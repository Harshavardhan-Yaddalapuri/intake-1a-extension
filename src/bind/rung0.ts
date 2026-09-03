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
  PostCondition,
  RecipeStep,
} from '../shared/contract';
import type { Observation, ObservationElement } from '../perceive/core';

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
 * Bind nav.to_study_root: find a navigation element (link/button) whose
 * accessible name suggests the study root / plan / study home.
 * Name-only matches are hypotheses.
 */
export function bindNavToStudyRoot(obs: Observation): BindingRecord | null {
  // Structural: look for a link/button with role=link or role=button that
  // contains navigation-type words in the name. We use language-agnostic
  // heuristics: look for a nav/heading element with "study" or "plan" in
  // the name, or the first link in a nav region.
  const candidates: Candidate[] = [];

  // Look for buttons/links whose name suggests study plan or home.
  for (const el of obs.elements) {
    if (el.role !== 'button' && el.role !== 'link') continue;
    const name = el.name.toLowerCase();
    if (name.includes('study') || name.includes('plan')) {
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=${el.role}, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  // If no name match, look for a navigation tab/heading at the top.
  if (candidates.length === 0) {
    for (const el of obs.elements) {
      if (el.role === 'link' && el.nameSource !== 'none' && el.nameSource !== 'placeholder') {
        candidates.push({
          el,
          confidence: 'tentative',
          evidence: `role=link, name="${el.name}" (first structural link)`,
        });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('nav.to_study_root', 0, [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `navigation to study root available`, [best.evidence], best.confidence);
}

/**
 * Bind nav.to_visit_list: find a way to reach the visit list. This is
 * usually a link/button with "visit" or "schedule" in the name.
 */
export function bindNavToVisitList(obs: Observation): BindingRecord | null {
  const candidates: Candidate[] = [];

  for (const el of obs.elements) {
    if (el.role !== 'button' && el.role !== 'link') continue;
    const name = el.name.toLowerCase();
    if (name.includes('visit') || name.includes('schedule')) {
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=${el.role}, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('nav.to_visit_list', 0, [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `navigation to visit list available`, [best.evidence], best.confidence);
}

// ---------------------------------------------------------------------------
// Visit ops: visit.create, visit.open.
// ---------------------------------------------------------------------------

/**
 * Bind visit.create: find a button whose name suggests adding/creating a
 * visit. The recipe is: click the add button, then fill the name input,
 * then click save.
 */
export function bindVisitCreate(obs: Observation): BindingRecord | null {
  // Find an "add" button near visit context.
  const addCandidates: Candidate[] = [];
  for (const el of obs.elements) {
    if (el.role !== 'button') continue;
    const name = el.name.toLowerCase();
    if (name.includes('add') && (name.includes('visit') || name.includes('new'))) {
      addCandidates.push({
        el,
        confidence: 'structural',
        evidence: `role=button, name~="${el.name}"`,
      });
    }
    // Broader: "add" or "new" or "+"
    if (name.includes('add') || name === '+') {
      addCandidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=button, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  if (addCandidates.length === 0) return null;

  // Also need a name input and a save button in the resulting form.
  // These are discovered after the add button is clicked; the recipe
  // encodes them as subsequent steps.
  const best = addCandidates[0];
  const recipe: RecipeStep[] = [
    { step: 'click', evidence_role: 'button', evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ];

  // Look for a name input that might appear (or already visible).
  const nameInputs = findByRole(obs, 'textbox', { contains: 'visit' })
    .concat(findByRole(obs, 'textbox', { contains: 'name' }));
  if (nameInputs.length > 0) {
    recipe.push({ step: 'set_value', evidence_role: 'textbox', evidence_name: nameInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
  }

  // Look for a save button.
  const saveButtons = findByRole(obs, 'button', { contains: 'save' });
  if (saveButtons.length > 0) {
    recipe.push({ step: 'click', evidence_role: 'button', evidence_name: saveButtons[0].el.name, handle_kind: 'snapshot-id' });
  }

  return makeBinding(
    'visit.create',
    0,
    recipe,
    'a new visit appears in the visit list after save',
    [best.evidence, ...(nameInputs.length > 0 ? [nameInputs[0].evidence] : []), ...(saveButtons.length > 0 ? [saveButtons[0].evidence] : [])],
    best.confidence,
  );
}

/**
 * Bind visit.open: find a link/button that opens a specific visit. This
 * is usually a link with the visit name in a table/list.
 */
export function bindVisitOpen(obs: Observation): BindingRecord | null {
  // Look for links that could be visit rows.
  const candidates: Candidate[] = [];
  for (const el of obs.elements) {
    if (el.role !== 'link' && el.role !== 'button') continue;
    const name = el.name.toLowerCase();
    if (name.includes('visit') || el.tagName === 'a') {
      candidates.push({
        el,
        confidence: 'tentative',
        evidence: `role=${el.role}, name="${el.name}"`,
      });
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('visit.open', 0, [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `visit detail view appears`, [best.evidence], best.confidence);
}

// ---------------------------------------------------------------------------
// Form ops: form.create, form.open, form.exists.
// ---------------------------------------------------------------------------

/**
 * Bind form.create: find a button to create a new form/source document.
 */
export function bindFormCreate(obs: Observation): BindingRecord | null {
  const addCandidates: Candidate[] = [];
  for (const el of obs.elements) {
    if (el.role !== 'button') continue;
    const name = el.name.toLowerCase();
    if (name.includes('new') && (name.includes('form') || name.includes('document') || name.includes('source'))) {
      addCandidates.push({
        el,
        confidence: 'structural',
        evidence: `role=button, name~="${el.name}"`,
      });
    }
    if (name.includes('add') || name.includes('new') || name === '+') {
      addCandidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=button, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  if (addCandidates.length === 0) return null;
  const best = addCandidates[0];
  const recipe: RecipeStep[] = [
    { step: 'click', evidence_role: 'button', evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ];

  // Name input for the form.
  const nameInputs = findByRole(obs, 'textbox', { contains: 'name' })
    .concat(findByRole(obs, 'textbox', { contains: 'document' }));
  if (nameInputs.length > 0) {
    recipe.push({ step: 'set_value', evidence_role: 'textbox', evidence_name: nameInputs[0].el.name, handle_kind: 'snapshot-id', value_from: 'ir' });
  }

  // Create/save button.
  const createButtons = findByRole(obs, 'button', { contains: 'create' })
    .concat(findByRole(obs, 'button', { contains: 'save' }));
  if (createButtons.length > 0) {
    recipe.push({ step: 'click', evidence_role: 'button', evidence_name: createButtons[0].el.name, handle_kind: 'snapshot-id' });
  }

  return makeBinding(
    'form.create',
    0,
    recipe,
    'a new form appears in the visit document list',
    [best.evidence],
    best.confidence,
  );
}

/**
 * Bind form.open: find a button/link to open a form's builder/editor.
 */
export function bindFormOpen(obs: Observation): BindingRecord | null {
  const candidates: Candidate[] = [];
  for (const el of obs.elements) {
    if (el.role !== 'button' && el.role !== 'link') continue;
    const name = el.name.toLowerCase();
    if (name.includes('edit') || name.includes('open') || name.includes('builder')) {
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=${el.role}, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('form.open', 0, [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `form builder/designer surface appears`, [best.evidence], best.confidence);
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
 * Bind field_palette.open: find a button/region that exposes the control
 * library / element palette.
 */
export function bindFieldPaletteOpen(obs: Observation): BindingRecord | null {
  const candidates: Candidate[] = [];

  // Look for a region/aside/section that might be a palette.
  for (const el of obs.elements) {
    if (el.role !== 'button' && el.role !== 'link') continue;
    const name = el.name.toLowerCase();
    if (name.includes('element') || name.includes('library') || name.includes('palette') || name.includes('control')) {
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=${el.role}, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  // If no explicit palette button, look for a list of buttons that could be
  // library items (buttons with control-type names in a compact list).
  if (candidates.length === 0) {
    const buttons = obs.elements.filter((e) => e.role === 'button');
    // Heuristic: if there are 5+ buttons in a cluster, one group might be
    // a palette. Mark as tentative.
    if (buttons.length >= 5) {
      return makeBinding(
        'field_palette.open',
        0,
        [{ step: 'wait', handle_kind: 'role-only' }],
        'element library is visible as a group of buttons',
        [`${buttons.length} buttons visible (palette may be already open)`],
        'tentative',
      );
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('field_palette.open', 0, [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `element library/palette becomes visible`, [best.evidence], best.confidence);
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
 * Bind ctx.commit: find the real persist/commit button. Name-only matches
 * are hypotheses. The rung 1 commit probe confirms by reading the
 * post-condition (persisted indicator / working-copy banner disappearance).
 */
export function bindCtxCommit(obs: Observation): BindingRecord | null {
  const candidates: Candidate[] = [];

  for (const el of obs.elements) {
    if (el.role !== 'button') continue;
    const name = el.name.toLowerCase();
    if (name.includes('save') || name.includes('commit') || name.includes('persist')) {
      // "Save" is a hypothesis -- "not every save-looking button saves"
      // (criterion 11). The commit probe (rung 1) confirms.
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=button, name~="${el.name}" (name match, hypothesis -- commit probe required)`,
      });
    }
    if (name.includes('activate')) {
      // "Activate" is a stronger candidate in some platforms.
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=button, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('ctx.commit', 0, [
    { step: 'click', evidence_role: 'button', evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `persisted indicator appears / working-copy banner disappears`, [best.evidence], 'hypothesis');
}

/**
 * Bind ctx.is_committed: read-back check. At rung 0, we look for a status
 * indicator (text/banner) that shows committed state. This is a read-only
 * observation.
 */
export function bindCtxIsCommitted(obs: Observation): BindingRecord | null {
  // Look for status indicators in the observation: elements whose name
  // contains "active", "saved", "committed", "draft", "unsaved".
  const indicators = obs.elements.filter((e) => {
    const name = e.name.toLowerCase();
    return name.includes('active') || name.includes('saved') || name.includes('committed') || name.includes('draft') || name.includes('unsaved');
  });

  if (indicators.length === 0) {
    // No observable indicator -- needs human (honest escalation).
    return makeBinding(
      'ctx.is_committed',
      0,
      [{ step: 'wait', handle_kind: 'role-only' }],
      'commit status is observable via a status indicator',
      ['no status indicator found at rung 0 -- needs rung 1 probe or human'],
      'tentative',
    );
  }

  return makeBinding(
    'ctx.is_committed',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    'commit status is observable via a status indicator',
    [`status indicators: ${indicators.map((i) => i.name).join(', ')}`],
    'structural',
  );
}

/**
 * Bind ctx.discard: find a cancel/discard button or a navigation action
 * that abandons the working copy.
 */
export function bindCtxDiscard(obs: Observation): BindingRecord | null {
  const candidates: Candidate[] = [];

  for (const el of obs.elements) {
    if (el.role !== 'button' && el.role !== 'link') continue;
    const name = el.name.toLowerCase();
    if (name.includes('cancel') || name.includes('discard') || name.includes('close') || name.includes('back')) {
      candidates.push({
        el,
        confidence: 'hypothesis',
        evidence: `role=${el.role}, name~="${el.name}" (name match, hypothesis)`,
      });
    }
  }

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return makeBinding('ctx.discard', 0, [
    { step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' },
  ], `working copy is abandoned and the builder closes`, [best.evidence], 'hypothesis');
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