// src/bind/ranking.ts
/**
 * Structural enumeration and weak-signal ranking.
 *
 * This module exists to enforce one rule, stated in
 * docs/superpowers/specs/2026-09-04-esource-agent-s7-design.md section 2:
 *
 *   Candidate enumeration is structural and exhaustive. Lexical priors may
 *   only rank candidates, never exclude them. The probe adjudicates.
 *
 * LEXICAL_HINTS below is the ONLY place English words appear in binding code.
 * They are data consulted after enumeration, never a filter applied during it.
 * test/enumeration-guard.test.mjs fails if UI words appear elsewhere in
 * src/bind/ or src/engine/probe-runner.ts.
 *
 * HARD WALL: this module reads Observations and returns orderings. It never
 * clicks, and it never decides that a binding is correct — only which
 * candidate to try first.
 */

import type { Observation, ObservationElement } from '../perceive/core';

export type HintKey =
  | 'commit'
  | 'discard'
  | 'palette'
  | 'visit_create'
  | 'visit_open'
  | 'form_create'
  | 'form_open'
  | 'coded_values'
  | 'range'
  | 'status'
  | 'study_root'
  | 'visit_list'
  | 'name_input'
  | 'property_editor'
  | 'decimals'
  | 'formula'
  | 'visibility'
  | 'skip_when'
  | 'skip_value'
  | 'date_options'
  | 'template'
  | 'window_start'
  | 'window_end'
  | 'repeating';

/** Weak lexical priors. A word here may raise a candidate's rank. A word here
 *  may NEVER remove a candidate from the pool. Words are deliberately generic
 *  and multi-lingual-ish in spirit: they are guesses, not knowledge. */
export const LEXICAL_HINTS: Record<HintKey, readonly string[]> = {
  commit: ['save', 'commit', 'persist', 'apply', 'publish', 'submit', 'confirm', 'lock', 'finish', 'done', 'ok'],
  discard: ['cancel', 'discard', 'close', 'back', 'abandon', 'revert', 'undo'],
  palette: ['element', 'library', 'palette', 'control', 'widget', 'component', 'field', 'question', 'item'],
  visit_create: ['visit', 'phase', 'timepoint', 'event', 'add', 'new', 'create', '+'],
  visit_open: ['visit', 'phase', 'timepoint', 'open', 'edit', 'view'],
  form_create: ['form', 'document', 'source', 'sheet', 'record', 'crf', 'add', 'new', 'create', '+'],
  form_open: ['form', 'document', 'open', 'edit', 'builder', 'design'],
  coded_values: ['value', 'option', 'choice', 'code', 'item', 'paste', 'bulk', 'list'],
  range: ['min', 'max', 'minimum', 'maximum', 'range', 'limit', 'bound', 'lower', 'upper'],
  status: ['active', 'saved', 'committed', 'draft', 'unsaved', 'dirty', 'pending', 'published', 'modified'],
  study_root: ['study', 'plan', 'protocol', 'home', 'overview', 'dashboard'],
  visit_list: ['visit', 'schedule', 'phase', 'timeline', 'list'],
  name_input: ['name', 'label', 'title', 'identifier', 'id', 'caption'],
  property_editor: [
    'label', 'element type', 'visibility', 'delete', 'required', 'hidden',
    'add value', 'paste values', 'apply pasted', 'minimum', 'maximum', 'units',
    'decimal places', 'formula', 'allow past', 'allow future',
  ],
  decimals: ['decimal', 'precision', 'places'],
  formula: ['formula', 'expression', 'calculation', 'derived'],
  visibility: ['visibility', 'visible', 'show', 'hide', 'display', 'conditional'],
  skip_when: ['when', 'trigger', 'controlling', 'element', 'node', 'field'],
  skip_value: ['equal', 'equals', 'value', 'condition'],
  date_options: ['allow past', 'allow future', 'picker options', 'date range'],
  template: ['template', 'banked', 'bank it', 'library', 'reusable'],
  window_start: ['start', 'from', 'begin', 'day 1', 'lower', 'earliest', 'window'],
  window_end: ['end', 'to', 'until', 'finish', 'upper', 'latest', 'window'],
  repeating: ['repeat', 'recurring', 'multiple', 'many'],
};

/** Signal weights. Structural evidence outranks vocabulary, deliberately:
 *  a control that appeared in the diff we just caused is better evidence than
 *  a control whose label happens to contain an English word we guessed. */
const WEIGHT = {
  lexical: 1,
  /** An EXACT name match is stronger evidence than a substring one: "Save" is
   *  the save control; "Save As Template" merely contains the word and is a
   *  different control entirely -- the decoy the brief warns about.
   *
   *  Still deliberately below inDiff. Structural evidence outranks vocabulary
   *  even when the vocabulary matches perfectly: a control that appeared in
   *  the diff we just caused is better evidence than a word we guessed. */
  lexicalExact: 2,
  /** A candidate matching a hint list the caller named as a known decoy.
   *  Demoted, never excluded: it still gets probed, just last, so a platform
   *  where our guess about what is a decoy is wrong still recovers. */
  demoted: -4,
  actionable: 1,
  inRegion: 2,
  primary: 2,
  inDiff: 3,
  disabled: -4,
} as const;

export interface RankSignal {
  name: string;
  weight: number;
  detail: string;
}

export interface RankedCandidate {
  el: ObservationElement;
  score: number;
  signals: RankSignal[];
}

export interface RankOptions {
  /** Which lexical hint list to consult, if any. */
  hint?: HintKey;
  /** Hint lists whose members are known decoys for THIS question. Matching
   *  candidates are pushed down the trial order rather than removed, so the
   *  probe still reaches them if the ranking guessed wrong. */
  demote?: readonly HintKey[];
  /** Handles that appeared in the most recent diff. Strong structural signal. */
  diffAdded?: readonly string[];
  /** Handle prefix bounding the region of interest. */
  regionHandle?: string;
  /** Handles the platform marks as primary/default actions, if observable. */
  primaryHandles?: readonly string[];
}

/** Roles that clearly afford activation. A RANKING signal and a preference —
 *  never a gate. */
const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem',
]);

/** Roles that hold a value rather than performing an action. */
const VALUE_ROLES = new Set([
  'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'slider',
]);

/** Roles that are structure or prose, never a control. */
const STATIC_ROLES = new Set([
  'heading', 'paragraph', 'list', 'listitem', 'table', 'row', 'cell',
  'columnheader', 'rowheader', 'article', 'region', 'banner', 'navigation',
  'complementary', 'contentinfo', 'main', 'form', 'group', 'presentation', 'img',
]);

/**
 * Every element that could plausibly be activated.
 *
 * PERCEIVE has already filtered the page down to interactive elements — its
 * isInteractive() deliberately admits tabindex>=0 and cursor:pointer elements
 * so that platforms building controls out of bare <div>s are still observed.
 * Such an element computes to role 'generic', so gating on a list of "real"
 * action roles would throw away exactly the controls PERCEIVE went out of its
 * way to keep, and every binder would see an empty pool on an
 * accessibility-hostile platform. That is the same failure as the lexical
 * gate, relocated.
 *
 * So: exclude only what is unambiguously NOT a control — prose and structure,
 * and value-holding inputs, which a Save button is never one of. Everything
 * else, 'generic' very much included, stays a candidate and is ordered by
 * rankCandidates.
 */
export function enumerateActionable(obs: Observation): ObservationElement[] {
  return obs.elements.filter(
    (e) => !STATIC_ROLES.has(e.role) && !VALUE_ROLES.has(e.role),
  );
}

/** Roles that PERFORM an action rather than hold a value.
 *
 *  A narrower set than ACTIONABLE_ROLES, which deliberately includes
 *  checkbox/radio/switch because a palette tile can be any of those. When the
 *  question is "which control confirms this dialog", a value-holding control
 *  is never the answer, and including one lets a stray checkbox outrank the
 *  actual confirm button. */
const ACTION_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
]);

/** Every element that performs an action, regardless of its name. Used where
 *  a value-holding control cannot be the right answer. */
export function enumerateActions(obs: Observation): ObservationElement[] {
  return obs.elements.filter((e) => ACTION_ROLES.has(e.role) || e.role === 'generic');
}

/**
 * Find the tightest container holding the most controls.
 *
 * A field palette is, structurally, a large group of sibling-ish controls: 13
 * tiles under one ancestor, versus 4 nav links under another and 4 toolbar
 * buttons under a third. Tiles are often each wrapped in their own div, so
 * immediate-parent grouping does not find them -- the search therefore walks
 * up several levels and keeps whichever ancestor captures the largest cluster.
 *
 * This matters because probing is destructive: clicking a nav link to see
 * whether it is a palette tile navigates away from the designer and breaks
 * every probe after it. Knowing where the palette lives lets the probe try
 * those candidates FIRST, so it finds what it needs before it can wander off.
 *
 * Purely structural -- no names are read.
 */
export function largestControlCluster(
  pool: readonly ObservationElement[],
): { regionHandle: string; members: ObservationElement[] } | null {
  let best: { regionHandle: string; members: ObservationElement[] } | null = null;

  for (let strip = 1; strip <= 6; strip += 1) {
    const groups = new Map<string, ObservationElement[]>();
    for (const el of pool) {
      const parts = el.handle.split('.');
      if (parts.length <= strip) continue;
      const key = parts.slice(0, parts.length - strip).join('.');
      const bucket = groups.get(key);
      if (bucket) bucket.push(el);
      else groups.set(key, [el]);
    }
    for (const [regionHandle, members] of groups) {
      // Too small to be a palette, or so large it is simply the whole app.
      if (members.length < 3) continue;
      if (members.length > pool.length * 0.8) continue;
      if (!best || members.length > best.members.length) {
        best = { regionHandle, members };
      }
    }
  }
  return best;
}

/** Every element matching one of the given roles, regardless of its name. */
export function enumerateByRoles(obs: Observation, roles: readonly string[]): ObservationElement[] {
  const wanted = new Set(roles);
  return obs.elements.filter((e) => wanted.has(e.role));
}

/**
 * Order a pool of candidates by accumulated weak signals.
 *
 * INVARIANT: the returned array has exactly the same length as `pool`.
 * Nothing is ever filtered out. test/ranking.test.mjs asserts this for every
 * hint key, and it is the mechanical guarantee behind the enumeration
 * principle.
 */
export function rankCandidates(
  pool: readonly ObservationElement[],
  options: RankOptions = {},
): RankedCandidate[] {
  const hints = options.hint ? LEXICAL_HINTS[options.hint] : [];

  const scored = pool.map((el, inputIndex) => {
    const signals: RankSignal[] = [];
    const lower = el.name.toLowerCase();

    const trimmed = lower.trim();
    for (const word of hints) {
      if (trimmed === word) {
        signals.push({
          name: 'lexical-exact',
          weight: WEIGHT.lexicalExact,
          detail: `name is exactly "${word}"`,
        });
        break;
      }
      if (lower.includes(word)) {
        signals.push({
          name: 'lexical',
          weight: WEIGHT.lexical,
          detail: `name contains "${word}" (weak hint only)`,
        });
        break;
      }
    }

    for (const decoyHint of options.demote ?? []) {
      if (LEXICAL_HINTS[decoyHint].some((w) => lower.includes(w))) {
        signals.push({
          name: 'decoy',
          weight: WEIGHT.demoted,
          detail: `name matches the "${decoyHint}" list -- a known decoy for this question, tried last`,
        });
        break;
      }
    }

    if (options.diffAdded?.includes(el.handle)) {
      signals.push({
        name: 'in-diff',
        weight: WEIGHT.inDiff,
        detail: 'appeared in the diff caused by the preceding action',
      });
    }

    if (options.regionHandle) {
      const region = options.regionHandle;
      // Descendant, not sibling: handles join child indices with '.', so a
      // bare startsWith would match 0.3.12 against region 0.3.1.
      if (el.handle === region || el.handle.startsWith(`${region}.`)) {
        signals.push({
          name: 'in-region',
          weight: WEIGHT.inRegion,
          detail: 'located inside the region of interest',
        });
      }
    }

    if (options.primaryHandles?.includes(el.handle)) {
      signals.push({
        name: 'primary',
        weight: WEIGHT.primary,
        detail: 'marked by the platform as a primary action',
      });
    }

    if (ACTIONABLE_ROLES.has(el.role)) {
      signals.push({
        name: 'actionable',
        weight: WEIGHT.actionable,
        detail: `role=${el.role}`,
      });
    }

    if (el.state.disabled) {
      signals.push({
        name: 'disabled',
        weight: WEIGHT.disabled,
        detail: 'control is disabled',
      });
    }

    const score = signals.reduce((sum, s) => sum + s.weight, 0);
    return { candidate: { el, score, signals }, inputIndex };
  });

  // Stable: higher score first, input order as tiebreak.
  scored.sort((a, b) => (b.candidate.score - a.candidate.score) || (a.inputIndex - b.inputIndex));
  return scored.map((s) => s.candidate);
}

/** One-line human-readable explanation of why a candidate ranked where it did.
 *  Goes into BindingRecord.evidence and, later, the journal. */
export function explainRanking(
  ranked: RankedCandidate,
  poolSize: number,
  rankIndex = 0,
): string {
  const detail = ranked.signals.map((s) => s.detail).join('; ');
  const ordinal = rankIndex + 1;
  return `ranked ${ordinal} of ${poolSize} structurally enumerated candidates ` +
    `(score ${ranked.score}: ${detail || 'no signals'})`;
}
