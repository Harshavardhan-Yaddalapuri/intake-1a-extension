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
  // The orchestrator does the actual driving -- navigating visits, creating
  // forms, confirming saves. A lexical gate here fails the run on an unseen
  // platform regardless of how well the binding layer generalises, so it is
  // guarded on the same terms.
  'src/engine/orchestrator.ts',
];

/** Strip comments so commentary about the defect is not mistaken for it. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Find UI words used in a COMPARISON against some string.
 *
 * The defect is not "an English word appears in this file" — operation ids
 * ('visit.create'), hint keys ('commit') and post-condition prose ("the visit
 * list is reached") all legitimately contain these words, and always will.
 * The defect is testing an element's NAME against a word to decide whether
 * that element is eligible. That has a narrow syntactic signature:
 *
 *     name.includes('save')      x === 'save'      n.startsWith('save')
 *
 * so that is what this scans for. A word passed as data — `{ hint: 'commit' }`,
 * `makeBinding('ctx.commit', ...)` — is not a gate and is not flagged.
 *
 * Comparisons against our OWN vocabulary are likewise not gates. `item.kind`
 * is a PlanStepKind and `step.op` a ContractOperation: both are closed unions
 * declared in this repo, checked by tsc, and identical on every platform. A
 * word only becomes a gate when it is tested against a name the PLATFORM
 * chose, so `.kind` / `.op` operands are exempt while every other operand —
 * `e.name`, `n`, `label` — is not.
 */
function gatingComparisons(source) {
  const code = stripComments(source);
  const offenders = [];
  const pattern =
    /(\.kind|\.op)?\s*(?:\.includes|\.startsWith|\.endsWith|===|!==|==|!=)\s*\(?\s*'([^'\n]*)'/g;
  let m;
  while ((m = pattern.exec(code)) !== null) {
    if (m[1]) continue; // our own closed vocabulary, not the platform's
    const literal = m[2].toLowerCase();
    for (const word of UI_WORDS) {
      if (literal.includes(word)) {
        offenders.push(`compares against "${literal}" (contains "${word}")`);
        break;
      }
    }
  }
  return offenders;
}

for (const file of GUARDED) {
  test(`${file} never compares an element name against an English UI word`, () => {
    const offenders = gatingComparisons(readFileSync(file, 'utf8'));
    assert.deepEqual(
      offenders,
      [],
      `${file} decides candidate eligibility by reading names. Lexical hints ` +
      `belong in src/bind/ranking.ts as ranking data, never as filters:\n  ` +
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
