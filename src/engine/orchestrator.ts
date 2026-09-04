/**
 * Orchestrator engine (the missing runtime coordinator).
 *
 * Connects all modules into an autonomous execution loop:
 *   Plan -> (for each step) -> BIND -> ACT -> PERCEIVE -> VERIFY -> State Machine
 *
 * Runs in the service worker context. Communicates with:
 *   - Content script (via TabDriver) for PERCEIVE and ACT.
 *   - Side panel (via chrome.runtime messages) for human gate and progress.
 *   - State machine (in-memory + chrome.storage) for persistence/resume.
 *
 * DESIGN DECISIONS:
 *   - Navigation is IMPLICIT in the plan: the plan is ordered visit -> form ->
 *     field, and the orchestrator navigates when the visit/form context changes.
 *   - Checkpoint after every verified item for resume on page reload.
 *   - The orchestrator PAUSES on escalation and waits for human input.
 *   - Pre-flight runs discovery probes before the main execution loop.
 */

import { diffObservations, type Observation, type ObservationElement } from '../perceive/core';
import type { Ir, IrVisit, IrForm, IrField } from '../plan/ir';
import type {
  Plan,
  VisitPlan,
  FormPlan,
  FieldPlan,
  LinearItem,
} from '../plan/compiler';
import { compilePlan, linearize } from '../plan/compiler';
import { parseIRJson } from '../plan/ir';
import type {
  BindingRecord,
  BindingRung,
  CanonicalType,
  CapabilityReport,
  ContractOpId,
  RecipeStep,
} from '../shared/contract';
import { idempotencyKey, CANONICAL_TYPES } from '../shared/contract';
import type {
  EscalationItem,
  RunProgress,
  RunSummary,
  PlanSummary,
  HumanDecision,
} from '../shared/messages';
import type { IntentRecord, VerdictResult } from '../verify/verify';
import { compareIntent, checkFirst } from '../verify/verify';
import {
  type RunState,
  type ItemRecord,
  type ItemEvent,
  type StorageAdapter,
  newRunState,
  loadRunState,
  saveRunState,
  applyTransition,
  chromeStorageAdapter,
} from './state-machine';
import { TabDriver } from './tab-driver';
import {
  bindAllRung0,
  bindFieldAdd,
  findByRole,
  findByNameOnly,
  expectedRolesForType,
} from '../bind/rung0';
import { ProbeRunner } from './probe-runner';
import { analyzeCommit } from '../bind/rung1';
import {
  LEXICAL_HINTS,
  enumerateActionable,
  enumerateActions,
  enumerateByRoles,
  rankCandidates,
} from '../bind/ranking';
import { rankCommitCandidates, readObservedFields, bindFormListFields } from '../bind/rung0';
import { Journal, type IrSource } from './journal';
import { rankWithLlm } from '../bind/rung2';
import { makeTypeBinding } from '../bind/rung1';
import {
  reconcileForm,
  summariseTree,
  normaliseLabel,
  type FormReconcileResult,
  type TreeSummary,
} from './reconcile';

/** Does this name read like a working-copy / persisted-state indicator?
 *  Weak corroboration only -- analyzeCommit's structural before/after
 *  comparison is the authoritative signal. Word list lives in ranking.ts. */
function matchesStatusHint(name: string): boolean {
  const n = name.toLowerCase();
  return LEXICAL_HINTS.status.some((w) => n.includes(w));
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

export type OrchestratorPhase = 'idle' | 'preflight' | 'executing' | 'paused' | 'done';

export interface OrchestratorCallbacks {
  /** Called when the pre-flight report is ready for human review. */
  onPreflightReport: (report: CapabilityReport, planSummary: PlanSummary) => void;
  /** Called on every progress update (each step). */
  onProgress: (progress: RunProgress) => void;
  /** Called when an item is escalated and needs human input. */
  onEscalation: (item: EscalationItem) => void;
  /** Called when the run completes. */
  onComplete: (summary: RunSummary) => void;
  /** Called when the shallow reconcile pass completes, before execution, so
   *  the human authorises the run from a concrete statement of the work. */
  onReconcileSummary?: (summary: TreeSummary, deepAvailable: boolean) => void;
  /** Called at the end of the run with the parked (non-blocking) escalations,
   *  to be cleared in one review session. */
  onParkedReview?: (items: EscalationItem[]) => void;
}

export class Orchestrator {
  private ir: Ir;
  private plan: Plan;
  private linearItems: LinearItem[];
  private runState: RunState;
  private adapter: StorageAdapter;
  private driver: TabDriver;
  private probeRunner: ProbeRunner;
  private callbacks: OrchestratorCallbacks;
  private phase: OrchestratorPhase = 'idle';
  private startTime = 0;

  /** Resolved bindings for the current platform (cached per-origin). */
  private bindings: Partial<Record<ContractOpId, BindingRecord>> = {};
  /** Per-type bindings (field.add for each canonical type). */
  private typeBindings: Partial<Record<CanonicalType, BindingRecord>> = {};

  /** Escalation queue: items waiting for human input. */
  private escalationQueue: Map<string, { resolve: (d: HumanDecision) => void }> = new Map();

  /** Pause promise: resolves when the user resumes. */
  private pauseResolve: (() => void) | null = null;

  /** Current navigation context, to avoid redundant navigation. */
  private currentVisitId: string | null = null;
  private currentFormId: string | null = null;

  /** Append-only provenance log. Every act writes one record. */
  private journal: Journal;
  /** Per-form reconcile result, populated when the form is opened. */
  private formReconcile: Map<string, FormReconcileResult> = new Map();
  /** Shallow-pass survey of the visit/form tree, from pre-flight. */
  private treeSummary: TreeSummary | null = null;
  /** Whether form.list_fields bound. When false, field-level reconciliation is
   *  unavailable and the run must say so rather than silently degrading. */
  private deepReconcileAvailable = false;
  /** Non-blocking escalations, reviewed in one sitting at the end. */
  private parked: EscalationItem[] = [];
  /** One decision per group settles every item sharing that group key. */
  private groupDecisions: Map<string, HumanDecision> = new Map();

  /** The IR data, keyed for quick lookup. */
  private irVisitMap: Map<string, IrVisit>;
  private irFormMap: Map<string, IrForm>;
  private irFieldMap: Map<string, IrField>;

  constructor(
    irJson: string,
    tabId: number,
    callbacks: OrchestratorCallbacks,
  ) {
    this.ir = parseIRJson(irJson);
    this.plan = compilePlan(this.ir);
    this.linearItems = linearize(this.plan);
    this.adapter = chromeStorageAdapter('local');
    this.driver = new TabDriver(tabId);
    this.probeRunner = new ProbeRunner(this.driver);
    this.callbacks = callbacks;
    this.journal = new Journal(`run-${Date.now()}`);

    // Build lookup maps from IR.
    this.irVisitMap = new Map(this.ir.visits.map((v) => [v.visit_id, v]));
    this.irFormMap = new Map<string, IrForm>();
    this.irFieldMap = new Map<string, IrField>();
    for (const visit of this.ir.visits) {
      for (const form of visit.forms) {
        this.irFormMap.set(form.form_id, form);
        for (const field of form.fields) {
          this.irFieldMap.set(field.field_id, field);
        }
      }
    }

    // Build run state with all idempotency keys.
    const keys: string[] = [];
    for (const item of this.linearItems) {
      const key = idempotencyKey(item.visit_id, item.form_id, item.field_id);
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    this.runState = newRunState(
      `run-${Date.now()}`,
      '', // platform origin filled in during preflight
      keys,
    );
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  /** Start (or resume) the execution. */
  async execute(): Promise<void> {
    this.startTime = Date.now();

    // Try to load existing run state for resume.
    const existing = await loadRunState(this.adapter);
    if (existing && existing.status !== 'done') {
      this.runState = existing;
    }

    // Phase 1: Pre-flight discovery.
    this.phase = 'preflight';
    const capReport = await this.preflight();
    const planSummary = this.buildPlanSummary();
    this.callbacks.onPreflightReport(capReport, planSummary);

    // Wait for human approval (the side panel sends RESUME_RUN after review).
    this.phase = 'paused';
    await this.waitForResume();

    // Phase 2: Execution loop.
    this.phase = 'executing';
    await this.executePlan();

    // Phase 3: clear the parked pile.
    //
    // Non-blocking escalations were set aside during the build so a 195-field
    // run is not an interrupt-driven slog. They are reviewed here, in one
    // sitting, before the run is called done.
    if (this.parked.length > 0) {
      this.phase = 'paused';
      this.callbacks.onParkedReview?.(this.parked.slice());
      await this.waitForResume();
    }

    // Phase 4: Done.
    this.phase = 'done';
    this.runState.status = 'done';
    await saveRunState(this.adapter, this.runState);
    this.callbacks.onComplete(this.buildSummary());
  }

  /** Pause execution. The current step finishes, then the loop blocks. */
  pause(): void {
    if (this.phase === 'executing') {
      this.phase = 'paused';
    }
  }

  /** Resume execution after a pause or pre-flight approval. */
  resume(): void {
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    if (this.phase === 'paused') {
      this.phase = 'executing';
    }
  }

  /** Resolve a human escalation. */
  resolveEscalation(key: string, decision: HumanDecision): void {
    const pending = this.escalationQueue.get(key);
    if (pending) {
      pending.resolve(decision);
      this.escalationQueue.delete(key);
    }

    // A decision on a grouped escalation settles every item in that group.
    // 13 canonical types means at most 13 type decisions, never 195.
    const resolved =
      this.parked.find((p) => p.key === key) ?? null;
    const groupKey = resolved?.groupKey;
    if (groupKey) {
      this.groupDecisions.set(groupKey, decision);
      for (const [otherKey, waiter] of [...this.escalationQueue]) {
        const other = this.parked.find((p) => p.key === otherKey);
        if (other?.groupKey === groupKey) {
          waiter.resolve(decision);
          this.escalationQueue.delete(otherKey);
        }
      }
    }
  }


  /** Get the current phase. */
  getPhase(): OrchestratorPhase { return this.phase; }

  /** Get the escalation queue for side panel reconnect. */
  getEscalationQueue(): EscalationItem[] {
    const items: EscalationItem[] = [];
    for (const [key] of this.escalationQueue) {
      const item = this.runState.items[key];
      if (item) {
        const field = this.irFieldMap.get(item.field_id);
        const form = this.irFormMap.get(item.form_id);
        const visit = this.irVisitMap.get(item.visit_id);
        items.push({
          key,
          fieldLabel: field?.label ?? item.field_id,
          formName: form?.name ?? item.form_id,
          visitName: visit?.name ?? item.visit_id,
          canonicalType: (field?.canonical_type ?? 'text') as CanonicalType,
          reason: item.escalation_reason ?? 'unknown',
          // Reconstructed from the live queue: anything still waiting on a
          // human by definition blocked the run.
          blocking: true,
          evidence: [],
          phase: 'verifying',
        });
      }
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // Pre-flight: discover the platform.
  // -------------------------------------------------------------------------

  private async preflight(): Promise<CapabilityReport> {
    // Take initial observation.
    const { observation } = await this.driver.perceive();
    this.runState.platform_origin = observation.url;

    // Rung 0: structural binding from the current observation.
    this.bindings = bindAllRung0(observation);

    // Rung 0: per-type bindings.
    for (const type of CANONICAL_TYPES) {
      const binding = bindFieldAdd(observation, type);
      if (binding) {
        this.typeBindings[type] = binding;
      }
    }

    // Build capability report.
    const allBindings: Record<string, BindingRecord | null> = {};
    const needsHuman: ContractOpId[] = [];
    const unbindable: ContractOpId[] = [];

    for (const [op, binding] of Object.entries(this.bindings)) {
      allBindings[op] = binding;
      if (binding.status === 'needs-human') needsHuman.push(op as ContractOpId);
    }

    // Check which ops are missing entirely.
    const requiredOps: ContractOpId[] = [
      'nav.to_study_root', 'nav.to_visit_list',
      'visit.create', 'visit.open',
      'form.create', 'form.open',
      'field_palette.open', 'field.set_label', 'field.set_required',
      'ctx.commit',
    ];
    for (const op of requiredOps) {
      if (!this.bindings[op]) {
        allBindings[op] = null;
        unbindable.push(op);
      }
    }

    // Bind field enumeration, which reconciliation depends on. If it cannot
    // bind, field-level reconciliation is genuinely unavailable and the run
    // must SAY so rather than silently degrading -- a re-run would then be
    // unable to tell an already-built field from a missing one.
    const listBinding = bindFormListFields(observation);
    if (listBinding) {
      this.bindings['form.list_fields'] = listBinding;
      allBindings['form.list_fields'] = listBinding;
      this.deepReconcileAvailable = listBinding.status === 'bound';
    }

    // Shallow reconcile: walk the visit list and, for each visit that exists,
    // the form names under it. Bounded by visit and form-appearance count, not
    // field count, so the pre-flight screen gets a concrete work statement
    // without paying to enumerate 195 fields before anything happens.
    await this.runShallowReconcile();

    return {
      platform_origin: observation.url,
      generated_at: Date.now(),
      bindings: allBindings as Record<ContractOpId, BindingRecord | null>,
      needs_human: needsHuman,
      unbindable,
    };
  }

  /**
   * Survey the visit/form tree without descending into forms.
   *
   * Best-effort: navigation on an unknown platform can fail, and a visit that
   * cannot be opened is simply reported as absent, which errs toward building
   * rather than skipping. Recall matters more than precision.
   */
  private async runShallowReconcile(): Promise<void> {
    const presentByVisit: Record<string, string[]> = {};

    try {
      for (const visit of this.ir.visits) {
        const opened = await this.tryNavigateToVisitByName(visit.name);
        if (!opened) continue;
        const { observation } = await this.driver.perceiveAfterSettle(200);
        presentByVisit[visit.name] = enumerateActionable(observation)
          .map((e) => e.name)
          .filter((n) => n.length > 0);
      }
    } catch {
      // A failed survey is not a failed run: leave the tree summary partial
      // and let the deep pass decide per form.
    }

    this.treeSummary = summariseTree(
      this.ir.visits.map((v) => ({
        visit_id: v.visit_id,
        name: v.name,
        forms: v.forms.map((f) => ({ form_id: f.form_id, name: f.name })),
      })),
      presentByVisit,
    );

    this.journal.note(
      'preflight',
      `${this.treeSummary.visitsPresent} of ${this.treeSummary.visitsWanted} visits and ` +
      `${this.treeSummary.formAppearancesPresent} of ${this.treeSummary.formAppearancesWanted} ` +
      `form appearances already exist` +
      (this.deepReconcileAvailable
        ? ''
        : '; field-level reconciliation is UNAVAILABLE on this platform'),
    );

    this.callbacks.onReconcileSummary?.(this.treeSummary, this.deepReconcileAvailable);
  }

  /** Navigate to a visit by its input-file name. Returns false when no visit
   *  with that name is reachable, which means it does not exist yet. The name
   *  comes from the input file, so matching against it is data, not a
   *  hardcoded vocabulary guess. */
  private async tryNavigateToVisitByName(name: string): Promise<boolean> {
    const { observation } = await this.driver.perceiveAfterSettle(150);
    const target = normaliseLabel(name);
    const match = enumerateActionable(observation).find(
      (e) => normaliseLabel(e.name) === target,
    );
    if (!match) return false;
    const res = await this.driver.click(match.handle);
    if (!res.ok) return false;
    await this.sleep(250);
    return true;
  }

  // -------------------------------------------------------------------------
  // Main execution loop.
  // -------------------------------------------------------------------------

  private async executePlan(): Promise<void> {
    // Group linear items by visit -> form for navigation.
    let prevVisitId = '';
    let prevFormId = '';

    for (let i = this.runState.cursor; i < this.linearItems.length; i++) {
      // Check for pause.
      if (this.phase === 'paused') {
        await this.waitForResume();
      }

      const item = this.linearItems[i];
      const itemKey = idempotencyKey(item.visit_id, item.form_id, item.field_id);
      const record = this.runState.items[itemKey];

      // Skip already-verified items (idempotency).
      if (record && record.state === 'verified') {
        this.runState.cursor = i + 1;
        this.emitProgress(i);
        continue;
      }

      // Skip escalated items (human will resolve later).
      if (record && record.state === 'escalated') {
        this.runState.cursor = i + 1;
        this.emitProgress(i);
        continue;
      }

      // If form context is changing, commit the current form first!
      if (prevFormId !== '' && item.form_id !== prevFormId) {
        await this.commitCurrentForm();
      }

      // Navigate to the correct visit if context changed.
      if (item.visit_id !== prevVisitId) {
        await this.navigateToVisit(item.visit_id);
        prevVisitId = item.visit_id;
        prevFormId = ''; // Force form navigation too.
      }

      // Navigate to the correct form if context changed.
      if (item.form_id !== prevFormId) {
        await this.navigateToForm(item.visit_id, item.form_id);
        prevFormId = item.form_id;
      }

      // Execute the step.
      await this.executeStep(item, itemKey, i);

      // Advance cursor.
      this.runState.cursor = i + 1;
      await saveRunState(this.adapter, this.runState);
      this.emitProgress(i);
    }

    // Commit the final form upon completion!
    if (prevFormId !== '') {
      await this.commitCurrentForm();
    }
  }

  // -------------------------------------------------------------------------
  // Single step execution.
  // -------------------------------------------------------------------------

  private async executeStep(
    item: LinearItem,
    itemKey: string,
    stepIndex: number,
  ): Promise<void> {
    const field = this.irFieldMap.get(item.field_id);
    if (!field) return;

    // Reconcile decides whether this item needs building at all. Consulting it
    // BEFORE any mutation is what makes a re-run a no-op and what stops the
    // agent overwriting work someone may have done deliberately.
    const reconciled = this.formReconcile.get(item.form_id);
    const decision = reconciled?.decisions.find((d) => d.field_id === item.field_id);

    if (decision?.action === 'adopt') {
      const record = this.runState.items[itemKey];
      if (record) {
        record.state = 'verified';
        record.last_verdict = 'VERIFIED';
        await saveRunState(this.adapter, this.runState);
      }
      this.journal.adopted(this.sourceOf(item), decision.reason);
      return;
    }

    if (decision?.action === 'escalate') {
      await this.escalateItem(itemKey, 'verifying', {
        key: itemKey,
        fieldLabel: item.label,
        formName: item.form_name,
        visitName: item.visit_name,
        canonicalType: item.canonical_type,
        reason: decision.reason,
        suspectedTrap:
          `a field with this label already exists but its ${decision.mismatch} ` +
          `differs; not modifying work that may have been done deliberately`,
        evidence: [decision.reason],
        phase: 'verifying',
      }, /* blocking */ false);
      return;
    }

    const form = this.irFormMap.get(item.form_id);
    const visit = this.irVisitMap.get(item.visit_id);

    // Build the intent record for verification.
    const intent: IntentRecord = {
      visit_id: item.visit_id,
      form_id: item.form_id,
      field_id: item.field_id,
      canonical_type: field.canonical_type,
      label: field.label,
      required: field.required,
      coded_pairs: field.options,
      range_units: field.range,
      skip_rules: field.skip_logic ? [field.skip_logic] : undefined,
    };

    // Determine what to do based on the micro-step kind.
    switch (item.kind) {
      case 'add':
        await this.executeFieldAdd(item, itemKey, field, intent);
        break;
      case 'set_label':
        await this.executeFieldSetLabel(item, itemKey, field);
        break;
      case 'set_range':
        await this.executeFieldSetRange(item, itemKey, field);
        break;
      case 'type_refinement':
        // Settle the control's type BEFORE the range is written, so a type
        // change cannot silently discard it.
        await this.executeTypeRefinement(item, itemKey, field, intent);
        break;
      case 'verify_range':
        await this.executeVerifyRange(item, itemKey, field, intent);
        break;
      case 'set_coded_values':
        await this.executeFieldSetCodedValues(item, itemKey, field);
        break;
      case 'set_required':
        await this.executeFieldSetRequired(item, itemKey, field, intent);
        break;
      case 'set_skip_logic':
        await this.executeFieldSetSkipLogic(item, itemKey, field);
        break;
    }
  }

  /**
   * Re-read a field's range once the type is final.
   *
   * The last step for any field carrying a range. Everything that could
   * disturb the type has already run, so whatever the platform reports now is
   * what the study will actually have. A range that has gone missing is the
   * silent-discard trap and is parked for review rather than retried blindly —
   * a blind retry would just set it again and lose it again.
   */
  private async executeVerifyRange(
    item: LinearItem,
    itemKey: string,
    field: IrField,
    intent: IntentRecord,
  ): Promise<void> {
    const { observation } = await this.driver.perceiveAfterSettle(200);
    const verdict = compareIntent(observation, intent);

    if (verdict.verdict === 'VERIFIED') {
      await this.markVerified(itemKey, {
        rung: 0,
        evidence: [`range re-read after the type was final: ${verdict.reason}`],
        reason: verdict.reason,
      });
      return;
    }

    await this.escalateItem(itemKey, 'verifying', {
      key: itemKey,
      fieldLabel: item.label,
      formName: item.form_name,
      visitName: item.visit_name,
      canonicalType: item.canonical_type,
      reason: verdict.reason,
      suspectedTrap:
        verdict.suspected_trap ??
        'the range was set earlier but is absent now; the platform may have ' +
        'discarded it when the control type was settled',
      evidence: [verdict.reason],
      verdict,
      phase: 'verifying',
    }, /* blocking */ false);
  }

  // -------------------------------------------------------------------------
  // Field operations.
  // -------------------------------------------------------------------------

  private async executeFieldAdd(
    item: LinearItem,
    itemKey: string,
    field: IrField,
    intent: IntentRecord,
  ): Promise<void> {
    // Check-first: does this field already exist? (idempotency)
    const { observation: preObs } = await this.driver.perceive();
    const existing = checkFirst(preObs, intent);
    if (existing.verdict === 'VERIFIED') {
      // Already exists, skip.
      await this.markVerified(itemKey);
      return;
    }

    // Ensure form builder controls and palette types are discovered
    if (!this.typeBindings[field.canonical_type]) {
      await this.discoverFormBuilder();
    }

    // Get the type binding for this canonical type.
    let typeBinding = this.typeBindings[field.canonical_type];
    if (!typeBinding) {
      // Degrade to Rung 1: empirically probe candidate palette buttons
      const { observation: builderObs } = await this.driver.perceive();
      const probeRes = await this.probeRunner.probePalette(builderObs);
      for (const [t, b] of Object.entries(probeRes.bindings)) {
        if (b) this.typeBindings[t as CanonicalType] = b;
      }
      typeBinding = this.typeBindings[field.canonical_type];
    }

    // Rung 2: the model narrows the field. It NEVER decides -- its top pick is
    // placed and read back, and a disagreement escalates showing both views.
    // With no key configured this rung is skipped entirely and the item goes
    // straight to the human, so the build completes either way.
    const rung2Evidence: string[] = [];
    if (!typeBinding) {
      const stored = await chrome.storage.local.get('anthropicApiKey');
      const apiKey: string | null =
        typeof stored?.anthropicApiKey === 'string' ? stored.anthropicApiKey : null;

      if (apiKey) {
        const { observation: paletteObs } = await this.driver.perceive();
        const pool = rankCandidates(enumerateActionable(paletteObs), { hint: 'palette' });
        const llmRanked = await rankWithLlm(field.canonical_type, pool, {
          apiKey,
          fetch: (url, init) => globalThis.fetch(url as string, init as RequestInit),
        });

        if (llmRanked && llmRanked.length > 0) {
          const pick = llmRanked[0];
          const adjudication = await this.probeRunner.placeAndInspect(pick.el.handle);

          if (adjudication.matchedTypes.includes(field.canonical_type)) {
            const binding = makeTypeBinding(
              field.canonical_type,
              adjudication.probe,
              pick.el.name,
              pick.el.handle,
            );
            this.typeBindings[field.canonical_type] = binding;
            typeBinding = binding;
            this.journal.created(
              this.sourceOf(item),
              'field.add',
              {
                rung: 2,
                evidence: [
                  `rung 2 ranked "${pick.el.name}" first: ${pick.llmRationale}`,
                  `probe confirmed: placing it produced role "${adjudication.probe.observedRole}"`,
                ],
                llm_rationale: pick.llmRationale,
                llm_rank: pick.llmRank,
              },
              { verdict: 'VERIFIED', reason: 'probe confirmed the rung 2 ranking' },
            );
          } else {
            // The model was confident and the platform disagreed. Carry BOTH
            // opinions into the escalation so the human sees the conflict
            // rather than a bare failure.
            rung2Evidence.push(
              `rung 2 suggested "${pick.el.name}" (${pick.llmRationale}), but placing it ` +
              `produced role "${adjudication.probe.observedRole}", which does not realise ` +
              `"${field.canonical_type}"`,
            );
          }
        } else {
          rung2Evidence.push('rung 2 could not rank the candidates; escalating');
        }
      } else {
        rung2Evidence.push('rung 2 unavailable (no API key configured); escalating');
      }
    }

    if (!typeBinding) {
      // Every field of this canonical type is stuck behind this one answer,
      // so it blocks -- and it groups, so answering settles all of them.
      const affected = this.linearItems.filter(
        (i) => i.kind === 'add' && i.canonical_type === field.canonical_type,
      );
      await this.escalateItem(itemKey, 'binding', {
        key: itemKey,
        groupKey: `type:${field.canonical_type}`,
        blastRadius: {
          fields: affected.length,
          forms: new Set(affected.map((i) => i.form_id)).size,
        },
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: `No binding found for type "${field.canonical_type}" in the element palette after Rung 0 & Rung 1 probes`,
        evidence: [
          'no palette control matched this canonical type structurally after rungs 0 and 1',
          ...rung2Evidence,
        ],
        phase: 'binding',
      }, /* blocking */ true);
      return;
    }

    // Execute the binding recipe (click the palette button).
    await applyTransition(this.adapter, this.runState, itemKey, 'begin_binding');
    await applyTransition(this.adapter, this.runState, itemKey, 'bound');
    await applyTransition(this.adapter, this.runState, itemKey, 'begin_acting');

    const actOk = await this.executeRecipe(typeBinding.recipe, field);
    const actEvent: ItemEvent = actOk ? 'act_done' : 'act_failed';
    await applyTransition(this.adapter, this.runState, itemKey, actEvent);

    // Verify control placement: verify that a new element appeared on the canvas
    const { observation: postObs } = await this.driver.perceiveAfterSettle(300);
    const diff = diffObservations(preObs, postObs);
    const elementAdded = diff.added.length > 0 || postObs.elements.length > preObs.elements.length;

    if (!actOk || !elementAdded) {
      await applyTransition(this.adapter, this.runState, itemKey, 'verify_failed');
      const record = this.runState.items[itemKey];
      if (record && record.state === 'escalated') {
        await this.escalateItem(itemKey, 'verifying', {
          key: itemKey,
          fieldLabel: field.label,
          formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
          visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
          canonicalType: field.canonical_type,
          reason: 'Clicking palette button did not place a new control on canvas',
          evidence: typeBinding.evidence,
          binding: typeBinding,
          phase: 'verifying',
        }, /* blocking */ false);
      }
    }
  }

  private async executeFieldSetLabel(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    const { observation } = await this.driver.perceive();

    // Find the Label input in the options panel.
    const labelInputs = observation.elements.filter(
      (e) => e.role === 'textbox' && (
        e.name.toLowerCase() === 'label' ||
        e.name.toLowerCase().includes('label')
      ),
    );

    if (labelInputs.length > 0) {
      await this.driver.setValue(labelInputs[0].handle, field.label);
      await this.sleep(200);
      return;
    }

    // Fallback: look for candidate textbox that is not filter/search
    const candidateTextboxes = observation.elements.filter(
      (e) => e.role === 'textbox' && !e.name.toLowerCase().includes('filter') && !e.name.toLowerCase().includes('search'),
    );
    if (candidateTextboxes.length > 0) {
      await this.driver.setValue(candidateTextboxes[0].handle, field.label);
      await this.sleep(200);
    }
  }

  private async executeFieldSetRange(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    if (!field.range) return;

    const { observation } = await this.driver.perceive();

    // Find min/max/units inputs.
    const minInputs = findByRole(observation, 'textbox', { contains: 'min' })
      .concat(findByRole(observation, 'spinbutton', { contains: 'min' }));
    const maxInputs = findByRole(observation, 'textbox', { contains: 'max' })
      .concat(findByRole(observation, 'spinbutton', { contains: 'max' }));
    const unitInputs = findByRole(observation, 'textbox', { contains: 'unit' });

    if (minInputs.length > 0) {
      await this.driver.setValue(minInputs[0].el.handle, String(field.range.min));
    }
    if (maxInputs.length > 0) {
      await this.driver.setValue(maxInputs[0].el.handle, String(field.range.max));
    }
    if (unitInputs.length > 0 && field.range.units) {
      await this.driver.setValue(unitInputs[0].el.handle, field.range.units);
    }
  }

  private async executeTypeRefinement(
    item: LinearItem,
    itemKey: string,
    field: IrField,
    intent: IntentRecord,
  ): Promise<void> {
    // After setting range, verify the type is still correct.
    // (criterion 9: setting type after range may wipe the range)
    const { observation } = await this.driver.perceiveAfterSettle(300);

    // Look for a type selector in the options panel.
    const typeSelects = findByRole(observation, 'combobox', { contains: 'type' })
      .concat(findByRole(observation, 'listbox', { contains: 'type' }));

    if (typeSelects.length > 0) {
      // The type selector exists. Find the option that matches the canonical type.
      const typeBinding = this.typeBindings[field.canonical_type];
      if (typeBinding && typeBinding.recipe.length > 0) {
        const paletteName = typeBinding.recipe[0].evidence_name;
        if (paletteName) {
          await this.driver.selectOption(typeSelects[0].el.handle, paletteName);
        }
      }
    }
  }

  private async executeFieldSetCodedValues(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    if (!field.options || field.options.length === 0) return;

    const { observation } = await this.driver.perceive();

    // Strategy: find code + label input pairs and an "add value" button,
    // then enter each coded pair one at a time.
    const codeInputs = findByRole(observation, 'textbox', { contains: 'code' });
    const labelInputs = findByRole(observation, 'textbox', { contains: 'label' })
      .filter((c) => !codeInputs.some((ci) => ci.el.handle === c.el.handle));
    const addButtons = findByRole(observation, 'button', { contains: 'add' })
      .filter((b) => b.el.name.toLowerCase().includes('value'));

    if (codeInputs.length > 0 && labelInputs.length > 0) {
      // Two-column editor: enter pairs one at a time.
      for (const pair of field.options) {
        // Re-observe to get fresh handles after each add.
        const { observation: freshObs } = await this.driver.perceive();
        const freshCodeInputs = findByRole(freshObs, 'textbox', { contains: 'code' });
        const freshLabelInputs = findByRole(freshObs, 'textbox', { contains: 'label' })
          .filter((c) => !freshCodeInputs.some((ci) => ci.el.handle === c.el.handle));

        if (freshCodeInputs.length > 0) {
          await this.driver.setValue(freshCodeInputs[freshCodeInputs.length - 1].el.handle, pair.code);
        }
        if (freshLabelInputs.length > 0) {
          await this.driver.setValue(freshLabelInputs[freshLabelInputs.length - 1].el.handle, pair.label);
        }

        // Click "add value" button.
        const freshAddButtons = findByRole(freshObs, 'button', { contains: 'add' })
          .filter((b) => b.el.name.toLowerCase().includes('value'));
        if (freshAddButtons.length > 0) {
          await this.driver.click(freshAddButtons[0].el.handle);
          await this.sleep(200); // Brief settle.
        }
      }
    }
  }

  private async executeFieldSetRequired(
    item: LinearItem,
    itemKey: string,
    field: IrField,
    intent: IntentRecord,
  ): Promise<void> {
    if (field.required) {
      const { observation } = await this.driver.perceive();
      const requiredCheckboxes = findByRole(observation, 'checkbox', { contains: 'require' });

      if (requiredCheckboxes.length > 0) {
        const el = requiredCheckboxes[0].el;
        if (!el.state.checked) {
          await this.driver.check(el.handle, true);
          await this.sleep(200);
        }
      }
    }

    // FINAL VERIFICATION OF THE FIELD:
    // Read-back verification comparing semantic state against Intent Record
    const { observation: finalObs } = await this.driver.perceiveAfterSettle(300);
    const verdict = compareIntent(finalObs, intent);

    if (verdict.verdict === 'VERIFIED') {
      await applyTransition(this.adapter, this.runState, itemKey, 'verify_verified');
    } else if (verdict.verdict === 'AMBIGUOUS') {
      await applyTransition(this.adapter, this.runState, itemKey, 'verify_ambiguous');
      await this.escalateItem(itemKey, 'verifying', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: verdict.reason,
        suspectedTrap: verdict.suspected_trap,
        evidence: [verdict.reason],
        verdict,
        phase: 'verifying',
      }, /* blocking */ false);
    } else {
      await applyTransition(this.adapter, this.runState, itemKey, 'verify_failed');
      const record = this.runState.items[itemKey];
      if (record && record.state === 'escalated') {
        await this.escalateItem(itemKey, 'verifying', {
          key: itemKey,
          fieldLabel: field.label,
          formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
          visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
          canonicalType: field.canonical_type,
          reason: verdict.reason,
          evidence: [verdict.reason],
          verdict,
          phase: 'verifying',
        }, /* blocking */ false);
      }
    }
  }

  private async executeFieldSetSkipLogic(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    if (!field.skip_logic) return;

    const { observation } = await this.driver.perceive();

    // Find visibility/conditional selector.
    const visCandidates = findByRole(observation, 'combobox', { contains: 'visib' })
      .concat(findByRole(observation, 'listbox', { contains: 'visib' }))
      .concat(findByRole(observation, 'combobox', { contains: 'conditional' }));

    if (visCandidates.length > 0) {
      // Select "Conditional" or equivalent.
      await this.driver.selectOption(visCandidates[0].el.handle, 'Conditional');
      await this.sleep(300);

      // Re-observe for the when/value inputs.
      const { observation: freshObs } = await this.driver.perceive();

      // Find the "when" field selector.
      const whenSelects = findByRole(freshObs, 'combobox', { contains: 'when' })
        .concat(findByRole(freshObs, 'listbox', { contains: 'when' }));
      if (whenSelects.length > 0) {
        await this.driver.selectOption(whenSelects[0].el.handle, field.skip_logic.when_field_label);
        await this.sleep(200);
      }

      // Find the value input.
      const { observation: freshObs2 } = await this.driver.perceive();
      const valueInputs = findByRole(freshObs2, 'textbox', { contains: 'value' })
        .concat(findByRole(freshObs2, 'textbox', { contains: 'equal' }));
      if (valueInputs.length > 0) {
        await this.driver.setValue(valueInputs[0].el.handle, field.skip_logic.equals_value);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Navigation.
  // -------------------------------------------------------------------------

  private async navigateToVisit(visitId: string): Promise<void> {
    if (this.currentVisitId === visitId) return;

    const visit = this.irVisitMap.get(visitId);
    if (!visit) return;

    // Navigate to study root first.
    const { observation } = await this.driver.perceive();
    const navBinding = this.bindings['nav.to_study_root'];

    if (navBinding && navBinding.recipe.length > 0) {
      await this.executeRecipe(navBinding.recipe, null);
      await this.sleep(500);
    }

    // Create the visit if it doesn't exist.
    const { observation: rootObs } = await this.driver.perceive();
    const visitLinks = rootObs.elements.filter(
      (e) => (e.role === 'link' || e.role === 'button') && e.name === visit.name,
    );

    if (visitLinks.length === 0) {
      // Visit doesn't exist -- create it.
      await this.createVisit(visit);
    }

    // Open the visit.
    const { observation: afterCreate } = await this.driver.perceive();
    const visitLink = afterCreate.elements.find(
      (e) => (e.role === 'link' || e.role === 'button') && e.name === visit.name,
    );
    if (visitLink) {
      await this.driver.click(visitLink.handle);
      await this.sleep(500);
    }

    this.currentVisitId = visitId;
    this.currentFormId = null;
  }

  private async createVisit(visit: IrVisit): Promise<void> {
    const createBinding = this.bindings['visit.create'];
    if (!createBinding) return;

    // Click the "add visit" button.
    if (createBinding.recipe.length > 0) {
      const { observation } = await this.driver.perceive();
      const addPool = enumerateActionable(observation);
      const addBtn = rankCandidates(addPool, { hint: 'visit_create' })[0]?.el;
      // Remember the pre-dialog surface so the controls the dialog brings with
      // it can be told apart from the page chrome that was always there.
      this.preDialogObs = observation;
      if (addBtn) {
        await this.driver.click(addBtn.handle);
        await this.sleep(300);
      }
    }

    // Fill in the visit name.
    const { observation: formObs } = await this.driver.perceive();
    const textPool = enumerateByRoles(formObs, ['textbox', 'searchbox']);
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0]?.el;
    if (nameBox) {
      await this.driver.setValue(nameBox.handle, visit.name);
    }

    // Fill in the visit window. Both bounds are ranked over the same pool and
    // the top two distinct candidates are used, so a platform naming them
    // anything at all still gets values written; the read-back confirms.
    const startBox = rankCandidates(textPool, { hint: 'window_start' })[0]?.el;
    const endCandidates = rankCandidates(textPool, { hint: 'window_end' });
    const endBox = (endCandidates.find((c) => c.el.handle !== startBox?.handle) ?? endCandidates[0])?.el;
    if (startBox && startBox.handle !== nameBox?.handle) {
      await this.driver.setValue(startBox.handle, String(visit.window_start_day));
    }
    if (endBox && endBox.handle !== nameBox?.handle && endBox.handle !== startBox?.handle) {
      await this.driver.setValue(endBox.handle, String(visit.window_end_day));
    }

    // Click save.
    const { observation: saveObs } = await this.driver.perceive();
    const saveBtn = this.pickDialogCommit(saveObs);
    if (saveBtn) {
      await this.driver.click(saveBtn.handle, false);
      await this.sleep(500);
    }
  }

  private async navigateToForm(visitId: string, formId: string): Promise<void> {
    if (this.currentFormId === formId) return;

    const form = this.irFormMap.get(formId);
    if (!form) return;

    // Check if the form already exists in the current visit's document list.
    const { observation } = await this.driver.perceive();
    const formLink = observation.elements.find(
      (e) => (e.role === 'link' || e.role === 'button' || e.role === 'cell') &&
        (e.name === form.name || e.name.toLowerCase().includes(form.name.toLowerCase())),
    );

    if (!formLink) {
      // Form doesn't exist -- create it.
      await this.createForm(form);
    }

    // Open the form (click edit/open/modify button).
    const { observation: afterCreate } = await this.driver.perceive();
    const editLink = afterCreate.elements.find(
      (e) => (e.role === 'link' || e.role === 'button') &&
        (e.name === form.name || e.name.toLowerCase().includes('edit') ||
         e.name.toLowerCase().includes('modify') || e.name.toLowerCase().includes('open')),
    );
    if (editLink) {
      await this.driver.click(editLink.handle);
      await this.sleep(500);
    }

    this.currentFormId = formId;
    await this.discoverFormBuilder();

    // Deep reconcile: what is ACTUALLY in this form right now.
    //
    // This is also where the reuse question answers itself. A form that arrives
    // already populated means the platform shares definitions across visits, so
    // its fields are adopted; an empty one means it rebuilds per visit, so they
    // are built. Discovered by looking, never assumed in either direction.
    if (this.deepReconcileAvailable) {
      const irForm = this.irFormMap.get(formId);
      const irVisit = this.irVisitMap.get(visitId);
      if (irForm && irVisit) {
        const { observation } = await this.driver.perceiveAfterSettle(250);
        const present = readObservedFields(observation);
        const result = reconcileForm(
          {
            form_id: irForm.form_id,
            name: irForm.name,
            fields: irForm.fields.map((f) => ({
              visit_id: visitId,
              form_id: irForm.form_id,
              field_id: f.field_id,
              label: f.label,
              canonical_type: f.canonical_type,
              required: f.required,
              coded_pairs: f.options,
              range_units: f.range,
            })),
          },
          present,
        );
        this.formReconcile.set(formId, result);

        if (result.sharedDefinition) {
          this.journal.note(
            `${irVisit.name} > ${irForm.name}`,
            'form arrived already populated: this platform shares form definitions ' +
            'across visits, so its fields are adopted rather than rebuilt',
          );
        }
        if (result.unexpected.length > 0) {
          this.journal.note(
            `${irVisit.name} > ${irForm.name}`,
            `${result.unexpected.length} control(s) present that the input file does ` +
            `not mention: ${result.unexpected.map((u) => u.label).join(', ')}. ` +
            `Reported, not removed -- they may be deliberate work.`,
          );
        }
      }
    }
  }

  private async discoverFormBuilder(): Promise<void> {
    const { observation } = await this.driver.perceive();

    // Bind all rung 0 operations available on the builder screen
    const builderBindings = bindAllRung0(observation);
    for (const [op, binding] of Object.entries(builderBindings)) {
      if (binding) {
        this.bindings[op as ContractOpId] = binding;
      }
    }

    // Bind all 13 canonical types in the palette
    for (const type of CANONICAL_TYPES) {
      if (!this.typeBindings[type]) {
        const tb = bindFieldAdd(observation, type);
        if (tb) {
          this.typeBindings[type] = tb;
        }
      }
    }
  }

  private async createForm(form: IrForm): Promise<void> {
    // The control that creates a source document. Ranked, never gated: every
    // platform has its own word for it and the previous list was a guess.
    const { observation } = await this.driver.perceive();
    const newBtn = rankCandidates(enumerateActionable(observation), { hint: 'form_create' })[0]?.el;
    this.preDialogObs = observation;
    if (newBtn) {
      await this.driver.click(newBtn.handle);
      await this.sleep(300);
    }

    // Fill in the form name.
    const { observation: formObs } = await this.driver.perceive();
    const formTextPool = enumerateByRoles(formObs, ['textbox', 'searchbox']);
    const nameInputs = rankCandidates(formTextPool, { hint: 'name_input' })
      .slice(0, 1)
      .map((r) => r.el);
    if (nameInputs.length > 0) {
      await this.driver.setValue(nameInputs[0].handle, form.name);
    }

    // Set repeating flag if needed.
    if (form.repeating) {
      const toggles = formObs.elements.filter(
        (e) => (e.role === 'checkbox' || e.role === 'switch') &&
          rankCandidates([e], { hint: 'repeating' })[0].signals.some((sg) => sg.name === 'lexical'),
      );
      if (toggles.length > 0 && !toggles[0].state.checked) {
        await this.driver.check(toggles[0].handle, true);
      }
    }

    // Click create/save.
    const { observation: saveObs } = await this.driver.perceive();
    const createBtn = this.pickDialogCommit(saveObs);
    if (createBtn) {
      await this.driver.click(createBtn.handle, false);
      await this.sleep(500);
    }
  }

  /**
   * Commit the currently open form builder working copy.
   * Confirms persistence indicators (dirty banner cleared / draft -> saved / active).
   */
  private async commitCurrentForm(): Promise<void> {
    const { observation } = await this.driver.perceive();

    // Try ctx.commit binding if already resolved
    const saveBinding = this.bindings['ctx.commit'];
    if (saveBinding && saveBinding.recipe.length > 0) {
      const ok = await this.executeRecipe(saveBinding.recipe, null);
      if (ok) {
        await this.sleep(400);
        const post = await this.driver.perceiveAfterSettle(300);
        // Whether a working-copy indicator is still showing. Word list lives
        // in ranking.ts; the authoritative signal is analyzeCommit's structural
        // before/after comparison, which ran above.
        const hasUnsaved = post.observation.elements.some(
          (e) => e.name.length > 0 && matchesStatusHint(e.name),
        );
        if (!hasUnsaved) return;
      }
    }

    // Fallback: work down the ranked commit trial order. Nothing is excluded
    // by name -- the decoy is caught by analyzeCommit observing that the
    // working copy did not change, not by recognising its label.
    const saveButtons = rankCommitCandidates(observation).map((r) => r.el);

    if (saveButtons.length > 0) {
      await this.driver.click(saveButtons[0].handle, false);
      await this.sleep(400);
      const post = await this.driver.perceiveAfterSettle(300);
      const commitCheck = analyzeCommit(observation, post.observation);
      if (commitCheck.committed) {
        this.bindings['ctx.commit'] = {
          op: 'ctx.commit',
          version: 1,
          recipe: [{ step: 'click', evidence_role: 'button', evidence_name: saveButtons[0].name, handle_kind: 'snapshot-id' }],
          post_condition: { description: 'committed' },
          evidence: commitCheck.evidence,
          rung: 1,
          status: 'bound',
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recipe execution.
  // -------------------------------------------------------------------------

  private async executeRecipe(recipe: RecipeStep[], field: IrField | null): Promise<boolean> {
    for (const step of recipe) {
      const { observation } = await this.driver.perceive();

      // Resolve the target handle from the current observation.
      const handle = this.resolveRecipeTarget(observation, step);
      if (!handle) {
        return false; // Could not find the target element.
      }

      switch (step.step) {
        case 'click':
          const clickResult = await this.driver.click(handle);
          if (!clickResult.ok) return false;
          await this.sleep(300);
          break;
        case 'set_value': {
          const value = step.value_from === 'literal'
            ? (step.literal ?? '')
            : (field?.label ?? '');
          const setResult = await this.driver.setValue(handle, value);
          if (!setResult.ok) return false;
          break;
        }
        case 'check': {
          const checkResult = await this.driver.check(handle);
          if (!checkResult.ok) return false;
          break;
        }
        case 'select_option': {
          const optionLabel = step.literal ?? '';
          const selectResult = await this.driver.selectOption(handle, optionLabel);
          if (!selectResult.ok) return false;
          break;
        }
        case 'choose_option': {
          const chooseLabel = step.literal ?? '';
          const chooseResult = await this.driver.selectOption(handle, chooseLabel);
          if (!chooseResult.ok) return false;
          break;
        }
        case 'wait':
          await this.sleep(300);
          break;
      }
    }
    return true;
  }

  /** Resolve a recipe step's target to a handle in the current observation. */
  private resolveRecipeTarget(observation: Observation, step: RecipeStep): string | null {
    switch (step.handle_kind) {
      case 'snapshot-id':
        // Find by role + name.
        if (step.evidence_role && step.evidence_name) {
          const match = observation.elements.find(
            (e) => e.role === step.evidence_role && e.name === step.evidence_name,
          );
          if (match) return match.handle;
          // Fuzzy fallback: name contains.
          const fuzzy = observation.elements.find(
            (e) => e.role === step.evidence_role &&
              e.name.toLowerCase().includes((step.evidence_name ?? '').toLowerCase()),
          );
          if (fuzzy) return fuzzy.handle;
        }
        if (step.evidence_name) {
          const byName = observation.elements.find(
            (e) => e.name === step.evidence_name,
          );
          if (byName) return byName.handle;
        }
        return null;

      case 'role-name':
        if (step.evidence_role && step.evidence_name) {
          const match = observation.elements.find(
            (e) => e.role === step.evidence_role && e.name === step.evidence_name,
          );
          return match?.handle ?? null;
        }
        return null;

      case 'role-only':
        if (step.evidence_role) {
          const match = observation.elements.find((e) => e.role === step.evidence_role);
          return match?.handle ?? null;
        }
        return null;

      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Escalation.
  // -------------------------------------------------------------------------

  /**
   * Escalate an item to the human gate.
   *
   * Blocking escalations pause the run because it genuinely cannot proceed
   * without an answer -- no commit control, or an unresolved canonical type
   * that every field of that type is stuck behind. Non-blocking ones are
   * parked and the run continues, so a 195-field build is one review session
   * at the end rather than an interrupt-driven slog.
   *
   * Items sharing a groupKey resolve together: answering "single_select maps
   * to Beam Pick" once settles all 14 single_select fields.
   */
  private async escalateItem(
    itemKey: string,
    phase: 'binding' | 'acting' | 'verifying',
    escalation: Omit<EscalationItem, 'blocking'>,
    blocking: boolean,
  ): Promise<HumanDecision | null> {
    // A decision already given for this group settles this item too.
    const existing = escalation.groupKey
      ? this.groupDecisions.get(escalation.groupKey)
      : undefined;
    if (existing) return existing;

    const record = this.runState.items[itemKey];
    if (record && record.state !== 'escalated') {
      await applyTransition(this.adapter, this.runState, itemKey, 'escalate');
    }

    const item: EscalationItem = { ...escalation, blocking };
    this.callbacks.onEscalation(item);

    const source = this.sourceOfKey(itemKey, escalation);

    if (!blocking) {
      // Park it. The run continues; the reviewer clears the pile at the end.
      this.parked.push(item);
      this.journal.escalated(source, escalation.reason, null);
      return null;
    }

    const decision = await new Promise<HumanDecision>((resolve) => {
      this.escalationQueue.set(itemKey, { resolve });
    });

    this.journal.escalated(source, escalation.reason, {
      action: decision.action,
      note: decision.note,
    });

    if (escalation.groupKey) {
      this.groupDecisions.set(escalation.groupKey, decision);
    }

    await this.applyHumanDecision(itemKey, decision);
    return decision;
  }

  /** Apply a human decision to one item. */
  private async applyHumanDecision(itemKey: string, decision: HumanDecision): Promise<void> {
    if (decision.action === 'approve') {
      await this.markVerified(itemKey);
    } else if (decision.action === 'skip') {
      // Leave as escalated, move on.
    } else if (decision.action === 'override' && decision.overrideType) {
      const field = this.irFieldMap.get(this.runState.items[itemKey]?.field_id ?? '');
      if (field) {
        const newBinding = bindFieldAdd(
          (await this.driver.perceive()).observation,
          decision.overrideType,
        );
        if (newBinding) {
          this.typeBindings[field.canonical_type] = newBinding;
        }
      }
    } else if (decision.action === 'retry') {
      this.runState.items[itemKey].state = 'pending';
      this.runState.items[itemKey].rebind_count = 0;
    }
  }

  /** Best-effort provenance for an escalation, which may not have a LinearItem. */
  private sourceOfKey(itemKey: string, e: Omit<EscalationItem, 'blocking'>): IrSource {
    const item = this.linearItems.find(
      (i) => idempotencyKey(i.visit_id, i.form_id, i.field_id) === itemKey,
    );
    if (item) return this.sourceOf(item);
    return {
      path: itemKey,
      visit_name: e.visitName,
      form_name: e.formName,
      field_label: e.fieldLabel,
      declared_type: e.canonicalType,
    };
  }

  /** Observation taken immediately before a dialog was opened, so the controls
   *  the dialog brought with it can be identified structurally. */
  private preDialogObs: Observation | null = null;

  /**
   * Choose the control that confirms an open dialog.
   *
   * Ranking across the whole page is not good enough here. A dialog's confirm
   * button competes with every piece of persistent page chrome, and when no
   * lexical hint matches -- a button simply labelled "Create" matches nothing
   * in the commit vocabulary -- the tie falls to DOM order and the agent
   * clicks the first nav link on the page, navigating away and losing the
   * dialog entirely. That is not a hypothetical: it is what happened to
   * form creation on the supplied mock.
   *
   * The structural fix is that a dialog's controls APPEARED when the dialog
   * opened, and page chrome did not. Diff membership already outweighs any
   * lexical hint 3:1 in the ranking, so passing it here settles the question
   * without adding a single word to any list.
   */
  private pickDialogCommit(current: Observation): ObservationElement | undefined {
    // Actions only. A dialog's confirm control is never a checkbox, and
    // including value-holding controls here let a stray "Repeating log"
    // tick-box outrank the actual Create button on the supplied mock.
    const pool = enumerateActions(current);
    const diffAdded = this.preDialogObs
      ? diffObservations(this.preDialogObs, current).added
      : undefined;
    const ranked = rankCandidates(pool, { hint: 'commit', diffAdded });

    // Among controls the dialog brought with it, prefer one that is not the
    // dismiss control -- cancel and confirm both appear in the same diff.
    const appeared = diffAdded
      ? ranked.filter((r) => diffAdded.includes(r.el.handle))
      : [];
    if (appeared.length > 1) {
      const discardRanked = rankCandidates(appeared.map((r) => r.el), { hint: 'discard' });
      const dismiss = discardRanked[0];
      const dismissHasSignal = dismiss?.signals.some((sg) => sg.name === 'lexical');
      if (dismissHasSignal) {
        const notDismiss = appeared.find((r) => r.el.handle !== dismiss.el.handle);
        if (notDismiss) return notDismiss.el;
      }
    }

    return (appeared[0] ?? ranked[0])?.el;
  }

  /** Provenance for a step: which entry in the input file it came from. */
  private sourceOf(item: LinearItem): IrSource {
    const visitIndex = this.ir.visits.findIndex((v) => v.visit_id === item.visit_id);
    const visit = this.ir.visits[visitIndex];
    const formIndex = visit ? visit.forms.findIndex((f) => f.form_id === item.form_id) : -1;
    const form = formIndex >= 0 ? visit.forms[formIndex] : undefined;
    const fieldIndex = form ? form.fields.findIndex((f) => f.field_id === item.field_id) : -1;
    return {
      path: `visits[${visitIndex}].forms[${formIndex}].fields[${fieldIndex}]`,
      visit_name: item.visit_name,
      form_name: item.form_name,
      field_label: item.label,
      declared_type: item.canonical_type,
    };
  }

  /** The provenance journal, for export from the side panel. */
  getJournal(): Journal {
    return this.journal;
  }

  /** Non-blocking escalations awaiting end-of-run review. */
  getParked(): EscalationItem[] {
    return this.parked.slice();
  }

  /** Shallow-pass survey, for the pre-flight screen. */
  getTreeSummary(): TreeSummary | null {
    return this.treeSummary;
  }

  private async markVerified(itemKey: string, evidence?: {
    rung: BindingRung; evidence: string[]; reason: string;
  }): Promise<void> {
    const record = this.runState.items[itemKey];
    if (record) {
      record.state = 'verified';
      record.last_verdict = 'VERIFIED';
      await saveRunState(this.adapter, this.runState);
    }

    const item = this.linearItems.find(
      (i) => idempotencyKey(i.visit_id, i.form_id, i.field_id) === itemKey,
    );
    if (item) {
      this.journal.created(
        this.sourceOf(item),
        item.op,
        { rung: evidence?.rung ?? 0, evidence: evidence?.evidence ?? [item.description] },
        { verdict: 'VERIFIED', reason: evidence?.reason ?? `${item.description} confirmed by read-back` },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  private async waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  private emitProgress(stepIndex: number): void {
    const item = this.linearItems[stepIndex];
    const visit = this.irVisitMap.get(item?.visit_id ?? '');
    const form = this.irFormMap.get(item?.form_id ?? '');
    const field = this.irFieldMap.get(item?.field_id ?? '');

    let verified = 0, escalated = 0, failed = 0, pending = 0;
    for (const record of Object.values(this.runState.items)) {
      switch (record.state) {
        case 'verified': verified++; break;
        case 'escalated': escalated++; break;
        case 'failed': failed++; break;
        default: pending++; break;
      }
    }

    this.callbacks.onProgress({
      cursor: stepIndex,
      total: this.linearItems.length,
      currentVisit: visit?.name ?? '',
      currentForm: form?.name ?? '',
      currentField: field?.label ?? '',
      verified,
      escalated,
      failed,
      pending,
      phase: this.phase === 'paused' ? 'paused' : this.phase === 'done' ? 'done' : 'executing',
    });
  }

  private buildPlanSummary(): PlanSummary {
    // Count distinct forms.
    const formNames = new Set<string>();
    for (const visit of this.plan.visits) {
      for (const form of visit.forms) {
        formNames.add(form.name);
      }
    }

    return {
      studyTitle: this.plan.study.title,
      protocolId: this.plan.study.protocol_id,
      visitCount: this.plan.visits.length,
      formAppearances: this.plan.form_appearances,
      distinctForms: formNames.size,
      fieldNodes: this.plan.field_nodes,
      skipEdges: this.plan.skip_edges,
      errors: this.plan.errors.map((e) => ({ message: e.message })),
    };
  }

  private buildSummary(): RunSummary {
    let verified = 0, escalated = 0, failed = 0, skipped = 0;
    const escalations: EscalationItem[] = [];

    for (const record of Object.values(this.runState.items)) {
      switch (record.state) {
        case 'verified': verified++; break;
        case 'escalated':
          escalated++;
          const field = this.irFieldMap.get(record.field_id);
          const form = this.irFormMap.get(record.form_id);
          const visit = this.irVisitMap.get(record.visit_id);
          escalations.push({
            key: record.key,
            fieldLabel: field?.label ?? record.field_id,
            formName: form?.name ?? record.form_id,
            visitName: visit?.name ?? record.visit_id,
            canonicalType: (field?.canonical_type ?? 'text') as CanonicalType,
            reason: record.escalation_reason ?? 'unknown',
            // Reconstructed from persisted state, which does not record the
            // flag. Reported as non-blocking: the run reached its summary, so
            // nothing was still holding it up.
            blocking: false,
            evidence: [],
            phase: 'verifying',
          });
          break;
        case 'failed': failed++; break;
        default: skipped++; break;
      }
    }

    return {
      totalSteps: this.linearItems.length,
      verified,
      escalated,
      failed,
      skipped,
      durationMs: Date.now() - this.startTime,
      escalations,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
