/**
 * Live-oriented env-hostile-a11y visit create+open.
 *
 * Unit tests that stamp cursor:pointer and assign textContent manually hide the
 * two live failure modes that left overall at 0%:
 *   1) Chrome applies CSS cursor:pointer (no inline stamp) — perceive must see
 *      .clickable / .link-text via getComputedStyle.
 *   2) createVisit writes Wave Name via ACT setValue — contenteditable hosts
 *      must accept writes (Snapshot Wave refuses empty names).
 *
 * No Prism #brick / #add-visit hardcoding in assertions beyond fixture setup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import {
  bindVisitCreate,
  atVisitList,
  atVisitDetail,
} from '../dist/bind-rung0.mjs';
import {
  rankCandidates,
  enumerateActionable,
  enumerateByRoles,
} from '../dist/bind-ranking.mjs';
import { setValue, click } from '../dist/act-primitives.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];

function loadHostileLiveLike() {
  const base = join(__dirname, '..', 'generalization', 'env-hostile-a11y');
  let html = readFileSync(join(base, 'index.html'), 'utf8');
  const css = readFileSync(join(base, 'style.css'), 'utf8');
  const core = readFileSync(join(base, 'core.js'), 'utf8');
  const ui = readFileSync(join(base, 'ui.js'), 'utf8');
  // Inject stylesheet (jsdom ignores linked CSS) so getComputedStyle sees
  // cursor:pointer on .clickable / .link-text — matching live Chrome.
  if (html.includes('</head>')) {
    html = html.replace('</head>', `<style>${css}</style></head>`);
  } else {
    html = `<style>${css}</style>` + html;
  }
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

function makeActCtx(w) {
  const obs = observe(w.document);
  return {
    doc: w.document,
    obs,
    settle: async () => {},
  };
}

test('hostile-a11y live-like: CSS cursor:pointer exposes + Add Wave without inline stamp', () => {
  const w = loadHostileLiveLike();
  const obs = observe(w.document);
  const names = obs.elements.map((e) => e.name);
  assert.ok(
    names.includes('+ Add Wave'),
    `expected + Add Wave via computed cursor; got ${JSON.stringify(names)}`,
  );
  const create = bindVisitCreate(obs);
  assert.ok(create, 'visit.create must bind on CSS-styled roster');
  assert.equal(create.recipe[0].evidence_name, '+ Add Wave');
  assert.equal(atVisitList(obs, VISITS, '+ Add Wave'), true);
});

test('hostile-a11y live-like: setValue + Snapshot creates Screening; open reaches detail', async () => {
  const w = loadHostileLiveLike();

  // Click + Add Wave via ACT (same path as live TabDriver).
  {
    const ctx = makeActCtx(w);
    const add = rankCandidates(enumerateActionable(ctx.obs), { hint: 'visit_create' })[0]?.el;
    assert.ok(add, 'visit_create candidate');
    const clicked = await click(ctx, add.handle);
    assert.equal(clicked.ok, true);
  }

  // Fill Wave Name via setValue on contenteditable (live createVisit path).
  // Each input rebuilds the Prism UI — re-perceive after the write (handles go stale).
  {
    const ctx = makeActCtx(w);
    const textPool = enumerateByRoles(ctx.obs, ['textbox', 'searchbox']);
    assert.ok(textPool.length >= 1, `expected visit form textboxes, got ${textPool.map((e) => e.name)}`);
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0]?.el;
    assert.ok(nameBox, 'name input');
    const nameWrite = await setValue(ctx, nameBox.handle, 'Screening');
    assert.equal(nameWrite.ok, true, `name write failed: ${nameWrite.error}`);
  }
  // Window bounds (optional for saveVisit; exercise contenteditable writes with fresh obs).
  {
    const ctx = makeActCtx(w);
    const textPool = enumerateByRoles(ctx.obs, ['textbox', 'searchbox']);
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0]?.el;
    const startBox = rankCandidates(textPool, { hint: 'window_start' })[0]?.el;
    if (startBox && startBox.handle !== nameBox?.handle) {
      assert.equal((await setValue(ctx, startBox.handle, '-28')).ok, true);
    }
  }
  {
    const ctx = makeActCtx(w);
    const textPool = enumerateByRoles(ctx.obs, ['textbox', 'searchbox']);
    const used = new Set();
    const nameBox = rankCandidates(textPool, { hint: 'name_input' })[0]?.el;
    if (nameBox) used.add(nameBox.handle);
    const startBox = rankCandidates(textPool, { hint: 'window_start' })[0]?.el;
    if (startBox) used.add(startBox.handle);
    const endBox = rankCandidates(textPool, { hint: 'window_end' })
      .map((r) => r.el)
      .find((el) => !used.has(el.handle));
    if (endBox) {
      assert.equal((await setValue(ctx, endBox.handle, '-1')).ok, true);
    }
  }

  // Snapshot Wave (commit)
  {
    const ctx = makeActCtx(w);
    const save = enumerateActionable(ctx.obs).find((e) => e.name === 'Snapshot Wave');
    assert.ok(save, 'Snapshot Wave');
    assert.equal((await click(ctx, save.handle)).ok, true);
  }

  const listed = observe(w.document);
  assert.equal(atVisitList(listed, VISITS, '+ Add Wave'), true);
  assert.ok(
    enumerateActionable(listed).some((e) => e.name === 'Screening'),
    `Screening must appear after setValue+Snapshot; got ${enumerateActionable(listed).map((e) => e.name)}`,
  );

  // Open Screening via ACT click
  {
    const ctx = makeActCtx(w);
    const link = enumerateActionable(ctx.obs).find((e) => e.name === 'Screening');
    assert.ok(link);
    assert.equal((await click(ctx, link.handle)).ok, true);
  }

  const opened = observe(w.document);
  assert.equal(
    atVisitDetail(opened, 'Screening', VISITS),
    true,
    `expected detail via + New Survey; actionable=${enumerateActionable(opened).map((e) => e.name)}`,
  );
  assert.equal(atVisitList(opened, VISITS, '+ Add Wave'), false);
});
