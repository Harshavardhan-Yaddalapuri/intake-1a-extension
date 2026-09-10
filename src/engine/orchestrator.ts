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
 *   - Blocking escalations pause for human input; verifying/parked findings
 *     never halt the build (reviewed in one sitting at the end).
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
import { idempotencyKey, stepIdempotencyKey, CANONICAL_TYPES } from '../shared/contract';
import { FieldPropertyWrites } from './field-properties';
import type {
  EscalationItem,
  RunProgress,
  RunSummary,
  PlanSummary,
  HumanDecision,
} from '../shared/messages';
import type { IntentRecord, VerdictResult } from '../verify/verify';
import { compareIntent, checkFirst, resolveByName } from '../verify/verify';
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
import { navGateAllowsContinue, navGateShouldRetryOpen } from './nav-gate';
import {
  bindAllRung0,
  bindFieldAdd,
  findByRole,
  findByNameOnly,
  findAddCodedValueControl,
  findCodedValueRemoveControls,
  expectedRolesForType,
} from '../bind/rung0';
import { ProbeRunner } from './probe-runner';
import { analyzeCommit, sameSurface } from '../bind/rung1';
import {
  enumerateActionable,
  enumerateActions,
  enumerateByRoles,
  rankCandidates,
} from '../bind/ranking';
import {
  rankCommitCandidates,
  readObservedFields,
  bindFormListFields,
  resolveFormOpenCandidates,
  surfaceShowsForm,
  rankAscendCandidates,
  atVisitList,
  atVisitDetail,
} from '../bind/rung0';
import { Journal, type IrSource } from './journal';
import { rankWithLlm } from '../bind/rung2';
import { makeTypeBinding, inspectPlacedControl, classifyTypeFromProbe } from '../bind/rung1';
import {
  reconcileForm,
  summariseTree,
  normaliseLabel,
  type FormReconcileResult,
  type TreeSummary,
} from './reconcile';

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


/**
 * Whether an escalation should halt the orchestrator.
 *
 * Verifying findings mean the field is already in the study ("Built — needs a
 * look"). They must never block: hostile v7 parked the schedule on Sex at Birth
 * after Demographics was clean and later visits never built.
 */
export function escalationIsBlocking(
  phase: 'binding' | 'acting' | 'verifying',
  blocking: boolean,
): boolean {
  return phase === 'verifying' ? false : blocking;
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

  /** Fields whose read-back did not pass while the form was still being built.
   *  Re-checked against the committed surface before anything is reported, so
   *  a preview that has not caught up is never mistaken for missing work. */
  private pendingVerification: Array<{
    itemKey: string;
    item: LinearItem;
    field: IrField;
    intent: IntentRecord;
  }> = [];

  /** Accessible names seen on the visit list -- a surface with no working copy.
   *  Anything still offered inside the form designer is application chrome, so
   *  it cannot be the control that commits the working copy. */
  private crossScreenChrome: Set<string> = new Set();

  /** Types whose read-back was deferred until their coded values exist, keyed
   *  to the observation taken before the control was placed. A choice control
   *  with no options yet renders no options: its role cannot be read until
   *  set_coded_values has run. See adjudicateType. */
  private deferredTypeProbe: Map<CanonicalType, Observation> = new Map();

  /** Escalation queue: blocking items waiting for human input.
   *  Stores the full EscalationItem so reconnect does not invent phase/blocking. */
  private escalationQueue: Map<string, {
    item: EscalationItem;
    resolve: (d: HumanDecision) => void;
  }> = new Map();

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
  /** How many fields carried an attribute this platform states nowhere, by
   *  attribute. Entered, but with no surface to read it back from -- said once
   *  for the run rather than parked as a finding on every field that has one. */
  private unobservable: Map<string, number> = new Map();
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

    // Build run state with all step keys. Skip-logic steps get a distinct key
    // so they still run after the field body is verified (see stepIdempotencyKey).
    const keys: string[] = [];
    for (const item of this.linearItems) {
      const key = stepIdempotencyKey(item);
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

    // Say what could not be re-read, once, before the pile is reviewed.
    //
    // These are not findings and must never become queue items: a field whose
    // bounds this designer keeps in its own state and never renders is built
    // and correct. But dropping the check silently would be its own dishonesty
    // -- the reviewer is entitled to know which claims the platform let us
    // confirm and which it did not.
    for (const [attr, n] of this.unobservable) {
      this.journal.note(
        'verify',
        `${n} field(s) carry ${attr} that this platform states nowhere on the ` +
        `form: they were entered, and there is no surface to read them back ` +
        `from. Not re-checked, and not reported as findings.`,
      );
    }

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
    const fromQueue = pending?.item;
    if (pending) {
      pending.resolve(decision);
      this.escalationQueue.delete(key);
    }

    // A decision on a grouped escalation settles every item in that group.
    // 13 canonical types means at most 13 type decisions, never 195.
    const resolved =
      fromQueue ?? this.parked.find((p) => p.key === key) ?? null;
    const groupKey = resolved?.groupKey;
    if (groupKey) {
      this.groupDecisions.set(groupKey, decision);
      for (const [otherKey, waiter] of [...this.escalationQueue]) {
        if (waiter.item.groupKey === groupKey) {
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
    // Return the items we stored when we opened the gate. Do NOT reconstruct
    // with phase:'verifying' / blocking:true — that turned binding and visit
    // gates into "Built — needs a look" after a worker blip, and dropped
    // visit-nav / form-open waiters that have no runState.items entry.
    return [...this.escalationQueue.values()].map((w) => w.item);
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

    // Cached progress is a fast path, never a trust boundary. chrome.storage
    // persists across a target reset, so runState may claim a visit's fields
    // are already 'verified' when the LIVE platform just showed that visit
    // does not exist at all -- the previous run happened against a version of
    // the platform that no longer exists. Reconciling the cache against this
    // shallow pass is what makes chrome.storage.local.clear() unnecessary
    // between runs: only genuinely stale cache is discarded, and a real
    // resume against an unchanged platform keeps its progress.
    await this.invalidateStaleCache(presentByVisit);

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

  /**
   * Discard cached progress for any visit the live platform just showed does
   * not exist.
   *
   * A cache entry is trustworthy only as long as the platform it describes is
   * the same platform state that produced it. `presentByVisit` is this run's
   * OWN live observation, taken moments ago, so it is authoritative: if a
   * visit is absent from it, nothing under that visit can genuinely be built,
   * regardless of what an earlier session's runState claims.
   *
   * Deliberately coarse: a full run reset (cursor back to 0) rather than a
   * surgical per-item repair. Re-deriving from reconcile is cheap -- adopt
   * decisions for anything the platform genuinely has are near-instant -- and
   * correctness here matters far more than shaving a few redundant reconcile
   * calls.
   */
  private async invalidateStaleCache(presentByVisit: Record<string, string[]>): Promise<void> {
    const presentVisitNames = new Set(Object.keys(presentByVisit).map((n) => normaliseLabel(n)));
    let invalidated = false;

    for (const item of this.linearItems) {
      const key = stepIdempotencyKey(item);
      const record = this.runState.items[key];
      if (!record || record.state === 'pending') continue;

      if (!presentVisitNames.has(normaliseLabel(item.visit_name))) {
        record.state = 'pending';
        record.last_verdict = undefined;
        record.rebind_count = 0;
        invalidated = true;
      }
    }

    if (invalidated) {
      this.runState.cursor = 0;
      this.journal.note(
        'preflight',
        'cached progress from a previous run referenced a visit the platform ' +
        'no longer has; that progress was discarded rather than trusted',
      );
      await saveRunState(this.adapter, this.runState);
    }
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
      const itemKey = stepIdempotencyKey(item);
      const record = this.runState.items[itemKey];

      // Skip already-verified items (idempotency).
      if (record && record.state === 'verified') {
        this.runState.cursor = i + 1;
        this.emitProgress(i);
        continue;
      }

      // Skip escalated items (human will resolve later) — except skip-logic /
      // formula property writes. Reconcile does not observe those properties, and
      // a prior escalate (e.g. wrong visibility option label) must not permanently
      // suppress retries after a code fix on an otherwise complete study.
      if (record && record.state === 'escalated') {
        if (item.kind === 'set_skip_logic' || item.kind === 'set_formula') {
          record.state = 'pending';
          record.last_verdict = undefined;
        } else {
          this.runState.cursor = i + 1;
          this.emitProgress(i);
          continue;
        }
      }

      // If form context is changing, commit the current form first!
      if (prevFormId !== '' && item.form_id !== prevFormId) {
        await this.commitCurrentForm();
        await this.settlePendingVerification();
      }

      // Navigate to the correct visit if context changed. A visit we could not
      // open is a visit we do not build: its steps are skipped, not written
      // into whichever visit is still on screen.
      if (item.visit_id !== prevVisitId) {
        if (!(await this.navigateToVisit(item.visit_id))) {
          i = this.skipSpan(i, (it) => it.visit_id === item.visit_id);
          prevVisitId = '';
          prevFormId = '';
          continue;
        }
        prevVisitId = item.visit_id;
        prevFormId = ''; // Force form navigation too.
      }

      // Navigate to the correct form if context changed.
      if (item.form_id !== prevFormId) {
        if (!(await this.navigateToForm(item.visit_id, item.form_id))) {
          i = this.skipSpan(i, (it) => it.form_id === item.form_id);
          prevFormId = '';
          continue;
        }
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
      await this.settlePendingVerification();
    }
  }

  /**
   * Advance past every remaining step in an unreachable span, leaving them
   * unverified so the summary reports them missing. navigateTo* has already
   * escalated; this only stops the steps from running in the wrong place.
   * Returns the last index consumed (the for-loop's i++ moves past it).
   */
  private skipSpan(from: number, inSpan: (it: LinearItem) => boolean): number {
    let i = from;
    while (i + 1 < this.linearItems.length && inSpan(this.linearItems[i + 1])) i += 1;
    this.runState.cursor = i + 1;
    return i;
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

    // Reconcile adopts on label/type/required/range/codes only — it never looks
    // at skip_logic or formula. Adopting those micro-steps marks them verified
    // without writing, which is exactly how live Mock A stayed at 0/13 skip
    // rules after structure+formulas were already present.
    if (
      decision?.action === 'adopt' &&
      item.kind !== 'set_skip_logic' &&
      item.kind !== 'set_formula'
    ) {
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
      formula: field.formula,
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
      case 'set_formula':
        await this.executeFieldSetFormula(item, itemKey, field);
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
    const verdict = this.countUnobservable(compareIntent(observation, intent));

    if (verdict.verdict === 'VERIFIED') {
      await this.markVerified(itemKey, {
        rung: 0,
        evidence: [`range re-read after the type was final: ${verdict.reason}`],
        reason: verdict.reason,
      });
      return;
    }

    // A miss here is not yet a finding, for the same reason it is not one on
    // the main path: this canvas re-renders only when the form's SHAPE changes,
    // so a label typed a moment ago is still absent from it. Escalating here
    // reported the field twice -- once now and once after the commit -- and the
    // second look was the one that could see anything. Defer to it.
    this.pendingVerification.push({ itemKey, item, field, intent });
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
      const stored = await chrome.storage.local.get('openRouterApiKey');
      const apiKey: string | null =
        typeof stored?.openRouterApiKey === 'string' ? stored.openRouterApiKey : null;

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
      // Human Change-type installs a binding; continue and place rather than
      // abandoning the field (live: override collapsed the card and left
      // Demographics empty while the run looked stopped).
      typeBinding = this.typeBindings[field.canonical_type];
      if (!typeBinding) return;
      const rec = this.runState.items[itemKey];
      if (rec && rec.state === 'escalated') {
        rec.state = 'pending';
        rec.rebind_count = 0;
        delete rec.escalation_reason;
      }
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

    // Adjudicate the type mapping against what ACTUALLY appeared.
    //
    // A rung 0 binding is a name guess: the ladder used to escalate only when
    // no binding existed at all, so a confidently wrong guess was never
    // challenged and every field of that type was built on it. Placing the
    // control is itself the probe -- it has already happened here, so this
    // costs nothing extra and needs no scratch control.
    //
    // Runs once per canonical type: a confirmed mapping is upgraded to
    // `structural` and cached, so the cost is bounded by 13, not by 195.
    if (elementAdded && typeBinding.confidence !== 'structural') {
      const settled = await this.adjudicateType(
        item, itemKey, field, preObs, postObs, /* mayDefer */ true,
      );
      if (!settled) return;
      typeBinding = this.typeBindings[field.canonical_type] ?? typeBinding;
    }

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

  /**
   * Decide whether the control that appeared is the type the input file asked
   * for, and act on the answer: confirm and cache the mapping, defer it, or
   * hand the disagreement to a human.
   *
   * Returns false when the caller must stop (the item escalated).
   *
   * The deferral is the point. A choice control renders its options and
   * nothing else, so before `set_coded_values` runs there is no radiogroup to
   * see -- the read-back would be judging a control the platform has not
   * realised yet. Absent evidence is not contradictory evidence, so the
   * question is asked again once the values exist rather than answered wrong
   * now. Live, this escalated all 10 radio fields on a mapping that was
   * correct.
   */
  private async adjudicateType(
    item: LinearItem,
    itemKey: string,
    field: IrField,
    preObs: Observation,
    postObs: Observation,
    mayDefer: boolean,
  ): Promise<boolean> {
    const typeBinding = this.typeBindings[field.canonical_type];
    if (!typeBinding) return true;

    const scope =
      `${this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id} > ` +
      `${this.irFormMap.get(item.form_id)?.name ?? item.form_id}`;
    const probe = inspectPlacedControl(preObs, postObs);
    const classification = classifyTypeFromProbe(field.canonical_type, probe);

    if (classification.matches) {
      this.deferredTypeProbe.delete(field.canonical_type);
      const paletteName = typeBinding.recipe[0]?.evidence_name ?? '';
      const paletteEl = preObs.elements.find((e) => e.name === paletteName);
      this.typeBindings[field.canonical_type] = makeTypeBinding(
        field.canonical_type, probe, paletteName, paletteEl?.handle ?? '',
      );
      this.journal.note(
        scope,
        `"${paletteName}" confirmed as ${field.canonical_type} by read-back ` +
        `(role ${probe.observedRole}); every later field of this type uses it.`,
      );
      return true;
    }

    // Nothing to read yet: this control's type IS its options, and they have
    // not been entered. Ask again after set_coded_values.
    if (mayDefer && probe.observedOptions.length === 0 && (field.options?.length ?? 0) > 0) {
      this.deferredTypeProbe.set(field.canonical_type, preObs);
      this.journal.note(
        scope,
        `${field.canonical_type} read-back deferred: the placed control has no ` +
        `options yet (saw role ${probe.observedRole || 'none'}), so its type is ` +
        `not observable until the coded values are entered.`,
      );
      return true;
    }

    // The name said one thing and the control says another. Behaviour wins,
    // but the disagreement is the human's to settle -- and it settles for
    // every field of this type at once.
    this.deferredTypeProbe.delete(field.canonical_type);
    const affected = this.linearItems.filter(
      (i) => i.kind === 'add' && i.canonical_type === field.canonical_type,
    );
    await applyTransition(this.adapter, this.runState, itemKey, 'verify_failed');
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
      suspectedTrap:
        'a palette entry whose name suggests one type can place another; ' +
        'names are a hint, the placed control is the evidence',
      reason:
        `Placed "${typeBinding.recipe[0]?.evidence_name}" for ` +
        `${field.canonical_type} and a ${probe.observedRole || 'unrecognised'} ` +
        `control appeared instead.`,
      evidence: [
        `expected role: ${expectedRolesForType(field.canonical_type).join(' | ')}`,
        `observed role: ${probe.observedRole || 'none'}`,
        classification.evidence,
        ...typeBinding.evidence,
      ],
      phase: 'binding',
    }, /* blocking */ true);
    return false;
  }

  private async executeFieldSetCodedValues(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    if (!field.options || field.options.length === 0) return;

    const codesOf = (o: Observation) => findByRole(o, 'textbox', { contains: 'code' });
    // The element's OWN label field is also named "Label", and it already
    // holds the field name. Row labels are aligned from the END, where the
    // count of row labels equals the count of code inputs, so the field's own
    // label can never be mistaken for an option's and overwritten with it.
    const rowLabelsOf = (o: Observation, codeCount: number) => {
      const codes = codesOf(o);
      const labels = findByRole(o, 'textbox', { contains: 'label' })
        .filter((c) => !codes.some((ci) => ci.el.handle === c.el.handle));
      return labels.slice(Math.max(0, labels.length - codeCount));
    };
    // An editor that renders one row per existing value offers NO code/label
    // inputs until a row exists, so the row-adding control has to be pressed
    // before there is anything to type into. The previous order -- type, then
    // press add -- could never start on such a platform: it required the
    // inputs it was there to create, found none, and silently entered nothing.
    // Editors that keep a blank row ready need no press, and land in the same
    // place.
    //
    // ponytail: per-row entry only. A platform offering ONLY a bulk paste box
    // needs its format guessed, which is not generalisable; add a fallback
    // when one such platform is actually in hand.
    for (let i = 0; i < field.options.length; i += 1) {
      const pair = field.options[i];
      let { observation } = await this.driver.perceive();
      let codes = codesOf(observation);

      if (codes.length <= i) {
        const add = findAddCodedValueControl(observation);
        if (!add) break;
        await this.driver.click(add.handle);
        await this.sleep(200);
        ({ observation } = await this.driver.perceive());
        codes = codesOf(observation);
        if (codes.length <= i) break; // the control did not add a row
      }

      const rowLabels = rowLabelsOf(observation, codes.length);
      await this.driver.setValue(codes[i].el.handle, pair.code);
      if (rowLabels[i]) await this.driver.setValue(rowLabels[i].el.handle, pair.label);
    }

    // Platforms that keep option inputs uncontrolled (draft text excluded from
    // the layout key) do not re-render the canvas after the last label is
    // typed. Live, Race's fifth checkbox stayed aria-labelled "Race: " while
    // the Options panel already held OT/Other — VERIFY then saw a blank option
    // and parked every multi_select. Nudge a shape-changing add+remove so the
    // canvas catches up before deferred type read-back / set_required.
    await this.nudgeCodedValuesCanvasRefresh(codesOf);
    await this.pruneEmptyCodedValueRows(codesOf, field.options.length);

    // The options now exist, so the control finally shows what it is. Settle
    // any read-back this type deferred at add time.
    const deferredFrom = this.deferredTypeProbe.get(field.canonical_type);
    if (deferredFrom) {
      this.deferredTypeProbe.delete(field.canonical_type);
      const { observation: realised } = await this.driver.perceiveAfterSettle(250);
      await this.adjudicateType(
        item, itemKey, field, deferredFrom, realised, /* mayDefer */ false,
      );
    }
  }

  /**
   * Force a layout-key change after coded-value text writes so the canvas
   * re-renders option labels that live only in platform state until then.
   */
  private async nudgeCodedValuesCanvasRefresh(
    codesOf: (o: Observation) => ReturnType<typeof findByRole>,
  ): Promise<void> {
    let { observation } = await this.driver.perceive();
    const before = codesOf(observation).length;
    const add = findAddCodedValueControl(observation);
    if (!add) return;
    await this.driver.click(add.handle);
    await this.sleep(150);
    ({ observation } = await this.driver.perceive());
    if (codesOf(observation).length <= before) return;
    // Rosetta/Nexus label the row delete control "x", not "×" or "Remove".
    // Missing that match left a permanent blank ('','') option after every
    // choice field write (live Rosetta v9 coded-pairs).
    const removes = findCodedValueRemoveControls(observation);
    if (removes.length === 0) {
      // Could not undo the nudge — still try to drop an empty trailing row
      // by re-finding after a beat rather than leaving the blank option.
      return;
    }
    await this.driver.click(removes[removes.length - 1].handle);
    await this.sleep(150);
  }

  /**
   * Drop trailing empty code/label rows left by a failed canvas-refresh nudge
   * or by editors that keep a blank starter row after real values are filled.
   */
  private async pruneEmptyCodedValueRows(
    codesOf: (o: Observation) => ReturnType<typeof findByRole>,
    keepCount: number,
  ): Promise<void> {
    for (let guard = 0; guard < 8; guard += 1) {
      let { observation } = await this.driver.perceive();
      const codes = codesOf(observation);
      if (codes.length <= keepCount) return;
      // Only prune a row that is still blank — never a filled option.
      const last = codes[codes.length - 1]?.el;
      const lastCode = (last?.state.value ?? '').trim();
      const labels = findByRole(observation, 'textbox', { contains: 'label' })
        .filter((c) => !codes.some((ci) => ci.el.handle === c.el.handle));
      const lastLabel = labels[labels.length - 1]?.el;
      const lastLabelVal = (lastLabel?.state.value ?? '').trim();
      if (lastCode || lastLabelVal) return;
      const removes = findCodedValueRemoveControls(observation);
      if (removes.length === 0) return;
      await this.driver.click(removes[removes.length - 1].handle);
      await this.sleep(120);
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
      // findByRole matches name OR groupText, so nameless Required checkboxes
      // on Rosetta/Nexus (broken label[for]) still resolve.
      let requiredCheckboxes = findByRole(observation, 'checkbox', { contains: 'require' });
      // Prefer an unchecked Required over Hidden when both match loosely.
      const preferred =
        requiredCheckboxes.find((c) => /requir/i.test(c.el.name || c.el.groupText || '')) ??
        requiredCheckboxes[0];

      if (preferred) {
        const el = preferred.el;
        if (!el.state.checked) {
          await this.driver.check(el.handle, true);
          await this.sleep(200);
        }
        // Verify the write stuck — silent required=false was ~47% of Rosetta
        // required misses when the click hit the wrong or unbound control.
        const { observation: after } = await this.driver.perceive();
        const again = findByRole(after, 'checkbox', { contains: 'require' })
          .find((c) => c.el.handle === el.handle) ??
          findByRole(after, 'checkbox', { contains: 'require' })[0];
        if (again && !again.el.state.checked) {
          await this.driver.check(again.el.handle, true);
          await this.sleep(150);
        }
      } else {
        this.journal.note(
          this.sourceOf(item).path,
          `field.set_required: no Required checkbox found for "${field.label}" ` +
          `(wanted required=true); leaving for commit-time verify`,
        );
      }
    }

    // FIRST LOOK. A pass here is real and costs nothing to accept.
    //
    // A miss is NOT yet a finding. The canvas a designer draws while you type
    // is not required to keep up with what you typed: this platform re-renders
    // only when the shape of the form changes, so a label and its units live in
    // the platform's own state while the preview still shows the type's default
    // name. Read then, "Height" is nowhere on screen although the field is
    // built, has its range, and saves correctly. Live, that produced 59 reports
    // of missing numeric fields, every one of them wrong.
    //
    // So anything that does not pass now is re-checked once the form is
    // committed, which is the only surface that speaks for what was persisted
    // -- and persistence is the thing being claimed.
    const { observation: finalObs } = await this.driver.perceiveAfterSettle(300);
    const verdict = this.countUnobservable(compareIntent(finalObs, intent));

    if (verdict.verdict !== 'VERIFIED') {
      this.pendingVerification.push({ itemKey, item, field, intent });
      return;
    }

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

  private async executeFieldSetFormula(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    if (!field.formula) {
      await this.markVerified(itemKey, {
        rung: 0,
        evidence: ['no formula in IR; nothing to write'],
        reason: 'set_formula skipped (empty)',
      });
      return;
    }

    const { observation } = await this.driver.perceive();
    const input = FieldPropertyWrites.findFormulaInput(observation);
    if (!input) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: 'no formula/expression input found in the property editor',
        suspectedTrap:
          'calculated fields expose a formula editor only when that type is ' +
          'selected; the type may not have settled, or this platform names it oddly',
        evidence: ['field.set_formula: formula input absent'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    await this.driver.setValue(input.handle, field.formula);
    await this.sleep(200);

    const { observation: after } = await this.driver.perceiveAfterSettle(200);
    const check = FieldPropertyWrites.formulaLooksSet(after, field.formula);
    if (check.ok) {
      await this.markVerified(itemKey, {
        rung: 0,
        evidence: [check.evidence],
        reason: check.evidence,
      });
      return;
    }

    await this.escalateItem(itemKey, 'verifying', {
      key: itemKey,
      fieldLabel: field.label,
      formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
      visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
      canonicalType: field.canonical_type,
      reason: check.evidence,
      suspectedTrap: 'formula write did not stick on read-back',
      evidence: [check.evidence],
      phase: 'verifying',
    }, /* blocking */ false);
  }

  private async executeFieldSetSkipLogic(
    item: LinearItem,
    itemKey: string,
    field: IrField,
  ): Promise<void> {
    if (!field.skip_logic) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: 'set_skip_logic planned but IR has no skip_logic on this field',
        evidence: ['missing field.skip_logic'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    // Form-end: the property editor may still be showing a different field.
    // Open this field first so Visibility / When / Equals controls exist.
    if (!(await this.selectFieldForProperties(field))) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: `could not select field "${field.label}" on the canvas to edit skip logic`,
        evidence: ['selectFieldForProperties failed'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    const { observation } = await this.driver.perceive();
    const mode = FieldPropertyWrites.findVisibilityModeControl(observation);
    if (!mode) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: 'no visibility/display-mode control found in the property editor',
        suspectedTrap:
          'skip logic is unbindable on this surface, or the field was not selected',
        evidence: ['visibility mode control absent'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    const conditionalOption = FieldPropertyWrites.pickConditionalModeOption(mode.options);
    if (!conditionalOption) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason:
          `visibility control "${mode.name}" has no option that looks conditional ` +
          `(options: ${mode.options.join(' | ') || 'none'})`,
        evidence: [`options=[${mode.options.join(', ')}]`],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    // Select the platform's OWN option label (e.g. "Visible When…"), never a
    // hardcoded "Conditional" string that Mock A does not offer.
    //
    // Mock A setVisibilityMode('when') RESETS whenElementId/equalsValue every
    // time. Re-picking an already-conditional mode would wipe a partial write
    // and is unnecessary — only change the mode when it is not yet conditional.
    const modeValue = (mode.state.value ?? '').toLowerCase();
    const alreadyConditional =
      modeValue === 'when' ||
      modeValue === conditionalOption.toLowerCase() ||
      modeValue.includes('when') ||
      ['when', 'conditional', 'if', 'depends'].some((w) => modeValue.includes(w));
    if (!alreadyConditional) {
      const modeRes = await this.driver.selectOption(mode.handle, conditionalOption);
      if (!modeRes.ok) {
        await this.escalateItem(itemKey, 'acting', {
          key: itemKey,
          fieldLabel: field.label,
          formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
          visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
          canonicalType: field.canonical_type,
          reason: `failed to select visibility option "${conditionalOption}": ${modeRes.error ?? 'unknown'}`,
          evidence: [modeRes.error ?? 'selectOption failed'],
          phase: 'acting',
        }, /* blocking */ false);
        return;
      }
      await this.sleep(300);
    }

    const { observation: afterMode } = await this.driver.perceive();
    const whenSelect = FieldPropertyWrites.findWhenFieldControl(
      afterMode,
      field.skip_logic.when_field_label,
    );
    if (!whenSelect) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason:
          'visibility is conditional but no when-element select appeared — ' +
          'Mock A only persists skipLogic when whenElementId is set',
        evidence: ['when-element control absent after selecting conditional mode'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    const whenOption =
      FieldPropertyWrites.pickOptionLabel(
        whenSelect.options,
        field.skip_logic.when_field_label,
      ) ?? field.skip_logic.when_field_label;
    const whenRes = await this.driver.selectOption(whenSelect.handle, whenOption);
    if (!whenRes.ok) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason:
          `failed to select controlling field "${field.skip_logic.when_field_label}" ` +
          `in when-control: ${whenRes.error ?? 'unknown'}`,
        suspectedTrap:
          'when-element list may have self-excluded the controlling field because ' +
          'the options panel was still editing that field (or a neighbour), not ' +
          `"${field.label}"`,
        evidence: [whenRes.error ?? 'selectOption failed'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }
    await this.sleep(200);

    const { observation: afterWhen } = await this.driver.perceive();
    const valueInput = FieldPropertyWrites.findEqualsValueInput(afterWhen);
    if (!valueInput) {
      await this.escalateItem(itemKey, 'acting', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: 'no equals-value input found after setting when-element',
        evidence: ['equals-value input absent'],
        phase: 'acting',
      }, /* blocking */ false);
      return;
    }

    await this.driver.setValue(valueInput.handle, field.skip_logic.equals_value);
    await this.sleep(150);

    const { observation: finalObs } = await this.driver.perceiveAfterSettle(250);
    const onField = FieldPropertyWrites.propertyPanelShowsField(finalObs, field.label);
    const check = FieldPropertyWrites.skipLogicLooksSet(
      finalObs,
      field.skip_logic.equals_value,
      field.skip_logic.when_field_label,
    );
    if (check.ok && onField) {
      await this.markVerified(itemKey, {
        rung: 0,
        evidence: [check.evidence, `mode option="${conditionalOption}"`],
        reason: check.evidence,
      });
      return;
    }

    await this.escalateItem(itemKey, 'verifying', {
      key: itemKey,
      fieldLabel: field.label,
      formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
      visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
      canonicalType: field.canonical_type,
      reason: onField ? check.evidence : `options panel is not editing "${field.label}" after skip write`,
      suspectedTrap: onField
        ? 'skip logic write did not read back'
        : 'skip logic may have been written onto a different selected field',
      evidence: [
        check.evidence,
        `tried mode option="${conditionalOption}"`,
        onField ? 'property Label matches field' : 'property Label mismatch',
      ],
      phase: 'verifying',
    }, /* blocking */ false);
  }

  /**
   * Click the canvas control for a field so its property editor is showing.
   * Required before form-end skip-logic writes: the options panel only edits
   * the currently selected element.
   */
  private async selectFieldForProperties(field: IrField): Promise<boolean> {
    // Form-end skip writes must edit THIS field's visibility. If the previous
    // field (e.g. Outcome before Resolution Date) is still selected, When
    // Element self-excludes that controlling label and selectOption fails —
    // the live 4/13 miss pattern.
    let { observation } = await this.driver.perceive();
    if (FieldPropertyWrites.propertyPanelShowsField(observation, field.label)) {
      return true;
    }

    const tryClick = async (handle: string): Promise<boolean> => {
      await this.driver.click(handle);
      await this.sleep(250);
      const { observation: after } = await this.driver.perceive();
      return FieldPropertyWrites.propertyPanelShowsField(after, field.label);
    };

    const match = resolveByName(observation, field.label);
    if (match && match !== 'ambiguous') {
      if (await tryClick(match.el.handle)) return true;
      // Option-group / card-group: try every member.
      if (match.members) {
        for (const m of match.members) {
          if (await tryClick(m.handle)) return true;
        }
      }
    }

    // Ambiguous or click-on-inner-control did not select the card: try every
    // exact-name hit (canvas + preview duplicates).
    const exact = observation.elements.filter((e) => e.name === field.label);
    for (const el of exact) {
      if (await tryClick(el.handle)) return true;
    }

    // Last resort: any control whose group text parts include the label
    // (element-card chrome), preferring ones that are not the options Label.
    const grouped = observation.elements.filter((e) =>
      e.groupTextParts?.some((p) => p.trim() === field.label),
    );
    for (const el of grouped) {
      if (await tryClick(el.handle)) return true;
    }

    ({ observation } = await this.driver.perceive());
    return FieldPropertyWrites.propertyPanelShowsField(observation, field.label);
  }

  // -------------------------------------------------------------------------
  // Navigation.
  // -------------------------------------------------------------------------

  private async navigateToVisit(visitId: string): Promise<boolean> {
    if (this.currentVisitId === visitId) return true;

    const visit = this.irVisitMap.get(visitId);
    if (!visit) return false;

    const visitNames = [...this.irVisitMap.values()].map((v) => v.name);
    const createControl = this.bindings['visit.create']?.recipe?.[0]?.evidence_name;

    // Already on this visit's form list (e.g. just left its designer via
    // breadcrumb). Re-climbing to the schedule and re-clicking the visit is
    // unnecessary — and hostile ascend ranking used to fail that climb, so
    // Screening escalated as "could not open" after Demographics was built.
    {
      const { observation: here } = await this.driver.perceive();
      if (atVisitDetail(here, visit.name, visitNames)) {
        this.currentVisitId = visitId;
        this.currentFormId = null;
        return true;
      }
    }

    // Climb to the visit list, CONFIRMING arrival instead of assuming it.
    // A single pre-bound "go to study root" click cannot do this job: on the
    // supplied mock that control is the already-active nav tab and is inert at
    // every depth, so the run silently stayed inside one visit and built every
    // form into it.
    const hops: string[] = [];
    // Visit detail exposes form-create; that must never count as "reached the
    // visit list" even if visit.create was rebound to "+ New Record Sheet".
    const onVisitList = (o: Observation) =>
      atVisitList(o, visitNames, createControl) && !atVisitDetail(o);
    let reached = onVisitList((await this.driver.perceive()).observation);
    for (let hop = 0; hop < 4 && !reached; hop += 1) {
      const { observation } = await this.driver.perceive();
      // Still inside this visit's form list after a hop (e.g. designer →
      // detail via "<- Screening"). That IS the destination — keep climbing
      // and we leave it for the schedule, then fail to re-open (Hostile E2E
      // v6 Screening "could not open this visit" after Demographics).
      if (atVisitDetail(observation, visit.name, visitNames)) {
        this.currentVisitId = visitId;
        this.currentFormId = null;
        return true;
      }
      const best = rankAscendCandidates(observation, visitNames)[0];
      if (!best) break;
      await this.driver.click(best.handle);
      await this.sleep(450);
      const { observation: after } = await this.driver.perceiveAfterSettle(200);
      hops.push(best.name);
      if (atVisitDetail(after, visit.name, visitNames)) {
        this.currentVisitId = visitId;
        this.currentFormId = null;
        return true;
      }
      reached = onVisitList(after);
    }

    if (!reached) {
      const decision = await this.escalateItem(`visit-nav:${visitId}`, 'acting', {
        key: `visit-nav:${visitId}`,
        fieldLabel: '(whole visit)',
        canonicalType: 'text',
        formName: '(none)',
        visitName: visit.name,
        suspectedTrap:
          'The control that ascends is named after the level it leaves, so it ' +
          'differs per level; a top-level nav item may look right and be inert.',
        reason:
          `Could not reach the visit list to open "${visit.name}". Nothing was ` +
          `built for this visit rather than building it into whichever visit ` +
          `was already open.`,
        evidence: hops.length ? [`ascended via: ${hops.join(' -> ')}`] : ['no ascend candidate found'],
        phase: 'acting',
      }, /* blocking */ true);

      // Human may have navigated to the visit list (or into this visit) while
      // the gate was up. Do not skipSpan a fresh study after Approve.
      const { observation: now } = await this.driver.perceive();
      if (atVisitDetail(now, visit.name, visitNames)) {
        this.currentVisitId = visitId;
        this.currentFormId = null;
        return true;
      }
      if (onVisitList(now)) {
        reached = true;
      } else if (!decision || decision.action === 'skip') {
        return false;
      } else {
        return false;
      }
    }

    // Remember what this surface offers. There is no working copy on the visit
    // list, so nothing reachable from here can be the control that commits
    // one -- these are the application's chrome, present on every screen. The
    // commit search uses this to avoid probing navigation: clicking a nav tab
    // to find out whether it saves is destructive on any platform where
    // navigating away discards the draft, and this one does exactly that.
    for (const el of enumerateActionable((await this.driver.perceive()).observation)) {
      if (el.name) this.crossScreenChrome.add(normaliseLabel(el.name));
    }

    // Create the visit if it is not already listed.
    const nameMatches = (o: Observation) => enumerateActionable(o).find(
      (e) => normaliseLabel(e.name) === normaliseLabel(visit.name),
    );

    if (!nameMatches((await this.driver.perceive()).observation)) {
      await this.createVisit(visit);
      await this.sleep(300);
    }

    // Open it, then confirm THIS visit opened before recording that it did.
    const { observation: listed } = await this.driver.perceiveAfterSettle(200);
    const link = nameMatches(listed);
    let opened = false;
    if (link) {
      for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
        await this.driver.click(link.handle);
        await this.sleep(500 + attempt * 300);
        const { observation: after } = await this.driver.perceiveAfterSettle(250 + attempt * 200);
        // Prefer positive structural proof (form-create control on the visit
        // detail) over negating atVisitList — inert "Phases" chrome made the
        // negation unreliable and blocked Screening after the create-control fix.
        // Prefer positive form-create proof. Negating atVisitList alone is not
        // enough when a poisoned createControl made the list witness fire on
        // detail — require that we left the list OR landed on detail.
        opened = atVisitDetail(after, visit.name, visitNames)
          || (Boolean(link) && !onVisitList(after));
      }
    }

    if (!opened) {
      const decision = await this.escalateItem(`visit-open:${visitId}`, 'acting', {
        key: `visit-open:${visitId}`,
        fieldLabel: '(whole visit)',
        canonicalType: 'text',
        formName: '(none)',
        visitName: visit.name,
        reason:
          `Reached the visit list but could not confirm "${visit.name}" opened` +
          `${link ? '' : ' (it was not listed after creation)'}. Its forms are ` +
          `not being built, to avoid adding them to another visit.`,
        evidence: [`visit control ${link ? `"${link.name}" clicked` : 'not found'}`],
        phase: 'acting',
      }, /* blocking */ true);

      // ROOT CAUSE of swapped/Nexus "208 skipped" after a human Approve on the
      // visit-open gate: we used to ignore the decision and always return
      // false → skipSpan the entire visit. Approve looked like consent to
      // continue, but the schedule still skipped. Re-perceive first — the
      // human may have opened the visit while the gate was up — and on
      // retry/approve, attempt one more open before giving up.
      const recovered = await this.confirmVisitOpenAfterGate(
        visitId, visit.name, visitNames, onVisitList, nameMatches, decision,
      );
      if (!recovered) return false;
    }

    this.currentVisitId = visitId;
    this.currentFormId = null;
    return true;
  }

  /**
   * After a blocking visit-open gate, decide whether the visit is now open.
   * Surface evidence wins over the button label: Approve without the visit
   * detail on screen still refuses (do not build into the wrong visit).
   */
  private async confirmVisitOpenAfterGate(
    _visitId: string,
    visitName: string,
    visitNames: string[],
    onVisitList: (o: Observation) => boolean,
    nameMatches: (o: Observation) => ReturnType<typeof enumerateActionable>[number] | undefined,
    decision: { action: string } | null,
  ): Promise<boolean> {
    const detailOk = (o: Observation) =>
      atVisitDetail(o, visitName, visitNames);

    let { observation: now } = await this.driver.perceive();
    if (navGateAllowsContinue(decision, detailOk(now))) return true;

    if (!navGateShouldRetryOpen(decision)) return false;

    // retry / approve: one more click on the visit control if listed.
    const link = nameMatches(now);
    if (link) {
      await this.driver.click(link.handle);
      await this.sleep(500);
      ({ observation: now } = await this.driver.perceiveAfterSettle(250));
      if (navGateAllowsContinue(decision, detailOk(now))) return true;
      // Left the list without a named detail witness — still accept when the
      // create-control witness says we are no longer on the visit list.
      if (!onVisitList(now) && link) return true;
    }
    return navGateAllowsContinue(decision, detailOk(now));
  }

  private async createVisit(visit: IrVisit): Promise<void> {
    // Every step here is journalled. A visit that fails to appear is otherwise
    // indistinguishable from a dialog that never opened, a name that never
    // landed, or a commit control that did nothing -- and the run cannot say
    // which, because none of it was recorded.
    const trace: string[] = [];
    const say = (s: string) => { trace.push(s); };
    const done = () => this.journal.note(`visit.create:${visit.name}`, trace.join(' | '));

    const createBinding = this.bindings['visit.create'];
    if (!createBinding) {
      say('ABORTED: visit.create never bound, so nothing was attempted');
      done();
      return;
    }
    say(`binding recipe steps=${createBinding.recipe.length}`);

    // Click the "add visit" button.
    if (createBinding.recipe.length > 0) {
      const { observation } = await this.driver.perceive();
      const addPool = enumerateActionable(observation);
      const addBtn = rankCandidates(addPool, { hint: 'visit_create' })[0]?.el;
      // Remember the pre-dialog surface so the controls the dialog brings with
      // it can be told apart from the page chrome that was always there.
      this.preDialogObs = observation;
      say(`add control=${addBtn ? JSON.stringify(addBtn.name) : 'NONE FOUND'}`);
      if (addBtn) {
        await this.driver.click(addBtn.handle);
        await this.sleep(300);
      }
    } else {
      say('add control NOT clicked: recipe is empty');
    }

    // Fill in the visit name.
    const { observation: formObs } = await this.driver.perceive();
    const textPool = enumerateByRoles(formObs, ['textbox', 'searchbox']);
    say(`text inputs after opening=[${textPool.map((e) => e.name).join(', ')}]`);
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0]?.el;
    say(`name input=${nameBox ? JSON.stringify(nameBox.name) : 'NONE FOUND'}`);
    if (nameBox) {
      const wrote = await this.driver.setValue(nameBox.handle, visit.name);
      if (!wrote.ok) say(`name write FAILED: ${wrote.error ?? 'unknown'}`);
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

    // Click save. Read the name field back FIRST: a platform that silently
    // drops the write (its own draft never updated) looks identical to one
    // that saved nothing, and only this distinguishes them.
    const { observation: saveObs } = await this.driver.perceive();
    const nameNow = nameBox
      ? enumerateByRoles(saveObs, ['textbox', 'searchbox'])
          .find((e) => e.handle === nameBox.handle)?.state.value
      : undefined;
    say(`name reads back as ${JSON.stringify(nameNow ?? null)} (wanted ${JSON.stringify(visit.name)})`);

    const saveBtn = this.pickDialogCommit(saveObs);
    say(`commit control=${saveBtn ? JSON.stringify(saveBtn.name) : 'NONE FOUND'}`);
    if (saveBtn) {
      const clicked = await this.driver.click(saveBtn.handle, false);
      if (!clicked.ok) say(`commit click FAILED: ${clicked.error ?? 'unknown'}`);
      await this.sleep(500);
    }
    done();
  }

  private async navigateToForm(visitId: string, formId: string): Promise<boolean> {
    if (this.currentFormId === formId) return true;

    const form = this.irFormMap.get(formId);
    if (!form) return false;

    // Sibling forms sharing this visit's list. Used to tell the list screen
    // (many forms named) from a designer surface (one form named).
    const visitName = this.irVisitMap.get(visitId)?.name ?? visitId;
    const siblings = (this.irVisitMap.get(visitId)?.forms ?? [])
      .map((f) => f.name)
      .filter((n) => n !== form.name);

    // Does the form already exist? Resolved by the row that BEARS ITS NAME,
    // never by the open-control's own label: a list of N forms renders N
    // identical "Edit" controls, so matching on the control always returns the
    // first row and silently builds every form into whichever sits on top.
    let { observation } = await this.driver.perceive();

    // "Not visible" and "does not exist" are different claims, and the run
    // used to treat the first as the second. After a form is built the agent
    // is standing INSIDE that form's designer, where no document list exists
    // to search -- so every later form in the visit found zero candidates,
    // was "created" onto the designer surface, and escalated. Live, that cost
    // 24 of 28 forms while all four visits sat there correctly created.
    //
    // So before concluding a form is absent, go and look from the surface
    // that lists forms. Re-opening the visit lands there and is already
    // read-back confirmed; clearing currentVisitId is what stops
    // navigateToVisit short-circuiting on "we are already there".
    if (resolveFormOpenCandidates(observation, form.name, [visitName]).length === 0) {
      this.currentVisitId = null;
      if (await this.navigateToVisit(visitId)) {
        ({ observation } = await this.driver.perceiveAfterSettle(250));
      }
    }

    if (resolveFormOpenCandidates(observation, form.name, [visitName]).length === 0) {
      await this.createForm(form);
      ({ observation } = await this.driver.perceiveAfterSettle(250));
    }

    // Open it, then CONFIRM which form actually opened. Ranking only sets the
    // trial order; the read-back adjudicates.
    const candidates = resolveFormOpenCandidates(observation, form.name, [visitName]);
    let opened = false;
    for (const cand of candidates.slice(0, 3)) {
      await this.driver.click(cand.handle);
      await this.sleep(500);
      const { observation: after } = await this.driver.perceiveAfterSettle(250);
      // The visit name is page furniture here, not a form row: its breadcrumb
      // is on screen whichever surface this is.
      if (surfaceShowsForm(after, form.name, siblings, [visitName])) {
        opened = true;
        break;
      }
      // Wrong surface. Back out and try the next candidate rather than
      // building this form's fields into whatever is on screen.
      const back = rankCandidates(enumerateActions(after), { hint: 'discard' })[0]?.el;
      if (back) {
        await this.driver.click(back.handle);
        await this.sleep(400);
      }
    }

    if (!opened) {
      // Never claim a form is open when the read-back disagrees: that is the
      // failure that silently writes 195 fields into the wrong document.
      const decision = await this.escalateItem(`form-open:${formId}`, 'acting', {
        key: `form-open:${formId}`,
        fieldLabel: '(whole form)',
        canonicalType: 'text',
        formName: form.name,
        visitName: this.irVisitMap.get(visitId)?.name ?? visitId,
        suspectedTrap:
          'Every row in a document list tends to render an identically named ' +
          'open control; the form name lives beside it, not on it.',
        reason:
          `Could not confirm the designer for "${form.name}" opened. Tried ` +
          `${candidates.length} candidate control(s); the surface never showed ` +
          `this form. Its fields are NOT being built to avoid writing them into ` +
          `another document.`,
        evidence: candidates.slice(0, 3).map(
          (c) => `${c.role} "${c.name}" in group "${c.groupText ?? ''}"`,
        ),
        phase: 'acting',
      }, /* blocking */ true);

      let { observation: now } = await this.driver.perceive();
      if (surfaceShowsForm(now, form.name, siblings, [visitName])) {
        opened = true;
      } else if (decision && decision.action !== 'skip') {
        const retryCands = resolveFormOpenCandidates(now, form.name, [visitName]);
        for (const cand of retryCands.slice(0, 2)) {
          await this.driver.click(cand.handle);
          await this.sleep(500);
          ({ observation: now } = await this.driver.perceiveAfterSettle(250));
          if (surfaceShowsForm(now, form.name, siblings, [visitName])) {
            opened = true;
            break;
          }
        }
      }
      if (!opened) return false;
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
    return true;
  }

  private async discoverFormBuilder(): Promise<void> {
    const { observation } = await this.driver.perceive();

    // Adopt only what the BUILDER owns. Re-binding everything from this screen
    // rebinds controls that live elsewhere against whatever happens to look
    // similar here: "+ Page" (add a page to this form) satisfies the same
    // add-ish shape as "+ Add Visit", so visit.create silently became "+ Page"
    // the moment the first form was opened. Every later visit was then
    // "created" by adding a page to the open form and typing the visit name
    // into the palette's filter box -- and because atVisitList accepts the
    // create control as proof of arrival, the run believed it was standing on
    // the visit list while it was inside the designer. Three of four visits
    // were lost to this.
    //
    // Navigation, visit and document-lifecycle ops keep the bindings they got
    // on the surfaces where those controls actually live.
    const BUILDER_OWNED: readonly ContractOpId[] = [
      'field.add', 'field.set_label', 'field.set_required', 'field.set_range',
      'field.set_coded_values', 'field.set_skip_logic', 'field.set_formula',
      'ctx.commit', 'ctx.is_committed', 'ctx.discard',
      'form.list_fields', 'field_palette.open',
    ];
    const builderBindings = bindAllRung0(observation);
    for (const [op, binding] of Object.entries(builderBindings)) {
      if (binding && BUILDER_OWNED.includes(op as ContractOpId)) {
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
  /**
   * Close whatever a click opened, so the next action runs on the surface it
   * expects rather than through a dialog left standing.
   *
   * Only controls that ARRIVED with the overlay are considered, and only if
   * one of them reads as a dismissal -- so this cannot wander off clicking
   * page furniture when nothing actually opened. Verified by read-back: the
   * controls that appeared have to be gone again.
   */
  private async dismissOverlay(before: Observation, after: Observation): Promise<void> {
    const appeared = diffObservations(before, after).added;
    if (appeared.length === 0) return;

    const arrivals = enumerateActions(after).filter((e) => appeared.includes(e.handle));
    const dismiss = rankCandidates(arrivals, { hint: 'discard' })[0];
    if (!dismiss || !dismiss.signals.some((s) => s.name === 'lexical')) return;

    await this.driver.click(dismiss.el.handle);
    await this.sleep(300);
    const { observation: restored } = await this.driver.perceiveAfterSettle(200);
    const stillOpen = enumerateActions(restored).some((e) => appeared.includes(e.handle));
    this.journal.note(
      'ctx.commit',
      `a trial opened something; dismissed it with "${dismiss.el.name}" -- ` +
      `${stillOpen ? 'IT IS STILL OPEN' : 'surface restored'}`,
    );
  }

  /**
   * Re-check every field whose read-back did not pass during the build, now
   * that the form is committed and the surface reflects what was persisted.
   * One observation settles the whole form. Only what still disagrees is
   * reported, and it is reported once.
   */
  private async settlePendingVerification(): Promise<void> {
    if (this.pendingVerification.length === 0) return;
    const pending = this.pendingVerification;
    this.pendingVerification = [];

    const { observation } = await this.driver.perceiveAfterSettle(300);
    let recovered = 0;

    for (const { itemKey, item, field, intent } of pending) {
      const verdict = this.countUnobservable(compareIntent(observation, intent));

      if (verdict.verdict === 'VERIFIED') {
        await applyTransition(this.adapter, this.runState, itemKey, 'verify_verified');
        recovered += 1;
        continue;
      }

      await applyTransition(
        this.adapter, this.runState, itemKey,
        verdict.verdict === 'AMBIGUOUS' ? 'verify_ambiguous' : 'verify_failed',
      );
      await this.escalateItem(itemKey, 'verifying', {
        key: itemKey,
        fieldLabel: field.label,
        formName: this.irFormMap.get(item.form_id)?.name ?? item.form_id,
        visitName: this.irVisitMap.get(item.visit_id)?.name ?? item.visit_id,
        canonicalType: field.canonical_type,
        reason: verdict.reason,
        suspectedTrap: verdict.suspected_trap,
        evidence: [verdict.reason, 're-checked after the form was saved'],
        verdict,
        phase: 'verifying',
      }, /* blocking */ false);
    }

    if (recovered > 0) {
      this.journal.note(
        this.currentFormId
          ? `${this.irVisitMap.get(this.currentVisitId ?? '')?.name ?? ''} > ` +
            `${this.irFormMap.get(this.currentFormId)?.name ?? this.currentFormId}`
          : 'verify',
        `${recovered} of ${pending.length} field(s) read back correctly once the ` +
        `form was saved; the preview had not caught up while they were built.`,
      );
    }
  }

  private async commitCurrentForm(): Promise<void> {
    const { observation } = await this.driver.perceive();

    // Try ctx.commit binding if already resolved.
    //
    // Judged by the SAME structural test as the fallback below: did an
    // indicator the platform was showing disappear? The previous check asked
    // whether any status-ish word was still on screen, and the word list holds
    // both halves of the distinction ('saved' and 'unsaved', 'draft' and
    // 'committed'). A successful save therefore proved itself a failure -- the
    // platform's own "Saved." announcement matched, as did the lifecycle word
    // "Draft", which has nothing to do with whether the working copy is
    // pending. Live, this reported a correctly-saved form as uncommitted and
    // then probed four navigation tabs looking for a better one.
    const saveBinding = this.bindings['ctx.commit'];
    if (saveBinding && saveBinding.recipe.length > 0) {
      const before = await this.driver.perceive();
      const ok = await this.executeRecipe(saveBinding.recipe, null);
      if (ok) {
        await this.sleep(400);
        const post = await this.driver.perceiveAfterSettle(300);
        if (analyzeCommit(before.observation, post.observation).committed) return;
      }
    }

    // Fallback: actually work DOWN the ranked trial order, rather than trying
    // the top candidate once and giving up. Nothing is excluded by name --
    // decoys are demoted in the ranking and still probed -- and the decoy is
    // identified by analyzeCommit observing that the working copy did not
    // change, not by recognising its label.
    //
    // This loop is what the previous single-shot version was supposed to be.
    // On the supplied mock "Save As Template" and "Save" tie on the word
    // "save", DOM order put the decoy first, it was clicked once, correctly
    // reported as not-a-commit, and then the form was abandoned uncommitted
    // and its entire contents lost on the next navigation.
    const trials = rankCommitCandidates(observation)
      .map((r) => r.el)
      .filter((el) => !this.crossScreenChrome.has(normaliseLabel(el.name)));
    const MAX_COMMIT_TRIALS = 6;
    const attempted: string[] = [];

    for (const candidate of trials.slice(0, MAX_COMMIT_TRIALS)) {
      const before = await this.driver.perceive();
      const clicked = await this.driver.click(candidate.handle, false);
      if (!clicked.ok) continue;
      attempted.push(candidate.name);

      await this.sleep(400);
      const post = await this.driver.perceiveAfterSettle(300);
      const commitCheck = analyzeCommit(before.observation, post.observation);

      if (!commitCheck.committed) {
        // Did that click leave the surface entirely? Predicting it beforehand
        // does not work -- the ascend ranker misses a breadcrumb here and
        // flags "+ Page", which goes nowhere -- but noticing it afterwards is
        // exact. Whatever this control was, we are no longer on the form, so
        // every further trial would click a foreign screen. Stop.
        if (!sameSurface(before.observation, post.observation)) {
          this.journal.note(
            'ctx.commit',
            `"${candidate.name}" left the form surface rather than committing it; ` +
            `abandoning the search here instead of clicking on whatever it opened`,
          );
          break;
        }

        // Still here, but the click may have OPENED something -- a preview, a
        // dialog. Left standing it covers the surface for every later trial and
        // for whatever the run does next: live, an unclosed preview made the
        // following form's designer unreachable and its open-control search saw
        // zero candidates. Put the surface back.
        await this.dismissOverlay(before.observation, post.observation);
      }

      if (commitCheck.committed) {
        this.bindings['ctx.commit'] = {
          op: 'ctx.commit',
          version: 1,
          recipe: [{
            step: 'click',
            evidence_role: candidate.role,
            evidence_name: candidate.name,
            handle_kind: 'snapshot-id',
          }],
          post_condition: { description: 'committed' },
          evidence: [
            ...commitCheck.evidence,
            `confirmed after trying: ${attempted.join(' -> ')}`,
          ],
          rung: 1,
          status: 'bound',
          // Probe-confirmed: this control demonstrably persisted the work.
          confidence: 'structural',
        };
        return;
      }
    }

    // Nothing committed. This is the single most expensive silent failure in
    // the contract -- everything built in this form is about to be discarded
    // by the next navigation -- so it escalates rather than passing quietly.
    const formName = this.currentFormId
      ? this.irFormMap.get(this.currentFormId)?.name ?? this.currentFormId
      : 'the open form';
    this.journal.note(
      this.currentFormId ?? 'commit',
      `could not commit "${formName}": tried ${attempted.length} candidate(s) ` +
      `(${attempted.join(', ') || 'none clickable'}) and none cleared the ` +
      `working copy. Work in this form is unsaved.`,
    );
    this.callbacks.onEscalation({
      key: `commit:${this.currentFormId ?? 'unknown'}`,
      // How this platform persists a form is ONE decision, not one per form.
      // Ungrouped, this asked again for every one of the 28 appearances and
      // turned the build into an interrupt-driven review session.
      groupKey: 'commit:platform',
      fieldLabel: formName,
      formName,
      visitName: this.currentVisitId
        ? this.irVisitMap.get(this.currentVisitId)?.name ?? this.currentVisitId
        : '',
      canonicalType: 'text',
      reason:
        `Could not save "${formName}". Tried ${attempted.length} control(s) and ` +
        `none of them actually persisted the working copy.`,
      suspectedTrap:
        'a control that looks like save may only be filing the form away ' +
        'under a reusable name; everything built in this form is unsaved and ' +
        'will be lost on navigation',
      evidence: attempted.map((n) => `clicked "${n}" -- working copy unchanged`),
      phase: 'acting',
      // Stated here, not inferred from the wording downstream: this is the one
      // finding where work already done is lost if nobody acts.
      severity: 'data-loss',
      blocking: true,
    });
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

  /** Record what a read-back could not check, so the run can say it once. */
  private countUnobservable(verdict: VerdictResult): VerdictResult {
    for (const attr of verdict.unobservable ?? []) {
      this.unobservable.set(attr, (this.unobservable.get(attr) ?? 0) + 1);
    }
    return verdict;
  }

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

    // Verifying findings mean the field is already in the study. They are
    // never a reason to halt the schedule — live hostile v7 parked the whole
    // run on "Built — needs a look" for Sex at Birth after Demographics was
    // otherwise clean, and later visits never built (~75% of score).
    const effectiveBlocking = escalationIsBlocking(phase, blocking);
    const item: EscalationItem = {
      ...escalation,
      phase,
      blocking: effectiveBlocking,
    };

    const source = this.sourceOfKey(itemKey, escalation);

    if (!effectiveBlocking) {
      // Park silently. Do not broadcast a mid-run ESCALATION card: Approve/Skip
      // on a parked "Built — needs a look" looks like a gate and caused
      // computerUse (and humans) to stop while the orchestrator could continue.
      // The pile is delivered once via onParkedReview at the end of the run.
      this.parked.push(item);
      this.journal.escalated(source, escalation.reason, null);
      return null;
    }

    this.callbacks.onEscalation(item);

    // Blocking waits can sit for minutes with no tab traffic. MV3 will still
    // kill an "idle" worker even while this Promise is outstanding; touch
    // extension state on an interval so keep-alive stays honest for the whole
    // gate, not just while the sidepanel port happens to be connected.
    const decision = await new Promise<HumanDecision>((resolve) => {
      const pulse = setInterval(() => {
        try {
          void chrome.storage?.session?.set({ keepaliveTick: Date.now() });
        } catch {
          // chrome may be unavailable in unit tests
        }
      }, 20000);
      this.escalationQueue.set(itemKey, {
        item,
        resolve: (d: HumanDecision) => {
          clearInterval(pulse);
          resolve(d);
        },
      });
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
        const target = decision.overrideType;
        const { observation } = await this.driver.perceive();
        // Name synonyms miss hostile palette labels ("Dial Group", "Solar Mark");
        // fall back to place-and-inspect so Change-type still installs a binding.
        let newBinding = bindFieldAdd(observation, target);
        if (!newBinding) {
          const probed = await this.probeRunner.probePalette(observation);
          for (const [t, b] of Object.entries(probed.bindings)) {
            if (b) this.typeBindings[t as CanonicalType] = this.typeBindings[t as CanonicalType] ?? b;
          }
          newBinding = this.typeBindings[target] ?? probed.bindings[target] ?? null;
        }
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
      (i) => stepIdempotencyKey(i) === itemKey,
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
