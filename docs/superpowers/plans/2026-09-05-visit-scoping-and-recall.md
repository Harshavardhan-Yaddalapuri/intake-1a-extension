# Visit Scoping and Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent build all 28 form appearances under the correct 4 visits, and — when it cannot — report the gap loudly instead of writing the forms into whichever visit happens to be on screen.

**Architecture:** The plan compiler is already correct (it emits 4 visits × 7 forms = 28 appearances, 195 fields, with per-appearance ids). The defect is in the runtime: `navigateToVisit` and `navigateToForm` return `void`, so `executePlan` cannot tell that navigation failed and executes the step anyway. We change both to return a boolean, make `executePlan` skip the entire visit/form span on failure, and park every skipped item so the run summary states exactly what was not built. Then we add the orchestrator's first direct tests, using an injected fake driver, so this control flow is covered at all.

**Tech Stack:** TypeScript, esbuild → `dist/*.mjs`, `node --test` with jsdom fixtures.

---

## Background: what actually happened

Ground truth from `data/abc-101-study.ir.json`:

| Visit | Window | Forms |
|---|---|---|
| Screening | -28..-1 | Demographics, Informed Consent, Eligibility Criteria, **Medical History**, Prior and Concomitant Medications, Vital Signs, Local Laboratory - Hematology |
| Baseline (Day 1) | 0..0 | Visit Status, Vital Signs, Physical Examination, 12-Lead ECG, Randomization, Study Drug Administration, Disease Activity Assessment |
| Week 4 | 25..31 | Visit Status, Vital Signs, Study Drug Administration, Disease Activity Assessment, Adverse Events, Concomitant Medications, Local Laboratory - Chemistry |
| End of Treatment (Week 12) | 81..87 | Visit Status, Vital Signs, Physical Examination, 12-Lead ECG, Adverse Events, Disease Activity Assessment, End of Treatment |

Observed live (2026-09-05): **2 visits instead of 4.** Screening held 10 documents, Week 4 held 9.

Diffing the screenshots against the table above:

- Screening = its own 6 (**Medical History missing**) + 4 that belong to Baseline
  (12-Lead ECG, Randomization, Study Drug Administration, Disease Activity Assessment).
- Week 4 = its own 7 + 2 that belong to End of Treatment (12-Lead ECG, End of Treatment).
- "Baseline (Day 1)" and "End of Treatment (Week 12)" were never created.

**These are not duplicate forms.** Every row is distinct within its visit. Nine of the
seventeen form definitions legitimately recur across visits (Vital Signs is at all four),
so a misplaced form *looks* like a duplicate. The actual defect is misplacement plus
non-creation. Fixing "duplicates" would be fixing the wrong thing.

### Root cause (confirmed by reading the code)

`src/engine/orchestrator.ts:1183` and `:1323` both return `Promise<void>`. On failure they
escalate and `return`, and their escalation text promises:

> "Nothing was built for this visit rather than building it into whichever visit was already open."
> "Its fields are NOT being built to avoid writing them into another document."

The caller at `src/engine/orchestrator.ts:562-577` does not honour that:

```ts
if (item.visit_id !== prevVisitId) {
  await this.navigateToVisit(item.visit_id);   // result discarded
  prevVisitId = item.visit_id;                 // set unconditionally
  prevFormId = '';
}
if (item.form_id !== prevFormId) {
  await this.navigateToForm(item.visit_id, item.form_id);  // result discarded
  prevFormId = item.form_id;
}
await this.executeStep(item, itemKey, i);      // runs regardless
```

The comments describe fail-closed behaviour; the control flow is fail-open. Any navigation
failure silently redirects that visit's entire remaining output into the previously opened
visit. This is exactly the observed corruption.

### Why the test suite did not catch it

271 tests pass. `src/engine/orchestrator.ts` has **no direct test** — nothing in `test/`
imports `Orchestrator`. `test/visit-navigation.test.mjs` covers `rankAscendCandidates` and
`atVisitList` as pure functions, which are fine; the bug is in the control flow that
consumes them. Tasks 1–3 close that gap.

### Ruled out by inspection (do not spend time here)

- **`form_id` collision across visits.** Ids are `v{vi}.f{fi}` (`src/plan/ir.ts:204`), unique
  per appearance, and `idempotencyKey` includes `visit_id` (`src/shared/contract.ts:348`).
  The `currentFormId === formId` guard is therefore safe.
- **`atVisitList` false-positive from the breadcrumb.** The mock renders the breadcrumb as
  `<p class="breadcrumb">Study Plan / {visit}</p>` (`esource-mock/src/ui/render.ts:217`),
  which is not actionable, so `enumerateActionable` never sees it.
- **The plan compiler.** Verified to emit 4/28/195 correctly.

### Still unknown

Why visit creation succeeded for "Screening" and "Week 4" but not for "Baseline (Day 1)" and
"End of Treatment (Week 12)". Task 6 reproduces it under instrumentation rather than guessing.
Note both failing names contain parentheses and both succeeding ones do not — a hypothesis to
test in Task 6, not an assumption to code against.

---

## File Structure

- `src/engine/orchestrator.ts` — change two method signatures, the call site, and add a
  span-skip helper. No new file; this is a control-flow correction in place.
- `test/orchestrator-harness.mjs` — **new.** Fake driver + fake storage adapter, so the
  orchestrator can be driven headlessly.
- `test/visit-scoping.test.mjs` — **new.** Regression tests for fail-closed navigation.
- `test/plan-coverage.test.mjs` — **new.** Asserts the compiled plan covers 4/28/195 and that
  each form appearance is scoped to exactly one visit.
- `build.mjs` — add `src/engine/orchestrator.ts` to the node-module build list if absent.

---

## Task 1: Make the orchestrator's collaborators injectable

The constructor hardcodes `chromeStorageAdapter('local')` and `new TabDriver(tabId)`
(`src/engine/orchestrator.ts:174-183`), so it cannot be instantiated outside Chrome. Add an
optional deps parameter. Production callers are unchanged.

**Files:**
- Modify: `src/engine/orchestrator.ts:174-183`
- Test: none yet (Task 2 consumes this)

- [ ] **Step 1: Add the optional deps parameter**

In `src/engine/orchestrator.ts`, replace the constructor signature and the two hardcoded
assignments:

```ts
export interface OrchestratorDeps {
  adapter?: StorageAdapter;
  driver?: TabDriver;
}

// ... inside class Orchestrator:
  constructor(
    irJson: string,
    tabId: number,
    callbacks: OrchestratorCallbacks,
    deps: OrchestratorDeps = {},
  ) {
    this.ir = parseIRJson(irJson);
    this.plan = compilePlan(this.ir);
    this.linearItems = linearize(this.plan);
    this.adapter = deps.adapter ?? chromeStorageAdapter('local');
    this.driver = deps.driver ?? new TabDriver(tabId);
    this.probeRunner = new ProbeRunner(this.driver);
    // ... rest unchanged
```

- [ ] **Step 2: Verify nothing else broke**

Run: `npm run typecheck && npm test`
Expected: no type errors; `pass 271 / fail 0`.

- [ ] **Step 3: Ensure the orchestrator is built as a node module**

Check `build.mjs` for an entry producing `dist/orchestrator.mjs`. `dist/orchestrator.mjs`
already exists, so it is present — confirm with:

Run: `npm run build && node -e "import('./dist/orchestrator.mjs').then(m => console.log(Object.keys(m)))"`
Expected: output includes `Orchestrator`.

- [ ] **Step 4: Commit**

```bash
git add src/engine/orchestrator.ts
git commit -m "refactor(engine): allow the orchestrator's driver and storage to be injected

The navigation control flow has never had a direct test because the
constructor reaches for Chrome APIs. Production callers are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 2: Build the headless orchestrator harness

A fake driver that serves scripted observations and records clicks, plus an in-memory
storage adapter.

**Files:**
- Create: `test/orchestrator-harness.mjs`

- [ ] **Step 1: Write the harness**

```js
// test/orchestrator-harness.mjs
//
// A headless stand-in for TabDriver and chromeStorageAdapter, so the
// orchestrator's navigation control flow can be driven without Chrome.
//
// The fake driver models the eSource as a tiny state machine: a visit list, a
// per-visit document list, and a form designer. `failVisitCreate` names the
// visits whose creation silently does nothing, which is the live failure we
// are reproducing.

import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';

// StorageAdapter is exactly { get, set } — see src/engine/state-machine.ts:180.
export function inMemoryAdapter() {
  const store = new Map();
  return {
    async get(key) { return store.get(key); },
    async set(key, value) { store.set(key, value); },
  };
}

const dom = (body) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`).window.document;

const TOP_NAV = `<nav><button>Patients</button><button>Calendar</button>
  <button>Study Plan</button><button>Reports</button></nav>`;

export class FakeEsource {
  /**
   * @param {{failVisitCreate?: string[]}} opts
   */
  constructor(opts = {}) {
    this.failVisitCreate = new Set(opts.failVisitCreate ?? []);
    /** @type {Map<string, string[]>} visit name -> document names */
    this.visits = new Map();
    /** @type {{kind: 'plan'} | {kind: 'visit', name: string} | {kind: 'builder', visit: string, form: string}} */
    this.screen = { kind: 'plan' };
    this.visitFormOpen = false;
    this.formFormOpen = false;
    this.draft = { name: '', start: '', end: '' };
    this.clicks = [];
  }

  /** Every document this platform holds, as visit -> [doc names]. */
  snapshot() {
    return Object.fromEntries([...this.visits].map(([v, d]) => [v, [...d]]));
  }

  html() {
    if (this.screen.kind === 'plan') {
      const rows = [...this.visits.keys()]
        .map((v) => `<tr><td><button class="link">${v}</button></td></tr>`)
        .join('');
      const form = this.visitFormOpen
        ? `<div class="card"><h3>New Visit</h3>
             <label>Visit Name<input type="text" id="v-name"></label>
             <label>Window Start (day)<input type="text" id="v-start"></label>
             <label>Window End (day)<input type="text" id="v-end"></label>
             <button>Save Visit</button><button>Cancel</button></div>`
        : '';
      return `${TOP_NAV}<h2>Visit Schedule</h2><table><tbody>${rows}</tbody></table>
              <button>+ Add Visit</button>${form}`;
    }
    if (this.screen.kind === 'visit') {
      const docs = this.visits.get(this.screen.name) ?? [];
      const rows = docs
        .map(
          (d) =>
            `<tr><td class="doc-name">${d}</td>` +
            `<td><button>✎ Edit</button><button>Activate</button><button>Delete</button></td></tr>`,
        )
        .join('');
      const form = this.formFormOpen
        ? `<div class="card"><h3>New Source Document</h3>
             <label>Document Name<input type="text" id="f-name"></label>
             <button>Create</button><button>Cancel</button></div>`
        : '';
      return `${TOP_NAV}<p class="breadcrumb">Study Plan / ${this.screen.name}</p>
              <button>← Visit Schedule</button>
              <h2>${this.screen.name} — Source Documents</h2>
              <table><tbody>${rows}</tbody></table>
              <button>+ New Source Document</button>${form}`;
    }
    return `${TOP_NAV}
      <header><button>← ${this.screen.visit}</button>
        <span class="builder-title">${this.screen.form}</span>
        <button>Save</button><button>Activate</button></header>
      <aside><button>Checkbox</button><button>Date</button><button>Dropdown</button>
        <button>Radio Buttons</button><button>Single Line Textbox</button></aside>
      <main><button>+ Page</button></main>`;
  }

  observation() {
    return observe(dom(this.html()));
  }

  /** Resolve a handle back to its accessible name, then act on it. */
  click(name) {
    this.clicks.push(name);
    const n = name.trim();
    if (n === '+ Add Visit') { this.visitFormOpen = true; return; }
    if (n === 'Cancel') { this.visitFormOpen = false; this.formFormOpen = false; return; }
    if (n === 'Save Visit') {
      const wanted = this.draft.name.trim();
      this.visitFormOpen = false;
      // The live failure: creation appears to succeed and produces nothing.
      if (wanted && !this.failVisitCreate.has(wanted) && !this.visits.has(wanted)) {
        this.visits.set(wanted, []);
      }
      this.draft = { name: '', start: '', end: '' };
      return;
    }
    if (n === '+ New Source Document') { this.formFormOpen = true; return; }
    if (n === 'Create') {
      const wanted = this.draft.name.trim();
      this.formFormOpen = false;
      if (this.screen.kind === 'visit' && wanted) {
        const docs = this.visits.get(this.screen.name) ?? [];
        if (!docs.includes(wanted)) docs.push(wanted);
        this.visits.set(this.screen.name, docs);
      }
      this.draft = { name: '', start: '', end: '' };
      return;
    }
    if (n === '← Visit Schedule') { this.screen = { kind: 'plan' }; return; }
    if (n.startsWith('← ')) {
      this.screen = { kind: 'visit', name: n.slice(2).trim() };
      return;
    }
    if (this.screen.kind === 'plan' && this.visits.has(n)) {
      this.screen = { kind: 'visit', name: n };
      return;
    }
  }

  setValue(name, value) {
    // The harness keys the draft off the input's label, as a real platform would.
    if (/name/i.test(name)) this.draft.name = value;
    else if (/start/i.test(name)) this.draft.start = value;
    else if (/end/i.test(name)) this.draft.end = value;
  }
}

/** A TabDriver-shaped facade over FakeEsource. Mirrors the public surface at
 *  src/engine/tab-driver.ts:45-104. */
export function fakeDriver(app) {
  const nameOf = (handle) => {
    const el = [...app.observation().elements].find((e) => e.handle === handle);
    return el ? el.name : '';
  };
  return {
    async perceive() { return { observation: app.observation() }; },
    async perceiveAfterSettle() { return { observation: app.observation() }; },
    async act() { return { ok: true }; },
    async click(handle) { app.click(nameOf(handle)); return { ok: true }; },
    async setValue(handle, value) { app.setValue(nameOf(handle), value); return { ok: true }; },
    async check() { return { ok: true }; },
    async selectOption() { return { ok: true }; },
    getTabId() { return 0; },
  };
}
```

- [ ] **Step 2: Smoke-test the harness itself**

Run:
```bash
node -e "
import('./test/orchestrator-harness.mjs').then(({FakeEsource}) => {
  const a = new FakeEsource({failVisitCreate: ['Baseline (Day 1)']});
  a.click('+ Add Visit'); a.setValue('Visit Name','Screening'); a.click('Save Visit');
  a.click('+ Add Visit'); a.setValue('Visit Name','Baseline (Day 1)'); a.click('Save Visit');
  console.log(JSON.stringify(a.snapshot()));
});"
```
Expected: `{"Screening":[]}` — Baseline silently absent, reproducing the live failure.

- [ ] **Step 3: Commit**

```bash
git add test/orchestrator-harness.mjs
git commit -m "test(engine): headless eSource harness for orchestrator control flow

Models a visit list, per-visit document list and designer, and can be told
to make a named visit's creation silently do nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 3: Failing test — a visit that cannot be created must not leak into another

**Files:**
- Create: `test/visit-scoping.test.mjs`

- [ ] **Step 1: Write the failing test**

Note on approach: this drives the private `executePlan` directly rather than `execute()`.
`execute()` runs pre-flight binding and probe discovery, which the fake cannot satisfy and
which is not what we are testing. TypeScript's `private` is compile-time only, so bracket
access works at runtime from JS. We seed the two bindings the navigation path reads:
`visit.create` (whose absence makes `createVisit` return early) and `ctx.commit`.

```js
// test/visit-scoping.test.mjs
//
// Live regression (2026-09-05): only "Screening" and "Week 4" were created;
// four of Baseline's forms were written into Screening and two of End of
// Treatment's into Week 4. navigateToVisit escalated and returned void, and
// executePlan executed the step anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Orchestrator } from '../dist/orchestrator.mjs';
import { FakeEsource, fakeDriver, inMemoryAdapter } from './orchestrator-harness.mjs';

const IR = readFileSync(
  new URL('./fixtures/abc-101-study.ir.json', import.meta.url),
  'utf8',
);

const binding = (op) => ({
  op,
  version: 1,
  recipe: [{ kind: 'click', evidence_name: '' }],
  post_condition: { kind: 'none' },
  evidence: ['test-seeded'],
  rung: 0,
  status: 'bound',
  confidence: 'structural',
});

async function runPlan(app) {
  const escalations = [];
  const orch = new Orchestrator(IR, 0, {
    onPreflightReport() {},
    onProgress() {},
    onEscalation(item) { escalations.push(item); },
    onComplete() {},
  }, { adapter: inMemoryAdapter(), driver: fakeDriver(app) });

  orch['bindings'] = { 'visit.create': binding('visit.create'), 'ctx.commit': binding('ctx.commit') };
  await orch['executePlan']();
  return { escalations, parked: orch.getParked() };
}

test('a visit that cannot be created does not donate its forms to another visit', async () => {
  const app = new FakeEsource({ failVisitCreate: ['Baseline (Day 1)'] });
  await runPlan(app);

  const built = app.snapshot();

  // Forms that exist ONLY in Baseline (Day 1) must appear nowhere at all.
  for (const exclusive of ['Randomization', 'Physical Examination']) {
    for (const [visitName, docs] of Object.entries(built)) {
      assert.ok(
        !docs.includes(exclusive),
        `"${exclusive}" belongs only to Baseline (Day 1) but was built into "${visitName}"`,
      );
    }
  }

  // Screening must hold exactly its own seven — no more, no fewer.
  assert.deepEqual(
    [...(built['Screening'] ?? [])].sort(),
    [
      'Demographics',
      'Eligibility Criteria',
      'Informed Consent',
      'Local Laboratory - Hematology',
      'Medical History',
      'Prior and Concomitant Medications',
      'Vital Signs',
    ],
    'Screening must hold exactly its own seven forms',
  );
});

test('an unreachable visit is parked, not silently dropped', async () => {
  const app = new FakeEsource({ failVisitCreate: ['Baseline (Day 1)'] });
  const { parked } = await runPlan(app);
  const names = parked.map((p) => `${p.visitName} / ${p.formName}`);
  assert.ok(
    names.some((n) => n.startsWith('Baseline (Day 1)')),
    `Baseline's unbuilt forms must be parked for review; parked: ${names.join(', ')}`,
  );
});

test('the other three visits are still built when one fails', async () => {
  const app = new FakeEsource({ failVisitCreate: ['Baseline (Day 1)'] });
  await runPlan(app);
  const built = app.snapshot();
  assert.ok(built['Week 4'], 'Week 4 must still be created after Baseline fails');
  assert.ok(
    built['End of Treatment (Week 12)'],
    'End of Treatment must still be created after Baseline fails',
  );
});
```

- [ ] **Step 2: Confirm the seeded binding shape matches the real type**

`BindingRecord` is defined at `src/shared/contract.ts:300`. If `rung`, `status` or
`confidence` reject the literals above, read the type and use its actual members — the test
must not invent a shape the production type does not have.

- [ ] **Step 3: Copy the IR into the test fixtures**

```bash
mkdir -p test/fixtures
cp "/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/data/abc-101-study.ir.json" \
   test/fixtures/abc-101-study.ir.json
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npm run build && node --test test/visit-scoping.test.mjs`
Expected: FAIL — `"Randomization" belongs to Baseline (Day 1) but was built into "Screening"`.

This failure is the whole bug, reproduced headlessly. Do not proceed until you see it.

- [ ] **Step 5: Commit the failing test**

```bash
git add test/visit-scoping.test.mjs test/fixtures/abc-101-study.ir.json
git commit -m "test(engine): reproduce cross-visit form leakage headlessly

Fails today: Baseline's forms are built into Screening when Baseline
cannot be created.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 4: Make navigation fail closed

**Files:**
- Modify: `src/engine/orchestrator.ts:1183` (`navigateToVisit`)
- Modify: `src/engine/orchestrator.ts:1323` (`navigateToForm`)
- Modify: `src/engine/orchestrator.ts:528-586` (`executePlan`)

- [ ] **Step 1: Return a boolean from `navigateToVisit`**

Change the signature and all four exit points:

```ts
  private async navigateToVisit(visitId: string): Promise<boolean> {
    if (this.currentVisitId === visitId) return true;

    const visit = this.irVisitMap.get(visitId);
    if (!visit) return false;
```

The `if (!reached)` escalation block keeps its body but ends `return false;` instead of
`return;`. The `if (!opened)` block likewise ends `return false;`. The method's final lines
become:

```ts
    this.currentVisitId = visitId;
    this.currentFormId = null;
    return true;
  }
```

- [ ] **Step 2: Return a boolean from `navigateToForm`**

```ts
  private async navigateToForm(visitId: string, formId: string): Promise<boolean> {
    if (this.currentFormId === formId) return true;

    const form = this.irFormMap.get(formId);
    if (!form) return false;
```

The `if (!opened)` escalation block ends `return false;`. After
`this.currentFormId = formId;` and the reconcile work that follows it, the method ends
`return true;`.

- [ ] **Step 3: Add the span-skip helper**

Insert next to `escalateItem` in `src/engine/orchestrator.ts`:

```ts
  /**
   * Abandon every remaining step in a span the agent could not reach, and say
   * so. Missing forms are the most heavily penalized failure in this domain,
   * so they are parked for review rather than dropped silently — but building
   * them into the wrong visit is worse than not building them, which is why
   * this exists at all.
   *
   * Returns the index of the last item consumed, so the caller can advance.
   */
  private async abandonSpan(
    from: number,
    matches: (item: LinearItem) => boolean,
    reason: string,
  ): Promise<number> {
    let i = from;
    const forms = new Set<string>();
    for (; i < this.linearItems.length && matches(this.linearItems[i]); i += 1) {
      const item = this.linearItems[i];
      const key = idempotencyKey(item.visit_id, item.form_id, item.field_id);
      const record = this.runState.items[key];
      if (record && record.state !== 'escalated') {
        await applyTransition(this.adapter, this.runState, key, 'escalate');
      }
      forms.add(`${item.visit_name} / ${item.form_name}`);
      this.runState.cursor = i + 1;
    }
    await saveRunState(this.adapter, this.runState);

    for (const label of forms) {
      this.parked.push({
        key: `unbuilt:${label}`,
        fieldLabel: '(whole form)',
        canonicalType: 'text',
        formName: label.split(' / ')[1] ?? label,
        visitName: label.split(' / ')[0] ?? '',
        reason: `${reason} Nothing was built for "${label}".`,
        evidence: [],
        phase: 'acting',
        blocking: false,
      });
    }
    return i - 1;
  }
```

- [ ] **Step 4: Honour the return values in `executePlan`**

Replace the navigation block at `src/engine/orchestrator.ts:562-577` with:

```ts
      // Navigate to the correct visit if context changed. A visit we cannot
      // open is a visit whose forms we do not build: writing them into
      // whichever visit is on screen is worse than leaving them out, and it is
      // invisible until data collection has started.
      if (item.visit_id !== prevVisitId) {
        const arrived = await this.navigateToVisit(item.visit_id);
        if (!arrived) {
          i = await this.abandonSpan(
            i,
            (it) => it.visit_id === item.visit_id,
            `Could not open visit "${item.visit_name}".`,
          );
          prevVisitId = '';
          prevFormId = '';
          this.emitProgress(i);
          continue;
        }
        prevVisitId = item.visit_id;
        prevFormId = '';
      }

      // Navigate to the correct form if context changed.
      if (item.form_id !== prevFormId) {
        const opened = await this.navigateToForm(item.visit_id, item.form_id);
        if (!opened) {
          i = await this.abandonSpan(
            i,
            (it) => it.form_id === item.form_id,
            `Could not open form "${item.form_name}" under "${item.visit_name}".`,
          );
          prevFormId = '';
          this.emitProgress(i);
          continue;
        }
        prevFormId = item.form_id;
      }
```

- [ ] **Step 5: Run the regression test**

Run: `npm run build && node --test test/visit-scoping.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: `fail 0`. If a test now fails because it asserted the old fail-open behaviour, read
it carefully — it was asserting the bug, and should be updated to expect the skip.

- [ ] **Step 7: Commit**

```bash
git add src/engine/orchestrator.ts
git commit -m "fix(engine): a visit or form we cannot open is one we do not build

navigateToVisit and navigateToForm escalated and returned void, promising
in their escalation text that nothing would be built — while executePlan
discarded the result and executed the step anyway. A single failed visit
navigation redirected that visit's whole output into the previously opened
visit: live, four of Baseline's forms landed in Screening and two of End of
Treatment's in Week 4, and neither visit was ever created.

Both now return a boolean, and executePlan abandons the whole span and
parks it for review.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 5: Assert the plan's coverage never silently shrinks

Cheap, fast, and would have flagged any compiler-side regression immediately.

**Files:**
- Create: `test/plan-coverage.test.mjs`

- [ ] **Step 1: Write the test**

```js
// test/plan-coverage.test.mjs
//
// The input is fixed and known: 4 visits, 7 forms each, 195 fields, 17
// distinct form definitions across 28 appearances. Anything else means the
// compiler dropped work on the floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIRJson } from '../dist/plan-ir.mjs';
import { compilePlan, linearize } from '../dist/plan-compiler.mjs';

const ir = parseIRJson(
  readFileSync(new URL('./fixtures/abc-101-study.ir.json', import.meta.url), 'utf8'),
);
const plan = compilePlan(ir);

test('the plan covers every visit, form appearance and field', () => {
  assert.equal(plan.visits.length, 4, 'visits');
  assert.equal(plan.form_appearances, 28, 'form appearances');
  assert.equal(plan.field_nodes, 195, 'fields');
  assert.equal(plan.errors.length, 0, `plan errors: ${JSON.stringify(plan.errors)}`);
});

test('every form appearance is scoped to exactly one visit', () => {
  const seen = new Map();
  for (const visit of plan.visits) {
    for (const form of visit.forms) {
      assert.ok(!seen.has(form.form_id), `form_id ${form.form_id} appears twice`);
      seen.set(form.form_id, visit.visit_id);
      assert.equal(form.visit_id, visit.visit_id, `${form.name} carries the wrong visit_id`);
    }
  }
  assert.equal(seen.size, 28);
});

test('recurring form definitions get a distinct id per visit', () => {
  const vitalSigns = [];
  for (const visit of plan.visits) {
    for (const form of visit.forms) {
      if (form.name === 'Vital Signs') vitalSigns.push(form.form_id);
    }
  }
  assert.equal(vitalSigns.length, 4, 'Vital Signs is at all four visits');
  assert.equal(new Set(vitalSigns).size, 4, 'each appearance needs its own id');
});

test('every linear item names the visit and form it belongs to', () => {
  const items = linearize(plan);
  const byVisit = new Map();
  for (const it of items) {
    assert.ok(it.visit_name, 'missing visit_name');
    assert.ok(it.form_name, 'missing form_name');
    assert.ok(it.form_id.startsWith(`${it.visit_id}.`), `${it.form_id} is not under ${it.visit_id}`);
    byVisit.set(it.visit_id, (byVisit.get(it.visit_id) ?? 0) + 1);
  }
  assert.equal(byVisit.size, 4, 'work must be spread across all four visits');
});
```

- [ ] **Step 2: Run it**

Run: `npm run build && node --test test/plan-coverage.test.mjs`
Expected: PASS (the compiler is already correct; this locks it in).

- [ ] **Step 3: Commit**

```bash
git add test/plan-coverage.test.mjs
git commit -m "test(plan): lock the input's 4/28/195 coverage and per-visit form scoping

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 6: Reproduce the visit-creation failure live and find its cause

Tasks 1–5 stop the corruption. They do not explain why "Baseline (Day 1)" and "End of
Treatment (Week 12)" were never created. With fail-closed navigation the run now parks those
visits loudly instead of hiding them, which makes this reproducible.

**Files:**
- Modify: none yet — this task produces evidence, not code.

- [ ] **Step 1: Reset the mock and start it**

```bash
cd "/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/esource-mock"
npm run dev
```

In the mock's DevTools console: `__resetState()`.

- [ ] **Step 2: Load the rebuilt extension and run it**

```bash
cd /Users/harshavardhan/Projects/intake-1a-extension && npm run build
```

Reload the unpacked extension, open the side panel, load
`data/abc-101-study.ir.json`, and start the run.

- [ ] **Step 3: Capture the journal**

When the run reaches the first parked "Could not open visit" escalation, export the journal
from the side panel (the export control added in `376e29b`). Save it to
`docs/superpowers/notes/2026-09-05-visit-create-journal.json`.

- [ ] **Step 4: Answer these three questions from the journal, in writing**

Write the answers into `docs/superpowers/notes/2026-09-05-visit-create-findings.md`:

1. On the attempt for "Baseline (Day 1)", did `createVisit` reach the visit list
   (`atVisitList` true) before trying to create?
2. Which control did `rankCandidates(addPool, {hint:'visit_create'})` select, and which did
   `pickDialogCommit` select? Were they "+ Add Visit" and "Save Visit"?
3. What value was written into the name input — the full `Baseline (Day 1)`, or something
   truncated or empty?

The parenthesised-name hypothesis is worth testing here, but the journal decides it. Do not
write a fix before this file exists.

- [ ] **Step 5: Commit the evidence**

```bash
git add docs/superpowers/notes/
git commit -m "docs: journal evidence for the visit-creation failure

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 7: Fix the visit-creation failure

Scoped by Task 6's findings. Write the test first, driving `FakeEsource` to reproduce the
specific mechanism the journal identified — then fix it. Whatever the cause, the fix must not
introduce a platform-specific string: the constraint in `ASSIGNMENT.md` rules out any
selector, id, button label or library entry name hardcoded to this mock.

**Files:**
- Modify: `src/engine/orchestrator.ts` (`createVisit`) and/or `src/bind/ranking.ts`
- Modify: `test/visit-scoping.test.mjs`

- [ ] **Step 1: Extend the harness to model the mechanism found**

Add the failing behaviour to `FakeEsource` as a constructor option, the way
`failVisitCreate` already is, so the test states the mechanism rather than the symptom.

- [ ] **Step 2: Write the failing test, run it, watch it fail**

Run: `npm run build && node --test test/visit-scoping.test.mjs`
Expected: FAIL, for the reason Task 6 identified.

- [ ] **Step 3: Fix, then re-run**

Run: `npm run build && node --test test/visit-scoping.test.mjs`
Expected: PASS.

- [ ] **Step 4: Full suite, then commit**

Run: `npm run typecheck && npm test`
Expected: `fail 0`.

```bash
git add -A
git commit -m "fix(engine): create every visit in the schedule, not just the first of each shape

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Task 8: Full live run and honest scoring

**Files:**
- Create: `docs/superpowers/notes/2026-09-05-run-result.md`

- [ ] **Step 1: Reset and run end to end**

`__resetState()` in the mock, then a full run from the side panel.

- [ ] **Step 2: Score it**

In the mock's DevTools console, `copy(__exportState())`, save to
`/tmp/claude-501/-Users-harshavardhan-Projects-intake-1a-extension/7948cb2a-8315-42f3-a119-451f9409b08d/scratchpad/built.json`,
then diff against the input:

```bash
node -e "
const fs=require('fs');
const want=JSON.parse(fs.readFileSync('/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/data/abc-101-study.ir.json','utf8'));
const got=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const gv=new Map((got.visits||[]).map(v=>[v.name,v]));
let forms=0,missing=[];
for(const v of want.visits){
  const g=gv.get(v.name);
  for(const f of v.forms){
    const hit=g&&(g.forms||[]).find(x=>x.name===f.name);
    if(hit) forms++; else missing.push(v.name+' / '+f.name);
  }
}
console.log('visits: '+gv.size+'/4');
console.log('form appearances: '+forms+'/28');
if(missing.length) console.log('MISSING:\n  '+missing.join('\n  '));
" /tmp/claude-501/-Users-harshavardhan-Projects-intake-1a-extension/7948cb2a-8315-42f3-a119-451f9409b08d/scratchpad/built.json
```

- [ ] **Step 3: Confirm no form landed under the wrong visit**

The script above reports recall. Also check precision — extra documents in a visit:

```bash
node -e "
const fs=require('fs');
const want=JSON.parse(fs.readFileSync('/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/data/abc-101-study.ir.json','utf8'));
const got=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const wv=new Map(want.visits.map(v=>[v.name,new Set(v.forms.map(f=>f.name))]));
for(const v of (got.visits||[])){
  const w=wv.get(v.name);
  if(!w){console.log('UNEXPECTED VISIT: '+v.name);continue;}
  for(const f of (v.forms||[])) if(!w.has(f.name)) console.log('MISPLACED: '+f.name+' under '+v.name);
}
" /tmp/claude-501/-Users-harshavardhan-Projects-intake-1a-extension/7948cb2a-8315-42f3-a119-451f9409b08d/scratchpad/built.json
```

Expected: no `MISPLACED` lines. That is the specific defect this plan exists to kill.

- [ ] **Step 4: Record the result honestly**

Write `docs/superpowers/notes/2026-09-05-run-result.md` with the counts, including what is
still missing. `ASSIGNMENT.md` is explicit that a lower honest number beats a polished one.

- [ ] **Step 5: Re-run against the scrambled environments**

```bash
cd /Users/harshavardhan/Projects/intake-1a-extension && npm test -- test/generalization-scramble.test.mjs
```

Then run the extension unchanged against `generalization/env-wizard` and
`generalization/env-swapped-controls` per `generalization/RUNBOOK.md`, and add those numbers
to the same file. The visit-scoping fix must hold on a platform it has not seen.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/
git commit -m "docs: live run result after the visit-scoping fix

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JaohGM6wzCE533q8EMtby8"
```

---

## Out of scope for this plan

Field-level correctness (coded value pairs, range/unit retention across type changes, the
thirteen skip-logic rules, repeating flags) is a separate concern with its own failure modes.
It is only worth measuring once forms land under the right visits — until then, per-field
scores are computed against documents that are in the wrong place. Task 8's output is the
input to that plan.
