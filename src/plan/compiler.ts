/**
 * Plan compiler (proposal-b section 5).
 *
 * The IR compiles, at load time, into a dependency DAG and then a linear PLAN.
 * Fully deterministic and LLM-free.
 *
 *   Nodes: every field-appearance in the input (195 fields across 28 form
 *          appearances, 17 distinct forms, 4 visits).
 *   Edges: skip-logic rule "field X shown when field Y <op> value" adds
 *          Y -> X (controlling field must exist first; criterion 7). Labels
 *          resolve to field ids at IR-compile time against the input file, so
 *          runtime never resolves names.
 *   Cycles: a cyclic skip-logic graph is an INPUT error; report and halt the
 *          affected form, escalate; do not guess.
 *   Linearize: topological sort with stable secondary ordering (input-file
 *          order within the same dependency level) so the plan is
 *          reproducible byte-for-byte and diffable.
 *   Micro-ordering: within a field, fixed by default (see microOrder below).
 *
 * Form-reuse policy (D5, revised 2026-09-02): PROBE-ONLY. The plan carries a
 * 'probe-first' flag; the reuse-vs-rebuild decision is made empirically at
 * binding time (form.exists across visits), never assumed here. The
 * brute-force-28 fallback from the original plan is REMOVED.
 */

import type {
  CanonicalType,
  ContractOpId,
  SkipRule,
} from '../shared/contract';
import type { Ir, IrField, IrForm, IrStudy, IrVisit } from './ir';

// ---------------------------------------------------------------------------
// Micro-ordering (proposal-b section 5.5).
// ---------------------------------------------------------------------------

export type MicroStepKind =
  | 'add'
  | 'set_label'
  | 'set_range'
  | 'type_refinement'
  | 'set_coded_values'
  | 'set_required'
  | 'set_skip_logic';

/** The contract op each micro-step kind maps to. */
export const MICRO_STEP_OP: Record<MicroStepKind, ContractOpId> = {
  add: 'field.add',
  set_label: 'field.set_label',
  set_range: 'field.set_range',
  type_refinement: 'field.add',
  set_coded_values: 'field.set_coded_values',
  set_required: 'field.set_required',
  set_skip_logic: 'field.set_skip_logic',
};

/**
 * Fixed micro-order for a single field: add control, then label, then
 * range/units, THEN set/confirm type refinements, then coded values, then
 * required flag. Skip logic is NOT part of the per-field order: it is applied
 * at form end (the controlling field must exist first).
 *
 * The range-before-type trap (criterion 9) is handled not by ordering luck but
 * by VERIFY: after type finalization, re-read range; missing range after type
 * set is AMBIGUOUS evidence of silent discard and escalates.
 */
export function microOrder(field: IrField): MicroStepKind[] {
  const steps: MicroStepKind[] = ['add', 'set_label'];
  if (field.range) steps.push('set_range');
  steps.push('type_refinement');
  if (field.options) steps.push('set_coded_values');
  steps.push('set_required');
  return steps;
}

// ---------------------------------------------------------------------------
// Plan shapes.
// ---------------------------------------------------------------------------

export interface FieldStep {
  kind: MicroStepKind;
  op: ContractOpId;
  /** Stable, human-readable description for the dry-run print. */
  description: string;
}

export interface SkipStep {
  /** The controlled field (the one that is shown/hidden). */
  field_id: string;
  /** The controlled field's label, for human-readable trace output. */
  field_label: string;
  /** The controlling field id, resolved at compile time. */
  controlling_field_id: string;
  /** The controlling field's label. */
  controlling_label: string;
  rule: SkipRule;
}

export interface FieldPlan {
  visit_id: string;
  form_id: string;
  field_id: string;
  label: string;
  canonical_type: CanonicalType;
  required: boolean;
  steps: FieldStep[];
  /** Skip logic is deferred to form end; this is the resolved rule (or
   *  undefined if the field has none). */
  skip_logic?: SkipRule;
}

export interface FormPlan {
  visit_id: string;
  form_id: string;
  name: string;
  repeating: boolean;
  /** Fields in topo order (controlling before controlled, input-file order
   *  as the stable tiebreak). */
  fields: FieldPlan[];
  /** Skip-logic steps, applied at form end. */
  skip_steps: SkipStep[];
  /** True when a cycle was detected: the form is halted and escalated. */
  halted: boolean;
  halt_reason?: string;
}

export interface VisitPlan {
  visit_id: string;
  name: string;
  forms: FormPlan[];
}

export type PlanErrorKind = 'cycle' | 'unknown_label';

export interface PlanError {
  kind: PlanErrorKind;
  visit_id: string;
  form_id: string;
  field_id?: string;
  message: string;
}

export interface Plan {
  study: IrStudy;
  form_reuse_policy: 'probe-first';
  visits: VisitPlan[];
  form_appearances: number;
  field_nodes: number;
  skip_edges: number;
  errors: PlanError[];
}

// ---------------------------------------------------------------------------
// Label -> id resolution (compile time, within a form).
// ---------------------------------------------------------------------------

function resolveControllingField(
  form: IrForm,
  when_field_label: string,
): IrField | undefined {
  return form.fields.find((f) => f.label === when_field_label);
}

// ---------------------------------------------------------------------------
// Topological sort with stable secondary ordering (input-file order).
// ---------------------------------------------------------------------------

/**
 * Kahn's algorithm with a stable tiebreak: at each step, pick the first
 * remaining field (in input-file order) whose in-degree is zero. Returns the
 * sorted field ids, or null if a cycle is present.
 */
function topoSortStable(fields: IrField[], edges: Map<string, string[]>): string[] | null {
  const indegree = new Map<string, number>();
  for (const f of fields) indegree.set(f.field_id, 0);
  for (const [, targets] of edges) {
    for (const t of targets) {
      indegree.set(t, (indegree.get(t) ?? 0) + 1);
    }
  }

  const result: string[] = [];
  const emitted = new Set<string>();
  const byId = new Map(fields.map((f) => [f.field_id, f]));

  while (result.length < fields.length) {
    // Find the first un-emitted field (input order) with in-degree zero.
    let next: IrField | undefined;
    for (const f of fields) {
      if (!emitted.has(f.field_id) && (indegree.get(f.field_id) ?? 0) === 0) {
        next = f;
        break;
      }
    }
    if (!next) {
      // No zero-in-degree field remains but fields are un-emitted: cycle.
      return null;
    }
    emitted.add(next.field_id);
    result.push(next.field_id);
    for (const t of edges.get(next.field_id) ?? []) {
      indegree.set(t, (indegree.get(t) ?? 0) - 1);
    }
  }

  // Sanity: every field emitted exactly once.
  if (result.length !== fields.length) return null;
  void byId;
  return result;
}

// ---------------------------------------------------------------------------
// Per-form compilation.
// ---------------------------------------------------------------------------

function compileForm(visit: IrVisit, form: IrForm, errors: PlanError[]): FormPlan {
  const visit_id = visit.visit_id;
  const form_id = form.form_id;

  // Resolve skip-logic edges at compile time.
  const edges = new Map<string, string[]>();
  const skipByField = new Map<string, SkipRule>();
  const skipSteps: SkipStep[] = [];

  for (const field of form.fields) {
    if (!field.skip_logic) continue;
    const controlling = resolveControllingField(form, field.skip_logic.when_field_label);
    if (!controlling) {
      // Dangling edge: the controlling field's label does not match any field
      // in this form. Escalate (E5); build the field without skip logic.
      errors.push({
        kind: 'unknown_label',
        visit_id,
        form_id,
        field_id: field.field_id,
        message:
          `skip logic on "${field.label}" references unknown controlling field ` +
          `"${field.skip_logic.when_field_label}" in form "${form.name}"`,
      });
      continue;
    }
    // Edge: controlling -> controlled.
    const targets = edges.get(controlling.field_id) ?? [];
    targets.push(field.field_id);
    edges.set(controlling.field_id, targets);
    skipByField.set(field.field_id, field.skip_logic);
    skipSteps.push({
      field_id: field.field_id,
      field_label: field.label,
      controlling_field_id: controlling.field_id,
      controlling_label: controlling.label,
      rule: field.skip_logic,
    });
  }

  // Topo sort. A cycle halts the form.
  const sorted = topoSortStable(form.fields, edges);
  if (sorted === null) {
    errors.push({
      kind: 'cycle',
      visit_id,
      form_id,
      message: `cyclic skip-logic graph in form "${form.name}" (visit "${visit.name}")`,
    });
    return {
      visit_id,
      form_id,
      name: form.name,
      repeating: form.repeating,
      fields: [],
      skip_steps: [],
      halted: true,
      halt_reason: 'cyclic skip-logic graph',
    };
  }

  const byId = new Map(form.fields.map((f) => [f.field_id, f]));
  const fields: FieldPlan[] = sorted.map((fid) => {
    const field = byId.get(fid)!;
    const steps: FieldStep[] = microOrder(field).map((kind) => ({
      kind,
      op: MICRO_STEP_OP[kind],
      description: describeStep(kind, field),
    }));
    return {
      visit_id,
      form_id,
      field_id: field.field_id,
      label: field.label,
      canonical_type: field.canonical_type,
      required: field.required,
      steps,
      skip_logic: skipByField.get(field.field_id),
    };
  });

  return {
    visit_id,
    form_id,
    name: form.name,
    repeating: form.repeating,
    fields,
    skip_steps: skipSteps,
    halted: false,
  };
}

function describeStep(kind: MicroStepKind, field: IrField): string {
  switch (kind) {
    case 'add':
      return `add control of canonical type "${field.canonical_type}"`;
    case 'set_label':
      return `set label "${field.label}"`;
    case 'set_range':
      return `set range ${field.range!.min}-${field.range!.max}${field.range!.units ? ' ' + field.range!.units : ''}`;
    case 'type_refinement':
      return `confirm type "${field.canonical_type}" (post-range)`;
    case 'set_coded_values':
      return `set ${field.options!.length} coded value pairs`;
    case 'set_required':
      return `set required=${field.required}`;
    case 'set_skip_logic':
      return 'set skip logic (form end)';
  }
}

// ---------------------------------------------------------------------------
// Whole-plan compilation.
// ---------------------------------------------------------------------------

export function compilePlan(ir: Ir): Plan {
  const errors: PlanError[] = [];
  const visits: VisitPlan[] = ir.visits.map((visit) => {
    const forms: FormPlan[] = visit.forms.map((form) => compileForm(visit, form, errors));
    return { visit_id: visit.visit_id, name: visit.name, forms };
  });

  let form_appearances = 0;
  let field_nodes = 0;
  let skip_edges = 0;
  for (const v of visits) {
    for (const f of v.forms) {
      form_appearances += 1;
      field_nodes += f.fields.length;
      skip_edges += f.skip_steps.length;
    }
  }

  return {
    study: ir.study,
    form_reuse_policy: 'probe-first',
    visits,
    form_appearances,
    field_nodes,
    skip_edges,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Linear plan (for the null-ACT dry run).
// ---------------------------------------------------------------------------

export interface LinearItem {
  visit_id: string;
  form_id: string;
  field_id: string;
  label: string;
  kind: MicroStepKind;
  op: ContractOpId;
  description: string;
  /** Canonical type of the field this step belongs to. Escalations group on
   *  it, so one type decision settles every field of that type — 13 decisions
   *  at worst rather than 195. */
  canonical_type: CanonicalType;
  /** Human-readable names, for escalation cards and journal provenance. */
  visit_name: string;
  form_name: string;
}

/**
 * Flatten the plan into a single linear sequence of steps, in build order:
 * visit -> form -> field (topo order) -> micro-step order, with skip-logic
 * steps appended at the end of each form. Deterministic and byte-identical
 * across runs.
 */
export function linearize(plan: Plan): LinearItem[] {
  const items: LinearItem[] = [];
  for (const visit of plan.visits) {
    for (const form of visit.forms) {
      if (form.halted) continue;
      for (const field of form.fields) {
        for (const step of field.steps) {
          items.push({
            visit_id: field.visit_id,
            form_id: field.form_id,
            field_id: field.field_id,
            label: field.label,
            kind: step.kind,
            op: step.op,
            description: step.description,
            canonical_type: field.canonical_type,
            visit_name: visit.name,
            form_name: form.name,
          });
        }
      }
      for (const skip of form.skip_steps) {
        items.push({
          visit_id: form.visit_id,
          form_id: form.form_id,
          field_id: skip.field_id,
          label: skip.field_label,
          kind: 'set_skip_logic',
          op: 'field.set_skip_logic',
          description:
            `skip logic: show "${skip.field_label}" when "${skip.controlling_label}" ` +
            `= "${skip.rule.equals_value}"`,
          canonical_type:
            form.fields.find((f) => f.field_id === skip.field_id)?.canonical_type ?? 'text',
          visit_name: visit.name,
          form_name: form.name,
        });
      }
    }
  }
  return items;
}
