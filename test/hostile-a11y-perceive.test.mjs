/**
 * Hostile-a11y perception degrade path.
 *
 * env-hostile-a11y (PrismForm) builds controls from role-less divs:
 *   - div.clickable (buttons) with CSS/inline cursor:pointer
 *   - div[contenteditable] text/area cells (textbox stand-ins)
 *   - onclick= / toggle / list widgets with no ARIA
 *
 * These tests use a minimal DOM shaped like that environment — no Prism ids,
 * no class-name hardcoding in the assertion surface beyond describing the
 * fixture. observe() must return actionable buttons/fields with sensible names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { computeRole, observe } from '../dist/perceive-core.mjs';

function doc(html) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

test('hostile-a11y: contenteditable cells are textbox interactive controls', () => {
  const d = doc(`
    <div class="field-row">
      <span class="field-label">Wave Name</span>
      <div class="text-cell" contenteditable="true"><span class="cell-text">Screening</span></div>
    </div>
    <div class="field-row">
      <span class="field-label">Notes</span>
      <div class="area-cell" contenteditable="true"><span class="cell-text"></span></div>
    </div>
  `);
  const obs = observe(d);
  const editables = obs.elements.filter((e) => e.role === 'textbox');
  assert.ok(editables.length >= 2, `expected >=2 textboxes, got ${editables.length}: ${JSON.stringify(obs.elements)}`);
  for (const e of editables) {
    assert.equal(e.role, 'textbox');
    assert.equal(e.tagName, 'div');
  }
  // Names come from text content (accname content tier) when present.
  const named = editables.find((e) => e.name === 'Screening');
  assert.ok(named, 'contenteditable with visible text is named from content');
  assert.equal(computeRole(d.querySelector('.text-cell')), 'textbox');
});

test('hostile-a11y: inline cursor:pointer divs are observed as buttons (no stylesheet)', () => {
  // Class "clickable" alone is intentionally NOT the signal — the fixture
  // stamps cursor:pointer inline the way a degrade path must work without CSS.
  const d = doc(`
    <div class="clickable" style="cursor:pointer"><span>Snapshot Wave</span></div>
    <div class="clickable" style="cursor: pointer"><span>Cancel</span></div>
    <div class="not-a-control"><span>Wave Roster</span></div>
  `);
  const obs = observe(d);
  const names = obs.elements.map((e) => e.name);
  assert.ok(obs.elements.length >= 2, `expected interactive controls, got ${JSON.stringify(obs.elements)}`);
  assert.ok(names.includes('Snapshot Wave'), `missing Snapshot Wave in ${JSON.stringify(names)}`);
  assert.ok(names.includes('Cancel'), `missing Cancel in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('Wave Roster'), 'plain text without pointer/contenteditable must stay invisible');
});

test('hostile-a11y: mixed fixture returns actionable buttons and fields', () => {
  const d = doc(`
    <div class="top-bar">
      <div style="cursor:pointer"><span>Wave Roster</span></div>
      <div style="cursor:pointer"><span>+ Add Wave</span></div>
    </div>
    <div class="card">
      <div class="field-row">
        <span class="field-label">Wave Name</span>
        <div contenteditable="true"><span></span></div>
      </div>
      <div class="actions">
        <div style="cursor:pointer" onclick="void(0)"><span>Snapshot Wave</span></div>
        <div style="cursor:pointer"><span>Cancel</span></div>
      </div>
    </div>
  `);
  const beforeShape = {
    buttons: [...d.querySelectorAll('button')].length,
    inputs: [...d.querySelectorAll('input,textarea,select')].length,
    roles: [...d.querySelectorAll('[role]')].length,
  };
  assert.deepEqual(beforeShape, { buttons: 0, inputs: 0, roles: 0 }, 'fixture stays a11y-hostile');

  const obs = observe(d);
  assert.ok(obs.elements.length > 0, 'observe must not return an empty candidate list on hostile DOM');

  const byName = new Map(obs.elements.map((e) => [e.name, e]));
  for (const label of ['Wave Roster', '+ Add Wave', 'Snapshot Wave', 'Cancel']) {
    assert.ok(byName.has(label), `missing actionable "${label}" in ${[...byName.keys()]}`);
  }
  const fields = obs.elements.filter((e) => e.role === 'textbox');
  assert.ok(fields.length >= 1, 'contenteditable field must appear as textbox');
});

test('hostile-a11y: contenteditable false is not a textbox host', () => {
  const d = doc(`<div contenteditable="false">Leave me alone</div>`);
  const obs = observe(d);
  assert.equal(obs.elements.length, 0);
});

test('hostile-a11y: card wrapping contenteditable is container, not duplicate control', () => {
  const d = doc(`
    <div class="element-card" style="cursor:pointer">
      <span>Wave Name</span>
      <div contenteditable="true"><span>Screening</span></div>
    </div>
  `);
  const obs = observe(d);
  const names = obs.elements.map((e) => e.name);
  // The editable cell is the control; the pointer-styled card around it is not.
  assert.ok(obs.elements.some((e) => e.role === 'textbox'), `expected textbox in ${JSON.stringify(obs.elements)}`);
  assert.equal(
    obs.elements.filter((e) => e.role === 'generic' && e.name.includes('Wave Name')).length,
    0,
    `card must not also appear as a named generic control: ${JSON.stringify(names)}`,
  );
});
