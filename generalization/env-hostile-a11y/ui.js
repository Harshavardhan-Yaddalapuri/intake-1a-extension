'use strict';

// ============================================================
// PrismForm Builder -- env-hostile-a11y (UI rendering)
//
// ACCESSIBLE-TREE HOSTILE:
//   - NO <button>, <label>, <select>, <input type=radio/checkbox>
//     with labels. Everything is div[onclick] and custom spans.
//   - NO role attributes, NO aria-label, NO aria-* at all.
//   - Text labels are <span> elements next to controls.
//   - Custom controls: div.clickable for buttons, div.toggle-box
//     for checkboxes, div.choice-pick for radio/checkbox, div.list-drop
//     for selects, div.text-cell for text inputs, div.area-cell
//     for textareas, div.on-off for booleans.
//   - The agent must degrade to structural DOM walking + probe
//     evidence (rung 2/3). Accessible names will not help here.
// ============================================================

function el(tag, attrs, children) {
  attrs = attrs || {}; children = children || [];
  var node = document.createElement(tag);
  for (var k in attrs) node.setAttribute(k, attrs[k]);
  children.forEach(function(c) { node.append(c); });
  return node;
}
function txt(s) { return document.createTextNode(s); }

// Custom clickable "button" -- a div with click handler, NO role, NO aria
function clickBox(id, label, cls, onClick) {
  var d = el('div', { id: id, class: 'clickable ' + (cls || '') });
  d.append(el('span', {}, [txt(label)]));
  if (onClick) d.addEventListener('click', onClick);
  return d;
}

// Custom labeled control -- label is a span, control is a div. NO <label>
function labeled(idStr, labelText, control) {
  control.setAttribute('id', idStr);
  var wrap = el('div', { class: 'field-row' });
  wrap.append(el('span', { class: 'field-label' }, [txt(labelText)]));
  wrap.append(control);
  return wrap;
}

// Custom text input -- a div with contenteditable, NO role/aria
function textCell(idStr, value, onInput) {
  var d = el('div', { id: idStr, class: 'text-cell', contenteditable: 'true' });
  d.append(el('span', { class: 'cell-text' }, [txt(value || '')]));
  d.addEventListener('input', function() { onInput(d.textContent); });
  return d;
}

// Custom textarea -- a div with contenteditable
function areaCell(idStr, value, onInput) {
  var d = el('div', { id: idStr, class: 'area-cell', contenteditable: 'true' });
  d.append(el('span', { class: 'cell-text' }, [txt(value || '')]));
  d.addEventListener('input', function() { onInput(d.textContent); });
  return d;
}

// Custom checkbox toggle -- div with click handler
function toggleBox(idStr, checked, onChange) {
  var d = el('div', { id: idStr, class: 'toggle-box' + (checked ? ' on' : '') });
  d.append(el('span', { class: 'toggle-mark' }, [txt(checked ? 'X' : '')]));
  d.addEventListener('click', function() {
    var isOn = d.classList.contains('on');
    if (isOn) { d.classList.remove('on'); d.querySelector('.toggle-mark').textContent = ''; }
    else { d.classList.add('on'); d.querySelector('.toggle-mark').textContent = 'X'; }
    onChange(!isOn);
  });
  return d;
}

// Custom single-select dropdown -- div that opens a list of div options
function dropList(idStr, options, currentVal, onChange) {
  var d = el('div', { id: idStr, class: 'list-drop' });
  var display = el('div', { class: 'list-display' });
  var currentLabel = options.find(function(o) { return o.value === currentVal; });
  display.append(el('span', { class: 'list-text' }, [txt(currentLabel ? currentLabel.label : '-- Choose --')]));
  d.append(display);
  var panel = el('div', { class: 'list-panel' });
  options.forEach(function(o) {
    var opt = el('div', { class: 'list-opt' + (o.value === currentVal ? ' sel' : '') });
    opt.append(el('span', {}, [txt(o.label)]));
    opt.addEventListener('click', function(e) {
      e.stopPropagation();
      display.querySelector('.list-text').textContent = o.label;
      panel.style.display = 'none';
      onChange(o.value);
    });
    panel.append(opt);
  });
  panel.style.display = 'none';
  d.append(panel);
  d.addEventListener('click', function() {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  return d;
}

function build() {
  var app = el('div', {});
  // Top bar -- all divs, no semantic nav
  var bar = el('div', { class: 'top-bar' });
  bar.append(el('div', { class: 'top-bar-title' }, [el('span', {}, [txt('PrismForm Builder')])]));
  bar.append(clickBox('nav-roster', 'Wave Roster', 'top-bar-btn', function() { navigate({ kind: 'roster' }); }));
  bar.append(clickBox('nav-sites', 'Sites', 'top-bar-btn', function() {}));
  bar.append(clickBox('nav-data', 'Data Entry', 'top-bar-btn', function() {}));
  bar.append(el('div', { class: 'top-bar-spacer' }, []));
  bar.append(el('div', { class: 'top-bar-study' }, [el('span', {}, [txt(state.study.name)])]));
  app.append(bar);

  var main = el('div', { class: 'content' });
  app.append(main);
  if (state.ui.route.kind === 'roster') { rosterScreen().forEach(function(n) { main.append(n); }); }
  else if (state.ui.route.kind === 'visit') { visitScreen().forEach(function(n) { main.append(n); }); }
  else if (state.ui.route.kind === 'builder') { main.append(builderScreen()); }
  if (state.ui.builder.previewOpen && state.ui.builder.working) app.append(previewModal());
  return app;
}

function rosterScreen() {
  var nodes = [el('div', { class: 'page-title' }, [el('span', {}, [txt('Wave Roster')])])];
  var grid = el('div', { class: 'grid' });
  var head = el('div', { class: 'grid-row grid-head' });
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Wave')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Window (days)')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Surveys')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('')])]));
  grid.append(head);
  state.study.visits.forEach(function(v) {
    var row = el('div', { class: 'grid-row' });
    var link = clickBox('open-visit-' + v.id, v.name, 'link-text', function() { navigate({ kind: 'visit', visitId: v.id }); });
    row.append(el('div', { class: 'grid-cell' }, [link]));
    row.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt(v.windowStart + ' to ' + v.windowEnd)])]));
    row.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt(String(v.forms.length))])]));
    row.append(el('div', { class: 'grid-cell' }, []));
    grid.append(row);
  });
  if (state.study.visits.length === 0) {
    var er = el('div', { class: 'grid-row' });
    er.append(el('div', { class: 'grid-cell empty-cell', colspan: '4' }, [el('span', {}, [txt('No waves defined.')])]));
    grid.append(er);
  }
  nodes.push(grid);
  nodes.push(clickBox('add-visit', '+ Add Wave', 'clickable primary', function() { openVisitForm(); }));

  if (state.ui.visitFormOpen) {
    var card = el('div', { class: 'card' }, [el('div', { class: 'card-title' }, [el('span', {}, [txt('New Wave')])])]);
    var name = textCell('visit-name', state.ui.visitDraft.name, function(v) { setVisitDraft({ name: v }); });
    var start = textCell('visit-start', state.ui.visitDraft.windowStart, function(v) { setVisitDraft({ windowStart: v }); });
    var end = textCell('visit-end', state.ui.visitDraft.windowEnd, function(v) { setVisitDraft({ windowEnd: v }); });
    card.append(labeled('visit-name', 'Wave Name', name), labeled('visit-start', 'Window Start (day)', start), labeled('visit-end', 'Window End (day)', end));
    var actions = el('div', { class: 'actions' });
    actions.append(clickBox('save-visit', 'Snapshot Wave', 'clickable primary', function() { saveVisit(); }));
    actions.append(clickBox('cancel-visit', 'Cancel', 'clickable', function() { cancelVisitForm(); }));
    card.append(actions);
    nodes.push(card);
  }
  return nodes;
}

function visitScreen() {
  var visit = currentVisit();
  if (!visit) return [el('div', {}, [el('span', {}, [txt('Wave not found.')])])];
  var nodes = [
    el('div', { class: 'breadcrumb' }, [el('span', {}, [txt('Wave Roster / ' + visit.name)])]),
    clickBox('back-to-roster', '<- Back', 'clickable small', function() { navigate({ kind: 'roster' }); }),
    el('div', { class: 'page-title' }, [el('span', {}, [txt(visit.name + ' -- Surveys')])])
  ];
  var grid = el('div', { class: 'grid' });
  var head = el('div', { class: 'grid-row grid-head' });
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Survey')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Version')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Status')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Type')])]));
  head.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('Actions')])]));
  grid.append(head);
  visit.forms.forEach(function(f) {
    var row = el('div', { class: 'grid-row' });
    row.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt(f.name)])]));
    row.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt('v' + f.version)])]));
    var chip = el('div', { class: 'chip ' + f.status });
    chip.append(el('span', {}, [txt(f.status === 'draft' ? 'Draft' : 'Live')]));
    row.append(el('div', { class: 'grid-cell' }, [chip]));
    row.append(el('div', { class: 'grid-cell' }, [el('span', {}, [txt(f.repeating ? 'Repeating log' : 'Standard')])]));
    var act = el('div', { class: 'grid-cell' });
    if (f.status === 'draft') {
      act.append(clickBox('edit-' + f.id, 'Modify', 'clickable small', function() { openBuilder(visit.id, f.id); }));
      act.append(clickBox('activate-' + f.id, 'Promote', 'clickable small', function() { activateForm(visit.id, f.id); }));
    } else {
      act.append(clickBox('newver-' + f.id, 'Branch New Version', 'clickable small', function() { createNewVersion(visit.id, f.id); }));
    }
    act.append(clickBox('delete-' + f.id, 'Remove', 'clickable small danger', function() { deleteForm(visit.id, f.id); }));
    row.append(act);
    grid.append(row);
  });
  if (visit.forms.length === 0) {
    var er = el('div', { class: 'grid-row' });
    er.append(el('div', { class: 'grid-cell empty-cell', colspan: '5' }, [el('span', {}, [txt('No surveys.')])]));
    grid.append(er);
  }
  nodes.push(grid);
  nodes.push(clickBox('new-form', '+ New Survey', 'clickable primary', function() { openFormForm(); }));

  if (state.ui.formFormOpen) {
    var card = el('div', { class: 'card' }, [el('div', { class: 'card-title' }, [el('span', {}, [txt('New Survey')])])]);
    var name = textCell('form-name', state.ui.formDraft.name, function(v) { setFormDraft({ name: v }); });
    card.append(labeled('form-name', 'Survey Name', name));
    var repWrap = el('div', { class: 'field-row inline' });
    var rep = toggleBox('form-repeating', state.ui.formDraft.repeating, function(v) { setFormDraft({ repeating: v }); });
    var toggleLine = el('div', { class: 'toggle-wrap' }, [rep, el('span', { class: 'field-label' }, [txt('Repeating log (many records per wave)')])]);
    repWrap.append(toggleLine);
    card.append(repWrap);
    var actions = el('div', { class: 'actions' });
    actions.append(clickBox('create-form', 'Create', 'clickable primary', function() { createForm(); }));
    actions.append(clickBox('cancel-form', 'Cancel', 'clickable', function() { cancelFormForm(); }));
    card.append(actions);
    nodes.push(card);
  }
  return nodes;
}

function builderScreen() {
  var visit = currentVisit();
  var working = state.ui.builder.working;
  if (!visit || !working) return el('div', {}, [el('span', {}, [txt('Survey not found.')])]);
  var wrap = el('div', {});
  var back = clickBox('builder-back', '<- ' + visit.name, 'clickable small', function() { navigate({ kind: 'visit', visitId: visit.id }); });
  var save = clickBox('builder-freeze', 'Snapshot', 'clickable primary', function() { saveWorking(); });
  var bank = clickBox('builder-bank', 'Blueprint', 'clickable primary', function() { bankIt(); });
  var preview = clickBox('builder-preview', 'Preview', 'clickable', function() { openPreview(); });
  var promote = clickBox('builder-activate', 'Promote', 'clickable primary', function() { activateWorking(); });
  var statusBits = ['v' + working.version, working.status === 'draft' ? 'Draft' : 'Live'];
  if (state.ui.builder.dirty) statusBits.push('Unsaved changes');
  var bar = el('div', { class: 'builder-bar' });
  var left = el('div', { class: 'builder-bar-left' });
  left.append(back, el('span', { class: 'builder-title' }, [txt(working.name)]), el('span', { class: 'builder-status' }, [txt(statusBits.join(' | '))]));
  var right = el('div', { class: 'builder-bar-right' });
  right.append(preview, bank, save, promote);
  bar.append(left, right);
  wrap.append(bar);
  if (state.ui.builder.notice) wrap.append(el('div', { class: 'toast' }, [el('span', {}, [txt(state.ui.builder.notice)])]));

  // Palette strip -- div tiles, no buttons
  var palette = el('div', { class: 'palette-strip' }, [el('span', { class: 'palette-label' }, [txt('Fragments:')])]);
  var needle = state.ui.builder.libraryFilter.trim().toLowerCase();
  ELEMENT_TYPES.forEach(function(def) {
    if (needle && def.label.toLowerCase().indexOf(needle) === -1) return;
    var tile = clickBox('brick-' + def.canonical, def.label, 'palette-tile', function() { addElement(def.canonical); });
    palette.append(tile);
  });
  var filter = textCell('library-filter', state.ui.builder.libraryFilter, function(v) { setLibraryFilter(v); });
  filter.setAttribute('class', 'text-cell narrow');
  palette.append(filter);
  wrap.append(palette);

  var columns = el('div', { class: 'builder-columns' });
  columns.append(canvasColumn(working), optionsColumn());
  wrap.append(columns);
  return wrap;
}

function canvasColumn(working) {
  var col = el('div', { class: 'canvas' });
  var tabs = el('div', { class: 'page-tabs' });
  working.pages.forEach(function(p) {
    var t = clickBox('page-tab-' + p.id, p.name, 'page-tab' + (p.id === state.ui.builder.selectedPageId ? ' active' : ''), function() { selectPage(p.id); });
    tabs.append(t);
  });
  tabs.append(clickBox('add-page', '+ Section', 'clickable small', function() { addPage(); }));
  col.append(tabs);
  var page = selectedPage();
  var surface = el('div', { class: 'canvas-surface' });
  if (!page || page.elements.length === 0) {
    surface.append(el('div', { class: 'empty' }, [el('span', {}, [txt('Click a fragment above to add it to this section.')])]));
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
  var head = el('div', { class: 'element-head' });
  head.append(el('span', { class: 'element-label' }, [txt(element.label + (element.required ? ' *' : ''))]));
  head.append(el('span', { class: 'element-meta' }, [txt(bits.join(' | '))]));
  card.append(head);
  card.append(inertControl(element));
  return card;
}

function inertControl(element) {
  var h = el('div', { class: 'element-preview' });
  switch (element.type) {
    case 'text':
      h.append(textCell('prev-' + element.id, element.placeholder, function() {}));
      break;
    case 'textarea':
      h.append(areaCell('prev-' + element.id, '', function () {}));
      break;
    case 'integer': case 'decimal':
      h.append(textCell('prev-' + element.id, '', function () {}));
      h.append(el('span', { class: 'units' }, [txt(element.units)]));
      break;
    case 'date':
      h.append(textCell('prev-' + element.id, '', function () {}));
      h.append(el('span', { class: 'hint' }, [txt('DD-MMM-YYYY')]));
      break;
    case 'time':
      h.append(textCell('prev-' + element.id, '', function () {}));
      h.append(el('span', { class: 'hint' }, [txt('HH:MM')]));
      break;
    case 'datetime':
      h.append(textCell('prev-' + element.id, '', function () {}));
      h.append(el('span', { class: 'hint' }, [txt('DD-MMM-YYYY HH:MM')]));
      break;
    case 'boolean':
      var onBox = clickBox('prev-yes-' + element.id, 'Yes', 'clickable small', function () {});
      var offBox = clickBox('prev-no-' + element.id, 'No', 'clickable small', function () {});
      h.append(onBox, offBox);
      break;
    case 'single_select':
      var opts = element.values.map(function (v) { return { value: v.code, label: v.label }; });
      h.append(dropList('prev-' + element.id, opts, '', function () {}));
      break;
    case 'multi_select': case 'radio':
      element.values.forEach(function (v) {
        var pick = el('div', { class: 'choice-pick' });
        var box = toggleBox('prev-' + element.id + '-' + v.code, false, function () {});
        pick.append(box, el('span', { class: 'choice-text' }, [txt(v.label)]));
        h.append(pick);
      });
      if (element.values.length === 0) h.append(el('span', { class: 'element-meta' }, [txt('No values defined.')]));
      break;
    case 'checkbox':
      var cPick = el('div', { class: 'choice-pick' });
      var cBox = toggleBox('prev-' + element.id, false, function () {});
      cPick.append(cBox, el('span', { class: 'choice-text' }, [txt(element.label)]));
      h.append(cPick);
      break;
    case 'calculated':
      h.append(textCell('prev-' + element.id, element.formula ? '= ' + element.formula : '= (no formula)', function () {}));
      break;
  }
  return h;
}

function optionsColumn() {
  var col = el('div', { class: 'options-panel' }, [el('div', { class: 'card-title' }, [el('span', {}, [txt('Properties')])])]);
  var element = selectedElement();
  if (!element) {
    col.append(el('div', { class: 'empty' }, [el('span', {}, [txt('Select a fragment on the canvas to edit its properties.')])]));
    return col;
  }
  var def = FIELD_TYPE_DEFS[element.type];
  var working = state.ui.builder.working;

  var labelInput = textCell('opt-label', element.label, function (v) { patchSelected({ label: v }); });
  col.append(labeled('opt-label', 'Label', labelInput));

  var typeOpts = ELEMENT_TYPES.map(function (t) { return { value: t.canonical, label: t.label }; });
  var typeDrop = dropList('opt-type', typeOpts, element.type, function (v) { setSelectedType(v); });
  col.append(labeled('opt-type', 'Fragment Type', typeDrop));

  var reqWrap = el('div', { class: 'field-row inline' });
  var req = toggleBox('opt-required', element.required, function (v) { patchSelected({ required: v }); });
  reqWrap.append(req, el('span', { class: 'field-label' }, [txt('Required')]));
  col.append(reqWrap);

  var hidWrap = el('div', { class: 'field-row inline' });
  var hid = toggleBox('opt-hidden', element.hidden, function (v) { patchSelected({ hidden: v }); });
  hidWrap.append(hid, el('span', { class: 'field-label' }, [txt('Hidden')]));
  col.append(hidWrap);

  if (def.hasRange) {
    var group = el('div', { class: 'group-box' }, [el('div', { class: 'group-label' }, [el('span', {}, [txt('Range Check')])])]);
    var minInput = textCell('opt-min', element.min, function (v) { patchSelected({ min: v }); });
    var maxInput = textCell('opt-max', element.max, function (v) { patchSelected({ max: v }); });
    var unitsInput = textCell('opt-units', element.units, function (v) { patchSelected({ units: v }); });
    group.append(labeled('opt-min', 'Minimum', minInput), labeled('opt-max', 'Maximum', maxInput), labeled('opt-units', 'Units', unitsInput));
    if (element.type === 'decimal') {
      var dpInput = textCell('opt-dp', element.decimalPlaces, function (v) { patchSelected({ decimalPlaces: v }); });
      group.append(labeled('opt-dp', 'Decimal Places', dpInput));
    }
    col.append(group);
  }

  if (def.hasFormula) {
    var formulaInput = textCell('opt-formula', element.formula, function (v) { patchSelected({ formula: v }); });
    col.append(labeled('opt-formula', 'Formula', formulaInput));
  }

  if (def.hasOptions) {
    var vgroup = el('div', { class: 'group-box' }, [el('div', { class: 'group-label' }, [el('span', {}, [txt('Values')])])]);
    element.values.forEach(function (v, i) {
      var vr = el('div', { class: 'value-row' });
      var codeInput = textCell('val-code-' + i, v.code, function (c) { setValueCode(i, c); });
      var labelInput2 = textCell('val-label-' + i, v.label, function (l) { setValueLabel(i, l); });
      var rm = clickBox('val-rm-' + i, 'x', 'clickable small danger', function () { removeValue(i); });
      var codeWrap = labeled('val-code-' + i, 'Code', codeInput);
      var labelWrap = labeled('val-label-' + i, 'Label', labelInput2);
      codeWrap.setAttribute('class', 'field-row value-field');
      labelWrap.setAttribute('class', 'field-row value-field');
      vr.append(codeWrap, labelWrap, rm);
      vgroup.append(vr);
    });
    vgroup.append(clickBox('val-add', '+ Add Value', 'clickable small', function () { addValue(); }));
    var paste = areaCell('val-paste', state.ui.builder.pasteText, function (v) { setPasteText(v); });
    vgroup.append(labeled('val-paste', 'Paste Values (replaces list)', paste));
    vgroup.append(clickBox('val-paste-apply', 'Apply Pasted Values', 'clickable small', function () { applyPasteValues(); }));
    col.append(vgroup);
  }

  // Visibility / skip logic
  var visGroup = el('div', { class: 'group-box' }, [el('div', { class: 'group-label' }, [el('span', {}, [txt('Fragment Visibility')])])]);
  var visOpts = [
    { value: 'always', label: 'Visible' },
    { value: 'when', label: 'Visible When...' }
  ];
  var visDrop = dropList('opt-vis', visOpts, element.visibility.mode, function (v) { setVisibilityMode(v); });
  visGroup.append(labeled('opt-vis', 'Visibility', visDrop));
  if (element.visibility.mode === 'when') {
    var whenOpts = [{ value: '', label: '-- choose fragment --' }];
    (working ? working.pages : []).forEach(function (p) {
      p.elements.forEach(function (o) {
        if (o.id === element.id) return;
        whenOpts.push({ value: o.id, label: o.label });
      });
    });
    var whenDrop = dropList('opt-vis-when', whenOpts, element.visibility.whenElementId, function (v) { setVisibilityWhen(v); });
    visGroup.append(labeled('opt-vis-when', 'When Fragment', whenDrop));
    var eqInput = textCell('opt-vis-val', element.visibility.equalsValue, function (v) { setVisibilityValue(v); });
    visGroup.append(labeled('opt-vis-val', 'Equals Value', eqInput));
  }
  col.append(visGroup);
  col.append(clickBox('opt-delete', 'Delete Fragment', 'clickable danger', function () { deleteSelectedElement(); }));
  return col;
}

function previewModal() {
  var working = state.ui.builder.working;
  var overlay = el('div', { class: 'modal-overlay' });
  var panel = el('div', { class: 'modal' });
  panel.append(el('div', { class: 'card-title' }, [el('span', {}, [txt('Preview -- ' + working.name)])]));
  working.pages.forEach(function (p) {
    panel.append(el('div', { class: 'section-title' }, [el('span', {}, [txt(p.name)])]));
    p.elements.filter(function (e) { return !e.hidden; }).forEach(function (e) {
      var row = el('div', { class: 'preview-row' });
      row.append(el('span', { class: 'element-label' }, [txt(e.label + (e.required ? ' *' : ''))]));
      row.append(inertControl(e));
      panel.append(row);
    });
  });
  var actions = el('div', { class: 'actions' });
  actions.append(clickBox('preview-close', 'Close Preview', 'clickable primary', function () { closePreview(); }));
  panel.append(actions);
  overlay.append(panel);
  return overlay;
}

// Mount and render loop
function render() { document.getElementById('root').replaceChildren(build()); }
subscribe(render);
render();