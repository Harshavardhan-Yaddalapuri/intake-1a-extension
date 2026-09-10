/**
 * Hostile Prism create-visit: nameless contenteditables must bind
 * name_input → Wave Name (groupText), NOT Window Start/End day fields.
 *
 * Live v12 symptom: visit names became window-end days (-1/0/31/87) because
 * rankCandidates scored only el.name (all empty → DOM-order ties) and
 * createVisit wrote day integers into the name cell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import {
  rankCandidates,
  enumerateByRoles,
  enumerateActionable,
} from '../dist/bind-ranking.mjs';
import { setValue, click } from '../dist/act-primitives.mjs';
import { elem, obs, resetSeq } from './fixtures/obs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('rankCandidates: nameless textboxes disambiguated by groupText Wave Name vs window days', () => {
  resetSeq();
  const pool = [
    elem('textbox', '', { groupText: 'Wave Name' }),
    elem('textbox', '', { groupText: 'Window Start (day)' }),
    elem('textbox', '', { groupText: 'Window End (day)' }),
  ];
  // Shuffle input order so DOM order cannot accidentally save the test.
  const shuffled = [pool[1], pool[2], pool[0]];

  const nameTop = rankCandidates(shuffled, {
    hint: 'name_input',
    demote: ['window_start', 'window_end'],
  })[0].el;
  assert.equal(nameTop.groupText, 'Wave Name', 'name_input must prefer Wave Name groupText');

  const startTop = rankCandidates(shuffled, {
    hint: 'window_start',
    demote: ['name_input', 'window_end'],
  })[0].el;
  assert.equal(startTop.groupText, 'Window Start (day)');

  const endTop = rankCandidates(shuffled, {
    hint: 'window_end',
    demote: ['name_input', 'window_start'],
  })[0].el;
  assert.equal(endTop.groupText, 'Window End (day)');

  // After the name cell holds the visit title (accname from content), groupText
  // must still keep window hints off the name cell.
  resetSeq();
  const afterName = [
    elem('textbox', 'Screening', { groupText: 'Wave Name' }),
    elem('textbox', '', { groupText: 'Window Start (day)' }),
    elem('textbox', '', { groupText: 'Window End (day)' }),
  ];
  const nameStill = rankCandidates(afterName, {
    hint: 'name_input',
    demote: ['window_start', 'window_end'],
  })[0].el;
  assert.equal(nameStill.groupText, 'Wave Name');
  const startStill = rankCandidates(afterName, {
    hint: 'window_start',
    demote: ['name_input', 'window_end'],
  })[0].el;
  assert.equal(startStill.groupText, 'Window Start (day)');
  assert.notEqual(startStill.handle, nameStill.handle);
});

function loadHostile() {
  const base = join(__dirname, '..', 'generalization', 'env-hostile-a11y');
  let html = readFileSync(join(base, 'index.html'), 'utf8');
  const css = readFileSync(join(base, 'style.css'), 'utf8');
  const core = readFileSync(join(base, 'core.js'), 'utf8');
  const ui = readFileSync(join(base, 'ui.js'), 'utf8');
  html = html.replace('</head>', `<style>${css}</style></head>`);
  html = html.replace(
    /<script src="core\.js"><\/script>\s*<script src="ui\.js"><\/script>/,
    `<script>${core}</script><script>${ui}</script>`,
  );
  return new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/env-hostile-a11y/',
  }).window;
}

test('hostile createVisit path: Screening name + window days land in correct cells', async () => {
  const w = loadHostile();
  const act = (o) => ({ doc: w.document, obs: o, settle: async () => {} });

  {
    const o = observe(w.document);
    const add = rankCandidates(enumerateActionable(o), { hint: 'visit_create' })[0]?.el;
    assert.ok(add);
    assert.equal((await click(act(o), add.handle)).ok, true);
  }

  // Name — demote window hints (mirrors orchestrator createVisit).
  {
    const o = observe(w.document);
    const pool = enumerateByRoles(o, ['textbox', 'searchbox']);
    assert.equal(pool.length, 3);
    const nameBox = rankCandidates(pool, {
      hint: 'name_input',
      demote: ['window_start', 'window_end'],
    })[0].el;
    assert.equal(nameBox.groupText, 'Wave Name');
    assert.equal((await setValue(act(o), nameBox.handle, 'Screening')).ok, true);
  }

  // Window start
  {
    const o = observe(w.document);
    const pool = enumerateByRoles(o, ['textbox', 'searchbox']);
    const nameH = rankCandidates(pool, {
      hint: 'name_input',
      demote: ['window_start', 'window_end'],
    })[0].el.handle;
    const startBox = rankCandidates(pool, {
      hint: 'window_start',
      demote: ['name_input', 'window_end'],
    }).map((c) => c.el).find((el) => el.handle !== nameH);
    assert.ok(startBox);
    assert.equal(startBox.groupText, 'Window Start (day)');
    assert.equal((await setValue(act(o), startBox.handle, '-28')).ok, true);
  }

  // Window end
  {
    const o = observe(w.document);
    const pool = enumerateByRoles(o, ['textbox', 'searchbox']);
    const nameH = rankCandidates(pool, {
      hint: 'name_input',
      demote: ['window_start', 'window_end'],
    })[0].el.handle;
    const startH = rankCandidates(pool, {
      hint: 'window_start',
      demote: ['name_input', 'window_end'],
    }).map((c) => c.el).find((el) => el.handle !== nameH)?.handle;
    const endBox = rankCandidates(pool, {
      hint: 'window_end',
      demote: ['name_input', 'window_start'],
    }).map((c) => c.el).find((el) => el.handle !== nameH && el.handle !== startH);
    assert.ok(endBox);
    assert.equal(endBox.groupText, 'Window End (day)');
    assert.equal((await setValue(act(o), endBox.handle, '-1')).ok, true);
  }

  const draft = JSON.parse(w.eval('JSON.stringify(state.ui.visitDraft)'));
  assert.equal(draft.name, 'Screening', `name must not be a day integer; got ${JSON.stringify(draft)}`);
  assert.equal(draft.windowStart, '-28');
  assert.equal(draft.windowEnd, '-1');

  {
    const o = observe(w.document);
    const save = enumerateActionable(o).find((e) => e.name === 'Snapshot Wave');
    assert.ok(save);
    assert.equal((await click(act(o), save.handle)).ok, true);
  }

  const visits = JSON.parse(
    w.eval('JSON.stringify(state.study.visits.map(v => ({name:v.name,ws:v.windowStart,we:v.windowEnd})))'),
  );
  assert.deepEqual(visits, [{ name: 'Screening', ws: '-28', we: '-1' }]);
});
