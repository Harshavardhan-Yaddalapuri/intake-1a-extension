/**
 * Tip 5dc7ac7 broadened Prism zero-ARIA paths (generic tiles, findByRole
 * name|groupText OR, namesSuggestIn groupText) and FormCraft wizard collapsed:
 * live v14 77.51% → v15 30.93%, with date/integer fields stored as multi_select.
 *
 * These guards keep Prism working while restoring named-ARIA (wizard) behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { bindFieldAdd, findByRole } from '../dist/bind-rung0.mjs';
import { inspectPlacedControl, classifyTypeFromProbe } from '../dist/bind-rung1.mjs';
import { enumerateActionable } from '../dist/bind-ranking.mjs';
import { click } from '../dist/act-primitives.mjs';
import { CANONICAL_TYPES } from '../dist/contract.mjs';
import {
  findWizardAdvanceControl,
  isSafePaletteProbeCandidate as safePalette,
} from '../dist/probe-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wizardDir = join(__dirname, '..', 'generalization', 'env-wizard');

function loadWizard() {
  let html = readFileSync(join(wizardDir, 'index.html'), 'utf8');
  html = html.replace(
    '<script src="core.js"></script>\n<script src="ui.js"></script>',
    `<script>${readFileSync(join(wizardDir, 'core.js'), 'utf8')}</script>\n` +
      `<script>${readFileSync(join(wizardDir, 'ui.js'), 'utf8')}</script>`,
  );
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true }).window;
}

function setupBuilder(w) {
  w.eval(`(function() {
    var v = { id: "v1", name: "V1", windowStart: "0", windowEnd: "7", forms: [] };
    var f = { id: "f1", name: "F1", repeating: false, status: "draft", version: 1,
      pages: [{ id: "pg1", name: "P1", elements: [] }] };
    v.forms.push(f);
    commit(Object.assign({}, state, { study: { name: "ABC-101", visits: [v] } }));
    openBuilder("v1", "f1");
  })();`);
}

function ctx(w) {
  const obs = observe(w.document);
  return { doc: w.document, obs, settle: async () => {} };
}

async function reveal(w, before, after) {
  let current = after;
  for (let step = 0; step < 6; step += 1) {
    const probe = inspectPlacedControl(before, current);
    if (probe.declaredCanonical || probe.hasOptionsEditor) return { current, probe };
    if (['radiogroup', 'radio', 'combobox', 'listbox'].includes(probe.observedRole)) {
      return { current, probe };
    }
    const advance = findWizardAdvanceControl(current);
    if (!advance) return { current, probe };
    await click(ctx(w), advance.handle);
    current = observe(w.document);
  }
  return { current, probe: inspectPlacedControl(before, current) };
}

test('findByRole does not OR-match groupText when name is set', () => {
  const obs = {
    snapshotId: 't',
    url: 'http://x/',
    elements: [
      {
        index: 1,
        handle: '1',
        role: 'textbox',
        name: 'Question Text',
        nameSource: 'for',
        labelUncertain: false,
        state: {},
        options: [],
        tagName: 'input',
        groupText: 'Label panel chrome',
      },
      {
        index: 2,
        handle: '2',
        role: 'textbox',
        name: '',
        nameSource: 'none',
        labelUncertain: true,
        state: {},
        options: [],
        tagName: 'input',
        groupText: 'Label',
      },
    ],
  };
  const hits = findByRole(obs, 'textbox', { contains: 'label' });
  assert.equal(hits.length, 1, 'named Question Text must not match via groupText');
  assert.equal(hits[0].el.handle, '2');
});

test('bindFieldAdd prefers buttons over generic synonym tiles', () => {
  const obs = {
    snapshotId: 't',
    url: 'http://x/',
    elements: [
      {
        index: 1,
        handle: 'g1',
        role: 'generic',
        name: 'Glyph Line',
        nameSource: 'content',
        labelUncertain: false,
        state: {},
        options: [],
        tagName: 'div',
      },
      {
        index: 2,
        handle: 'b1',
        role: 'button',
        name: 'T Brief Answer',
        nameSource: 'content',
        labelUncertain: false,
        state: {},
        options: [],
        tagName: 'button',
      },
    ],
  };
  // "Brief Answer" has no text synonym — binding may be null; add a real text button.
  obs.elements[1].name = 'Single Line Textbox';
  const binding = bindFieldAdd(obs, 'text');
  assert.ok(binding);
  assert.equal(binding.recipe[0].evidence_role, 'button');
  assert.equal(binding.recipe[0].evidence_name, 'Single Line Textbox');
});

test('bindFieldAdd accepts generic tiles when no buttons score', () => {
  const obs = {
    snapshotId: 't',
    url: 'http://x/',
    elements: [
      {
        index: 1,
        handle: 'g1',
        role: 'generic',
        name: 'Glyph Line',
        nameSource: 'content',
        labelUncertain: false,
        state: {},
        options: [],
        tagName: 'div',
      },
      {
        index: 2,
        handle: 'b1',
        role: 'button',
        name: 'Save',
        nameSource: 'content',
        labelUncertain: false,
        state: {},
        options: [],
        tagName: 'button',
      },
    ],
  };
  const binding = bindFieldAdd(obs, 'text');
  assert.ok(binding);
  assert.equal(binding.recipe[0].evidence_role, 'generic');
  assert.equal(binding.recipe[0].evidence_name, 'Glyph Line');
});

test('wizard palette sweep: date/integer/boolean bind their own tiles, not Tick Many', async () => {
  const w = loadWizard();
  setupBuilder(w);
  w.openLibrary();
  const opening = observe(w.document);
  const candidates = enumerateActionable(opening).filter((e) => safePalette(e.name));
  const bindings = {};

  for (const btn of candidates) {
    const w2 = loadWizard();
    setupBuilder(w2);
    w2.openLibrary();
    const before = observe(w2.document);
    const tile = enumerateActionable(before).find((e) => e.name === btn.name);
    if (!tile) continue;
    await click(ctx(w2), tile.handle);
    const after = observe(w2.document);
    const { probe } = await reveal(w2, before, after);
    const matches = CANONICAL_TYPES.filter((t) => classifyTypeFromProbe(t, probe).matches);
    const specificity = matches.length || 99;
    for (const m of matches) {
      const existing = bindings[m];
      const prevSpec = existing?.spec ?? 99;
      const declaredRank = probe.declaredCanonical === m ? 0 : 1;
      const prevDeclared = existing?.declared ? 0 : 1;
      if (
        !existing
        || specificity < prevSpec
        || (specificity === prevSpec && declaredRank < prevDeclared)
      ) {
        bindings[m] = {
          name: btn.name,
          spec: specificity,
          declared: !!probe.declaredCanonical && probe.declaredCanonical === m,
        };
      }
    }
  }

  assert.equal(bindings.date?.name, '⊞ Day Marker', `date→${bindings.date?.name}`);
  assert.equal(bindings.integer?.name, '℔ Round Figure', `integer→${bindings.integer?.name}`);
  assert.equal(bindings.multi_select?.name, '✓✓ Tick Many', `multi→${bindings.multi_select?.name}`);
  assert.notEqual(bindings.date?.name, bindings.multi_select?.name);
  assert.ok(bindings.boolean, 'boolean must bind');
  assert.notEqual(bindings.boolean?.name, '☰', 'hamburger must not steal boolean');
  assert.equal(bindings.boolean?.name, '⇅ Truth Switch');
  assert.equal(bindings.checkbox?.name, '☐ Confirm Box');
});

test('hamburger Commit must not classify as boolean', async () => {
  const w = loadWizard();
  setupBuilder(w);
  w.openLibrary();
  const before = observe(w.document);
  const burger = enumerateActionable(before).find((e) => e.name === '☰');
  await click(ctx(w), burger.handle);
  const probe = inspectPlacedControl(before, observe(w.document));
  assert.equal(classifyTypeFromProbe('boolean', probe).matches, false);
});
