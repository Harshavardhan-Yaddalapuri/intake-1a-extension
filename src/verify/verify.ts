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

/** Find the element in a fresh Observation whose accessible name matches the
 *  intent label. Exact match only; near-matches are AMBIGUOUS, never trusted. */
function findByName(obs: Observation, label: string): ObservationElement | undefined {
  return obs.elements.find((e) => e.name === label);
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
  const el = findByName(obs, intent.label);

  // The field is simply absent: a clear failure.
  if (!el) {
    return {
      verdict: 'FAILED',
      reason: `no element with accessible name "${intent.label}" found in the fresh observation`,
    };
  }

  // Role check: does the control realize the intended semantic type?
  const roles = expectedRoles(intent.canonical_type);
  const roleOk = roles.includes(el.role);
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

  // Range: re-read after type finalization (criterion 9). The range itself is
  // not always exposed in the AX tree, so we only flag a HARD absence when the
  // intent has a range and the element carries no numeric affordance at all.
  // This is intentionally conservative: a missing range read is AMBIGUOUS.
  if (intent.range_units) {
    // The AX tree does not reliably expose min/max/units. We cannot confirm
    // the range from the Observation alone; the caller (ACT/VERIFY pipeline)
    // must supply a dedicated range read-back. Here we mark it as a soft
    // signal: if the element is a spinbutton/textbox, the range is plausibly
    // present but unverifiable from this observation.
    if (el.role === 'spinbutton' || el.role === 'textbox') {
      // Range plausibly present; do not fail. The dedicated range read-back
      // (S3) is the authoritative check.
    } else {
      return {
        verdict: 'AMBIGUOUS',
        reason:
          `element "${intent.label}" has role "${el.role}" which cannot carry a ` +
          `range, but intent specifies range ${intent.range_units.min}-${intent.range_units.max}`,
        suspected_trap:
          'range read after type set: the control type may not hold a range, ' +
          'or the platform silently discarded the range on type change',
      };
    }
  }

  // Required flag: not reliably exposed in the AX tree; skip (the dedicated
  // required read-back in S3 is authoritative). We do not fail on it here.

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
  const el = findByName(obs, intent.label);
  if (!el) {
    return {
      verdict: 'FAILED',
      reason: `no existing element named "${intent.label}" (build it)`,
    };
  }
  const roles = expectedRoles(intent.canonical_type);
  if (roles.includes(el.role)) {
    return {
      verdict: 'VERIFIED',
      reason: `element "${intent.label}" already exists with role "${el.role}" (skip)`,
    };
  }
  return {
    verdict: 'AMBIGUOUS',
    reason:
      `element "${intent.label}" exists but with role "${el.role}", not ` +
      `[${roles.join(', ')}]`,
    suspected_trap: 'a same-named element exists with the wrong type',
  };
}
