// Hostile E2E v5 residuals after 11c2c91:
//   1. env-swapped-controls: Beam Pick deepen missed "+ Add Choice" when a
//      prior palette probe reused the DOM handle (Expression → + Add Choice),
//      so radio never bound → Sex at Birth type-gate.
//   2. env-rosetta: after Demographics, re-entering navigateToVisit climbed
//      past visit detail because rankAscendCandidates excluded "<- Back" with
//      the toolbar cluster, leaving Modify/Go Live → Screening "could not open".
//   3. Palette probe tiles left on canvas as chrome-named fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe, diffObservations } from '../dist/perceive-core.mjs';
import { inspectPlacedControl, classifyTypeFromProbe } from '../dist/bind-rung1.mjs';
import {
  enumerateActionable,
  enumerateActions,
  rankCandidates,
  largestControlCluster,
} from '../dist/bind-ranking.mjs';
import {
  orderChoiceDeepenCandidates,
  choiceDeepenPanelActions,
  isSafePaletteProbeCandidate,
} from '../dist/probe-runner.mjs';
import {
  atVisitList,
  atVisitDetail,
  rankAscendCandidates,
} from '../dist/bind-rung0.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gen = join(__dirname, '..', 'generalization');
const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];
const TYPES = [
  'text', 'textarea', 'integer', 'decimal', 'date', 'time', 'datetime',
  'boolean', 'single_select', 'multi_select', 'radio', 'checkbox', 'calculated',
];

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

function clickName(w, name) {
  const b = [...w.document.querySelectorAll('button')]
    .find((x) => (x.textContent || '').trim() === name);
  assert.ok(b, `missing button ${name}`);
  b.click();
}

function deepenWithPanelActions(w, before, after) {
  const panelActions = choiceDeepenPanelActions(before, after);
  const ordered = orderChoiceDeepenCandidates(
    rankCandidates(panelActions, { hint: 'coded_values' }).map((r) => r.el),
  );
  let current = after;
  for (const candidate of ordered) {
    let progressed = false;
    for (let i = 0; i < 2; i += 1) {
      const snap = current;
      const btn = [...w.document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === candidate.name);
      if (!btn) break;
      btn.click();
      current = observe(w.document);
      if (diffObservations(snap, current).added.length === 0) break;
      progressed = true;
    }
    if (progressed) return { observed: current, winner: candidate.name };
  }
  return { observed: current, winner: null };
}

test('swapped: after Logic Expr, deepen panel actions include + Add Choice via changed handle', () => {
  const w = loadEnv('env-swapped-controls');
  openDemographics(w);
  w.document.querySelector('#node-calculated').click();
  const before = observe(w.document);
  w.document.querySelector('#node-radio').click();
  const after = observe(w.document);

  const addedOnly = enumerateActions(after).filter(
    (e) => new Set(diffObservations(before, after).added).has(e.handle),
  ).map((e) => e.name);
  assert.ok(
    !addedOnly.some((n) => /add choice/i.test(n)),
    `trap: added-only must miss + Add Choice; got ${addedOnly}`,
  );

  const panel = choiceDeepenPanelActions(before, after).map((e) => e.name);
  assert.ok(
    panel.some((n) => /add choice/i.test(n)),
    `changed∪added must surface + Add Choice; got ${panel}`,
  );
});

test('swapped: Logic Expr then Beam Pick deepens to radio (not multi_select)', () => {
  const w = loadEnv('env-swapped-controls');
  openDemographics(w);
  w.document.querySelector('#node-calculated').click();
  const before = observe(w.document);
  w.document.querySelector('#node-radio').click();
  const after = observe(w.document);

  const empty = inspectPlacedControl(before, after);
  assert.equal(empty.declaredCanonical, 'radio');
  assert.equal(
    classifyTypeFromProbe('multi_select', empty).matches, false,
    'declared radio must not vacuously bind as multi_select',
  );

  const { observed, winner } = deepenWithPanelActions(w, before, after);
  assert.ok(winner && /add choice/i.test(winner), `deepen winner=${winner}`);
  const probe = inspectPlacedControl(before, observed);
  assert.equal(
    classifyTypeFromProbe('radio', probe).matches, true,
    `radio must bind; role=${probe.observedRole} evidence=${probe.evidence[0]}`,
  );
  assert.equal(classifyTypeFromProbe('multi_select', probe).matches, false);
  assert.equal(classifyTypeFromProbe('single_select', probe).matches, false);
});

test('rosetta: Dial Group still binds radio after a prior Calculated probe', () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  w.document.querySelector('#brick-calculated').click();
  const before = observe(w.document);
  w.document.querySelector('#brick-radio').click();
  const after = observe(w.document);
  const { observed, winner } = deepenWithPanelActions(w, before, after);
  assert.ok(winner && /add value/i.test(winner), `deepen winner=${winner}`);
  const probe = inspectPlacedControl(before, observed);
  assert.equal(classifyTypeFromProbe('radio', probe).matches, true);
});

test('rosetta: ascend from visit detail keeps <- Back (not only Modify)', () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  clickName(w, '<- Screening');
  const obs = observe(w.document);
  assert.equal(atVisitDetail(obs, 'Screening'), true);
  assert.equal(atVisitList(obs, VISITS, '+ New Phase'), false);

  const ranked = rankAscendCandidates(obs, VISITS);
  assert.ok(ranked.length > 0, 'need ascend candidates');
  assert.equal(
    ranked[0].name, '<- Back',
    `Back must win ascend; got ${ranked.slice(0, 4).map((r) => r.name)}`,
  );
  assert.ok(!['Modify', 'Go Live', 'Remove'].includes(ranked[0].name));
});

test('rosetta: hop designer → detail → list reaches visit schedule', () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  let reached = atVisitList(observe(w.document), VISITS, '+ New Phase');
  const hops = [];
  for (let hop = 0; hop < 4 && !reached; hop += 1) {
    const best = rankAscendCandidates(observe(w.document), VISITS)[0];
    assert.ok(best, `no ascend candidate at hop ${hop}`);
    clickName(w, best.name);
    hops.push(best.name);
    reached = atVisitList(observe(w.document), VISITS, '+ New Phase');
  }
  assert.equal(reached, true, `failed to reach visit list via ${hops.join(' -> ')}`);
  assert.ok(hops.includes('<- Back') || hops.includes('<- Screening'));
});

test('rosetta: already at visit detail is a successful open witness', () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  clickName(w, '<- Screening');
  const obs = observe(w.document);
  // navigateToVisit short-circuit condition
  assert.equal(atVisitDetail(obs, 'Screening'), true);
});

test('probe delete controls exist on both hostile builders', () => {
  for (const [env, sel, delName] of [
    ['env-rosetta', '#brick-text', 'Delete Element'],
    ['env-swapped-controls', '#node-text', 'Delete Node'],
  ]) {
    const w = loadEnv(env);
    openDemographics(w);
    w.document.querySelector(sel).click();
    const obs = observe(w.document);
    const del = enumerateActions(obs).find((e) => e.name === delName);
    assert.ok(del, `${env} missing ${delName}`);
    clickName(w, delName);
    const elements = w.eval(
      `(function(){return state.study.visits[0].forms[0].pages[0].elements.length;})()`,
    );
    assert.equal(elements, 0, `${env} delete must clear probe tile`);
  }
});

test('sequential probe with delete leaves radio bound and canvas clean', () => {
  const w = loadEnv('env-swapped-controls');
  openDemographics(w);

  // Place calculated, inspect, delete (as probePalette now does).
  {
    const before = observe(w.document);
    w.document.querySelector('#node-calculated').click();
    const after = observe(w.document);
    const probe = inspectPlacedControl(before, after);
    assert.equal(classifyTypeFromProbe('calculated', probe).matches, true);
    clickName(w, 'Delete Node');
  }

  const before = observe(w.document);
  w.document.querySelector('#node-radio').click();
  const after = observe(w.document);
  const { observed, winner } = deepenWithPanelActions(w, before, after);
  assert.ok(winner && /add choice/i.test(winner), `winner=${winner}`);
  const probe = inspectPlacedControl(before, observed);
  assert.equal(classifyTypeFromProbe('radio', probe).matches, true);
  clickName(w, 'Delete Node');
  const n = w.eval(
    `(function(){return state.study.visits[0].forms[0].pages[0].elements.length;})()`,
  );
  assert.equal(n, 0, 'canvas must be clean after probe deletes');
});
