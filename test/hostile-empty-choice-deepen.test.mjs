// Hostile E2E v3 residual (after b9a6e2c): empty Dial Group / Beam Pick still
// failed to bind radio without a human type-gate.
//
// Two stacked failures against real env HTML:
//   1. Nameless Required/Hidden checkboxes survived the property-panel filter
//      and were read as the placed control (role=checkbox → multi_select).
//   2. deepenChoiceProbe ranked "Apply Pasted Values" / "Append Pasted
//      Choices" above "+ Add Value" / "+ Add Choice"; the paste-apply click
//      added nothing and aborted deepen, so role=radio never appeared.
//
// field.add for text ALSO requires typeBindings['text']. On env-rosetta
// bindFieldAdd('text') is null ("Free String" has no text synonym), so the
// map stays empty until probePalette succeeds — a failed choice deepen does
// not itself clear text, but the same probe pass must bind both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe, diffObservations } from '../dist/perceive-core.mjs';
import { inspectPlacedControl, classifyTypeFromProbe } from '../dist/bind-rung1.mjs';
import { bindFieldAdd } from '../dist/bind-rung0.mjs';
import { enumerateActions, rankCandidates } from '../dist/bind-ranking.mjs';
import { orderChoiceDeepenCandidates, choiceDeepenPanelActions } from '../dist/probe-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gen = join(__dirname, '..', 'generalization');

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

function deepenLikeProbeRunner(w, before, after) {
  const panelActions = choiceDeepenPanelActions(before, after);
  const ranked = rankCandidates(panelActions, { hint: 'coded_values' }).map((r) => r.el);
  const ordered = orderChoiceDeepenCandidates(ranked);
  let current = after;
  const tried = [];
  for (const candidate of ordered) {
    let progressed = false;
    for (let i = 0; i < 2; i += 1) {
      const snap = current;
      const btn = [...w.document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === candidate.name);
      tried.push(candidate.name);
      if (!btn) break;
      btn.click();
      current = observe(w.document);
      if (diffObservations(snap, current).added.length === 0) break;
      progressed = true;
    }
    if (progressed) return { observed: current, tried, winner: candidate.name };
  }
  return { observed: current, tried, winner: null };
}

for (const env of [
  { id: 'env-rosetta', radioSel: '#brick-radio', textSel: '#brick-text', radioName: 'Dial Group', textName: 'Free String' },
  { id: 'env-swapped-controls', radioSel: '#node-radio', textSel: '#node-text', radioName: 'Beam Pick', textName: 'Glyph Line' },
]) {
  test(`${env.id}: empty ${env.radioName} is generic (not nameless Required checkbox)`, () => {
    const w = loadEnv(env.id);
    openDemographics(w);
    const before = observe(w.document);
    w.document.querySelector(env.radioSel).click();
    const after = observe(w.document);
    const probe = inspectPlacedControl(before, after);
    assert.notEqual(
      probe.observedRole, 'checkbox',
      `nameless Required must not be the placed field; got ${probe.evidence[0]}`,
    );
    assert.equal(probe.hasOptionsEditor, true);
    assert.ok(
      probe.observedRole === 'generic' || probe.observedRole === 'none',
      `expected generic/none for empty choice; got ${probe.observedRole}`,
    );
    // Type picker option value is structural: empty Dial Group / Beam Pick
    // declare radio before options exist. Trust that so wizard/FormCraft can
    // bind without deepen; deepen remains for platforms with no type picker.
    assert.equal(probe.declaredCanonical, 'radio');
    assert.equal(
      classifyTypeFromProbe('radio', probe).matches, true,
      'declaredCanonical radio classifies empty choice without deepen',
    );
    assert.equal(
      classifyTypeFromProbe('multi_select', probe).matches, false,
      'must not steal radio for multi_select',
    );
  });

  test(`${env.id}: deepen prefers +Add over paste-apply and binds radio without escalate`, () => {
    const w = loadEnv(env.id);
    openDemographics(w);
    const before = observe(w.document);
    w.document.querySelector(env.radioSel).click();
    const after = observe(w.document);

    const panelActions = choiceDeepenPanelActions(before, after);
    const rawRanked = rankCandidates(panelActions, { hint: 'coded_values' }).map((r) => r.el.name);
    // Document the trap: raw lexical rank puts paste-apply first.
    assert.ok(
      rawRanked.some((n) => /paste/i.test(n)),
      `expected a paste-apply decoy in panel actions; got ${rawRanked}`,
    );

    const ordered = orderChoiceDeepenCandidates(
      rankCandidates(panelActions, { hint: 'coded_values' }).map((r) => r.el),
    ).map((e) => e.name);
    assert.ok(
      /add (value|choice)/i.test(ordered[0]),
      `add-row must win deepen order; got ${ordered}`,
    );

    const { observed, winner } = deepenLikeProbeRunner(w, before, after);
    assert.ok(winner && /add (value|choice)/i.test(winner), `deepen winner=${winner}`);
    const probe = inspectPlacedControl(before, observed);
    assert.equal(
      classifyTypeFromProbe('radio', probe).matches, true,
      `radio must bind from deepen; role=${probe.observedRole} evidence=${probe.evidence[0]}`,
    );
    assert.equal(
      classifyTypeFromProbe('single_select', probe).matches, false,
      'must not collapse radio into single_select',
    );
  });

  test(`${env.id}: Subject Initials (text) can bind without a prior type map`, () => {
    const w = loadEnv(env.id);
    openDemographics(w);
    const obs = observe(w.document);
    const rung0 = bindFieldAdd(obs, 'text');
    // Rosetta "Free String" has no text synonym → map empty until probe.
    // Swapped "Glyph Line" hits synonym 'line' → hypothesis binding exists.
    if (env.id === 'env-rosetta') {
      assert.equal(rung0, null, 'rosetta text must not falsely name-bind');
    }

    const before = observe(w.document);
    w.document.querySelector(env.textSel).click();
    const after = observe(w.document);
    const probe = inspectPlacedControl(before, after);
    assert.equal(
      classifyTypeFromProbe('text', probe).matches, true,
      `text probe must succeed; role=${probe.observedRole}`,
    );
  });
}

test('orderChoiceDeepenCandidates puts Add Value before Apply Pasted Values', () => {
  const ordered = orderChoiceDeepenCandidates([
    { name: 'Apply Pasted Values' },
    { name: '+ Add Value' },
    { name: 'Delete Element' },
  ]).map((e) => e.name);
  assert.deepEqual(ordered[0], '+ Add Value');
  assert.ok(ordered.indexOf('+ Add Value') < ordered.indexOf('Apply Pasted Values'));
});
