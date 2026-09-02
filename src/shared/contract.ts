/**
 * The Platform Contract (proposal-b section 3).
 *
 * The whole assignment reduces to one question: can the platform bind these
 * operations? The contract is derived from the INPUT IR's requirements, not
 * from any given mock's UI. If a platform cannot bind an operation, that is a
 * finding about the platform (and an automatic human-gate item), never a
 * silent workaround.
 *
 * Each operation is an INTERFACE, not an implementation. Nothing here
 * references screens, their order, English widget names, CSS, XPath, or
 * positions. The same schema works whether the unseen platform is
 * wizard-style, palette-style, or table-style.
 *
 * NOTE ON COUNT: the build plan calls this the "15-op" contract, but
 * proposal-b section 3 enumerates seventeen operations. This file implements
 * the seventeen enumerated in the spec (the authoritative list), which is
 * what the S2 card's deliverable list also spells out.
 */

// ---------------------------------------------------------------------------
// Canonical field types (the input IR's semantic vocabulary).
// ---------------------------------------------------------------------------

export type CanonicalType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'time'
  | 'datetime'
  | 'boolean'
  | 'single_select'
  | 'multi_select'
  | 'radio'
  | 'checkbox'
  | 'calculated';

export const CANONICAL_TYPES: readonly CanonicalType[] = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'date',
  'time',
  'datetime',
  'boolean',
  'single_select',
  'multi_select',
  'radio',
  'checkbox',
  'calculated',
];

/** A coded value is a pair: code (what the system stores) + label (what a
 *  human reads). Both matter; entering only labels stores the wrong thing. */
export interface CodedPair {
  code: string;
  label: string;
}

/** A range check for numeric types. min and max are required; units is
 *  optional (some numeric fields in the IR carry a range with no unit). */
export interface RangeSpec {
  min: number;
  max: number;
  units?: string;
}

/** Skip logic: this field is shown only when the named field in the SAME form
 *  holds the given value. For coded fields the value is the code; for boolean
 *  fields it is "Yes" or "No". */
export interface SkipRule {
  when_field_label: string;
  equals_value: string;
}

// ---------------------------------------------------------------------------
// Contract operation identifiers.
// ---------------------------------------------------------------------------

export type ContractOpId =
  | 'nav.to_study_root'
  | 'nav.to_visit_list'
  | 'visit.create'
  | 'visit.open'
  | 'form.create'
  | 'form.open'
  | 'form.exists'
  | 'field_palette.open'
  | 'field.add'
  | 'field.set_label'
  | 'field.set_required'
  | 'field.set_coded_values'
  | 'field.set_range'
  | 'field.set_skip_logic'
  | 'ctx.commit'
  | 'ctx.is_committed'
  | 'ctx.discard';

export const CONTRACT_OPS: readonly ContractOpId[] = [
  'nav.to_study_root',
  'nav.to_visit_list',
  'visit.create',
  'visit.open',
  'form.create',
  'form.open',
  'form.exists',
  'field_palette.open',
  'field.add',
  'field.set_label',
  'field.set_required',
  'field.set_coded_values',
  'field.set_range',
  'field.set_skip_logic',
  'ctx.commit',
  'ctx.is_committed',
  'ctx.discard',
];

// ---------------------------------------------------------------------------
// Operation argument shapes (each op is an interface, not an implementation).
// ---------------------------------------------------------------------------

export interface NavToStudyRootArgs {
  op: 'nav.to_study_root';
}

export interface NavToVisitListArgs {
  op: 'nav.to_visit_list';
}

export interface VisitCreateArgs {
  op: 'visit.create';
  visit_label: string;
}

export interface VisitOpenArgs {
  op: 'visit.open';
  visit_label: string;
}

export interface FormCreateArgs {
  op: 'form.create';
  visit_ctx: string;
  form_label: string;
}

export interface FormOpenArgs {
  op: 'form.open';
  form_label: string;
}

export interface FormExistsArgs {
  op: 'form.exists';
  form_label: string;
}

export interface FieldPaletteOpenArgs {
  op: 'field_palette.open';
}

export interface FieldAddArgs {
  op: 'field.add';
  /** The SEMANTIC type, not a library entry name. The mapping
   *  canonical-type -> concrete-control is itself a Binding. */
  canonical_type: CanonicalType;
}

export interface FieldSetLabelArgs {
  op: 'field.set_label';
  text: string;
}

export interface FieldSetRequiredArgs {
  op: 'field.set_required';
  required: boolean;
}

export interface FieldSetCodedValuesArgs {
  op: 'field.set_coded_values';
  pairs: CodedPair[];
  /** append | replace-probe: the binding carries an empirical check before
   *  bulk entry is trusted (criterion 6). */
  mode: 'append' | 'replace-probe';
}

export interface FieldSetRangeArgs {
  op: 'field.set_range';
  range: RangeSpec;
}

export interface FieldSetSkipLogicArgs {
  op: 'field.set_skip_logic';
  trigger_label: string;
  operator: string;
  value: string;
  action: string;
}

export interface CtxCommitArgs {
  op: 'ctx.commit';
}

export interface CtxIsCommittedArgs {
  op: 'ctx.is_committed';
}

export interface CtxDiscardArgs {
  op: 'ctx.discard';
}

export type ContractOpArgs =
  | NavToStudyRootArgs
  | NavToVisitListArgs
  | VisitCreateArgs
  | VisitOpenArgs
  | FormCreateArgs
  | FormOpenArgs
  | FormExistsArgs
  | FieldPaletteOpenArgs
  | FieldAddArgs
  | FieldSetLabelArgs
  | FieldSetRequiredArgs
  | FieldSetCodedValuesArgs
  | FieldSetRangeArgs
  | FieldSetSkipLogicArgs
  | CtxCommitArgs
  | CtxIsCommittedArgs
  | CtxDiscardArgs;

// ---------------------------------------------------------------------------
// Binding record shape (what BIND emits per operation; JSON, versioned,
// cached per platform-origin in chrome.storage).
// ---------------------------------------------------------------------------

/** A single interaction step inside a binding recipe. */
export interface RecipeStep {
  step: 'click' | 'choose_option' | 'set_value' | 'check' | 'select_option' | 'wait';
  /** The evidence that grounds this step's target. */
  evidence_role?: string;
  evidence_name?: string;
  /** How the target is located at act time. */
  handle_kind: 'snapshot-id' | 'role-name' | 'role-only';
  /** For choose_option: whether the option list is exposed in the AX tree. */
  from_list_exposed?: boolean;
  /** For set_value: the value is substituted from the IR at act time, never
   *  baked into the binding. */
  value_from?: 'ir' | 'literal';
  literal?: string;
}

/** The post-condition VERIFY checks after the recipe runs. */
export interface PostCondition {
  /** Human-readable statement of what must be true after the op. */
  description: string;
  /** The semantic evidence VERIFY reads back to confirm it. */
  expect_role?: string;
  expect_name?: string;
  expect_state?: Record<string, unknown>;
  expect_options_count?: number;
}

/** The graded binding ladder rung this binding resolved at. */
export type BindingRung = 0 | 1 | 2 | 3;

export type BindingStatus = 'bound' | 'needs-human' | 'unbindable';

/** The platform model is the set of Binding records + a capability report.
 *  Thin, inspectable, diffable. No free-form prose, no A-schema fields. */
export interface BindingRecord {
  op: ContractOpId;
  version: number;
  recipe: RecipeStep[];
  post_condition: PostCondition;
  /** Evidence that grounded this binding: ax_role, accname, probe_diff,
   *  llm_choice:N/M, etc. */
  evidence: string[];
  rung: BindingRung;
  status: BindingStatus;
}

/** A capability report: which ops bound, at which rung, which escalated. */
export interface CapabilityReport {
  platform_origin: string;
  generated_at: number;
  bindings: Record<ContractOpId, BindingRecord | null>;
  /** Ops that could not bind and need a human. */
  needs_human: ContractOpId[];
  /** Ops that are structurally unbindable on this platform. */
  unbindable: ContractOpId[];
}

// ---------------------------------------------------------------------------
// Idempotency key (M5): structural, from IR ids, never labels, never LLM
// output.
// ---------------------------------------------------------------------------

export interface IdempotencyKey {
  visit_id: string;
  form_id: string;
  field_id: string;
}

export function idempotencyKey(visit_id: string, form_id: string, field_id: string): string {
  return `${visit_id}\u0000${form_id}\u0000${field_id}`;
}
