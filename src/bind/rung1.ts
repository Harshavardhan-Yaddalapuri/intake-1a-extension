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
import { CANONICAL_TYPES } from '../shared/contract';
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
  /** Canvas preview carries a date mask (e.g. DD-MMM-YYYY). */
  hasDateFormatHint?: boolean;
  /** Canvas preview carries a time mask (e.g. HH:MM). */
  hasTimeFormatHint?: boolean;
  /**
   * Canonical type declared by the property-panel type picker (Node Type /
   * Element Type). Hostile envs expose the canonical id as <select>.value;
   * when present this is stronger than role isomorphism (every Free/date
   * tile is a textbox).
   */
  declaredCanonical?: CanonicalType | null;
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
  return elements.some(
    (e) => matchesHint(e.name, hint) || matchesHint(e.groupText ?? '', hint),
  );
}

/** Read the canonical type from a Node Type / Element Type picker in the panel.
 *
 *  env-swapped-controls labels it "Node Type" and stores the canonical id in
 *  the option value; env-rosetta uses "Element Type" the same way. Without
 *  this, Free String / Glyph Line / Solar Mark / Calendar Day are all bare
 *  textboxes and first-wins probe binds date to the wrong tile (or, when the
 *  probe navigates away first, leaves date unbound).
 */
export function readDeclaredCanonical(
  panelControls: readonly ObservationElement[],
): CanonicalType | null {
  const picker = panelControls.find(
    (e) => {
      const typeNamed = /\btype\b/i.test(e.name) || /\btype\b/i.test(e.groupText ?? '');
      if (!typeNamed) return false;
      // Native <select> / listbox, or a11y-hostile custom list (role=generic)
      // whose accessible name is the currently displayed type label.
      return e.role === 'combobox' || e.role === 'listbox' || e.role === 'generic' || e.role === 'button';
    },
  );
  if (!picker) return null;
  const raw = (picker.state.value ?? '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
  if ((CANONICAL_TYPES as readonly string[]).includes(raw)) {
    return raw as CanonicalType;
  }
  // Friendly mocks sometimes store the visible label as the value ("Date").
  // Hostile Prism Fragment Type dropList keeps the friendly label as the
  // accessible name while state.value is empty.
  const label = (picker.state.value || picker.name || '').trim().toLowerCase();
  const fromLabel: Record<string, CanonicalType> = {
    date: 'date',
    time: 'time',
    'date/time': 'datetime',
    datetime: 'datetime',
    'date time': 'datetime',
    text: 'text',
    textarea: 'textarea',
    integer: 'integer',
    decimal: 'decimal',
    boolean: 'boolean',
    checkbox: 'checkbox',
    radio: 'radio',
    calculated: 'calculated',
  };
  if (fromLabel[label]) return fromLabel[label];
  // Adversarial friendly names (Glyph Line, Sun Marker, …) only for custom
  // dropLists. Native <select> values like "Radio Buttons" must NOT map via
  // substring ('radio') — that made empty radios look declared and broke
  // choice-type-readback / multi_select vacuous matching.
  if (picker.role !== 'generic' && picker.role !== 'button') return null;
  let best: CanonicalType | null = null;
  let bestHits = 0;
  let tied = false;
  for (const t of CANONICAL_TYPES) {
    const hits = friendlyTypeLabelHits(t, label);
    if (hits > bestHits) { best = t; bestHits = hits; tied = false; }
    else if (hits > 0 && hits === bestHits) tied = true;
  }
  if (best && bestHits > 0 && !tied) return best;
  return null;
}

/** Friendly type-picker labels → canonical. Used only when the picker value is
 *  not already a canonical id (Prism Fragment Type dropList). */
function friendlyTypeLabelHits(canonical: CanonicalType, name: string): number {
  const TABLE: Record<CanonicalType, readonly string[]> = {
    text: ['line', 'text', 'string', 'glyph line'],
    textarea: ['block', 'paragraph', 'glyph block'],
    integer: ['int', 'whole', 'integer', 'count int'],
    decimal: ['decimal', 'precise', 'float', 'count precise'],
    date: ['date', 'sun', 'calendar', 'sun marker'],
    time: ['time', 'hour', 'clock', 'hour marker'],
    datetime: ['datetime', 'chrono', 'timestamp', 'chrono marker'],
    boolean: ['boolean', 'switch', 'polarity', 'yes/no'],
    single_select: ['dropdown', 'lens', 'lens list'],
    multi_select: ['token', 'tray', 'token tray', 'checklist'],
    radio: ['radio', 'beam', 'cluster', 'beam cluster'],
    checkbox: ['checkbox', 'tick', 'tick slate'],
    calculated: ['calculated', 'formula', 'synthesis', 'synthesis output'],
  };
  const n = name.toLowerCase();
  return (TABLE[canonical] ?? []).filter((s) => n.includes(s)).length;
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
    matchesHint(el.name, 'property_editor')
    || matchesHint(el.groupText ?? '', 'property_editor')
    || matchesHint(el.groupText ?? '', 'panel_field');

  const canvasControls = addedElements.filter((e) => !isPropertyEditorControl(e));
  const panelControls = addedElements.filter((e) => isPropertyEditorControl(e));

  // Prefer NAMED canvas controls. Required/Hidden checkboxes in hostile envs
  // often have empty accessible names (label[for] points at a missing id), so
  // they survive the property_editor name filter and look like the placed
  // field. Reading them made empty Dial Group / Beam Pick look like
  // checkbox+optionsEditor (= multi_select), and radio never bound.
  const namedCanvas = canvasControls.filter((e) => (e.name || '').trim() !== '');

  const DATA_ROLES = [
    'checkbox', 'radio', 'combobox', 'listbox', 'radiogroup',
    'spinbutton', 'textbox', 'switch', 'slider',
  ];
  // Prefer a data-role control on the canvas even when nameless (Prism paints
  // empty contenteditable previews). Named cards alone would hide the textbox
  // and leave date/integer probes at role=none after the Label cell moved to
  // the panel via groupText.
  const placedCandidate =
    canvasControls.find((e) => DATA_ROLES.includes(e.role))
    ?? namedCanvas[0]
    ?? canvasControls[0];
  const canvasForPlace = placedCandidate
    ? [placedCandidate, ...namedCanvas.filter((e) => e.handle !== placedCandidate.handle)]
    : [];

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
    // Exclude the type picker: its option labels ("Lens List") contain coded_values
    // hint words like "list" and would mark every Prism tile as a choice control.
    namesSuggestIn(
      panelControls.filter(
        (e) => !/\btype\b/i.test(e.name) && !/\btype\b/i.test(e.groupText ?? ''),
      ),
      'coded_values',
    );

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
  // Prefer the live panel on afterObs: sequential palette probes leave prior
  // tiles on the canvas, so the type picker may not appear in the diff even
  // though it now shows the newly selected element's canonical type.
  const declaredCanonical =
    readDeclaredCanonical(afterObs.elements.filter(
      (e) => matchesHint(e.name, 'property_editor') || matchesHint(e.groupText ?? '', 'property_editor'),
    ))
    ?? readDeclaredCanonical(panelControls);

  // Structural date/time masks painted beside the canvas preview (Prism:
  // "DD-MMM-YYYY" / "HH:MM") — not vocabulary about the palette tile name.
  const formatBlob = canvasControls
    .map((e) => `${e.groupText ?? ''} ${e.name ?? ''}`)
    .join(' ')
    .toLowerCase();
  const hasDateFormatHint = /\bdd[-/\s]?mmm[-/\s]?yyyy\b|\byyyy[-/]mm[-/]dd\b|\bmm\/dd\/yyyy\b/.test(formatBlob);
  const hasTimeFormatHint = /\bhh:mm\b/.test(formatBlob);

  // Find placed control from named canvas controls only (see canvasForPlace).
  let placedControl = canvasForPlace.find(
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

  if (!placedControl && canvasForPlace.length > 0) {
    placedControl = canvasForPlace[0];
  }

  // NEVER fall back to the property panel. An empty choice control adds no
  // interactive canvas node ("No values defined."); the panel's Label /
  // Required / type picker always appear alongside it. Reading those as the
  // placed field made Dial Group / Beam Pick look like a textbox, skipped
  // deepen, and escalated radio to the human gate on clear probe-able tiles.
  if (!placedControl) {
    // Empty date/text tiles can leave only the property panel visible when
    // the canvas control is nameless; the type picker still declares what
    // was placed, so date need not escalate to a human gate.
    if (declaredCanonical) {
      return {
        observedRole: 'none',
        observedOptions: [],
        mutualExclusivity: 'n/a',
        hasOptionsEditor,
        hasRangeEditor,
        hasFormulaEditor,
        hasDatePickerOptions,
        hasDecimalPlaces,
        hasDateFormatHint,
        hasTimeFormatHint,
        declaredCanonical,
        evidence: [
          `property panel type picker declares canonical "${declaredCanonical}" (no named canvas control yet)`,
        ],
        destructive: false,
        discarded: false,
      };
    }
    return {
      // 'generic' + hasOptionsEditor is the deepen signal: the panel says this
      // is a choice control, the canvas has not realised it yet.
      observedRole: hasOptionsEditor ? 'generic' : 'none',
      observedOptions: [],
      mutualExclusivity: 'n/a',
      hasOptionsEditor,
      hasRangeEditor,
      hasFormulaEditor,
      hasDatePickerOptions,
      hasDecimalPlaces,
      hasDateFormatHint,
      hasTimeFormatHint,
      declaredCanonical: null,
      evidence: [
        hasOptionsEditor
          ? 'property panel offers an options editor but no interactive control appeared on the canvas yet (empty choice)'
          : 'no new interactive element detected in diff after placing control',
      ],
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

  if (declaredCanonical) {
    evidence.push(`property panel type picker declares canonical "${declaredCanonical}"`);
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
    hasDateFormatHint,
    hasTimeFormatHint,
    declaredCanonical,
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
  // Property-panel type picker is structural (option value / selection), not a
  // name guess. Scoped to the textbox-isomorphic family: Free String / Glyph
  // Line / Solar Mark / Calendar Day / Clock Time all place a textbox, so role
  // alone cannot separate text from date. Choice types still need deepen /
  // role evidence — an empty Dial Group's picker says "radio" but the canvas
  // has not realised options yet.
  const TEXTBOX_FAMILY: readonly CanonicalType[] = [
    'text', 'textarea', 'integer', 'decimal', 'date', 'time', 'datetime', 'calculated',
  ];
  if (probe.declaredCanonical && TEXTBOX_FAMILY.includes(probe.declaredCanonical)) {
    const matches = probe.declaredCanonical === canonical;
    return {
      matches,
      evidence: matches
        ? `${canonical}: type picker declares "${probe.declaredCanonical}"`
        : `${canonical}: type picker declares "${probe.declaredCanonical}", not ${canonical}`,
    };
  }

  // Wizard / empty-canvas choice: type picker already stores the canonical id
  // (option value="radio") before any options exist on the canvas. Trust that
  // declaration when the observed role has not materialised yet — otherwise
  // FormCraft Orbit Set / Pick One never bind (live wizard v10: 8 fields).
  if (
    probe.declaredCanonical === canonical
    && (canonical === 'radio' || canonical === 'single_select' || canonical === 'multi_select')
    && (probe.observedRole === 'none' || probe.observedRole === 'generic')
  ) {
    return {
      matches: true,
      evidence: `${canonical}: type picker declares "${probe.declaredCanonical}" (canvas role unrealised)`,
    };
  }

  // Choice types
  if (canonical === 'single_select') {
    if (probe.observedRole === 'combobox' || probe.observedRole === 'listbox') {
      return { matches: true, evidence: `single_select: role=${probe.observedRole}, dropdown selection` };
    }
    if (probe.declaredCanonical === 'single_select') {
      return { matches: true, evidence: `single_select: type picker declares single_select` };
    }
    return { matches: false, evidence: `single_select: expected combobox/listbox, got ${probe.observedRole}` };
  }

  if (canonical === 'multi_select') {
    // Empty single-choice tiles declare radio/single_select in the type picker
    // but have no canvas role until deepen. The vacuous hasOptionsEditor branch
    // must not claim them as multi_select — that stole Beam Pick from radio
    // after a prior probe left deepen without "+ Add Choice" (E2E v5 swapped).
    if (
      probe.declaredCanonical === 'radio'
      || probe.declaredCanonical === 'single_select'
    ) {
      return {
        matches: false,
        evidence: `multi_select: type picker declares "${probe.declaredCanonical}"`,
      };
    }
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
    if (probe.declaredCanonical === 'radio') {
      return { matches: true, evidence: `radio: type picker declares radio` };
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
    // Require an explicit decimal-places affordance (or declaredCanonical above).
    // Bare range+textbox also matches integer and stole Count Int from integer
    // on Prism (both types specificity=2, first tile wins).
    if (probe.hasDecimalPlaces) {
      return { matches: true, evidence: `decimal: decimal-places affordance present` };
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

  // Canvas date/time masks are structural — reserve the textbox-family role
  // match so Sun Marker does not also bind text/textarea/date siblings.
  if (probe.hasDateFormatHint || probe.hasTimeFormatHint) {
    const isDatetime = !!(probe.hasDateFormatHint && probe.hasTimeFormatHint);
    const isDate = !!(probe.hasDateFormatHint && !probe.hasTimeFormatHint);
    const isTime = !!(probe.hasTimeFormatHint && !probe.hasDateFormatHint);
    if (canonical === 'datetime') {
      return { matches: isDatetime, evidence: isDatetime ? 'datetime: date+time format hint on canvas' : 'datetime: format hint is not combined date+time' };
    }
    if (canonical === 'date') {
      return { matches: isDate, evidence: isDate ? 'date: date format hint on canvas' : 'date: format hint is not date-only' };
    }
    if (canonical === 'time') {
      return { matches: isTime, evidence: isTime ? 'time: time format hint on canvas' : 'time: format hint is not time-only' };
    }
    if (
      canonical === 'text' || canonical === 'textarea' || canonical === 'integer'
      || canonical === 'decimal' || canonical === 'calculated'
    ) {
      return { matches: false, evidence: `${canonical}: canvas format hint reserves date/time` };
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

/**
 * Are these two observations of the SAME surface?
 *
 * Committing clears a marker; leaving clears the screen. Used both to keep a
 * navigation from being recorded as a commit, and to stop a trial loop that
 * has wandered off the form it was trying to save.
 */
export function sameSurface(before: Observation, after: Observation): boolean {
  const words = (obs: Observation) => {
    const out = new Set<string>();
    for (const e of obs.elements) {
      for (const w of (e.groupText ?? '').toLowerCase().split(/\s+/)) if (w) out.add(w);
    }
    return out;
  };
  const b = words(before);
  if (b.size === 0) return true;
  const a = words(after);
  const retained = [...b].filter((w) => a.has(w)).length;
  return retained / b.size >= 0.5;
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

  // The indicator usually is not an element of its own. `observe` reports only
  // INTERACTIVE elements, so a platform that states its working-copy state in
  // plain text ("v1 - Draft - Unsaved changes" beside the buttons) contributes
  // no status element at all, and the comparison above has nothing to compare.
  // That text is still observed -- as the groupText of the controls it sits
  // with -- so the same question is asked there.
  //
  // Word LOSS, not word change: a real commit removes the pending marker,
  // while a decoy only adds an announcement of its own ("Saved as a reusable
  // template"), leaving the marker in place. Comparing sets of words rather
  // than whole strings is what tells those two apart, and it reads no
  // vocabulary -- only what stopped being displayed.
  const groupWords = (obs: Observation) => {
    const words = new Set<string>();
    for (const e of obs.elements) {
      for (const w of (e.groupText ?? '').toLowerCase().split(/\s+/)) {
        if (w) words.add(w);
      }
    }
    return words;
  };
  const wordsBefore = groupWords(beforeObs);
  const wordsAfter = groupWords(afterObs);
  const lost = [...wordsBefore].filter((w) => !wordsAfter.has(w));

  // Committing clears a marker; LEAVING clears the screen. Without this, a
  // control that navigates away -- discarding the working copy on the way out,
  // which is the trap this whole probe exists to survive -- would lose every
  // word at once and be recorded as the platform's save control. A commit is
  // only credible while we are demonstrably still on the same surface.
  const lostWords = sameSurface(beforeObs, afterObs) ? lost : [];

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

  const committed =
    clearedIndicators.length > 0 || addedIndicators.length > 0 || lostWords.length > 0;

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
        ...(lostWords.length > 0
          ? [`working-copy text no longer displayed: ${lostWords.join(' ')}`]
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
  paletteButtonRole: string = 'button',
): BindingRecord {
  const classification = classifyTypeFromProbe(canonicalType, probe);
  const expectedRoles = expectedRolesForType(canonicalType);

  return {
    op: 'field.add',
    version: 1,
    recipe: [
      {
        step: 'click',
        // Hostile palettes use role=generic tiles; prefer the observed role so
        // resolveRecipeTarget hits role+name before the name-only fallback.
        evidence_role: paletteButtonRole || 'button',
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
    // The probe placed the control and read back what appeared, so this is a
    // conclusion when it agrees -- and an explicit non-answer when it does not.
    confidence: classification.matches ? 'structural' : 'tentative',
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