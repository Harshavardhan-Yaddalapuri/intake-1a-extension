// test/scramble.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeScrambler, scrambleObservation } from './scramble.mjs';
import { elem, obs, resetSeq } from './fixtures/obs.mjs';

test('scrambler is deterministic for a given seed', () => {
  const a = makeScrambler(42);
  const b = makeScrambler(42);
  assert.equal(a('Save'), b('Save'));
  assert.equal(a('Add Visit'), b('Add Visit'));
});

test('scrambler differs across seeds', () => {
  const a = makeScrambler(1);
  const b = makeScrambler(2);
  assert.notEqual(a('Save'), b('Save'));
});

test('scrambler is memoised: same input maps to same output', () => {
  const s = makeScrambler(7);
  assert.equal(s('Save'), s('Save'));
});

test('scrambler produces no English UI words', () => {
  const s = makeScrambler(99);
  const banned = ['save', 'commit', 'add', 'new', 'visit', 'form', 'cancel'];
  for (const input of ['Save', 'Add Visit', 'New Form', 'Cancel', 'Commit']) {
    const out = s(input).toLowerCase();
    for (const word of banned) {
      assert.ok(!out.includes(word), `scrambled "${input}" -> "${out}" still contains "${word}"`);
    }
  }
});

test('scrambler preserves empty names', () => {
  const s = makeScrambler(3);
  assert.equal(s(''), '');
});

test('scrambleObservation renames every element name and option', () => {
  resetSeq();
  const original = obs([
    elem('button', 'Save'),
    elem('button', 'Add Visit'),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  const scrambled = scrambleObservation(original, 5);

  assert.equal(scrambled.elements.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.notEqual(scrambled.elements[i].name, original.elements[i].name);
    // Structure is preserved: role, handle, index untouched.
    assert.equal(scrambled.elements[i].role, original.elements[i].role);
    assert.equal(scrambled.elements[i].handle, original.elements[i].handle);
  }
  assert.equal(scrambled.elements[2].options.length, 2);
  assert.notEqual(scrambled.elements[2].options[0], 'Male');
});

test('scrambleObservation does not mutate the input', () => {
  resetSeq();
  const original = obs([elem('button', 'Save')]);
  scrambleObservation(original, 5);
  assert.equal(original.elements[0].name, 'Save');
});
