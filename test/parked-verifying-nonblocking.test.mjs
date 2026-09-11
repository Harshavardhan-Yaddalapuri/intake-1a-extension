/**
 * Hostile v7 parked the schedule on "Built — needs a look" for Sex at Birth
 * after Demographics was otherwise clean; later visits never built (~75% of
 * score). Verifying findings must never be treated as blocking gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationIsBlocking } from '../dist/orchestrator.mjs';

test('verifying phase is never blocking, even when the caller passes true', () => {
  assert.equal(escalationIsBlocking('verifying', true), false);
  assert.equal(escalationIsBlocking('verifying', false), false);
});

test('binding and acting preserve the caller blocking flag', () => {
  assert.equal(escalationIsBlocking('binding', true), true);
  assert.equal(escalationIsBlocking('binding', false), false);
  assert.equal(escalationIsBlocking('acting', true), true);
  assert.equal(escalationIsBlocking('acting', false), false);
});
