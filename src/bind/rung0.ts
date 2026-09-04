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
  rankCandidates,
  explainRanking,
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
  const candidates: Candidate[] = [];
  const typeLower = canonicalType.replace(/_/g, ' ');

  for (const el of obs.elements) {
    if (el.role !== 'button') continue;
    const name = el.name.toLowerCase();
    // Loose name matching: the button name might contain the type or a
    // synonym. This is a HYPOTHESIS, not a conclusion.
    if (name.includes(typeLower) || matchesSynonym(canonicalType, name)) {
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=button, name~="${el.name}" (name match for ${canonicalType}, hypothesis)`,
      });
    }
  }

  if (candidates.length === 0) return null;

  // If multiple candidates, pick the first. The rung 1 probe will confirm
  // by inspecting the actual placed control.
  const best = candidates[0];
  const expectedRoles = expectedRolesForType(canonicalType);

  return makeBinding(
    'field.add',
    0,
    [{ step: 'click', evidence_role: 'button', evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    `a new control of role [${expectedRoles.join('|')}] appears on canvas`,
    [best.evidence, `expected roles: ${expectedRoles.join(', ')}`],
    'hypothesis',
  );
}

/** Loose synonym matching for canonical types. Used ONLY to generate
 *  hypotheses, never conclusions. */
function matchesSynonym(canonical: CanonicalType, name: string): boolean {
  const synonyms: Record<CanonicalType, string[]> = {
    text: ['text', 'textbox', 'line'],
    textarea: ['textarea', 'multi-line', 'multiline', 'paragraph'],
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
  const syns = synonyms[canonical] ?? [];
  return syns.some((s) => name.includes(s));
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
 * the trigger/condition inputs.
 */
export function bindFieldSetSkipLogic(obs: Observation): BindingRecord | null {
  const visCandidates = findByRole(obs, 'combobox', { contains: 'visib' })
    .concat(findByRole(obs, 'listbox', { contains: 'visib' }))
    .concat(findByRole(obs, 'combobox', { contains: 'conditional' }))
    .concat(findByRole(obs, 'combobox', { contains: 'when' }));

  if (visCandidates.length === 0) return null;

  const recipe: RecipeStep[] = [
    { step: 'select_option', evidence_role: visCandidates[0].el.role, evidence_name: visCandidates[0].el.name, handle_kind: 'snapshot-id', from_list_exposed: true },
  ];
  const evidence = [visCandidates[0].evidence];

  // Also look for a trigger field selector and a value input.
  const whenSelects = findByRole(obs, 'combobox', { contains: 'when' })
    .concat(findByRole(obs, 'listbox', { contains: 'when' }));
  const valueInputs = findByRole(obs, 'textbox', { contains: 'equal' })
    .concat(findByRole(obs, 'textbox', { contains: 'value' }));

  if (whenSelects.length > 0) {
    recipe.push({ step: 'select_option', evidence_role: whenSelects[0].el.role, evidence_name: whenSelects[0].el.name, handle_kind: 'snapshot-id', from_list_exposed: true });
    evidence.push(whenSelects[0].evidence);
  }
  if (valueInputs.length > 0) {
    recipe.push({ step: 'set_value', evidence_role: 'textbox', evidence_name: valueInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
    evidence.push(valueInputs[0].evidence);
  }

  return makeBinding(
    'field.set_skip_logic',
    0,
    recipe,
    'conditional visibility is set on the element',
    evidence,
    visCandidates[0].confidence,
  );
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

  // Also look for an "add value" button.
  const addValueBtns = findByRole(obs, 'button', { contains: 'add' }).filter(
    (b) => b.el.name.toLowerCase().includes('value'),
  );
  void addValueBtns;

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

  const ranked = rankCandidates(pool, { hint: 'commit' });
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
  return rankCandidates(enumerateActionable(obs), { hint: 'commit' });
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
    status: confidence === 'hypothesis' ? 'bound' : 'bound', // hypotheses are still "bound" but flagged in evidence
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
