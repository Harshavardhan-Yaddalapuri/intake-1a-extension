/**
 * env-hostile-a11y live path: perceive sees pointer/contenteditable clickables,
 * but visit.create/open still failed because atVisitList/atVisitDetail did not
 * recognise degrade-path nouns ("+ Add Wave", "+ New Survey") — no a11y names,
 * no Prism id hardcoding.
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
  looksLikeFormCreateControl,
} from '../dist/bind-rung0.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];

/** jsdom does not apply linked style.css; stamp the degrade cursor signal inline. */
function stampPointers(w) {
  w.document.querySelectorAll('.clickable, .link-text').forEach((el) => {
    el.style.cursor = 'pointer';
  });
}

function loadHostile() {
  const base = join(__dirname, '..', 'generalization', 'env-hostile-a11y');
  let html = readFileSync(join(base, 'index.html'), 'utf8');
  const core = readFileSync(join(base, 'core.js'), 'utf8');
  const ui = readFileSync(join(base, 'ui.js'), 'utf8');
  html = html.replace(
    /<script src="core\.js"><\/script>\s*<script src="ui\.js"><\/script>/,
    `<script>${core}</script><script>${ui}</script>`,
  );
  const w = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/env-hostile-a11y/',
  }).window;
  stampPointers(w);
  return w;
}

function clickByLabel(w, label) {
  const el = [...w.document.querySelectorAll('div')].find(
    (d) => (d.textContent || '').trim() === label && (d.className || '').includes('clickable') ||
      ((d.textContent || '').trim() === label && (d.className || '').includes('link-text')),
  );
  // Prefer exact class match for clickable/link-text hosts
  const host = [...w.document.querySelectorAll('.clickable, .link-text')].find(
    (d) => (d.textContent || '').trim() === label,
  );
  assert.ok(host, `missing control "${label}"`);
  host.click();
  stampPointers(w);
  return host;
}

test('hostile-a11y: form-create witness accepts Survey without Prism ids', () => {
  assert.equal(looksLikeFormCreateControl('+ New Survey'), true);
  assert.equal(looksLikeFormCreateControl('+ Add Wave'), false, 'wave create is visit-list, not detail');
  assert.equal(looksLikeFormCreateControl('+ New Phase'), false);
  assert.equal(looksLikeFormCreateControl('+ New Record Sheet'), true);
});

test('hostile-a11y: roster surface is atVisitList via + Add Wave', () => {
  const w = loadHostile();
  const obs = observe(w.document);
  const create = bindVisitCreate(obs);
  assert.ok(create, 'visit.create must bind on degrade roster');
  assert.equal(create.recipe[0].evidence_name, '+ Add Wave');
  assert.equal(atVisitList(obs, VISITS, '+ Add Wave'), true);
  assert.equal(atVisitDetail(obs, 'Screening', VISITS), false);
});

test('hostile-a11y: create + open Screening confirmed via atVisitDetail', () => {
  const w = loadHostile();
  clickByLabel(w, '+ Add Wave');

  const nameCell = w.document.querySelector('#visit-name');
  assert.ok(nameCell, 'Wave Name cell');
  nameCell.textContent = 'Screening';
  nameCell.dispatchEvent(new w.Event('input', { bubbles: true }));
  const start = w.document.querySelector('#visit-start');
  start.textContent = '-28';
  start.dispatchEvent(new w.Event('input', { bubbles: true }));
  const end = w.document.querySelector('#visit-end');
  end.textContent = '-1';
  end.dispatchEvent(new w.Event('input', { bubbles: true }));

  clickByLabel(w, 'Snapshot Wave');

  const listed = observe(w.document);
  assert.equal(atVisitList(listed, VISITS, '+ Add Wave'), true);
  assert.ok(
    listed.elements.some((e) => e.name === 'Screening'),
    `Screening row must be perceived from text content; got ${listed.elements.map((e) => e.name)}`,
  );

  clickByLabel(w, 'Screening');

  const opened = observe(w.document);
  assert.equal(
    atVisitDetail(opened, 'Screening', VISITS),
    true,
    `expected visit detail via + New Survey; actionable=${opened.elements.map((e) => e.name)}`,
  );
  assert.equal(atVisitList(opened, VISITS, '+ Add Wave'), false);
});
