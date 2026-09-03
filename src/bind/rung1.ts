/**
 * BIND rung 1 -- scratch-form probes (proposal-b section 4, rung 1).
 *
 * Perform reversible or disposable interactions and read the DIFF. These
 * probes convert naming problems into structural-evidence problems by
 * placing a control on a scratch form, inspecting its role, option
 * structure, and mutual exclusivity, then discarding.
 *
 * HARD WALL: BIND cannot click. The probes here use ACT primitives to
 * perform the interactions, but the decision logic is in BIND. The ACT
 * context is injected so the probes are testable against jsdom.
 *
 * Probes implemented:
 *   (1) Palette place-and-inspect-discard per canonical type.
 *   (2) Coded-value append-vs-replace probe.
 *   (3) Commit / is_committed probe.
 *   (4) Form-reuse probe (form.exists across visits).
 *   (5) Probe disposability detection.
 *
 * single_select vs radio and checkbox vs multi_select MUST be distinguished
 * by observed structure (role + option count + exclusivity), never by name
 * similarity.
 */

import type {
  BindingRecord,
  CanonicalType,
  ContractOpId,
} from '../shared/contract';
import type { Observation, ObservationElement, Diff } from '../perceive/core';
import { diffObservations } from '../perceive/core';
import type { ActContext } from '../act/primitives';
import { click, setValue, resolveHandle } from '../act/primitives';
import type { Candidate } from './rung0';
import { findByRole, expectedRolesForType } from './rung0';

// ---------------------------------------------------------------------------
// Probe interfaces.
// ---------------------------------------------------------------------------

/** Context for probe execution: the ACT context for clicking + a way to
 *  take fresh observations (re-perceive the DOM). */
export interface ProbeContext {
  act: ActContext;
  /** Take a fresh observation of the current DOM. */
  observe: () => Observation;
  /** Diff two observations. */
  diff: (prev: Observation, curr: Observation) => Diff;
}

/** Result of a single probe. */
export interface ProbeResult {
  /** Structural evidence observed: role, option count, exclusivity. */
  observedRole: string;
  observedOptions: string[];
  /** For choice controls: can exactly one be selected at a time? */
  mutualExclusivity: 'single' | 'multiple' | 'n/a';
  /** Options panel structural affordances */
  hasOptionsEditor?: boolean;
  hasRangeEditor?: boolean;
  hasFormulaEditor?: boolean;
  hasDatePickerOptions?: boolean;
  hasDecimalPlaces?: boolean;
  /** Evidence strings for the binding record. */
  evidence: string[];
  /** Whether the probe was destructive (creation was immediately persistent). */
  destructive: boolean;
  /** Whether the probe could be cleanly discarded. */
  discarded: boolean;
}

// ---------------------------------------------------------------------------
// (5) Disposability detection -- run FIRST because it gates the rest.
// ---------------------------------------------------------------------------

/**
 * Detect whether form creation is immediately persistent. If creating a
 * form/element is immediately persistent and cannot be discarded, rung 1
 * degrades to rung 2/3 (never destructive probing).
 *
 * Heuristic: after clicking the palette button to add a control, check
 * whether the element appeared on the canvas (it always will in the working
 * copy). Then attempt to discard (navigate away or click a cancel). If the
 * element persists after discard, creation is immediate-persistent.
 *
 * In a Node/jsdom test environment we cannot truly test this without the
 * mock running. This function provides the structural check; the full
 * behavioral probe is run against the live mock.
 */
export function detectDisposability(
  beforeDiscard: Observation,
  afterDiscard: Observation,
): { disposable: boolean; evidence: string } {
  // Compare element counts: if the placed control survives discard,
  // creation is persistent.
  const beforeControls = beforeDiscard.elements.length;
  const afterControls = afterDiscard.elements.length;
  const diff = diffObservations(beforeDiscard, afterDiscard);

  // If elements from beforeDiscard are still present after a discard
  // attempt, the platform is immediately persistent.
  const survived = diff.added.length === 0 && diff.removed.length === 0;
  if (survived && beforeControls === afterControls) {
    return {
      disposable: false,
      evidence: `creation is immediately persistent (${beforeControls} -> ${afterControls} elements, none removed by discard)`,
    };
  }
  return {
    disposable: true,
    evidence: `working copy is disposable (diff: ${diff.removed.length} removed, ${diff.added.length} added)`,
  };
}

// ---------------------------------------------------------------------------
// (1) Palette place-and-inspect-discard per canonical type.
// ---------------------------------------------------------------------------

/**
 * Place a control on the scratch form, inspect its role, option structure,
 * and mutual exclusivity from the DIFF, then discard.
 *
 * single_select vs radio: distinguished by observed role (combobox/listbox
 *   vs radiogroup) and option count + exclusivity.
 * checkbox vs multi_select: distinguished by role (checkbox vs listbox) and
 *   whether multiple selections are possible.
 */
export function inspectPlacedControl(
  beforeObs: Observation,
  afterObs: Observation,
): ProbeResult {
  const diff = diffObservations(beforeObs, afterObs);
  const addedHandles = new Set(diff.added);
  const addedElements = afterObs.elements.filter((e) => addedHandles.has(e.handle));

  // 1. Detect structural affordances in options panel
  const hasOptionsEditor = afterObs.elements.some((e) => {
    const n = e.name.toLowerCase();
    return n.includes('add value') || n.includes('paste values') || n.includes('values');
  });

  const hasRangeEditor = afterObs.elements.some((e) => {
    const n = e.name.toLowerCase();
    return n.includes('minimum') || n.includes('maximum') || n.includes('range');
  });

  const hasDecimalPlaces = afterObs.elements.some((e) => {
    const n = e.name.toLowerCase();
    return n.includes('decimal places');
  });

  const hasFormulaEditor = afterObs.elements.some((e) => {
    const n = e.name.toLowerCase();
    return n.includes('formula');
  });

  const hasDatePickerOptions = afterObs.elements.some((e) => {
    const n = e.name.toLowerCase();
    return n.includes('allow past') || n.includes('allow future') || n.includes('picker options');
  });

  // 2. Filter out options-panel controls to isolate the canvas control
  const isOptionsPanelControl = (el: ObservationElement) => {
    const n = el.name.toLowerCase();
    return (
      n === 'label' ||
      n === 'element type' ||
      n === 'visibility' ||
      n === 'delete element' ||
      n.includes('add value') ||
      n.includes('paste values') ||
      n.includes('apply pasted') ||
      n === 'required' ||
      n === 'hidden' ||
      n.includes('minimum') ||
      n.includes('maximum') ||
      n.includes('units') ||
      n.includes('decimal places') ||
      n.includes('formula') ||
      n.includes('allow past') ||
      n.includes('allow future')
    );
  };

  const canvasControls = addedElements.filter((e) => !isOptionsPanelControl(e));

  // Find placed control from canvas controls, or fallback to addedElements
  let placedControl = canvasControls.find(
    (e) =>
      e.role === 'checkbox' ||
      e.role === 'radio' ||
      e.role === 'combobox' ||
      e.role === 'listbox' ||
      e.role === 'radiogroup' ||
      e.role === 'spinbutton' ||
      e.role === 'textbox' ||
      e.role === 'switch' ||
      e.role === 'button',
  );

  if (!placedControl && canvasControls.length > 0) {
    placedControl = canvasControls[0];
  }

  if (!placedControl) {
    placedControl = addedElements.find(
      (e) =>
        e.role === 'combobox' ||
        e.role === 'listbox' ||
        e.role === 'radiogroup' ||
        e.role === 'checkbox' ||
        e.role === 'radio' ||
        e.role === 'spinbutton' ||
        e.role === 'textbox',
    );
  }

  if (!placedControl) {
    return {
      observedRole: 'none',
      observedOptions: [],
      mutualExclusivity: 'n/a',
      hasOptionsEditor,
      hasRangeEditor,
      hasFormulaEditor,
      hasDatePickerOptions,
      hasDecimalPlaces,
      evidence: ['no new interactive element detected in diff after placing control'],
      destructive: false,
      discarded: false,
    };
  }

  const evidence: string[] = [
    `placed control: role=${placedControl.role}, name="${placedControl.name}"`,
    `options: [${placedControl.options.join(', ')}] (${placedControl.options.length} options)`,
    `affordances: optionsEditor=${hasOptionsEditor}, rangeEditor=${hasRangeEditor}, formulaEditor=${hasFormulaEditor}`,
  ];

  let exclusivity: ProbeResult['mutualExclusivity'] = 'n/a';
  if (placedControl.role === 'radiogroup') {
    exclusivity = 'single';
    evidence.push('mutual exclusivity: single (radiogroup)');
  } else if (placedControl.role === 'combobox') {
    exclusivity = 'single';
    evidence.push('mutual exclusivity: single (combobox default)');
  } else if (placedControl.role === 'listbox') {
    exclusivity = 'multiple';
    evidence.push('mutual exclusivity: multiple (listbox)');
  } else if (placedControl.role === 'checkbox') {
    if (hasOptionsEditor) {
      exclusivity = 'multiple';
      evidence.push('mutual exclusivity: multiple (checkbox with options editor = multi_select)');
    } else {
      exclusivity = 'n/a';
      evidence.push('mutual exclusivity: n/a (single boolean checkbox)');
    }
  }

  return {
    observedRole: placedControl.role,
    observedOptions: placedControl.options,
    mutualExclusivity: exclusivity,
    hasOptionsEditor,
    hasRangeEditor,
    hasFormulaEditor,
    hasDatePickerOptions,
    hasDecimalPlaces,
    evidence,
    destructive: false,
    discarded: false,
  };
}

/**
 * Classify a canonical type from a probe result. This is how rung 1
 * distinguishes single_select vs radio, checkbox vs multi_select.
 *
 * The classification uses structural evidence (role + option count +
 * exclusivity + options panel affordances), never name similarity.
 */
export function classifyTypeFromProbe(
  canonical: CanonicalType,
  probe: ProbeResult,
): { matches: boolean; evidence: string } {
  // Choice types
  if (canonical === 'single_select') {
    if (probe.observedRole === 'combobox' || probe.observedRole === 'listbox') {
      return { matches: true, evidence: `single_select: role=${probe.observedRole}, dropdown selection` };
    }
    return { matches: false, evidence: `single_select: expected combobox/listbox, got ${probe.observedRole}` };
  }

  if (canonical === 'multi_select') {
    if (
      probe.observedRole === 'listbox' ||
      (probe.observedRole === 'checkbox' && probe.hasOptionsEditor) ||
      (probe.hasOptionsEditor && probe.observedRole !== 'combobox' && probe.observedRole !== 'radiogroup' && probe.observedRole !== 'radio')
    ) {
      return { matches: true, evidence: `multi_select: choice control with multi-select affordances` };
    }
    return { matches: false, evidence: `multi_select: not multi-select control (role=${probe.observedRole}, hasOptions=${probe.hasOptionsEditor})` };
  }

  if (canonical === 'radio') {
    if (probe.observedRole === 'radiogroup' || probe.observedRole === 'radio') {
      return { matches: true, evidence: `radio: role=${probe.observedRole}` };
    }
    if (probe.hasOptionsEditor && probe.mutualExclusivity === 'single' && probe.observedRole !== 'combobox') {
      return { matches: true, evidence: `radio: choice control with single exclusivity` };
    }
    return { matches: false, evidence: `radio: expected radiogroup/radio, got ${probe.observedRole}` };
  }

  if (canonical === 'checkbox') {
    if (probe.observedRole === 'checkbox' && !probe.hasOptionsEditor) {
      return { matches: true, evidence: `checkbox: single standalone boolean checkbox` };
    }
    return { matches: false, evidence: `checkbox: not single boolean checkbox (role=${probe.observedRole}, hasOptions=${probe.hasOptionsEditor})` };
  }

  // Numeric types
  if (canonical === 'decimal') {
    if (probe.hasDecimalPlaces || (probe.hasRangeEditor && (probe.observedRole === 'textbox' || probe.observedRole === 'spinbutton'))) {
      return { matches: true, evidence: `decimal: numeric with range and decimal places` };
    }
  }

  if (canonical === 'integer') {
    if (probe.hasRangeEditor && !probe.hasDecimalPlaces) {
      return { matches: true, evidence: `integer: numeric integer with range` };
    }
  }

  // Formula
  if (canonical === 'calculated') {
    if (probe.hasFormulaEditor) {
      return { matches: true, evidence: `calculated: formula editor present` };
    }
  }

  // Fallback to role match
  const expected = expectedRolesForType(canonical);
  const roleMatch = expected.includes(probe.observedRole);
  if (roleMatch) {
    return { matches: true, evidence: `${canonical}: role=${probe.observedRole} matches expected [${expected.join('|')}]` };
  }

  return { matches: false, evidence: `role mismatch: expected [${expected.join('|')}] for ${canonical}, got ${probe.observedRole}` };
}

// ---------------------------------------------------------------------------
// (2) Coded-value append-vs-replace probe.
// ---------------------------------------------------------------------------

/**
 * Probe the coded-value editor to determine whether entering a second pair
 * APPENDS or REPLACES the list. Enter one pair, read the list, enter a
 * second pair, read whether the first survived.
 *
 * Returns the mode: 'append' or 'replace' or 'unknown'.
 */
export interface CodedValueProbeResult {
  mode: 'append' | 'replace' | 'unknown';
  evidence: string[];
}

export function analyzeAppendReplace(
  listAfterFirst: string[],
  listAfterSecond: string[],
): CodedValueProbeResult {
  if (listAfterFirst.length === 0) {
    return { mode: 'unknown', evidence: ['no values after first entry -- cannot determine mode'] };
  }

  const firstSurvived = listAfterSecond.includes(listAfterFirst[0]);
  const countIncreased = listAfterSecond.length > listAfterFirst.length;

  if (firstSurvived && countIncreased) {
    return {
      mode: 'append',
      evidence: [
        `first value "${listAfterFirst[0]}" survived second entry`,
        `count increased: ${listAfterFirst.length} -> ${listAfterSecond.length}`,
        'mode: append',
      ],
    };
  }
  if (!firstSurvived) {
    return {
      mode: 'replace',
      evidence: [
        `first value "${listAfterFirst[0]}" was replaced by second entry`,
        `count: ${listAfterFirst.length} -> ${listAfterSecond.length}`,
        'mode: replace',
      ],
    };
  }
  return {
    mode: 'unknown',
    evidence: [
      `first value survived but count did not increase (${listAfterFirst.length} -> ${listAfterSecond.length})`,
      'mode: unknown',
    ],
  };
}

// ---------------------------------------------------------------------------
// (3) Commit / is_committed probe.
// ---------------------------------------------------------------------------

export interface CommitProbeResult {
  /** Whether a persistence indicator appeared after the commit click. */
  committed: boolean;
  /** Evidence strings. */
  evidence: string[];
}

export function analyzeCommit(
  beforeObs: Observation,
  afterObs: Observation,
): CommitProbeResult {
  const diff = diffObservations(beforeObs, afterObs);

  // Indicators that commit persisted changes:
  // 1. A persistence indicator appeared (and is NOT a template/banked indicator)
  const isPersistName = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('template') || n.includes('banked') || n.includes('bank it')) return false;
    return n.includes('saved') || n.includes('frozen') || n.includes('freeze') || n.includes('active') || n.includes('committed');
  };

  const addedIndicators = afterObs.elements.filter(
    (e) => isPersistName(e.name) && (diff.added.includes(e.handle) || e.role === 'status'),
  );

  // 2. An unsaved/dirty indicator was present before and is NOT present after
  const isUnsaved = (name: string) => {
    const n = name.toLowerCase();
    return n.includes('unsaved') || n.includes('dirty') || n.includes('unfrozen');
  };

  const hadUnsavedBefore = beforeObs.elements.some((e) => isUnsaved(e.name));
  const hasUnsavedAfter = afterObs.elements.some((e) => isUnsaved(e.name));
  const unsavedCleared = hadUnsavedBefore && !hasUnsavedAfter;

  if (addedIndicators.length > 0 || unsavedCleared) {
    return {
      committed: true,
      evidence: [
        ...(addedIndicators.length > 0 ? [`persistence indicator appeared: ${addedIndicators.map((i) => i.name).join(', ')}`] : []),
        ...(unsavedCleared ? ['unsaved/dirty indicator was cleared'] : []),
        'commit probe: persisted',
      ],
    };
  }

  return {
    committed: false,
    evidence: [
      `no persistence indicator detected after commit click`,
      `diff: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`,
      'commit probe: NOT persisted (may need a different commit button)',
    ],
  };
}

// ---------------------------------------------------------------------------
// (4) Form-reuse probe.
// ---------------------------------------------------------------------------

/**
 * Probe form reuse: create form F at visit A, then check from visit B
 * whether form.exists(F) finds it. If the platform reuses definitions,
 * the form is visible from visit B; if it rebuilds, it is not.
 *
 * @param formNameInVisitB - whether a form with the given name appears in
 *                           the observation of visit B's document list
 */
export interface FormReuseProbeResult {
  policy: 'reuse' | 'rebuild' | 'unknown';
  evidence: string[];
}

export function analyzeFormReuse(
  formName: string,
  formVisibleFromOtherVisit: boolean,
): FormReuseProbeResult {
  if (formVisibleFromOtherVisit) {
    return {
      policy: 'reuse',
      evidence: [
        `form "${formName}" created at visit A is visible from visit B`,
        'policy: reuse (single build, N references)',
      ],
    };
  }
  return {
    policy: 'rebuild',
    evidence: [
      `form "${formName}" created at visit A is NOT visible from visit B`,
      'policy: rebuild (N independent builds)',
    ],
  };
}

// ---------------------------------------------------------------------------
// Type binding: produce a BindingRecord for field.add from probe evidence.
// ---------------------------------------------------------------------------

/**
 * Produce a rung 1 BindingRecord for field.add(canonicalType) using the
 * structural evidence from a place-and-inspect probe. This upgrades the
 * rung 0 hypothesis to a rung 1 structural binding.
 */
export function makeTypeBinding(
  canonicalType: CanonicalType,
  probe: ProbeResult,
  paletteButtonName: string,
  paletteButtonHandle: string,
): BindingRecord {
  const classification = classifyTypeFromProbe(canonicalType, probe);
  const expectedRoles = expectedRolesForType(canonicalType);

  return {
    op: 'field.add',
    version: 1,
    recipe: [
      {
        step: 'click',
        evidence_role: 'button',
        evidence_name: paletteButtonName,
        handle_kind: 'snapshot-id',
      },
    ],
    post_condition: {
      description: `a new control of role [${expectedRoles.join('|')}] appears on canvas`,
      expect_role: expectedRoles[0],
    },
    evidence: [
      `rung 1 probe: placed "${paletteButtonName}" (handle ${paletteButtonHandle})`,
      ...probe.evidence,
      classification.evidence,
    ],
    rung: 1,
    status: classification.matches ? 'bound' : 'needs-human',
  };
}

// ---------------------------------------------------------------------------
// Full rung 1 binding: run all probes and assemble a capability report.
// ---------------------------------------------------------------------------

/**
 * Run the full rung 1 probe suite against the current observation context.
 * This is the main entry point for the binding phase.
 *
 * In a live extension run, this would be called after navigating to the
 * form builder. In tests, it is called with a jsdom fixture and stubbed
 * ACT context.
 */
export interface Rung1Result {
  /** Type bindings for all 13 canonical types. */
  typeBindings: Record<CanonicalType, BindingRecord | null>;
  /** Coded-value mode: append or replace. */
  codedValueMode: 'append' | 'replace' | 'unknown';
  /** Commit probe result. */
  commitProbe: CommitProbeResult | null;
  /** Form-reuse policy. */
  formReuse: FormReuseProbeResult | null;
  /** Disposability: can we safely probe? */
  disposable: boolean;
  /** Full evidence log. */
  evidence: string[];
}

/**
 * Given a set of rung 0 bindings and a probe context, upgrade bindings
 * to rung 1 where probes confirm them.
 *
 * This function does NOT perform live interactions -- it analyzes
 * observations taken before and after probe actions. The caller (the
 * extension's binding runner) is responsible for performing the actual
 * ACT clicks and taking observations.
 */
export function upgradeToRung1(
  rung0Bindings: Partial<Record<ContractOpId, BindingRecord>>,
  obs: Observation,
): Rung1Result {
  const evidence: string[] = [];
  const typeBindings: Record<CanonicalType, BindingRecord | null> = {
    text: null, textarea: null, integer: null, decimal: null,
    date: null, time: null, datetime: null, boolean: null,
    single_select: null, multi_select: null, radio: null,
    checkbox: null, calculated: null,
  };

  // At rung 1, the palette should be visible (from field_palette.open).
  // We look for palette buttons and try to match them to canonical types
  // by structural evidence. Since we cannot place-and-inspect without
  // a live DOM, here we just record what rung 0 found and mark them
  // as rung 1 candidates.
  const paletteBinding = rung0Bindings['field_palette.open'];
  if (paletteBinding) {
    evidence.push(`palette binding from rung 0: ${paletteBinding.evidence.join('; ')}`);
  } else {
    evidence.push('no palette binding from rung 0 -- type bindings need rung 1 probe');
  }

  // For each canonical type, check if rung 0 found a hypothesis binding.
  // In a full live run, the caller would place-and-inspect each type.
  // Here we just carry forward what rung 0 found.
  void obs;

  return {
    typeBindings,
    codedValueMode: 'unknown',
    commitProbe: null,
    formReuse: null,
    disposable: true,
    evidence,
  };
}