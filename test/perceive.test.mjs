import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  computeAccname,
  computeRole,
  computeOptions,
  computeState,
  observe,
  diffObservations,
  structuralPath,
} from '../dist/perceive-core.mjs';

function doc(html) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

function el(d, selector) {
  const found = d.querySelector(selector);
  assert.ok(found, `selector not found: ${selector}`);
  return found;
}

// ---------------------------------------------------------------------------
// accname fallback ladder: each tier in order.
// ---------------------------------------------------------------------------

test('accname: aria-labelledby wins over everything', () => {
  const d = doc(`
    <span id="lbl">Labelled By Name</span>
    <input id="x" aria-labelledby="lbl" aria-label="Aria Label" placeholder="Placeholder" title="Title" />
  `);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'Labelled By Name');
  assert.equal(r.source, 'labelledby');
});

test('accname: aria-label is second', () => {
  const d = doc(`<input id="x" aria-label="Aria Label" placeholder="Placeholder" title="Title" />`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'Aria Label');
  assert.equal(r.source, 'aria-label');
});

test('accname: label[for] is third', () => {
  const d = doc(`<label for="x">For Label</label><input id="x" placeholder="Placeholder" title="Title" />`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'For Label');
  assert.equal(r.source, 'for');
});

test('accname: wrapped label is fourth', () => {
  const d = doc(`<label>Wrapped Label <input id="x" placeholder="Placeholder" title="Title" /></label>`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'Wrapped Label');
  assert.equal(r.source, 'wrapped');
});

test('accname: placeholder is fifth and marks label-uncertain', () => {
  const d = doc(`<input id="x" placeholder="Placeholder Name" />`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'Placeholder Name');
  assert.equal(r.source, 'placeholder');
});

test('accname: title is sixth and marks label-uncertain', () => {
  const d = doc(`<input id="x" title="Title Name" />`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'Title Name');
  assert.equal(r.source, 'title');
});

test('accname: button falls through to content', () => {
  const d = doc(`<button id="x">Click Me</button>`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, 'Click Me');
  assert.equal(r.source, 'content');
});

test('accname: absent name returns none', () => {
  const d = doc(`<input id="x" type="text" />`);
  const r = computeAccname(el(d, '#x'), d);
  assert.equal(r.name, '');
  assert.equal(r.source, 'none');
});

// ---------------------------------------------------------------------------
// Role computation.
// ---------------------------------------------------------------------------

test('role: native select is combobox, multiple select is listbox', () => {
  const d = doc(`<select id="a"></select><select id="b" multiple></select>`);
  assert.equal(computeRole(el(d, '#a')), 'combobox');
  assert.equal(computeRole(el(d, '#b')), 'listbox');
});

test('role: input types map to ARIA roles', () => {
  const d = doc(`<input id="c" type="checkbox" /><input id="r" type="radio" /><input id="n" type="number" />`);
  assert.equal(computeRole(el(d, '#c')), 'checkbox');
  assert.equal(computeRole(el(d, '#r')), 'radio');
  assert.equal(computeRole(el(d, '#n')), 'spinbutton');
});

test('role: explicit role attribute wins', () => {
  const d = doc(`<div id="x" role="tab">Tab</div>`);
  assert.equal(computeRole(el(d, '#x')), 'tab');
});

// ---------------------------------------------------------------------------
// Option vocabulary.
// ---------------------------------------------------------------------------

test('options: native select reads option children', () => {
  const d = doc(`<select id="x"><option>Alpha</option><option>Beta</option><option>Gamma</option></select>`);
  assert.deepEqual(computeOptions(el(d, '#x'), 'combobox', d), ['Alpha', 'Beta', 'Gamma']);
});

test('options: radiogroup reads radio descendants', () => {
  const d = doc(`
    <div id="x" role="radiogroup">
      <label><input type="radio" name="g" /> Red</label>
      <label><input type="radio" name="g" /> Green</label>
    </div>
  `);
  assert.deepEqual(computeOptions(el(d, '#x'), 'radiogroup', d), ['Red', 'Green']);
});

// ---------------------------------------------------------------------------
// Handle stability across two snapshots of the same page.
// ---------------------------------------------------------------------------

test('handle: stable across two observations of an unchanged page', () => {
  const d = doc(`
    <button id="a">One</button>
    <input id="b" aria-label="Two" />
    <select id="c"><option>X</option></select>
  `);
  const first = observe(d);
  const second = observe(d);
  assert.equal(first.elements.length, second.elements.length);
  const firstHandles = first.elements.map((e) => e.handle);
  const secondHandles = second.elements.map((e) => e.handle);
  assert.deepEqual(secondHandles, firstHandles);
  // Handles are unique within a snapshot.
  assert.equal(new Set(firstHandles).size, firstHandles.length);
});

test('handle: structural path is deterministic', () => {
  const d = doc(`<div><button id="a">One</button></div>`);
  const path = structuralPath(el(d, '#a'));
  assert.equal(path, '1.0.0'); // html > body > div > button (jsdom inserts head)
});

test('diff: added and changed are detected', () => {
  const d = doc(`<button id="a">One</button><button id="b">Two</button>`);
  const first = observe(d);
  // Change a's label, append c at a new position (b stays put).
  el(d, '#a').textContent = 'One Changed';
  const c = d.createElement('button');
  c.id = 'c';
  c.textContent = 'Three';
  d.body.appendChild(c);
  const second = observe(d);
  const diff = diffObservations(first, second);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 0);
});

test('diff: removed is detected', () => {
  const d = doc(`<button id="a">One</button><button id="b">Two</button>`);
  const first = observe(d);
  el(d, '#b').remove();
  const second = observe(d);
  const diff = diffObservations(first, second);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.changed.length, 0);
});

test('observe: label-uncertain flag set for placeholder/title/absent names', () => {
  const d = doc(`
    <input id="p" placeholder="ph" />
    <input id="t" title="ti" />
    <input id="n" type="text" />
    <input id="l" aria-label="labelled" />
  `);
  const obs = observe(d);
  const byName = new Map(obs.elements.map((e) => [e.name, e]));
  assert.equal(byName.get('ph')?.labelUncertain, true);
  assert.equal(byName.get('ti')?.labelUncertain, true);
  assert.equal(byName.get('labelled')?.labelUncertain, false);
  // The unnamed input is present and uncertain.
  const unnamed = obs.elements.find((e) => e.name === '');
  assert.ok(unnamed);
  assert.equal(unnamed.labelUncertain, true);
});

// ---------------------------------------------------------------------------
// Required state (scoring criterion 7).
// ---------------------------------------------------------------------------

test('state: aria-required="true" sets required', () => {
  const d = doc(`<input id="x" aria-required="true" />`);
  assert.equal(computeState(el(d, '#x')).required, true);
});

test('state: aria-required="false" sets required false', () => {
  const d = doc(`<input id="x" aria-required="false" />`);
  assert.equal(computeState(el(d, '#x')).required, false);
});

test('state: native required attribute sets required', () => {
  const d = doc(`<input id="x" required />`);
  assert.equal(computeState(el(d, '#x')).required, true);
});

test('state: aria-required wins over native attribute', () => {
  const d = doc(`<input id="x" required aria-required="false" />`);
  assert.equal(computeState(el(d, '#x')).required, false);
});

test('state: required is absent when neither signal is present', () => {
  const d = doc(`<input id="x" />`);
  assert.equal(computeState(el(d, '#x')).required, undefined);
});

test('state: required works on non-input roles', () => {
  const d = doc(`<div id="x" role="combobox" aria-required="true"></div>`);
  assert.equal(computeState(el(d, '#x')).required, true);
});
