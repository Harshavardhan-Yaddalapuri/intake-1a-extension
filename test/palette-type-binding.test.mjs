// Regression tests for the canonical-type collapse.
//
// Observed live against the supplied mock (2026-09-05): three canonical types
// bound to the wrong palette control, and the correct control sat unused in
// the same palette.
//
//   text     -> "Multi-line Textbox"   ("Single Line Textbox" present)
//   integer  -> "Number (Decimal)"     ("Number (Whole)" present)
//   time     -> "Date/Time"            ("Time" present)
//
// Two causes:
//
//  1. bindFieldAdd collected loose name matches and took candidates[0] -- the
//     first in DOM order -- with no scoring. The palette is alphabetical, so
//     the substring decoy sorts ahead of the specific control in all three
//     cases. rankCandidates was never consulted.
//
//  2. makeBinding discarded the confidence grade through a ternary whose two
//     branches were identical, so a name-only guess was reported exactly like
//     a probe-confirmed match. The orchestrator's ladder escalated only when a
//     binding was ABSENT, never when it was uncertain, which left the rung 1
//     place-and-inspect probe unreachable for any type rung 0 guessed at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { bindFieldAdd } from '../dist/bind-rung0.mjs';

/** The supplied mock's element palette, in its real alphabetical DOM order. */
const PALETTE = [
  'Calculated Field', 'Check List', 'Checkbox', 'Date', 'Date/Time', 'Dropdown',
  'Multi-line Textbox', 'Number (Decimal)', 'Number (Whole)', 'Radio Buttons',
  'Single Line Textbox', 'Time', 'Yes/No Toggle',
];

function builderScreen(entries = PALETTE) {
  return new JSDOM(`<!doctype html><html><body>
    <nav><button>Patients</button><button>Study Plan</button></nav>
    <header><button>← Screening</button><button>Save</button><button>Activate</button></header>
    <aside>
      <input type="text" placeholder="Filter elements…">
      ${entries.map((n) => `<button>${n}</button>`).join('')}
      <button>Import From Library…</button>
    </aside>
    <main><button>+ Page</button></main>
  </body></html>`).window.document;
}

/** What each canonical type must resolve to on this palette. */
const EXPECTED = {
  text: 'Single Line Textbox',
  textarea: 'Multi-line Textbox',
  integer: 'Number (Whole)',
  decimal: 'Number (Decimal)',
  date: 'Date',
  time: 'Time',
  datetime: 'Date/Time',
  boolean: 'Yes/No Toggle',
  single_select: 'Dropdown',
  multi_select: 'Check List',
  radio: 'Radio Buttons',
  checkbox: 'Checkbox',
  calculated: 'Calculated Field',
};

const pick = (obs, type) => bindFieldAdd(obs, type)?.recipe?.[0]?.evidence_name ?? null;

test('every canonical type binds to its own palette control', () => {
  const obs = observe(builderScreen());
  const actual = {};
  for (const type of Object.keys(EXPECTED)) actual[type] = pick(obs, type);
  assert.deepEqual(actual, EXPECTED);
});

test('no two canonical types collapse onto the same control', () => {
  const obs = observe(builderScreen());
  const picked = Object.keys(EXPECTED).map((t) => pick(obs, t));
  assert.equal(new Set(picked).size, picked.length, `collapsed: ${JSON.stringify(picked)}`);
});

test('a more specific control beats a substring decoy regardless of DOM order', () => {
  // The real failure was order-dependent. Reversing the palette must not
  // change the answer: if it does, position is still deciding, not evidence.
  const forward = observe(builderScreen(PALETTE));
  const reversed = observe(builderScreen([...PALETTE].reverse()));
  for (const type of Object.keys(EXPECTED)) {
    assert.equal(pick(forward, type), pick(reversed, type), `${type} is order-dependent`);
  }
});

test('a name-only match is reported as a hypothesis, not a conclusion', () => {
  // The grade must survive into the record. While it was discarded, the
  // orchestrator could not tell a guess from a probe-confirmed match and so
  // never escalated to rung 1.
  const obs = observe(builderScreen());
  const binding = bindFieldAdd(obs, 'text');
  assert.ok(binding, 'text should bind');
  assert.equal(binding.confidence, 'hypothesis');
  assert.equal(binding.status, 'bound');
});

test('an unresolvable type binds to nothing rather than to the nearest word', () => {
  // A palette with no numeric control must not hand `integer` a text box.
  const obs = observe(builderScreen(['Single Line Textbox', 'Date', 'Checkbox']));
  assert.equal(pick(obs, 'integer'), null);
  assert.equal(pick(obs, 'calculated'), null);
});

test('a tie between equally plausible controls is graded tentative', () => {
  // Two controls that score identically for `radio`. Nothing in the names
  // separates them, so the binding must say so and let the probe decide.
  const obs = observe(builderScreen(['Radio A', 'Radio B']));
  const binding = bindFieldAdd(obs, 'radio');
  assert.ok(binding, 'should still produce a candidate to probe');
  assert.equal(binding.confidence, 'tentative');
});
