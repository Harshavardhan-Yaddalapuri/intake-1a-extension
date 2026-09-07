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

// ---------------------------------------------------------------------------
// Range state (scoring criterion 9).
// ---------------------------------------------------------------------------

test('state: native min/max on a number input', () => {
  const d = doc(`<input id="x" type="number" min="30" max="200" />`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 30, max: 200 });
});

test('state: native step is captured', () => {
  const d = doc(`<input id="x" type="number" min="0" max="10" step="0.1" />`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 0, max: 10, step: 0.1 });
});

test('state: aria-valuemin/aria-valuemax on a custom control', () => {
  const d = doc(`<div id="x" role="spinbutton" aria-valuemin="1" aria-valuemax="5"></div>`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 1, max: 5 });
});

test('state: aria wins over native for range', () => {
  const d = doc(`<input id="x" type="number" min="1" max="2" aria-valuemin="10" aria-valuemax="20" />`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 10, max: 20 });
});

test('state: a partial range records only what is present', () => {
  const d = doc(`<input id="x" type="number" min="5" />`);
  assert.deepEqual(computeState(el(d, '#x')).range, { min: 5 });
});

test('state: range is absent when no bound is declared', () => {
  const d = doc(`<input id="x" type="number" />`);
  assert.equal(computeState(el(d, '#x')).range, undefined);
});

test('state: non-numeric min/max values are ignored', () => {
  const d = doc(`<input id="x" type="number" min="abc" max="200" />`);
  assert.deepEqual(computeState(el(d, '#x')).range, { max: 200 });
});

// ---------------------------------------------------------------------------
// A clickable box AROUND controls is a container, not a control.
//
// Live (2026-09-07, run-1788807654779): the review queue held 222 items after a
// clean build. This designer draws every field as a card that selects when
// clicked -- `.element-card { cursor: pointer }` -- so PERCEIVE promoted the
// card to a control, named by everything written inside it. That name opens
// with the field's own label, so on all 195 fields the card collided with the
// control it contained:
//
//   "more than one element resolves to the label \"Ethnicity\""
//   "element \"Sex at Birth\" has role \"generic\" but intent radio expects ..."
//
// and, where the field is realised as one control per option, the card joined
// the option group as a member of a different role and dissolved it.
//
// Nothing here is visible without the stylesheet, which is why these cases
// carry one.
// ---------------------------------------------------------------------------

function styled(css, html) {
  return new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`,
    { pretendToBeVisual: true },
  ).window.document;
}

const CARD_CSS = '.card { cursor: pointer } .plain-click { cursor: pointer }';

test('a clickable card wrapping a control is not itself a control', () => {
  const d = styled(CARD_CSS, `
    <div class="card"><span>Ethnicity</span><span>Dropdown</span>
      <select aria-label="Ethnicity"><option>Hispanic or Latino</option></select></div>`);
  assert.equal(d.defaultView.getComputedStyle(el(d, '.card')).cursor, 'pointer',
    'the stylesheet is what makes this case exist at all');

  const names = observe(d).elements.map((e) => e.name);
  assert.deepEqual(names, ['Ethnicity'], 'the select, and nothing wrapping it');
});

test('a clickable card wrapping options does not dissolve the option group', () => {
  const d = styled(CARD_CSS, `
    <div class="card"><span>Sex at Birth *</span><span>Radio Buttons · Required</span>
      <input type="radio" aria-label="Sex at Birth: Female">
      <input type="radio" aria-label="Sex at Birth: Male"></div>`);
  const roles = new Set(observe(d).elements.map((e) => e.role));
  assert.deepEqual([...roles], ['radio'], 'one role, so the group holds');
});

test('a clickable box with no controls in it is still a control', () => {
  // The heuristic exists for a reason: platforms do build controls out of
  // plain divs. Only the ones wrapping other controls are demoted.
  const d = styled(CARD_CSS, `<div class="plain-click">Add Visit</div>`);
  const els = observe(d).elements;
  assert.equal(els.length, 1);
  assert.equal(els[0].name, 'Add Visit');
});

test('a control that declares itself is unaffected by what it contains', () => {
  const d = styled(CARD_CSS, `
    <div class="card" role="button" tabindex="0">Save<span>and close</span></div>`);
  assert.equal(observe(d).elements.length, 1, 'an ARIA role wins over the wrapper rule');
});

// `cursor` is an INHERITED property.
//
// Live (2026-09-07, run-1788807654779): 222 items in the review queue after a
// clean build, and the largest family was "more than one element resolves to
// the label X". Read off the running platform in Chrome, every div and span
// inside `.element-card { cursor: pointer }` computes to `cursor: pointer`:
//
//   div.element-head     "EthnicityDropdown"
//   span.element-label   "Ethnicity"          <- named exactly the field
//   span.element-meta    "Dropdown"
//   div.element-preview  "— Select —Hispanic or Latino..."
//
// So each field arrived as four extra "controls", one of them wearing the
// field's own name. It duplicated every optional field, and on fields realised
// as one control per option ("Race: White", ...) the span was the ONLY exact
// match, which is where "element \"Race\" has role \"generic\"" came from.
//
// jsdom does not inherit `cursor`, which is why a probe run against it saw
// none of this. These cases spell the inheritance out.
// ---------------------------------------------------------------------------

const INHERITED_POINTER = '.card { cursor: pointer } .card * { cursor: pointer }';

test('an inherited pointer cursor does not make text a control', () => {
  const d = styled(INHERITED_POINTER, `
    <div class="card"><div class="head"><span class="label">Ethnicity</span><span>Dropdown</span></div>
      <div class="preview"><select aria-label="Ethnicity"><option>Hispanic or Latino</option></select></div></div>`);
  assert.equal(d.defaultView.getComputedStyle(el(d, '.label')).cursor, 'pointer',
    'the span really does compute to pointer -- that is the trap');

  const names = observe(d).elements.map((e) => e.name);
  assert.deepEqual(names, ['Ethnicity'], 'one Ethnicity, and it is the select');
});

test('an inherited pointer cursor does not shadow a field built from options', () => {
  // The label span was the only element named exactly "Race"; the controls that
  // actually realise the field are named "Race: White" and so on. The field
  // resolved to the span, reported role "generic", and was queued for review.
  const d = styled(INHERITED_POINTER, `
    <div class="card"><span class="label">Race</span>
      <input type="checkbox" aria-label="Race: White">
      <input type="checkbox" aria-label="Race: Asian"></div>`);
  const named = observe(d).elements.filter((e) => e.name === 'Race');
  assert.deepEqual(named, [], 'nothing answers to the bare label but the option group');
});

test('the element that declares the pointer cursor is still a control', () => {
  const d = styled('.outer { cursor: default } .plain-click { cursor: pointer }',
    `<div class="outer"><div class="plain-click">Add Visit</div></div>`);
  assert.deepEqual(observe(d).elements.map((e) => e.name), ['Add Visit']);
});
