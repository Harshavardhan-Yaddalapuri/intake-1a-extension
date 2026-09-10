// Hostile E2E v4 residuals after aa1f2ec:
//   1. env-swapped-controls: date unbound — Free/Glyph textbox isomorphism +
//      probe clicking "<- Screening" left the designer before Solar Mark.
//   2. env-rosetta: visit open escalation — need positive atVisitDetail and
//      ascend that prefers Back over inert Phases; Freeze Phase as commit.
//
// Prove against real env HTML (jsdom), not fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe, diffObservations } from '../dist/perceive-core.mjs';
import {
  inspectPlacedControl,
  classifyTypeFromProbe,
} from '../dist/bind-rung1.mjs';
import {
  bindVisitCreate,
  atVisitList,
  atVisitDetail,
  rankAscendCandidates,
} from '../dist/bind-rung0.mjs';
import {
  enumerateActionable,
  enumerateActions,
  rankCandidates,
  largestControlCluster,
} from '../dist/bind-ranking.mjs';
import { isSafePaletteProbeCandidate } from '../dist/probe-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gen = join(__dirname, '..', 'generalization');
const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];

function loadEnv(dir) {
  const base = join(gen, dir);
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
    url: `http://127.0.0.1/${dir}/`,
  }).window;
}

function openDemographics(w) {
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

function place(w, sel) {
  const before = observe(w.document);
  const btn = w.document.querySelector(sel);
  assert.ok(btn, `missing tile ${sel}`);
  btn.click();
  const after = observe(w.document);
  return inspectPlacedControl(before, after);
}

test('swapped: Solar Mark declares date via Node Type; Glyph Line does not', () => {
  const w = loadEnv('env-swapped-controls');
  openDemographics(w);
  const dateProbe = place(w, '#node-date');
  assert.equal(dateProbe.declaredCanonical, 'date');
  assert.equal(classifyTypeFromProbe('date', dateProbe).matches, true);
  assert.equal(classifyTypeFromProbe('text', dateProbe).matches, false);

  const w2 = loadEnv('env-swapped-controls');
  openDemographics(w2);
  const textProbe = place(w2, '#node-text');
  assert.equal(textProbe.declaredCanonical, 'text');
  assert.equal(classifyTypeFromProbe('text', textProbe).matches, true);
  assert.equal(classifyTypeFromProbe('date', textProbe).matches, false);
});

test('rosetta: Calendar Day declares date via Element Type; Free String does not', () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  const dateProbe = place(w, '#brick-date');
  assert.equal(dateProbe.declaredCanonical, 'date');
  assert.equal(classifyTypeFromProbe('date', dateProbe).matches, true);
  assert.equal(classifyTypeFromProbe('text', dateProbe).matches, false);

  const w2 = loadEnv('env-rosetta');
  openDemographics(w2);
  const textProbe = place(w2, '#brick-text');
  assert.equal(textProbe.declaredCanonical, 'text');
  assert.equal(classifyTypeFromProbe('date', textProbe).matches, false);
});

test('safe palette probe rejects builder back/chrome controls', () => {
  assert.equal(isSafePaletteProbeCandidate('<- Screening'), false);
  assert.equal(isSafePaletteProbeCandidate('← Screening'), false);
  assert.equal(isSafePaletteProbeCandidate('Lock'), false);
  assert.equal(isSafePaletteProbeCandidate('Freeze'), false);
  assert.equal(isSafePaletteProbeCandidate('Go Live'), false);
  assert.equal(isSafePaletteProbeCandidate('Phases'), false);
  assert.equal(isSafePaletteProbeCandidate('Solar Mark'), true);
  assert.equal(isSafePaletteProbeCandidate('Calendar Day'), true);
  assert.equal(isSafePaletteProbeCandidate('Glyph Line'), true);
});

test('swapped builder cluster: filtering keeps Solar Mark and drops back', () => {
  const w = loadEnv('env-swapped-controls');
  openDemographics(w);
  const obs = observe(w.document);
  const all = enumerateActionable(obs);
  const cluster = largestControlCluster(all);
  const safe = (cluster?.members ?? []).filter((m) => isSafePaletteProbeCandidate(m.name));
  assert.ok(safe.some((m) => m.name === 'Solar Mark'));
  assert.ok(!safe.some((m) => m.name.startsWith('<-') || m.name.startsWith('←')));
  assert.ok(!safe.some((m) => m.name === 'Lock'));
});

test('swapped first-wins with type picker: date binds to Solar Mark not Glyph Line', () => {
  const tiles = [
    ['#node-text', 'Glyph Line'],
    ['#node-date', 'Solar Mark'],
    ['#node-calculated', 'Logic Expr'],
  ];
  const bindings = {};
  for (const [sel, label] of tiles) {
    const w = loadEnv('env-swapped-controls');
    openDemographics(w);
    const probe = place(w, sel);
    const matches = ['text', 'textarea', 'integer', 'decimal', 'date', 'time', 'datetime',
      'boolean', 'single_select', 'multi_select', 'radio', 'checkbox', 'calculated']
      .filter((t) => classifyTypeFromProbe(t, probe).matches);
    for (const m of matches) {
      const spec = matches.length;
      const prev = bindings[m];
      if (!prev || spec < prev.spec) bindings[m] = { label, spec };
    }
  }
  assert.equal(bindings.date?.label, 'Solar Mark');
  assert.equal(bindings.text?.label, 'Glyph Line');
});

test('rosetta: Freeze Phase ranks above Cancel with commit+diff', () => {
  const w = loadEnv('env-rosetta');
  const before = observe(w.document);
  w.document.querySelector('#add-visit').click();
  const after = observe(w.document);
  const diffAdded = diffObservations(before, after).added;
  const ranked = rankCandidates(enumerateActions(after), { hint: 'commit', diffAdded });
  const topAppeared = ranked.filter((r) => diffAdded.includes(r.el.handle));
  assert.ok(topAppeared.some((r) => r.el.name === 'Freeze Phase'));
  assert.equal(topAppeared[0].el.name, 'Freeze Phase');
  const freeze = ranked.find((r) => r.el.name === 'Freeze Phase');
  const cancel = ranked.find((r) => r.el.name === 'Cancel');
  assert.ok(freeze.score > cancel.score);
});

test('rosetta: create + open Screening confirmed via atVisitDetail', () => {
  const w = loadEnv('env-rosetta');
  const create = bindVisitCreate(observe(w.document));
  assert.equal(create?.recipe?.[0]?.evidence_name, '+ New Phase');

  w.document.querySelector('#add-visit').click();
  const name = w.document.querySelector('#visit-name');
  name.value = 'Screening';
  name.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.querySelector('#visit-start').value = '-28';
  w.document.querySelector('#visit-start').dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.querySelector('#visit-end').value = '-1';
  w.document.querySelector('#visit-end').dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.querySelector('#save-visit').click();

  const listed = observe(w.document);
  assert.equal(atVisitList(listed, VISITS, '+ New Phase'), true);
  const vid = w.eval('state.study.visits[0].id');
  w.document.querySelector('#open-visit-' + vid).click();
  const opened = observe(w.document);
  assert.equal(atVisitDetail(opened, 'Screening'), true);
  assert.equal(atVisitList(opened, VISITS, '+ New Phase'), false);
});

test('rosetta: ascend prefers <- Back over inert Phases', () => {
  const w = loadEnv('env-rosetta');
  w.eval(`(function(){
    state.study={name:'ABC-101',visits:[{id:'v1',name:'Screening',windowStart:'-28',windowEnd:'-1',forms:[]}]};
    try { commit(Object.assign({}, state)); } catch (e) {}
    navigate({ kind: 'visit', visitId: 'v1' });
  })()`);
  const obs = observe(w.document);
  const ranked = rankAscendCandidates(obs, VISITS);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].name, '<- Back');
  assert.notEqual(ranked[0].name, 'Phases');
});
