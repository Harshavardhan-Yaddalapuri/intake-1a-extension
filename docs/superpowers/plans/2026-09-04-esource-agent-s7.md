# eSource Build Agent S7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five open gaps in the S1–S6 eSource build agent, after first removing the English-word candidate gates and the two missing read-backs that undermine them.

**Architecture:** The existing module walls hold — PERCEIVE cannot write, BIND cannot click, ACT cannot decide, VERIFY cannot fix. Binding changes from "filter candidates by name" to "enumerate structurally, rank by weak signals, probe in rank order." A new reconcile layer reads live platform state and derives the work list from the diff, which delivers idempotency and empirical form reuse from one mechanism. A new append-only journal records provenance for every act.

**Tech Stack:** TypeScript, esbuild → `dist/`, `node --test` with jsdom, Chrome MV3 extension (service worker + content script + side panel).

**Spec:** `docs/superpowers/specs/2026-09-04-esource-agent-s7-design.md`

---

## Before You Start

Read the spec. Sections 2 and 3 explain *why* the first twelve tasks rewrite working code instead of adding to it. Without that context the changes look like churn.

Two invariants govern this whole plan:

1. **Lexical priors may rank candidates, never exclude them.** English words live in exactly one table, in `src/bind/ranking.ts`. Task 3 adds a test that fails if they appear anywhere else in binding code.
2. **Nothing is verified until it is read back.** If a step sets something, a later step reads it from a fresh observation and compares.

**Conventions in this repo:**
- Tests are `test/*.test.mjs`, run via `npm test` (`node --test test/*.test.mjs`).
- Tests import from `../dist/*.mjs`, **not** from `src/`. You must run `npm run build` before `npm test`, every time.
- Any new `src/` module that a test imports must be added to the `nodeModules` array in `build.mjs`.
- DOM-level tests use `jsdom` (see `test/perceive.test.mjs` for the `doc()` / `el()` helper pattern).
- `npm run typecheck` must stay at zero errors.

**Baseline check before Task 1:**

```bash
cd /Users/harshavardhan/Projects/intake-1a-extension
npm run build && npm run typecheck && npm test
```

Expected: build succeeds, zero type errors, 100 tests pass. If not, stop and fix that first.

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `test/fixtures/obs.mjs` | Test helper. Builds synthetic `Observation` objects without a DOM. |
| `test/scramble.mjs` | Test helper. Seeded, memoised vocabulary scrambler for `Observation` names. |
| `test/scramble.test.mjs` | Tests the scrambler itself is deterministic and structure-preserving. |
| `test/generalization-scramble.test.mjs` | **The Finding A harness.** Runs binding against scrambled observations. |
| `test/enumeration-guard.test.mjs` | Static scan. Fails if English words appear outside `ranking.ts`. |
| `src/bind/ranking.ts` | Structural enumeration + weak-signal ranking. The only home for lexical hints. |
| `test/ranking.test.mjs` | Tests ranking never drops a candidate. |
| `src/bind/rung2.ts` | LLM candidate ranking. Optional key, probe-adjudicated. |
| `test/rung2.test.mjs` | Tests request construction, response parsing, every degradation path. |
| `src/engine/reconcile.ts` | Shallow tree survey + deep per-form reconciliation. |
| `test/reconcile.test.mjs` | Tests the four-way decision table. |
| `src/engine/journal.ts` | Append-only provenance records, JSONL + HTML export. |
| `test/journal.test.mjs` | Tests record emission and export shape. |
| `test/idempotency.test.mjs` | Double-run: second run creates nothing. |
| `generalization/runtime-scramble.js` | Injectable page script that renames visible text at runtime, for the manual scored sweep. |

**Modified files:**

| Path | Change |
|---|---|
| `src/perceive/core.ts` | `ElementState` gains `required` and `range`; `computeState` reads them. |
| `src/verify/verify.ts` | Normalised `findByName`; real `required` and `range` comparisons. |
| `src/shared/contract.ts` | `form.list_fields` op, `ObservedField`, `FormListFieldsArgs`. |
| `src/bind/rung0.ts` | Lexical demotion at every candidate-selection site. |
| `src/bind/rung1.ts` | Lexical demotion at sub-control discovery sites. |
| `src/engine/probe-runner.ts` | Delete both name filters; probe in rank order. |
| `src/engine/orchestrator.ts` | Reconcile integration, journal emission, blocking/non-blocking escalation. |
| `src/shared/messages.ts` | New message types for reconcile summary, journal export, API key. |
| `src/sidepanel/app.ts` | Pre-flight reconcile summary, key entry, journal export, per-type cards. |
| `sidepanel.html` | Markup for the above. |
| `build.mjs` | Add `ranking`, `rung2`, `reconcile`, `journal` to `nodeModules`. |
| `manifest.json` | Host permission for `https://api.anthropic.com/*`. |

**Phase seam:** Tasks 1–12 make the agent generalize. Tasks 13–22 close the feature gaps. If work is interrupted, stopping after Task 12 leaves the repo in a coherent, better state than it started.

---

# Phase 1 — The harness that defines "done" for Finding A

### Task 1: Observation test fixture helper

Tests in later tasks need synthetic `Observation` objects. Building them through jsdom every time is slow and obscures intent.

**Files:**
- Create: `test/fixtures/obs.mjs`

- [ ] **Step 1: Write the helper**

```javascript
// test/fixtures/obs.mjs
// Builds synthetic Observation objects for tests that exercise BIND and
// VERIFY without needing a DOM. Mirrors the shape emitted by
// src/perceive/core.ts observe().

let seq = 0;

/** One ObservationElement. Only `role` and `name` are usually interesting;
 *  everything else gets a sane default. */
export function elem(role, name, extra = {}) {
  seq += 1;
  return {
    index: extra.index ?? seq,
    handle: extra.handle ?? `0/1/${seq}`,
    role,
    name,
    nameSource: extra.nameSource ?? 'content',
    labelUncertain: extra.labelUncertain ?? false,
    state: extra.state ?? {},
    options: extra.options ?? [],
    tagName: extra.tagName ?? 'button',
    inputType: extra.inputType,
  };
}

/** A whole Observation wrapping the given elements. */
export function obs(elements, extra = {}) {
  return {
    snapshotId: extra.snapshotId ?? 'test-snapshot',
    url: extra.url ?? 'http://localhost:4091/',
    title: extra.title ?? 'Test Platform',
    timestamp: extra.timestamp ?? 1_700_000_000_000,
    elements,
  };
}

/** Reset the handle counter so tests are independent. */
export function resetSeq() {
  seq = 0;
}
```

- [ ] **Step 2: Verify it loads**

Run: `node -e "import('./test/fixtures/obs.mjs').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'elem', 'obs', 'resetSeq' ]`

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/obs.mjs
git commit -m "test: add synthetic Observation fixture helper"
```

---

### Task 2: The vocabulary scrambler

This is the instrument that measures Finding A. It renames every accessible name in an `Observation` to generated nonsense, deterministically from a seed, memoised so the same input name always maps to the same output (two buttons sharing a name still share it after scrambling).

**Files:**
- Create: `test/scramble.mjs`
- Create: `test/scramble.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/scramble.test.mjs`
Expected: FAIL — `Cannot find module './scramble.mjs'`

- [ ] **Step 3: Write the scrambler**

```javascript
// test/scramble.mjs
// Seeded, memoised vocabulary scrambler.
//
// The point: if BIND still finds its candidates after every accessible name
// on the page has been replaced with nonsense, then English words are not
// load-bearing. Because the nonsense differs per seed, this cannot be tuned
// to the way a hand-written fixture can.

const SYLLABLES = [
  'ka', 'zo', 'mir', 'tuv', 'lex', 'pon', 'dra', 'feq',
  'wub', 'nyx', 'gel', 'sot', 'ryn', 'quo', 'vash', 'ild',
];

/** Returns a memoised scramble function. Same seed => same mapping. */
export function makeScrambler(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    // Numerical Recipes LCG. Deterministic, adequate for naming.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const memo = new Map();
  return function scramble(name) {
    if (!name) return name;
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const count = 2 + Math.floor(next() * 2);
    let out = '';
    for (let i = 0; i < count; i += 1) {
      out += SYLLABLES[Math.floor(next() * SYLLABLES.length)];
    }
    const word = out.charAt(0).toUpperCase() + out.slice(1);
    memo.set(name, word);
    return word;
  };
}

/** Returns a copy of `observation` with every name and option scrambled.
 *  Roles, handles, indices, and state are untouched — only vocabulary moves. */
export function scrambleObservation(observation, seed) {
  const scramble = makeScrambler(seed);
  return {
    ...observation,
    title: scramble(observation.title),
    elements: observation.elements.map((e) => ({
      ...e,
      name: scramble(e.name),
      options: e.options.map(scramble),
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/scramble.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add test/scramble.mjs test/scramble.test.mjs
git commit -m "test: add seeded vocabulary scrambler for generalization testing"
```

---

### Task 3: The scramble harness and the enumeration guard — both expected to fail

These two tests define "done" for Phase 3. They are written now and are **expected to fail** against the current code. Do not fix them in this task. Their failure is the measurement.

**Files:**
- Create: `test/generalization-scramble.test.mjs`
- Create: `test/enumeration-guard.test.mjs`

- [ ] **Step 1: Write the scramble harness test**

```javascript
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
```

- [ ] **Step 2: Write the enumeration guard test**

```javascript
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
```

- [ ] **Step 3: Run both and record the failure**

Run: `npm run build && node --test test/generalization-scramble.test.mjs test/enumeration-guard.test.mjs`

Expected: **FAIL.** The scramble tests fail because `bindCtxCommit` and friends filter on `name.includes('save')` and return `null` once names are nonsense. The guard tests fail because those literals are present. `enumeration-guard` will additionally fail to read `src/bind/ranking.ts` (it does not exist yet).

Record the exact failure count in the commit message — it is the before-measurement.

- [ ] **Step 4: Commit the failing tests**

```bash
git add test/generalization-scramble.test.mjs test/enumeration-guard.test.mjs
git commit -m "test: add scramble harness and enumeration guard (expected failing)

Both tests define done for the Finding A restructuring in Phase 3. They fail
against current code because bind/rung0.ts, bind/rung1.ts and probe-runner.ts
gate candidate enumeration on English substrings.

See docs/superpowers/specs/2026-09-04-esource-agent-s7-design.md section 2."
```

- [ ] **Step 5: Confirm the rest of the suite is unaffected**

Run: `npm test`
Expected: the 100 pre-existing tests still pass; the new scramble and guard tests fail. Total failures should be confined to the two new files.

---

# Phase 2 — The two missing read-backs

Independent of Phase 1 and Phase 3. Small, directly scored, and it unblocks two of the ten scoring criteria.

### Task 4: PERCEIVE reads `required`

**Files:**
- Modify: `src/perceive/core.ts:34-39` (`ElementState`), `src/perceive/core.ts:291-302` (`computeState`)
- Test: `test/perceive.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/perceive.test.mjs`:

```javascript
// ---------------------------------------------------------------------------
// Required state (scoring criterion 7).
// ---------------------------------------------------------------------------

test('state: aria-required="true" sets required', () => {
  const d = doc(`<input id="x" aria-required="true" />`);
  assert.equal(computeState(el(d, '#x')).required, true);
});

test('state: aria-required="false" sets required false', () => {
  const d = doc(`<input id="x" aria-required="false" />`);
  assert.equal(computeState(el(d, '#x')).required, false);
});

test('state: native required attribute sets required', () => {
  const d = doc(`<input id="x" required />`);
  assert.equal(computeState(el(d, '#x')).required, true);
});

test('state: aria-required wins over native attribute', () => {
  const d = doc(`<input id="x" required aria-required="false" />`);
  assert.equal(computeState(el(d, '#x')).required, false);
});

test('state: required is absent when neither signal is present', () => {
  const d = doc(`<input id="x" />`);
  assert.equal(computeState(el(d, '#x')).required, undefined);
});

test('state: required works on non-input roles', () => {
  const d = doc(`<div id="x" role="combobox" aria-required="true"></div>`);
  assert.equal(computeState(el(d, '#x')).required, true);
});
```

Add `computeState` to the import list at the top of the file:

```javascript
import {
  computeAccname,
  computeRole,
  computeOptions,
  computeState,
  observe,
  diffObservations,
  structuralPath,
} from '../dist/perceive-core.mjs';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && node --test test/perceive.test.mjs`
Expected: FAIL — the six new tests report `undefined` where `true` or `false` is expected.

- [ ] **Step 3: Extend `ElementState`**

In `src/perceive/core.ts`, replace the `ElementState` interface:

```typescript
export interface ElementState {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  value?: string;
  /** aria-required, falling back to the native `required` attribute.
   *  Scoring criterion 7 read-back. Absent when the platform expresses
   *  neither, which is not the same as false. */
  required?: boolean;
  /** aria-valuemin/aria-valuemax, falling back to native min/max/step.
   *  Scoring criterion 9 read-back. */
  range?: { min?: number; max?: number; step?: number };
}
```

- [ ] **Step 4: Add the reader and wire it into `computeState`**

In `src/perceive/core.ts`, immediately above `computeState`, add:

```typescript
/** Required state. ARIA wins over the native attribute, per ARIA in HTML:
 *  an explicit aria-required="false" is an author override of `required`. */
function isRequired(el: Element): boolean | undefined {
  const aria = el.getAttribute('aria-required');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (el.hasAttribute('required')) return true;
  return undefined;
}
```

Then in `computeState`, after the `expanded` block and before the `value` block:

```typescript
  const required = isRequired(el);
  if (required !== undefined) state.required = required;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test test/perceive.test.mjs`
Expected: PASS, including the six new tests.

- [ ] **Step 6: Commit**

```bash
git add src/perceive/core.ts test/perceive.test.mjs
git commit -m "feat(perceive): read required state into ElementState

Scoring criterion 7 previously had no read-back at all: verify.ts deferred to
a dedicated required read-back that was never written."
```

---

### Task 5: PERCEIVE reads range

**Files:**
- Modify: `src/perceive/core.ts` (`computeState` and a new `readRange` helper)
- Test: `test/perceive.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/perceive.test.mjs`:

```javascript
// ---------------------------------------------------------------------------
// Range state (scoring criterion 9).
// ---------------------------------------------------------------------------

test('state: native min/max on a number input', () => {
  const d = doc(`<input id="x" type="number" min="30" max="200" />`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 30, max: 200 });
});

test('state: native step is captured', () => {
  const d = doc(`<input id="x" type="number" min="0" max="10" step="0.1" />`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 0, max: 10, step: 0.1 });
});

test('state: aria-valuemin/aria-valuemax on a custom control', () => {
  const d = doc(`<div id="x" role="spinbutton" aria-valuemin="1" aria-valuemax="5"></div>`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 1, max: 5 });
});

test('state: aria wins over native for range', () => {
  const d = doc(`<input id="x" type="number" min="1" max="2" aria-valuemin="10" aria-valuemax="20" />`);
  const r = computeState(el(d, '#x')).range;
  assert.deepEqual(r, { min: 10, max: 20 });
});

test('state: a partial range records only what is present', () => {
  const d = doc(`<input id="x" type="number" min="5" />`);
  assert.deepEqual(computeState(el(d, '#x')).range, { min: 5 });
});

test('state: range is absent when no bound is declared', () => {
  const d = doc(`<input id="x" type="number" />`);
  assert.equal(computeState(el(d, '#x')).range, undefined);
});

test('state: non-numeric min/max values are ignored', () => {
  const d = doc(`<input id="x" type="number" min="abc" max="200" />`);
  assert.deepEqual(computeState(el(d, '#x')).range, { max: 200 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && node --test test/perceive.test.mjs`
Expected: FAIL — seven new tests report `undefined` for `range`.

- [ ] **Step 3: Add the range reader**

In `src/perceive/core.ts`, below `isRequired`, add:

```typescript
/** Parse an attribute as a finite number, or undefined. A platform that
 *  writes a non-numeric bound has not declared a usable range. */
function numAttr(el: Element, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = el.getAttribute(name);
    if (raw === null || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    // A present-but-unparseable value on the preferred attribute should not
    // fall through to a less-preferred one: the author declared it here.
    return undefined;
  }
  return undefined;
}

/** Range bounds. ARIA value attributes take precedence over native ones. */
function readRange(el: Element): ElementState['range'] {
  const min = numAttr(el, 'aria-valuemin', 'min');
  const max = numAttr(el, 'aria-valuemax', 'max');
  const step = numAttr(el, 'step');
  if (min === undefined && max === undefined && step === undefined) return undefined;
  const range: NonNullable<ElementState['range']> = {};
  if (min !== undefined) range.min = min;
  if (max !== undefined) range.max = max;
  if (step !== undefined) range.step = step;
  return range;
}
```

Then in `computeState`, after the `required` block:

```typescript
  const range = readRange(el);
  if (range !== undefined) state.range = range;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/perceive.test.mjs`
Expected: PASS.

Note the `min="abc" max="200"` case: `numAttr(el, 'aria-valuemin', 'min')` returns `undefined` because `min` is present but unparseable, so only `max` is recorded. That is the intended behaviour.

- [ ] **Step 5: Full suite check**

Run: `npm run typecheck && npm test`
Expected: zero type errors; the scramble and guard tests still fail (Phase 3 work); everything else passes.

- [ ] **Step 6: Commit**

```bash
git add src/perceive/core.ts test/perceive.test.mjs
git commit -m "feat(perceive): read range bounds into ElementState

Scoring criterion 9 previously had no read-back. VERIFY assumed a range had
survived whenever the control role still looked numeric, which is exactly the
type-change-discards-range trap the brief describes."
```

---

### Task 6: VERIFY compares required and range, and normalises labels

Three changes to `src/verify/verify.ts`, all in one task because they touch the same comparator and share test setup.

**Files:**
- Modify: `src/verify/verify.ts` (`findByName`, `compareIntent`, `checkFirst`)
- Test: `test/verify.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/verify.test.mjs`.

`test/verify.test.mjs` already defines a local `obs(elements)` helper with a different signature, so the fixture import must be aliased or it will shadow it and break the existing tests:

```javascript
import { elem, obs as mkObs, resetSeq } from './fixtures/obs.mjs';
```

The new tests below use `mkObs`. Leave the existing local `obs` helper and the tests that use it alone.

```javascript
// ---------------------------------------------------------------------------
// Label normalisation.
// ---------------------------------------------------------------------------

const baseIntent = {
  visit_id: 'v0',
  form_id: 'v0.f0',
  field_id: 'v0.f0.d0',
  canonical_type: 'text',
  label: 'Subject Initials',
  required: false,
};

test('findByName tolerates a trailing required marker', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Subject Initials *')]);
  const v = compareIntent(o, baseIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('findByName tolerates a "(required)" suffix', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Subject Initials (required)')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

test('findByName tolerates collapsed and padded whitespace', () => {
  resetSeq();
  const o = mkObs([elem('textbox', '  Subject   Initials  ')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

test('findByName tolerates case differences', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'SUBJECT INITIALS')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

test('findByName still reports a genuinely absent field as FAILED', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Something Else Entirely')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'FAILED');
});

test('an ambiguous normalised match escalates rather than guessing', () => {
  resetSeq();
  const o = mkObs([
    elem('textbox', 'Subject Initials *'),
    elem('textbox', 'subject initials'),
  ]);
  const v = compareIntent(o, baseIntent);
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /more than one/i);
});

test('an exact match is preferred over a normalised one', () => {
  resetSeq();
  const o = mkObs([
    elem('checkbox', 'subject initials'),
    elem('textbox', 'Subject Initials'),
  ]);
  // The exact match is a textbox and matches type `text`; the normalised-only
  // candidate is a checkbox and would fail the role check.
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

// ---------------------------------------------------------------------------
// Required comparison (scoring criterion 7).
// ---------------------------------------------------------------------------

test('required intent matched by required state is VERIFIED', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: { required: true } })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: true });
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('required intent contradicted by observed state is AMBIGUOUS', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: { required: false } })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: true });
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.suspected_trap ?? '', /required/i);
});

test('optional intent contradicted by observed required is AMBIGUOUS', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: { required: true } })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: false });
  assert.equal(v.verdict, 'AMBIGUOUS');
});

test('unobservable required state does not fail the comparison', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: {} })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: true });
  assert.equal(v.verdict, 'VERIFIED', 'absence of evidence is not evidence of absence');
});

// ---------------------------------------------------------------------------
// Range comparison (scoring criterion 9).
// ---------------------------------------------------------------------------

const rangeIntent = {
  ...baseIntent,
  label: 'Heart Rate',
  canonical_type: 'integer',
  range_units: { min: 30, max: 200, units: 'bpm' },
};

test('a matching observed range is VERIFIED', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: { range: { min: 30, max: 200 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('a numeric control with NO observed range is AMBIGUOUS, not VERIFIED', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: {} })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'AMBIGUOUS', 'this is the silent-discard trap');
  assert.match(v.suspected_trap ?? '', /discard|type change/i);
});

test('a wrong observed range is AMBIGUOUS', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: { range: { min: 0, max: 999 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /30|200/);
});

test('missing units are AMBIGUOUS, not FAILED', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate', { state: { range: { min: 30, max: 200 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /unit/i);
});

test('units found in the accessible name satisfy the unit check', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate bpm', { state: { range: { min: 30, max: 200 } } })]);
  assert.equal(compareIntent(o, rangeIntent).verdict, 'VERIFIED');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/verify.test.mjs`
Expected: FAIL across the normalisation, required, and range groups.

- [ ] **Step 3: Replace `findByName` with a normalising resolver**

In `src/verify/verify.ts`, replace the existing `findByName` function with:

```typescript
/** Normalise an accessible name for comparison: strip a trailing required
 *  marker, collapse whitespace, case-fold. Applied to both sides. */
export function normaliseLabel(name: string): string {
  return name
    .replace(/\s*\((?:required|mandatory)\)\s*$/i, '')
    .replace(/\s*[*†‡]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface NameMatch {
  el: ObservationElement;
  /** True when the accessible name matched byte-for-byte. */
  exact: boolean;
}

/** Resolve an intent label to at most one element.
 *
 *  Exact matches win outright. Failing that, normalised matches are used, but
 *  only when exactly one candidate normalises to the target — two candidates
 *  that both normalise to the same label is a genuine ambiguity and is
 *  reported rather than resolved by picking the first. */
export function resolveByName(obs: Observation, label: string): NameMatch | 'ambiguous' | null {
  const exact = obs.elements.filter((e) => e.name === label);
  if (exact.length === 1) return { el: exact[0], exact: true };
  if (exact.length > 1) return 'ambiguous';

  const target = normaliseLabel(label);
  const loose = obs.elements.filter((e) => normaliseLabel(e.name) === target);
  if (loose.length === 1) return { el: loose[0], exact: false };
  if (loose.length > 1) return 'ambiguous';
  return null;
}
```

Add `ObservationElement` to the type import at the top of the file if it is not already imported.

- [ ] **Step 4: Rewrite the head of `compareIntent` to use the resolver**

Replace the opening of `compareIntent` (the `const el = findByName(...)` line and the `if (!el)` block) with:

```typescript
export function compareIntent(obs: Observation, intent: IntentRecord): VerdictResult {
  const match = resolveByName(obs, intent.label);

  if (match === 'ambiguous') {
    return {
      verdict: 'AMBIGUOUS',
      reason:
        `more than one element resolves to the label "${intent.label}" in the ` +
        `fresh observation; refusing to guess which one was meant`,
      suspected_trap:
        'duplicate or near-duplicate labels: a previous run may have built ' +
        'this field twice, or the platform renders a shadow copy',
    };
  }

  if (match === null) {
    return {
      verdict: 'FAILED',
      reason: `no element with accessible name "${intent.label}" found in the fresh observation`,
    };
  }

  const el = match.el;
```

The rest of `compareIntent` — the role check and the coded-values block — is unchanged and continues to reference `el`.

- [ ] **Step 5: Replace the range block with a real comparison**

In `compareIntent`, replace the entire `if (intent.range_units) { ... }` block (currently `verify.ts:175-198`, the one whose comment says the AX tree does not expose min/max) with:

```typescript
  // Range (criterion 9). The observed range now comes from PERCEIVE's
  // ElementState. A numeric control carrying NO range when the intent
  // declares one is the silent-discard trap, not a pass.
  if (intent.range_units) {
    const observed = el.state.range;
    const wanted = intent.range_units;

    if (!observed || (observed.min === undefined && observed.max === undefined)) {
      return {
        verdict: 'AMBIGUOUS',
        reason:
          `element "${intent.label}" declares no range bounds, but intent ` +
          `specifies ${wanted.min}-${wanted.max}`,
        suspected_trap:
          'range absent after type set: the platform may have silently ' +
          'discarded the range when the control type changed, or it does not ' +
          'expose bounds in the accessibility tree',
      };
    }

    if (observed.min !== wanted.min || observed.max !== wanted.max) {
      return {
        verdict: 'AMBIGUOUS',
        reason:
          `element "${intent.label}" has range ${observed.min}-${observed.max} ` +
          `but intent specifies ${wanted.min}-${wanted.max}`,
        suspected_trap:
          'range mismatch: the platform may have clamped, rounded, or ' +
          'partially applied the bounds',
      };
    }

    // Units are not an ARIA concept. Look for the unit string in the
    // accessible name. Absence is AMBIGUOUS, never FAILED — units are often
    // rendered presentationally and may be genuinely present but unobservable.
    if (wanted.units) {
      const haystack = normaliseLabel(el.name);
      if (!haystack.includes(wanted.units.toLowerCase())) {
        return {
          verdict: 'AMBIGUOUS',
          reason:
            `element "${intent.label}" does not expose the unit "${wanted.units}" ` +
            `in its accessible name`,
          suspected_trap:
            'units may be rendered presentationally and not exposed to the ' +
            'accessibility tree, or they were not applied',
        };
      }
    }
  }
```

- [ ] **Step 6: Replace the required block with a real comparison**

Replace the comment at the end of `compareIntent` that reads *"Required flag: not reliably exposed in the AX tree; skip"* with:

```typescript
  // Required flag (criterion 7). Now observable via ElementState. An absent
  // observation is not a contradiction: some platforms express requiredness
  // only visually. A PRESENT observation that disagrees is a real mismatch.
  if (el.state.required !== undefined && el.state.required !== intent.required) {
    return {
      verdict: 'AMBIGUOUS',
      reason:
        `element "${intent.label}" reports required=${el.state.required} but ` +
        `intent declares required=${intent.required}`,
      suspected_trap:
        'required flag not applied, or silently reset when the control type ' +
        'was changed',
    };
  }
```

- [ ] **Step 7: Update `checkFirst` to use the resolver**

Replace the body of `checkFirst` with:

```typescript
export function checkFirst(obs: Observation, intent: IntentRecord): VerdictResult {
  const match = resolveByName(obs, intent.label);

  if (match === 'ambiguous') {
    return {
      verdict: 'AMBIGUOUS',
      reason: `more than one existing element resolves to "${intent.label}"`,
      suspected_trap: 'a previous run may have built this field more than once',
    };
  }

  if (match === null) {
    return {
      verdict: 'FAILED',
      reason: `no existing element named "${intent.label}" (build it)`,
    };
  }

  const roles = expectedRoles(intent.canonical_type);
  if (roles.includes(match.el.role)) {
    return {
      verdict: 'VERIFIED',
      reason:
        `element "${intent.label}" already exists with role "${match.el.role}" (skip)` +
        (match.exact ? '' : ' [matched after label normalisation]'),
    };
  }

  return {
    verdict: 'AMBIGUOUS',
    reason:
      `element "${intent.label}" exists but with role "${match.el.role}", not ` +
      `[${roles.join(', ')}]`,
    suspected_trap: 'a same-named element exists with the wrong type',
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run build && node --test test/verify.test.mjs`
Expected: PASS, including all seventeen new tests.

- [ ] **Step 9: Full suite check**

Run: `npm run typecheck && npm test`
Expected: zero type errors. Only the scramble and guard tests fail.

If any *pre-existing* verify test now fails, it is almost certainly asserting the old permissive range behaviour. Read it: if it asserts that a rangeless numeric control is VERIFIED, that assertion was encoding the bug — update it to expect AMBIGUOUS and note the change in the commit message.

- [ ] **Step 10: Commit**

```bash
git add src/verify/verify.ts test/verify.test.mjs
git commit -m "feat(verify): real required and range comparison, normalised labels

Replaces two deferrals to read-backs that were never written. A numeric
control with no declared range now reports AMBIGUOUS instead of VERIFIED,
which is the silent-discard trap from the brief.

findByName is replaced by resolveByName: exact match preferred, normalised
match accepted when unique, and two candidates normalising to the same label
escalate rather than resolving to the first. Exact-only matching previously
mistook 'Age *' for a missing field, which under checkFirst would build a
duplicate."
```

---

# Phase 3 — Lexical demotion

The largest change in the plan. Each task converts a group of candidate-selection sites from filtering to ranking. Run the scramble harness after every task and watch failures fall.

### Task 7: The ranking module

The single home for lexical hints, and the enumeration primitive every binder will use.

**Files:**
- Create: `src/bind/ranking.ts`
- Create: `test/ranking.test.mjs`
- Modify: `build.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test/ranking.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEXICAL_HINTS,
  enumerateActionable,
  enumerateByRoles,
  rankCandidates,
} from '../dist/bind-ranking.mjs';
import { elem, obs, resetSeq } from './fixtures/obs.mjs';

function screen() {
  resetSeq();
  return obs([
    elem('button', 'Save'),
    elem('button', 'Cancel'),
    elem('button', 'Zzyzx'),
    elem('link', 'Study Plan'),
    elem('textbox', 'Field Label'),
    elem('heading', 'Form Designer'),
  ]);
}

test('enumerateActionable selects by role, never by name', () => {
  const pool = enumerateActionable(screen());
  const names = pool.map((e) => e.name);
  assert.ok(names.includes('Zzyzx'), 'a nonsense-named button must still be enumerated');
  assert.ok(names.includes('Save'));
  assert.ok(!names.includes('Form Designer'), 'a heading is not actionable');
  assert.ok(!names.includes('Field Label'), 'a textbox is not actionable');
});

test('enumerateByRoles selects exactly the requested roles', () => {
  const pool = enumerateByRoles(screen(), ['textbox', 'heading']);
  assert.deepEqual(pool.map((e) => e.name).sort(), ['Field Label', 'Form Designer']);
});

// THE invariant. If this ever fails, Finding A has regrown.
test('rankCandidates returns every candidate it was given', () => {
  const pool = enumerateActionable(screen());
  for (const hint of Object.keys(LEXICAL_HINTS)) {
    const ranked = rankCandidates(pool, { hint });
    assert.equal(
      ranked.length,
      pool.length,
      `hint "${hint}" dropped ${pool.length - ranked.length} candidate(s); ` +
      `lexical hints must rank, never exclude`,
    );
  }
});

test('rankCandidates with no options still returns everything', () => {
  const pool = enumerateActionable(screen());
  assert.equal(rankCandidates(pool).length, pool.length);
});

test('a lexical hint raises rank but does not remove others', () => {
  const pool = enumerateActionable(screen());
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked[0].el.name, 'Save', 'the hinted candidate should rank first');
  assert.ok(
    ranked.some((r) => r.el.name === 'Zzyzx'),
    'an unhinted candidate must remain in the ranking',
  );
});

test('a nonsense-named pool still produces a ranking', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Vashild'),
    elem('button', 'Ponmir'),
    elem('button', 'Gelsot'),
  ]));
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].el.name, 'a top candidate must exist even with zero lexical signal');
});

test('diff membership outranks a lexical hint', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Save', { handle: '0/1/1' }),
    elem('button', 'Zzyzx', { handle: '0/1/2' }),
  ]));
  const ranked = rankCandidates(pool, { hint: 'commit', diffAdded: ['0/1/2'] });
  assert.equal(
    ranked[0].el.name,
    'Zzyzx',
    'structural evidence (appeared in the diff) must outweigh an English word',
  );
});

test('a disabled control is demoted but not removed', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Save', { state: { disabled: true } }),
    elem('button', 'Zzyzx'),
  ]));
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked[0].el.name, 'Zzyzx');
  assert.equal(ranked.length, 2, 'the disabled control stays in the pool');
});

test('ranking is stable: equal scores preserve input order', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Alpha'),
    elem('button', 'Beta'),
    elem('button', 'Gamma'),
  ]));
  const ranked = rankCandidates(pool);
  assert.deepEqual(ranked.map((r) => r.el.name), ['Alpha', 'Beta', 'Gamma']);
});

test('every ranked candidate carries its signals as evidence', () => {
  const pool = enumerateActionable(screen());
  const ranked = rankCandidates(pool, { hint: 'commit' });
  const top = ranked[0];
  assert.ok(Array.isArray(top.signals));
  assert.ok(top.signals.length > 0, 'the top candidate must explain its score');
  for (const signal of top.signals) {
    assert.ok(typeof signal.detail === 'string' && signal.detail.length > 0);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/ranking.test.mjs`
Expected: FAIL — `Cannot find module '../dist/bind-ranking.mjs'`

- [ ] **Step 3: Write the ranking module**

```typescript
// src/bind/ranking.ts
/**
 * Structural enumeration and weak-signal ranking.
 *
 * This module exists to enforce one rule, stated in
 * docs/superpowers/specs/2026-09-04-esource-agent-s7-design.md section 2:
 *
 *   Candidate enumeration is structural and exhaustive. Lexical priors may
 *   only rank candidates, never exclude them. The probe adjudicates.
 *
 * LEXICAL_HINTS below is the ONLY place English words appear in binding code.
 * They are data consulted after enumeration, never a filter applied during it.
 * test/enumeration-guard.test.mjs fails if UI words appear elsewhere in
 * src/bind/ or src/engine/probe-runner.ts.
 *
 * HARD WALL: this module reads Observations and returns orderings. It never
 * clicks, and it never decides that a binding is correct — only which
 * candidate to try first.
 */

import type { Observation, ObservationElement } from '../perceive/core';

export type HintKey =
  | 'commit'
  | 'discard'
  | 'palette'
  | 'visit_create'
  | 'visit_open'
  | 'form_create'
  | 'form_open'
  | 'coded_values'
  | 'range'
  | 'status'
  | 'study_root'
  | 'visit_list';

/** Weak lexical priors. A word here may raise a candidate's rank. A word here
 *  may NEVER remove a candidate from the pool. Words are deliberately generic
 *  and multi-lingual-ish in spirit: they are guesses, not knowledge. */
export const LEXICAL_HINTS: Record<HintKey, readonly string[]> = {
  commit: ['save', 'commit', 'persist', 'apply', 'publish', 'submit', 'confirm', 'lock', 'finish', 'done', 'ok'],
  discard: ['cancel', 'discard', 'close', 'back', 'abandon', 'revert', 'undo'],
  palette: ['element', 'library', 'palette', 'control', 'widget', 'component', 'field', 'question', 'item'],
  visit_create: ['visit', 'phase', 'timepoint', 'event', 'add', 'new', 'create', '+'],
  visit_open: ['visit', 'phase', 'timepoint', 'open', 'edit', 'view'],
  form_create: ['form', 'document', 'source', 'sheet', 'record', 'crf', 'add', 'new', 'create', '+'],
  form_open: ['form', 'document', 'open', 'edit', 'builder', 'design'],
  coded_values: ['value', 'option', 'choice', 'code', 'item', 'paste', 'bulk', 'list'],
  range: ['min', 'max', 'minimum', 'maximum', 'range', 'limit', 'bound', 'lower', 'upper'],
  status: ['active', 'saved', 'committed', 'draft', 'unsaved', 'dirty', 'pending', 'published', 'modified'],
  study_root: ['study', 'plan', 'protocol', 'home', 'overview', 'dashboard'],
  visit_list: ['visit', 'schedule', 'phase', 'timeline', 'list'],
};

/** Signal weights. Structural evidence outranks vocabulary, deliberately:
 *  a control that appeared in the diff we just caused is better evidence than
 *  a control whose label happens to contain an English word we guessed. */
const WEIGHT = {
  lexical: 1,
  actionable: 1,
  inRegion: 2,
  primary: 2,
  inDiff: 3,
  disabled: -4,
} as const;

export interface RankSignal {
  name: string;
  weight: number;
  detail: string;
}

export interface RankedCandidate {
  el: ObservationElement;
  score: number;
  signals: RankSignal[];
}

export interface RankOptions {
  /** Which lexical hint list to consult, if any. */
  hint?: HintKey;
  /** Handles that appeared in the most recent diff. Strong structural signal. */
  diffAdded?: readonly string[];
  /** Handle prefix bounding the region of interest. */
  regionHandle?: string;
  /** Handles the platform marks as primary/default actions, if observable. */
  primaryHandles?: readonly string[];
}

/** Roles that can be activated. Structural, not lexical. */
const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem',
]);

/** Every activatable element in the observation, regardless of its name. */
export function enumerateActionable(obs: Observation): ObservationElement[] {
  return obs.elements.filter((e) => ACTIONABLE_ROLES.has(e.role));
}

/** Every element matching one of the given roles, regardless of its name. */
export function enumerateByRoles(obs: Observation, roles: readonly string[]): ObservationElement[] {
  const wanted = new Set(roles);
  return obs.elements.filter((e) => wanted.has(e.role));
}

/**
 * Order a pool of candidates by accumulated weak signals.
 *
 * INVARIANT: the returned array has exactly the same length as `pool`.
 * Nothing is ever filtered out. test/ranking.test.mjs asserts this for every
 * hint key, and it is the mechanical guarantee behind the Finding A principle.
 */
export function rankCandidates(
  pool: readonly ObservationElement[],
  options: RankOptions = {},
): RankedCandidate[] {
  const hints = options.hint ? LEXICAL_HINTS[options.hint] : [];

  const scored = pool.map((el, inputIndex) => {
    const signals: RankSignal[] = [];
    const lower = el.name.toLowerCase();

    for (const word of hints) {
      if (lower.includes(word)) {
        signals.push({
          name: 'lexical',
          weight: WEIGHT.lexical,
          detail: `name contains "${word}" (weak hint only)`,
        });
        break;
      }
    }

    if (options.diffAdded?.includes(el.handle)) {
      signals.push({
        name: 'in-diff',
        weight: WEIGHT.inDiff,
        detail: 'appeared in the diff caused by the preceding action',
      });
    }

    if (options.regionHandle && el.handle.startsWith(options.regionHandle)) {
      signals.push({
        name: 'in-region',
        weight: WEIGHT.inRegion,
        detail: 'located inside the region of interest',
      });
    }

    if (options.primaryHandles?.includes(el.handle)) {
      signals.push({
        name: 'primary',
        weight: WEIGHT.primary,
        detail: 'marked by the platform as a primary action',
      });
    }

    if (ACTIONABLE_ROLES.has(el.role)) {
      signals.push({
        name: 'actionable',
        weight: WEIGHT.actionable,
        detail: `role=${el.role}`,
      });
    }

    if (el.state.disabled) {
      signals.push({
        name: 'disabled',
        weight: WEIGHT.disabled,
        detail: 'control is disabled',
      });
    }

    const score = signals.reduce((sum, s) => sum + s.weight, 0);
    return { candidate: { el, score, signals }, inputIndex };
  });

  // Stable: higher score first, input order as tiebreak.
  scored.sort((a, b) => (b.candidate.score - a.candidate.score) || (a.inputIndex - b.inputIndex));
  return scored.map((s) => s.candidate);
}

/** One-line human-readable explanation of why a candidate ranked where it did.
 *  Goes into BindingRecord.evidence and, later, the journal. */
export function explainRanking(ranked: RankedCandidate, poolSize: number): string {
  const detail = ranked.signals.map((s) => s.detail).join('; ');
  return `ranked 1st of ${poolSize} structurally enumerated candidates ` +
    `(score ${ranked.score}: ${detail || 'no signals'})`;
}
```

- [ ] **Step 4: Register the module in the build**

In `build.mjs`, add to the `nodeModules` array, after the `bind/rung1.ts` entry:

```javascript
    ['src/bind/ranking.ts', 'bind-ranking.mjs'],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test test/ranking.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 6: Check the guard's second assertion now passes**

Run: `node --test test/enumeration-guard.test.mjs`
Expected: the `ranking.ts is the declared home` test now PASSES. The three file-scan tests still fail — that is Tasks 8–12.

- [ ] **Step 7: Commit**

```bash
git add src/bind/ranking.ts test/ranking.test.mjs build.mjs
git commit -m "feat(bind): add structural enumeration and weak-signal ranking

Single home for lexical hints. rankCandidates guarantees output length equals
input length, which is the mechanical form of 'hints rank, never exclude'."
```

---

### Task 8: Demote navigation and visit binders

**Files:**
- Modify: `src/bind/rung0.ts` — `bindNavToStudyRoot` (~line 105), `bindNavToVisitList` (~line 145), `bindVisitCreate` (~line 176), `bindVisitOpen` (~line 236)
- Test: `test/generalization-scramble.test.mjs` (already written)

- [ ] **Step 1: Run the harness to see the current failures**

Run: `npm run build && node --test test/generalization-scramble.test.mjs`
Expected: FAIL. Note which of `visit.create` and the nav ops fail — these are what this task fixes.

- [ ] **Step 2: Add the ranking import to rung0.ts**

At the top of `src/bind/rung0.ts`:

```typescript
import {
  enumerateActionable,
  rankCandidates,
  explainRanking,
} from './ranking';
```

- [ ] **Step 3: Rewrite `bindNavToStudyRoot`**

Replace the whole function body with:

```typescript
export function bindNavToStudyRoot(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'study_root' });
  const best = ranked[0];

  return makeBinding(
    'nav.to_study_root',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the study root / plan screen is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 4: Rewrite `bindNavToVisitList`**

Same shape, with `hint: 'visit_list'` and op id `'nav.to_visit_list'`, post-condition `'the visit list is reached'`.

```typescript
export function bindNavToVisitList(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'visit_list' });
  const best = ranked[0];

  return makeBinding(
    'nav.to_visit_list',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the visit list is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 5: Rewrite `bindVisitCreate`**

```typescript
export function bindVisitCreate(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'visit_create' });
  const best = ranked[0];

  return makeBinding(
    'visit.create',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'a new visit appears in the visit list',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 6: Rewrite `bindVisitOpen`**

```typescript
export function bindVisitOpen(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'visit_open' });
  const best = ranked[0];

  return makeBinding(
    'visit.open',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the named visit detail screen is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 7: Run the harness**

Run: `npm run build && node --test test/generalization-scramble.test.mjs`
Expected: the `visit.create` scramble tests now PASS. `ctx.commit`, `form.create`, `field_palette.open`, `ctx.discard` still fail.

- [ ] **Step 8: Confirm nothing regressed**

Run: `npm test`
Expected: pre-existing rung0 tests still pass. If a pre-existing test asserted that `bindVisitCreate` returns `null` when no English word matched, that assertion encoded the bug — update it to expect a ranked hypothesis and say so in the commit.

- [ ] **Step 9: Commit**

```bash
git add src/bind/rung0.ts test/
git commit -m "refactor(bind): demote lexical gates to ranking in nav and visit binders

Candidates are now enumerated by role and ordered by weak signals. A platform
whose 'Add Visit' is called something else still produces a ranked pool for
the probe to adjudicate instead of an empty one."
```

---

### Task 9: Demote form and palette binders

**Files:**
- Modify: `src/bind/rung0.ts` — `bindFormCreate` (~line 264), `bindFormOpen` (~line 318), `bindFieldPaletteOpen` (~line 371), `bindFormExists`
- Test: `test/generalization-scramble.test.mjs`

- [ ] **Step 1: Rewrite `bindFormCreate`**

```typescript
export function bindFormCreate(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'form_create' });
  const best = ranked[0];

  return makeBinding(
    'form.create',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'a new source document appears under the open visit',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 2: Rewrite `bindFormOpen`**

```typescript
export function bindFormOpen(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'form_open' });
  const best = ranked[0];

  return makeBinding(
    'form.open',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the form designer for the named document is reached',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 3: Rewrite `bindFieldPaletteOpen`**

```typescript
export function bindFieldPaletteOpen(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'palette' });
  const best = ranked[0];

  return makeBinding(
    'field_palette.open',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the element library becomes visible',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

Note: on a platform where the palette is always visible, this binding is harmless — the probe discovers that clicking it changes nothing and the palette is used as-is. Do not add a special case; `probePalette` in Task 12 handles it.

- [ ] **Step 4: Rewrite `bindFormExists` to use label resolution, not substring search**

`form.exists` answers "is there a form named X here". Replace any `includes()`-based search with the same normalisation used in VERIFY:

```typescript
export function bindFormExists(obs: Observation, formLabel: string): BindingRecord | null {
  // Structural: any element whose accessible name resolves to the target
  // label. Normalisation matches VERIFY's resolveByName so that "exists" and
  // "verified" agree about what counts as the same label.
  const target = formLabel.replace(/\s+/g, ' ').trim().toLowerCase();
  const matches = obs.elements.filter(
    (e) => e.name.replace(/\s+/g, ' ').trim().toLowerCase() === target,
  );

  return makeBinding(
    'form.exists',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    `an element whose accessible name is "${formLabel}" is present`,
    [
      matches.length === 0
        ? `no element named "${formLabel}" in the current observation`
        : `${matches.length} element(s) named "${formLabel}": ` +
          matches.map((m) => `${m.role}@${m.handle}`).join(', '),
    ],
    matches.length === 1 ? 'structural' : 'tentative',
  );
}
```

This compares against a label supplied by the IR, not a hardcoded English word, so the enumeration guard does not object.

- [ ] **Step 5: Run the harness**

Run: `npm run build && node --test test/generalization-scramble.test.mjs`
Expected: `form.create` and `field_palette.open` scramble tests now PASS. Only `ctx.commit` and `ctx.discard` still fail.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: zero type errors; only commit/discard scramble tests and the three guard file-scans still fail.

- [ ] **Step 7: Commit**

```bash
git add src/bind/rung0.ts
git commit -m "refactor(bind): demote lexical gates in form and palette binders"
```

---

### Task 10: Demote commit, discard, and status binders

The highest-stakes group. `ctx.commit` failing to bind means nothing persists.

**Files:**
- Modify: `src/bind/rung0.ts` — `bindCtxCommit` (~line 736), `bindCtxIsCommitted` (~line 771), `bindCtxDiscard` (~line 806)
- Test: `test/generalization-scramble.test.mjs`

- [ ] **Step 1: Rewrite `bindCtxCommit` and export the full ranking**

Replace the whole function with:

```typescript
/**
 * Bind ctx.commit.
 *
 * Every actionable control is a candidate. Ranking picks a trial order; it
 * does NOT decide. The rung 1 commit probe clicks candidates in this order
 * until one demonstrably clears the working-copy state, because "not every
 * button that looks like save actually saves" — and on an unseen platform,
 * the button that does save may not look like it either.
 */
export function bindCtxCommit(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'commit' });
  const best = ranked[0];

  return makeBinding(
    'ctx.commit',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'persisted indicator appears / working-copy banner disappears',
    [explainRanking(best, pool.length), 'rung 1 commit probe required before this binding is trusted'],
    'hypothesis',
  );
}

/** The full trial order for the commit probe. Exported so ProbeRunner can
 *  work down the list rather than testing a name-filtered subset. */
export function rankCommitCandidates(obs: Observation): RankedCandidate[] {
  return rankCandidates(enumerateActionable(obs), { hint: 'commit' });
}
```

Add `RankedCandidate` to the ranking import at the top of the file:

```typescript
import {
  enumerateActionable,
  rankCandidates,
  explainRanking,
  type RankedCandidate,
} from './ranking';
```

- [ ] **Step 2: Rewrite `bindCtxDiscard`**

```typescript
export function bindCtxDiscard(obs: Observation): BindingRecord | null {
  const pool = enumerateActionable(obs);
  if (pool.length === 0) return null;

  const ranked = rankCandidates(pool, { hint: 'discard' });
  const best = ranked[0];

  return makeBinding(
    'ctx.discard',
    0,
    [{ step: 'click', evidence_role: best.el.role, evidence_name: best.el.name, handle_kind: 'snapshot-id' }],
    'the working copy is abandoned and the editor closes',
    [explainRanking(best, pool.length)],
    'hypothesis',
  );
}
```

- [ ] **Step 3: Rewrite `bindCtxIsCommitted` to be structural**

Commit status is read as *a difference between two observations*, not as a word. The binding records which elements are plausible status indicators; the probe in Task 12 decides by watching what changes across a commit.

```typescript
/**
 * Bind ctx.is_committed.
 *
 * There is no reliable structural marker for "saved" across platforms, so
 * this binding does not claim to know one. It records the observation's
 * status-bearing candidates — elements that carry text but are not
 * actionable, i.e. banners, badges, and status regions — and defers the
 * decision to the rung 1 commit probe, which compares before/after
 * observations and identifies which of them actually changes on commit.
 */
export function bindCtxIsCommitted(obs: Observation): BindingRecord | null {
  const statusRoles = ['status', 'alert', 'note', 'banner', 'contentinfo', 'generic'];
  const structural = enumerateByRoles(obs, statusRoles).filter((e) => e.name.length > 0);
  const ranked = rankCandidates(structural, { hint: 'status' });

  if (ranked.length === 0) {
    return makeBinding(
      'ctx.is_committed',
      0,
      [{ step: 'wait', handle_kind: 'role-only' }],
      'commit status is observable as a change between pre- and post-commit observations',
      ['no status-bearing element found at rung 0 -- commit probe must decide from the diff alone'],
      'tentative',
    );
  }

  return makeBinding(
    'ctx.is_committed',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    'commit status is observable as a change between pre- and post-commit observations',
    [
      `${ranked.length} status-bearing candidate(s) ranked; top = ` +
      `"${ranked[0].el.name}" (${explainRanking(ranked[0], ranked.length)})`,
    ],
    'tentative',
  );
}
```

Add `enumerateByRoles` to the ranking import.

- [ ] **Step 4: Run the harness — it should now be fully green**

Run: `npm run build && node --test test/generalization-scramble.test.mjs`
Expected: **PASS, all 26 tests.** Every binder produces a candidate under every seed.

- [ ] **Step 5: Run the enumeration guard**

Run: `node --test test/enumeration-guard.test.mjs`
Expected: `src/bind/rung0.ts` now PASSES. `src/bind/rung1.ts` and `src/engine/probe-runner.ts` still fail — Tasks 11 and 12.

- [ ] **Step 6: Full suite**

Run: `npm run typecheck && npm test`
Expected: zero type errors. Only two guard file-scans fail.

- [ ] **Step 7: Commit**

```bash
git add src/bind/rung0.ts
git commit -m "refactor(bind): demote lexical gates in commit, discard and status binders

ctx.commit previously enumerated zero candidates on any platform whose save
control was not named save/commit/persist, which meant nothing persisted and
nothing said so. It now ranks every actionable control and hands the trial
order to the commit probe.

The scramble harness is now green: all rung-0 binders produce candidates when
every accessible name on the page is nonsense."
```

---

### Task 11: Demote rung 1 sub-control discovery

`rung1.ts` locates sub-controls inside a field's property editor — the coded-value entry, the min/max boxes, the decimals box, the formula box. Same treatment, but the pool is form controls rather than actionable elements.

**Files:**
- Modify: `src/bind/rung1.ts` — the helper predicates at ~lines 138-160 and their call sites
- Test: `test/enumeration-guard.test.mjs`, `test/bind.test.mjs` if present

- [ ] **Step 1: Read the current predicates**

Run: `sed -n '130,175p' src/bind/rung1.ts`

You will find a cluster of small predicates of the form `(e) => e.name.toLowerCase().includes('minimum') || ...`. Each is used to find one sub-control.

- [ ] **Step 2: Add the ranking import**

```typescript
import {
  enumerateByRoles,
  rankCandidates,
  explainRanking,
  type RankedCandidate,
} from './ranking';
```

- [ ] **Step 3: Replace each predicate with a ranked finder**

Replace the predicate cluster with:

```typescript
/** Form-control roles that can hold a scalar value. */
const VALUE_ROLES = ['textbox', 'spinbutton', 'combobox', 'searchbox'] as const;

/**
 * Find the sub-control most likely to be the one named by `hint`, inside the
 * property editor. Returns the full ranking, not a single answer: the caller
 * writes a value, reads it back, and moves down the list if the read-back
 * disagrees. Nothing is excluded by name.
 */
function rankValueControls(obs: Observation, hint: Parameters<typeof rankCandidates>[1] extends infer O ? O extends { hint?: infer H } ? H : never : never): RankedCandidate[] {
  return rankCandidates(enumerateByRoles(obs, VALUE_ROLES), { hint });
}

/** The coded-value entry control, if the platform has one. */
export function rankCodedValueControls(obs: Observation): RankedCandidate[] {
  return rankValueControls(obs, 'coded_values');
}

/** The min/max entry controls. Two positions are needed, so the caller takes
 *  the top two of this ranking and confirms by read-back which is which. */
export function rankRangeControls(obs: Observation): RankedCandidate[] {
  return rankValueControls(obs, 'range');
}
```

If the awkward conditional type above is hard to read, use the simpler explicit signature instead:

```typescript
import type { HintKey } from './ranking';

function rankValueControls(obs: Observation, hint: HintKey): RankedCandidate[] {
  return rankCandidates(enumerateByRoles(obs, VALUE_ROLES), { hint });
}
```

Use this second form. Add `HintKey` to the import.

- [ ] **Step 4: Update the call sites**

Every place that called the old predicates now takes `rankCodedValueControls(obs)[0]` or walks the ranking. Where a call site previously did:

```typescript
const minBox = obs.elements.find(isMinControl);
if (!minBox) return null;
```

it becomes:

```typescript
const ranked = rankRangeControls(obs);
if (ranked.length === 0) return null;
const minBox = ranked[0].el;
```

Search for the old predicate names with `grep -n 'isMinControl\|isMaxControl\|isCodedValue\|isDecimals\|isFormula' src/bind/rung1.ts` and update each.

- [ ] **Step 5: Delete the old predicates**

Once no call sites remain, delete the predicate functions entirely. Leaving them unused still fails the enumeration guard.

- [ ] **Step 6: Run the guard**

Run: `npm run build && node --test test/enumeration-guard.test.mjs`
Expected: `src/bind/rung1.ts` now PASSES. Only `probe-runner.ts` fails.

- [ ] **Step 7: Full suite**

Run: `npm run typecheck && npm test`
Expected: zero type errors; only the `probe-runner.ts` guard fails.

- [ ] **Step 8: Commit**

```bash
git add src/bind/rung1.ts
git commit -m "refactor(bind): demote lexical gates in rung 1 sub-control discovery

Range and coded-value sub-controls are now found by role and ranked, with the
caller confirming by read-back rather than trusting a name match."
```

---

### Task 12: Delete the probe-runner filters

The last two, and the ones that carried env-rosetta's own vocabulary.

**Files:**
- Modify: `src/engine/probe-runner.ts:66-76` (`probePalette` exclusion list), `src/engine/probe-runner.ts:139-144` (`probeCommitButton` filter)
- Test: `test/enumeration-guard.test.mjs`

- [ ] **Step 1: Replace the `probePalette` candidate selection**

Replace lines 66–76 (the `candidateButtons` filter with its exclusion list) with:

```typescript
    // Every actionable control is a palette candidate. Placing one and reading
    // back what appeared is the only reliable way to tell a palette tile from
    // a toolbar button on an unseen platform: a tile adds a control to the
    // canvas, a toolbar button does not. Excluding candidates by name here
    // would silently skip whichever tile this platform names unusually.
    const candidateButtons = rankCandidates(
      enumerateActionable(currentObs),
      { hint: 'palette' },
    ).map((r) => r.el);
```

Add the import at the top of `probe-runner.ts`:

```typescript
import { enumerateActionable, rankCandidates } from '../bind/ranking';
```

The existing loop body already handles a non-tile gracefully: `inspectPlacedControl` returns `observedRole === 'none'` and the loop `continue`s. That is exactly the adjudication we want — it now runs over the full pool rather than a name-filtered subset.

- [ ] **Step 2: Replace the `probeCommitButton` candidate selection**

Replace lines 139–144 with:

```typescript
    // Trial order comes from ranking, not filtering. On a platform whose
    // commit control is named something we never guessed, the ranking is
    // near-flat and the probe simply tries more candidates — which is slower
    // and correct, rather than instant and wrong.
    const candidates = rankCommitCandidates(currentObs).map((r) => r.el);
```

Add `rankCommitCandidates` to the rung0 import in `probe-runner.ts`.

- [ ] **Step 3: Bound the probe cost**

Trying every actionable control is safe for palette placement (each is undone by the diff inspection) but a commit probe *clicks things*, which can navigate away. Add a guard immediately after the `candidates` assignment:

```typescript
    // A commit probe mutates state. Cap the number of trials so a pathological
    // page cannot cause an unbounded click storm, and report honestly when the
    // cap is reached rather than claiming nothing could commit.
    const MAX_COMMIT_TRIALS = 12;
    const trials = candidates.slice(0, MAX_COMMIT_TRIALS);
```

Then change the loop to iterate `trials`, and after the loop, before the final `return`, extend the evidence:

```typescript
    if (candidates.length > trials.length) {
      evidence.push(
        `probed ${trials.length} of ${candidates.length} candidates ` +
        `(capped at ${MAX_COMMIT_TRIALS}); no commit confirmed among them`,
      );
    }
```

- [ ] **Step 4: Run the guard**

Run: `npm run build && node --test test/enumeration-guard.test.mjs`
Expected: **PASS, all four tests.**

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test`
Expected: **zero type errors, all tests pass, including the scramble harness and the enumeration guard.**

This is the milestone. Finding A is closed and mechanically guarded.

- [ ] **Step 6: Commit**

```bash
git add src/engine/probe-runner.ts
git commit -m "refactor(engine): delete probe-runner name filters

probeCommitButton filtered candidates on save/freeze/commit/persist/bank.
'freeze' and 'bank' are env-rosetta's own invented vocabulary: the fixture's
words had been added to the matcher to make the fixture pass. Both filters are
now replaced by ranked trial order over structurally enumerated candidates,
capped at 12 trials for the commit probe since it mutates state.

Scramble harness and enumeration guard are both green."
```

- [ ] **Step 7: Tag the phase boundary**

```bash
git tag -a s7-phase3-generalization -m "Finding A closed: binding no longer gates on English words"
```

---

# Phase 4 — The field enumeration operation

### Task 13: Add `form.list_fields` to the contract

**Files:**
- Modify: `src/shared/contract.ts`
- Test: `test/plan.test.mjs` (contract shape assertions live here)

- [ ] **Step 1: Write the failing test**

Append to `test/plan.test.mjs`:

```javascript
import { CONTRACT_OPS } from '../dist/contract.mjs';

test('contract includes form.list_fields', () => {
  assert.ok(
    CONTRACT_OPS.includes('form.list_fields'),
    'reconciliation requires an operation that enumerates the fields in an open form',
  );
});

test('contract has 18 operations', () => {
  assert.equal(CONTRACT_OPS.length, 18);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/plan.test.mjs`
Expected: FAIL — `form.list_fields` absent, length is 17.

- [ ] **Step 3: Add the operation id**

In `src/shared/contract.ts`, add `'form.list_fields'` to the `ContractOpId` union immediately after `'form.exists'`, and to the `CONTRACT_OPS` array in the same position.

- [ ] **Step 4: Add the argument and result shapes**

After `FormExistsArgs`, add:

```typescript
/** Enumerate the controls inside the currently open form.
 *
 *  This is the operation reconciliation is built on: it answers "what is
 *  actually in this form right now", which is what makes a re-run a no-op and
 *  what makes the reuse-versus-rebuild question empirical rather than
 *  assumed. It reads only; it never mutates. */
export interface FormListFieldsArgs {
  op: 'form.list_fields';
}

/** One control observed inside an open form. A projection of
 *  ObservationElement onto the attributes the input file cares about. */
export interface ObservedField {
  /** Accessible name, as observed. Callers normalise before comparing. */
  label: string;
  /** ARIA role, which is what distinguishes near-identical control types. */
  role: string;
  required?: boolean;
  range?: { min?: number; max?: number; step?: number };
  /** Option vocabulary, empty for controls that have none. */
  options: string[];
  /** ACT handle, for follow-up interaction with this specific control. */
  handle: string;
}
```

Add `FormListFieldsArgs` to the `ContractOpArgs` union.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test test/plan.test.mjs`
Expected: PASS.

- [ ] **Step 6: Fix exhaustiveness errors**

Run: `npm run typecheck`

Adding a union member will surface errors wherever a `switch` over `ContractOpId` is exhaustive. Expect them in `src/plan/compiler.ts` and `src/engine/orchestrator.ts`. For each, add a `case 'form.list_fields':` branch. In the compiler's step-description switch, return `'enumerate existing fields'`. In the orchestrator's dispatcher, route it to the reconcile path added in Task 15 — for now, add the case and `throw new Error('form.list_fields is handled by reconcile, not executeStep')` so a wrong call is loud rather than silent.

Repeat `npm run typecheck` until zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/contract.ts src/plan/compiler.ts src/engine/orchestrator.ts test/plan.test.mjs
git commit -m "feat(contract): add form.list_fields, the 18th operation

Reconciliation needs to know what is actually in a form. Without it, a re-run
can only consult its own journal, which produces duplicates whenever storage
is cleared or the study is edited by hand."
```

---

### Task 14: Bind `form.list_fields`

**Files:**
- Modify: `src/bind/rung0.ts`
- Test: `test/generalization-scramble.test.mjs` (extend), `test/ranking.test.mjs` unaffected

- [ ] **Step 1: Write the failing test**

Append to `test/generalization-scramble.test.mjs`:

```javascript
import { bindFormListFields, readObservedFields } from '../dist/bind-rung0.mjs';

test('form.list_fields binds on an unscrambled designer canvas', () => {
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
  const fields = readObservedFields(o);
  const labels = fields.map((f) => f.label).sort();
  assert.deepEqual(labels, ['Sex', 'Subject Initials']);
});

test('readObservedFields carries required, range and options through', () => {
  resetSeq();
  const o = obs([
    elem('spinbutton', 'Heart Rate', {
      state: { required: true, range: { min: 30, max: 200 } },
    }),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  const byLabel = Object.fromEntries(readObservedFields(o).map((f) => [f.label, f]));
  assert.equal(byLabel['Heart Rate'].required, true);
  assert.deepEqual(byLabel['Heart Rate'].range, { min: 30, max: 200 });
  assert.deepEqual(byLabel['Sex'].options, ['Male', 'Female']);
});

test('readObservedFields works when every name is nonsense', () => {
  resetSeq();
  const plain = obs([
    elem('textbox', 'Subject Initials'),
    elem('combobox', 'Sex', { options: ['Male', 'Female'] }),
  ]);
  const scrambled = scrambleObservation(plain, 31);
  assert.equal(
    readObservedFields(scrambled).length,
    2,
    'field enumeration must be role-based and unaffected by vocabulary',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/generalization-scramble.test.mjs`
Expected: FAIL — `bindFormListFields` is not exported.

- [ ] **Step 3: Implement the reader and the binder**

Add to `src/bind/rung0.ts`:

```typescript
/** Roles that realise a data-entry field. Structural, and deliberately the
 *  same set VERIFY's expectedRoles() draws from, so that "what is in this
 *  form" and "does this field match its intent" agree about what a field is. */
const FIELD_ROLES = [
  'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox',
  'radiogroup', 'checkbox', 'switch', 'slider',
] as const;

/**
 * Project the current observation onto the fields present in the open form.
 *
 * Pure and read-only. It does not know which form is open — the caller
 * guarantees that by navigating there first. Everything with a field role and
 * a non-empty accessible name counts; an unnamed control is reported with an
 * empty label so that the "created but never named" failure is visible rather
 * than invisible.
 */
export function readObservedFields(obs: Observation): ObservedField[] {
  return enumerateByRoles(obs, FIELD_ROLES).map((e) => ({
    label: e.name,
    role: e.role,
    required: e.state.required,
    range: e.state.range,
    options: e.options,
    handle: e.handle,
  }));
}

/**
 * Bind form.list_fields. Unlike the action bindings, this one has no recipe to
 * click: enumeration is a read of the current observation. The binding exists
 * so that the capability report can state honestly whether the platform's
 * fields are observable at all — on a canvas-rendered designer they are not,
 * and reconciliation must be reported as unavailable rather than silently
 * returning an empty list that looks like an empty form.
 */
export function bindFormListFields(obs: Observation): BindingRecord | null {
  const fields = readObservedFields(obs);
  const named = fields.filter((f) => f.label.length > 0);

  return makeBinding(
    'form.list_fields',
    0,
    [{ step: 'wait', handle_kind: 'role-only' }],
    'the controls in the open form are enumerable from the accessibility tree',
    [
      `${fields.length} field-role control(s) observed, ${named.length} with an accessible name`,
      ...(fields.length > named.length
        ? [`${fields.length - named.length} control(s) present but UNNAMED -- ` +
           `structurally there and semantically worthless; these escalate`]
        : []),
    ],
    fields.length > 0 ? 'structural' : 'tentative',
  );
}
```

Add `ObservedField` to the contract type import at the top of `rung0.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/generalization-scramble.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bind/rung0.ts test/generalization-scramble.test.mjs
git commit -m "feat(bind): implement form.list_fields via role-based field enumeration

Reports unnamed controls explicitly: an element that exists but was never
labelled is structurally present and semantically worthless, and the brief
penalises exactly that."
```

---

# Phase 5 — Reconciliation

### Task 15: The reconcile decision table

Pure logic, no browser. Given what the input file wants and what the platform has, decide what to do about each field.

**Files:**
- Create: `src/engine/reconcile.ts`
- Create: `test/reconcile.test.mjs`
- Modify: `build.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test/reconcile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileField, reconcileForm, summariseTree } from '../dist/reconcile.mjs';

const intent = {
  visit_id: 'v0',
  form_id: 'v0.f0',
  field_id: 'v0.f0.d0',
  label: 'Heart Rate',
  canonical_type: 'integer',
  required: true,
  range_units: { min: 30, max: 200, units: 'bpm' },
};

function observed(overrides = {}) {
  return {
    label: 'Heart Rate',
    role: 'spinbutton',
    required: true,
    range: { min: 30, max: 200 },
    options: [],
    handle: '0/1/5',
    ...overrides,
  };
}

test('absent field decides BUILD', () => {
  const d = reconcileField(intent, []);
  assert.equal(d.action, 'build');
});

test('matching field decides ADOPT', () => {
  const d = reconcileField(intent, [observed({ label: 'Heart Rate bpm' })]);
  assert.equal(d.action, 'adopt', d.reason);
});

test('wrong role decides ESCALATE, never repair', () => {
  const d = reconcileField(intent, [observed({ role: 'textbox', label: 'Heart Rate bpm' })]);
  assert.equal(d.action, 'escalate');
  assert.match(d.reason, /role/i);
});

test('wrong range decides ESCALATE', () => {
  const d = reconcileField(intent, [observed({ label: 'Heart Rate bpm', range: { min: 0, max: 300 } })]);
  assert.equal(d.action, 'escalate');
  assert.match(d.reason, /range/i);
});

test('wrong required flag decides ESCALATE', () => {
  const d = reconcileField(intent, [observed({ label: 'Heart Rate bpm', required: false })]);
  assert.equal(d.action, 'escalate');
  assert.match(d.reason, /required/i);
});

test('duplicate labels decide ESCALATE', () => {
  const d = reconcileField(intent, [observed({ label: 'Heart Rate bpm' }), observed({ label: 'Heart Rate bpm' })]);
  assert.equal(d.action, 'escalate');
  assert.match(d.reason, /more than one|duplicate/i);
});

test('label matching tolerates normalisation', () => {
  const d = reconcileField(intent, [observed({ label: '  heart   rate  bpm ' })]);
  assert.equal(d.action, 'adopt', d.reason);
});

test('an unnamed control never counts as a match', () => {
  const d = reconcileField(intent, [observed({ label: '' })]);
  assert.equal(d.action, 'build', 'an unnamed control cannot satisfy a labelled intent');
});

test('coded values must match as pairs, not just count', () => {
  const codedIntent = {
    ...intent,
    label: 'Sex',
    canonical_type: 'single_select',
    range_units: undefined,
    coded_pairs: [{ code: 'M', label: 'Male' }, { code: 'F', label: 'Female' }],
  };
  const ok = reconcileField(codedIntent, [{
    label: 'Sex', role: 'combobox', options: ['Male', 'Female'], handle: 'h', required: true,
  }]);
  assert.equal(ok.action, 'adopt', ok.reason);

  const wrong = reconcileField(codedIntent, [{
    label: 'Sex', role: 'combobox', options: ['Male', 'Other'], handle: 'h', required: true,
  }]);
  assert.equal(wrong.action, 'escalate');
});

// --- form level -----------------------------------------------------------

const form = {
  form_id: 'v0.f0',
  name: 'Vital Signs',
  fields: [
    { ...intent, field_id: 'v0.f0.d0', label: 'Heart Rate' },
    { ...intent, field_id: 'v0.f0.d1', label: 'Temperature', range_units: { min: 30, max: 45, units: 'C' } },
  ],
};

test('an empty form means the platform rebuilds per visit: build everything', () => {
  const r = reconcileForm(form, []);
  assert.equal(r.decisions.filter((d) => d.action === 'build').length, 2);
  assert.equal(r.sharedDefinition, false);
});

test('a fully populated form means the platform shares definitions: adopt everything', () => {
  const r = reconcileForm(form, [
    { label: 'Heart Rate bpm', role: 'spinbutton', required: true, range: { min: 30, max: 200 }, options: [], handle: 'a' },
    { label: 'Temperature C', role: 'spinbutton', required: true, range: { min: 30, max: 45 }, options: [], handle: 'b' },
  ]);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 2);
  assert.equal(r.sharedDefinition, true, 'a form arriving already populated indicates a shared definition');
});

test('a partially populated form builds the remainder', () => {
  const r = reconcileForm(form, [
    { label: 'Heart Rate bpm', role: 'spinbutton', required: true, range: { min: 30, max: 200 }, options: [], handle: 'a' },
  ]);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 1);
  assert.equal(r.decisions.filter((d) => d.action === 'build').length, 1);
});

test('extra fields on the platform are reported but never deleted', () => {
  const r = reconcileForm(form, [
    { label: 'Heart Rate bpm', role: 'spinbutton', required: true, range: { min: 30, max: 200 }, options: [], handle: 'a' },
    { label: 'Temperature C', role: 'spinbutton', required: true, range: { min: 30, max: 45 }, options: [], handle: 'b' },
    { label: 'Investigator Note', role: 'textbox', options: [], handle: 'c' },
  ]);
  assert.deepEqual(r.unexpected.map((f) => f.label), ['Investigator Note']);
  assert.ok(!r.decisions.some((d) => d.action === 'delete'), 'reconcile never deletes');
});

// --- tree level -----------------------------------------------------------

test('summariseTree counts what exists against what is wanted', () => {
  const s = summariseTree(
    [
      { visit_id: 'v0', name: 'Screening', forms: [{ form_id: 'v0.f0', name: 'Demographics' }, { form_id: 'v0.f1', name: 'Vital Signs' }] },
      { visit_id: 'v1', name: 'Week 4', forms: [{ form_id: 'v1.f0', name: 'Vital Signs' }] },
    ],
    { 'Screening': ['Demographics'] },
  );
  assert.equal(s.visitsWanted, 2);
  assert.equal(s.visitsPresent, 1);
  assert.equal(s.formAppearancesWanted, 3);
  assert.equal(s.formAppearancesPresent, 1);
  assert.equal(s.visitsToCreate.length, 1);
  assert.equal(s.visitsToCreate[0], 'Week 4');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/reconcile.test.mjs`
Expected: FAIL — `Cannot find module '../dist/reconcile.mjs'`

- [ ] **Step 3: Write the reconcile module**

```typescript
// src/engine/reconcile.ts
/**
 * Reconciliation: derive the work list from the difference between what the
 * input file wants and what the platform actually has.
 *
 * This is the mechanism behind three requirements at once:
 *   - Idempotency. A second run finds everything present and builds nothing.
 *   - Form reuse. A form that arrives already populated indicates the platform
 *     shares definitions across visits; an empty one indicates it does not.
 *     Discovered by looking, never assumed in either direction.
 *   - Recall. Anything the input file wants and the platform lacks is BUILD.
 *
 * HARD WALL: reconcile decides, it does not act, and it never decides to
 * delete. A control the platform has that the input file does not mention is
 * reported as unexpected and left alone — it may be deliberate work by a
 * study builder, and this agent does not know otherwise.
 */

import type { CanonicalType, CodedPair, ObservedField, RangeSpec } from '../shared/contract';

/** The subset of an IR field reconcile needs. Structurally compatible with
 *  verify.ts IntentRecord so callers can pass the same object. */
export interface FieldIntent {
  visit_id: string;
  form_id: string;
  field_id: string;
  label: string;
  canonical_type: CanonicalType;
  required: boolean;
  coded_pairs?: CodedPair[];
  range_units?: RangeSpec;
}

export type ReconcileAction = 'build' | 'adopt' | 'escalate';

export interface FieldDecision {
  field_id: string;
  label: string;
  action: ReconcileAction;
  reason: string;
  /** The matched control, when one was found. */
  observed?: ObservedField;
  /** Populated for escalate: what specifically disagreed. */
  mismatch?: 'role' | 'required' | 'range' | 'units' | 'coded_values' | 'duplicate';
}

/** Same normalisation VERIFY uses, duplicated deliberately: reconcile must not
 *  depend on the verify module, and the two agreeing is asserted by test. */
export function normaliseLabel(name: string): string {
  return name
    .replace(/\s*\((?:required|mandatory)\)\s*$/i, '')
    .replace(/\s*[*†‡]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Roles that can realise each canonical type. Mirrors verify.ts expectedRoles. */
function expectedRoles(canonical: CanonicalType): string[] {
  switch (canonical) {
    case 'text':
    case 'textarea':
    case 'calculated':
      return ['textbox', 'searchbox'];
    case 'integer':
    case 'decimal':
      return ['spinbutton', 'textbox'];
    case 'date':
    case 'time':
    case 'datetime':
      return ['textbox', 'spinbutton'];
    case 'boolean':
      return ['checkbox', 'switch', 'radiogroup'];
    case 'single_select':
      return ['combobox', 'listbox'];
    case 'multi_select':
      return ['listbox', 'combobox'];
    case 'radio':
      return ['radiogroup'];
    case 'checkbox':
      return ['checkbox'];
  }
}

/**
 * Decide what to do about one field.
 *
 * Missing -> build. Present and matching -> adopt. Present and differing ->
 * escalate, never mutate: the agent cannot distinguish its own earlier error
 * from a deliberate human edit.
 */
export function reconcileField(intent: FieldIntent, present: readonly ObservedField[]): FieldDecision {
  const target = normaliseLabel(intent.label);
  const matches = present.filter((f) => f.label.length > 0 && normaliseLabel(f.label) === target);

  if (matches.length === 0) {
    return {
      field_id: intent.field_id,
      label: intent.label,
      action: 'build',
      reason: `no control named "${intent.label}" in this form`,
    };
  }

  if (matches.length > 1) {
    return {
      field_id: intent.field_id,
      label: intent.label,
      action: 'escalate',
      mismatch: 'duplicate',
      reason:
        `more than one control resolves to "${intent.label}" in this form; ` +
        `a previous run may have built it twice`,
    };
  }

  const observed = matches[0];
  const roles = expectedRoles(intent.canonical_type);

  if (!roles.includes(observed.role)) {
    return {
      field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
      mismatch: 'role',
      reason:
        `"${intent.label}" exists with role "${observed.role}" but type ` +
        `"${intent.canonical_type}" expects one of [${roles.join(', ')}]`,
    };
  }

  if (observed.required !== undefined && observed.required !== intent.required) {
    return {
      field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
      mismatch: 'required',
      reason:
        `"${intent.label}" exists with required=${observed.required} but the ` +
        `input file declares required=${intent.required}`,
    };
  }

  if (intent.range_units) {
    const want = intent.range_units;
    const got = observed.range;
    if (!got || got.min !== want.min || got.max !== want.max) {
      return {
        field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
        mismatch: 'range',
        reason:
          `"${intent.label}" exists with range ` +
          `${got ? `${got.min}-${got.max}` : 'none'} but the input file ` +
          `declares ${want.min}-${want.max}`,
      };
    }
    if (want.units && !normaliseLabel(observed.label).includes(want.units.toLowerCase())) {
      return {
        field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
        mismatch: 'units',
        reason: `"${intent.label}" does not expose the unit "${want.units}"`,
      };
    }
  }

  if (intent.coded_pairs && intent.coded_pairs.length > 0) {
    const want = intent.coded_pairs.map((p) => p.label);
    const got = observed.options;
    const same = got.length === want.length && want.every((label, i) => got[i] === label);
    if (!same) {
      return {
        field_id: intent.field_id, label: intent.label, action: 'escalate', observed,
        mismatch: 'coded_values',
        reason:
          `"${intent.label}" has options [${got.join(', ')}] but the input file ` +
          `declares [${want.join(', ')}]`,
      };
    }
  }

  return {
    field_id: intent.field_id,
    label: intent.label,
    action: 'adopt',
    observed,
    reason: `"${intent.label}" already present as ${observed.role} and matches the input file`,
  };
}

export interface FormIntent {
  form_id: string;
  name: string;
  fields: FieldIntent[];
}

export interface FormReconcileResult {
  form_id: string;
  decisions: FieldDecision[];
  /** Controls present that the input file does not mention. Reported, never
   *  deleted. */
  unexpected: ObservedField[];
  /** True when every wanted field was already present on arrival, which is the
   *  observable signature of a platform that shares form definitions across
   *  visits. */
  sharedDefinition: boolean;
}

export function reconcileForm(
  form: FormIntent,
  present: readonly ObservedField[],
): FormReconcileResult {
  const decisions = form.fields.map((f) => reconcileField(f, present));

  const claimed = new Set(
    decisions.map((d) => d.observed?.handle).filter((h): h is string => h !== undefined),
  );
  const unexpected = present.filter((f) => f.label.length > 0 && !claimed.has(f.handle));

  return {
    form_id: form.form_id,
    decisions,
    unexpected,
    sharedDefinition:
      form.fields.length > 0 && decisions.every((d) => d.action === 'adopt'),
  };
}

// ---------------------------------------------------------------------------
// Shallow tree survey.
// ---------------------------------------------------------------------------

export interface TreeVisit {
  visit_id: string;
  name: string;
  forms: { form_id: string; name: string }[];
}

export interface TreeSummary {
  visitsWanted: number;
  visitsPresent: number;
  visitsToCreate: string[];
  formAppearancesWanted: number;
  formAppearancesPresent: number;
  formAppearancesToCreate: { visit: string; form: string }[];
}

/**
 * Compare the wanted visit/form tree against what the platform shows.
 *
 * `presentByVisit` maps an observed visit name to the form names observed
 * under it. Both sides are normalised before comparison.
 */
export function summariseTree(
  wanted: readonly TreeVisit[],
  presentByVisit: Record<string, readonly string[]>,
): TreeSummary {
  const presentIndex = new Map<string, Set<string>>();
  for (const [visitName, formNames] of Object.entries(presentByVisit)) {
    presentIndex.set(
      normaliseLabel(visitName),
      new Set(formNames.map(normaliseLabel)),
    );
  }

  const visitsToCreate: string[] = [];
  const formAppearancesToCreate: { visit: string; form: string }[] = [];
  let visitsPresent = 0;
  let formAppearancesWanted = 0;
  let formAppearancesPresent = 0;

  for (const visit of wanted) {
    const key = normaliseLabel(visit.name);
    const forms = presentIndex.get(key);
    if (forms === undefined) {
      visitsToCreate.push(visit.name);
    } else {
      visitsPresent += 1;
    }
    for (const form of visit.forms) {
      formAppearancesWanted += 1;
      if (forms?.has(normaliseLabel(form.name))) {
        formAppearancesPresent += 1;
      } else {
        formAppearancesToCreate.push({ visit: visit.name, form: form.name });
      }
    }
  }

  return {
    visitsWanted: wanted.length,
    visitsPresent,
    visitsToCreate,
    formAppearancesWanted,
    formAppearancesPresent,
    formAppearancesToCreate,
  };
}
```

- [ ] **Step 4: Register in the build**

In `build.mjs`, add to `nodeModules`:

```javascript
    ['src/engine/reconcile.ts', 'reconcile.mjs'],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test test/reconcile.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 6: Add the normalisation-agreement test**

Reconcile duplicates `normaliseLabel` deliberately. Assert the two stay in step — append to `test/reconcile.test.mjs`:

```javascript
import { normaliseLabel as verifyNormalise } from '../dist/verify.mjs';
import { normaliseLabel as reconcileNormalise } from '../dist/reconcile.mjs';

test('reconcile and verify normalise labels identically', () => {
  const samples = [
    'Heart Rate', 'Heart Rate *', 'Heart Rate (required)', '  Heart   Rate  ',
    'HEART RATE', 'Sex †', '', 'Weight (kg)',
  ];
  for (const s of samples) {
    assert.equal(
      reconcileNormalise(s),
      verifyNormalise(s),
      `divergent normalisation for "${s}" — reconcile and verify would ` +
      `disagree about whether a field already exists`,
    );
  }
});
```

Run it. If it fails, the two implementations have drifted — make them identical.

- [ ] **Step 7: Full suite and commit**

Run: `npm run typecheck && npm test`
Expected: zero errors, all pass.

```bash
git add src/engine/reconcile.ts test/reconcile.test.mjs build.mjs
git commit -m "feat(engine): reconcile decision table

Missing -> build, matching -> adopt, differing -> escalate. Never deletes and
never repairs: the agent cannot tell its own earlier error from a deliberate
human edit.

sharedDefinition falls out of the same pass: a form that arrives already
populated is how a platform that shares form definitions across visits reveals
itself, which settles the reuse-versus-rebuild question by observation."
```

---

### Task 16: Wire reconcile into the orchestrator

**Files:**
- Modify: `src/engine/orchestrator.ts` — `preflight()` (~line 253), `executePlan()` (~line 307), `navigateToForm()` (~line 840), `createForm()` (~line 896)
- Modify: `src/shared/messages.ts`
- Test: `test/orchestrator` coverage via `test/state-machine.test.mjs` and the new `test/idempotency.test.mjs` in Task 21

- [ ] **Step 0: Extend `LinearItem` — it lacks three fields this phase needs**

`LinearItem` (`src/plan/compiler.ts:364`) currently carries only `visit_id`, `form_id`, `field_id`, `label`, `kind`, `op`, `description`. Tasks 16, 17, 18 and 19 all need the canonical type and the human-readable visit and form names — escalation cards show them, the journal records them, and grouping keys are built from the type. Looking them up from the IR at every use site is repetitive and error-prone, so carry them on the item.

In `src/plan/compiler.ts`, extend the interface:

```typescript
export interface LinearItem {
  visit_id: string;
  form_id: string;
  field_id: string;
  label: string;
  kind: MicroStepKind;
  op: ContractOpId;
  description: string;
  /** Canonical type of the field this step belongs to. Escalations group on
   *  it, so a type decision settles every field of that type at once. */
  canonical_type: CanonicalType;
  /** Human-readable names, for escalation cards and journal records. */
  visit_name: string;
  form_name: string;
}
```

In `linearize()`, populate the three new fields wherever a `LinearItem` is pushed. The visit and form are already in scope in the loop; the canonical type comes from the field being linearised. For the `set_skip_logic` steps appended at the end of each form, use the canonical type of the field the rule is attached to.

Add `CanonicalType` to the type imports in `compiler.ts` if it is not already there.

- [ ] **Step 0b: Update the linearize test**

`test/plan.test.mjs` asserts the shape of linearized items. Add:

```javascript
test('every linear item carries its canonical type and human-readable names', () => {
  const items = linearize(compilePlan(parseIR(sampleIR)));
  for (const item of items) {
    assert.ok(item.canonical_type, `item ${item.field_id} has no canonical_type`);
    assert.ok(item.visit_name, `item ${item.field_id} has no visit_name`);
    assert.ok(item.form_name, `item ${item.field_id} has no form_name`);
  }
});
```

Run: `npm run build && node --test test/plan.test.mjs`
Expected: PASS.

- [ ] **Step 1: Add the reconcile summary message type**

In `src/shared/messages.ts`, add:

```typescript
import type { TreeSummary, FieldDecision } from '../engine/reconcile';

/** Shallow-pass result, shown on the pre-flight screen before the human
 *  authorises the run. */
export interface ReconcileSummaryMsg {
  type: 'RECONCILE_SUMMARY';
  summary: TreeSummary;
  /** Whether form.list_fields bound. When false, deep reconciliation is
   *  unavailable and the run degrades to journal-only resume. */
  deepReconcileAvailable: boolean;
}
```

Add `ReconcileSummaryMsg` to the `BackgroundToSidePanelMsg` union.

- [ ] **Step 2: Add the shallow pass to `preflight()`**

At the end of `preflight()`, after the capability report is assembled and before it is returned:

```typescript
    // Shallow reconcile: walk the visit list and, for each visit that exists,
    // the form names under it. Bounded by visit and form-appearance count, not
    // field count, so the pre-flight screen has real content without paying to
    // enumerate 195 fields.
    const presentByVisit: Record<string, string[]> = {};
    await this.runOp('nav.to_visit_list');
    const visitList = await this.driver.perceiveAfterSettle(200);

    for (const visit of this.ir.visits) {
      const opened = await this.tryNavigateToVisitByName(visit.name);
      if (!opened) continue;
      const visitObs = await this.driver.perceiveAfterSettle(200);
      presentByVisit[visit.name] = this.readFormNames(visitObs.observation);
      await this.runOp('nav.to_visit_list');
    }

    const treeSummary = summariseTree(
      this.ir.visits.map((v) => ({
        visit_id: v.visit_id,
        name: v.name,
        forms: v.forms.map((f) => ({ form_id: f.form_id, name: f.name })),
      })),
      presentByVisit,
    );

    this.treeSummary = treeSummary;
    this.deepReconcileAvailable = this.bindings['form.list_fields']?.status === 'bound';
    this.callbacks.onReconcileSummary(treeSummary, this.deepReconcileAvailable);
```

Add the fields to the class:

```typescript
  private treeSummary: TreeSummary | null = null;
  private deepReconcileAvailable = false;
```

Add `onReconcileSummary` to `OrchestratorCallbacks`:

```typescript
  /** Called when the shallow reconcile pass completes, before execution. */
  onReconcileSummary: (summary: TreeSummary, deepAvailable: boolean) => void;
```

- [ ] **Step 3: Add the two helpers**

```typescript
  /** Navigate to a visit by its input-file name. Returns false when no visit
   *  with that name is reachable, which means it does not exist yet. */
  private async tryNavigateToVisitByName(name: string): Promise<boolean> {
    const obs = await this.driver.perceiveAfterSettle(150);
    const target = normaliseLabel(name);
    const match = obs.observation.elements.find(
      (e) => normaliseLabel(e.name) === target &&
             (e.role === 'link' || e.role === 'button' || e.role === 'treeitem'),
    );
    if (!match) return false;
    const res = await this.driver.click(match.handle);
    if (!res.ok) return false;
    await this.sleep(250);
    return true;
  }

  /** The form names visible under the currently open visit. Structural: any
   *  actionable element that is not the visit-level chrome. The reconcile
   *  comparison tolerates extras, so over-reporting here is safe and
   *  under-reporting is not. */
  private readFormNames(observation: Observation): string[] {
    return enumerateActionable(observation)
      .map((e) => e.name)
      .filter((n) => n.length > 0);
  }
```

Import `summariseTree`, `normaliseLabel`, and `TreeSummary` from `./reconcile`, and `enumerateActionable` from `../bind/ranking`.

- [ ] **Step 4: Add the deep pass on form open**

In `navigateToForm()`, after the form designer is confirmed reached, add:

```typescript
    // Deep reconcile: what is actually in this form right now. This is also
    // where the reuse question is answered — a form that arrives already
    // populated means the platform shares definitions across visits.
    if (this.deepReconcileAvailable) {
      const obs = await this.driver.perceiveAfterSettle(250);
      const present = readObservedFields(obs.observation);
      const irForm = this.findIrForm(visitId, formId);
      const result = reconcileForm(
        {
          form_id: irForm.form_id,
          name: irForm.name,
          fields: irForm.fields.map((f) => ({
            visit_id: visitId,
            form_id: irForm.form_id,
            field_id: f.field_id,
            label: f.label,
            canonical_type: f.canonical_type,
            required: f.required,
            coded_pairs: f.options,
            range_units: f.range,
          })),
        },
        present,
      );
      this.formReconcile.set(formId, result);

      if (result.sharedDefinition) {
        this.journal.note(
          formId,
          'form arrived already populated: this platform shares form ' +
          'definitions across visits, so its fields are adopted rather than rebuilt',
        );
      }
    }
```

Add the field and helper:

```typescript
  private formReconcile: Map<string, FormReconcileResult> = new Map();

  private findIrForm(visitId: string, formId: string): IrForm {
    const visit = this.ir.visits.find((v) => v.visit_id === visitId);
    const form = visit?.forms.find((f) => f.form_id === formId);
    if (!form) throw new Error(`no IR form ${formId} under visit ${visitId}`);
    return form;
  }
```

`this.journal` arrives in Task 17. Until then, replace that call with a `console.info` and add a `// TASK 17: route through the journal` marker so it is not forgotten. Task 17 replaces it.

- [ ] **Step 5: Consult the reconcile result before building each field**

In `executeStep()`, at the top, before any mutation:

```typescript
    // Reconcile decides whether this item needs building at all.
    const reconcileResult = this.formReconcile.get(item.form_id);
    const decision = reconcileResult?.decisions.find((d) => d.field_id === item.field_id);

    if (decision?.action === 'adopt') {
      await this.markVerified(itemKey);
      this.journal.adopted(item, decision);
      return;
    }

    if (decision?.action === 'escalate') {
      await this.escalateItem(itemKey, 'verifying', {
        key: itemKey,
        fieldLabel: item.label,
        formName: item.form_name,
        visitName: item.visit_name,
        canonicalType: item.canonical_type,
        reason: decision.reason,
        suspectedTrap: `existing field differs (${decision.mismatch}); not modifying work that may be deliberate`,
        evidence: [decision.reason],
        phase: 'verifying',
      }, /* blocking */ false);
      return;
    }
```

The `blocking` parameter on `escalateItem` arrives in Task 18. Until then call it without that argument.

- [ ] **Step 6: Typecheck and fix**

Run: `npm run typecheck`
Expected: errors about the missing `onReconcileSummary` callback in whatever constructs the `Orchestrator` (`src/background.ts`). Add the callback there, forwarding the message to the side panel:

```typescript
      onReconcileSummary: (summary, deepAvailable) => {
        chrome.runtime.sendMessage({
          type: 'RECONCILE_SUMMARY',
          summary,
          deepReconcileAvailable: deepAvailable,
        } satisfies ReconcileSummaryMsg);
      },
```

Repeat until zero errors.

- [ ] **Step 7: Full suite**

Run: `npm run build && npm test`
Expected: all pass. The orchestrator has no direct unit test; Task 21 covers it end to end.

- [ ] **Step 8: Commit**

```bash
git add src/engine/orchestrator.ts src/shared/messages.ts src/background.ts
git commit -m "feat(engine): wire reconcile into the orchestrator

Shallow pass in preflight populates the pre-flight screen with real numbers.
Deep pass on form open decides build/adopt/escalate per field and detects
shared form definitions by observing whether the form arrived populated."
```

---

### Task 16b: Enforce type-before-range ordering and re-read after type changes

Spec section 5, "Ordering rules". The brief warns that platforms silently discard a range when the field type changes. Task 5 and Task 6 made that discard *detectable*; this task makes it *unlikely* and makes recovery deliberate.

**Files:**
- Modify: `src/engine/orchestrator.ts` — `executeFieldSetRange()` (~line 538), `executeTypeRefinement()` (~line 565)
- Modify: `src/plan/compiler.ts` — micro-step ordering
- Test: `test/plan.test.mjs`

- [ ] **Step 1: Write the failing ordering test**

Append to `test/plan.test.mjs`:

```javascript
test('set_range never precedes the type-setting step for the same field', () => {
  const items = linearize(compilePlan(parseIR(sampleIR)));
  const seen = new Map();
  for (const item of items) {
    const prior = seen.get(item.field_id) ?? [];
    if (item.kind === 'set_range') {
      assert.ok(
        prior.includes('add'),
        `set_range for ${item.field_id} ("${item.label}") is ordered before the ` +
        `control is added; the platform may discard the range when the type is set`,
      );
    }
    seen.set(item.field_id, [...prior, item.kind]);
  }
});

test('every field with a range also has a range re-read step after its type is final', () => {
  const items = linearize(compilePlan(parseIR(sampleIR)));
  const byField = new Map();
  for (const item of items) {
    if (!byField.has(item.field_id)) byField.set(item.field_id, []);
    byField.get(item.field_id).push(item.kind);
  }
  for (const [fieldId, kinds] of byField) {
    if (!kinds.includes('set_range')) continue;
    assert.ok(
      kinds.lastIndexOf('verify_range') > kinds.lastIndexOf('set_range'),
      `field ${fieldId} sets a range but never re-reads it after the type settles`,
    );
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/plan.test.mjs`
Expected: FAIL — there is no `verify_range` micro-step kind.

- [ ] **Step 3: Add the `verify_range` micro-step**

In `src/plan/compiler.ts`, add `'verify_range'` to the `MicroStepKind` union and map it in the op table:

```typescript
  verify_range: 'field.set_range',
```

It reuses the `field.set_range` binding because the read-back inspects the same sub-controls; the orchestrator distinguishes the two by `kind`.

In the micro-step ordering, emit `verify_range` as the **last** step for any field that has a range, after every step that could touch the type. Add its description:

```typescript
    case 'verify_range':
      return 're-read range after type is final';
```

- [ ] **Step 4: Handle `verify_range` in the orchestrator**

In `executeStep`, add a branch:

```typescript
      case 'verify_range': {
        // The range was set earlier. Anything since then that touched the type
        // may have silently discarded it, and the platform will not say so.
        // Read it back from a fresh observation and compare.
        const obs = await this.driver.perceiveAfterSettle(200);
        const verdict = compareIntent(obs.observation, this.intentFor(item));
        if (verdict.verdict === 'VERIFIED') {
          await this.markVerified(itemKey);
          return;
        }
        await this.escalateItem(itemKey, 'verifying', {
          key: itemKey,
          fieldLabel: item.label,
          formName: item.form_name,
          visitName: item.visit_name,
          canonicalType: item.canonical_type,
          reason: verdict.reason,
          suspectedTrap: verdict.suspected_trap ??
            'range discarded after the control type was set',
          evidence: [verdict.reason],
          verdict,
          phase: 'verifying',
        }, /* blocking */ false);
        return;
      }
```

Add an `intentFor(item: LinearItem): IntentRecord` helper that assembles the intent record from the IR field, if one does not already exist.

- [ ] **Step 5: Make `executeTypeRefinement` re-apply a lost range**

`executeTypeRefinement` changes a control's type after it has been placed, which is the exact trigger for the discard. After it completes, re-read the range and, if it is gone, re-apply it once before falling through to escalation:

```typescript
    // Changing the type is the documented trigger for a silently discarded
    // range. Re-read, and if it went missing, set it again — once. A second
    // disappearance is a platform behaviour, not a transient, and escalates.
    if (field.range) {
      const after = await this.driver.perceiveAfterSettle(200);
      const check = compareIntent(after.observation, this.intentFor(item));
      if (check.verdict !== 'VERIFIED') {
        this.journal.note(
          item.field_id,
          `range absent after type refinement; re-applying once (${check.reason})`,
        );
        await this.executeFieldSetRange(itemKey, item, field);
      }
    }
```

- [ ] **Step 6: Run the tests**

Run: `npm run build && node --test test/plan.test.mjs`
Expected: PASS.

- [ ] **Step 7: Full suite and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/plan/compiler.ts src/engine/orchestrator.ts test/plan.test.mjs
git commit -m "feat(plan): type-before-range ordering and post-type range re-read

Ranges are now set only after the control exists, re-read as the last step for
any field that has one, and re-applied once if a type refinement discarded
them. A second disappearance escalates rather than looping."
```

---

# Phase 6 — Traceability

### Task 17: The provenance journal

**Files:**
- Create: `src/engine/journal.ts`
- Create: `test/journal.test.mjs`
- Modify: `build.mjs`, `src/engine/orchestrator.ts`

- [ ] **Step 1: Write the failing test**

```javascript
// test/journal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, toJsonl, toHtmlReport } from '../dist/journal.mjs';

function fixture() {
  const j = new Journal('run-abc', 1_700_000_000_000);
  j.created(
    {
      path: 'visits[0].forms[2].fields[1]',
      visit_name: 'Screening',
      form_name: 'Vital Signs',
      field_label: 'Heart Rate',
      declared_type: 'integer',
    },
    'field.add',
    { rung: 1, evidence: ['probe placed control; read back role "spinbutton"'] },
    { verdict: 'VERIFIED', reason: 'label, required and range all match' },
  );
  j.adopted(
    {
      path: 'visits[1].forms[0].fields[0]',
      visit_name: 'Week 4',
      form_name: 'Vital Signs',
      field_label: 'Heart Rate',
      declared_type: 'integer',
    },
    'already present and matching; left alone',
  );
  j.escalated(
    {
      path: 'visits[0].forms[1].fields[3]',
      visit_name: 'Screening',
      form_name: 'Demographics',
      field_label: 'Sex',
      declared_type: 'single_select',
    },
    'names and behaviour disagree',
    { action: 'override', note: 'Beam Pick is the dropdown here' },
  );
  return j;
}

test('every record carries a monotonically increasing seq', () => {
  const records = fixture().records();
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3]);
});

test('every record traces back to a path in the input file', () => {
  for (const r of fixture().records()) {
    assert.match(r.ir_source.path, /^visits\[\d+\]/);
    assert.ok(r.ir_source.visit_name);
    assert.ok(r.ir_source.form_name);
  }
});

test('a created record carries the binding rung and its evidence', () => {
  const r = fixture().records()[0];
  assert.equal(r.outcome, 'created');
  assert.equal(r.binding.rung, 1);
  assert.ok(r.binding.evidence.length > 0);
  assert.equal(r.verification.verdict, 'VERIFIED');
});

test('an adopted record explains why nothing was built', () => {
  const r = fixture().records()[1];
  assert.equal(r.outcome, 'adopted');
  assert.match(r.verification.reason, /already present/i);
});

test('an escalated record carries the human decision', () => {
  const r = fixture().records()[2];
  assert.equal(r.outcome, 'escalated');
  assert.equal(r.human.action, 'override');
  assert.match(r.human.note, /Beam Pick/);
});

test('records are frozen: the journal is append-only', () => {
  const j = fixture();
  const r = j.records()[0];
  assert.throws(() => { r.outcome = 'tampered'; }, TypeError);
});

test('records() returns a copy, so callers cannot splice history', () => {
  const j = fixture();
  j.records().pop();
  assert.equal(j.records().length, 3);
});

test('toJsonl emits one parseable object per line', () => {
  const lines = toJsonl(fixture().records()).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(parsed.seq);
    assert.ok(parsed.ir_source.path);
  }
});

test('toHtmlReport groups by visit then form', () => {
  const html = toHtmlReport(fixture(), { studyTitle: 'ABC-101' });
  assert.match(html, /Screening/);
  assert.match(html, /Week 4/);
  assert.match(html, /Vital Signs/);
  assert.match(html, /Heart Rate/);
  assert.match(html, /ABC-101/);
});

test('toHtmlReport escapes content rather than injecting it', () => {
  const j = new Journal('run-x', 0);
  j.adopted(
    { path: 'visits[0].forms[0].fields[0]', visit_name: 'V', form_name: 'F', field_label: '<script>alert(1)</script>' },
    'present',
  );
  const html = toHtmlReport(j, { studyTitle: 'T' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('a note records something worth remembering without a field', () => {
  const j = new Journal('run-y', 0);
  j.note('v0.f0', 'form arrived already populated; platform shares definitions');
  const r = j.records()[0];
  assert.equal(r.outcome, 'note');
  assert.match(r.verification.reason, /shares definitions/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/journal.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the journal**

```typescript
// src/engine/journal.ts
/**
 * Append-only provenance journal.
 *
 * The assignment requires that for every element the agent creates, it can say
 * which entry in the input file it came from and why. Adoptions and skips are
 * recorded alongside creations: "already present, matched, left alone" is what
 * explains why a second run touched nothing, and it is as load-bearing as a
 * creation record.
 *
 * Records are frozen on write and records() returns a copy. The journal is a
 * log, not a working set.
 */

import type { BindingRung, CanonicalType, ContractOpId } from '../shared/contract';
import type { Verdict } from '../verify/verify';
import type { HumanDecision } from '../shared/messages';

export interface IrSource {
  /** Path into the input file, e.g. "visits[0].forms[2].fields[1]". */
  path: string;
  visit_name: string;
  form_name: string;
  field_label?: string;
  declared_type?: CanonicalType;
}

export type JournalOutcome = 'created' | 'adopted' | 'skipped' | 'escalated' | 'failed' | 'note';

export interface JournalBinding {
  rung: BindingRung;
  evidence: string[];
  llm_rationale?: string;
  llm_rank?: number;
}

export interface JournalVerification {
  verdict: Verdict | 'N/A';
  reason: string;
  suspected_trap?: string;
}

export interface JournalRecord {
  seq: number;
  run_id: string;
  timestamp: number;
  ir_source: IrSource;
  op: ContractOpId | 'note';
  outcome: JournalOutcome;
  binding: JournalBinding | null;
  verification: JournalVerification | null;
  human: { action: HumanDecision['action']; note?: string } | null;
}

export class Journal {
  private readonly runId: string;
  private readonly clock: () => number;
  private seq = 0;
  private log: JournalRecord[] = [];

  /** `now` accepts a fixed number for deterministic tests. */
  constructor(runId: string, now: number | (() => number) = () => Date.now()) {
    this.runId = runId;
    this.clock = typeof now === 'number' ? () => now : now;
  }

  private append(record: Omit<JournalRecord, 'seq' | 'run_id' | 'timestamp'>): void {
    this.seq += 1;
    this.log.push(Object.freeze({
      seq: this.seq,
      run_id: this.runId,
      timestamp: this.clock(),
      ...record,
    }) as JournalRecord);
  }

  created(
    source: IrSource,
    op: ContractOpId,
    binding: JournalBinding,
    verification: JournalVerification,
    human?: { action: HumanDecision['action']; note?: string },
  ): void {
    this.append({ ir_source: source, op, outcome: 'created', binding, verification, human: human ?? null });
  }

  adopted(source: IrSource, reason: string): void {
    this.append({
      ir_source: source,
      op: 'form.list_fields',
      outcome: 'adopted',
      binding: null,
      verification: { verdict: 'VERIFIED', reason },
      human: null,
    });
  }

  skipped(source: IrSource, reason: string, human?: { action: HumanDecision['action']; note?: string }): void {
    this.append({
      ir_source: source, op: 'note', outcome: 'skipped', binding: null,
      verification: { verdict: 'N/A', reason }, human: human ?? null,
    });
  }

  escalated(
    source: IrSource,
    reason: string,
    human: { action: HumanDecision['action']; note?: string } | null,
    binding: JournalBinding | null = null,
  ): void {
    this.append({
      ir_source: source, op: 'note', outcome: 'escalated', binding,
      verification: { verdict: 'AMBIGUOUS', reason }, human,
    });
  }

  failed(source: IrSource, op: ContractOpId, reason: string, binding: JournalBinding | null = null): void {
    this.append({
      ir_source: source, op, outcome: 'failed', binding,
      verification: { verdict: 'FAILED', reason }, human: null,
    });
  }

  /** Something worth recording that is not about one field. */
  note(scope: string, message: string): void {
    this.append({
      ir_source: { path: scope, visit_name: '', form_name: '' },
      op: 'note', outcome: 'note', binding: null,
      verification: { verdict: 'N/A', reason: message }, human: null,
    });
  }

  records(): JournalRecord[] {
    return this.log.slice();
  }
}

export function toJsonl(records: readonly JournalRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Readable report grouped visit -> form -> field. */
export function toHtmlReport(journal: Journal, meta: { studyTitle: string }): string {
  const records = journal.records();

  const byVisit = new Map<string, Map<string, JournalRecord[]>>();
  for (const r of records) {
    const visit = r.ir_source.visit_name || '(run-level)';
    const form = r.ir_source.form_name || '(form-level)';
    if (!byVisit.has(visit)) byVisit.set(visit, new Map());
    const forms = byVisit.get(visit)!;
    if (!forms.has(form)) forms.set(form, []);
    forms.get(form)!.push(r);
  }

  const counts = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  const sections: string[] = [];
  for (const [visit, forms] of byVisit) {
    const formBlocks: string[] = [];
    for (const [form, rows] of forms) {
      const trs = rows.map((r) => `
        <tr class="${esc(r.outcome)}">
          <td>${esc(r.ir_source.field_label ?? '—')}</td>
          <td>${esc(r.ir_source.declared_type ?? '—')}</td>
          <td>${esc(r.outcome)}</td>
          <td>${r.binding ? `rung ${r.binding.rung}` : '—'}</td>
          <td>${esc(r.verification?.reason ?? '')}</td>
          <td>${esc(r.binding?.evidence.join('; ') ?? '')}</td>
          <td>${r.human ? esc(`${r.human.action}${r.human.note ? `: ${r.human.note}` : ''}`) : '—'}</td>
          <td><code>${esc(r.ir_source.path)}</code></td>
        </tr>`).join('');
      formBlocks.push(`
        <h3>${esc(form)}</h3>
        <table>
          <thead><tr>
            <th>Field</th><th>Type</th><th>Outcome</th><th>Rung</th>
            <th>What confirmed it</th><th>Why this binding</th><th>Human</th><th>Input file</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>`);
    }
    sections.push(`<section><h2>${esc(visit)}</h2>${formBlocks.join('')}</section>`);
  }

  return `<!doctype html>
<meta charset="utf-8">
<title>Build report — ${esc(meta.studyTitle)}</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #d0d0d0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  tr.created { background: #f6fff6; }
  tr.adopted { background: #f6f9ff; }
  tr.escalated { background: #fffbf0; }
  tr.failed { background: #fff5f5; }
  code { font-size: 12px; color: #555; }
  .summary { margin-bottom: 2rem; padding: 1rem; background: #f8f8f8; border-radius: 4px; }
</style>
<h1>Build report — ${esc(meta.studyTitle)}</h1>
<div class="summary">
  ${Object.entries(counts).map(([k, v]) => `<strong>${esc(k)}:</strong> ${v}`).join(' &middot; ')}
  <br><small>${records.length} records. Every row names the entry in the input file it came from.</small>
</div>
${sections.join('')}
`;
}
```

- [ ] **Step 4: Register in the build**

```javascript
    ['src/engine/journal.ts', 'journal.mjs'],
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && node --test test/journal.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 6: Wire the journal into the orchestrator**

In `src/engine/orchestrator.ts`:

Add the field and construct it in the constructor:

```typescript
  private journal: Journal;
```
```typescript
    this.journal = new Journal(runId);
```

Add a helper that builds an `IrSource` from a `LinearItem`:

```typescript
  private sourceOf(item: LinearItem): IrSource {
    const visitIndex = this.ir.visits.findIndex((v) => v.visit_id === item.visit_id);
    const visit = this.ir.visits[visitIndex];
    const formIndex = visit?.forms.findIndex((f) => f.form_id === item.form_id) ?? -1;
    const form = visit?.forms[formIndex];
    const fieldIndex = form?.fields.findIndex((f) => f.field_id === item.field_id) ?? -1;
    return {
      path: `visits[${visitIndex}].forms[${formIndex}].fields[${fieldIndex}]`,
      visit_name: item.visit_name,
      form_name: item.form_name,
      field_label: item.label,
      declared_type: item.canonical_type,
    };
  }
```

Then emit at each outcome:
- In `markVerified`, call `this.journal.created(this.sourceOf(item), item.op, {rung, evidence}, verdict)`.
- In the reconcile adopt branch from Task 16, replace the placeholder with `this.journal.adopted(this.sourceOf(item), decision.reason)`.
- In `escalateItem`, after the human decision resolves, call `this.journal.escalated(...)` with the decision.
- Replace the Task 16 `console.info` marker with `this.journal.note(formId, '...')`.
- On a FAILED verdict, call `this.journal.failed(...)`.

Add `getJournal(): Journal { return this.journal; }` so the side panel can export it.

- [ ] **Step 7: Typecheck, build, full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: zero errors, all pass.

- [ ] **Step 8: Commit**

```bash
git add src/engine/journal.ts test/journal.test.mjs build.mjs src/engine/orchestrator.ts
git commit -m "feat(engine): append-only provenance journal

One immutable record per act, tracing back to a path in the input file with
the binding rung, its evidence, the verification verdict, and any human
decision. Adoptions and notes are recorded alongside creations."
```

---

# Phase 7 — The human queue

### Task 18: Blocking versus non-blocking escalation

**Files:**
- Modify: `src/engine/orchestrator.ts` — `escalateItem()` (~line 1102), `executePlan()` (~line 307)
- Modify: `src/shared/messages.ts` — `EscalationItem`

- [ ] **Step 1: Extend `EscalationItem`**

In `src/shared/messages.ts`, add to `EscalationItem`:

```typescript
  /** Blocking escalations pause the run because it cannot proceed without an
   *  answer (no commit control; an unresolved canonical type gating every
   *  field of that type). Non-blocking ones are parked and reviewed at the
   *  end, so a long build is not an interrupt-driven review session. */
  blocking: boolean;
  /** How many other items share this decision. A type mapping affecting 14
   *  fields is one decision, not fourteen. */
  blastRadius?: { fields: number; forms: number };
  /** Stable key grouping items that share one decision, e.g. the canonical
   *  type. Items with the same groupKey resolve together. */
  groupKey?: string;
```

- [ ] **Step 2: Add the blocking parameter to `escalateItem`**

```typescript
  private async escalateItem(
    itemKey: string,
    phase: 'binding' | 'acting' | 'verifying',
    escalation: Omit<EscalationItem, 'blocking'>,
    blocking: boolean,
  ): Promise<HumanDecision | null> {
    const record = this.runState.items[itemKey];
    if (record && record.state !== 'escalated') {
      await applyTransition(this.adapter, this.runState, itemKey, 'escalate');
    }

    const item: EscalationItem = { ...escalation, blocking };
    this.callbacks.onEscalation(item);

    if (!blocking) {
      // Park it. The run continues; the reviewer clears the pile at the end.
      this.parked.push(item);
      this.journal.escalated(this.sourceOfKey(itemKey), item.reason, null);
      return null;
    }

    const decision = await new Promise<HumanDecision>((resolve) => {
      this.escalationQueue.set(itemKey, { resolve });
    });
    this.journal.escalated(this.sourceOfKey(itemKey), item.reason, {
      action: decision.action,
      note: decision.note,
    });
    return decision;
  }
```

Add `private parked: EscalationItem[] = [];` and a `getParked()` accessor.

- [ ] **Step 3: Set `blocking` at every call site**

Blocking (`true`):
- `ctx.commit` failed to bind, in `preflight`.
- A canonical type unresolved after rung 2, in `executeFieldAdd`.
- `form.list_fields` failed to bind when the run needs reconciliation.
- The plan compiler reported a cyclic skip-logic graph.

Non-blocking (`false`):
- Range rejected or discarded (`executeFieldSetRange`).
- Coded values did not land (`executeFieldSetCodedValues`).
- Skip-rule controlling field not found (`executeFieldSetSkipLogic`).
- Reconcile mismatch (Task 16's branch).
- Form creation unconfirmed (`createForm`).

Grep for `escalateItem(` and set each explicitly. Do not default the parameter — an unmarked escalation should be a compile error, not a silent guess.

- [ ] **Step 4: Add blast radius and group key for type escalations**

In `executeFieldAdd`, when the type is unresolved:

```typescript
      const affected = this.linearItems.filter(
        (i) => i.kind === 'add' && i.canonical_type === item.canonical_type,
      );
      const forms = new Set(affected.map((i) => i.form_id));
      await this.escalateItem(itemKey, 'binding', {
        key: itemKey,
        fieldLabel: item.label,
        formName: item.form_name,
        visitName: item.visit_name,
        canonicalType: item.canonical_type,
        reason: `no confident control for canonical type "${item.canonical_type}"`,
        suspectedTrap: 'near-identical library entries; names and behaviour may disagree',
        evidence,
        phase: 'binding',
        groupKey: `type:${item.canonical_type}`,
        blastRadius: { fields: affected.length, forms: forms.size },
      }, /* blocking */ true);
```

- [ ] **Step 5: Apply a group decision to the whole group**

In `resolveEscalation`, after resolving the named item:

```typescript
  resolveEscalation(key: string, decision: HumanDecision): void {
    const pending = this.escalationQueue.get(key);
    if (pending) {
      pending.resolve(decision);
      this.escalationQueue.delete(key);
    }

    // A decision on a grouped escalation settles every item in that group.
    // 13 canonical types means at most 13 type decisions, never 195.
    const resolved = this.parked.find((p) => p.key === key) ?? null;
    const groupKey = resolved?.groupKey;
    if (groupKey) {
      this.groupDecisions.set(groupKey, decision);
      for (const [otherKey, waiter] of this.escalationQueue) {
        const other = this.parked.find((p) => p.key === otherKey);
        if (other?.groupKey === groupKey) {
          waiter.resolve(decision);
          this.escalationQueue.delete(otherKey);
        }
      }
    }
  }
```

Add `private groupDecisions: Map<string, HumanDecision> = new Map();` and consult it before escalating:

```typescript
    const existing = escalation.groupKey ? this.groupDecisions.get(escalation.groupKey) : undefined;
    if (existing) return existing;
```

as the first lines of `escalateItem`.

- [ ] **Step 6: Review the parked pile at the end of the run**

At the end of `executePlan`, before emitting the summary:

```typescript
    // Parked items are reviewed in one sitting rather than as interruptions.
    if (this.parked.length > 0) {
      this.phase = 'paused';
      this.callbacks.onParkedReview(this.parked.slice());
      await this.waitForResume();
    }
```

Add `onParkedReview` to `OrchestratorCallbacks` and forward it in `src/background.ts`.

- [ ] **Step 7: Typecheck, build, test, commit**

Run: `npm run typecheck && npm run build && npm test`

```bash
git add src/engine/orchestrator.ts src/shared/messages.ts src/background.ts
git commit -m "feat(engine): split blocking from non-blocking escalation

A run is now a few questions up front, an uninterrupted build, then one review
session. Grouped escalations resolve together: a type decision settles every
field of that type, so the worst case is 13 decisions rather than 195."
```

---

### Task 19: Side panel — pre-flight summary, cards, export

**Files:**
- Modify: `src/sidepanel/app.ts`, `sidepanel.html`

- [ ] **Step 1: Render the reconcile summary on the pre-flight tab**

Handle `RECONCILE_SUMMARY` and render:

```typescript
function renderReconcileSummary(s: TreeSummary, deepAvailable: boolean): string {
  const parts = [
    `<p><strong>${s.visitsPresent} of ${s.visitsWanted}</strong> visits already exist.</p>`,
    `<p><strong>${s.formAppearancesPresent} of ${s.formAppearancesWanted}</strong> form appearances present.</p>`,
    `<p><strong>${s.formAppearancesToCreate.length}</strong> forms to create.</p>`,
  ];
  if (s.visitsToCreate.length > 0) {
    parts.push(`<p class="detail">Visits to create: ${s.visitsToCreate.map(escapeHtml).join(', ')}</p>`);
  }
  if (!deepAvailable) {
    parts.push(
      `<p class="warn"><strong>Field-level reconciliation unavailable.</strong> ` +
      `This platform's form contents could not be enumerated, so a re-run cannot ` +
      `detect fields that already exist. Re-running may create duplicates.</p>`,
    );
  }
  return parts.join('');
}
```

The warning matters: it states a real limitation instead of silently degrading.

- [ ] **Step 2: Render escalation cards with blast radius**

```typescript
function renderEscalationCard(item: EscalationItem): string {
  const radius = item.blastRadius
    ? `<p class="radius">Affects ${item.blastRadius.fields} fields across ${item.blastRadius.forms} forms.</p>`
    : '';
  const evidence = item.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  return `
    <article class="card ${item.blocking ? 'blocking' : 'parked'}" data-key="${escapeHtml(item.key)}">
      <header>
        <span class="badge">${item.blocking ? 'Blocking' : 'Parked'}</span>
        <h3>${escapeHtml(item.canonicalType)} — ${escapeHtml(item.reason)}</h3>
      </header>
      <p class="location">${escapeHtml(item.visitName)} › ${escapeHtml(item.formName)} › ${escapeHtml(item.fieldLabel)}</p>
      <ul class="evidence">${evidence}</ul>
      ${item.suspectedTrap ? `<p class="trap">Suspected: ${escapeHtml(item.suspectedTrap)}</p>` : ''}
      ${radius}
      <div class="actions">
        <button data-action="approve">Approve as built</button>
        <select data-role="override-type">
          ${CANONICAL_TYPES.map((t) => `<option value="${t}"${t === item.canonicalType ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <button data-action="override">Use this type</button>
        <button data-action="skip">Skip${item.blastRadius ? ` these ${item.blastRadius.fields}` : ''}</button>
        <input data-role="note" placeholder="Note (recorded in the audit trail)">
      </div>
    </article>`;
}
```

- [ ] **Step 3: Add the journal export controls**

In `sidepanel.html`, add to the Report tab:

```html
<div class="export">
  <button id="export-jsonl">Export audit trail (JSONL)</button>
  <button id="export-report">Export build report (HTML)</button>
</div>
```

In `app.ts`:

```typescript
function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('export-jsonl')?.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'GET_JOURNAL' });
  download(`build-${res.runId}.jsonl`, res.jsonl, 'application/x-ndjson');
});

document.getElementById('export-report')?.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'GET_JOURNAL' });
  download(`build-report-${res.runId}.html`, res.html, 'text/html');
});
```

Add a `GET_JOURNAL` message type and a handler in `src/background.ts` that calls `orchestrator.getJournal()` and returns `toJsonl(...)` and `toHtmlReport(...)`.

- [ ] **Step 4: Add the API key field**

In `sidepanel.html`, on the Pre-Flight tab:

```html
<details class="llm-config">
  <summary>Optional: AI-assisted type mapping</summary>
  <p class="detail">
    Speeds up ambiguous type mappings by ranking candidates the agent already
    observed. Its answer is always confirmed by a probe before anything is
    built. With no key the agent still completes the build — ambiguous types
    go to the review queue instead.
  </p>
  <input type="password" id="api-key" placeholder="Anthropic API key (stored locally)">
  <button id="save-key">Save</button>
  <span id="key-status"></span>
</details>
```

```typescript
document.getElementById('save-key')?.addEventListener('click', async () => {
  const input = document.getElementById('api-key') as HTMLInputElement;
  await chrome.storage.local.set({ anthropicApiKey: input.value.trim() });
  input.value = '';
  setKeyStatus(true);
});

async function setKeyStatus(justSaved = false): Promise<void> {
  const { anthropicApiKey } = await chrome.storage.local.get('anthropicApiKey');
  const el = document.getElementById('key-status');
  if (el) {
    el.textContent = anthropicApiKey
      ? (justSaved ? 'Key saved. Rung 2 enabled.' : 'Key configured. Rung 2 enabled.')
      : 'No key. Ambiguous types will be escalated.';
  }
}
```

- [ ] **Step 5: Build, load, and check by hand**

Run: `npm run build`

Load `dist/` as an unpacked extension, open the side panel, confirm the pre-flight tab renders, the key field saves, and the export buttons appear. There is no automated test for this; verify visually.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/app.ts sidepanel.html src/shared/messages.ts src/background.ts
git commit -m "feat(sidepanel): reconcile summary, blast-radius cards, journal export, key entry"
```

---

# Phase 8 — Rung 2

### Task 20: LLM candidate ranking, probe-adjudicated

**Files:**
- Create: `src/bind/rung2.ts`
- Create: `test/rung2.test.mjs`
- Modify: `build.mjs`, `manifest.json`, `src/engine/orchestrator.ts`

- [ ] **Step 1: Write the failing test**

```javascript
// test/rung2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, rankWithLlm } from '../dist/bind-rung2.mjs';
import { elem, obs, resetSeq } from './fixtures/obs.mjs';

function candidates() {
  resetSeq();
  return [
    { el: elem('button', 'Beam Pick'), score: 1, signals: [] },
    { el: elem('button', 'Orbit List'), score: 1, signals: [] },
    { el: elem('button', 'Tick Box'), score: 0, signals: [] },
  ];
}

test('the request contains only observed candidates, never DOM', () => {
  const req = buildRequest('single_select', candidates());
  const body = JSON.stringify(req);
  assert.ok(body.includes('Beam Pick'));
  assert.ok(body.includes('single_select'));
  assert.ok(!body.includes('handle'), 'ACT handles must not be sent');
  assert.ok(!/<[a-z]+[ >]/.test(body), 'no HTML may appear in the request');
});

test('the request names a current model', () => {
  assert.match(buildRequest('single_select', candidates()).model, /claude/);
});

test('parseResponse accepts a valid ranking', () => {
  const r = parseResponse(
    JSON.stringify({ ranking: [{ index: 1, reason: 'a list control' }, { index: 0, reason: 'looks like a picker' }] }),
    3,
  );
  assert.deepEqual(r.map((x) => x.index), [1, 0]);
  assert.equal(r[0].reason, 'a list control');
});

test('parseResponse tolerates prose around the JSON', () => {
  const r = parseResponse('Here you go:\n```json\n{"ranking":[{"index":2,"reason":"tick box"}]}\n```', 3);
  assert.equal(r[0].index, 2);
});

test('parseResponse rejects an out-of-range index', () => {
  assert.throws(() => parseResponse(JSON.stringify({ ranking: [{ index: 9, reason: 'x' }] }), 3), /range/i);
});

test('parseResponse rejects an invented candidate', () => {
  assert.throws(
    () => parseResponse(JSON.stringify({ ranking: [{ name: 'Something Else', reason: 'x' }] }), 3),
    /index/i,
  );
});

test('parseResponse rejects unparseable output', () => {
  assert.throws(() => parseResponse('I am not sure, sorry.', 3), /parse/i);
});

test('rankWithLlm returns null when no key is configured', async () => {
  const r = await rankWithLlm('single_select', candidates(), { apiKey: null, fetch: async () => { throw new Error('must not be called'); } });
  assert.equal(r, null);
});

test('rankWithLlm returns null on a network failure', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test',
    fetch: async () => { throw new Error('offline'); },
  });
  assert.equal(r, null, 'a failed call degrades to escalation, never to a guess');
});

test('rankWithLlm returns null on a non-200 response', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test',
    fetch: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
  });
  assert.equal(r, null);
});

test('rankWithLlm returns null on malformed content', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'no idea' }] }) }),
  });
  assert.equal(r, null);
});

test('rankWithLlm reorders the given candidates and nothing else', async () => {
  const pool = candidates();
  const r = await rankWithLlm('single_select', pool, {
    apiKey: 'sk-test',
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ranking: [{ index: 1, reason: 'a list' }] }) }] }),
    }),
  });
  assert.ok(r);
  assert.equal(r.length, 1);
  assert.equal(r[0].el.name, 'Orbit List');
  assert.equal(r[0].llmRationale, 'a list');
  assert.equal(r[0].llmRank, 0);
});

test('the API key never appears in the returned evidence', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-ant-secret',
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ranking: [{ index: 0, reason: 'r' }] }) }] }),
    }),
  });
  assert.ok(!JSON.stringify(r).includes('sk-ant-secret'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/rung2.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```typescript
// src/bind/rung2.ts
/**
 * Rung 2: LLM candidate ranking.
 *
 * Invoked only when rung 0 (structural) and rung 1 (probe) both fail to
 * resolve a canonical type to a platform control.
 *
 * HARD WALLS:
 *   - The model sees only what PERCEIVE already observed: role, name, name
 *     source, probe outcome. No HTML, no DOM, no CSS, no ACT handles.
 *   - The model may only REORDER the candidates it was given. It cannot
 *     introduce one. parseResponse rejects any answer that tries.
 *   - The model never has the last word. Its top pick is placed and read back;
 *     if the read-back disagrees, the item escalates with both opinions shown.
 *   - Every failure path returns null, which means "escalate to a human",
 *     never "guess".
 */

import type { CanonicalType } from '../shared/contract';
import type { RankedCandidate } from './ranking';

const MODEL = 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface LlmRankedCandidate extends RankedCandidate {
  llmRationale: string;
  llmRank: number;
}

/** What each canonical type means, so the model reasons about semantics
 *  rather than matching spelling. */
const TYPE_MEANING: Record<CanonicalType, string> = {
  text: 'a single line of free text',
  textarea: 'multiple lines of free text',
  integer: 'a whole number',
  decimal: 'a number with a fractional part',
  date: 'a calendar date',
  time: 'a time of day',
  datetime: 'a date together with a time',
  boolean: 'a single yes/no answer',
  single_select: 'a list of choices from which exactly ONE is chosen',
  multi_select: 'a list of choices from which SEVERAL may be chosen',
  radio: 'a set of mutually exclusive options, all visible at once',
  checkbox: 'a single independent tick box, not a list of choices',
  calculated: 'a read-only value derived from other fields',
};

export function buildRequest(
  canonicalType: CanonicalType,
  candidates: readonly RankedCandidate[],
): Record<string, unknown> {
  const listing = candidates
    .map((c, i) => {
      const probe = c.signals.map((s) => s.detail).join('; ');
      return `${i}. role="${c.el.role}" name="${c.el.name}" nameSource="${c.el.nameSource}"` +
        (probe ? ` observed: ${probe}` : '');
    })
    .join('\n');

  return {
    model: MODEL,
    max_tokens: 1024,
    system:
      'You help an automated agent choose which control in a form-designer ' +
      'element library corresponds to a canonical field type. You are given ' +
      'only what the agent observed through the accessibility tree. ' +
      'Platforms routinely place near-identical names next to each other: a ' +
      'list-of-choices control and a single tick box may sit one row apart ' +
      'with almost the same name, and names may be in any language or ' +
      'invented vocabulary. Reason from role and observed behaviour first, ' +
      'and from names only as weak evidence. ' +
      'Reply with JSON only: {"ranking":[{"index":<number>,"reason":"<short>"}]} ' +
      'ordered best first. Use ONLY the indices given. Do not invent a ' +
      'candidate. If nothing fits, return {"ranking":[]}.',
    messages: [{
      role: 'user',
      content:
        `Canonical type: ${canonicalType} — ${TYPE_MEANING[canonicalType]}\n\n` +
        `Observed candidates:\n${listing}\n\n` +
        `Which candidates could realise this type? Rank them best first.`,
    }],
  };
}

export interface ParsedRanking {
  index: number;
  reason: string;
}

/** Parse the model's reply. Strict: anything that is not a ranking over the
 *  supplied indices throws, and the caller degrades to human escalation. */
export function parseResponse(text: string, candidateCount: number): ParsedRanking[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('rung 2: could not parse a JSON object from the model reply');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('rung 2: could not parse the model reply as JSON');
  }

  const ranking = (parsed as { ranking?: unknown }).ranking;
  if (!Array.isArray(ranking)) {
    throw new Error('rung 2: the model reply has no ranking array');
  }

  return ranking.map((entry) => {
    const index = (entry as { index?: unknown }).index;
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw new Error('rung 2: a ranking entry has no integer index (the model may have invented a candidate)');
    }
    if (index < 0 || index >= candidateCount) {
      throw new Error(`rung 2: ranking index ${index} is out of range 0..${candidateCount - 1}`);
    }
    const reason = (entry as { reason?: unknown }).reason;
    return { index, reason: typeof reason === 'string' ? reason : '' };
  });
}

export interface RankWithLlmDeps {
  apiKey: string | null;
  fetch: typeof globalThis.fetch | ((url: string, init?: unknown) => Promise<any>);
}

/**
 * Reorder candidates using the model. Returns null on every failure path —
 * no key, network error, non-200, unparseable reply, invented candidate —
 * because the correct response to "the model could not help" is to ask a
 * human, never to guess.
 */
export async function rankWithLlm(
  canonicalType: CanonicalType,
  candidates: readonly RankedCandidate[],
  deps: RankWithLlmDeps,
): Promise<LlmRankedCandidate[] | null> {
  if (!deps.apiKey) return null;
  if (candidates.length === 0) return null;

  try {
    const response = await deps.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': deps.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequest(canonicalType, candidates)),
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const text = (payload?.content ?? [])
      .filter((b: { type?: string }) => b?.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('');
    if (!text) return null;

    return parseResponse(text, candidates.length).map((entry, rank) => ({
      ...candidates[entry.index],
      llmRationale: entry.reason,
      llmRank: rank,
    }));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Register in the build and the manifest**

`build.mjs`:
```javascript
    ['src/bind/rung2.ts', 'bind-rung2.mjs'],
```

`manifest.json` — add to `host_permissions`:
```json
"https://api.anthropic.com/*"
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && node --test test/rung2.test.mjs`
Expected: PASS, 13 tests.

- [ ] **Step 6: Wire into the ladder**

In `src/engine/orchestrator.ts`, in `executeFieldAdd`, between the rung 1 probe failing and the escalation:

```typescript
    // Rung 2: the model narrows the field. It never decides — its top pick is
    // placed and read back, and a disagreement escalates showing both views.
    const { anthropicApiKey } = await chrome.storage.local.get('anthropicApiKey');
    const llmRanked = await rankWithLlm(item.canonical_type, rankedPalette, {
      apiKey: anthropicApiKey ?? null,
      fetch: globalThis.fetch,
    });

    if (llmRanked && llmRanked.length > 0) {
      const pick = llmRanked[0];
      const probeResult = await this.probeRunner.placeAndInspect(pick.el.handle);
      // placeAndInspect does not exist yet — add it in Step 6b below.

      if (probeResult.matchedTypes.includes(item.canonical_type)) {
        this.typeBindings[item.canonical_type] = makeTypeBinding(
          item.canonical_type, probeResult.probe, pick.el.name, pick.el.handle,
        );
        this.journal.created(this.sourceOf(item), 'field.add', {
          rung: 2,
          evidence: [
            `rung 2 ranked "${pick.el.name}" first: ${pick.llmRationale}`,
            `probe confirmed: placing it produced role "${probeResult.probe.observedRole}"`,
          ],
          llm_rationale: pick.llmRationale,
          llm_rank: pick.llmRank,
        }, { verdict: 'VERIFIED', reason: 'probe confirmed the rung 2 ranking' });
      } else {
        evidence.push(
          `rung 2 suggested "${pick.el.name}" (${pick.llmRationale}), ` +
          `but placing it produced role "${probeResult.probe.observedRole}", ` +
          `which does not realise "${item.canonical_type}"`,
        );
        // Falls through to escalation below, carrying both opinions.
      }
    }
```

Import `rankWithLlm` from `../bind/rung2`.

- [ ] **Step 6b: Add `placeAndInspect` to ProbeRunner**

`ProbeRunner` currently exposes only `probePalette` and `probeCommitButton`. Rung 2 needs to probe **one** named candidate rather than sweep the whole palette. The logic already exists inside `probePalette`'s loop body — extract it.

In `src/engine/probe-runner.ts`:

```typescript
  /**
   * Place one specific palette candidate and read back what appeared.
   *
   * This is the adjudication step for rung 2: the model names a candidate,
   * this method places it, and the observed role decides whether the model
   * was right. Extracted from probePalette's loop body so both the sweep and
   * the single-candidate case use identical logic.
   */
  async placeAndInspect(handle: string): Promise<{
    probe: ProbeResult;
    matchedTypes: CanonicalType[];
  }> {
    const before = await this.driver.perceive();
    const clickRes = await this.driver.click(handle);
    if (!clickRes.ok) {
      return { probe: { observedRole: 'none', evidence: ['click failed'] }, matchedTypes: [] };
    }
    await this.sleep(250);
    const after = await this.driver.perceiveAfterSettle(200);

    const probe = inspectPlacedControl(before.observation, after.observation);
    if (probe.observedRole === 'none') return { probe, matchedTypes: [] };

    const matchedTypes = CANONICAL_TYPES.filter((t) => classifyTypeFromProbe(t, probe));
    return { probe, matchedTypes };
  }
```

Import `CANONICAL_TYPES` from `../shared/contract`. Then rewrite `probePalette`'s loop body to call `placeAndInspect(btn.handle)` instead of repeating the snapshot/click/inspect sequence, so there is one implementation rather than two.

Check the exact signature of `classifyTypeFromProbe` in `src/bind/rung1.ts:282` before writing the filter — if it returns a list of matching types rather than a boolean per type, call it once and use its result directly.

Also remove the `// placeAndInspect does not exist yet` marker comment added in Step 6.

- [ ] **Step 7: Typecheck, build, full suite, commit**

Run: `npm run typecheck && npm run build && npm test`

```bash
git add src/bind/rung2.ts test/rung2.test.mjs build.mjs manifest.json src/engine/orchestrator.ts
git commit -m "feat(bind): rung 2 LLM candidate ranking, probe-adjudicated

The model reorders candidates PERCEIVE already observed and never sees DOM,
selectors, or ACT handles. Its top pick is placed and read back before
anything is built; disagreement escalates showing both opinions. Every failure
path returns null, meaning 'ask a human', never 'guess'. With no key the
ladder skips this rung entirely and the build still completes."
```

---

# Phase 9 — Evidence

### Task 21: The double-run idempotency test

**Files:**
- Create: `test/idempotency.test.mjs`

- [ ] **Step 1: Write the test**

```javascript
// test/idempotency.test.mjs
//
// Idempotency stated as something checked rather than claimed. Uses the
// reconcile decision table directly: given a platform state produced by a
// first run, a second run must decide 'adopt' for everything and 'build' for
// nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileForm } from '../dist/reconcile.mjs';

const form = {
  form_id: 'v0.f0',
  name: 'Vital Signs',
  fields: [
    { visit_id: 'v0', form_id: 'v0.f0', field_id: 'd0', label: 'Heart Rate',
      canonical_type: 'integer', required: true, range_units: { min: 30, max: 200, units: 'bpm' } },
    { visit_id: 'v0', form_id: 'v0.f0', field_id: 'd1', label: 'Sex',
      canonical_type: 'single_select', required: true,
      coded_pairs: [{ code: 'M', label: 'Male' }, { code: 'F', label: 'Female' }] },
    { visit_id: 'v0', form_id: 'v0.f0', field_id: 'd2', label: 'Comments',
      canonical_type: 'textarea', required: false },
  ],
};

/** What the platform looks like after a correct first run. */
function afterFirstRun() {
  return [
    { label: 'Heart Rate bpm', role: 'spinbutton', required: true, range: { min: 30, max: 200 }, options: [], handle: 'a' },
    { label: 'Sex', role: 'combobox', required: true, options: ['Male', 'Female'], handle: 'b' },
    { label: 'Comments', role: 'textbox', required: false, options: [], handle: 'c' },
  ];
}

test('first run against an empty platform builds everything', () => {
  const r = reconcileForm(form, []);
  assert.equal(r.decisions.filter((d) => d.action === 'build').length, 3);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 0);
});

test('second run builds NOTHING', () => {
  const r = reconcileForm(form, afterFirstRun());
  const builds = r.decisions.filter((d) => d.action === 'build');
  assert.deepEqual(
    builds.map((d) => d.label),
    [],
    'a second run must not create a duplicate of anything the first run built',
  );
});

test('second run adopts everything', () => {
  const r = reconcileForm(form, afterFirstRun());
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 3);
});

test('second run does not depend on a journal: reconcile works from live state alone', () => {
  // No run state passed in anywhere. The decision comes purely from what the
  // platform shows, so a cleared chrome.storage cannot cause duplicates.
  const r = reconcileForm(form, afterFirstRun());
  assert.ok(r.decisions.every((d) => d.action === 'adopt'));
});

test('an interrupted first run resumes without duplicating what it finished', () => {
  const partial = afterFirstRun().slice(0, 2);
  const r = reconcileForm(form, partial);
  assert.deepEqual(r.decisions.filter((d) => d.action === 'build').map((d) => d.label), ['Comments']);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 2);
});

test('a hand-edited field is reported, not silently overwritten', () => {
  const edited = afterFirstRun();
  edited[2].role = 'combobox'; // someone changed Comments to a dropdown
  const r = reconcileForm(form, edited);
  const decision = r.decisions.find((d) => d.label === 'Comments');
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.mismatch, 'role');
});

test('shared form definitions are detected on the second appearance', () => {
  const r = reconcileForm(form, afterFirstRun());
  assert.equal(r.sharedDefinition, true);
});

test('per-visit rebuild is detected when the second appearance is empty', () => {
  const r = reconcileForm(form, []);
  assert.equal(r.sharedDefinition, false);
});
```

- [ ] **Step 2: Run it**

Run: `npm run build && node --test test/idempotency.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```bash
git add test/idempotency.test.mjs
git commit -m "test: double-run idempotency and reuse-detection assertions"
```

---

### Task 22: The scored sweep

Manual, browser-based, and the only evidence that any of this works end to end.

**Files:**
- Create: `generalization/runtime-scramble.js`
- Create: `generalization/RESULTS.md`
- Modify: `generalization/RUNBOOK.md`

- [ ] **Step 1: Write the runtime scrambler**

```javascript
// generalization/runtime-scramble.js
//
// Paste into the DevTools console of any generalization environment before
// running the agent. Renames every visible text node and every aria-label to
// nonsense, leaving structure, roles, and behaviour untouched.
//
// This is the browser-level version of test/scramble.mjs. The unit harness
// proves the binders rank rather than filter; this proves the whole agent
// still drives a real UI when its vocabulary is unrecognisable.
//
// Usage:  __scramble(1234)   then run the extension.

(function () {
  var SYLLABLES = ['ka','zo','mir','tuv','lex','pon','dra','feq','wub','nyx','gel','sot','ryn','quo','vash','ild'];

  window.__scramble = function (seed) {
    var s = (seed >>> 0) || 1;
    function next() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }
    var memo = new Map();
    function scramble(t) {
      var key = t.trim();
      if (!key) return t;
      if (memo.has(key)) return memo.get(key);
      var n = 2 + Math.floor(next() * 2), out = '';
      for (var i = 0; i < n; i++) out += SYLLABLES[Math.floor(next() * SYLLABLES.length)];
      var word = out.charAt(0).toUpperCase() + out.slice(1);
      memo.set(key, word);
      return word;
    }

    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(function (node) { node.nodeValue = scramble(node.nodeValue); });

    document.querySelectorAll('[aria-label],[title],[placeholder]').forEach(function (el) {
      ['aria-label', 'title', 'placeholder'].forEach(function (attr) {
        var v = el.getAttribute(attr);
        if (v) el.setAttribute(attr, scramble(v));
      });
    });

    console.log('[scramble] seed', seed, '—', memo.size, 'distinct strings replaced');
    return memo.size;
  };

  console.log('[scramble] ready. Call __scramble(1234) before starting the agent.');
})();
```

Note: this rewrites the DOM once. Environments that re-render will restore original text — re-run `__scramble(seed)` after navigation, or accept partial coverage and say so in the results.

- [ ] **Step 2: Run the sweep**

Start all four environments:

```bash
cd generalization/env-rosetta        && python3 -m http.server 4091 &
cd generalization/env-wizard         && python3 -m http.server 4092 &
cd generalization/env-hostile-a11y   && python3 -m http.server 4093 &
cd generalization/env-swapped-controls && python3 -m http.server 4094 &
```

And the supplied mock:

```bash
cd "/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/esource-mock"
npm install && npm run dev
```

For each of the five targets, run this matrix and record the score:

| Run | Target | Setup |
|---|---|---|
| 1 | supplied mock | fresh, no key |
| 2 | supplied mock | re-run immediately (idempotency) |
| 3 | env-rosetta | fresh, no key |
| 4 | env-wizard | fresh, with key (icon-only tiles exercise rung 2) |
| 5 | env-hostile-a11y | fresh, with key |
| 6 | env-swapped-controls | fresh, no key |
| 7 | env-rosetta | fresh + `__scramble(4242)` before starting |
| 8 | supplied mock | fresh, storage cleared, then re-run (reconcile-not-journal) |

For each: reset with `?reset=1`, run the agent, export ground truth with `window.__groundTruth()` in the console, and score:

```bash
python3 generalization/score.py \
  --ir "/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/data/abc-101-study.ir.json" \
  --ground-truth /path/to/exported-gt.json \
  --json
```

`__groundTruth()` is a scoring tool used by a human after the run. The agent must never call it — grep the built bundles to confirm:

```bash
grep -c "__groundTruth\|__readState" dist/*.js
```
Expected: `0` in every file.

- [ ] **Step 3: Record results**

Create `generalization/RESULTS.md`:

```markdown
# Scored sweep — <date>

Commit: <sha>

| # | Target | Key | Visits | Forms | Fields | Types | Required | Coded | Ranges | Skip | Overall | Escalations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | supplied mock | no | | | | | | | | | | |
| 2 | supplied mock (re-run) | no | | | | | | | | | | |
| 3 | env-rosetta | no | | | | | | | | | | |
| 4 | env-wizard | yes | | | | | | | | | | |
| 5 | env-hostile-a11y | yes | | | | | | | | | | |
| 6 | env-swapped-controls | no | | | | | | | | | | |
| 7 | env-rosetta + scramble | no | | | | | | | | | | |
| 8 | supplied mock, storage cleared | no | | | | | | | | | | |

## Run 2 — idempotency
Elements created on the second run: <n>. Must be 0.

## Run 8 — reconcile, not journal
Elements created after clearing chrome.storage: <n>. Must be 0.

## Failures and what they exposed

<one paragraph per failure: what broke, what it revealed, what changed>
```

Fill it in honestly. A run that scores badly and is recorded is worth more than a run that is not attempted.

- [ ] **Step 4: Fix what the sweep exposes**

Every fix must be re-checked across all five targets before it is committed. A change that improves one environment and regresses another does not ship — re-run the affected rows and record both numbers.

- [ ] **Step 5: Update the runbook**

Add to `generalization/RUNBOOK.md`: the scramble step, the eight-run matrix, and the `grep -c "__groundTruth"` check.

- [ ] **Step 6: Commit**

```bash
git add generalization/runtime-scramble.js generalization/RESULTS.md generalization/RUNBOOK.md
git commit -m "test: runtime scrambler and scored sweep results across five targets"
```

---

## Done When

- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — all pass, including the scramble harness and the enumeration guard
- [ ] `grep -c "__groundTruth\|__readState" dist/*.js` — zero in every file
- [ ] `generalization/RESULTS.md` filled in for all eight runs
- [ ] Run 2 and Run 8 both created zero elements
- [ ] Journal export produces both a JSONL file and a readable HTML report
- [ ] The build completes with no API key configured
