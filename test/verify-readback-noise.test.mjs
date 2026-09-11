// The read-back's noise floor.
//
// Live (2026-09-07): the run finished and offered 222 items for review. Built
// against the same designer, a study built PERFECTLY -- every field, type,
// value, bound and unit exactly as the input file asks -- reported 120 of its
// 195 fields. Four families, none of them a defect in the study:
//
//   59  "declares no range bounds"          every bounded integer + decimal
//   26  "has N options but intent has N"    every dropdown, off by the prompt row
//   19  "no element with accessible name"   every yes/no field
//   16  "exposes no option vocabulary"      every radio + multi-select
//
// All four are the comparator asking the surface for evidence it never states.
// Three of them the platform DOES state, somewhere other than where we looked:
// a yes/no field's name is on its card, a unit is in the text beside the
// control, and a choice field's values are in the names of its options. Those
// became real checks. Only min/max is genuinely unobservable here, and that is
// counted once for the run instead of reported 59 times.
//
// The hazard in all of this is reporting a MISSING field as present, which is
// the one failure that must never happen. Every rule below is paired with the
// case that would produce it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { compareIntent } from '../dist/verify.mjs';

/** A card as this designer draws it: the field's name in the head, the
 *  control(s) below, and nothing tying the two together. */
const card = (label, meta, inner) => `<div class="element-card">
  <div class="element-head"><span class="element-label">${label}</span><span class="element-meta">${meta}</span></div>
  <div class="element-preview">${inner}</div></div>`;

const screen = (html) => observe(
  new JSDOM(`<!doctype html><html><body><div id="app">${html}</div></body></html>`).window.document,
);

const intent = (canonical_type, label, extra = {}) => ({
  visit_id: 'v0', form_id: 'f0', field_id: 'x', canonical_type, label, required: false, ...extra,
});

const pairs = (...labels) => labels.map((label, i) => ({ code: `C${i}`, label }));

const yesNo = '<button type="button" class="pill">Yes</button><button type="button" class="pill">No</button>';

// ---------------------------------------------------------------------------
// A field that names none of its own controls.
// ---------------------------------------------------------------------------

test('a yes/no field is found by the card that names it', () => {
  const obs = screen(card('Informed Consent Obtained *', 'Yes/No Toggle · Required', yesNo));
  assert.equal(
    obs.elements.filter((e) => e.name.includes('Informed Consent')).length, 0,
    'no control carries the field name -- that is the whole difficulty',
  );
  assert.equal(
    compareIntent(obs, intent('boolean', 'Informed Consent Obtained')).verdict, 'VERIFIED',
  );
});

test('a card that names a field of its own never answers for another', () => {
  // "Height" is NOT built; "Height Velocity" is. The card's text opens with
  // "Height", so a prefix rule alone would report the missing field as present
  // -- the one failure this agent must never produce. The card holds a control
  // with a field role, so it answers for itself.
  const obs = screen(card('Height Velocity *', 'Number (Decimal) · Required',
    '<input type="text" aria-label="Height Velocity"><span class="units">cm/yr</span>'));
  assert.equal(compareIntent(obs, intent('decimal', 'Height')).verdict, 'FAILED');
});

test('a yes/no field that was never built is still FAILED', () => {
  const obs = screen(card('Prior Therapy *', 'Yes/No Toggle · Required', yesNo));
  assert.equal(compareIntent(obs, intent('boolean', 'Informed Consent Obtained')).verdict, 'FAILED');
});

test('a neighbouring card is not swallowed on a word boundary', () => {
  // "Consent" must not resolve against the card for "Consent Obtained".
  const obs = screen(card('Consent Obtained *', 'Yes/No Toggle · Required', yesNo));
  const v = compareIntent(obs, intent('boolean', 'Consent'));
  assert.equal(v.verdict, 'FAILED', v.reason);
});

// ---------------------------------------------------------------------------
// Coded values: read where the platform states them.
// ---------------------------------------------------------------------------

test("a dropdown's prompt row is not a value", () => {
  const obs = screen(card('Ethnicity', 'Dropdown',
    `<select aria-label="Ethnicity"><option>— Select —</option>
     <option>Hispanic or Latino</option><option>Not Hispanic or Latino</option></select>`));
  const v = compareIntent(obs, intent('single_select', 'Ethnicity', {
    coded_pairs: pairs('Hispanic or Latino', 'Not Hispanic or Latino'),
  }));
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('a value the platform dropped is still caught', () => {
  const obs = screen(card('Ethnicity', 'Dropdown',
    `<select aria-label="Ethnicity"><option>— Select —</option>
     <option>Hispanic or Latino</option></select>`));
  const v = compareIntent(obs, intent('single_select', 'Ethnicity', {
    coded_pairs: pairs('Hispanic or Latino', 'Not Hispanic or Latino'),
  }));
  assert.equal(v.verdict, 'AMBIGUOUS', 'a short list is a short list, prompt row or not');
});

test('a value list that was replaced rather than appended is still caught', () => {
  const obs = screen(card('Ethnicity', 'Dropdown',
    `<select aria-label="Ethnicity"><option>— Select —</option>
     <option>Yes</option><option>No</option></select>`));
  const v = compareIntent(obs, intent('single_select', 'Ethnicity', {
    coded_pairs: pairs('Hispanic or Latino', 'Not Hispanic or Latino'),
  }));
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /option/i);
});

test("a choice field's values are read from its options' names", () => {
  const opts = (label, values) => values
    .map((v) => `<span class="choice"><input type="radio" aria-label="${label}: ${v}">${v}</span>`).join('');
  const obs = screen(card('Sex at Birth *', 'Radio Buttons · Required',
    opts('Sex at Birth', ['Female', 'Male', 'Undisclosed'])));
  const v = compareIntent(obs, intent('radio', 'Sex at Birth', {
    coded_pairs: pairs('Female', 'Male', 'Undisclosed'),
  }));
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('a wrong value on a choice field is caught, not waived', () => {
  // The previous rule read `options` off one radio input, found nothing, and
  // reported "exposes no option vocabulary" for every choice field in the
  // study -- which also meant a genuinely wrong value was never noticed.
  const opts = (label, values) => values
    .map((v) => `<span class="choice"><input type="radio" aria-label="${label}: ${v}">${v}</span>`).join('');
  const obs = screen(card('Sex at Birth *', 'Radio Buttons · Required',
    opts('Sex at Birth', ['Female', 'Male', 'Unknown'])));
  const v = compareIntent(obs, intent('radio', 'Sex at Birth', {
    coded_pairs: pairs('Female', 'Male', 'Undisclosed'),
  }));
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /Undisclosed/);
});

// ---------------------------------------------------------------------------
// Range and units: silence versus disagreement.
// ---------------------------------------------------------------------------

test('bounds the platform states nowhere are counted, not reported', () => {
  const obs = screen(card('Height *', 'Number (Decimal) · Required',
    '<input type="text" aria-label="Height" class="narrow"><span class="units">cm</span>'));
  const v = compareIntent(obs, intent('decimal', 'Height', {
    range_units: { min: 100, max: 250, units: 'cm' },
  }));
  assert.equal(v.verdict, 'VERIFIED', v.reason);
  assert.deepEqual(v.unobservable, ['range bounds'], 'the unit beside the control WAS checked');
});

test('bounds the platform states but got wrong are still reported', () => {
  const obs = screen(card('Height *', 'Number (Decimal) · Required',
    '<input type="number" aria-label="Height" min="0" max="999"><span class="units">cm</span>'));
  const v = compareIntent(obs, intent('decimal', 'Height', {
    range_units: { min: 100, max: 250, units: 'cm' },
  }));
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /100|250/);
});

test('a wrong unit beside the control is not mistaken for the right one', () => {
  const obs = screen(card('Height *', 'Number (Decimal) · Required',
    '<input type="text" aria-label="Height" class="narrow"><span class="units">in</span>'));
  const v = compareIntent(obs, intent('decimal', 'Height', {
    range_units: { min: 100, max: 250, units: 'cm' },
  }));
  assert.deepEqual(v.unobservable, ['range bounds', 'units (cm)']);
});
