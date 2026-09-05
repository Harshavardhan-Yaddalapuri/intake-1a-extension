/**
 * Reconciliation: derive the work list from the difference between what the
 * input file wants and what the platform actually has.
 *
 * This is the mechanism behind three requirements at once:
 *   - Idempotency. A second run finds everything present and builds nothing.
 *   - Form reuse. A form that arrives already populated indicates the platform
 *     shares definitions across visits; an empty one indicates it does not.
 *     Discovered by looking, never assumed in either direction.
 *   - Recall. Anything the input file wants and the platform lacks is BUILD,
 *     and a missing field is the most heavily penalised failure there is.
 *
 * HARD WALL: reconcile decides, it does not act, and it never decides to
 * delete. A control the platform has that the input file does not mention is
 * reported as unexpected and left alone -- it may be deliberate work by a
 * study builder, and this agent does not know otherwise.
 */

import type { CanonicalType, CodedPair, ObservedField, RangeSpec } from '../shared/contract';

/** The subset of an IR field reconcile needs. Structurally compatible with
 *  verify.ts IntentRecord so callers can pass the same object. */
export interface FieldIntent {
  visit_id: string;
  form_id: string;
  field_id: string;
  label: string;
  canonical_type: CanonicalType;
  required: boolean;
  coded_pairs?: CodedPair[];
  range_units?: RangeSpec;
}

export type ReconcileAction = 'build' | 'adopt' | 'escalate';

export interface FieldDecision {
  field_id: string;
  label: string;
  action: ReconcileAction;
  reason: string;
  /** The matched control, when one was found. */
  observed?: ObservedField;
  /** Populated for escalate: what specifically disagreed. */
  mismatch?: 'role' | 'required' | 'range' | 'units' | 'coded_values' | 'duplicate';
}

/** Same normalisation VERIFY uses. Duplicated deliberately so reconcile does
 *  not depend on the verify module; a test asserts the two stay identical,
 *  because if they drift the agent would disagree with itself about whether a
 *  field already exists. */
export function normaliseLabel(name: string): string {
  return name
    .replace(/\s*\((?:required|mandatory)\)\s*$/i, '')
    .replace(/\s*[*†‡]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Roles that can realise each canonical type. Mirrors verify.ts expectedRoles. */
function expectedRoles(canonical: CanonicalType): string[] {
  switch (canonical) {
    case 'text':
    case 'textarea':
    case 'calculated':
      return ['textbox', 'searchbox'];
    case 'integer':
    case 'decimal':
      return ['spinbutton', 'textbox'];
    case 'date':
    case 'time':
    case 'datetime':
      return ['textbox', 'spinbutton', 'combobox'];
    case 'boolean':
      return ['checkbox', 'switch', 'radiogroup'];
    case 'single_select':
      return ['combobox', 'listbox'];
    case 'multi_select':
      return ['listbox', 'combobox'];
    case 'radio':
      return ['radiogroup'];
    case 'checkbox':
      return ['checkbox'];
  }
}

/**
 * Decide what to do about one field.
 *
 * Missing -> build. Present and matching -> adopt. Present and differing ->
 * escalate, never mutate: the agent cannot distinguish its own earlier error
 * from a deliberate human edit made after a previous run.
 */
export function reconcileField(
  intent: FieldIntent,
  present: readonly ObservedField[],
): FieldDecision {
  const target = normaliseLabel(intent.label);
  const unit = intent.range_units?.units?.toLowerCase();
  const accepted = new Set([target]);
  if (unit) {
    accepted.add(`${target} ${unit}`);
    accepted.add(`${target} (${unit})`);
  }

  const matches = present.filter(
    (f) => f.label.length > 0 && accepted.has(normaliseLabel(f.label)),
  );

  if (matches.length === 0) {
    return {
      field_id: intent.field_id,
      label: intent.label,
      action: 'build',
      reason: `no control named "${intent.label}" in this form`,
    };
  }

  if (matches.length > 1) {
    return {
      field_id: intent.field_id,
      label: intent.label,
      action: 'escalate',
      mismatch: 'duplicate',
      reason:
        `more than one control resolves to "${intent.label}" in this form; ` +
        `a previous run may have built it twice`,
    };
  }

  const observed = matches[0];
  const roles = expectedRoles(intent.canonical_type);

  if (!roles.includes(observed.role)) {
    return {
      field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
      mismatch: 'role',
      reason:
        `"${intent.label}" exists with role "${observed.role}" but type ` +
        `"${intent.canonical_type}" expects one of [${roles.join(', ')}]`,
    };
  }

  if (observed.required !== undefined && observed.required !== intent.required) {
    return {
      field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
      mismatch: 'required',
      reason:
        `"${intent.label}" exists with required=${observed.required} but the ` +
        `input file declares required=${intent.required}`,
    };
  }

  if (intent.range_units) {
    const want = intent.range_units;
    const got = observed.range;
    if (!got || got.min !== want.min || got.max !== want.max) {
      return {
        field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
        mismatch: 'range',
        reason:
          `"${intent.label}" exists with range ` +
          `${got ? `${got.min}-${got.max}` : 'none'} but the input file declares ` +
          `${want.min}-${want.max}`,
      };
    }
  }

  if (intent.coded_pairs && intent.coded_pairs.length > 0) {
    const want = intent.coded_pairs.map((c) => c.label);
    const got = observed.options;
    const same = got.length === want.length && want.every((label, i) => got[i] === label);
    if (!same) {
      return {
        field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
        mismatch: 'coded_values',
        reason:
          `"${intent.label}" has options [${got.join(', ')}] but the input file ` +
          `declares [${want.join(', ')}]`,
      };
    }
  }

  return {
    field_id: intent.field_id,
    label: intent.label,
    action: 'adopt',
    observed,
    reason: `"${intent.label}" already present as ${observed.role} and matches the input file`,
  };
}

export interface FormIntent {
  form_id: string;
  name: string;
  fields: FieldIntent[];
}

export interface FormReconcileResult {
  form_id: string;
  decisions: FieldDecision[];
  /** Controls present that the input file does not mention. Reported, never
   *  deleted. */
  unexpected: ObservedField[];
  /** True when every wanted field was already present on arrival -- the
   *  observable signature of a platform that shares form definitions across
   *  visits. */
  sharedDefinition: boolean;
}

export function reconcileForm(
  form: FormIntent,
  present: readonly ObservedField[],
): FormReconcileResult {
  const decisions = form.fields.map((f) => reconcileField(f, present));

  const claimed = new Set(
    decisions.map((d) => d.observed?.handle).filter((h): h is string => h !== undefined),
  );
  const unexpected = present.filter((f) => f.label.length > 0 && !claimed.has(f.handle));

  return {
    form_id: form.form_id,
    decisions,
    unexpected,
    sharedDefinition: form.fields.length > 0 && decisions.every((d) => d.action === 'adopt'),
  };
}

// ---------------------------------------------------------------------------
// Shallow tree survey.
// ---------------------------------------------------------------------------

export interface TreeVisit {
  visit_id: string;
  name: string;
  forms: { form_id: string; name: string }[];
}

export interface TreeSummary {
  visitsWanted: number;
  visitsPresent: number;
  visitsToCreate: string[];
  formAppearancesWanted: number;
  formAppearancesPresent: number;
  formAppearancesToCreate: { visit: string; form: string }[];
}

/**
 * Compare the wanted visit/form tree against what the platform shows.
 *
 * Bounded by visit and form-appearance count, not field count, so the
 * pre-flight screen gets a concrete work statement without paying to enumerate
 * every field before anything happens.
 */
export function summariseTree(
  wanted: readonly TreeVisit[],
  presentByVisit: Record<string, readonly string[]>,
): TreeSummary {
  const presentIndex = new Map<string, Set<string>>();
  for (const [visitName, formNames] of Object.entries(presentByVisit)) {
    presentIndex.set(normaliseLabel(visitName), new Set(formNames.map(normaliseLabel)));
  }

  const visitsToCreate: string[] = [];
  const formAppearancesToCreate: { visit: string; form: string }[] = [];
  let visitsPresent = 0;
  let formAppearancesWanted = 0;
  let formAppearancesPresent = 0;

  for (const visit of wanted) {
    const forms = presentIndex.get(normaliseLabel(visit.name));
    if (forms === undefined) visitsToCreate.push(visit.name);
    else visitsPresent += 1;

    for (const form of visit.forms) {
      formAppearancesWanted += 1;
      if (forms?.has(normaliseLabel(form.name))) formAppearancesPresent += 1;
      else formAppearancesToCreate.push({ visit: visit.name, form: form.name });
    }
  }

  return {
    visitsWanted: wanted.length,
    visitsPresent,
    visitsToCreate,
    formAppearancesWanted,
    formAppearancesPresent,
    formAppearancesToCreate,
  };
}
