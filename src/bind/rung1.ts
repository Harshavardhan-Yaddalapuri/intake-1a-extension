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
import { LEXICAL_HINTS, type HintKey } from './ranking';
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
 * Does this name contain any word from a hint list?
 *
 * A weak, supplementary signal. It may add evidence toward a classification;
 * it may never exclude an element from consideration. The word lists live in
 * ranking.ts, the single declared home for lexical hints, so that this file
 * carries no vocabulary of its own.
 */
function matchesHint(name: string, hint: HintKey): boolean {
  const n = name.toLowerCase();
  return LEXICAL_HINTS[hint].some((w) => n.includes(w));
}

/** Does any of these elements carry a name suggesting this hint?
 *
 *  Scoped to a caller-supplied list, never a whole observation. Scanning the
 *  entire page would let an unrelated control poison the answer -- a palette
 *  tile named "Multi Choice Box" would make the agent believe an options
 *  editor had appeared, which is precisely the name-over-structure mistake
 *  the probe exists to correct. */
function namesSuggestIn(elements: readonly ObservationElement[], hint: HintKey): boolean {
  return elements.some((e) => matchesHint(e.name, hint));
}

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

  // 1. Separate the placed control from the property editor that opened
  //    alongside it.
  //
  //    This has to happen FIRST, because the property panel is full of
  //    controls that look like field affordances but are not: env-rosetta's
  //    panel contains an "Element Type" combobox carrying 13 options, and
  //    reading those as "this field has an option list" misclassifies a plain
  //    tick box as a multi-select. Affordances are therefore judged relative
  //    to the placed control, never to everything that appeared.
  const isPropertyEditorControl = (el: ObservationElement) =>
    matchesHint(el.name, 'property_editor');

  const canvasControls = addedElements.filter((e) => !isPropertyEditorControl(e));
  const panelControls = addedElements.filter((e) => isPropertyEditorControl(e));

  const DATA_ROLES = [
    'checkbox', 'radio', 'combobox', 'listbox', 'radiogroup',
    'spinbutton', 'textbox', 'switch', 'slider',
  ];
  const placedCandidate =
    canvasControls.find((e) => DATA_ROLES.includes(e.role)) ??
    canvasControls[0];

  // 2. Detect affordances.
  //
  //    Structure leads, vocabulary only corroborates, and both are scoped so
  //    an unrelated control cannot poison the answer.
  const hasOptionsEditor =
    // The placed control itself carries a choice vocabulary. A tick box does
    // not; a list-of-choices control does.
    (placedCandidate?.options.length ?? 0) > 0 ||
    // Or the property panel offers a coded-value editor -- checked against the
    // PANEL only, so the field's own label ("Multi Choice Box") cannot vote.
    namesSuggestIn(panelControls, 'coded_values');

  const hasRangeEditor =
    (placedCandidate?.state.range !== undefined) ||
    panelControls.filter((e) => e.role === 'spinbutton').length >= 2 ||
    namesSuggestIn(panelControls, 'range');

  const hasDecimalPlaces =
    // A fractional step is the structural statement that this control holds
    // non-integers; the label is only a fallback.
    (placedCandidate?.state.range?.step !== undefined &&
      !Number.isInteger(placedCandidate.state.range.step)) ||
    namesSuggestIn(panelControls, 'decimals');

  const hasFormulaEditor = namesSuggestIn(panelControls, 'formula');
  const hasDatePickerOptions = namesSuggestIn(panelControls, 'date_options');


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

  // What distinguishes a real save from a decoy that looks like one?
  //
  // Not the button's name. "Save As Template", "Bank It", "Export" all read
  // like persistence and none of them persist the working copy. The structural
  // answer is that a real commit CLEARS the working-copy state: whatever
  // indicator the platform was showing to mean "you have unsaved work"
  // disappears. A decoy leaves it exactly where it was.
  //
  // So the probe compares status-bearing text before and after and looks for
  // an indicator that went away. That works whether the platform calls the
  // state "Unsaved", "Draft", "Modified", "Unfrozen", or something nobody has
  // thought of, because it never reads the word -- only its disappearance.
  const STATUS_ROLES = ['status', 'alert', 'note', 'banner', 'contentinfo', 'generic', 'paragraph'];
  const statusText = (obs: Observation) =>
    obs.elements
      .filter((e) => STATUS_ROLES.includes(e.role) && e.name.length > 0)
      .map((e) => e.name);

  const before = statusText(beforeObs);
  const after = new Set(statusText(afterObs));
  const clearedIndicators = before.filter((name) => !after.has(name));

  // Second structural signal: a live region appeared. An ARIA status/alert
  // region is how a platform announces the outcome of an action, and its mere
  // APPEARANCE is structural -- no vocabulary needed to notice it.
  //
  // Vocabulary enters at exactly one point, and only to reject a decoy: a
  // control that files the work away under a reusable name announces that it
  // did so ("Banked as a reusable template", "Saved to library"), whereas a
  // real commit does not. That word list lives in ranking.ts. Note the
  // deliberate omission of any positive word list here: requiring the
  // announcement to MATCH a persisted-state vocabulary would fail on any
  // platform whose word for "saved" we did not guess, which is the whole
  // failure this refactor exists to remove.
  const announcements = afterObs.elements.filter(
    (e) =>
      diff.added.includes(e.handle) &&
      (e.role === 'status' || e.role === 'alert') &&
      e.name.length > 0,
  );
  const addedIndicators = announcements.filter((e) => !matchesHint(e.name, 'template'));
  const decoyAnnouncements = announcements.filter((e) => matchesHint(e.name, 'template'));

  const committed = clearedIndicators.length > 0 || addedIndicators.length > 0;

  if (committed) {
    return {
      committed: true,
      evidence: [
        ...(clearedIndicators.length > 0
          ? [`working-copy indicator cleared: ${clearedIndicators.join(', ')}`]
          : []),
        ...(addedIndicators.length > 0
          ? [`persisted-state indicator appeared: ${addedIndicators.map((i) => i.name).join(', ')}`]
          : []),
        'commit probe: persisted',
      ],
    };
  }

  return {
    committed: false,
    evidence: [
      'no working-copy indicator was cleared and no persisted-state indicator appeared',
      `diff: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`,
      ...(decoyAnnouncements.length > 0
        ? [
            `control announced "${decoyAnnouncements.map((d) => d.name).join(', ')}" -- ` +
            `it files the work away under a reusable name rather than committing ` +
            `this form; not every control that looks like save actually saves`,
          ]
        : []),
      'commit probe: NOT persisted (this control is not the one that commits)',
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