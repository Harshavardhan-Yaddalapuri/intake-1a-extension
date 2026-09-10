/**
 * env-hostile-a11y (Prism) field place path.
 *
 * Live v14: forms opened (21/28) but fields criterion stayed 0. Root causes:
 *   1) palette tiles are role=generic → bindFieldAdd skipped them (button-only)
 *   2) Label contenteditable keeps the value as accessible name; groupText
 *      "Label" was ignored by findByRole (`name || group`) and by
 *      executeFieldSetLabel — writes landed in the Fragments filter
 *   3) inspectPlacedControl ignored groupText for panel/range, so every
 *      textbox-family tile looked identical (no declaredCanonical from the
 *      custom Fragment Type dropList)
 *
 * No #brick-* / Prism id hardcoding in the assertion surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { bindFieldAdd, bindFieldSetLabel, findByRole } from '../dist/bind-rung0.mjs';
import { inspectPlacedControl, classifyTypeFromProbe, readDeclaredCanonical } from '../dist/bind-rung1.mjs';
import { enumerateActionable, rankCandidates, enumerateByRoles } from '../dist/bind-ranking.mjs';
import { setValue, click } from '../dist/act-primitives.mjs';
import { CANONICAL_TYPES } from '../dist/contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const base = join(__dirname, '..', 'generalization', 'env-hostile-a11y');

function load() {
  let html = readFileSync(join(base, 'index.html'), 'utf8');
  const css = readFileSync(join(base, 'style.css'), 'utf8');
  const core = readFileSync(join(base, 'core.js'), 'utf8');
  const ui = readFileSync(join(base, 'ui.js'), 'utf8');
  html = html.includes('</head>')
    ? html.replace('</head>', `<style>${css}</style></head>`)
    : `<style>${css}</style>` + html;
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

function ctx(w) {
  const obs = observe(w.document);
  return { doc: w.document, obs, settle: async () => {} };
}

async function mustClick(w, name) {
  const c = ctx(w);
  const el = enumerateActionable(c.obs).find((e) => e.name === name);
  assert.ok(el, `missing ${name}; have=${enumerateActionable(c.obs).map((e) => e.name)}`);
  assert.equal((await click(c, el.handle)).ok, true);
}

async function openBuilder(w) {
  await mustClick(w, '+ Add Wave');
  {
    const c = ctx(w);
    const nameBox = rankCandidates(enumerateByRoles(c.obs, ['textbox', 'searchbox']), { hint: 'name_input' })[0]?.el;
    assert.ok(nameBox);
    assert.equal((await setValue(c, nameBox.handle, 'Screening')).ok, true);
  }
  await mustClick(w, 'Snapshot Wave');
  await mustClick(w, 'Screening');
  await mustClick(w, '+ New Survey');
  {
    const c = ctx(w);
    const nameBox = rankCandidates(enumerateByRoles(c.obs, ['textbox', 'searchbox']), { hint: 'name_input' })[0]?.el;
    assert.equal((await setValue(c, nameBox.handle, 'Demographics')).ok, true);
  }
  await mustClick(w, 'Create');
  await mustClick(w, 'Modify');
}

test('hostile-a11y: generic palette tiles bind text via Glyph Line synonym', async () => {
  const w = load();
  await openBuilder(w);
  const obs = observe(w.document);
  const tile = enumerateActionable(obs).find((e) => e.name === 'Glyph Line');
  assert.ok(tile, 'Fragments tile Glyph Line must be actionable');
  assert.equal(tile.role, 'generic', 'Prism tiles are role-less clickable divs');
  const binding = bindFieldAdd(obs, 'text');
  assert.ok(binding, 'field.add(text) must bind on generic palette tiles');
  assert.equal(binding.recipe[0].evidence_name, 'Glyph Line');
  assert.equal(binding.recipe[0].evidence_role, 'generic');
});

test('hostile-a11y: place Glyph Line + set_label via groupText Label persists in GT', async () => {
  const w = load();
  await openBuilder(w);
  const before = observe(w.document);
  const tile = enumerateActionable(before).find((e) => e.name === 'Glyph Line');
  assert.equal((await click(ctx(w), tile.handle)).ok, true);
  const after = observe(w.document);

  // Prism: accessible name is the value ("Glyph Line"); only groupText says Label.
  // findByRole uses name||groupText (blank-name fallback), so use groupText directly.
  const labelEl = after.elements.find(
    (e) => e.role === 'textbox' && /^label\b/i.test((e.groupText || '').trim()),
  );
  assert.ok(labelEl, `Label cell via groupText; have=${after.elements.filter((e) => e.role === 'textbox').map((e) => e.name + '/' + e.groupText)}`);
  assert.equal((await setValue(ctx(w), labelEl.handle, 'Subject Initials')).ok, true);

  const setLabel = bindFieldSetLabel(observe(w.document));
  assert.ok(setLabel, 'field.set_label binds');

  await mustClick(w, 'Snapshot');
  const form = w.__groundTruth().study.visits[0].forms[0];
  assert.equal(form.fields.length, 1, `expected 1 field in GT, got ${JSON.stringify(form.fields)}`);
  assert.equal(form.fields[0].label, 'Subject Initials');
  assert.equal(form.fields[0].type, 'text');
});

test('hostile-a11y: inspect distinguishes date / integer / text tiles', async () => {
  async function probe(tileName) {
    const w = load();
    await openBuilder(w);
    const before = observe(w.document);
    const tile = enumerateActionable(before).find((e) => e.name === tileName);
    assert.ok(tile, tileName);
    await click(ctx(w), tile.handle);
    const after = observe(w.document);
    const probe = inspectPlacedControl(before, after);
    const matches = CANONICAL_TYPES.filter((t) => classifyTypeFromProbe(t, probe).matches);
    return { probe, matches };
  }

  const text = await probe('Glyph Line');
  assert.ok(text.matches.includes('text'), `Glyph Line matches=${text.matches}`);
  assert.ok(!text.matches.includes('date'), `text must not claim date: ${text.matches}`);

  const date = await probe('Sun Marker');
  assert.ok(date.matches.includes('date'), `Sun Marker matches=${date.matches}`);
  assert.equal(date.matches.includes('text'), false, `date must not claim text: ${date.matches}`);

  const integer = await probe('Count Int');
  assert.ok(integer.matches.includes('integer'), `Count Int matches=${integer.matches}`);
  assert.equal(integer.matches.includes('decimal'), false, `integer must not claim decimal: ${integer.matches}`);
});

test('hostile-a11y: Fragment Type groupText yields declaredCanonical for Glyph Line', async () => {
  const w = load();
  await openBuilder(w);
  const before = observe(w.document);
  await click(ctx(w), enumerateActionable(before).find((e) => e.name === 'Glyph Line').handle);
  const after = observe(w.document);
  const panel = after.elements.filter(
    (e) => /type/i.test(e.name) || /type/i.test(e.groupText || ''),
  );
  const declared = readDeclaredCanonical(panel);
  assert.equal(declared, 'text', `declaredCanonical from Fragment Type; panel=${JSON.stringify(panel.map((e) => ({ role: e.role, name: e.name, group: e.groupText, val: e.state?.value })))}`);
});
