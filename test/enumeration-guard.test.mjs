// test/enumeration-guard.test.mjs
//
// Structural guard for the Finding A principle: English UI words may live in
// exactly one place, src/bind/ranking.ts, where they are data used for
// ranking. Anywhere else in binding code they are almost certainly acting as
// a gate.
//
// Expected to FAIL until Phase 3 (Tasks 7-12) is complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Words that describe platform UI affordances in English. Their presence in
 *  binding logic means the binder is reading names to decide eligibility. */
const UI_WORDS = [
  'save', 'commit', 'persist', 'activate', 'freeze', 'bank', 'publish',
  'cancel', 'discard', 'close', 'back', 'home', 'delete', 'preview',
  'visit', 'schedule', 'phase', 'form', 'document', 'source', 'sheet',
  'element', 'library', 'palette', 'control', 'widget',
  'minimum', 'maximum', 'range', 'decimal places', 'formula',
  'add value', 'paste values', 'builder', 'draft', 'unsaved',
];

/** Files that must contain no UI-word string literals. */
const GUARDED = [
  'src/bind/rung0.ts',
  'src/bind/rung1.ts',
  'src/engine/probe-runner.ts',
];

/** Extract single- and double-quoted string literals, ignoring comments. */
function stringLiterals(source) {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutLineComments = withoutBlockComments.replace(/\/\/[^\n]*/g, '');
  const matches = withoutLineComments.match(/'[^'\n]*'|"[^"\n]*"/g) ?? [];
  return matches.map((m) => m.slice(1, -1).toLowerCase());
}

for (const file of GUARDED) {
  test(`${file} contains no English UI-word literals`, () => {
    const literals = stringLiterals(readFileSync(file, 'utf8'));
    const offenders = [];
    for (const literal of literals) {
      for (const word of UI_WORDS) {
        if (literal.includes(word)) offenders.push(`"${literal}" contains "${word}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${file} uses English UI words in string literals. Lexical hints belong ` +
      `in src/bind/ranking.ts as ranking data, never as candidate filters:\n  ` +
      offenders.join('\n  '),
    );
  });
}

test('src/bind/ranking.ts is the declared home for lexical hints', () => {
  const source = readFileSync('src/bind/ranking.ts', 'utf8');
  assert.ok(
    source.includes('LEXICAL_HINTS'),
    'ranking.ts must export LEXICAL_HINTS as the single lexical-hint table',
  );
});
