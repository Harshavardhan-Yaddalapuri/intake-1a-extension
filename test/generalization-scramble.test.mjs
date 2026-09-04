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
