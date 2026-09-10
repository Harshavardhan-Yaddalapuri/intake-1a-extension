/**
 * BIND rung 0 -- structural binding (proposal-b section 4, rung 0).
 *
 * Resolve contract operations from the current Observation alone, using
 * role + accname + state. Name-only matches are HYPOTHESES flagged for
 * confirmation, never conclusions.
 *
 * HARD WALL: BIND cannot click. It only inspects observations and emits
 * BindingRecords. ACT does the clicking.
 *
 * The binding ladder spends LLM calls only at rungs where structural evidence
 * is insufficient. On a well-behaved accessible mock, most ops bind here.
 */

import type {
  BindingRecord,
  BindingRung,
  CanonicalType,
  ContractOpId,
  ObservedField,
  PostCondition,
  RecipeStep,
} from '../shared/contract';
import type { Observation, ObservationElement } from '../perceive/core';
import {
  enumerateActionable,
  enumerateByRoles,
  largestControlCluster,
  rankCandidates,
  explainRanking,
  matchesHintExact,
  matchesHintLoose,
  type RankedCandidate,
} from './ranking';

// ---------------------------------------------------------------------------
// Candidate search: find elements matching role + optional name constraints.
// ---------------------------------------------------------------------------

export interface Candidate {
  el: ObservationElement;
  /** How strong the match is: role+name = structural; name-only = hypothesis;
   *  role-only = tentative. */
  confidence: 'structural' | 'hypothesis' | 'tentative';
  /** The evidence string for the binding record. */
  evidence: string;
}

/** Find elements by role. Optionally filter by a name substring (case
 *  insensitive). Returns candidates with confidence levels. */
export function findByRole(
  obs: Observation,
  role: string,
  nameFilter?: { contains?: string; equals?: string },
): Candidate[] {
  const results: Candidate[] = [];
  for (const el of obs.elements) {
    if (el.role !== role) continue;
    if (nameFilter) {
      const name = el.name.toLowerCase();
      if (nameFilter.contains && !name.includes(nameFilter.contains.toLowerCase())) continue;
      if (nameFilter.equals && name !== nameFilter.equals.toLowerCase()) continue;
    }
    // Role match with no name constraint: tentative.
    // Role match with name constraint: structural if name also matches.
    let confidence: Candidate['confidence'] = 'tentative';
    let evidence = `role=${el.role}`;
    if (nameFilter) {
      confidence = 'structural';
      evidence += `, name~="${el.name}"`;
    } else {
      evidence += `, name="${el.name}"`;
    }
    results.push({ el, confidence, evidence });
  }
  return results;
}

/** Find elements by name only (no role constraint). These are HYPOTHESES. */
export function findByNameOnly(obs: Observation, nameSubstring: string): Candidate[] {
  const results: Candidate[] = [];
  const needle = nameSubstring.toLowerCase();
  for (const el of obs.elements) {
    if (el.name.toLowerCase().includes(needle)) {
      results.push({
        el,
        confidence: 'hypothesis',
        evidence: `name~="${el.name}" (name-only match, hypothesis)`,
      });
    }
  }
  return results;
}

/** Find elements by role only, returning all with that role. */
export function findByRoleOnly(obs: Observation, role: string): Candidate[] {
  return findByRole(obs, role);
}

// ---------------------------------------------------------------------------
// Navigation ops: nav.to_study_root, nav.to_visit_list.
// ---------------------------------------------------------------------------

/**
 * Bind nav.to_study_root.
 *
 * Every actionable control is a candidate. Ranking picks a trial order using
 * weak signals; it never removes anything from the pool. On a platform whose
 * study-root control is worded in a way nobody guessed, the pool is still
 * non-empty and the probe adjudicates -- which is the whole point.
 */
export function bindNavToStudyRoot(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'study_root' });
  const best = ranked[0];

  return makeBinding(
    'nav.to_study_root',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the study root / plan screen is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}

/**
 * Bind nav.to_visit_list: reach the list of visits.
 */
export function bindNavToVisitList(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'visit_list' });
  const best = ranked[0];

  return makeBinding(
    'nav.to_visit_list',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the visit list is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}

// ---------------------------------------------------------------------------
// Visit ops: visit.create, visit.open.
// ---------------------------------------------------------------------------

/**
 * Bind visit.create.
 *
 * The recipe is click-add, then name it, then confirm. The name field and the
 * confirm control usually appear only AFTER the add control is clicked, so at
 * rung 0 they are opportunistic: recorded when they happen to be visible
 * already, and rediscovered by the orchestrator from a fresh observation
 * otherwise. The visit name itself is substituted from the IR at act time,
 * never baked into the binding.
 */
export function bindVisitCreate(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'visit_create' });
  const best = ranked[0];

  const recipe: RecipeStep[] = [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ];
  const evidence: string[] = [explainRanking(best, pool.length)];

  const textPool = enumerateByRoles(obs, ['textbox', 'searchbox']);
  if (textPool.length > 0) {
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0];
    recipe.push({
      step: 'set_value',
      evidence_role: nameBox.el.role,
      evidence_name: nameBox.el.name,
      handle_kind: 'snapshot-id',
      value_from: 'ir',
    });
    evidence.push(`name field: ${explainRanking(nameBox, textPool.length)}`);
  }

  const confirm = rankCandidates(pool, { hint: 'commit' })[0];
  if (confirm && confirm.el.handle !== best.el.handle) {
    recipe.push({
      step: 'click',
      evidence_role: confirm.el.role,
      evidence_name: confirm.el.name,
      handle_kind: 'snapshot-id',
    });
    evidence.push(`confirm control: ${explainRanking(confirm, pool.length)}`);
  }

  return makeBinding(
    'visit.create',
    0,
    recipe,
    'a new visit appears in the visit list after save',
    evidence,
    'hypothesis',
  );
}

/**
 * Bind visit.open: reach a specific visit's detail screen.
 *
 * The orchestrator resolves WHICH visit by matching the IR-supplied name
 * against the observation at act time. A name from the input file is data,
 * not a hardcoded vocabulary guess, so that comparison is legitimate; this
 * binding only establishes that visits are openable at all.
 */
export function bindVisitOpen(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'visit_open' });
  const best = ranked[0];

  return makeBinding(
    'visit.open',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the named visit detail screen is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}


// ---------------------------------------------------------------------------
// Form ops: form.create, form.open, form.exists.
// ---------------------------------------------------------------------------

/**
 * Bind form.create.
 *
 * Same shape as visit.create: click-add, name it, confirm. The name field and
 * confirm control usually materialise only after the add control is clicked,
 * so at rung 0 they are opportunistic and the orchestrator rediscovers them
 * from a fresh observation when they are absent here.
 */
export function bindFormCreate(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'form_create' });
  const best = ranked[0];

  const recipe: RecipeStep[] = [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ];
  const evidence: string[] = [explainRanking(best, pool.length)];

  const textPool = enumerateByRoles(obs, ['textbox', 'searchbox']);
  if (textPool.length > 0) {
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0];
    recipe.push({
      step: 'set_value',
      evidence_role: nameBox.el.role,
      evidence_name: nameBox.el.name,
      handle_kind: 'snapshot-id',
      value_from: 'ir',
    });
    evidence.push(`name field: ${explainRanking(nameBox, textPool.length)}`);
  }

  const confirm = rankCandidates(pool, { hint: 'commit' })[0];
  if (confirm && confirm.el.handle !== best.el.handle) {
    recipe.push({
      step: 'click',
      evidence_role: confirm.el.role,
      evidence_name: confirm.el.name,
      handle_kind: 'snapshot-id',
    });
    evidence.push(`confirm control: ${explainRanking(confirm, pool.length)}`);
  }

  return makeBinding(
    'form.create',
    0,
    recipe,
    'a new source document appears under the open visit',
    evidence,
    'hypothesis',
  );
}

/**
 * Bind form.open: reach the designer surface for a named form.
 *
 * Which form is resolved by the orchestrator against the IR-supplied name at
 * act time; this binding only establishes that forms are openable.
 */
export function bindFormOpen(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'form_open' });
  const best = ranked[0];

  return makeBinding(
    'form.open',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the form designer for the named document is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}

/** Trim, collapse internal whitespace, case-fold. Applied to both sides of
 *  every group-text comparison so padding and casing cannot hide a match. */
function normaliseText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Resolve the control that opens ONE NAMED form, scoped to the group that
 * bears that name.
 *
 * A platform listing N forms renders N identical open-controls ("Edit",
 * "Open", a pencil glyph). Selecting by the control's own name can only ever
 * return the first of them, which silently builds every form's fields into
 * whichever form happens to sit at the top of the list. The distinguishing
 * information lives beside the control, in the row that names the form, which
 * is what `groupText` carries.
 *
 * Returns candidates in trial order, best first. Empty means the named form is
 * not on screen — the caller must treat that as "not present", never fall back
 * to another form's control.
 */
export function resolveFormOpenCandidates(
  obs: Observation,
  formName: string,
  contextNames: readonly string[] = [],
): ObservationElement[] {
  const target = normaliseText(formName);
  if (!target) return [];

  // Page furniture is removed before matching. The visit's own name sits in the
  // breadcrumb and heading of its document list, and it may CONTAIN a form's
  // name: visit "End of Treatment (Week 12)" contains the form "End of
  // Treatment". Left in, every control on the page inherits that text through
  // its group and matches, so a form that does not exist reads as existing and
  // is never created -- live, that was the one form of 28 that went missing.
  //
  // A context name identical to the form's is not removed: there would be
  // nothing left to match on.
  const context = contextNames
    .map(normaliseText)
    .filter((c) => c && c !== target && c.includes(target));
  const groupOf = (e: ObservationElement) => {
    const raw = normaliseText(e.groupText!);
    return context.reduce((t, c) => t.split(c).join(' '), raw);
  };

  const withGroups = enumerateActionable(obs).filter((e) => e.groupText);

  // Names in a real study overlap: "Concomitant Medications" is a substring of
  // "Prior and Concomitant Medications". Group text starts with the name cell,
  // so a prefix match distinguishes them; containment is the weaker fallback.
  const prefix = withGroups.filter((e) => groupOf(e).startsWith(target));
  const pool = prefix.length > 0
    ? prefix
    : withGroups.filter((e) => groupOf(e).includes(target));

  if (pool.length === 0) return [];

  // Lexical hints only order the trial; the caller's read-back adjudicates.
  return rankCandidates(pool, { hint: 'form_open' }).map((r) => r.el);
}

/** Weight for a candidate that names a context the caller already knows about
 *  (a visit from the input file). Deliberately larger than any lexical hint:
 *  "the control that names my parent" is evidence, where a word is a guess. */
const ASCEND_PARENT_NAME_BONUS = 10;

/**
 * Rank the controls that move UP a level, toward the visit list.
 *
 * Two things make this harder than it looks, both observed live:
 *
 * 1. A top-level nav item can be inert. On the supplied mock "Study Plan" is
 *    the active tab, so clicking it does nothing at any depth — it binds green
 *    and never moves. Only the breadcrumb ascends, and its NAME CHANGES per
 *    level ("← Screening", "← Visit Schedule"), so no fixed word finds it.
 * 2. Trial-and-error is destructive here. The `visit_list` hint contains
 *    "list", which matches a palette entry called "Check List"; clicking it
 *    adds a control to the form under construction. So the palette is removed
 *    structurally — as a cluster of sibling controls, not by name — before any
 *    ranking happens.
 *
 * `contextNames` are names the caller already knows (the input file's visits).
 * A breadcrumb out of a form designer names its visit, which is far stronger
 * evidence than any English word, and it is data the agent was given rather
 * than vocabulary it guessed.
 */
export function rankAscendCandidates(
  obs: Observation,
  contextNames: readonly string[] = [],
): ObservationElement[] {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return [];

  // Structural exclusion: the palette is a cluster of sibling controls.
  // Removing it by shape is legitimate; removing it by name would not be.
  //
  // Keep breadcrumb/back controls even when they sit in the largest cluster.
  // On a visit detail screen that cluster is toolbar chrome (Phases / Sites /
  // <- Back / + New Record Sheet); excluding Back left only Modify/Go Live/
  // Remove, which re-entered the builder and never reached the visit list
  // (Hostile E2E v5 Screening "could not open this visit" after Demographics).
  const cluster = largestControlCluster(pool);
  const excluded = new Set((cluster?.members ?? []).map((e) => e.handle));
  const isBreadcrumb = (name: string) => {
    const n = normaliseText(name);
    return matchesHintLoose(n, 'ascend') || n.startsWith('<-') || n.startsWith('←');
  };
  const safe = pool.filter((e) => !excluded.has(e.handle) || isBreadcrumb(e.name));
  if (safe.length === 0) return [];

  const known = contextNames.map(normaliseText).filter(Boolean);

  return rankCandidates(safe, { hint: 'visit_list' })
    .map((r) => {
      let score = r.score;
      const name = normaliseText(r.el.name);
      if (known.some((n) => name.includes(n))) score += ASCEND_PARENT_NAME_BONUS;
      // Breadcrumb / back controls actually move; inert tabs named "Phases"
      // match visit_list lexically and do nothing (env-rosetta toolbar).
      if (matchesHintLoose(name, 'ascend') || name.startsWith('<-') || name.startsWith('←')) {
        score += ASCEND_PARENT_NAME_BONUS;
      } else if (matchesHintExact(name, 'chrome')) {
        score -= ASCEND_PARENT_NAME_BONUS;
      }
      return { el: r.el, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.el);
}

/**
 * Read-back for "am I at the visit list?" — the screen where visits can be
 * created and opened.
 *
 * Recognised by the input file's own visit names appearing as actionable
 * controls, never by a screen title or heading word. Before the first visit
 * exists there are no such names, so the control that pre-flight bound to
 * `visit.create` is accepted as the second witness: it is present on the visit
 * list and nowhere else. Used here as evidence, not as an action.
 *
 * A create-control witness must look like a create action, not like chrome.
 *
 * Live on Zephyr (env-rosetta): visit.create bound to the inert toolbar tab
 * "Phases" (tied with "+ New Phase" on a single hint hit). "Phases" is present
 * on every screen, so treating it as proof of the visit list made
 * atVisitList always true, createVisit clicked a no-op, and no visits appeared.
 */
function looksLikeCreateControl(name: string): boolean {
  const n = normaliseText(name);
  if (!n) return false;
  if (n.includes('+')) return true;
  return /(?:^|\s)(add|new|create)(?:\s|$)/.test(n);
}

/**
 * Visit-list create witness — must look like creating a VISIT/phase/cycle,
 * not a form/page/element. "+ New Record Sheet" / "+ Page" / "+ New Instrument"
 * live on visit detail / designer; treating them as visit.create made
 * atVisitList true on those screens, so navigateToVisit skipped the climb,
 * found no Screening row, and false-gated "could not open this visit"
 * (Hostile E2E rosetta after Demographics).
 */
function looksLikeVisitCreateControl(name: string): boolean {
  if (!looksLikeCreateControl(name)) return false;
  const n = normaliseText(name);
  // Form / document create on the visit detail.
  if (/(?:^|\s)(form|sheet|record|instrument|document|crf|source)(?:\s|$)/.test(n)) {
    return false;
  }
  // Designer page chrome.
  if (/(?:^|\s)(page|element|field|node|brick|tile)(?:\s|$)/.test(n)) {
    return false;
  }
  return true;
}

export function atVisitList(
  obs: Observation,
  visitNames: readonly string[],
  createControlName?: string,
): boolean {
  const actionable = enumerateActionable(obs);

  const wanted = visitNames.map(normaliseText).filter(Boolean);
  if (wanted.length > 0 && actionable.some((e) => wanted.includes(normaliseText(e.name)))) {
    return true;
  }

  const create = createControlName ? normaliseText(createControlName) : '';
  if (!create || !looksLikeVisitCreateControl(createControlName!)) return false;
  return actionable.some((e) => normaliseText(e.name) === create);
}

/**
 * Positive read-back for "am I inside a visit's form list?"
 *
 * Negating atVisitList is not enough on hostile chrome: inert tabs named
 * "Phases" do not move, and a failed open left the run blocked on Screening
 * even after the Phases/create-control fix. A visit detail screen exposes a
 * form-create control ("+ New Record Sheet", "+ New Instrument") that the
 * visit list does not.
 */
export function atVisitDetail(
  obs: Observation,
  visitName?: string,
  knownVisitNames: readonly string[] = [],
): boolean {
  const actionable = enumerateActionable(obs);
  const hasFormCreate = actionable.some((e) => {
    const n = normaliseText(e.name);
    if (!n) return false;
    // Must look like create AND mention a form-ish noun (not visit/phase).
    if (!(n.includes('+') || /(?:^|\s)(add|new|create)(?:\s|$)/.test(n))) return false;
    if (/(?:^|\s)(visit|phase|cycle|timepoint|event)(?:\s|$)/.test(n)) return false;
    return /(?:^|\s)(form|sheet|record|instrument|document|crf|source)(?:\s|$)/.test(n);
  });
  if (!hasFormCreate) return false;
  if (!visitName) return true;

  // Prefer seeing the visit name (heading / breadcrumb / groupText). Hostile
  // a11y trees sometimes omit it while still exposing form-create. Requiring
  // the name then made navigateToVisit treat an already-open detail as "not
  // open", climb via "<- Back", and false-gate re-open.
  const target = normaliseText(visitName);
  if (!target) return true;
  const blob = (e: { name: string; groupText?: string }) =>
    normaliseText(`${e.name} ${e.groupText ?? ''}`);
  if (obs.elements.some((e) => blob(e).includes(target))) return true;

  // Name absent: still accept UNLESS another known visit is clearly indicated
  // (avoids claiming Screening while standing on Baseline's form list).
  const others = knownVisitNames
    .map(normaliseText)
    .filter((n) => n && n !== target);
  if (others.some((o) => obs.elements.some((e) => blob(e).includes(o)))) {
    return false;
  }
  return true;
}

/**
 * Read-back for form.open: is the surface now showing THIS form's designer?
 *
 * Presence of the name alone is not proof — the list screen names every form.
 * The discriminator is that a designer shows one form where a list shows many,
 * so the sibling forms sharing that list must have gone. Names that overlap the
 * target ("Concomitant Medications" inside "Prior and Concomitant Medications")
 * are excluded from the sibling set, since their text cannot be attributed.
 */
export function surfaceShowsForm(
  obs: Observation,
  formName: string,
  siblingNames: readonly string[] = [],
  contextNames: readonly string[] = [],
): boolean {
  const target = normaliseText(formName);
  if (!target) return false;

  const text = obs.elements
    .map((e) => normaliseText(`${e.name} ${e.groupText ?? ''}`))
    .join(' | ');
  if (!text.includes(target)) return false;

  // Names that belong to the page's own furniture rather than to a form row --
  // the visit this designer sits under, whose breadcrumb is on screen either
  // way. A sibling whose name is contained in one of them cannot be told from
  // that furniture by text alone, so its presence proves nothing about which
  // surface this is.
  //
  // Live (2026-09-06): visit "End of Treatment (Week 12)" contains the form
  // name "End of Treatment". Every one of that visit's other six forms was
  // rejected -- the breadcrumb alone looked like a sibling row -- and only
  // "End of Treatment" itself, which is excluded from its own sibling set,
  // could be opened.
  const context = contextNames.map(normaliseText).filter(Boolean);

  const others = siblingNames
    .map(normaliseText)
    .filter((n) => n && n !== target && !n.includes(target) && !target.includes(n))
    .filter((n) => !context.some((c) => c.includes(n)));

  return !others.some((n) => text.includes(n));
}

/**
 * Bind form.exists: read-only existence probe. Look for a form by name in
 * the current view (list, table, etc.). This is a read-only check.
 */
export function bindFormExists(obs: Observation): BindingRecord | null {
  // If we can see text elements or links that could be form names, we can
  // check existence by scanning the observation.
  const hasTextContent = obs.elements.some(
    (e) => e.role === 'link' || e.role === 'button' || e.role === 'row' || e.role === 'cell',
  );
  if (!hasTextContent) return null;

  return makeBinding(
    'form.exists',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    'form with matching name is present in the current view',
    ['read-only observation scan'],
    'structural',
  );
}

// ---------------------------------------------------------------------------
// Field palette: field_palette.open.
// ---------------------------------------------------------------------------

/**
 * Bind field_palette.open.
 *
 * Two shapes exist in the wild: a library behind a control, and a library
 * permanently visible as a strip or sidebar. Distinguish them structurally
 * rather than by name -- when nothing ranks above the baseline but the surface
 * is dense with actionable elements, the library is most likely already
 * showing, and clicking an arbitrary control could navigate away instead.
 */
export function bindFieldPaletteOpen(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'palette' });
  const best = ranked[0];
  const hasLexicalSignal = best.signals.some((sig) => sig.name === 'lexical');

  if (!hasLexicalSignal && pool.length >= 5) {
    return makeBinding(
      'field_palette.open',
      0,
      [{ step: 'wait', handle_kind: 'role-only' }],
      'the element library is visible',
      [
        `${pool.length} actionable elements present and none ranks as a library ` +
        `opener; treating the library as already visible rather than clicking blind`,
      ],
      'tentative',
    );
  }

  return makeBinding(
    'field_palette.open',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the element library becomes visible',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}

// ---------------------------------------------------------------------------
// field.add: the 13 canonical-type bindings.
// ---------------------------------------------------------------------------

/** Map a canonical type to the ARIA roles that realize it. This is the
 *  semantic layer: roles distinguish controls even when names are nearly
 *  identical (single_select vs radio, checkbox vs multi_select). */
export function expectedRolesForType(canonical: CanonicalType): string[] {
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

/**
 * Bind field.add for a canonical type. At rung 0, we look at the palette
 * (library) buttons and try to match by name. Name-only matches are
 * HYPOTHESES flagged for rung 1 probe confirmation.
 *
 * The recipe: click the palette button for the type, then a new control
 * appears on the canvas. The post-condition checks the role of the placed
 * control.
 */
export function bindFieldAdd(obs: Observation, canonicalType: CanonicalType): BindingRecord | null {
  // At rung 0, we do not know which palette button corresponds to this
  // canonical type. We produce a HYPOTHESIS binding: the name-only match
  // is flagged for confirmation by the rung 1 place-and-inspect probe.
  //
  // We look for buttons whose name suggests the canonical type.
  const typeLower = canonicalType.replace(/_/g, ' ');

  // Score, never take-the-first. The palette on the supplied mock is
  // alphabetical, so "Multi-line Textbox" precedes "Single Line Textbox",
  // "Number (Decimal)" precedes "Number (Whole)", and "Date/Time" precedes
  // "Time". Taking candidates[0] handed all three types the decoy while the
  // right control sat unused in the same palette.
  const scored: Array<{ el: ObservationElement; score: number; why: string }> = [];

  for (const el of obs.elements) {
    if (el.role !== 'button') continue;
    const name = el.name.toLowerCase();

    const own = synonymHits(canonicalType, name) + (name.includes(typeLower) ? 1 : 0);
    if (own === 0) continue;

    // A control that answers some OTHER canonical type more distinctively is
    // that type's control, not ours. Subtracting rather than excluding keeps
    // it in the pool: if this reasoning is wrong on an unseen platform, it is
    // still reachable, just last.
    let rival = 0;
    let rivalOf = '';
    for (const other of Object.keys(SYNONYMS) as CanonicalType[]) {
      if (other === canonicalType) continue;
      const hits = synonymHits(other, name);
      if (hits > rival) { rival = hits; rivalOf = other; }
    }

    // An exact name match is the strongest name-evidence there is.
    const exact = name.trim() === typeLower ? 1 : 0;

    scored.push({
      el,
      score: own - rival + exact,
      why: `name~="${el.name}" (${own} match${own === 1 ? '' : 'es'} for ${canonicalType}` +
        (rival > 0 ? `, ${rival} for ${rivalOf}` : '') + ')',
    });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];

  // Nothing in the names separates the top two: say so, so the probe decides
  // instead of a coin toss being reported as a finding.
  const confidence: Candidate['confidence'] =
    runnerUp && runnerUp.score === best.score ? 'tentative' : 'hypothesis';

  const expectedRoles = expectedRolesForType(canonicalType);

  return makeBinding(
    'field.add',
    0,
    [{ step: 'click', evidence_role: 'button', evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    `a new control of role [${expectedRoles.join('|')}] appears on canvas`,
    [
      `role=button, ${best.why}`,
      ...(runnerUp ? [`next best: "${runnerUp.el.name}" (score ${runnerUp.score} vs ${best.score})`] : []),
      `expected roles: ${expectedRoles.join(', ')}`,
    ],
    confidence,
  );
}

/** Loose synonym matching for canonical types. Used ONLY to generate
 *  hypotheses, never conclusions. */
const SYNONYMS: Record<CanonicalType, readonly string[]> = {
  // 'single line' is the positive counterpart to textarea's 'multi-line'.
  // Without it the two tie on a palette offering both, because every word that
  // matches one matches the other. Two words, not the bare 'single', which
  // belongs to single_select.
  text: ['text', 'textbox', 'line', 'single line', 'single-line', 'short'],
  textarea: ['textarea', 'multi-line', 'multiline', 'multi line', 'paragraph', 'long'],
  integer: ['integer', 'whole', 'number'],
  decimal: ['decimal', 'float', 'number'],
  date: ['date'],
  time: ['time'],
  datetime: ['datetime', 'date/time', 'timestamp'],
  boolean: ['boolean', 'toggle', 'yes/no', 'yesno', 'switch'],
  single_select: ['dropdown', 'select', 'single', 'picklist', 'combo'],
  multi_select: ['multi', 'check list', 'checklist', 'multiselect'],
  radio: ['radio'],
  checkbox: ['checkbox', 'check box', 'tick'],
  calculated: ['calculated', 'formula', 'computed'],
};

/** How many of this type's synonyms the name contains. A count rather than a
 *  boolean: "Single Line Textbox" answers `text` on three words where
 *  "Multi-line Textbox" also answers `textarea`, and that difference is what
 *  separates a control from its decoy. */
function synonymHits(canonical: CanonicalType, name: string): number {
  return (SYNONYMS[canonical] ?? []).filter((s) => name.includes(s)).length;
}

function matchesSynonym(canonical: CanonicalType, name: string): boolean {
  return synonymHits(canonical, name) > 0;
}

// ---------------------------------------------------------------------------
// field.set_label, field.set_required, field.set_range, field.set_skip_logic.
// ---------------------------------------------------------------------------

/**
 * Bind field.set_label: find a text input in the options/properties panel
 * that sets the field label. This is usually a textbox with "label" in
 * its accessible name, or the first textbox in an options panel.
 */
export function bindFieldSetLabel(obs: Observation): BindingRecord | null {
  const candidates = findByRole(obs, 'textbox', { contains: 'label' });
  if (candidates.length === 0) {
    // Fall back to the first textbox that might be a label input.
    const textboxes = findByRoleOnly(obs, 'textbox');
    if (textboxes.length > 0) {
      return makeBinding(
        'field.set_label',
        0,
        [{ step: 'set_value', evidence_role: 'textbox', evidence_name: textboxes[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' }],
        'the element label text changes to the provided value',
        [`role=textbox, name="${textboxes[0].el.name}" (first textbox, tentative)`],
        'tentative',
      );
    }
    return null;
  }
  const best = candidates[0];
  return makeBinding(
    'field.set_label',
    0,
    [{ step: 'set_value', evidence_role: 'textbox', evidence_name: best.el.name, handle_kind: 'snapshot-id', value_from: 'ir' }],
    'the element label text changes to the provided value',
    [best.evidence],
    best.confidence,
  );
}

/**
 * Bind field.set_required: find a checkbox/toggle that controls the
 * "required" property of a field.
 */
export function bindFieldSetRequired(obs: Observation): BindingRecord | null {
  const candidates = findByRole(obs, 'checkbox', { contains: 'require' });
  if (candidates.length === 0) {
    // Fall back: any checkbox near an options panel.
    const checkboxes = findByRoleOnly(obs, 'checkbox');
    if (checkboxes.length > 0) {
      return makeBinding(
        'field.set_required',
        0,
        [{ step: 'check', evidence_role: 'checkbox', evidence_name: checkboxes[0].el.name, handle_kind: 'snapshot-id' }],
        'the element shows a required indicator',
        [`role=checkbox, name="${checkboxes[0].el.name}" (tentative)`],
        'tentative',
      );
    }
    return null;
  }
  const best = candidates[0];
  return makeBinding(
    'field.set_required',
    0,
    [{ step: 'check', evidence_role: 'checkbox', evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the element shows a required indicator',
    [best.evidence],
    best.confidence,
  );
}

/**
 * Bind field.set_range: find inputs for min, max, and optionally units.
 */
export function bindFieldSetRange(obs: Observation): BindingRecord | null {
  const minInputs = findByRole(obs, 'textbox', { contains: 'min' })
    .concat(findByRole(obs, 'spinbutton', { contains: 'min' }));
  const maxInputs = findByRole(obs, 'textbox', { contains: 'max' })
    .concat(findByRole(obs, 'spinbutton', { contains: 'max' }));
  const unitInputs = findByRole(obs, 'textbox', { contains: 'unit' });

  if (minInputs.length === 0 && maxInputs.length === 0) return null;

  const recipe: RecipeStep[] = [];
  const evidence: string[] = [];
  if (minInputs.length > 0) {
    recipe.push({ step: 'set_value', evidence_role: minInputs[0].el.role, evidence_name: minInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    evidence.push(minInputs[0].evidence);
  }
  if (maxInputs.length > 0) {
    recipe.push({ step: 'set_value', evidence_role: maxInputs[0].el.role, evidence_name: maxInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    evidence.push(maxInputs[0].evidence);
  }
  if (unitInputs.length > 0) {
    recipe.push({ step: 'set_value', evidence_role: 'textbox', evidence_name: unitInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    evidence.push(unitInputs[0].evidence);
  }

  return makeBinding(
    'field.set_range',
    0,
    recipe,
    'range values (min, max, units) are set on the element',
    evidence,
    minInputs.length > 0 && maxInputs.length > 0 ? 'structural' : 'tentative',
  );
}

/**
 * Bind field.set_skip_logic: find the visibility/conditional control and
 * the trigger/condition inputs via ranking (no English name gates).
 */
export function bindFieldSetSkipLogic(obs: Observation): BindingRecord | null {
  const modePool = enumerateByRoles(obs, ['combobox', 'listbox']);
  const mode = rankCandidates(modePool, { hint: 'visibility' })[0];
  if (!mode) return null;

  const recipe: RecipeStep[] = [
    { step: 'select_option', evidence_role: mode.el.role, evidence_name: mode.el.name, handle_kind: 'snapshot-id', from_list_exposed: true },
  ];
  const evidence = [explainRanking(mode, modePool.length)];

  const when = rankCandidates(modePool, { hint: 'skip_when', demote: ['visibility'] })[0];
  if (when && when.el.handle !== mode.el.handle) {
    recipe.push({ step: 'select_option', evidence_role: when.el.role, evidence_name: when.el.name, handle_kind: 'snapshot-id', from_list_exposed: true });
    evidence.push(explainRanking(when, modePool.length));
  }

  const valuePool = enumerateByRoles(obs, ['textbox', 'searchbox']);
  const value = rankCandidates(valuePool, { hint: 'skip_value' })[0];
  if (value) {
    recipe.push({ step: 'set_value', evidence_role: value.el.role, evidence_name: value.el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    evidence.push(explainRanking(value, valuePool.length));
  }

  return makeBinding(
    'field.set_skip_logic',
    0,
    recipe,
    'conditional visibility is set on the element',
    evidence,
    mode.score > 0 ? 'hypothesis' : 'tentative',
  );
}

/**
 * Bind field.set_formula: locate the formula/expression textbox.
 */
export function bindFieldSetFormula(obs: Observation): BindingRecord | null {
  const pool = enumerateByRoles(obs, ['textbox', 'searchbox']);
  if (pool.length === 0) return null;
  const best = rankCandidates(pool, { hint: 'formula' })[0];
  if (!best) return null;

  return makeBinding(
    'field.set_formula',
    0,
    [{ step: 'set_value', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id', value_from: 'ir' }],
    'the calculated formula/expression is set on the element',
    [explainRanking(best, pool.length)],
    best.score > 0 ? 'hypothesis' : 'tentative',
  );
}


/**
 * The control that appends a coded-value row ("+ Add Value"), not the bulk
 * paste apply button.
 *
 * `contains: 'add'` alone matches "Apply Pasted Values" because "pasted"
 * contains the substring "add". That button REPLACES the list when the paste
 * box is non-empty and is a no-op when empty — either way it is not the
 * row-adding control. Require a word-boundary `add` and exclude paste/apply.
 */
export function findAddCodedValueControl(obs: Observation): ObservationElement | undefined {
  return findByRole(obs, 'button', { contains: 'add' })
    .map((c) => c.el)
    .find((el) => {
      const n = el.name.toLowerCase();
      if (!/\badd\b/.test(n)) return false;
      if (!n.includes('value')) return false;
      if (n.includes('paste') || n.includes('apply')) return false;
      return true;
    });
}

// ---------------------------------------------------------------------------
// field.set_coded_values: at rung 0, find the value editor structure.
// ---------------------------------------------------------------------------

/**
 * Bind field.set_coded_values: find the coded-value editor. At rung 0 we
 * look for a pair of inputs (code + label) or a grid/table with code and
 * label columns. The append-vs-replace mode is determined by the rung 1
 * probe, not here.
 */
export function bindFieldSetCodedValues(obs: Observation): BindingRecord | null {
  const codeInputs = findByRole(obs, 'textbox', { contains: 'code' });
  const labelInputs = findByRole(obs, 'textbox', { contains: 'label' }).filter(
    (c) => !codeInputs.some((code) => code.el.handle === c.el.handle),
  );

  // Also look for an "add value" button (not "Apply Pasted Values").
  const addValueEl = findAddCodedValueControl(obs);
  const addValueBtns = addValueEl
    ? [{ el: addValueEl, evidence: `add value button: ${addValueEl.name}`, confidence: 'structural' as const }]
    : [];

  // Or a paste textarea + apply button.
  const pasteTextareas = obs.elements.filter(
    (e) => e.role === 'textbox' && e.name.toLowerCase().includes('paste'),
  );
  const applyBtns = findByRole(obs, 'button', { contains: 'apply' });

  if (codeInputs.length === 0 && labelInputs.length === 0 && addValueBtns.length === 0 && pasteTextareas.length === 0) {
    return null;
  }

  const recipe: RecipeStep[] = [];
  const evidence: string[] = [];

  if (codeInputs.length > 0 && labelInputs.length > 0) {
    // Two-column editor detected.
    recipe.push({ step: 'set_value', evidence_role: 'textbox', evidence_name: codeInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    recipe.push({ step: 'set_value', evidence_role: 'textbox', evidence_name: labelInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    evidence.push(`code input: ${codeInputs[0].evidence}`);
    evidence.push(`label input: ${labelInputs[0].evidence}`);
  }

  if (addValueBtns.length > 0) {
    recipe.push({ step: 'click', evidence_role: 'button', evidence_name: addValueBtns[0].el.name, handle_kind: 'snapshot-id' });
    evidence.push(`add value button: ${addValueBtns[0].evidence}`);
  }

  if (pasteTextareas.length > 0 && applyBtns.length > 0) {
    // A paste-based bulk entry path also exists. Note it but do not prefer
    // it -- the append/replace probe (rung 1) determines the safe mode.
    evidence.push(`paste textarea detected: ${pasteTextareas[0].name}`);
    evidence.push(`apply button detected: ${applyBtns[0].el.name}`);
  }

  return makeBinding(
    'field.set_coded_values',
    0,
    recipe,
    'coded values are entered as code+label pairs',
    evidence,
    codeInputs.length > 0 && labelInputs.length > 0 ? 'structural' : 'tentative',
  );
}

// ---------------------------------------------------------------------------
// ctx.commit, ctx.is_committed, ctx.discard.
// ---------------------------------------------------------------------------

/**
 * Bind ctx.commit.
 *
 * The single most consequential binding in the contract: if this is wrong,
 * work is never persisted and nothing says so. Every actionable control is
 * therefore a candidate. Ranking picks a TRIAL ORDER; it does not decide.
 * The rung 1 commit probe clicks candidates in that order until one
 * demonstrably clears the working-copy state, because not every button that
 * looks like save actually saves -- and on an unseen platform, the one that
 * does save may not look like it either.
 */
export function bindCtxCommit(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'commit', demote: ['template', 'discard'] });
  const best = ranked[0];

  return makeBinding(
    'ctx.commit',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'persisted indicator appears / working-copy banner disappears',
    [
      explainRanking(best, pool.length),
      'rung 1 commit probe required before this binding is trusted',
    ],
    'hypothesis',
  );
}

/** The full trial order for the commit probe. Exported so ProbeRunner works
 *  down the ranked list instead of testing a name-filtered subset. */
export function rankCommitCandidates(obs: Observation): RankedCandidate[] {
  // Decoys are demoted, not removed: a control that files work away under a
  // reusable name ("Save As Template") ties with the real save control on the
  // word "save" alone, and DOM order then decides -- which on the supplied
  // mock put the decoy first and silently lost an entire form's work.
  return rankCandidates(enumerateActionable(obs), {
    hint: 'commit',
    demote: ['template', 'discard'],
  });
}

/**
 * Bind ctx.is_committed.
 *
 * There is no reliable cross-platform marker for "saved", so this binding does
 * not pretend to know one. It records which elements are plausibly status
 * bearing -- named, non-actionable text regions -- and defers the decision to
 * the rung 1 commit probe, which compares pre- and post-commit observations
 * and identifies which of them actually changes.
 */
export function bindCtxIsCommitted(obs: Observation): BindingRecord | null {
  const statusRoles = ['status', 'alert', 'note', 'banner', 'contentinfo', 'generic', 'paragraph'];
  const structural = enumerateByRoles(obs, statusRoles).filter((e) => e.name.length > 0);
  const ranked = rankCandidates(structural, { hint: 'status' });

  if (ranked.length === 0) {
    return makeBinding(
      'ctx.is_committed',
      0,
      [{ step: 'wait', handle_kind: 'role-only' }],
      'commit status is observable as a change between pre- and post-commit observations',
      ['no status-bearing element found at rung 0 -- the commit probe must decide from the diff alone'],
      'tentative',
    );
  }

  return makeBinding(
    'ctx.is_committed',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    'commit status is observable as a change between pre- and post-commit observations',
    [
      `${ranked.length} status-bearing candidate(s); top = "${ranked[0].el.name}" ` +
      `(${explainRanking(ranked[0], ranked.length)})`,
    ],
    'tentative',
  );
}

/**
 * Bind ctx.discard: abandon the working copy.
 *
 * Ranked, never gated. A mis-ranked discard costs an extra probe; a gated one
 * that finds nothing leaves the agent unable to back out of a bad state.
 */
export function bindCtxDiscard(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'discard' });
  const best = ranked[0];

  return makeBinding(
    'ctx.discard',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the working copy is abandoned and the editor closes',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}

// ---------------------------------------------------------------------------
// Convenience: bind all ops at rung 0.
// ---------------------------------------------------------------------------

export function bindAllRung0(obs: Observation): Partial<Record<ContractOpId, BindingRecord>> {
  const results: Partial<Record<ContractOpId, BindingRecord>> = {};
  const r0 = bindNavToStudyRoot(obs);
  if (r0) results['nav.to_study_root'] = r0;
  const r1 = bindNavToVisitList(obs);
  if (r1) results['nav.to_visit_list'] = r1;
  const r2 = bindVisitCreate(obs);
  if (r2) results['visit.create'] = r2;
  const r3 = bindVisitOpen(obs);
  if (r3) results['visit.open'] = r3;
  const r4 = bindFormCreate(obs);
  if (r4) results['form.create'] = r4;
  const r5 = bindFormOpen(obs);
  if (r5) results['form.open'] = r5;
  const r6 = bindFormExists(obs);
  if (r6) results['form.exists'] = r6;
  const r7 = bindFieldPaletteOpen(obs);
  if (r7) results['field_palette.open'] = r7;
  const r8 = bindFieldSetLabel(obs);
  if (r8) results['field.set_label'] = r8;
  const r9 = bindFieldSetRequired(obs);
  if (r9) results['field.set_required'] = r9;
  const r10 = bindFieldSetRange(obs);
  if (r10) results['field.set_range'] = r10;
  const r11 = bindFieldSetSkipLogic(obs);
  if (r11) results['field.set_skip_logic'] = r11;
  const r11b = bindFieldSetFormula(obs);
  if (r11b) results['field.set_formula'] = r11b;
  const r12 = bindFieldSetCodedValues(obs);
  if (r12) results['field.set_coded_values'] = r12;
  const r13 = bindCtxCommit(obs);
  if (r13) results['ctx.commit'] = r13;
  const r14 = bindCtxIsCommitted(obs);
  if (r14) results['ctx.is_committed'] = r14;
  const r15 = bindCtxDiscard(obs);
  if (r15) results['ctx.discard'] = r15;
  // field.add is per-canonical-type, bound separately.
  return results;
}

// ---------------------------------------------------------------------------
// Binding record factory.
// ---------------------------------------------------------------------------

function makeBinding(
  op: ContractOpId,
  rung: BindingRung,
  recipe: RecipeStep[],
  postCondition: string,
  evidence: string[],
  confidence: Candidate['confidence'],
): BindingRecord {
  return {
    op,
    version: 1,
    recipe,
    post_condition: {
      description: postCondition,
    },
    evidence,
    rung,
    // A binding that is merely a name guess is still "bound" -- there IS a
    // candidate to try. What matters is that the grade survives, so a caller
    // can send an unconfirmed one to the probe instead of acting on it.
    status: 'bound',
    confidence,
  };
}

// ---------------------------------------------------------------------------
// form.list_fields: what is actually in the open form right now.
// ---------------------------------------------------------------------------

/** Roles that realise a data-entry field. Structural, and deliberately drawn
 *  from the same set VERIFY's expectedRoles() uses, so that "what is in this
 *  form" and "does this field match its intent" agree about what a field is. */
const FIELD_ROLES = [
  'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox',
  'radiogroup', 'checkbox', 'switch', 'slider',
] as const;

/**
 * Project the current observation onto the fields present in the open form.
 *
 * Pure and read-only. It does not know which form is open -- the caller
 * guarantees that by navigating there first. Everything with a field role
 * counts, including controls with an EMPTY accessible name: an element that
 * was added but never labelled is structurally present and semantically
 * worthless, and reporting it is how that failure becomes visible instead of
 * invisible.
 */
export function readObservedFields(obs: Observation): ObservedField[] {
  return enumerateByRoles(obs, FIELD_ROLES).map((e) => ({
    label: e.name,
    role: e.role,
    required: e.state.required,
    range: e.state.range,
    options: e.options,
    handle: e.handle,
  }));
}

/**
 * Bind form.list_fields.
 *
 * Unlike the action bindings there is no recipe to click: enumeration is a
 * read of the current observation. The binding exists so the capability report
 * can state honestly whether this platform's fields are observable at all --
 * on a canvas-rendered designer they are not, and reconciliation must then be
 * reported as unavailable rather than silently returning an empty list that
 * looks indistinguishable from an empty form.
 */
export function bindFormListFields(obs: Observation): BindingRecord | null {
  const fields = readObservedFields(obs);
  const named = fields.filter((f) => f.label.length > 0);
  const unnamed = fields.length - named.length;

  return makeBinding(
    'form.list_fields',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    'the controls in the open form are enumerable from the accessibility tree',
    [
      `${fields.length} field-role control(s) observed, ${named.length} with an accessible name`,
      ...(unnamed > 0
        ? [
            `${unnamed} control(s) present but UNNAMED -- structurally there and ` +
            `semantically worthless; these escalate rather than counting as built`,
          ]
        : []),
    ],
    fields.length > 0 ? 'structural' : 'tentative',
  );
}
