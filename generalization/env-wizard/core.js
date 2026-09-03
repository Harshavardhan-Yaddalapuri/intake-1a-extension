'use strict';

// ============================================================
// FormCraft Studio -- env-wizard (core logic + state)
//
// Wizard-style form builder: one element/step at a time,
// Next/Back navigation, element library as modal icon grid.
// Commit lives behind a hamburger menu.
//
// Vocabulary (invented, distinct from mock surface.ts and env-rosetta):
//   multi_select  -> "Tick Many"          (trap: sounds like checkbox)
//   checkbox      -> "Confirm Box"        (trap: sounds like boolean)
//   single_select -> "Pick One"           (trap: sounds like radio)
//   radio         -> "Orbit Set"          (trap: obscure)
//   text          -> "Brief Answer"      (distinct: "Free String" in rosetta)
//   textarea      -> "Expanded Answer"    (distinct: "Long String")
//   integer       -> "Round Figure"      (distinct: "Whole Number")
//   decimal       -> "Precise Figure"     (distinct: "Fractional Number")
//   date          -> "Day Marker"         (distinct: "Calendar Day")
//   time          -> "Hour Marker"        (distinct: "Clock Time")
//   datetime      -> "Moment Marker"      (distinct: "Stamp")
//   boolean       -> "Truth Switch"      (distinct: "Binary Flip")
//   calculated    -> "Auto Expression"   (distinct: "Derived Value")
//
// Save -> "Commit"  (in hamburger menu)
// Activate -> "Publish"
// Add Visit -> "Add Stop"
// Add Source Document -> "Add Question Set"
// Study Plan -> "Study Route"
// ============================================================

var SPEC_VERSION = 'formcraft/1.0.0';
var PLATFORM_ID = 'env-wizard';
var PLATFORM_LABEL = 'FormCraft Studio';

var ELEMENT_TYPES = [
  { canonical: 'calculated',    label: 'Auto Expression' },
  { canonical: 'multi_select',  label: 'Tick Many' },
  { canonical: 'checkbox',      label: 'Confirm Box' },
  { canonical: 'date',          label: 'Day Marker' },
  { canonical: 'datetime',      label: 'Moment Marker' },
  { canonical: 'single_select', label: 'Pick One' },
  { canonical: 'textarea',      label: 'Expanded Answer' },
  { canonical: 'decimal',       label: 'Precise Figure' },
  { canonical: 'integer',       label: 'Round Figure' },
  { canonical: 'radio',         label: 'Orbit Set' },
  { canonical: 'text',          label: 'Brief Answer' },
  { canonical: 'time',          label: 'Hour Marker' },
  { canonical: 'boolean',       label: 'Truth Switch' },
];

// Icon mappings for the modal grid tiles.
// calculated, time, datetime are icon-ONLY -- no accessible name, no aria-label.
var TYPE_ICONS = {
  calculated:   '\u03A3',   // Sigma
  multi_select: '\u2713\u2713',
  checkbox:     '\u2610',
  date:         '\u229E',
  datetime:     '\u25C9',
  single_select:'\u25BE',
  textarea:     '\u2630',
  decimal:      '\u2206',
  integer:      '\u2114',
  radio:        '\u25CE',
  text:         'T',
  time:         '\u231B',
  boolean:      '\u21C5',
};

// Types where the tile in the modal grid is icon-only (accessibility hazard)
var ICON_ONLY_TYPES = { calculated: true, time: true, datetime: true };

var FIELD_TYPE_DEFS = {
  text:          { hasOptions: false, hasRange: false, hasFormula: false },
  textarea:      { hasOptions: false, hasRange: false, hasFormula: false },
  integer:       { hasOptions: false, hasRange: true,  hasFormula: false },
  decimal:       { hasOptions: false, hasRange: true,  hasFormula: false },
  date:          { hasOptions: false, hasRange: false, hasFormula: false },
  time:          { hasOptions: false, hasRange: false, hasFormula: false },
  datetime:      { hasOptions: false, hasRange: false, hasFormula: false },
  boolean:       { hasOptions: false, hasRange: false, hasFormula: false },
  single_select: { hasOptions: true,  hasRange: false, hasFormula: false },
  multi_select:  { hasOptions: true,  hasRange: false, hasFormula: false },
  radio:         { hasOptions: true,  hasRange: false, hasFormula: false },
  checkbox:      { hasOptions: false, hasRange: false, hasFormula: false },
  calculated:    { hasOptions: false, hasRange: false, hasFormula: true  },
};

function typeLabel(c) {
  var f = ELEMENT_TYPES.find(function(t) { return t.canonical === c; });
  return f ? f.label : c;
}

var seq = 0;
function nextId(p) { return p + (++seq); }
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

var state = {
  study: { name: 'ABC-101', visits: [] },
  ui: {
    route: { kind: 'plan' },
    visitFormOpen: false,
    visitDraft: { name: '', windowStart: '', windowEnd: '' },
    formFormOpen: false,
    formDraft: { name: '', repeating: false },
    hamburgerOpen: false,
    builder: {
      working: null,
      dirty: false,
      selectedPageId: '',
      selectedElementId: null,
      libraryOpen: false,       // element grid modal visible
      libraryFilter: '',
      wizardStep: 0,            // current step index within selected element
      pasteText: '',
      previewOpen: false,
      notice: null,
    },
  },
};

var listeners = [];
function subscribe(fn) { listeners.push(fn); }
function commit(next) { state = next; listeners.forEach(function(f) { f(); }); }
function patchUi(patch) { commit(Object.assign({}, state, { ui: Object.assign({}, state.ui, patch) })); }
function patchBuilder(patch) { patchUi({ builder: Object.assign({}, state.ui.builder, { notice: null }, patch) }); }
function emptyBuilder() {
  return { working: null, dirty: false, selectedPageId: '', selectedElementId: null, libraryOpen: false, libraryFilter: '', wizardStep: 0, pasteText: '', previewOpen: false, notice: null };
}

function navigate(route) {
  commit(Object.assign({}, state, {
    ui: {
      route: route,
      visitFormOpen: false,
      visitDraft: { name: '', windowStart: '', windowEnd: '' },
      formFormOpen: false,
      formDraft: { name: '', repeating: false },
      hamburgerOpen: false,
      builder: emptyBuilder(),
    },
  }));
}

// ---- Hamburger menu ----
function toggleHamburger() { patchUi({ hamburgerOpen: !state.ui.hamburgerOpen }); }
function closeHamburger() { patchUi({ hamburgerOpen: false }); }

// ---- Visit (Stop) management ----
function openVisitForm() { patchUi({ visitFormOpen: true, visitDraft: { name: '', windowStart: '', windowEnd: '' } }); }
function cancelVisitForm() { patchUi({ visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' } }); }
function setVisitDraft(p) { patchUi({ visitDraft: Object.assign({}, state.ui.visitDraft, p) }); }
function saveVisit() {
  var d = state.ui.visitDraft;
  if (!d.name.trim()) return;
  var v = { id: nextId('v'), name: d.name.trim(), windowStart: d.windowStart, windowEnd: d.windowEnd, forms: [] };
  commit(Object.assign({}, state, {
    study: Object.assign({}, state.study, { visits: state.study.visits.concat([v]) }),
    ui: Object.assign({}, state.ui, { visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' } }),
  }));
}

// ---- Form (Question Set) management ----
function openFormForm() { patchUi({ formFormOpen: true, formDraft: { name: '', repeating: false } }); }
function cancelFormForm() { patchUi({ formFormOpen: false, formDraft: { name: '', repeating: false } }); }
function setFormDraft(p) { patchUi({ formDraft: Object.assign({}, state.ui.formDraft, p) }); }
function createForm() {
  if (state.ui.route.kind !== 'visit') return;
  var fd = state.ui.formDraft;
  if (!fd.name.trim()) return;
  var f = { id: nextId('f'), name: fd.name.trim(), repeating: fd.repeating, status: 'draft', version: 1, pages: [{ id: nextId('pg'), name: 'Page 1', elements: [] }] };
  commit(Object.assign({}, state, {
    study: Object.assign({}, state.study, {
      visits: state.study.visits.map(function(v) {
        return v.id === state.ui.route.visitId ? Object.assign({}, v, { forms: v.forms.concat([f]) }) : v;
      }),
    }),
    ui: Object.assign({}, state.ui, { formFormOpen: false, formDraft: { name: '', repeating: false } }),
  }));
}

function deleteForm(vid, fid) {
  var v = state.study.visits.find(function(x) { return x.id === vid; });
  var f = v && v.forms.find(function(x) { return x.id === fid; });
  if (!f) return;
  if (f.status === 'active') { patchBuilder({ notice: 'Published question sets cannot be removed. Revert to draft first.' }); return; }
  commit(Object.assign({}, state, {
    study: Object.assign({}, state.study, {
      visits: state.study.visits.map(function(v) {
        return v.id === vid ? Object.assign({}, v, { forms: v.forms.filter(function(x) { return x.id !== fid; }) }) : v;
      }),
    }),
  }));
}

function activateForm(vid, fid) {
  commit(Object.assign({}, state, {
    study: Object.assign({}, state.study, {
      visits: state.study.visits.map(function(v) {
        return v.id !== vid ? v : Object.assign({}, v, {
          forms: v.forms.map(function(f) {
            return f.id === fid ? Object.assign({}, f, { status: 'active' }) : f;
          }),
        });
      }),
    }),
  }));
}

function createNewVersion(vid, fid) {
  commit(Object.assign({}, state, {
    study: Object.assign({}, state.study, {
      visits: state.study.visits.map(function(v) {
        return v.id !== vid ? v : Object.assign({}, v, {
          forms: v.forms.map(function(f) {
            return (f.id === fid && f.status === 'active') ? Object.assign({}, f, { status: 'draft', version: f.version + 1 }) : f;
          }),
        });
      }),
    }),
  }));
}

// ---- Builder ----
function openBuilder(vid, fid) {
  var v = state.study.visits.find(function(x) { return x.id === vid; });
  var f = v && v.forms.find(function(x) { return x.id === fid; });
  if (!f || f.status !== 'draft') return;
  var w = deepCopy(f);
  commit(Object.assign({}, state, {
    ui: Object.assign({}, state.ui, {
      route: { kind: 'builder', visitId: vid, formId: fid },
      visitFormOpen: false,
      visitDraft: { name: '', windowStart: '', windowEnd: '' },
      formFormOpen: false,
      formDraft: { name: '', repeating: false },
      hamburgerOpen: false,
      builder: Object.assign({}, emptyBuilder(), { working: w, selectedPageId: w.pages[0] ? w.pages[0].id : '' }),
    }),
  }));
}

// Commit (Save) -- lives in hamburger menu
function commitWorking() {
  if (state.ui.route.kind !== 'builder' || !state.ui.builder.working) return;
  var s = deepCopy(state.ui.builder.working);
  commit(Object.assign({}, state, {
    study: Object.assign({}, state.study, {
      visits: state.study.visits.map(function(v) {
        return v.id !== state.ui.route.visitId ? v : Object.assign({}, v, {
          forms: v.forms.map(function(f) { return f.id === s.id ? s : f; }),
        });
      }),
    }),
    ui: Object.assign({}, state.ui, { hamburgerOpen: false, builder: Object.assign({}, state.ui.builder, { dirty: false, notice: 'Committed.' }) }),
  }));
}

function publishWorking() {
  if (state.ui.route.kind !== 'builder' || !state.ui.builder.working) return;
  if (state.ui.builder.dirty) { patchBuilder({ notice: 'Commit the question set before publishing.' }); return; }
  activateForm(state.ui.route.visitId, state.ui.route.formId);
  patchBuilder({ working: Object.assign({}, state.ui.builder.working, { status: 'active' }), notice: 'Question set is now published.' });
}

// ---- Wizard step model ----
// Each "step" in the wizard shows ONE thing:
//   step 0: element list overview (all elements on the page)
//   step 1..N: per-element configuration (one element at a time)
// The wizardStep is an index; when an element is selected, step = index+1 of that element.
// For editing, we present one field at a time within the selected element.

function wizardSteps() {
  var page = selectedPage();
  if (!page) return ['overview'];
  var steps = ['overview'];
  page.elements.forEach(function(e) {
    steps.push({ elementId: e.id, field: 'label' });
    steps.push({ elementId: e.id, field: 'type' });
    steps.push({ elementId: e.id, field: 'required' });
    var def = FIELD_TYPE_DEFS[e.type];
    if (def.hasOptions) steps.push({ elementId: e.id, field: 'options' });
    if (def.hasRange) steps.push({ elementId: e.id, field: 'range' });
    if (def.hasFormula) steps.push({ elementId: e.id, field: 'formula' });
    steps.push({ elementId: e.id, field: 'visibility' });
  });
  return steps;
}

function wizardStepInfo() {
  var steps = wizardSteps();
  var idx = state.ui.builder.wizardStep;
  if (idx < 0) idx = 0;
  if (idx >= steps.length) idx = steps.length - 1;
  return { index: idx, total: steps.length, current: steps[idx] };
}

function wizardNext() {
  var info = wizardStepInfo();
  if (info.index < info.total - 1) patchBuilder({ wizardStep: info.index + 1 });
}
function wizardBack() {
  var info = wizardStepInfo();
  if (info.index > 0) patchBuilder({ wizardStep: info.index - 1 });
}

// ---- Element library modal ----
function openLibrary() { patchBuilder({ libraryOpen: true }); }
function closeLibrary() { patchBuilder({ libraryOpen: false }); }
function setLibraryFilter(f) { patchBuilder({ libraryFilter: f }); }

// ---- Page management ----
function selectPage(id) { patchBuilder({ selectedPageId: id, selectedElementId: null, wizardStep: 0 }); }
function addPage() {
  var b = state.ui.builder; if (!b.working) return;
  var p = { id: nextId('pg'), name: 'Page ' + (b.working.pages.length + 1), elements: [] };
  patchBuilder({ working: Object.assign({}, b.working, { pages: b.working.pages.concat([p]) }), selectedPageId: p.id, selectedElementId: null, wizardStep: 0, dirty: true });
}

// ---- Element management ----
function addElement(type) {
  var b = state.ui.builder; if (!b.working) return;
  var e = {
    id: nextId('el'), label: typeLabel(type), type: type,
    required: false, hidden: false, placeholder: '',
    min: '', max: '', units: '', decimalPlaces: '', formula: '',
    allowPast: true, allowFuture: true, values: [],
    visibility: { mode: 'always' },
  };
  // After adding, find the step index for this element's label step
  var newPage = b.working.pages.map(function(p) {
    return p.id === b.selectedPageId ? Object.assign({}, p, { elements: p.elements.concat([e]) }) : p;
  });
  var working = Object.assign({}, b.working, { pages: newPage });
  var steps = ['overview'];
  var targetStep = 0;
  var page = working.pages.find(function(p) { return p.id === b.selectedPageId; });
  if (page) {
    page.elements.forEach(function(el2) {
      steps.push({ elementId: el2.id, field: 'label' });
      if (el2.id === e.id) targetStep = steps.length - 1;
      steps.push({ elementId: el2.id, field: 'type' });
      steps.push({ elementId: el2.id, field: 'required' });
      var def = FIELD_TYPE_DEFS[el2.type];
      if (def.hasOptions) steps.push({ elementId: el2.id, field: 'options' });
      if (def.hasRange) steps.push({ elementId: el2.id, field: 'range' });
      if (def.hasFormula) steps.push({ elementId: el2.id, field: 'formula' });
      steps.push({ elementId: el2.id, field: 'visibility' });
    });
  }
  patchBuilder({ working: working, selectedElementId: e.id, wizardStep: targetStep, libraryOpen: false, dirty: true });
}

function selectElement(id) {
  // Jump wizard to that element's label step
  var b = state.ui.builder; if (!b.working) return;
  var steps = wizardSteps();
  var targetStep = 0;
  for (var i = 0; i < steps.length; i++) {
    if (typeof steps[i] === 'object' && steps[i].elementId === id && steps[i].field === 'label') {
      targetStep = i; break;
    }
  }
  patchBuilder({ selectedElementId: id, wizardStep: targetStep });
}

function deleteSelectedElement() {
  var b = state.ui.builder; if (!b.working || !b.selectedElementId) return;
  patchBuilder({
    working: Object.assign({}, b.working, {
      pages: b.working.pages.map(function(p) {
        return Object.assign({}, p, { elements: p.elements.filter(function(e) { return e.id !== b.selectedElementId; }) });
      }),
    }),
    selectedElementId: null, wizardStep: 0, dirty: true,
  });
}

function selectedElement() {
  var b = state.ui.builder; if (!b.working || !b.selectedElementId) return undefined;
  for (var i = 0; i < b.working.pages.length; i++) {
    var f = b.working.pages[i].elements.find(function(e) { return e.id === b.selectedElementId; });
    if (f) return f;
  }
  return undefined;
}

function updateSelected(fn) {
  var b = state.ui.builder; if (!b.working || !b.selectedElementId) return;
  patchBuilder({
    working: Object.assign({}, b.working, {
      pages: b.working.pages.map(function(p) {
        return Object.assign({}, p, {
          elements: p.elements.map(function(e) { return e.id === b.selectedElementId ? fn(e) : e; }),
        });
      }),
    }),
    dirty: true,
  });
}

function patchSelected(p) { updateSelected(function(e) { return Object.assign({}, e, p); }); }

// Type change clears range/options/formula as appropriate
function setSelectedType(type) {
  var d = FIELD_TYPE_DEFS[type];
  updateSelected(function(e) {
    return Object.assign({}, e, {
      type: type,
      values: d.hasOptions ? e.values : [],
      min: d.hasRange ? e.min : '',
      max: d.hasRange ? e.max : '',
      units: d.hasRange ? e.units : '',
      decimalPlaces: type === 'decimal' ? e.decimalPlaces : '',
      formula: d.hasFormula ? e.formula : '',
    });
  });
}

// ---- Options (coded values) ----
function addValue() { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.concat([{ id: nextId('val'), code: '', label: '' }]) }); }); }
function setValueCode(i, c) { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.map(function(v, j) { return j === i ? Object.assign({}, v, { code: c }) : v; }) }); }); }
function setValueLabel(i, l) { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.map(function(v, j) { return j === i ? Object.assign({}, v, { label: l }) : v; }) }); }); }
function removeValue(i) { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.filter(function(_, j) { return j !== i; }) }); }); }
function setPasteText(t) { patchBuilder({ pasteText: t }); }

function applyPasteValues() {
  var lines = state.ui.builder.pasteText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 0) return;
  var vals = lines.map(function(line) {
    var eq = line.indexOf('=');
    var c = eq === -1 ? line : line.slice(0, eq).trim();
    var l = eq === -1 ? line : line.slice(eq + 1).trim();
    return { id: nextId('val'), code: c, label: l };
  });
  updateSelected(function(e) { return Object.assign({}, e, { values: vals }); });
  patchBuilder({ pasteText: '' });
}

// ---- Visibility / skip logic ----
function setVisibilityMode(m) {
  updateSelected(function(e) {
    return Object.assign({}, e, { visibility: m === 'always' ? { mode: 'always' } : { mode: 'when', whenElementId: '', equalsValue: '' } });
  });
}
function setVisibilityWhen(id) {
  updateSelected(function(e) { return e.visibility.mode === 'when' ? Object.assign({}, e, { visibility: Object.assign({}, e.visibility, { whenElementId: id }) }) : e; });
}
function setVisibilityValue(v) {
  updateSelected(function(e) { return e.visibility.mode === 'when' ? Object.assign({}, e, { visibility: Object.assign({}, e.visibility, { equalsValue: v }) }) : e; });
}

// ---- Helpers ----
function currentVisit() {
  if (state.ui.route.kind === 'plan') return undefined;
  return state.study.visits.find(function(v) { return v.id === state.ui.route.visitId; });
}
function selectedPage() {
  var b = state.ui.builder;
  return b.working ? b.working.pages.find(function(p) { return p.id === b.selectedPageId; }) : undefined;
}

function resetState() {
  seq = 0;
  commit({
    study: { name: state.study.name, visits: [] },
    ui: {
      route: { kind: 'plan' },
      visitFormOpen: false,
      visitDraft: { name: '', windowStart: '', windowEnd: '' },
      formFormOpen: false,
      formDraft: { name: '', repeating: false },
      hamburgerOpen: false,
      builder: emptyBuilder(),
    },
  });
}

// ---- Preview ----
function openPreview() { patchBuilder({ previewOpen: true }); }
function closePreview() { patchBuilder({ previewOpen: false }); }

// ---- Ground-truth export (test tooling, NOT for agent use) ----
function readField(el, form) {
  var sl = null;
  var v = el.visibility;
  if (v.mode === 'when' && v.whenElementId) {
    var w = form.pages.flatMap(function(p) { return p.elements; }).find(function(e) { return e.id === v.whenElementId; });
    if (w) sl = { whenFieldLabel: w.label, equalsValue: v.equalsValue };
  }
  return {
    label: el.label,
    type: el.type,
    required: el.required,
    options: el.values.map(function(v) { return { code: v.code, label: v.label }; }),
    min: el.min,
    max: el.max,
    units: el.units,
    formula: el.formula,
    skipLogic: sl,
  };
}

window.__groundTruth = function() {
  return JSON.parse(JSON.stringify({
    platform: PLATFORM_ID,
    specVersion: SPEC_VERSION,
    study: {
      name: state.study.name,
      visits: state.study.visits.map(function(v) {
        return {
          name: v.name,
          windowStart: v.windowStart,
          windowEnd: v.windowEnd,
          forms: v.forms.map(function(f) {
            return {
              name: f.name,
              repeating: f.repeating,
              status: f.status,
              fields: f.pages.flatMap(function(p) {
                return p.elements.map(function(e) { return readField(e, f); });
              }),
            };
          }),
        };
      }),
    },
  }));
};

window.__resetState = function() { resetState(); };
window.__mockPlatform = PLATFORM_ID;

var p = new URLSearchParams(window.location.search);
if (p.get('reset') === '1') resetState();