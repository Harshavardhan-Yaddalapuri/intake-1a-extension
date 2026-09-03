'use strict';

// ============================================================
// Nexus Form Engine -- env-swapped-controls (core logic + state)
//
// SAME structure as the given mock family but with INVERTED traps
// and a COMPLETELY different vocabulary from both the given mock
// and env-rosetta.
//
// Vocabulary swap table (invented words, adversarial):
//   calculated    -> "Logic Expr"          (formula field)
//   multi_select  -> "Multi Mark Grid"     (sounds like checkbox grid)
//   checkbox      -> "Flag Toggle Grid"    (sounds like multi_select grid)
//   single_select -> "Orbit List"         (sounds like radio)
//   radio         -> "Beam Pick"          (sounds like dropdown)
//   text          -> "Glyph Line"
//   textarea      -> "Glyph Block"
//   integer       -> "Count Value"
//   decimal       -> "Measure Value"
//   date          -> "Solar Mark"
//   time          -> "Temporal Mark"
//   datetime      -> "Chrono Mark"
//   boolean       -> "Polarity Switch"
//
// Save -> "Lock"        |  Save As Template -> "Stash"
// Activate -> "Deploy"  |  Add Visit -> "New Cycle"
// Add Form -> "New Instrument"   |  Elements -> "Nodes"
// Study Plan -> "Trial Roadmap"  |  Pages -> "Sections"
//
// KEY TRAPS (inverted from given mock):
//   1. Library lists radio ("Beam Pick") where you expect dropdown (single_select)
//      and single_select ("Orbit List") where you expect radio.
//   2. checkbox ("Flag Toggle Grid") and multi_select ("Multi Mark Grid")
//      adjacency is FLIPPED in the library order.
//   3. Type-change clears range in BOTH directions:
//      integer->decimal AND decimal->integer BOTH clear range
//      (the given mock only clears when going from range to non-range).
//   4. Bulk paste APPENDS to existing values instead of replacing.
// ============================================================

var SPEC_VERSION = 'nexus/1.0.0';
var PLATFORM_ID = 'env-swapped-controls';
var PLATFORM_LABEL = 'Nexus Form Engine';

// ELEMENT_TYPES -- order is adversarial:
// radio appears where you expect single_select (dropdown-like),
// checkbox and multi_select adjacency is flipped.
var ELEMENT_TYPES = [
  { canonical: 'calculated',    label: 'Logic Expr' },
  { canonical: 'radio',         label: 'Beam Pick' },        // TRAP: sounds like dropdown
  { canonical: 'checkbox',      label: 'Flag Toggle Grid' },  // TRAP: flipped adjacency
  { canonical: 'multi_select',  label: 'Multi Mark Grid' },   // TRAP: flipped adjacency
  { canonical: 'single_select', label: 'Orbit List' },       // TRAP: sounds like radio
  { canonical: 'date',          label: 'Solar Mark' },
  { canonical: 'datetime',      label: 'Chrono Mark' },
  { canonical: 'textarea',      label: 'Glyph Block' },
  { canonical: 'decimal',       label: 'Measure Value' },
  { canonical: 'integer',       label: 'Count Value' },
  { canonical: 'text',          label: 'Glyph Line' },
  { canonical: 'time',          label: 'Temporal Mark' },
  { canonical: 'boolean',       label: 'Polarity Switch' },
];

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
  study: { name: 'NEX-202', visits: [] },
  ui: {
    route: { kind: 'roadmap' },
    visitFormOpen: false,
    visitDraft: { name: '', windowStart: '', windowEnd: '' },
    formFormOpen: false,
    formDraft: { name: '', repeating: false },
    builder: { working: null, dirty: false, selectedPageId: '', selectedElementId: null, libraryFilter: '', pasteText: '', previewOpen: false, notice: null },
  },
};

var listeners = [];
function subscribe(fn) { listeners.push(fn); }
function commit(next) { state = next; listeners.forEach(function(f) { f(); }); }
function patchUi(patch) { commit(Object.assign({}, state, { ui: Object.assign({}, state.ui, patch) })); }
function patchBuilder(patch) { patchUi({ builder: Object.assign({}, state.ui.builder, { notice: null }, patch) }); }
function emptyBuilder() { return { working: null, dirty: false, selectedPageId: '', selectedElementId: null, libraryFilter: '', pasteText: '', previewOpen: false, notice: null }; }

function navigate(route) {
  commit(Object.assign({}, state, { ui: { route: route, visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' }, formFormOpen: false, formDraft: { name: '', repeating: false }, builder: emptyBuilder() } }));
}

// --- Visit (Cycle) management ---
function openVisitForm() { patchUi({ visitFormOpen: true, visitDraft: { name: '', windowStart: '', windowEnd: '' } }); }
function cancelVisitForm() { patchUi({ visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' } }); }
function setVisitDraft(p) { patchUi({ visitDraft: Object.assign({}, state.ui.visitDraft, p) }); }
function saveVisit() {
  var d = state.ui.visitDraft;
  if (!d.name.trim()) return;
  var v = { id: nextId('v'), name: d.name.trim(), windowStart: d.windowStart, windowEnd: d.windowEnd, forms: [] };
  commit(Object.assign({}, state, { study: Object.assign({}, state.study, { visits: state.study.visits.concat([v]) }), ui: Object.assign({}, state.ui, { visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' } }) }));
}

// --- Form (Instrument) management ---
function openFormForm() { patchUi({ formFormOpen: true, formDraft: { name: '', repeating: false } }); }
function cancelFormForm() { patchUi({ formFormOpen: false, formDraft: { name: '', repeating: false } }); }
function setFormDraft(p) { patchUi({ formDraft: Object.assign({}, state.ui.formDraft, p) }); }
function createForm() {
  if (state.ui.route.kind !== 'visit') return;
  var fd = state.ui.formDraft;
  if (!fd.name.trim()) return;
  var f = { id: nextId('f'), name: fd.name.trim(), repeating: fd.repeating, status: 'draft', version: 1, pages: [{ id: nextId('pg'), name: 'Section 1', elements: [] }] };
  commit(Object.assign({}, state, { study: Object.assign({}, state.study, { visits: state.study.visits.map(function(v) { return v.id === state.ui.route.visitId ? Object.assign({}, v, { forms: v.forms.concat([f]) }) : v; }) }), ui: Object.assign({}, state.ui, { formFormOpen: false, formDraft: { name: '', repeating: false } }) }));
}

function deleteForm(vid, fid) {
  var v = state.study.visits.find(function(x) { return x.id === vid; });
  var f = v && v.forms.find(function(x) { return x.id === fid; });
  if (!f) return;
  if (f.status === 'active') { patchBuilder({ notice: 'Deployed instruments cannot be removed. Revert to draft first.' }); return; }
  commit(Object.assign({}, state, { study: Object.assign({}, state.study, { visits: state.study.visits.map(function(v) { return v.id === vid ? Object.assign({}, v, { forms: v.forms.filter(function(x) { return x.id !== fid; }) }) : v; }) }) }));
}

function deployForm(vid, fid) {
  commit(Object.assign({}, state, { study: Object.assign({}, state.study, { visits: state.study.visits.map(function(v) {
    return v.id !== vid ? v : Object.assign({}, v, { forms: v.forms.map(function(f) {
      return f.id === fid ? Object.assign({}, f, { status: 'active' }) : f;
    }) });
  }) }) }));
}

function createNewVersion(vid, fid) {
  commit(Object.assign({}, state, { study: Object.assign({}, state.study, { visits: state.study.visits.map(function(v) {
    return v.id !== vid ? v : Object.assign({}, v, { forms: v.forms.map(function(f) {
      return (f.id === fid && f.status === 'active') ? Object.assign({}, f, { status: 'draft', version: f.version + 1 }) : f;
    }) });
  }) }) }));
}

// --- Builder ---
function openBuilder(vid, fid) {
  var v = state.study.visits.find(function(x) { return x.id === vid; });
  var f = v && v.forms.find(function(x) { return x.id === fid; });
  if (!f || f.status !== 'draft') return;
  var w = deepCopy(f);
  commit(Object.assign({}, state, { ui: Object.assign({}, state.ui, { route: { kind: 'builder', visitId: vid, formId: fid }, visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' }, formFormOpen: false, formDraft: { name: '', repeating: false }, builder: Object.assign({}, emptyBuilder(), { working: w, selectedPageId: w.pages[0] ? w.pages[0].id : '' }) }) }));
}

function lockWorking() {
  if (state.ui.route.kind !== 'builder' || !state.ui.builder.working) return;
  var s = deepCopy(state.ui.builder.working);
  commit(Object.assign({}, state, { study: Object.assign({}, state.study, { visits: state.study.visits.map(function(v) { return v.id !== state.ui.route.visitId ? v : Object.assign({}, v, { forms: v.forms.map(function(f) { return f.id === s.id ? s : f; }) }); }) }), ui: Object.assign({}, state.ui, { builder: Object.assign({}, state.ui.builder, { dirty: false, notice: 'Locked.' }) }) }));
}

function stashInstrument() { if (state.ui.route.kind !== 'builder') return; patchBuilder({ notice: 'Stashed as a reusable template.' }); }

function deployWorking() {
  if (state.ui.route.kind !== 'builder' || !state.ui.builder.working) return;
  if (state.ui.builder.dirty) { patchBuilder({ notice: 'Lock the instrument before deploying.' }); return; }
  deployForm(state.ui.route.visitId, state.ui.route.formId);
  patchBuilder({ working: Object.assign({}, state.ui.builder.working, { status: 'active' }), notice: 'Instrument is now deployed.' });
}

function openPreview() { patchBuilder({ previewOpen: true }); }
function closePreview() { patchBuilder({ previewOpen: false }); }
function setLibraryFilter(f) { patchBuilder({ libraryFilter: f }); }
function selectPage(id) { patchBuilder({ selectedPageId: id, selectedElementId: null }); }

function addPage() {
  var b = state.ui.builder; if (!b.working) return;
  var p = { id: nextId('pg'), name: 'Section ' + (b.working.pages.length + 1), elements: [] };
  patchBuilder({ working: Object.assign({}, b.working, { pages: b.working.pages.concat([p]) }), selectedPageId: p.id, selectedElementId: null, dirty: true });
}

function addElement(type) {
  var b = state.ui.builder; if (!b.working) return;
  var e = { id: nextId('el'), label: typeLabel(type), type: type, required: false, hidden: false, placeholder: '', min: '', max: '', units: '', decimalPlaces: '', formula: '', allowPast: true, allowFuture: true, values: [], visibility: { mode: 'always' } };
  patchBuilder({ working: Object.assign({}, b.working, { pages: b.working.pages.map(function(p) { return p.id === b.selectedPageId ? Object.assign({}, p, { elements: p.elements.concat([e]) }) : p; }) }), selectedElementId: e.id, dirty: true });
}

function selectElement(id) { patchBuilder({ selectedElementId: id }); }
function deleteSelectedElement() {
  var b = state.ui.builder; if (!b.working || !b.selectedElementId) return;
  patchBuilder({ working: Object.assign({}, b.working, { pages: b.working.pages.map(function(p) { return Object.assign({}, p, { elements: p.elements.filter(function(e) { return e.id !== b.selectedElementId; }) }); }) }), selectedElementId: null, dirty: true });
}

function selectedElement() {
  var b = state.ui.builder; if (!b.working || !b.selectedElementId) return undefined;
  for (var i = 0; i < b.working.pages.length; i++) { var f = b.working.pages[i].elements.find(function(e) { return e.id === b.selectedElementId; }); if (f) return f; }
  return undefined;
}

function updateSelected(fn) {
  var b = state.ui.builder; if (!b.working || !b.selectedElementId) return;
  patchBuilder({ working: Object.assign({}, b.working, { pages: b.working.pages.map(function(p) { return Object.assign({}, p, { elements: p.elements.map(function(e) { return e.id === b.selectedElementId ? fn(e) : e; }) }); }) }), dirty: true });
}

function patchSelected(p) { updateSelected(function(e) { return Object.assign({}, e, p); }); }

// KEY TRAP #3: Type-change clears range in BOTH directions.
// integer->decimal clears range, AND decimal->integer clears range.
// Also clears range when going from range to non-range (as expected).
// Essentially: if the OLD type had range and the NEW type is different,
// range is cleared. If both old and new are range types but different
// (integer vs decimal), range is ALSO cleared.
function setSelectedType(type) {
  var d = FIELD_TYPE_DEFS[type];
  var oldType = selectedElement() ? selectedElement().type : null;
  var oldDef = oldType ? FIELD_TYPE_DEFS[oldType] : null;

  // Determine if range should be cleared:
  // Clear if old type had range and:
  //   - new type does NOT have range (range -> non-range), OR
  //   - new type has range but is a DIFFERENT range type (integer <-> decimal)
  // This means BOTH directions of integer<->decimal clear range.
  var clearRange = false;
  if (oldDef && oldDef.hasRange) {
    if (!d.hasRange || (d.hasRange && type !== oldType)) {
      clearRange = true;
    }
  }

  updateSelected(function(e) {
    var newMin = d.hasRange ? (clearRange ? '' : e.min) : '';
    var newMax = d.hasRange ? (clearRange ? '' : e.max) : '';
    var newUnits = d.hasRange ? (clearRange ? '' : e.units) : '';
    var newDecimalPlaces = d.hasRange && type === 'decimal' ? (clearRange ? '' : e.decimalPlaces) : '';
    return Object.assign({}, e, {
      type: type,
      values: d.hasOptions ? e.values : [],
      min: newMin,
      max: newMax,
      units: newUnits,
      decimalPlaces: newDecimalPlaces,
      formula: d.hasFormula ? e.formula : ''
    });
  });
}

// --- Options / Values ---
function addValue() { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.concat([{ id: nextId('val'), code: '', label: '' }]) }); }); }
function setValueCode(i, c) { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.map(function(v, j) { return j === i ? Object.assign({}, v, { code: c }) : v; }) }); }); }
function setValueLabel(i, l) { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.map(function(v, j) { return j === i ? Object.assign({}, v, { label: l }) : v; }) }); }); }
function removeValue(i) { updateSelected(function(e) { return Object.assign({}, e, { values: e.values.filter(function(_, j) { return j !== i; }) }); }); }
function setPasteText(t) { patchBuilder({ pasteText: t }); }

// KEY TRAP #4: Bulk paste APPENDS to existing values instead of replacing.
function applyPasteValues() {
  var lines = state.ui.builder.pasteText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 0) return;
  var newVals = lines.map(function(line) { var eq = line.indexOf('='); var c = eq === -1 ? line : line.slice(0, eq).trim(); var l = eq === -1 ? line : line.slice(eq + 1).trim(); return { id: nextId('val'), code: c, label: l }; });
  // APPEND to existing values instead of replacing
  updateSelected(function(e) { return Object.assign({}, e, { values: e.values.concat(newVals) }); });
  patchBuilder({ pasteText: '' });
}

// --- Visibility / Skip Logic ---
function setVisibilityMode(m) { updateSelected(function(e) { return Object.assign({}, e, { visibility: m === 'always' ? { mode: 'always' } : { mode: 'when', whenElementId: '', equalsValue: '' } }); }); }
function setVisibilityWhen(id) { updateSelected(function(e) { return e.visibility.mode === 'when' ? Object.assign({}, e, { visibility: Object.assign({}, e.visibility, { whenElementId: id }) }) : e; }); }
function setVisibilityValue(v) { updateSelected(function(e) { return e.visibility.mode === 'when' ? Object.assign({}, e, { visibility: Object.assign({}, e.visibility, { equalsValue: v }) }) : e; }); }

function currentVisit() { if (state.ui.route.kind === 'roadmap') return undefined; return state.study.visits.find(function(v) { return v.id === state.ui.route.visitId; }); }
function selectedPage() { var b = state.ui.builder; return b.working ? b.working.pages.find(function(p) { return p.id === b.selectedPageId; }) : undefined; }

function resetState() { seq = 0; commit({ study: { name: state.study.name, visits: [] }, ui: { route: { kind: 'roadmap' }, visitFormOpen: false, visitDraft: { name: '', windowStart: '', windowEnd: '' }, formFormOpen: false, formDraft: { name: '', repeating: false }, builder: emptyBuilder() } }); }

// --- Ground-truth export (test tooling, NOT for agent use) ---
function readField(el, form) {
  var sl = null; var v = el.visibility;
  if (v.mode === 'when' && v.whenElementId) { var w = form.pages.flatMap(function(p) { return p.elements; }).find(function(e) { return e.id === v.whenElementId; }); if (w) sl = { whenFieldLabel: w.label, equalsValue: v.equalsValue }; }
  return { label: el.label, type: el.type, required: el.required, options: el.values.map(function(v) { return { code: v.code, label: v.label }; }), min: el.min, max: el.max, units: el.units, formula: el.formula, skipLogic: sl };
}

window.__groundTruth = function() { return JSON.parse(JSON.stringify({ platform: PLATFORM_ID, specVersion: SPEC_VERSION, study: { name: state.study.name, visits: state.study.visits.map(function(v) { return { name: v.name, windowStart: v.windowStart, windowEnd: v.windowEnd, forms: v.forms.map(function(f) { return { name: f.name, repeating: f.repeating, status: f.status, fields: f.pages.flatMap(function(p) { return p.elements.map(function(e) { return readField(e, f); }); }) }; }) }; }) } })); };
window.__resetState = function() { resetState(); };
window.__mockPlatform = PLATFORM_ID;

var p = new URLSearchParams(window.location.search);
if (p.get('reset') === '1') resetState();