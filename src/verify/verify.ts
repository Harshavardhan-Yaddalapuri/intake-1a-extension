/**
 * VERIFY (proposal-b section 2, 6).
 *
 * After every mutating step, VERIFY takes a FRESH Observation and compares
 * deterministic read-back evidence against the INTENT RECORD declared before
 * the step. Emits exactly one of three verdicts: VERIFIED, FAILED, AMBIGUOUS.
 *
 * Read-back compares SEMANTIC state (a field exists, with this accessible
 * name, this control role, this option list) against the intent, never a DOM
 * snapshot. AMBIGUOUS is a first-class verdict, not a retry trigger: it covers
 * the brief's silent-discard traps (type-set wipes range; save-looking button
 * did not save). Ambiguous items reconcile before any further mutation of the
 * same object.
 *
 * HARD WALL: VERIFY cannot fix. It only compares and reports.
 */

import type {
  CanonicalType,
  CodedPair,
  RangeSpec,
  SkipRule,
} from '../shared/contract';
import type { Observation, ObservationElement } from '../perceive/core';

// ---------------------------------------------------------------------------
// Intent records (proposal-b section 6).
// ---------------------------------------------------------------------------

export interface IntentRecord {
  visit_id: string;
  form_id: string;
  field_id: string;
  canonical_type: CanonicalType;
  label: string;
  required: boolean;
  coded_pairs?: CodedPair[];
  range_units?: RangeSpec;
  skip_rules?: SkipRule[];
}

// ---------------------------------------------------------------------------
// Verdicts.
// ---------------------------------------------------------------------------

export type Verdict = 'VERIFIED' | 'FAILED' | 'AMBIGUOUS';

export interface VerdictResult {
  verdict: Verdict;
  /** Human-readable explanation of what was compared and what matched. */
  reason: string;
  /** The specific trap suspected, if AMBIGUOUS (e.g. "range read after type
   *  set: absent; platform may silently discard range on type change"). */
  suspected_trap?: string;
}

// ---------------------------------------------------------------------------
// Semantic read-back helpers.
// ---------------------------------------------------------------------------

/** Normalise an accessible name for comparison: strip a trailing required
 *  marker, collapse whitespace, case-fold. Applied to both sides. */
export function normaliseLabel(name: string): string {
  return name
    .replace(/\s*\((?:required|mandatory)\)\s*$/i, '')
    .replace(/\s*[*†‡]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface NameMatch {
  el: ObservationElement;
  /** True when the accessible name matched byte-for-byte. */
  exact: boolean;
  /** True when the field was found as a GROUP OF OPTIONS ("Race: Asian",
   *  "Race: White", ...) rather than as one control bearing its own name.
   *  `el` is then one member of that group, so its role is the option's role
   *  and not the field's. Only a choice type may be realised this way. */
  viaOptionGroup?: boolean;
}

/** Resolve an intent label to at most one element.
 *
 *  Exact matches win outright. Failing that, normalised matches are used, but
 *  only when exactly one candidate normalises to the target — two candidates
 *  that both normalise to the same label is a genuine ambiguity and is
 *  reported rather than resolved by picking the first. */
export function resolveByName(
  obs: Observation,
  label: string,
  unit?: string,
): NameMatch | 'ambiguous' | null {
  const exact = obs.elements.filter((e) => e.name === label);
  if (exact.length === 1) return { el: exact[0], exact: true };
  if (exact.length > 1) return 'ambiguous';

  const target = normaliseLabel(label);

  // Units are not an ARIA concept, so a platform that applies a unit usually
  // renders it into the label: "Heart Rate (bpm)" or "Heart Rate bpm". Accept
  // the label carrying EXACTLY the unit the input file declared, in either
  // form, and nothing else. A generic "starts with the label" rule would let
  // "Heart Rate" resolve against "Heart Rate Variability" — two fields that
  // really do coexist in studies — and a field that resolves to its neighbour
  // never gets built.
  const accepted = new Set([target]);
  if (unit) {
    const u = unit.toLowerCase();
    accepted.add(`${target} ${u}`);
    accepted.add(`${target} (${u})`);
  }

  const loose = obs.elements.filter((e) => accepted.has(normaliseLabel(e.name)));
  if (loose.length === 1) return { el: loose[0], exact: false };
  if (loose.length > 1) return 'ambiguous';

  // A choice field is often not ONE control. Platforms realise "Sex at Birth"
  // with three inputs named "Sex at Birth: Female", "Sex at Birth: Male",
  // "Sex at Birth: Undisclosed" -- one per option, with no wrapper carrying the
  // field's own name. Nothing is then named "Sex at Birth" and the field reads
  // as missing, though it is built and correct. Live, that was every radio and
  // every multi-select in the study.
  //
  // The shape is recognised structurally: several controls of the SAME role
  // whose names all begin with the field's label and then diverge. Any single
  // one of them stands for the field, since they share its role and answer for
  // its value.
  const optionsOf = optionGroup(obs, target);
  if (optionsOf) return { el: optionsOf, exact: false, viaOptionGroup: true };

  return null;
}

/**
 * The member of a same-role option group whose names all extend `target`, or
 * undefined when the observation holds no such group. Returned rather than a
 * synthetic element so callers still get a real handle to read state from.
 */
function optionGroup(obs: Observation, target: string): ObservationElement | undefined {
  const members = obs.elements.filter((e) => {
    const n = normaliseLabel(e.name);
    if (n === target || !n.startsWith(target)) return false;
    // A separator must follow the label, or "Height" would swallow
    // "Height Velocity" -- two fields that really do coexist in studies.
    return /^[\s:\-–—.,/|]/.test(n.slice(target.length));
  });
  if (members.length < 2) return undefined;

  const roles = new Set(members.map((m) => m.role));
  return roles.size === 1 ? members[0] : undefined;
}

/** Map a canonical type to the ARIA role(s) that realize it. This is the
 *  semantic layer: roles distinguish controls even when names are nearly
 *  identical (single_select vs radio, checkbox vs multi_select). */
function expectedRoles(canonical: CanonicalType): string[] {
  switch (canonical) {
    case 'text':
    case 'textarea':
      return ['textbox'];
    case 'integer':
    case 'decimal':
      return ['spinbutton', 'textbox'];
    case 'date':
    case 'time':
    case 'datetime':
      return ['textbox', 'combobox', 'spinbutton'];
    case 'boolean':
      return ['checkbox', 'switch', 'button', 'combobox', 'listbox'];
    case 'single_select':
      return ['combobox', 'listbox', 'radiogroup'];
    case 'multi_select':
      return ['listbox', 'combobox'];
    case 'radio':
      return ['radiogroup'];
    case 'checkbox':
      return ['checkbox'];
    case 'calculated':
      return ['textbox', 'spinbutton'];
  }
}

// ---------------------------------------------------------------------------
// Comparator.
// ---------------------------------------------------------------------------

/**
 * Compare a fresh Observation against an intent record. Returns a verdict.
 *
 * The comparator is deliberately conservative: any mismatch that could be a
 * silent-discard trap yields AMBIGUOUS (escalate), not FAILED (blind retry).
 * FAILED is reserved for a clear, unambiguous absence (the field is simply
 * not there). AMBIGUOUS means "something is present but it does not match what
 * we meant, and we cannot tell whether the platform silently changed it."
 */
export function compareIntent(obs: Observation, intent: IntentRecord): VerdictResult {
  const match = resolveByName(obs, intent.label, intent.range_units?.units);

  if (match === 'ambiguous') {
    return {
      verdict: 'AMBIGUOUS',
      reason:
        `more than one element resolves to the label "${intent.label}" in the ` +
        `fresh observation; refusing to guess which one was meant`,
      suspected_trap:
        'duplicate or near-duplicate labels: a previous run may have built ' +
        'this field twice, or the platform renders a shadow copy',
    };
  }

  if (match === null) {
    return {
      verdict: 'FAILED',
      reason: `no element with accessible name "${intent.label}" found in the fresh observation`,
    };
  }

  const el = match.el;

  // Role check: does the control realize the intended semantic type?
  const roles = expectedRoles(intent.canonical_type);
  // A group of options realises a choice field even though each member reports
  // the OPTION's role rather than the field's. Accepted only for a choice type
  // and only when the group shape was actually observed: a single tick box
  // named "Race" stays a boolean, which is the near-miss the brief warns sits
  // one row away from a list-of-choices control.
  const CHOICE_TYPES: CanonicalType[] = ['single_select', 'multi_select', 'radio'];
  const roleOk = roles.includes(el.role)
    || (match.viaOptionGroup === true && CHOICE_TYPES.includes(intent.canonical_type));
  if (!roleOk) {
    return {
      verdict: 'AMBIGUOUS',
      reason:
        `element "${intent.label}" has role "${el.role}" but intent ` +
        `"${intent.canonical_type}" expects one of [${roles.join(', ')}]`,
      suspected_trap:
        'role mismatch: the control may have been added with the wrong type, ' +
        'or the platform renamed a near-identical neighbor',
    };
  }

  // Coded values: count and content must match (criterion 6: pairs, not
  // labels-only; append-vs-replace traps).
  if (intent.coded_pairs && intent.coded_pairs.length > 0) {
    const expectedLabels = intent.coded_pairs.map((p) => p.label);
    const actual = el.options ?? [];
    if (actual.length === 0) {
      return {
        verdict: 'AMBIGUOUS',
        reason: `element "${intent.label}" exposes no option vocabulary but intent has ${expectedLabels.length} coded values`,
        suspected_trap:
          'coded values may have been silently discarded, or the option list ' +
          'is not exposed in the accessibility tree',
      };
    }
    if (actual.length !== expectedLabels.length) {
      return {
        verdict: 'AMBIGUOUS',
        reason:
          `element "${intent.label}" has ${actual.length} options but intent has ` +
          `${expectedLabels.length}`,
        suspected_trap:
          'coded-value count mismatch: bulk entry may have replaced instead of ' +
          'appended, or a pair was dropped',
      };
    }
    for (let i = 0; i < expectedLabels.length; i += 1) {
      if (actual[i] !== expectedLabels[i]) {
        return {
          verdict: 'AMBIGUOUS',
          reason:
            `element "${intent.label}" option ${i} is "${actual[i]}" but intent ` +
            `has "${expectedLabels[i]}"`,
          suspected_trap: 'coded-value label mismatch (order or content)',
        };
      }
    }
  }

  // Range (criterion 9). The observed range now comes from PERCEIVE's
  // ElementState. A numeric control carrying NO range when the intent
  // declares one is the silent-discard trap, not a pass.
  if (intent.range_units) {
    const observed = el.state.range;
    const wanted = intent.range_units;

    if (!observed || (observed.min === undefined && observed.max === undefined)) {
      return {
        verdict: 'AMBIGUOUS',
        reason:
          `element "${intent.label}" declares no range bounds, but intent ` +
          `specifies ${wanted.min}-${wanted.max}`,
        suspected_trap:
          'range absent after type set: the platform may have silently ' +
          'discarded the range when the control type changed, or it does not ' +
          'expose bounds in the accessibility tree',
      };
    }

    if (observed.min !== wanted.min || observed.max !== wanted.max) {
      return {
        verdict: 'AMBIGUOUS',
        reason:
          `element "${intent.label}" has range ${observed.min}-${observed.max} ` +
          `but intent specifies ${wanted.min}-${wanted.max}`,
        suspected_trap:
          'range mismatch: the platform may have clamped, rounded, or ' +
          'partially applied the bounds',
      };
    }

    // Units are not an ARIA concept. Look for the unit string in the
    // accessible name. Absence is AMBIGUOUS, never FAILED — units are often
    // rendered presentationally and may be genuinely present but unobservable.
    if (wanted.units) {
      const haystack = normaliseLabel(el.name);
      if (!haystack.includes(wanted.units.toLowerCase())) {
        return {
          verdict: 'AMBIGUOUS',
          reason:
            `element "${intent.label}" does not expose the unit "${wanted.units}" ` +
            `in its accessible name`,
          suspected_trap:
            'units may be rendered presentationally and not exposed to the ' +
            'accessibility tree, or they were not applied',
        };
      }
    }
  }

  // Required flag (criterion 7). Now observable via ElementState. An absent
  // observation is not a contradiction: some platforms express requiredness
  // only visually. A PRESENT observation that disagrees is a real mismatch.
  if (el.state.required !== undefined && el.state.required !== intent.required) {
    return {
      verdict: 'AMBIGUOUS',
      reason:
        `element "${intent.label}" reports required=${el.state.required} but ` +
        `intent declares required=${intent.required}`,
      suspected_trap:
        'required flag not applied, or silently reset when the control type ' +
        'was changed',
    };
  }

  return {
    verdict: 'VERIFIED',
    reason:
      `element "${intent.label}" present with role "${el.role}" matching ` +
      `"${intent.canonical_type}"` +
      (intent.coded_pairs ? ` and ${intent.coded_pairs.length} coded values` : ''),
  };
}

// ---------------------------------------------------------------------------
// Check-first (idempotency, proposal-b section 6).
// ---------------------------------------------------------------------------

/**
 * Before building any item, VERIFY performs check-first: does the target form
 * already contain a control whose accessible name and role match this intent?
 * Verified-exists means SKIP. This is what makes a re-run a no-op by
 * construction.
 */
export function checkFirst(obs: Observation, intent: IntentRecord): VerdictResult {
  const match = resolveByName(obs, intent.label, intent.range_units?.units);

  if (match === 'ambiguous') {
    return {
      verdict: 'AMBIGUOUS',
      reason: `more than one existing element resolves to "${intent.label}"`,
      suspected_trap: 'a previous run may have built this field more than once',
    };
  }

  if (match === null) {
    return {
      verdict: 'FAILED',
      reason: `no existing element named "${intent.label}" (build it)`,
    };
  }

  const roles = expectedRoles(intent.canonical_type);
  if (roles.includes(match.el.role)) {
    return {
      verdict: 'VERIFIED',
      reason:
        `element "${intent.label}" already exists with role "${match.el.role}" (skip)` +
        (match.exact ? '' : ' [matched after label normalisation]'),
    };
  }

  return {
    verdict: 'AMBIGUOUS',
    reason:
      `element "${intent.label}" exists but with role "${match.el.role}", not ` +
      `[${roles.join(', ')}]`,
    suspected_trap: 'a same-named element exists with the wrong type',
  };
}
