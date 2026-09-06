// skipSpan advances past an unreachable visit/form instead of building its
// steps into whatever is still on screen. It assumes each visit's and each
// form's items are CONTIGUOUS in the linear plan — if linearize ever
// interleaves them, the skip would silently drop the wrong steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIRJson } from '../dist/plan-ir.mjs';
import { compilePlan, linearize } from '../dist/plan-compiler.mjs';

const items = linearize(compilePlan(parseIRJson(
  readFileSync(new URL('./fixtures/abc-101-study.ir.json', import.meta.url), 'utf8'),
)));

const contiguous = (key) => {
  const seen = new Set();
  let prev;
  for (const it of items) {
    if (it[key] === prev) continue;
    assert.ok(!seen.has(it[key]), `${key} ${it[key]} is not contiguous in the plan`);
    seen.add(it[key]);
    prev = it[key];
  }
  return seen.size;
};

test('each visit and form occupies one contiguous span', () => {
  assert.equal(contiguous('visit_id'), 4);
  assert.equal(contiguous('form_id'), 28);
});

test('skipping a failed visit lands on the next visit', () => {
  // Mirrors skipSpan: advance while the NEXT item is still in the span.
  const skip = (from, inSpan) => {
    let i = from;
    while (i + 1 < items.length && inSpan(items[i + 1])) i += 1;
    return i;
  };
  const first = items[0].visit_id;
  const last = skip(0, (it) => it.visit_id === first);
  assert.ok(items.slice(0, last + 1).every((it) => it.visit_id === first));
  assert.notEqual(items[last + 1].visit_id, first);
});
