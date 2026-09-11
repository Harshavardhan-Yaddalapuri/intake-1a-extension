# Intake 1a - eSource Build Agent

Chrome MV3 extension that builds a clinical study (4 visits, 28 form
appearances, 195 fields, 13 skip rules) into an **unknown** eSource form-designer
web app from `abc-101-study.ir.json`, with a human gate for ambiguous decisions.

Architecture: B-backbone composite (Platform Contract + graded binding ladder
+ deterministic plan compiler).

**Load the fixed branch**, not `main`:
`fix/skip-logic-and-formula-writes` via worktree
`.claude/worktrees/review-queue-signal` (then `npm run build` and load `dist/`).

## Architecture

```
                    +------------------+
                    |   Side Panel     |
                    |   (Human Gate)   |
                    +--------+---------+
                             |
                    +--------+---------+
                    | Service Worker   |
                    | (Orchestrator)   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
         +----+----+   +----+----+   +-----+-----+
         | PERCEIVE|   |  BIND   |   |   VERIFY   |
         | (read)  |   | (map)   |   | (compare)  |
         +----+----+   +----+----+   +-----+-----+
              |              |              |
         +----+----+        |              |
         |   ACT   |--------+--------------+
         | (click) |   Content Script
         +---------+
```

## Module walls

- **PERCEIVE** cannot write. It reads the DOM and serializes an Observation.
- **BIND** cannot click. It maps contract operations to interaction recipes.
- **ACT** cannot decide. It replays bindings against IR values.
- **VERIFY** cannot fix. It compares read-back against declared intent.

### Perceive → decide → act → confirm

1. **Perceive** — content script walks interactive DOM into an Observation
   (role, accessible name, handle, state, options). No IR types, no LLM.
2. **Decide** — service-worker orchestrator compiles the IR into a plan, binds
   contract ops (visit/form/field create, type, options, required, ranges,
   skip, formulas) via the binding ladder, and chooses the next step.
3. **Act** — content script executes bound recipes (click, setValue, select).
4. **Confirm** — VERIFY reads the page back and marks VERIFIED / FAILED /
   AMBIGUOUS. Failures escalate or retry; successes unlock dependents.
5. **Human gate** — AMBIGUOUS / unbound types park in the side-panel Queue.

## Layout

    src/perceive/         Accessibility-tree Observation serializer
    src/bind/             Binding ladder (Rung 0: structural, Rung 1: probes)
    src/act/              DOM primitives (click, setValue, check, selectOption)
    src/verify/           Read-back comparator (VERIFIED / FAILED / AMBIGUOUS)
    src/plan/             IR parser + dependency DAG + topo sort + linearize
    src/engine/           Orchestrator + state machine + tab driver
    src/sidepanel/        Human gate UI (pre-flight, queue, report)
    src/shared/           Platform contract + message protocol types
    test/                 Unit tests + dev harness
    generalization/       4 hostile mock environments + scoring harness
    docs/                 Live GT dumps + generalization evidence

## Setup (load unpacked)

Requires Node 20+ and Chrome.

```bash
git clone <this-repo>
cd intake-1a-extension
git checkout fix/skip-logic-and-formula-writes
npm install
npm run typecheck
npm run build          # writes dist/
npm test               # node --test
```

1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.
2. Serve the assignment eSource mock (the take-home folder with `esource-mock`) locally, e.g. Vite on `http://127.0.0.1:5173`, or any static server for that app.
3. Open the mock in a tab. Click the extension icon → open the **side panel**.
4. Pre-Flight → upload `abc-101-study.ir.json` (from the take-home `data/` folder, also referenced from docs artifacts).
5. Optional Rung 2: enter an OpenRouter API key in the side panel (kept in
   local Chrome storage only; nothing is bundled with the extension).
6. Start build → review capability report → **Resume**. Use Queue for escalations.

Hostile generalization mocks (optional): see `generalization/RUNBOOK.md` (ports 4091–4094).

## How it works

1. Load the unpacked extension from `dist/`.
2. Open the side panel.
3. Upload `abc-101-study.ir.json` in Pre-Flight.
4. Start build (Rung 0 structural discovery + capability report).
5. Review bindings, then Resume.
6. Escalations appear in Queue (approve / override type / skip).
7. Report tab shows live progress and final summary.

## Type mapping approach

- **Rung 0** (structural): ARIA role + accessible name in the palette.
  Name-only matches are hypotheses, not conclusions.
- **Rung 1** (probes): place-and-inspect scratch controls to confirm identity
  (e.g. single_select vs radio; checkbox vs multi_select).
- **Rung 2** (LLM, stretch): optional when Rungs 0–1 fail.
- **Rung 3** (human): escalate to the gate.

## Human gate design

**What escalates:** type mapping the ladder cannot confirm (Rung 0–2 miss or
probe disagrees), visit/form open failures after retry, and verify AMBIGUOUS /
FAILED items that need a human call. Structural misses do not silently invent
controls.

**Side panel:**

- **Pre-Flight** — IR upload, capability report (which ops bound), Resume.
- **Queue** — one card per escalation: intent, observed candidates, binding
  rung, suspected trap, Approve / Override type / Skip.
- **Report** — live progress and final verified / failed / skipped counts.

Approvals are **per canonical type** where possible (approve `date` once, reuse).
Batch approve is available after reviewing a few items.

## Results (proven)

### Friendly Mock A (assignment esource-mock)

| Metric | Result |
|---|---|
| Overall GT | **99.53%** (1062 / 1067) |
| Visits / forms / fields | 4 / 28 / 195 |
| Types | 195 / 195 |
| Coded pairs | 195 / 195 |
| Skip rules | **13 / 13** |
| Formulas | **7 / 7** |
| Ranges | 190 / 195 |
| Best queue | ~208 verified, 0 escalated |

Artifact: `docs/after-live-run-skipfix4.json`.

Residual Mock A: five numeric fields store `min=0` as empty
(`Dose Administered` ×2, `Aspartate Aminotransferase`, `Total Bilirubin`,
`Creatinine`). Max + units OK.

The agent **does not** call `__readState()` / `__groundTruth()` to build.
Those APIs are for human / harness scoring only.

### Hostile / unseen mocks (live E2E)

Best **v14** live overalls on tip `d220d9d` (see `docs/generalization-runs/LIVE_V14_RESULTS_d220d9d.md`):

| Environment | Live overall | Notes |
|---|---:|---|
| env-rosetta | **99.44%** | Vocabulary-hostile; required/coded pairs strong |
| env-swapped-controls | **93.91%** | Inverted type labels; near-complete build |
| env-wizard | **77.51%** | Wizard/hamburger UI; recovered after Done-decoy commit bug |
| env-hostile-a11y | **4.4%** | Zero-ARIA: visits/forms create, **field placement still 0** |

Harness perfect-seed ceiling is **100%** on all four. Three of four proxies
clear a ~70% unseen bar; zero-ARIA field write remains the honest gap.

Evidence: `docs/generalization-runs/LIVE_V14_RESULTS_d220d9d.md` and
`docs/generalization-runs/*-after-v14-score.json`.

More detail on the live score tip and artifacts:
`docs/generalization-runs/SUBMIT_BASELINE.md`.

## Special considerations scorecard

Proven against Mock A + v14 hostile live runs (`d220d9d`). Zero-ARIA remains the weak row.

| Consideration | Mock A | Hostile / unseen (v14) |
|---|---|---|
| Semantic type mapping (probe ladder) | Pass (195/195) | Strong on rosetta/swapped/wizard; weak on zero-ARIA |
| Recall + naming | Pass | Pass on rosetta/swapped/wizard; a11y visits name OK, fields not placed |
| Coded value pairs | Pass 195/195 | Strong on rosetta/swapped; partial on wizard |
| Skip logic + order | Pass 13/13 | Present where forms/fields complete |
| Form reuse across visits | Pass 28/28 | Pass on high-scoring proxies |
| Ranges | Mostly (190/195) | Strong where fields land |
| Explicit save / commit | Pass | Pass; wizard `Done` treated as decoy not commit |
| Decoy buttons | Partially handled | Improved (commit ranking ignores bare Done) |
| Read-back verify | Yes | Yes when UI reachable |
| Idempotency (check-before-create) | Designed in engine/verify; second Mock A pass not re-recorded in this package | Depends on enumerate |
| Human gate / traceability | Yes | Yes |
| No `__readState` in agent build path | Yes | Yes |

## Generalization approach

Designed for unknown designers, not Mock-A selectors:

- Accessibility-first perceive; check-before-create idempotency keys from IR ids
- Graded type ladder (structural → probe → optional LLM → human)
- Nav-gate must re-perceive after Approve (no skip-entire-span on Approve alone)
- Commit ranking ignores bare wizard `Done` decoys
- Evidence: live scores on four **modified** hostile mocks (second-mock style),
  not only the assignment mock — see Results above

## Generalization harness

Four hostile mocks in `generalization/`:

| Environment | Port | Trap |
|---|---|---|
| env-rosetta | 4091 | Invented vocabulary |
| env-wizard | 4092 | Wizard UI, hamburger save, icon-only tiles |
| env-hostile-a11y | 4093 | Near-zero ARIA |
| env-swapped-controls | 4094 | Inverted type mapping, append-paste trap |

    python3 generalization/score.py --ir data.json --ground-truth gt.json

## PERCEIVE

Pure, deterministic, LLM-free. Walks the DOM computing roles (W3C ARIA in
HTML) and accessible names (accname ladder). Interactive elements only.
Numbered index + structural handle, role, name, name-source, state, option
vocabulary. Diff against previous snapshot. Zero canonical-type knowledge,
zero form-domain knowledge, zero LLM calls.

## By-hand / harness verification

- **Mock A live:** full study build scored with `__groundTruth()` +
  `generalization/score.py` → 99.53% (`docs/after-live-run-skipfix4.json`).
  Skip 13/13 and formulas 7/7 confirmed in that dump; queue clean on best run.
- **Hostile live (v14):** four modified mocks in `generalization/` driven
  end-to-end; scores in `docs/generalization-runs/*-after-v14-score.json`.
- **Unit tests:** `npm test` (perceive / bind / verify / wizard / nav-gate /
  skip-formula suites).
- **Screen recording:** a separate 2–3 minute unedited Mock A run showing
  the side panel and human gate is included with the submission (kept out of
  git because of size).

## Where it breaks (and what it does)

| Failure | Behavior |
|---|---|
| Type cannot be bound | Escalate to Queue with evidence; no invented control |
| Visit/form open fails | Retry once; escalate; continue only if surface matches after Approve |
| Verify FAILED / AMBIGUOUS | Park for human review or skip dependents; no silent wrong writes |
| Wizard terminal `Done` | Treated as decoy, not Commit (avoids discarding drafts) |
| Zero-ARIA field place | Visits/forms may create; fields often stay 0 → low overall score |
| Mock A `min=0` ranges | Five fields store empty min (known residual) |
| Service worker sleep | MV3 alarms keep the worker alive on long runs; a manual reload recovers a stall |

## Runtime

Rough wall-clock for a full IR build (4 visits / 28 forms / 195 fields), cold
Chrome, human approvals only when gated:

| Platform | Approx. duration |
|---|---|
| Friendly Mock A | ~8–15 minutes when the queue stays clean |
| Rosetta / swapped (v14-class) | ~15–30 minutes |
| Wizard | ~20–40 minutes (stepper + library open) |
| Hostile a11y | Shorter wall time but little field progress |

Escalation-heavy runs take longer; batch-approving types after the first few
cards cuts a lot of waiting.

## Next steps (two more weeks)

1. Reliable field placement on zero-ARIA designers, without regressing
   named-ARIA platforms like FormCraft.
2. Stronger commit discrimination across hamburger / Freeze / Lock / Done.
3. An automated second-pass harness to demonstrate idempotency on Mock A.
4. Fix the Mock A range `min=0` write edge cases.
5. Measure whether optional Rung 2 (OpenRouter) helps on icon-only palettes.
6. A one-command hostile drive + score loop to catch flakes earlier.

## AI tools used

| Tool | Helped | Got in the way |
|---|---|---|
| Cursor / Grok Bot | Faster iteration on bind/verify, scoring loops, and docs | Cloud Agents were unavailable on this plan |
| Chrome + `__groundTruth` / `score.py` | Honest overall % on friendly and hostile mocks | Extension reload and service-worker lifetime flake |
| OpenRouter (optional Rung 2) | Fallback ranking when structural bind fails | Not needed for the reported v14 board; free-tier model churn |
| `node:test` + jsdom | Locked nav-gate, Done-decoy, skip/formula behavior | jsdom is not live Chrome — hostile gaps still need a real browser |

API keys are not included in the repository. Optional Rung 2 uses an
OpenRouter key entered in the side panel and stored only in local Chrome
storage.
