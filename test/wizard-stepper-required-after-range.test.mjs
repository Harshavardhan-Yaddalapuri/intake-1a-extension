/**
 * Regression: 22403d1 stepper-until-Required walked Next past range onto
 * visibility/Done. Form commit then ranked Done (commit hints include "done"),
 * navigated away without commitWorking, and collapsed wizard fields 189→19.
 *
 * Required sits BEFORE range on FormCraft. After set_range, set_required must
 * Back into Required — never Next onto Done / the next element.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import {
  findWizardAdvanceControl,
  findWizardBackControl,
} from '../dist/probe-runner.mjs';
import { rankCandidates, enumerateByRoles } from '../dist/bind-ranking.mjs';
import { elem, resetSeq } from './fixtures/obs.mjs';

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

function clickNamed(w, name) {
  const btn = [...w.document.querySelectorAll('button')].find(
    (b) => (b.textContent || '').trim() === name,
  );
  assert.ok(btn, `button ${JSON.stringify(name)}`);
  btn.click();
}

function requiredBoxes(o) {
  return o.elements.filter(
    (e) => e.role === 'checkbox' && /requir/i.test(`${e.name || ''} ${e.groupText || ''}`),
  );
}

function minBoxes(o) {
  return o.elements.filter(
    (e) =>
      (e.role === 'textbox' || e.role === 'spinbutton')
      && /min/i.test(`${e.name || ''} ${e.groupText || ''}`),
  );
}

test('rankCandidates: groupText lexical only when name is blank', () => {
  resetSeq();
  // Named control must NOT pick up window demotion via groupText alone.
  const named = elem('textbox', 'Question Text', { groupText: 'Window Start (day)' });
  const ranked = rankCandidates([named], {
    hint: 'name_input',
    demote: ['window_start', 'window_end'],
  });
  // name "Question Text" does not match name_input hints strongly, but demote
  // still applies via explicit demote hay (name+groupText) when demote is passed.
  // The regression lock: a NAMED palette-adjacent control must not gain
  // lexical hits from groupText window words for unrelated hints.
  const windowRank = rankCandidates(
    [elem('button', 'Save', { groupText: 'next page actions' })],
    { hint: 'wizard_advance' },
  );
  assert.equal(
    windowRank[0]?.signals.some((s) => s.detail?.includes('groupText')),
    false,
    'named Save must not score groupText for wizard_advance',
  );

  // Nameless still uses groupText (Prism Wave Name).
  resetSeq();
  const nameless = [
    elem('textbox', '', { groupText: 'Wave Name' }),
    elem('textbox', '', { groupText: 'Window Start (day)' }),
  ];
  const top = rankCandidates(nameless, {
    hint: 'name_input',
    demote: ['window_start', 'window_end'],
  })[0].el;
  assert.equal(top.groupText, 'Wave Name');
});

test('wizard: after range step, Back reaches Required; Next would hit Done', () => {
  const w = loadWizard();
  openBuilder(w);
  w.document.querySelector('#builder-add-element').click();
  w.document.querySelector('#tile-integer').click();

  // Advance like set_range until Minimum shows.
  for (let i = 0; i < 5; i += 1) {
    const o = observe(w.document);
    if (minBoxes(o).length > 0) break;
    const adv = findWizardAdvanceControl(o);
    assert.ok(adv, `advance while seeking range at ${i}`);
    clickNamed(w, adv.name);
  }
  let o = observe(w.document);
  assert.ok(minBoxes(o).length > 0, 'should be on range step');
  assert.equal(requiredBoxes(o).length, 0, 'Required not visible on range step');

  // Blind Next from here (old bug) reaches visibility where Done replaces Next.
  {
    const w2 = loadWizard();
    openBuilder(w2);
    w2.document.querySelector('#builder-add-element').click();
    w2.document.querySelector('#tile-integer').click();
    for (let i = 0; i < 5; i += 1) {
      const obs = observe(w2.document);
      if (minBoxes(obs).length > 0) break;
      clickNamed(w2, findWizardAdvanceControl(obs).name);
    }
    // one more Next → visibility
    clickNamed(w2, findWizardAdvanceControl(observe(w2.document)).name);
    const onVis = observe(w2.document);
    assert.equal(findWizardAdvanceControl(onVis), null, 'Next gone on final step');
    assert.ok(
      [...w2.document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Done'),
      'Done visible — commit decoy if set_required overshoots',
    );
  }

  // Fixed path: Back from range finds Required without surfacing Done.
  for (let i = 0; i < 4 && requiredBoxes(o).length === 0; i += 1) {
    const back = findWizardBackControl(o);
    assert.ok(back, `wizard back at ${i}`);
    clickNamed(w, back.name);
    o = observe(w.document);
  }
  assert.ok(requiredBoxes(o).length > 0, 'Back must reveal Required answer checkbox');
  assert.ok(findWizardAdvanceControl(o), 'still have Next — not stranded on Done');
  const info = JSON.parse(w.eval('JSON.stringify(wizardStepInfo())'));
  assert.equal(info.current.field, 'required');
});

test('wizard: set_required must not Next into the next element\'s Required', () => {
  const w = loadWizard();
  openBuilder(w);
  w.document.querySelector('#builder-add-element').click();
  w.document.querySelector('#tile-integer').click();
  w.document.querySelector('#builder-add-element').click();
  w.document.querySelector('#tile-decimal').click();
  // Select first element (Height) and walk to its range.
  w.eval(`(function(){
    var els=state.ui.builder.working.pages[0].elements;
    selectElement(els[0].id);
  })()`);
  for (let i = 0; i < 5; i += 1) {
    const o = observe(w.document);
    if (minBoxes(o).length > 0) break;
    clickNamed(w, findWizardAdvanceControl(o).name);
  }
  let o = observe(w.document);
  assert.ok(minBoxes(o).length > 0);

  // Old path: 4× Next lands on el2 required.
  const forward = [];
  {
    const w2 = loadWizard();
    openBuilder(w2);
    w2.document.querySelector('#builder-add-element').click();
    w2.document.querySelector('#tile-integer').click();
    w2.document.querySelector('#builder-add-element').click();
    w2.document.querySelector('#tile-decimal').click();
    w2.eval(`(function(){
      var els=state.ui.builder.working.pages[0].elements;
      selectElement(els[0].id);
    })()`);
    for (let i = 0; i < 5; i += 1) {
      const obs = observe(w2.document);
      if (minBoxes(obs).length > 0) break;
      clickNamed(w2, findWizardAdvanceControl(obs).name);
    }
    for (let i = 0; i < 4; i += 1) {
      const obs = observe(w2.document);
      if (requiredBoxes(obs).length > 0) {
        forward.push(JSON.parse(w2.eval('JSON.stringify(wizardStepInfo())')));
        break;
      }
      const adv = findWizardAdvanceControl(obs);
      if (!adv) break;
      clickNamed(w2, adv.name);
    }
  }
  // Blind Next from range can reach a later element's Required (or visibility).
  assert.ok(forward.length === 0 || forward[0]?.current?.elementId !== 'el1' || forward[0]?.current?.field !== 'range',
    'precondition: blind Next leaves the range step');

  // Fixed: Back stays on el1 required.
  for (let i = 0; i < 4 && requiredBoxes(o).length === 0; i += 1) {
    clickNamed(w, findWizardBackControl(o).name);
    o = observe(w.document);
  }
  const info = JSON.parse(w.eval('JSON.stringify(wizardStepInfo())'));
  assert.equal(info.current.elementId, 'el1');
  assert.equal(info.current.field, 'required');
});
