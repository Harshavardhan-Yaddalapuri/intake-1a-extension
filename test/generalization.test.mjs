import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Import our compiled ESM modules
import { observe, diffObservations } from '../dist/perceive-core.mjs';
import { inspectPlacedControl, classifyTypeFromProbe, analyzeCommit, analyzeAppendReplace } from '../dist/bind-rung1.mjs';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const rosettaDir = join(__dirname2, '..', 'generalization', 'env-rosetta');
const wizardDir = join(__dirname2, '..', 'generalization', 'env-wizard');
const swappedDir = join(__dirname2, '..', 'generalization', 'env-swapped-controls');

function loadRosetta() {
  let html = readFileSync(join(rosettaDir, 'index.html'), 'utf8');
  const coreScript = readFileSync(join(rosettaDir, 'core.js'), 'utf8');
  const uiScript = readFileSync(join(rosettaDir, 'ui.js'), 'utf8');
  html = html.replace(
    '<script src="core.js"></script>\n<script src="ui.js"></script>',
    '<script>' + coreScript + '</script>\n<script>' + uiScript + '</script>'
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  return dom.window;
}

function setupRosettaBuilder(w) {
  w.eval([
    '(function() {',
    '  var v = { id: "v1", name: "Phase 1", windowStart: "0", windowEnd: "7", forms: [] };',
    '  var f = { id: "f1", name: "Sheet 1", repeating: false, status: "draft", version: 1, pages: [{ id: "pg1", name: "Page 1", elements: [] }] };',
    '  v.forms.push(f);',
    '  state.study = { name: "ABC-101", visits: [v] };',
    '  openBuilder("v1", "f1");',
    '})();',
  ].join('\n'));
}

test('generalization: env-rosetta loads with swapped vocabulary', () => {
  const w = loadRosetta();
  assert.equal(typeof w.__groundTruth, 'function', '__groundTruth available');
  assert.equal(w.PLATFORM_ID, 'env-rosetta');
  assert.equal(w.ELEMENT_TYPES.length, 13, 'all 13 types defined');
});

test('generalization: env-rosetta trap: multi_select is labeled "Single Choice Box" but probe reveals multi_select', () => {
  const w = loadRosetta();
  setupRosettaBuilder(w);

  // 1. Initial observation before clicking "Single Choice Box"
  const obsBefore = observe(w.document);

  // 2. Click the tile for "Single Choice Box" (canonical: multi_select)
  const root = w.document.getElementById('root');
  const tile = root.querySelector('#brick-multi_select');
  assert.ok(tile, 'brick-multi_select tile exists');
  assert.equal(tile.textContent.trim(), 'Single Choice Box', 'Tile label is misleading');

  tile.click();

  // 3. Observation after clicking
  const obsAfter = observe(w.document);

  // 4. Run inspectPlacedControl on the diff
  const probe = inspectPlacedControl(obsBefore, obsAfter);

  // 5. Classify canonical type
  // Must NOT classify as single_select
  const singleCheck = classifyTypeFromProbe('single_select', probe);
  assert.equal(singleCheck.matches, false, 'Structural probe correctly rejects single_select despite word "Single"');

  // MUST classify as multi_select
  const multiCheck = classifyTypeFromProbe('multi_select', probe);
  assert.equal(multiCheck.matches, true, 'Structural probe correctly detects multi_select from structural evidence');
});

test('generalization: env-rosetta trap: checkbox is labeled "Multi Choice Box" but probe reveals boolean checkbox', () => {
  const w = loadRosetta();
  setupRosettaBuilder(w);

  const obsBefore = observe(w.document);
  const root = w.document.getElementById('root');
  const tile = root.querySelector('#brick-checkbox');
  assert.ok(tile, 'brick-checkbox tile exists');
  assert.equal(tile.textContent.trim(), 'Multi Choice Box', 'Tile label is misleading');

  tile.click();

  const obsAfter = observe(w.document);
  const probe = inspectPlacedControl(obsBefore, obsAfter);

  // Must NOT classify as multi_select
  const multiCheck = classifyTypeFromProbe('multi_select', probe);
  assert.equal(multiCheck.matches, false, 'Structural probe correctly rejects multi_select despite word "Multi"');

  // MUST classify as checkbox
  const check = classifyTypeFromProbe('checkbox', probe);
  assert.equal(check.matches, true, 'Structural probe correctly detects single boolean checkbox');
});

test('generalization: env-rosetta: single_select labeled "Picker" is classified as single_select (combobox/select)', () => {
  const w = loadRosetta();
  setupRosettaBuilder(w);

  const obsBefore = observe(w.document);
  const root = w.document.getElementById('root');
  const tile = root.querySelector('#brick-single_select');
  assert.ok(tile, 'brick-single_select tile exists');
  assert.equal(tile.textContent.trim(), 'Picker');

  tile.click();

  const obsAfter = observe(w.document);
  const probe = inspectPlacedControl(obsBefore, obsAfter);

  const singleCheck = classifyTypeFromProbe('single_select', probe);
  assert.equal(singleCheck.matches, true, 'Picker is structurally single_select');

  const radioCheck = classifyTypeFromProbe('radio', probe);
  assert.equal(radioCheck.matches, false, 'Picker is not radiogroup');
});

test('generalization: env-rosetta: radio labeled "Dial Group" is classified as radio (radiogroup)', () => {
  const w = loadRosetta();
  setupRosettaBuilder(w);

  const obsBefore = observe(w.document);
  const root = w.document.getElementById('root');
  const tile = root.querySelector('#brick-radio');
  assert.ok(tile, 'brick-radio tile exists');
  assert.equal(tile.textContent.trim(), 'Dial Group');

  tile.click();

  // In choice controls with no initial items, adding a value renders the control
  const addValBtn = root.querySelector('#val-add');
  if (addValBtn) addValBtn.click();

  const obsAfter = observe(w.document);
  const probe = inspectPlacedControl(obsBefore, obsAfter);

  const radioCheck = classifyTypeFromProbe('radio', probe);
  assert.equal(radioCheck.matches, true, 'Dial Group is structurally radio');

  const singleCheck = classifyTypeFromProbe('single_select', probe);
  assert.equal(singleCheck.matches, false, 'Dial Group is not combobox/select');
});

test('generalization: commit probe detects real save vs trap (Freeze vs Bank It)', () => {
  const w = loadRosetta();
  setupRosettaBuilder(w);

  // Make working form dirty by adding an element
  w.addElement('text');
  assert.equal(w.state.ui.builder.dirty, true, 'form is dirty');

  const obsBefore = observe(w.document);
  const root = w.document.getElementById('root');

  // Test Bank It (Save As Template trap)
  const bankBtn = root.querySelector('#builder-bank');
  assert.ok(bankBtn);
  bankBtn.click();
  const obsAfterBank = observe(w.document);
  const bankCommit = analyzeCommit(obsBefore, obsAfterBank);
  assert.equal(bankCommit.committed, false, 'Bank It does not commit the working copy');
  assert.equal(w.state.ui.builder.dirty, true, 'form remains dirty after Bank It');

  // Test Freeze (real Save in Rosetta)
  const freezeBtn = root.querySelector('#builder-freeze');
  assert.ok(freezeBtn);
  freezeBtn.click();
  const obsAfterFreeze = observe(w.document);
  const freezeCommit = analyzeCommit(obsBefore, obsAfterFreeze);
  assert.equal(freezeCommit.committed, true, 'Freeze commits the working copy');
  assert.equal(w.state.ui.builder.dirty, false, 'form is no longer dirty after Freeze');
});

test('generalization: coded value probe distinguishes append vs replace behavior', () => {
  // Test append
  const appendRes = analyzeAppendReplace(['1=Red'], ['1=Red', '2=Blue']);
  assert.equal(appendRes.mode, 'append', 'detected append mode');

  // Test replace
  const replaceRes = analyzeAppendReplace(['1=Red'], ['2=Blue']);
  assert.equal(replaceRes.mode, 'replace', 'detected replace mode');
});
