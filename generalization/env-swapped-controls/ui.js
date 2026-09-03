'use strict';

// ============================================================
// Nexus Form Engine -- env-swapped-controls (UI rendering)
// Left sidebar palette layout (differs from env-rosetta top-strip).
// ============================================================

function el(tag, attrs, children) {
  attrs = attrs || {}; children = children || [];
  var node = document.createElement(tag);
  for (var k in attrs) node.setAttribute(k, attrs[k]);
  children.forEach(function(c) { node.append(c); });
  return node;
}
function text(s) { return document.createTextNode(s); }
function btn(id, label, cls, onClick) {
  var b = el('button', { type: 'button', id: id, class: cls || 'btn' }, [text(label)]);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function labelled(id, labelText, control) {
  control.setAttribute('id', id);
  return el('div', { class: 'row' }, [el('label', { for: id }, [text(labelText)]), control]);
}

function build() {
  var app = el('div', {});
  app.append(el('div', { class: 'topbar' }, [
    el('span', { class: 'topbar-brand' }, [text('Nexus Form Engine')]),
    el('button', { type: 'button', class: 'topbar-link', id: 'nav-roadmap' }, [text('Trial Roadmap')]),
    el('button', { type: 'button', class: 'topbar-link', id: 'nav-sites' }, [text('Sites')]),
    el('button', { type: 'button', class: 'topbar-link', id: 'nav-data' }, [text('Data Entry')]),
    el('span', { class: 'topbar-brand', style: 'font-size:12px;color:#c4b5fd;' }, [text(state.study.name)]),
  ]));
  var main = el('div', { class: 'content' });
  app.append(main);
  if (state.ui.route.kind === 'roadmap') { roadmapScreen().forEach(function(n) { main.append(n); }); }
  else if (state.ui.route.kind === 'visit') { visitScreen().forEach(function(n) { main.append(n); }); }
  else if (state.ui.route.kind === 'builder') { main.append(builderScreen()); }
  if (state.ui.builder.previewOpen && state.ui.builder.working) app.append(previewModal());
  return app;
}

function roadmapScreen() {
  var nodes = [el('h2', {}, [text('Trial Roadmap')])];
  var table = el('table', { class: 'grid' });
  table.append(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, [text('Cycle')]),
      el('th', {}, [text('Window (days)')]),
      el('th', {}, [text('Instruments')]),
      el('th', {}, [text('.')])
    ])
  ]));
  var body = el('tbody', {});
  state.study.visits.forEach(function(v) {
    var open = el('button', { type: 'button', class: 'link-btn', id: 'open-visit-' + v.id }, [text(v.name)]);
    open.addEventListener('click', function() { navigate({ kind: 'visit', visitId: v.id }); });
    body.append(el('tr', {}, [el('td', {}, [open]), el('td', {}, [text(v.windowStart + ' to ' + v.windowEnd)]), el('td', {}, [text(String(v.forms.length))]), el('td', {}, [])]));
  });
  if (state.study.visits.length === 0) body.append(el('tr', {}, [el('td', { colspan: '4', class: 'empty' }, [text('No cycles defined.')])]));
  table.append(body);
  nodes.push(table);
  nodes.push(btn('add-visit', '+ New Cycle', 'btn primary', function() { openVisitForm(); }));

  if (state.ui.visitFormOpen) {
    var card = el('div', { class: 'card' }, [el('h3', {}, [text('New Cycle')])]);
    var name = el('input', { type: 'text' });
    name.addEventListener('input', function() { setVisitDraft({ name: name.value }); });
    var start = el('input', { type: 'text' });
    start.addEventListener('input', function() { setVisitDraft({ windowStart: start.value }); });
    var end = el('input', { type: 'text' });
    end.addEventListener('input', function() { setVisitDraft({ windowEnd: end.value }); });
    card.append(labelled('visit-name', 'Cycle Name', name), labelled('visit-start', 'Window Start (day)', start), labelled('visit-end', 'Window End (day)', end),
      el('div', { class: 'actions' }, [btn('save-visit', 'Add Cycle', 'btn primary', function() { saveVisit(); }), btn('cancel-visit', 'Cancel', 'btn', function() { cancelVisitForm(); })]));
    nodes.push(card);
  }
  return nodes;
}

function visitScreen() {
  var visit = currentVisit();
  if (!visit) return [el('p', {}, [text('Cycle not found.')])];
  var nodes = [el('p', { class: 'breadcrumb' }, [text('Trial Roadmap / ' + visit.name)]),
    btn('back-to-roadmap', '<- Back', 'btn small', function() { navigate({ kind: 'roadmap' }); }),
    el('h2', {}, [text(visit.name + ' -- Instruments')])];
  var table = el('table', { class: 'grid' });
  table.append(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, [text('Instrument')]),
      el('th', {}, [text('Version')]),
      el('th', {}, [text('Status')]),
      el('th', {}, [text('Type')]),
      el('th', {}, [text('Actions')])
    ])
  ]));
  var body = el('tbody', {});
  visit.forms.forEach(function(f) {
    var actions = el('td', {});
    if (f.status === 'draft') {
      actions.append(btn('edit-' + f.id, 'Edit', 'btn small', function() { openBuilder(visit.id, f.id); }));
      actions.append(btn('deploy-' + f.id, 'Deploy', 'btn small', function() { deployForm(visit.id, f.id); }));
    } else {
      actions.append(btn('newver-' + f.id, 'Branch New Version', 'btn small', function() { createNewVersion(visit.id, f.id); }));
    }
    actions.append(btn('delete-' + f.id, 'Remove', 'btn small danger', function() { deleteForm(visit.id, f.id); }));
    body.append(el('tr', {}, [el('td', {}, [text(f.name)]), el('td', {}, [text('v' + f.version)]), el('td', {}, [el('span', { class: 'chip ' + f.status }, [text(f.status === 'draft' ? 'Draft' : 'Deployed')])]), el('td', {}, [text(f.repeating ? 'Repeating log' : 'Standard')]), actions]));
  });
  if (visit.forms.length === 0) body.append(el('tr', {}, [el('td', { colspan: '5', class: 'empty' }, [text('No instruments.')])]));
  table.append(body);
  nodes.push(table);
  nodes.push(btn('new-form', '+ New Instrument', 'btn primary', function() { openFormForm(); }));

  if (state.ui.formFormOpen) {
    var card = el('div', { class: 'card' }, [el('h3', {}, [text('New Instrument')])]);
    var name = el('input', { type: 'text' });
    name.addEventListener('input', function() { setFormDraft({ name: name.value }); });
    var rep = el('input', { type: 'checkbox' });
    rep.addEventListener('change', function() { setFormDraft({ repeating: rep.checked }); });
    card.append(labelled('form-name', 'Instrument Name', name), el('div', { class: 'row checkbox' }, [rep, el('label', { for: 'form-repeating' }, [text('Repeating log (many records per cycle)')])]),
      el('div', { class: 'actions' }, [btn('create-form', 'Create', 'btn primary', function() { createForm(); }), btn('cancel-form', 'Cancel', 'btn', function() { cancelFormForm(); })]));
    nodes.push(card);
  }
  return nodes;
}

function builderScreen() {
  var visit = currentVisit();
  var working = state.ui.builder.working;
  if (!visit || !working) return el('p', {}, [text('Instrument not found.')]);
  var wrap = el('div', {});
  var back = btn('builder-back', '<- ' + visit.name, 'btn small', function() { navigate({ kind: 'visit', visitId: visit.id }); });
  var lock = btn('builder-lock', 'Lock', 'btn primary', function() { lockWorking(); });
  var stash = btn('builder-stash', 'Stash', 'btn primary', function() { stashInstrument(); });
  var preview = btn('builder-preview', 'Preview', 'btn', function() { openPreview(); });
  var deploy = btn('builder-deploy', 'Deploy', 'btn primary', function() { deployWorking(); });
  var statusBits = ['v' + working.version, working.status === 'draft' ? 'Draft' : 'Deployed'];
  if (state.ui.builder.dirty) statusBits.push('Unlocked changes');
  wrap.append(el('div', { class: 'builder-bar' }, [
    el('div', { class: 'builder-bar-left' }, [back, el('span', { class: 'builder-title' }, [text(working.name)]), el('span', { class: 'builder-status' }, [text(statusBits.join(' | '))])]),
    el('div', { class: 'builder-bar-right' }, [preview, stash, lock, deploy]),
  ]));
  if (state.ui.builder.notice) wrap.append(el('div', { class: 'toast' }, [text(state.ui.builder.notice)]));

  var body = el('div', { class: 'builder-body' });
  body.append(paletteSidebar(), canvasColumn(working), optionsColumn());
  wrap.append(body);
  return wrap;
}

function paletteSidebar() {
  var sidebar = el('div', { class: 'palette-sidebar' }, [el('h4', {}, [text('Nodes')])]);
  var needle = state.ui.builder.libraryFilter.trim().toLowerCase();
  ELEMENT_TYPES.forEach(function(def) {
    if (needle && def.label.toLowerCase().indexOf(needle) === -1) return;
    var tile = el('button', { type: 'button', class: 'palette-tile', id: 'node-' + def.canonical }, [text(def.label)]);
    tile.addEventListener('click', function() { addElement(def.canonical); });
    sidebar.append(tile);
  });
  var filter = el('input', { type: 'text', placeholder: 'Filter...', style: 'margin-top:8px;' });
  filter.value = state.ui.builder.libraryFilter;
  filter.addEventListener('input', function() { setLibraryFilter(filter.value); });
  sidebar.append(filter);
  return sidebar;
}

function canvasColumn(working) {
  var col = el('div', { class: 'canvas' });
  var tabs = el('div', { class: 'page-tabs' });
  working.pages.forEach(function(p) {
    var t = el('button', { type: 'button', class: 'page-tab' + (p.id === state.ui.builder.selectedPageId ? ' active' : ''), id: 'page-tab-' + p.id }, [text(p.name)]);
    t.addEventListener('click', function() { selectPage(p.id); });
    tabs.append(t);
  });
  tabs.append(btn('add-page', '+ Section', 'btn small', function() { addPage(); }));
  col.append(tabs);
  var page = selectedPage();
  var surface = el('div', { class: 'canvas-surface' });
  if (!page || page.elements.length === 0) {
    surface.append(el('p', { class: 'empty' }, [text('Click a node on the left to add it to this section.')]));
  } else {
    page.elements.forEach(function(e) {
      surface.append(elementCard(e, e.id === state.ui.builder.selectedElementId));
    });
  }
  col.append(surface);
  return col;
}

function elementCard(element, isSelected) {
  var card = el('div', { class: 'element-card' + (isSelected ? ' selected' : ''), id: 'element-' + element.id });
  card.addEventListener('click', function() { selectElement(element.id); });
  var bits = [typeLabel(element.type)];
  if (element.required) bits.push('Required');
  if (element.hidden) bits.push('Hidden');
  if (element.visibility.mode === 'when') bits.push('Conditional');
  card.append(el('div', { class: 'element-head' }, [el('span', { class: 'element-label' }, [text(element.label + (element.required ? ' *' : ''))]), el('span', { class: 'element-meta' }, [text(bits.join(' | '))])]), inertControl(element));
  return card;
}

function inertControl(element) {
  var h = el('div', { class: 'element-preview' });
  switch (element.type) {
    case 'text': h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: element.placeholder })); break;
    case 'textarea': h.append(el('textarea', { rows: '2', 'aria-label': element.label })); break;
    case 'integer': case 'decimal': h.append(el('input', { type: 'text', 'aria-label': element.label, class: 'narrow' }), el('span', { class: 'units' }, [text(element.units)])); break;
    case 'date': h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'YYYY-MM-DD', class: 'narrow' })); break;
    case 'time': h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'HH:MM', class: 'narrow' })); break;
    case 'datetime': h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'YYYY-MM-DD HH:MM', class: 'narrow' })); break;
    case 'boolean': h.append(el('button', { type: 'button', class: 'btn small' }, [text('True')]), el('button', { type: 'button', class: 'btn small' }, [text('False')])); break;
    case 'single_select': var s = el('select', { 'aria-label': element.label }); s.append(el('option', {}, [text('-- Select --')])); element.values.forEach(function(v) { s.append(el('option', {}, [text(v.label)])); }); h.append(s); break;
    case 'multi_select': case 'radio': var kind = element.type === 'radio' ? 'radio' : 'checkbox'; element.values.forEach(function(v) { h.append(el('span', { class: 'choice' }, [el('input', { type: kind, 'aria-label': element.label + ': ' + v.label }), text(v.label)])); }); if (element.values.length === 0) h.append(el('span', { class: 'element-meta' }, [text('No values defined.')])); break;
    case 'checkbox': h.append(el('span', { class: 'choice' }, [el('input', { type: 'checkbox', 'aria-label': element.label }), text(element.label)])); break;
    case 'calculated': h.append(el('input', { type: 'text', 'aria-label': element.label, readonly: 'readonly', value: element.formula ? '= ' + element.formula : '= (no formula)' })); break;
  }
  return h;
}

function optionsColumn() {
  var col = el('aside', { class: 'options-panel' }, [el('h3', {}, [text('Node Properties')])]);
  var element = selectedElement();
  if (!element) { col.append(el('p', { class: 'empty' }, [text('Select a node on the canvas to edit its properties.')])); return col; }
  var def = FIELD_TYPE_DEFS[element.type];
  var working = state.ui.builder.working;

  var label = el('input', { type: 'text' });
  label.value = element.label;
  label.addEventListener('input', function() { patchSelected({ label: label.value }); });
  col.append(labelled('opt-label', 'Label', label));

  var type = el('select', {});
  ELEMENT_TYPES.forEach(function(t) { var o = el('option', { value: t.canonical }, [text(t.label)]); if (t.canonical === element.type) o.setAttribute('selected', 'selected'); type.append(o); });
  type.addEventListener('change', function() { setSelectedType(type.value); });
  col.append(labelled('opt-type', 'Node Type', type));

  var req = el('input', { type: 'checkbox' });
  if (element.required) req.setAttribute('checked', 'checked');
  req.addEventListener('change', function() { patchSelected({ required: req.checked }); });
  col.append(el('div', { class: 'row checkbox' }, [req, el('label', { for: 'opt-required' }, [text('Required')])]));

  var hid = el('input', { type: 'checkbox' });
  if (element.hidden) hid.setAttribute('checked', 'checked');
  hid.addEventListener('change', function() { patchSelected({ hidden: hid.checked }); });
  col.append(el('div', { class: 'row checkbox' }, [hid, el('label', { for: 'opt-hidden' }, [text('Hidden')])]));

  if (def.hasRange) {
    var fs = el('fieldset', {}, [el('legend', {}, [text('Bounds')])]);
    var min = el('input', { type: 'text' }); min.value = element.min; min.addEventListener('input', function() { patchSelected({ min: min.value }); });
    var max = el('input', { type: 'text' }); max.value = element.max; max.addEventListener('input', function() { patchSelected({ max: max.value }); });
    var units = el('input', { type: 'text' }); units.value = element.units; units.addEventListener('input', function() { patchSelected({ units: units.value }); });
    fs.append(labelled('opt-min', 'Lower Bound', min), labelled('opt-max', 'Upper Bound', max), labelled('opt-units', 'Units', units));
    if (element.type === 'decimal') { var dp = el('input', { type: 'text' }); dp.value = element.decimalPlaces; dp.addEventListener('input', function() { patchSelected({ decimalPlaces: dp.value }); }); fs.append(labelled('opt-dp', 'Decimal Places', dp)); }
    col.append(fs);
  }

  if (def.hasFormula) {
    var f = el('input', { type: 'text', placeholder: 'e.g. weight / (height / 100) ^ 2' });
    f.value = element.formula; f.addEventListener('input', function() { patchSelected({ formula: f.value }); });
    col.append(labelled('opt-formula', 'Expression', f));
  }

  if (def.hasOptions) {
    var fs2 = el('fieldset', { class: 'values' }, [el('legend', {}, [text('Choices')])]);
    element.values.forEach(function(v, i) {
      var c = el('input', { type: 'text', class: 'narrow' }); c.value = v.code; c.addEventListener('input', function() { setValueCode(i, c.value); });
      var l = el('input', { type: 'text' }); l.value = v.label; l.addEventListener('input', function() { setValueLabel(i, l.value); });
      var rm = btn('val-rm-' + i, 'x', 'btn small danger', function() { removeValue(i); });
      fs2.append(el('div', { class: 'value-row' }, [labelled('val-code-' + i, 'Code', c), labelled('val-label-' + i, 'Label', l), rm]));
    });
    fs2.append(btn('val-add', '+ Add Choice', 'btn small', function() { addValue(); }));
    var paste = el('textarea', { rows: '3', placeholder: 'code=Label, one per line' });
    paste.addEventListener('input', function() { setPasteText(paste.value); });
    fs2.append(labelled('val-paste', 'Paste Choices (appends to list)', paste));
    fs2.append(btn('val-paste-apply', 'Append Pasted Choices', 'btn small', function() { applyPasteValues(); }));
    col.append(fs2);
  }

  // Visibility / skip logic
  var fs3 = el('fieldset', {}, [el('legend', {}, [text('Node Visibility')])]);
  var mode = el('select', {});
  mode.append(el('option', { value: 'always' }, [text('Always Shown')]), el('option', { value: 'when' }, [text('Shown When...')]));
  if (element.visibility.mode === 'when') mode.children[1].setAttribute('selected', 'selected');
  mode.addEventListener('change', function() { setVisibilityMode(mode.value); });
  fs3.append(labelled('opt-vis', 'Visibility', mode));
  if (element.visibility.mode === 'when') {
    var when = el('select', {});
    when.append(el('option', { value: '' }, [text('-- choose node --')]));
    (working ? working.pages : []).forEach(function(p) { p.elements.forEach(function(o) {
      if (o.id === element.id) return;
      var opt = el('option', { value: o.id }, [text(o.label)]);
      if (o.id === element.visibility.whenElementId) opt.setAttribute('selected', 'selected');
      when.append(opt);
    }); });
    when.addEventListener('change', function() { setVisibilityWhen(when.value); });
    var eq = el('input', { type: 'text' }); eq.value = element.visibility.equalsValue; eq.addEventListener('input', function() { setVisibilityValue(eq.value); });
    fs3.append(labelled('opt-vis-when', 'When Node', when), labelled('opt-vis-val', 'Equals Value', eq));
  }
  col.append(fs3);
  col.append(btn('opt-delete', 'Delete Node', 'btn danger', function() { deleteSelectedElement(); }));
  return col;
}

function previewModal() {
  var working = state.ui.builder.working;
  var panel = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Preview' });
  panel.append(el('h3', {}, [text('Preview -- ' + working.name)]));
  working.pages.forEach(function(p) {
    panel.append(el('h4', {}, [text(p.name)]));
    p.elements.filter(function(e) { return !e.hidden; }).forEach(function(e) {
      panel.append(el('div', { class: 'preview-row' }, [el('span', { class: 'element-label' }, [text(e.label + (e.required ? ' *' : ''))]), inertControl(e)]));
    });
  });
  panel.append(el('div', { class: 'actions' }, [btn('preview-close', 'Close Preview', 'btn primary', function() { closePreview(); })]));
  return el('div', { class: 'modal-overlay' }, [panel]);
}

// Mount and render loop
function render() { document.getElementById('root').replaceChildren(build()); }
subscribe(render);
render();