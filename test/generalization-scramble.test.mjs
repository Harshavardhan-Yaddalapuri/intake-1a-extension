// test/generalization-scramble.test.mjs
//
// The Finding A harness. Every accessible name is replaced with nonsense.
// A binder that still produces candidates is not relying on English words.
// A binder that returns null has an English-word gate.
//
// Expected to FAIL until Phase 3 (Tasks 7-12) is complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindCtxCommit,
  bindVisitCreate,
  bindFormCreate,
  bindFieldPaletteOpen,
  bindCtxDiscard,
  bindFormListFields,
  readObservedFields,
} from '../dist/bind-rung0.mjs';
import { scrambleObservation } from './scramble.mjs';
import { elem, obs, resetSeq } from './fixtures/obs.mjs';

/** A plausible form-designer screen. Names are realistic so that the
 *  UNSCRAMBLED case passes and only the SCRAMBLED case is discriminating. */
function designerScreen() {
  resetSeq();
  return obs([
    elem('link', 'Study Plan'),
    elem('button', 'Add Visit'),
    elem('button', 'New Source Document'),
    elem('button', 'Element Library'),
    elem('button', 'Text Field'),
    elem('button', 'Dropdown'),
    elem('button', 'Save'),
    elem('button', 'Save As Template'),
    elem('button', 'Cancel'),
    elem('textbox', 'Field Label'),
  ]);
}

const BINDERS = [
  ['ctx.commit', bindCtxCommit],
  ['visit.create', bindVisitCreate],
  ['form.create', bindFormCreate],
  ['field_palette.open', bindFieldPaletteOpen],
  ['ctx.discard', bindCtxDiscard],
];

for (const [opName, binder] of BINDERS) {
  test(`${opName} binds on an unscrambled screen`, () => {
    const result = binder(designerScreen());
    assert.ok(result, `${opName} produced no binding on plain English names`);
  });

  // Several seeds: one lucky seed proving nothing is the failure mode here.
  for (const seed of [1, 17, 404, 9001]) {
    test(`${opName} still binds when all vocabulary is scrambled (seed ${seed})`, () => {
      const scrambled = scrambleObservation(designerScreen(), seed);
      const result = binder(scrambled);
      assert.ok(
        result,
        `${opName} produced no binding once names were scrambled — ` +
        `an English word is gating candidate enumeration`,
      );
    });
  }
}

test('scrambling changes which candidate ranks first, but never empties the pool', () => {
  const plain = bindCtxCommit(designerScreen());
  const scrambled = bindCtxCommit(scrambleObservation(designerScreen(), 77));
  assert.ok(plain, 'no binding on plain names');
  assert.ok(scrambled, 'no binding on scrambled names');
  // Both must name *some* candidate. Which one differs, and that is fine —
  // the probe adjudicates.
  assert.ok(plain.recipe[0].evidence_name);
  assert.ok(scrambled.recipe[0].evidence_name);
});

// ---------------------------------------------------------------------------
// form.list_fields (Task 14): field enumeration must be role-based.
// ---------------------------------------------------------------------------

test('form.list_fields binds on a designer canvas', () => {
  resetSeq();
  const o = obs([
    elem('button', 'Save'),
    elem('textbox', 'Subject Initials', { state: { required: true } }),
    elem('spinbutton', 'Age', { state: { range: { min: 18, max: 99 } } }),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  assert.ok(bindFormListFields(o));
});

test('readObservedFields returns only value-bearing controls', () => {
  resetSeq();
  const o = obs([
    elem('button', 'Save'),
    elem('heading', 'Vital Signs'),
    elem('textbox', 'Subject Initials'),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  const labels = readObservedFields(o).map((f) => f.label).sort();
  assert.deepEqual(labels, ['Sex', 'Subject Initials']);
});

test('readObservedFields carries required, range and options through', () => {
  resetSeq();
  const o = obs([
    elem('spinbutton', 'Heart Rate', { state: { required: true, range: { min: 30, max: 200 } } }),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  const byLabel = Object.fromEntries(readObservedFields(o).map((f) => [f.label, f]));
  assert.equal(byLabel['Heart Rate'].required, true);
  assert.deepEqual(byLabel['Heart Rate'].range, { min: 30, max: 200 });
  assert.deepEqual(byLabel['Sex'].options, ['Male', 'Female']);
});

test('readObservedFields reports an UNNAMED control rather than hiding it', () => {
  resetSeq();
  const o = obs([elem('textbox', ''), elem('textbox', 'Named Field')]);
  const fields = readObservedFields(o);
  assert.equal(fields.length, 2, 'a control added but never labelled must still be reported');
  const binding = bindFormListFields(o);
  assert.ok(
    binding.evidence.some((e) => /unnamed/i.test(e)),
    'the binding must call out unnamed controls: present but semantically worthless',
  );
});

test('readObservedFields works when every name is nonsense', () => {
  resetSeq();
  const plain = obs([
    elem('textbox', 'Subject Initials'),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  assert.equal(
    readObservedFields(scrambleObservation(plain, 31)).length,
    2,
    'field enumeration must be role-based and unaffected by vocabulary',
  );
});
