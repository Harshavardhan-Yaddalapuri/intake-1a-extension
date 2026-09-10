/**
 * env-wizard: radio / single_select bind via Answer Type declaration after
 * wizard Next (empty Orbit Set / Pick One have no canvas role until options).
 * Icon-only tiles must remain probe-safe; Commit lives behind hamburger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import {
  inspectPlacedControl,
  classifyTypeFromProbe,
  readDeclaredCanonical,
} from '../dist/bind-rung1.mjs';
import {
  isSafePaletteProbeCandidate,
  findWizardAdvanceControl,
} from '../dist/probe-runner.mjs';
import { rankCommitCandidates } from '../dist/bind-rung0.mjs';
import { matchesHintWord } from '../dist/bind-ranking.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWizard() {
  const base = join(__dirname, '..', 'generalization', 'env-wizard');
  let html = readFileSync(join(base, 'index.html'), 'utf8');
  const core = readFileSync(join(base, 'core.js'), 'utf8');
  const ui = readFileSync(join(base, 'ui.js'), 'utf8');
  html = html.replace(
    /<script src="core\.js"><\/script>\s*<script src="ui\.js"><\/script>/,
    `<script>${core}</script><script>${ui}</script>`,
  );
  return new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/env-wizard/',
  }).window;
}

function openBuilder(w) {
  w.eval(`(function(){
    var v={id:'v1',name:'Screening',windowStart:'-28',windowEnd:'-1',forms:[]};
    var f={id:'f1',name:'Demographics',repeating:false,status:'draft',version:1,
      pages:[{id:'pg1',name:'Page 1',elements:[]}]};
    v.forms.push(f);
    state.study={name:'ABC-101',visits:[v]};
    try { commit(Object.assign({}, state)); } catch (e) {}
    openBuilder('v1','f1');
  })()`);
}

test('wizard: icon-only tiles are safe palette candidates', () => {
  assert.equal(isSafePaletteProbeCandidate(''), true);
  assert.equal(isSafePaletteProbeCandidate('Done'), false);
  assert.equal(isSafePaletteProbeCandidate('Orbit Set'), true);
});

test('wizard: Orbit Set classifies as radio after Next to Answer Type', () => {
  const w = loadWizard();
  openBuilder(w);
  w.document.querySelector('#builder-add-element').click();
  const before = observe(w.document);
  const tile = w.document.querySelector('#tile-radio');
  assert.ok(tile, 'Orbit Set tile');
  tile.click();
  let after = observe(w.document);
  let probe = inspectPlacedControl(before, after);
  // Label step — advance like revealWizardTypeEvidence
  for (let i = 0; i < 4 && !probe.declaredCanonical; i += 1) {
    const adv = findWizardAdvanceControl(after);
    assert.ok(adv, `wizard advance at step ${i}`);
    const btn = [...w.document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === adv.name,
    );
    btn.click();
    after = observe(w.document);
    probe = inspectPlacedControl(before, after);
  }
  assert.equal(probe.declaredCanonical, 'radio', `probe=${JSON.stringify(probe)}`);
  assert.equal(classifyTypeFromProbe('radio', probe).matches, true);
  assert.equal(classifyTypeFromProbe('single_select', probe).matches, false);
});

test('wizard: Pick One classifies as single_select via Answer Type', () => {
  const w = loadWizard();
  openBuilder(w);
  w.document.querySelector('#builder-add-element').click();
  const before = observe(w.document);
  w.document.querySelector('#tile-single_select').click();
  let after = observe(w.document);
  let probe = inspectPlacedControl(before, after);
  for (let i = 0; i < 4 && !probe.declaredCanonical; i += 1) {
    const adv = findWizardAdvanceControl(after);
    const btn = [...w.document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === adv.name,
    );
    btn.click();
    after = observe(w.document);
    probe = inspectPlacedControl(before, after);
  }
  assert.equal(probe.declaredCanonical, 'single_select');
  assert.equal(classifyTypeFromProbe('single_select', probe).matches, true);
});

test('wizard: hamburger reveals Commit for ranking', () => {
  const w = loadWizard();
  openBuilder(w);
  const closed = observe(w.document);
  assert.equal(
    closed.elements.some((e) => e.name === 'Commit'),
    false,
    'Commit control absent before hamburger open',
  );
  w.document.querySelector('#hamburger-btn').click();
  const open = observe(w.document);
  assert.ok(open.elements.some((e) => e.name === 'Commit'));
  const ranked = rankCommitCandidates(open);
  assert.ok(
    ranked.some((r) => r.el.name === 'Commit'),
    `Commit should rank among commit candidates; top=${ranked.slice(0, 5).map((r) => r.el.name)}`,
  );
  // Prefer Commit over Done when both are visible (Done navigates away dirty).
  const commitRank = ranked.findIndex((r) => r.el.name === 'Commit');
  const doneRank = ranked.findIndex((r) => r.el.name === 'Done');
  if (doneRank >= 0) {
    assert.ok(commitRank >= 0 && commitRank < doneRank, 'Commit must outrank Done');
  }
});
