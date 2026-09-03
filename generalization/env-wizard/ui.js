'use strict';

// ============================================================
// FormCraft Studio -- env-wizard (UI rendering)
//
// Wizard-style: one question/element per step, Next/Back nav.
// Commit lives behind hamburger menu.
// Element library = modal grid with icon-only tiles.
// 3 tiles (calculated, time, datetime) have NO accessible name.
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
  // Topbar with hamburger menu
  app.append(buildTopbar());
  var main = el('div', { class: 'content' });
  app.append(main);
  if (state.ui.route.kind === 'plan') { planScreen().forEach(function(n) { main.append(n); }); }
  else if (state.ui.route.kind === 'visit') { visitScreen().forEach(function(n) { main.append(n); }); }
  else if (state.ui.route.kind === 'builder') { main.append(builderScreen()); }
  // Modals
  if (state.ui.builder.libraryOpen) app.append(libraryModal());
  if (state.ui.builder.previewOpen && state.ui.builder.working) app.append(previewModal());
  return app;
}

function buildTopbar() {
  var bar = el('div', { class: 'topbar' }, [
    el('span', { class: 'topbar-brand' }, [text(PLATFORM_LABEL)]),
  ]);
  // Hamburger button
  var burger = el('button', { type: 'button', class: 'hamburger', id: 'hamburger-btn' }, [text('\u2630')]);
  burger.addEventListener('click', function() { toggleHamburger(); });
  bar.append(burger);

  // Hamburger dropdown
  if (state.ui.hamburgerOpen) {
    var menu = el('div', { class: 'hamburger-menu' });
    if (state.ui.route.kind === 'builder') {
      // Commit (Save) -- lives in hamburger menu
      var commitBtn = el('button', { type: 'button', class: 'hamburger-item commit', id: 'menu-commit' }, [text('Commit')]);
      commitBtn.addEventListener('click', function() { commitWorking(); });
      menu.append(commitBtn);
      var publishBtn = el('button', { type: 'button', class: 'hamburger-item', id: 'menu-publish' }, [text('Publish')]);
      publishBtn.addEventListener('click', function() { publishWorking(); });
      menu.append(publishBtn);
      var previewBtn = el('button', { type: 'button', class: 'hamburger-item', id: 'menu-preview' }, [text('Preview')]);
      previewBtn.addEventListener('click', function() { openPreview(); closeHamburger(); });
      menu.append(previewBtn);
      var sep = el('div', { style: 'height:1px;background:#313244;margin:4px 0;' });
      menu.append(sep);
    }
    var studyRouteBtn = el('button', { type: 'button', class: 'hamburger-item', id: 'menu-study-route' }, [text('Study Route')]);
    studyRouteBtn.addEventListener('click', function() { navigate({ kind: 'plan' }); });
    menu.append(studyRouteBtn);
    bar.append(menu);
  }
  return bar;
}

// ---- Plan screen (Study Route) ----
function planScreen() {
  var nodes = [el('h2', {}, [text('Study Route')])];
  var table = el('table', { class: 'grid' });
  table.append(el('thead', {}, [el('tr', {}, [
    el('th', {}, [text('Stop')]),
    el('th', {}, [text('Window (days)')]),
    el('th', {}, [text('Question Sets')]),
    el('th', {}, [text('')]),
  ])]));
  var body = el('tbody', {});
  state.study.visits.forEach(function(v) {
    var open = el('button', { type: 'button', class: 'link-btn', id: 'open-visit-' + v.id }, [text(v.name)]);
    open.addEventListener('click', function() { navigate({ kind: 'visit', visitId: v.id }); });
    body.append(el('tr', {}, [
      el('td', {}, [open]),
      el('td', {}, [text(v.windowStart + ' to ' + v.windowEnd)]),
      el('td', {}, [text(String(v.forms.length))]),
      el('td', {}, []),
    ]));
  });
  if (state.study.visits.length === 0) body.append(el('tr', {}, [el('td', { colspan: '4', class: 'empty' }, [text('No stops defined.')])]));
  table.append(body);
  nodes.push(table);
  nodes.push(btn('add-visit', '+ Add Stop', 'btn primary', function() { openVisitForm(); }));

  if (state.ui.visitFormOpen) {
    var card = el('div', { class: 'card' }, [el('h3', {}, [text('New Stop')])]);
    var name = el('input', { type: 'text' });
    name.addEventListener('input', function() { setVisitDraft({ name: name.value }); });
    var start = el('input', { type: 'text' });
    start.addEventListener('input', function() { setVisitDraft({ windowStart: start.value }); });
    var end = el('input', { type: 'text' });
    end.addEventListener('input', function() { setVisitDraft({ windowEnd: end.value }); });
    card.append(
      labelled('visit-name', 'Stop Name', name),
      labelled('visit-start', 'Window Start (day)', start),
      labelled('visit-end', 'Window End (day)', end),
      el('div', { class: 'actions' }, [
        btn('save-visit', 'Create Stop', 'btn primary', function() { saveVisit(); }),
        btn('cancel-visit', 'Cancel', 'btn', function() { cancelVisitForm(); }),
      ])
    );
    nodes.push(card);
  }
  return nodes;
}

// ---- Visit screen ----
function visitScreen() {
  var visit = currentVisit();
  if (!visit) return [el('p', {}, [text('Stop not found.')])];
  var nodes = [
    el('p', { class: 'breadcrumb' }, [text('Study Route / ' + visit.name)]),
    btn('back-to-plan', '<- Back', 'btn small', function() { navigate({ kind: 'plan' }); }),
    el('h2', {}, [text(visit.name + ' -- Question Sets')]),
  ];
  var table = el('table', { class: 'grid' });
  table.append(el('thead', {}, [el('tr', {}, [
    el('th', {}, [text('Set')]),
    el('th', {}, [text('Version')]),
    el('th', {}, [text('Status')]),
    el('th', {}, [text('Type')]),
    el('th', {}, [text('Actions')]),
  ])]));
  var body = el('tbody', {});
  visit.forms.forEach(function(f) {
    var actions = el('td', {});
    if (f.status === 'draft') {
      actions.append(btn('edit-' + f.id, 'Modify', 'btn small', function() { openBuilder(visit.id, f.id); }));
      actions.append(btn('activate-' + f.id, 'Publish', 'btn small', function() { activateForm(visit.id, f.id); }));
    } else {
      actions.append(btn('newver-' + f.id, 'Branch New Version', 'btn small', function() { createNewVersion(visit.id, f.id); }));
    }
    actions.append(btn('delete-' + f.id, 'Remove', 'btn small danger', function() { deleteForm(visit.id, f.id); }));
    body.append(el('tr', {}, [
      el('td', {}, [text(f.name)]),
      el('td', {}, [text('v' + f.version)]),
      el('td', {}, [el('span', { class: 'chip ' + f.status }, [text(f.status === 'draft' ? 'Draft' : 'Published')])]),
      el('td', {}, [text(f.repeating ? 'Repeating log' : 'Standard')]),
      actions,
    ]));
  });
  if (visit.forms.length === 0) body.append(el('tr', {}, [el('td', { colspan: '5', class: 'empty' }, [text('No question sets.')])]));
  table.append(body);
  nodes.push(table);
  nodes.push(btn('new-form', '+ Add Question Set', 'btn primary', function() { openFormForm(); }));

  if (state.ui.formFormOpen) {
    var card = el('div', { class: 'card' }, [el('h3', {}, [text('New Question Set')])]);
    var name = el('input', { type: 'text' });
    name.addEventListener('input', function() { setFormDraft({ name: name.value }); });
    var rep = el('input', { type: 'checkbox' });
    rep.addEventListener('change', function() { setFormDraft({ repeating: rep.checked }); });
    card.append(
      labelled('form-name', 'Set Name', name),
      el('div', { class: 'row checkbox' }, [rep, el('label', { for: 'form-repeating' }, [text('Repeating log (many records per stop)')])]),
      el('div', { class: 'actions' }, [
        btn('create-form', 'Create', 'btn primary', function() { createForm(); }),
        btn('cancel-form', 'Cancel', 'btn', function() { cancelFormForm(); }),
      ])
    );
    nodes.push(card);
  }
  return nodes;
}

// ---- Builder screen (wizard) ----
function builderScreen() {
  var visit = currentVisit();
  var working = state.ui.builder.working;
  if (!visit || !working) return el('p', {}, [text('Question set not found.')]);
  var wrap = el('div', {});

  // Wizard bar
  var info = wizardStepInfo();
  var statusBits = ['v' + working.version, working.status === 'draft' ? 'Draft' : 'Published'];
  if (state.ui.builder.dirty) statusBits.push('Uncommitted changes');
  var stepLabel = '';
  if (info.current === 'overview') stepLabel = 'Step ' + (info.index + 1) + ' of ' + info.total + ' -- Overview';
  else if (typeof info.current === 'object') {
    var e = selectedElement();
    var fieldName = info.current.field.charAt(0).toUpperCase() + info.current.field.slice(1);
    stepLabel = 'Step ' + (info.index + 1) + ' of ' + info.total + ' -- ' + (e ? e.label : '') + ': ' + fieldName;
  }

  var back = btn('builder-back', '<- ' + visit.name, 'btn small', function() { navigate({ kind: 'visit', visitId: visit.id }); });
  var addElementBtn = btn('builder-add-element', '+ Add Element', 'btn primary', function() { openLibrary(); });
  
  wrap.append(el('div', { class: 'wizard-bar' }, [
    el('div', {}, [back, el('span', { class: 'wizard-title', style: 'margin-left:8px;' }, [text(working.name)]), el('span', { class: 'wizard-status', style: 'margin-left:8px;' }, [text(statusBits.join(' | '))])]),
    addElementBtn,
  ]));

  if (state.ui.builder.notice) wrap.append(el('div', { class: 'toast' }, [text(state.ui.builder.notice)]));

  // Page tabs
  var tabs = el('div', { class: 'page-tabs', style: 'margin-bottom:10px;' });
  working.pages.forEach(function(p) {
    var t = el('button', { type: 'button', class: 'page-tab' + (p.id === state.ui.builder.selectedPageId ? ' active' : ''), id: 'page-tab-' + p.id, style: 'border:1px solid #313244;background:' + (p.id === state.ui.builder.selectedPageId ? '#cba6f7' : '#181825') + ';color:' + (p.id === state.ui.builder.selectedPageId ? '#11111b' : '#cdd6f4') + ';padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;' }, [text(p.name)]);
    t.addEventListener('click', function() { selectPage(p.id); });
    tabs.append(t);
  });
  tabs.append(btn('add-page', '+ Page', 'btn small', function() { addPage(); }));
  wrap.append(tabs);

  // Wizard step content
  var stepContent = el('div', { class: 'wizard-step' });
  stepContent.append(el('div', { class: 'step-number' }, [text(stepLabel)]));

  if (info.current === 'overview') {
    stepContent.append(buildOverviewStep());
  } else if (typeof info.current === 'object') {
    stepContent.append(buildElementStep(info.current));
  }

  // Navigation
  var nav = el('div', { class: 'step-nav' });
  nav.append(btn('wizard-back', '<- Back', 'btn', function() { wizardBack(); }));
  if (info.index < info.total - 1) {
    nav.append(btn('wizard-next', 'Next ->', 'btn primary', function() { wizardNext(); }));
  } else {
    nav.append(btn('wizard-done', 'Done', 'btn primary', function() { navigate({ kind: 'visit', visitId: visit.id }); }));
  }
  stepContent.append(nav);
  wrap.append(stepContent);

  return wrap;
}

function buildOverviewStep() {
  var page = selectedPage();
  var container = el('div', {});
  if (!page || page.elements.length === 0) {
    container.append(el('p', { class: 'empty' }, [text('No elements yet. Click "Add Element" to start building your question set.')])); 
    return container;
  }
  page.elements.forEach(function(e) {
    var card = el('div', { class: 'element-card' + (e.id === state.ui.builder.selectedElementId ? ' selected' : ''), id: 'element-' + e.id });
    card.addEventListener('click', function() { selectElement(e.id); });
    var bits = [typeLabel(e.type)];
    if (e.required) bits.push('Required');
    if (e.hidden) bits.push('Hidden');
    if (e.visibility.mode === 'when') bits.push('Conditional');
    card.append(el('div', { class: 'element-head' }, [
      el('span', { class: 'element-label' }, [text(e.label + (e.required ? ' *' : ''))]),
      el('span', { class: 'element-meta' }, [text(bits.join(' | '))]),
    ]));
    container.append(card);
  });
  return container;
}

function buildElementStep(step) {
  var element = selectedElement();
  if (!element) return el('p', { class: 'empty' }, [text('Element not found.')]);
  var container = el('div', {});

  switch (step.field) {
    case 'label':
      var labelInput = el('input', { type: 'text' });
      labelInput.value = element.label;
      labelInput.addEventListener('input', function() { patchSelected({ label: labelInput.value }); });
      container.append(labelled('opt-label', 'Question Text', labelInput));
      break;

    case 'type':
      var typeSelect = el('select', {});
      ELEMENT_TYPES.forEach(function(t) {
        var o = el('option', { value: t.canonical }, [text(t.label)]);
        if (t.canonical === element.type) o.setAttribute('selected', 'selected');
        typeSelect.append(o);
      });
      typeSelect.addEventListener('change', function() { setSelectedType(typeSelect.value); });
      container.append(labelled('opt-type', 'Answer Type', typeSelect));
      break;

    case 'required':
      var req = el('input', { type: 'checkbox' });
      if (element.required) req.setAttribute('checked', 'checked');
      req.addEventListener('change', function() { patchSelected({ required: req.checked }); });
      container.append(el('div', { class: 'row checkbox' }, [req, el('label', { for: 'opt-required' }, [text('Required answer')])]));
      var hid = el('input', { type: 'checkbox' });
      if (element.hidden) hid.setAttribute('checked', 'checked');
      hid.addEventListener('change', function() { patchSelected({ hidden: hid.checked }); });
      container.append(el('div', { class: 'row checkbox' }, [hid, el('label', { for: 'opt-hidden' }, [text('Hidden by default')])]));
      break;

    case 'options':
      var def = FIELD_TYPE_DEFS[element.type];
      if (def.hasOptions) {
        container.append(el('h3', {}, [text('Coded Values')]));
        element.values.forEach(function(v, i) {
          var c = el('input', { type: 'text', class: 'narrow' });
          c.value = v.code;
          c.addEventListener('input', function() { setValueCode(i, c.value); });
          var l = el('input', { type: 'text' });
          l.value = v.label;
          l.addEventListener('input', function() { setValueLabel(i, l.value); });
          var rm = btn('val-rm-' + i, 'x', 'btn small danger', function() { removeValue(i); });
          container.append(el('div', { class: 'value-row' }, [
            labelled('val-code-' + i, 'Code', c),
            labelled('val-label-' + i, 'Label', l),
            rm,
          ]));
        });
        container.append(btn('val-add', '+ Add Value', 'btn small', function() { addValue(); }));
        var paste = el('textarea', { rows: '3', placeholder: 'code=Label, one per line' });
        paste.addEventListener('input', function() { setPasteText(paste.value); });
        container.append(labelled('val-paste', 'Paste Values (replaces list)', paste));
        container.append(btn('val-paste-apply', 'Apply Pasted Values', 'btn small', function() { applyPasteValues(); }));
      }
      break;

    case 'range':
      var rdef = FIELD_TYPE_DEFS[element.type];
      if (rdef.hasRange) {
        container.append(el('h3', {}, [text('Range Check')]));
        var min = el('input', { type: 'text' }); min.value = element.min;
        min.addEventListener('input', function() { patchSelected({ min: min.value }); });
        var max = el('input', { type: 'text' }); max.value = element.max;
        max.addEventListener('input', function() { patchSelected({ max: max.value }); });
        var units = el('input', { type: 'text' }); units.value = element.units;
        units.addEventListener('input', function() { patchSelected({ units: units.value }); });
        container.append(labelled('opt-min', 'Minimum', min), labelled('opt-max', 'Maximum', max), labelled('opt-units', 'Units', units));
        if (element.type === 'decimal') {
          var dp = el('input', { type: 'text' }); dp.value = element.decimalPlaces;
          dp.addEventListener('input', function() { patchSelected({ decimalPlaces: dp.value }); });
          container.append(labelled('opt-dp', 'Decimal Places', dp));
        }
      }
      break;

    case 'formula':
      var fdef = FIELD_TYPE_DEFS[element.type];
      if (fdef.hasFormula) {
        container.append(el('h3', {}, [text('Formula')]));
        var f = el('input', { type: 'text', placeholder: 'e.g. Weight / (Height / 100) ^ 2' });
        f.value = element.formula;
        f.addEventListener('input', function() { patchSelected({ formula: f.value }); });
        container.append(labelled('opt-formula', 'Expression', f));
      }
      break;

    case 'visibility':
      container.append(el('h3', {}, [text('Element Visibility')]));
      var mode = el('select', {});
      mode.append(el('option', { value: 'always' }, [text('Visible')]), el('option', { value: 'when' }, [text('Visible When...')]));
      if (element.visibility.mode === 'when') mode.children[1].setAttribute('selected', 'selected');
      mode.addEventListener('change', function() { setVisibilityMode(mode.value); });
      container.append(labelled('opt-vis', 'Visibility', mode));
      if (element.visibility.mode === 'when') {
        var when = el('select', {});
        when.append(el('option', { value: '' }, [text('--- choose element ---')]));
        var working = state.ui.builder.working;
        (working ? working.pages : []).forEach(function(p) {
          p.elements.forEach(function(o) {
            if (o.id === element.id) return;
            var opt = el('option', { value: o.id }, [text(o.label)]);
            if (o.id === element.visibility.whenElementId) opt.setAttribute('selected', 'selected');
            when.append(opt);
          });
        });
        when.addEventListener('change', function() { setVisibilityWhen(when.value); });
        var eq = el('input', { type: 'text' }); eq.value = element.visibility.equalsValue;
        eq.addEventListener('input', function() { setVisibilityValue(eq.value); });
        container.append(labelled('opt-vis-when', 'When Element', when), labelled('opt-vis-val', 'Equals Value', eq));
      }
      // Delete element button
      container.append(el('div', { style: 'margin-top:16px;' }, [btn('opt-delete', 'Delete Element', 'btn danger', function() { deleteSelectedElement(); })]));
      break;
  }
  return container;
}

// ---- Element library modal (icon grid) ----
function libraryModal() {
  var panel = el('div', { class: 'element-grid', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add Element' });
  panel.append(el('h3', {}, [text('Add Element')]));
  var filter = el('input', { type: 'text', placeholder: 'Filter...' });
  filter.value = state.ui.builder.libraryFilter;
  filter.addEventListener('input', function() { setLibraryFilter(filter.value); });
  panel.append(filter);

  var grid = el('div', { class: 'tile-grid' });
  var needle = state.ui.builder.libraryFilter.trim().toLowerCase();
  ELEMENT_TYPES.forEach(function(def) {
    // For icon-only types, filtering by label still works (label exists internally, just not shown)
    if (needle && def.label.toLowerCase().indexOf(needle) === -1) return;
    var iconOnly = ICON_ONLY_TYPES[def.canonical];
    var tile;
    if (iconOnly) {
      // Icon-only tile: NO accessible name, NO aria-label, NO text label
      tile = el('button', { type: 'button', class: 'icon-tile', id: 'tile-' + def.canonical }, [
        el('span', { class: 'tile-icon' }, [text(TYPE_ICONS[def.canonical] || '?')]),
      ]);
    } else {
      tile = el('button', { type: 'button', class: 'icon-tile', id: 'tile-' + def.canonical }, [
        el('span', { class: 'tile-icon' }, [text(TYPE_ICONS[def.canonical] || '?')]),
        el('span', { class: 'tile-label' }, [text(def.label)]),
      ]);
    }
    tile.addEventListener('click', function() { addElement(def.canonical); });
    grid.append(tile);
  });
  panel.append(grid);
  panel.append(el('div', { class: 'actions' }, [btn('library-close', 'Close', 'btn', function() { closeLibrary(); })]));
  return el('div', { class: 'modal-overlay' }, [panel]);
}

// ---- Preview modal ----
function previewModal() {
  var working = state.ui.builder.working;
  var panel = el('div', { class: 'element-grid', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Preview' });
  panel.append(el('h3', {}, [text('Preview -- ' + working.name)]));
  working.pages.forEach(function(p) {
    panel.append(el('h4', {}, [text(p.name)]));
    p.elements.filter(function(e) { return !e.hidden; }).forEach(function(e) {
      var row = el('div', { class: 'preview-row' }, [
        el('span', { class: 'element-label' }, [text(e.label + (e.required ? ' *' : ''))]),
        inertControl(e),
      ]);
      panel.append(row);
    });
  });
  panel.append(el('div', { class: 'actions' }, [btn('preview-close', 'Close Preview', 'btn primary', function() { closePreview(); })]));
  return el('div', { class: 'modal-overlay' }, [panel]);
}

// ---- Inert preview controls ----
function inertControl(element) {
  var h = el('div', { class: 'element-preview' });
  switch (element.type) {
    case 'text':
      h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: element.placeholder }));
      break;
    case 'textarea':
      h.append(el('textarea', { rows: '2', 'aria-label': element.label }));
      break;
    case 'integer': case 'decimal':
      h.append(el('input', { type: 'text', 'aria-label': element.label, class: 'narrow' }), el('span', { class: 'units' }, [text(element.units)]));
      break;
    case 'date':
      h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'DD-MMM-YYYY', class: 'narrow' }));
      break;
    case 'time':
      h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'HH:MM', class: 'narrow' }));
      break;
    case 'datetime':
      h.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'DD-MMM-YYYY HH:MM', class: 'narrow' }));
      break;
    case 'boolean':
      h.append(el('button', { type: 'button', class: 'btn small' }, [text('Yes')]), el('button', { type: 'button', class: 'btn small' }, [text('No')]));
      break;
    case 'single_select':
      var s = el('select', { 'aria-label': element.label });
      s.append(el('option', {}, [text('--- Select ---')]));
      element.values.forEach(function(v) { s.append(el('option', {}, [text(v.label)])); });
      h.append(s);
      break;
    case 'multi_select': case 'radio':
      var kind = element.type === 'radio' ? 'radio' : 'checkbox';
      element.values.forEach(function(v) {
        h.append(el('span', { class: 'choice' }, [el('input', { type: kind, 'aria-label': element.label + ': ' + v.label }), text(v.label)]));
      });
      if (element.values.length === 0) h.append(el('span', { class: 'element-meta' }, [text('No values defined.')]));
      break;
    case 'checkbox':
      h.append(el('span', { class: 'choice' }, [el('input', { type: 'checkbox', 'aria-label': element.label }), text(element.label)]));
      break;
    case 'calculated':
      h.append(el('input', { type: 'text', 'aria-label': element.label, readonly: 'readonly', value: element.formula ? '= ' + element.formula : '= (no formula)' }));
      break;
  }
  return h;
}

// Mount and render loop
function render() { document.getElementById('root').replaceChildren(build()); }
subscribe(render);
render();