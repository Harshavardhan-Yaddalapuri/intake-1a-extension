// A field is not always ONE control.
//
// Live (2026-09-06, run-1788670028717): 100 of 195 fields were reported for
// human review, and they partitioned exactly by type --
//
//   59  no element with accessible name "X" found      every integer + decimal
//   25  more than one element resolves to "X"          25 of 26 dropdowns
//   16  has role "generic" but expects [radiogroup]    all radio + multi_select
//
// Not 100 problems. Two defects.
//
// (1) A choice field is realised as one control PER OPTION, named
//     "Sex at Birth: Female", "Sex at Birth: Male", ... with no wrapper
//     carrying the field's own name. Confirmed against the running mock:
//       input[radio]:"Sex at Birth: Female"   input[radio]:"Sex at Birth: Male"
//     Nothing is called "Sex at Birth", so the field read as missing.
//
// (2) The canvas is STALE while the form is being built. Confirmed live: after
//     typing the label, the Options panel held "Height" while the preview still
//     read "Number (Decimal)" and its units span was empty -- the platform
//     re-renders only when the form's shape changes. Saving fixed it, and the
//     saved record was correct all along. That is handled in the orchestrator
//     by re-checking after commit; this file covers (1) and the traps that
//     make (1) dangerous to fix carelessly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { compareIntent, resolveByName } from '../dist/verify.mjs';

const card = (label, inner) => `<div class="element-card">
  <div class="element-head"><span class="element-label">${label}</span></div>
  <div class="element-preview">${inner}</div></div>`;

const screen = (html) => observe(
  new JSDOM(`<!doctype html><html><body><div id="app">${html}</div></body></html>`).window.document,
);

const intent = (canonical_type, label, extra = {}) => ({
  visit_id: 'v0', form_id: 'f0', field_id: 'x', canonical_type, label, required: false, ...extra,
});

const choices = (kind, label, values) => values
  .map((v) => `<span class="choice"><input type="${kind}" aria-label="${label}: ${v}">${v}</span>`)
  .join('');

test('a radio rendered as one input per option verifies', () => {
  const obs = screen(card('Sex at Birth', choices('radio', 'Sex at Birth', ['Female', 'Male', 'Undisclosed'])));
  assert.equal(
    obs.elements.filter((e) => e.name === 'Sex at Birth').length, 0,
    'nothing carries the field name -- that is the whole difficulty',
  );
  assert.equal(compareIntent(obs, intent('radio', 'Sex at Birth')).verdict, 'VERIFIED');
});

test('a multi-select rendered as one checkbox per option verifies', () => {
  const obs = screen(card('Race', choices('checkbox', 'Race', ['White', 'Asian', 'Other'])));
  assert.equal(compareIntent(obs, intent('multi_select', 'Race')).verdict, 'VERIFIED');
});

test('a LONE tick box is still not a multi-select', () => {
  // The near-miss the brief warns about: a list-of-choices control and a single
  // tick box sit one row apart. Accepting the option role unconditionally would
  // erase this distinction, so it is accepted only when a GROUP was observed.
  const obs = screen(card('Race', `<span class="choice"><input type="checkbox" aria-label="Race">Race</span>`));
  const r = compareIntent(obs, intent('multi_select', 'Race'));
  assert.equal(r.verdict, 'AMBIGUOUS', 'one checkbox is a boolean, not a list of choices');
});

test('a neighbouring field is never swallowed', () => {
  // "Height" must not resolve against "Height Velocity" -- both are real fields
  // that coexist in studies, and a field resolving to its neighbour is never
  // built. The option-group rule requires a separator after the label.
  const obs = screen(card('Height Velocity', `<input type="text" aria-label="Height Velocity">`));
  assert.equal(compareIntent(obs, intent('decimal', 'Height')).verdict, 'FAILED');
});

test('an option group needs at least two members of the SAME role', () => {
  // One option is not a group; mixed roles are not one control's options.
  // Both are still FOUND -- the card around them carries the field's name --
  // but neither may be read as the field's list of choices, so neither passes.
  const single = screen(card('Race', `<input type="checkbox" aria-label="Race: White">`));
  assert.notEqual(resolveByName(single, 'Race')?.viaOptionGroup, true, 'a single option is not a group');
  assert.equal(compareIntent(single, intent('multi_select', 'Race')).verdict, 'AMBIGUOUS');

  const mixed = screen(card('Race',
    `<input type="checkbox" aria-label="Race: White"><select aria-label="Race: Asian"></select>`));
  assert.notEqual(resolveByName(mixed, 'Race')?.viaOptionGroup, true, 'mixed roles are not one field');
  assert.equal(compareIntent(mixed, intent('multi_select', 'Race')).verdict, 'AMBIGUOUS');
});

test('ordinary single-control fields are untouched', () => {
  const num = screen(card('Height', `<input type="text" aria-label="Height" class="narrow"><span class="units">cm</span>`));
  assert.equal(compareIntent(num, intent('decimal', 'Height')).verdict, 'VERIFIED');

  const drop = screen(card('Ethnicity', `<select aria-label="Ethnicity"><option>— Select —</option></select>`));
  assert.equal(compareIntent(drop, intent('single_select', 'Ethnicity')).verdict, 'VERIFIED');
});
