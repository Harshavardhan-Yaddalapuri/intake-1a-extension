// Hostile E2E v6 residuals after 567bab8:
//   1. env-rosetta Demographics still kept 13 palette chrome names
//      (Derived Value … Binary Flip) beside IR labels — delete-after-probe
//      clicked once without re-select / verify, so a lost selection or stale
//      handle left every probe tile on the canvas.
//   2. Screening "could not open this visit" after leaving Demographics:
//      ascend from designer landed on visit detail, then kept climbing to the
//      schedule and failed to re-open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe, diffObservations } from '../dist/perceive-core.mjs';
import {
  enumerateActions,
  enumerateActionable,
} from '../dist/bind-ranking.mjs';
import {
  findProbeDeleteAction,
  findPlacedProbeSelectTarget,
  isSafePaletteProbeCandidate,
} from '../dist/probe-runner.mjs';
import {
  atVisitList,
  atVisitDetail,
  rankAscendCandidates,
} from '../dist/bind-rung0.mjs';
import { click as actClick, defaultSettleWait } from '../dist/act-primitives.mjs';

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

function canvasLabels(w) {
  return w.eval(
    `(function(){return state.ui.builder.working.pages[0].elements.map(function(e){return e.label;});})()`,
  );
}

function canvasCount(w) {
  return w.eval(
    `(function(){return state.ui.builder.working.pages[0].elements.length;})()`,
  );
}

async function driverClick(w, handle) {
  const observation = observe(w.document);
  const ctx = { doc: w.document, obs: observation, settle: defaultSettleWait };
  try {
    return await actClick(ctx, handle, true);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** Mirrors ProbeRunner.removePlacedProbe (select → delete → verify → retry). */
async function removePlacedProbeLike(w, beforePlace, afterPlace) {
  const baselineSize = beforePlace.elements.length;
  let current = afterPlace;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current = observe(w.document);
    if (current.elements.length <= baselineSize) return true;
    let del = findProbeDeleteAction(current);
    if (!del) {
      const selectable = findPlacedProbeSelectTarget(beforePlace, current);
      if (selectable) {
        const sel = await driverClick(w, selectable.handle);
        if (sel.ok) {
          current = observe(w.document);
          del = findProbeDeleteAction(current);
        }
      }
    }
    if (!del) continue;
    const res = await driverClick(w, del.handle);
    if (!res.ok) continue;
    current = observe(w.document);
    if (current.elements.length <= baselineSize) return true;
  }
  return canvasCount(w) === 0;
}

test('findProbeDeleteAction matches Delete Element and Delete Node', () => {
  for (const [env, sel, delName] of [
    ['env-rosetta', '#brick-text', 'Delete Element'],
    ['env-swapped-controls', '#node-text', 'Delete Node'],
  ]) {
    const w = loadEnv(env);
    openDemographics(w);
    w.document.querySelector(sel).click();
    const obs = observe(w.document);
    const del = findProbeDeleteAction(obs);
    assert.ok(del, `${env} missing delete control`);
    assert.equal(del.name, delName);
  }
});

test('rosetta: deselect then cleanup must re-select before Delete Element', async () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  const before = observe(w.document);
  w.document.querySelector('#brick-calculated').click();
  const after = observe(w.document);
  assert.equal(canvasCount(w), 1);
  assert.ok(findProbeDeleteAction(after), 'selected probe exposes Delete Element');

  // Lose selection (empty panel → no Delete Element) — the live failure mode.
  w.eval('selectElement(null)');
  const deselected = observe(w.document);
  assert.equal(
    findProbeDeleteAction(deselected),
    null,
    'without selection Delete Element is absent — old cleanup would no-op',
  );

  const cleaned = await removePlacedProbeLike(w, before, after);
  assert.equal(cleaned, true);
  assert.equal(canvasCount(w), 0, 'cleanup must remove probe after re-select');
  assert.equal([...canvasLabels(w)].length, 0);
});

test('rosetta: sequential palette probes leave canvas empty', async () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);
  const tiles = [...w.document.querySelectorAll('.palette-tile')]
    .map((b) => b.textContent.trim())
    .filter(isSafePaletteProbeCandidate);

  for (const name of tiles) {
    const before = observe(w.document);
    const live = [...w.document.querySelectorAll('.palette-tile')]
      .find((b) => b.textContent.trim() === name);
    assert.ok(live, `missing brick ${name}`);
    live.click();
    const after = observe(w.document);
    const ok = await removePlacedProbeLike(w, before, after);
    assert.equal(ok, true, `cleanup failed after probing ${name}`);
  }
  assert.equal(canvasCount(w), 0, 'all probe tiles must be gone');
  assert.equal([...canvasLabels(w)].length, 0);
});

test('rosetta: climb from designer stops on visit detail (no re-open)', () => {
  const w = loadEnv('env-rosetta');
  openDemographics(w);

  // Place chrome tiles so the designer is crowded like a live probe sweep.
  for (const t of [
    'calculated', 'text', 'radio', 'boolean', 'date', 'integer', 'decimal',
  ]) {
    w.document.querySelector(`#brick-${t}`)?.click();
  }

  const hops = [];
  let here = observe(w.document);
  assert.equal(atVisitDetail(here, 'Screening'), false);

  for (let hop = 0; hop < 4; hop += 1) {
    here = observe(w.document);
    // Fixed navigateToVisit: landing on visit detail is success.
    if (atVisitDetail(here, 'Screening')) break;
    const best = rankAscendCandidates(here, VISITS)[0];
    assert.ok(best, `no ascend at hop ${hop}`);
    const btn = [...w.document.querySelectorAll('button')]
      .find((b) => (b.textContent || '').trim() === best.name);
    assert.ok(btn, `missing ${best.name}`);
    btn.click();
    hops.push(best.name);
  }

  const finalObs = observe(w.document);
  assert.equal(atVisitDetail(finalObs, 'Screening'), true);
  assert.equal(atVisitList(finalObs, VISITS, '+ New Phase'), false);
  assert.deepEqual(hops, ['<- Screening'], `must not climb past detail; hops=${hops}`);
  assert.ok(
    enumerateActionable(finalObs).some((e) => e.name === '+ New Record Sheet'),
  );
});
