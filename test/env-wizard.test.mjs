import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const wizardDir = join(__dirname2, '..', 'generalization', 'env-wizard');

function loadWizard() {
  let html = readFileSync(join(wizardDir, 'index.html'), 'utf8');
  const coreScript = readFileSync(join(wizardDir, 'core.js'), 'utf8');
  const uiScript = readFileSync(join(wizardDir, 'ui.js'), 'utf8');
  html = html.replace(
    '<script src="core.js"></script>\n<script src="ui.js"></script>',
    '<script>' + coreScript + '</script>\n<script>' + uiScript + '</script>'
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  return dom.window;
}

function setupBuilder(w) {
  w.eval([
    '(function() {',
    '  var v = { id: "v1", name: "V1", windowStart: "0", windowEnd: "7", forms: [] };',
    '  var f = { id: "f1", name: "F1", repeating: false, status: "draft", version: 1, pages: [{ id: "pg1", name: "P1", elements: [] }] };',
    '  v.forms.push(f);',
    '  commit(Object.assign({}, state, { study: { name: "ABC-101", visits: [v] } }));',
    '  openBuilder("v1", "f1");',
    '})();',
  ].join('\n'));
}

test('env-wizard: loads and renders initial plan screen', () => {
  const w = loadWizard();
  const root = w.document.getElementById('root');
  assert.ok(root, 'root element exists');
  assert.ok(root.innerHTML.length > 0, 'root has rendered content');
  assert.ok(root.innerHTML.includes('Study Route'), 'shows Study Route heading');
  assert.ok(root.innerHTML.includes('FormCraft Studio'), 'shows platform brand');
  assert.ok(root.querySelector('.hamburger'), 'hamburger button present');
  assert.ok(!root.innerHTML.includes('\u2014'), 'no em-dashes in rendered HTML');
  assert.ok(!root.innerHTML.includes('\u2013'), 'no en-dashes in rendered HTML');
});

test('env-wizard: ground truth export works', () => {
  const w = loadWizard();
  assert.equal(typeof w.__groundTruth, 'function', '__groundTruth is a function');
  assert.equal(typeof w.__resetState, 'function', '__resetState is a function');
  assert.equal(w.__mockPlatform, 'env-wizard', '__mockPlatform set');
  const gt = w.__groundTruth();
  assert.equal(gt.platform, 'env-wizard');
  assert.equal(gt.specVersion, 'formcraft/1.0.0');
  assert.ok(gt.study, 'study exists in ground truth');
  assert.ok(Array.isArray(gt.study.visits), 'visits array exists');
});

test('env-wizard: all 13 canonical types are defined', () => {
  const w = loadWizard();
  const types = w.ELEMENT_TYPES.map(t => t.canonical);
  const expected = ['calculated', 'multi_select', 'checkbox', 'date', 'datetime',
    'single_select', 'textarea', 'decimal', 'integer', 'radio', 'text', 'time', 'boolean'];
  for (const t of expected) {
    assert.ok(types.includes(t), 'canonical type ' + t + ' present');
  }
  assert.equal(types.length, 13, 'exactly 13 types');
});

test('env-wizard: vocabulary is distinct from mock and env-rosetta', () => {
  const w = loadWizard();
  const labels = w.ELEMENT_TYPES.map(t => t.label).join(' ');
  const mockLabels = ['Check List', 'Checkbox', 'Dropdown', 'Radio Buttons', 'Yes/No Toggle',
    'Single Line Textbox', 'Multi-line Textbox', 'Number (Decimal)', 'Number (Whole)',
    'Calculated Field', 'Date', 'Date/Time', 'Save', 'Activate'];
  for (const ml of mockLabels) {
    assert.ok(!labels.includes(ml), 'mock label "' + ml + '" not used');
  }
  const rosettaLabels = ['Derived Value', 'Single Choice Box', 'Multi Choice Box', 'Calendar Day',
    'Stamp', 'Picker', 'Long String', 'Fractional Number', 'Whole Number', 'Dial Group',
    'Free String', 'Clock Time', 'Binary Flip'];
  for (const rl of rosettaLabels) {
    assert.ok(!labels.includes(rl), 'rosetta label "' + rl + '" not used');
  }
});

test('env-wizard: icon-only tiles have no accessible name for calculated, time, datetime', () => {
  const w = loadWizard();
  assert.ok(w.ICON_ONLY_TYPES.calculated, 'calculated is icon-only');
  assert.ok(w.ICON_ONLY_TYPES.time, 'time is icon-only');
  assert.ok(w.ICON_ONLY_TYPES.datetime, 'datetime is icon-only');

  setupBuilder(w);
  w.openLibrary();
  const root = w.document.getElementById('root');

  const calcTile = root.querySelector('#tile-calculated');
  const timeTile = root.querySelector('#tile-time');
  const dtTile = root.querySelector('#tile-datetime');

  assert.ok(calcTile, 'calculated tile exists');
  assert.ok(timeTile, 'time tile exists');
  assert.ok(dtTile, 'datetime tile exists');

  assert.ok(!calcTile.hasAttribute('aria-label'), 'calculated tile has no aria-label');
  assert.ok(!timeTile.hasAttribute('aria-label'), 'time tile has no aria-label');
  assert.ok(!dtTile.hasAttribute('aria-label'), 'datetime tile has no aria-label');

  assert.ok(!calcTile.querySelector('.tile-label'), 'calculated tile has no tile-label');
  assert.ok(!timeTile.querySelector('.tile-label'), 'time tile has no tile-label');
  assert.ok(!dtTile.querySelector('.tile-label'), 'datetime tile has no tile-label');

  assert.ok(calcTile.querySelector('.tile-icon'), 'calculated tile has an icon');
  assert.ok(timeTile.querySelector('.tile-icon'), 'time tile has an icon');
  assert.ok(dtTile.querySelector('.tile-icon'), 'datetime tile has an icon');

  const textTile = root.querySelector('#tile-text');
  assert.ok(textTile, 'text tile exists');
  assert.ok(textTile.querySelector('.tile-label'), 'text tile has a visible label');
});

test('env-wizard: Commit lives in hamburger menu, not on builder bar', () => {
  const w = loadWizard();
  setupBuilder(w);

  const root = w.document.getElementById('root');
  const hamburger = root.querySelector('.hamburger');
  assert.ok(hamburger, 'hamburger button present');

  const commitBeforeOpen = root.querySelector('#menu-commit');
  assert.ok(!commitBeforeOpen, 'Commit button not visible before hamburger open');

  w.toggleHamburger();
  const root2 = w.document.getElementById('root');
  const commitBtn = root2.querySelector('#menu-commit');
  assert.ok(commitBtn, 'Commit button appears in hamburger menu');
  assert.ok(commitBtn.textContent.includes('Commit'), 'Commit button has text "Commit"');

  const visibleText = root2.textContent || '';
  assert.ok(!visibleText.includes('Save'), 'no "Save" text visible in UI');
});

test('env-wizard: wizard navigation -- add element, step through, commit, verify ground truth', () => {
  const w = loadWizard();
  setupBuilder(w);

  w.addElement('text');

  let info = w.wizardStepInfo();
  assert.ok(info.total > 1, 'wizard has multiple steps after adding element');

  let idxBefore = info.index;
  w.wizardNext();
  let info2 = w.wizardStepInfo();
  assert.ok(info2.index > idxBefore, 'wizard step advanced');

  w.wizardBack();
  let info3 = w.wizardStepInfo();
  assert.equal(info3.index, idxBefore, 'wizard step went back');

  w.commitWorking();
  const gt = w.__groundTruth();
  assert.equal(gt.study.visits[0].forms[0].fields.length, 1, 'one field committed');
  assert.equal(gt.study.visits[0].forms[0].fields[0].type, 'text', 'field type is text');
});

test('env-wizard: type-change clears range for non-range types', () => {
  const w = loadWizard();
  setupBuilder(w);

  w.addElement('integer');
  w.patchSelected({ min: '0', max: '100', units: 'mg' });

  w.setSelectedType('text');

  const el = w.selectedElement();
  assert.equal(el.type, 'text', 'type changed to text');
  assert.equal(el.min, '', 'min cleared after type change');
  assert.equal(el.max, '', 'max cleared after type change');
  assert.equal(el.units, '', 'units cleared after type change');

  w.commitWorking();
  const gt = w.__groundTruth();
  assert.equal(gt.study.visits[0].forms[0].fields[0].min, '', 'min cleared in ground truth');
  assert.equal(gt.study.visits[0].forms[0].fields[0].max, '', 'max cleared in ground truth');
});

test('env-wizard: skip logic / visibility works', () => {
  const w = loadWizard();
  setupBuilder(w);

  w.addElement('text');
  w.addElement('boolean');

  const els = w.selectedPage().elements;
  const el2Id = els[1].id;
  const el1Id = els[0].id;

  w.selectElement(el2Id);
  w.setVisibilityMode('when');
  w.setVisibilityWhen(el1Id);
  w.setVisibilityValue('true');

  w.commitWorking();
  const gt = w.__groundTruth();
  const field2 = gt.study.visits[0].forms[0].fields[1];
  assert.ok(field2.skipLogic, 'skipLogic present');
  assert.equal(field2.skipLogic.whenFieldLabel, els[0].label, 'whenFieldLabel correct');
  assert.equal(field2.skipLogic.equalsValue, 'true', 'equalsValue correct');
});

test('env-wizard: bulk paste for coded values', () => {
  const w = loadWizard();
  setupBuilder(w);

  w.addElement('radio');
  w.setPasteText('1=Red\n2=Green\n3=Blue');
  w.applyPasteValues();

  w.commitWorking();
  const gt = w.__groundTruth();
  const field = gt.study.visits[0].forms[0].fields[0];
  assert.equal(field.type, 'radio', 'type is radio');
  assert.equal(field.options.length, 3, '3 options pasted');
  assert.equal(field.options[0].code, '1', 'first code');
  assert.equal(field.options[0].label, 'Red', 'first label');
  assert.equal(field.options[2].code, '3', 'last code');
  assert.equal(field.options[2].label, 'Blue', 'last label');
});

test('env-wizard: draft/saved form lifecycle', () => {
  const w = loadWizard();

  w.eval([
    '(function() {',
    '  patchUi({ visitFormOpen: true, visitDraft: { name: "Screening", windowStart: "0", windowEnd: "7" } });',
    '  saveVisit();',
    '})();',
  ].join('\n'));

  const gt1 = w.__groundTruth();
  assert.equal(gt1.study.visits.length, 1, 'one visit created');
  assert.equal(gt1.study.visits[0].name, 'Screening', 'visit name correct');

  w.eval([
    '(function() {',
    '  navigate({ kind: "visit", visitId: state.study.visits[0].id });',
    '  patchUi({ formFormOpen: true, formDraft: { name: "Demographics", repeating: false } });',
    '  createForm();',
    '})();',
  ].join('\n'));

  const gt2 = w.__groundTruth();
  assert.equal(gt2.study.visits[0].forms.length, 1, 'one form created');
  assert.equal(gt2.study.visits[0].forms[0].name, 'Demographics', 'form name correct');
  assert.equal(gt2.study.visits[0].forms[0].status, 'draft', 'form starts as draft');

  const visitId = w.state.study.visits[0].id;
  const formId = w.state.study.visits[0].forms[0].id;
  w.openBuilder(visitId, formId);
  w.addElement('text');
  w.commitWorking();

  const gt3 = w.__groundTruth();
  assert.equal(gt3.study.visits[0].forms[0].fields.length, 1, 'field committed');
  assert.equal(gt3.study.visits[0].forms[0].fields[0].type, 'text', 'field type text');

  w.publishWorking();
  const gt4 = w.__groundTruth();
  assert.equal(gt4.study.visits[0].forms[0].status, 'active', 'form published (active)');

  w.eval([
    '(function() {',
    '  navigate({ kind: "visit", visitId: state.study.visits[0].id });',
    '  createNewVersion(state.study.visits[0].id, state.study.visits[0].forms[0].id);',
    '})();',
  ].join('\n'));

  const gt5 = w.__groundTruth();
  assert.equal(gt5.study.visits[0].forms[0].status, 'draft', 'branched back to draft');
  assert.equal(w.state.study.visits[0].forms[0].version, 2, "version incremented");;
});
