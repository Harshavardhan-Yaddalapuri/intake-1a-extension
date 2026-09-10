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

## Build and test

    npm install
    npm run typecheck   # tsc --noEmit
    npm run build       # esbuild -> dist/
    npm test            # node --test

Load `dist/` as an unpacked Chrome extension.

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

- Per-TYPE approval (one confirm covers all fields of that type).
- Evidence: attempted binding, observation, rung, suspected trap.
- One-click type override.
- Batch approve remaining after review.

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

| Environment | Best live overall | Notes |
|---|---:|---|
| env-swapped-controls | **19.4%** (v7) | v8 regressed to 0.37% (flaky visit-open / SW / runner) |
| env-rosetta | **3.37%** | Demographics often polluted with leftover palette tile names |
| env-wizard | **0.37%** | Little/no meaningful build |
| env-hostile-a11y | **0%** | Accessibility observe effectively empty |

Harness perfect-seed ceiling is **100%** on all four (scoring input shape is
fine). Live agent generalization is **not** at a ~70% never-seen bar.

Evidence: `docs/GENERALIZATION_EVIDENCE.md` and
`docs/generalization-runs/*-score.json`.

## Special considerations scorecard

| Consideration | Mock A | Hostile / unseen |
|---|---|---|
| Semantic type mapping (probe ladder) | Pass (195/195) | Weak / trap-prone |
| Recall + naming | Pass | Fail (rosetta palette leftovers; visit-open gates) |
| Coded value pairs | Pass 195/195 | Not established |
| Skip logic + order | Pass 13/13 | Not established |
| Form reuse across visits | Pass 28/28 | Not established |
| Ranges | Mostly (190/195) | Not established |
| Explicit save / commit | Pass | Name traps (e.g. rosetta `Freeze` vs decoys) |
| Decoy buttons | Partially handled | Still a failure family |
| Read-back verify | Yes | Yes (when UI reachable) |
| Idempotency (check-before-create) | Designed in engine/verify; **second Mock A run not re-proven this week** | Depends on enumerate |
| Human gate / traceability | Yes | Yes |
| No `__readState` in agent build path | Yes | Yes |

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

## Known limitations

- Cannot claim ~70% on never-seen mocks with current live evidence.
- Hostile runs are flaky (service-worker lifetime, visit-open gates, probe
  cleanup leaving palette names on canvas).
- `env-hostile-a11y` is effectively unobservable via the a11y tree.
- Idempotency is implemented (skip already-verified / check-first create) but
  needs a fresh second Mock A recording for graders.
- Five Mock A range `min=0` edge cases remain.

## AI tools used

Local Chrome live runs + Cursor / Grok Bot coaching on this machine.
Cloud coding agents were unavailable for this repo on the current plan.
