# eSource Build Agent — S7 Design

Date: 2026-09-04
Status: Approved, ready for implementation planning
Scope: Close the remaining gaps in the S1–S6 implementation. The existing
architecture (Platform Contract + graded binding ladder + deterministic plan
compiler + module walls) is retained without change.

---

## 1. Context

The extension drives an unknown eSource form designer to build a clinical
study described by an input file: 4 visits, 28 form appearances over 17
distinct form definitions, 195 fields, 13 skip-logic rules. It must work on an
eSource mock nobody on the implementing side has seen, with a human gate for
anything it cannot resolve confidently.

S1–S6 delivered PERCEIVE (accessibility-tree observation), BIND (structural
and probe rungs), ACT (DOM primitives), VERIFY (read-back comparator), the IR
parser and plan compiler, the orchestrator and state machine, the side panel
human gate, and four hostile generalization environments. 100 unit tests pass.

Five gaps were identified and confirmed as open:

1. Rung 2 (LLM disambiguation) — absent entirely.
2. Traceability — a type name in `messages.ts`, no emitted artifact.
3. Idempotency — key derivation and a persisted journal exist, but no
   reconciliation against live platform state.
4. Form reuse — the compiler declares a `probe-first` policy that the
   orchestrator does not implement.
5. Integration evidence — no scored end-to-end run against any environment.

Reading the code to design against those five surfaced two further findings
that take priority over all of them. They are stated first because they change
the work order.

---

## 2. Finding A — lexical gates in BIND

### The problem

Approximately thirty sites in `src/bind/rung0.ts`, `src/bind/rung1.ts`, and
`src/engine/probe-runner.ts` use English substring tests to decide which
elements are eligible for consideration. Representative examples:

```
rung0.ts:742        name.includes('save') || name.includes('commit')
                    || name.includes('persist')
rung0.ts:375        name.includes('element') || name.includes('library')
                    || name.includes('palette') || name.includes('control')
rung0.ts:268        name.includes('new') && (name.includes('form')
                    || name.includes('document') || name.includes('source'))
rung0.ts:813        name.includes('cancel') || name.includes('discard')
                    || name.includes('close') || name.includes('back')
rung1.ts:144        n.includes('minimum') || n.includes('maximum')
                    || n.includes('range')
probe-runner.ts:142 n.includes('save') || n.includes('freeze')
                    || n.includes('commit') || n.includes('persist')
                    || n.includes('bank')
probe-runner.ts:71  lower.includes('preview') || lower.includes('save')
                    || lower.includes('freeze') || ...   (palette exclusions)
```

The final example is diagnostic. `freeze` and `bank` are the invented
vocabulary of `generalization/env-rosetta`, a fixture written by this project.
Their presence in the matcher shows the loop that produced the current state:
write a hostile fixture, observe the agent fail on it, add the fixture's
vocabulary to the candidate filter, observe the test pass. The test goes green
without the agent becoming more general.

On an unseen platform whose commit control is named something not on the list
— "Publish", "Lock Record", "Apply Changes", "Submit for Review" — the
candidate set is empty, `ctx.commit` does not bind, and no form persists. The
failure is silent: the orchestrator has no candidate to probe, so it never
learns that saving did not happen.

The assignment states that any button label hardcoded to the supplied mock is
a failed submission. These are English lexical priors rather than DOM selectors
tied to the given mock, which is a materially weaker form of the same mistake,
but they occupy the wrong position in the decision: they gate rather than rank.

### The principle

> **Candidate enumeration is structural and exhaustive. Lexical priors may only
> rank candidates, never exclude them. The probe adjudicates the ranking.**

A word may move a candidate up the trial order. A word may never keep a
candidate off the list. A wrong hint costs additional probe attempts; a wrong
gate costs the run.

### The restructuring

Every lexical gate becomes a scoring term over a structurally enumerated
candidate set. The general shape:

1. **Enumerate structurally.** All actionable elements in the relevant scope,
   selected by role and by position in the observed tree, never by name.
2. **Rank by accumulated weak signals.** Lexical prior is one signal among
   several, and never decisive on its own. Other signals: proximity to the
   region that changed, whether the platform marks the control as primary or
   default, containment within a toolbar or action bar, whether the element
   appeared as part of the same diff as the editing surface.
3. **Probe in rank order** until one candidate demonstrably produces the
   required post-condition.
4. **Cache the winner** as a binding for the remainder of the run, keyed by
   platform origin.

Sites requiring this treatment: commit-control discovery, palette discovery
and its exclusion list, visit creation, visit navigation, form creation, form
opening, coded-value sub-controls, range sub-controls, and the discard/cancel
control.

`probeCommitButton`'s name filter and `probePalette`'s exclusion list are
deleted rather than extended. Extending them is how the current state arose.

Ranking heuristics that remain lexical must be expressed as data, in one
place, so they are visibly hints rather than logic — a single weights table
that a reader can inspect and that a test can assert is never consulted during
enumeration.

---

## 3. Finding B — two scored criteria have no read-back

`src/perceive/core.ts` does not read the required state or any range
attributes. `ElementState` carries `checked`, `disabled`, `expanded`, and
`value` only. Consequently:

**Required (scoring criterion 7).** `verify.ts:200` states the flag is "not
reliably exposed in the AX tree; skip", deferring to "the dedicated required
read-back in S3". No such read-back exists anywhere in the codebase. The agent
sets the flag and never confirms it.

**Range and units (scoring criterion 9).** `verify.ts:177–195` defers to "a
dedicated range read-back". No such read-back exists. Current behaviour: if
the element's role is `spinbutton` or `textbox`, the range is assumed present
and the comparator returns VERIFIED.

The second case is precisely the trap the assignment describes — a platform
silently discarding a range when the type changes — and the current response
to that scenario is to report success on the basis that the control still
looks numeric.

### The fix

`ObservationElement.state` gains two members, read from ARIA attributes with
native HTML fallbacks, computed in PERCEIVE with no domain knowledge added:

```ts
export interface ElementState {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  value?: string;
  /** aria-required, or the native `required` attribute. */
  required?: boolean;
  /** aria-valuemin/aria-valuemax/aria-valuenow, or native min/max/step. */
  range?: { min?: number; max?: number; step?: number };
}
```

Units are not an ARIA concept. Where the input file specifies units, VERIFY
looks for the unit string in the element's accessible name or in an adjacent
text-bearing sibling within the same labelled group, and treats absence as
AMBIGUOUS rather than FAILED — units are frequently presentational and their
absence from the tree is not proof of their absence from the platform.

VERIFY gains real comparisons for both, replacing the two current deferrals.

### Related: label matching is too strict

`findByName` in `verify.ts` matches accessible names by exact string equality.
Both `compareIntent` and `checkFirst` depend on it. A platform that renders a
required field's label as `"Age *"`, or that collapses or pads whitespace, or
that appends a type annotation, causes an existing correct field to read as
absent. Under `compareIntent` that produces a false FAILED; under `checkFirst`
it produces a duplicate build, which is the exact idempotency failure the
assignment names.

`findByName` gains normalisation before comparison: trim, collapse internal
whitespace, strip a trailing required marker (a lone `*`, `(required)`, or `†`
separated from the label by whitespace), case-fold. Normalisation
is applied to both sides. Exact match is preferred and returned first; a
normalised-only match is returned with a flag so that callers may treat it as
weaker evidence. A normalised match that is ambiguous between two candidates
is never silently resolved — it escalates.

---

## 4. Architecture delta

Module walls are unchanged. PERCEIVE cannot write, BIND cannot click, ACT
cannot decide, VERIFY cannot fix.

| Module | Change |
|---|---|
| `perceive/core.ts` | `ElementState` gains `required` and `range`. Pure, deterministic, no domain knowledge. |
| `shared/contract.ts` | Adds the 18th operation `form.list_fields`. Adds `RankedCandidate`. |
| `bind/rung0.ts`, `bind/rung1.ts`, `engine/probe-runner.ts` | Lexical demotion per Finding A. Largest and highest-risk change. |
| `verify/verify.ts` | Real `required` and `range` comparison; normalised `findByName`. |
| `bind/rung2.ts` | New. LLM candidate ranking, probe-adjudicated, key-optional. |
| `engine/reconcile.ts` | New. Shallow tree survey plus deep per-form reconciliation. |
| `engine/journal.ts` | New. Append-only provenance records, JSONL and HTML export. |
| `engine/orchestrator.ts` | Work list derives from reconcile output; blocking vs non-blocking escalation; journal emission at every act. |
| `plan/compiler.ts` | Work list derives from the reconcile diff rather than the raw IR. Topological ordering for skip logic is unchanged. |
| `sidepanel/app.ts` | Pre-flight reconcile summary; Rung 2 key entry; journal export; per-type escalation cards. |

### The 18th operation

```ts
export interface FormListFieldsArgs {
  op: 'form.list_fields';
}

/** One control observed inside the currently open form. */
export interface ObservedField {
  label: string;
  role: string;
  required?: boolean;
  range?: { min?: number; max?: number; step?: number };
  options: string[];
  handle: string;
}
```

It binds like any other operation: structural enumeration of the editing
surface, ranked, probed, cached. If it cannot bind, that is a capability
finding reported at pre-flight, and the agent falls back to journal-only
resume with a clearly stated limitation rather than pretending to reconcile.

---

## 5. Reconciliation

### Shallow pass — before any mutation

Walk the visit list and record which visits exist. Open each existing visit
and record which form names appear under it. Do not descend into forms.

Cost is bounded by visit and form-appearance count (4 and 28), not field count
(195). The result populates the pre-flight screen with a concrete work
statement before the human authorises anything:

> Screening and Week 4 already exist. 9 of 28 form appearances present.
> 19 forms to create, 186 fields to add.

### Deep pass — on opening each form

Call `form.list_fields`. For each field the input file specifies for this
form, resolve against what is present:

| Situation | Action |
|---|---|
| Not present | Build it. |
| Present, all attributes match | Adopt. Journal the adoption. Do not touch. |
| Present, any attribute differs | Do not mutate. Escalate as non-blocking. |
| Present twice (duplicate labels) | Do not mutate. Escalate as non-blocking. |

Attribute comparison covers label (normalised), role against expected roles for
the canonical type, required flag, range and units, and coded-value pairs.

The rule against mutating a differing field is deliberate. The agent cannot
distinguish its own earlier error from a deliberate human edit made after a
previous run, so it reports rather than overwrites.

### Form reuse resolves empirically

The assignment warns that whether a platform shares form definitions across
visits must be discovered rather than assumed, and that a naive agent errs in
one direction or the other. The deep pass removes the choice:

- Create "Vital Signs" at its second visit, then list its fields.
- Fields already present and matching → the platform shares definitions.
  Adopt; the appearance is complete.
- Empty → the platform requires per-visit construction. Build the fields.

No feature detection, no template-affordance search, no assumption. The same
code path handles both platform behaviours, and it also handles a platform
that shares definitions partially.

### Ordering rules

Skip-logic topological ordering from the existing compiler is unchanged:
a controlling field is always built before the field whose visibility depends
on it, within the same form.

One additional sequencing rule, driven by the type-change-discards-range trap:

> Set the type first. Set the range second. Read the range back after the type
> is settled. If any later step touches the type, read the range back again.

### Journal relationship

The persisted `RunState` remains, as an optimisation that lets a resumed run
skip re-verifying items confirmed moments earlier in the same session. It is
never the source of truth. Live observation is. A cleared `chrome.storage`
degrades performance, not correctness.

---

## 6. Rung 2 — LLM disambiguation

### Position in the ladder

Invoked only when Rung 0 (structural role and accessible name) and Rung 1
(place-and-inspect probe) both fail to resolve a canonical type to a platform
control. Most types on most platforms never reach it.

### Inputs and outputs

The model receives the candidate controls PERCEIVE has already observed —
role, accessible name, name source, observed probe result, position in the
tree — together with the canonical type being placed and its definition. It
does not receive HTML, DOM structure, CSS, or selectors.

It returns a ranked ordering of the candidates it was given, plus a one-
sentence rationale per ranked candidate. It cannot introduce a candidate that
was not in its input. This preserves the module walls: BIND still cannot click,
and no selector originates from a model.

### Adjudication

The model never has the last word. Its top-ranked candidate is placed, and the
resulting control is read back:

- Readback agrees with the intended canonical type → build, journal the model's
  involvement and the confirming evidence.
- Readback disagrees or is inconclusive → escalate, presenting both the
  model's ranking and rationale and the probe's contradicting observation.

A confidently wrong model answer therefore cannot reach the study.

### Key handling and degradation

An Anthropic API key is entered by the user in the side panel and stored in
`chrome.storage.local`. No key is bundled in the extension or committed to the
repository. With no key configured, the ladder skips Rung 2 and unresolved
types escalate to Rung 3 (human) directly. The build completes either way;
Rung 2 shortens the human queue and is never a correctness dependency.

### Cost

One call per unresolved canonical type, not per field. Thirteen canonical
types bounds a run at thirteen calls, and typical runs use far fewer.

Requests are made to the Anthropic Messages API from the service worker, with
the host permission declared in the manifest. Failure of the call — network,
quota, malformed response — is treated identically to having no key: skip the
rung, escalate to human.

---

## 7. Human gate

### Organised around decisions, not items

195 fields resolve to at most 13 type decisions. A type-mapping escalation is
raised once, answered once, and applied to every field of that canonical type.
The worst case for a reviewer is thirteen type decisions plus a per-field
remainder, not 195 confirmations.

### Blocking versus non-blocking

The current orchestrator pauses on every escalation and awaits a decision.
Over a study of this size this produces an interrupt-driven review session with
poor throughput. Escalations split by whether the run can proceed without the
answer:

**Blocking** — pause immediately and ask:
- The commit control could not be identified. Nothing can be persisted.
- A canonical type could not be resolved. Every field of that type is stuck.
- `form.list_fields` could not bind and reconciliation is unavailable.
- The plan compiler found a cyclic skip-logic graph in the input.

**Non-blocking** — park the item, continue the run, review at the end:
- A range the platform rejected or silently discarded.
- Coded values that did not land as entered (append-versus-replace).
- A skip rule whose controlling field could not be located.
- A field that exists but differs from the input file.
- A duplicate-labelled field found during reconciliation.
- A form whose creation could not be confirmed.

The resulting run shape is: a small number of questions up front, an
uninterrupted build, then a single review session over the parked items.

### Card content

An escalation card shows what was attempted, what was observed, the binding
rung reached, the suspected trap, and the blast radius. It presents the
disagreement rather than resolving it. Example:

> **single_select — no confident match**
> Placed the control named "Orbit List" → produced a group of radio buttons.
> Placed "Beam Pick" → produced a dropdown.
> Names and behaviour disagree. Behaviour is usually correct, but the naming
> is unusual enough to warrant a decision.
> Affects 14 fields across 6 forms.
> [Use "Beam Pick"] [Use "Orbit List"] [Show me] [Skip these 14]

Available actions are the existing `HumanDecision` set — approve, override,
skip, retry — plus an optional note, which is recorded in the journal.

### Pre-flight screen

Populated by the shallow reconcile pass and the capability report: which
contract operations bound and at which rung, which visits and forms already
exist, how much work remains, and whether Rung 2 is available. The human
authorises the run from a concrete statement of what will happen, not from an
empty progress bar.

---

## 8. Traceability

Every action writes one immutable record. The record answers: which entry in
the input file this came from, what was done, why it was believed correct, and
what confirmed it.

```ts
export interface JournalRecord {
  seq: number;
  run_id: string;
  timestamp: number;

  /** Provenance into the input file. */
  ir_source: {
    path: string;          // "visits[0].forms[2].fields[1]"
    visit_name: string;
    form_name: string;
    field_label?: string;
    declared_type?: CanonicalType;
  };

  /** What was attempted. */
  op: ContractOpId;
  outcome: 'created' | 'adopted' | 'skipped' | 'escalated' | 'failed';

  /** Why this binding was believed correct. */
  binding: {
    rung: BindingRung;
    evidence: string[];
    llm_rationale?: string;
    llm_rank?: number;
  } | null;

  /** What confirmed it. */
  verification: VerdictResult | null;

  /** Human involvement, if any. */
  human: { action: HumanDecision['action']; note?: string } | null;
}
```

Adoptions and skips are journalled alongside creations. "Already present,
matched, left alone" is the record that explains why a second run touched
nothing, and it is as important as the creation records.

Export from the side panel in two forms: JSONL for machine consumption and
scoring, and a rendered HTML report grouped visit → form → field for reading.

A hash chain over records was considered and deliberately excluded — it is
closer to what a regulated system eventually needs, but no scoring criterion
examines it and it is not on the critical path.

---

## 9. Validation

### The vocabulary-scramble harness

The primary evidence for Finding A, and the honest test of the assignment's
central constraint.

A build-time transform takes an existing generalization environment and
mechanically renames every visible string — button labels, palette entry
names, headings, section titles, field-property labels — to generated nonsense,
with a different scramble on each run, seeded and recorded so a failure is
reproducible. Structure, roles, and interaction paradigm are preserved; only
vocabulary changes.

If the agent still builds the study, English words are demonstrably no longer
load-bearing. If it fails, some list is still acting as a gate. Because the
vocabulary differs on every run, it cannot be tuned to.

This test is written first, run against the current code to observe it fail,
and used to drive the Finding A restructuring.

### The double-run test

Run against a fresh platform twice. The second run must create zero elements
and produce an identical score. This states idempotency as something checked
rather than claimed.

A third variant runs twice with `chrome.storage` cleared between runs, proving
that reconciliation rather than the journal is doing the work.

### The scored sweep

All four existing generalization environments plus the supplied mock — five
targets in total — scored by
`generalization/score.py` on all ten criteria, recorded before and after each
change. A change that improves one environment and regresses another does not
ship. The runbook already specifies this; it needs to actually be executed and
its results committed.

### The enumeration guard

A static test over `src/bind/` and `src/engine/probe-runner.ts` that fails if a
name comparison appears in a candidate-exclusion position. Lexical weights are
permitted only in the single declared weights table. This prevents Finding A
from regrowing.

### Unit tests

New coverage for: `required` and `range` extraction in PERCEIVE; the two new
VERIFY comparisons; label normalisation including the ambiguous-match
escalation path; `form.list_fields` binding and parsing; the reconcile decision
table across all four situations; Rung 2 request construction, response
parsing, and every degradation path; journal record emission and export.

---

## 10. Work order

Ordered by dependency and by risk, not by module.

1. **Vocabulary-scramble harness.** Written first, expected to fail. It defines
   done for step 3.
2. **PERCEIVE `required` and `range`; VERIFY comparisons and label
   normalisation.** Small, independent, immediately unblocks two scored
   criteria.
3. **Lexical demotion across BIND and the probe runner.** The largest change.
   Driven to green against the scramble harness and regression-checked against
   all five environments after each site.
4. **`form.list_fields` operation and its binding.**
5. **`engine/reconcile.ts`** — shallow and deep passes; work list derivation.
   Delivers idempotency and form reuse together.
6. **`engine/journal.ts`** and orchestrator emission at every act.
7. **Blocking versus non-blocking escalation** in the orchestrator; side panel
   pre-flight summary and per-type cards; journal export.
8. **`bind/rung2.ts`** and side panel key entry.
9. **Full scored sweep** across all five environments plus the double-run
   tests; results committed.

Steps 1–3 are the critical path. Step 8 is last because it is the only item
whose absence degrades the queue length rather than the correctness of the
build.

---

## 11. Assumptions and exclusions

**Assumptions**

- The unseen mock exposes a working accessibility tree, or enough native HTML
  semantics for PERCEIVE's role computation to recover one. `env-hostile-a11y`
  covers the degraded case; a platform rendering entirely in canvas is out of
  reach for this architecture and would be reported as a capability finding at
  pre-flight rather than silently mis-built.
- Field identity across runs is carried by the field's label. No platform-
  assigned identifier is assumed to be visible or stable.
- The input file is the one supplied; its structure is fixed and its parsing is
  already implemented and tested.

**Explicitly excluded**

- Hash-chained journal records.
- Repairing fields that exist but differ. They escalate.
- Any use of the mock's debug hooks (`__readState`, `__groundTruth`) in agent
  code. They remain available to the scoring harness only, which is a human
  verification tool and not part of the agent.
- Authoring a fifth hand-written hostile environment. The four existing ones
  are retained and still scored; the scramble harness generates more variation
  than another hand-written fixture would and cannot be tuned to.
