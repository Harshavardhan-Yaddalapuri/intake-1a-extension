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

    for (const word of hints) {
      if (lower.includes(word)) {
        signals.push({
          name: 'lexical',
          weight: WEIGHT.lexical,
          detail: `name contains "${word}" (weak hint only)`,
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
