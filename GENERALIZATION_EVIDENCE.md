# Intake-1a Generalization Evidence

**Date:** 2026-09-09 (America/Detroit)  
**Extension sync:** Mac worktree `fix/skip-logic-and-formula-writes` @ `c0bda5e`  
**IR:** `takehome/data/abc-101-study.ir.json` (4 visits / 28 forms / 195 fields / 13 skip rules)  
**Harness:** `extension/generalization/score.py` + `RUNBOOK.md`  
**Artifacts:** `/workspace/intake-1a/generalization-runs/`

## Honesty statement (scope completed)

| Layer | Status |
|---|---|
| Env servers on 4091–4094 | **Done** (static `python3 -m http.server`) |
| `__groundTruth()` + `score.py` harness validation | **Done** (empty = 0%; perfect seed = **100%** on all 4) |
| jsdom perceive / rung0 binders / type-probe smoke | **Done** for all 4 |
| Unit tests (generalization + wizard + skip/formula + plan) | **64/64 pass** |
| Friendly mock-A live GT scored | **Done** — best GT **99.53%** (`after-live-run-skipfix4.json`) |
| **Live Chrome E2E** (extension driving each hostile env end-to-end, then scoring GT) | **Not completed** — no computerUse/extension drive this turn |

Therefore: **there are no live hostile overall `%` scores from a full agent run.** Numbers below are (a) harness ceilings, (b) binding/probe smoke proxies that predict where a live run will fail, and (c) mock-A regression.

Extension can be pointed at:
- http://127.0.0.1:4091 — env-rosetta (Zephyr eForm Forge)
- http://127.0.0.1:4092 — env-wizard (FormCraft Studio)
- http://127.0.0.1:4093 — env-hostile-a11y (PrismForm Builder)
- http://127.0.0.1:4094 — env-swapped-controls (Nexus Form Engine)

Reset: `?reset=1`. Export: `window.__groundTruth()` in the page console.

---

## Scoreboard

### A. Live extension run (friendly mock only)

| Platform | GT artifact | Overall | Matched / Expected |
|---|---|---:|---:|
| esource-mock-a (pre skip-fix baseline) | `after-live-run.json` | **98.31%** | 1049 / 1067 |
| esource-mock-a (post skip-fix) | `after-live-run-skipfix4.json` | **99.53%** | 1062 / 1067 |

Post-fix criterion breakdown (skipfix4):

| Criterion | Match |
|---|---|
| visits | 4/4 (100%) |
| visit-windows | 4/4 (100%) |
| forms | 28/28 (100%) |
| repeating | 28/28 (100%) |
| fields | 28/28 (100%) |
| types | 195/195 (100%) |
| required | 195/195 (100%) |
| coded-pairs | 195/195 (100%) |
| ranges | 190/195 (**97.44%**) |
| skip-rules | 195/195 (100%) |

Residual mock-A failures (5): range **min=0** written/stored as empty for `Dose Administered` (×2), `Aspartate Aminotransferase`, `Total Bilirubin`, `Creatinine`. Max+units OK. Likely UI/`0` edge — not re-fixed this turn (needs live repro on mock-A).

### B. Hostile envs — harness ceiling (not an agent score)

Perfect IR seed into each env’s in-memory study, then `__groundTruth()` + `score.py`:

| Env | Empty GT | Perfect-seed GT |
|---|---:|---:|
| env-rosetta | 0% | **100%** (1067/1067) |
| env-wizard | 0% | **100%** |
| env-hostile-a11y | 0% | **100%** |
| env-swapped-controls | 0% | **100%** |

Confirms: scoring input shape is consistent across all four platforms; a correct live build *can* score 100%.

### C. Hostile envs — live E2E agent scores

| Env | Live overall % |
|---|---|
| env-rosetta | **N/A — E2E not run** |
| env-wizard | **N/A — E2E not run** |
| env-hostile-a11y | **N/A — E2E not run** |
| env-swapped-controls | **N/A — E2E not run** |

### D. Hostile envs — jsdom smoke proxies (predictive)

Plan compile against IR: **OK** (env-agnostic) for all four.

| Env | Study-root observed/actionable | Builder commit binder | Type probe match (placed) |
|---|---|---|---|
| env-rosetta | 4 / 4 | **WRONG → `Clock Time`** (want Freeze) | **12/13** (radio/Dial Group fail) |
| env-wizard | 2 / 2 | `Done` (plausible) | **8/13** (boolean/checkbox/single/multi/radio fail) |
| env-hostile-a11y | **0 / 0** | **NULL** | **0/13** matched (13 placed; a11y tree empty) |
| env-swapped-controls | 4 / 4 | `Lock` (plausible save name) | **11/13** (multi_select→single trap; radio/Beam Pick→single trap) |

Raw JSON: `generalization-runs/env-*-smoke.json`, `smoke-summary.json`, `perfect-seed-scores.json`.

---

## Per-env failure families (from smoke + RUNBOOK traps)

### 1. env-rosetta — vocabulary hostility
- **Name-based commit/nav collapse:** study-root binders latch onto `Phases` for nav/visit/commit/discard; builder commit ranks palette tile **`Clock Time`** instead of **`Freeze`**. Live runs will escalate or mis-click unless commit is probe-adjudicated (rung1 `analyzeCommit`), not name-ranked alone.
- **Structural type probes mostly win the label traps:** "Single Choice Box"→multi_select and "Multi Choice Box"→checkbox both classify correctly (unit tests + smoke).
- **Residual type:** `radio` / "Dial Group" did not classify as radio in jsdom probe (1/13).

### 2. env-wizard — paradigm hostility
- Hamburger / wizard step UI: visit create binds `+ Add Stop`; palette `+ Add Element`; commit `Done`.
- **Choice-family probes weak in jsdom:** boolean, checkbox, single_select, multi_select, radio all failed `classifyTypeFromProbe` after tile click (8/13 pass). Icon-only / nameless tiles (time, datetime, calculated) still placed; calculated matched.
- Live risk: Next/Back step machine + modal grid increases stale-handle and wrong-surface errors.

### 3. env-hostile-a11y — accessibility-tree hostility
- Perceive observes **zero** nodes: UI is `div.clickable` with **no roles, no aria-***, no semantic controls (`perceive-core` only keeps interactive roles / native controls).
- All rung0 binders **NULL**. Type tiles can be clicked via DOM id (`#brick-*`) in smoke, but the agent’s a11y pipeline cannot see them.
- **Expected correct degradation:** rung2/DOM walk + probe evidence. If live E2E is attempted without that path, score ≈ empty (0%).

### 4. env-swapped-controls — inverted type mapping
- Palette ids are `#node-{canonical}` (sidebar), not `#brick-*`.
- Builder commit binds `Lock` (OK-ish); discard still confuses with nav (`Trial Roadmap`).
- **Probe traps that fire:** `multi_select` ("Multi Mark Grid") classified as **single_select**; `radio` ("Beam Pick") classified as **single_select**. Matches the RUNBOOK intentional radio↔dropdown inversion.
- Other 11 types matched structurally despite alien labels.

---

## Residual risk on a 5th unseen mock

Ordered by likelihood of tanking an unseen grader mock:

1. **A11y-hostile / non-semantic DOM** — if the unseen mock paints controls without roles, current perceive returns an empty actionable set → near-total failure unless DOM/rung2 path is mandatory, not fallback-only.
2. **Commit/save vocabulary** — save labeled unlike Save/Commit/Freeze/Lock/Done; name-rank alone binds palette or nav chrome (seen: Clock Time, Phases, Trial Roadmap, hamburger).
3. **Choice-control isomorphism** — radio / single_select / multi_select / checkbox confusable under inverted chrome or weak post-place probes (seen on wizard + swapped).
4. **Wizard / multi-surface builders** — one-question-per-step or hamburger-hidden commit increases wrong-surface writes.
5. **Numeric min=0 / range clearing on type change** — still 5 residual range misses on friendly mock-A; swapped env also clears range on type flips in both directions.
6. **Skip/formula decoys** — mitigated on mock-A (13→0 skip misses in skipfix4) by When-Element vs Element-Type / Paste-Values ranking fixes; a 5th mock with new decoy labels could reopen that family.

**Confidence for an unseen mock without live hostile E2E:** medium-low on a11y-hostile and wizard-like paradigms; medium on rosetta-like renamed chrome if commit is probe-gated; higher on swapped-like layouts that still expose roles.

---

## What was run (commands / ports)

```text
# servers (still useful for a follow-up computerUse E2E)
python3 -m http.server 4091 --directory extension/generalization/env-rosetta
python3 -m http.server 4092 --directory extension/generalization/env-wizard
python3 -m http.server 4093 --directory extension/generalization/env-hostile-a11y
python3 -m http.server 4094 --directory extension/generalization/env-swapped-controls

# mock-A score
python3 extension/generalization/score.py \
  --ir takehome/data/abc-101-study.ir.json \
  --ground-truth after-live-run-skipfix4.json --json
# -> 99.53%

# jsdom smoke
node extension/test/_smoke-hostile-envs.mjs
# + swapped re-probe with #node-* tiles

# unit tests
node --test test/generalization.test.mjs test/env-wizard.test.mjs \
  test/skip-and-formula-writes.test.mjs test/plan.test.mjs
# -> 64/64 pass
```

## Code changes this turn

- Synced box extension from Mac `fix/skip-logic-and-formula-writes` @ `c0bda5e`.
- **No additional env-agnostic production fix committed** (no clear small bug isolated beyond documenting min=0 residual and binder mis-ranks).
- Smoke helper only: `extension/test/_smoke-hostile-envs.mjs` + `generalization-runs/*`.

## Recommended next step for real hostile `%`

Drive the unpacked extension against each of 4091–4094 (computerUse), export `__groundTruth()` per env, then:

```bash
python3 extension/generalization/score.py \
  --ir takehome/data/abc-101-study.ir.json \
  --ground-truth generalization-runs/env-NAME-live-gt.json --json
```

Do not treat the smoke type-probe ratios as substitute overall scores.

## Live E2E

Date: 2026-09-09 (computerUse), extension loaded unpacked from `/workspace/intake-1a/extension`.

| Environment | Ground-truth dump | Score | Queue / run stats | Blockers |
|---|---|---:|---|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after.json` | **0.00%** (0/1067) | Done in 39.3s; verified 0, escalated 0, failed 0, skipped 208 (report showed 208 pending). Four blocking visit-level decisions were approved: Screening, Baseline (Day 1), Week 4, End of Treatment (Week 12). | Visit navigation/opening failed; no visits/forms/fields were created. |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after.json` | **0.37%** (4/1067) | Run reached Screening → Demographics; one blocking type decision (Date of Birth, affecting 20 fields/19 forms) was approved. | Build then stalled at Screening → Demographics → Subject Initials; the side-panel UI was closed/reopened for recovery and reset its run state before completion. Dump contains one Screening visit and empty Demographics form. |

Machine-readable scorecards: `generalization-runs/env-rosetta-after-score.json`, `generalization-runs/env-swapped-controls-after-score.json`.

`env-wizard` and `env-hostile-a11y` were not driven in this live pass; no additional live dumps or scores were produced for them.

Availability check after the live pass: `env-wizard` (`:4092`) and `env-hostile-a11y` (`:4093`) both returned HTTP 200, but were intentionally not driven in this pass.

## Live E2E v2 (commit 2e31870)

Date: 2026-09-09 (computerUse), extension removed and freshly loaded unpacked from `/workspace/intake-1a/extension`.

| Environment | Ground-truth dump | Score | Outcome / blocker |
|---|---|---:|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after-v2.json` | **0.37%** (4/1067) | Visit create succeeded for Screening and Demographics. Run parked on missing `radio` control (Sex at Birth, 10 fields); Approve and Skip/Change actions each collapsed the queue card and left the build paused/stopped, so no completion. |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after-v2.json` | **0.37%** (4/1067) | Visit create succeeded for Screening and Demographics. Run parked on missing `date` control (Date of Birth, 20 fields); applying a date override collapsed the queue card and left the build paused/stopped, so no completion. |

Machine-readable scorecards: `generalization-runs/env-rosetta-after-v2-score.json`, `generalization-runs/env-swapped-controls-after-v2-score.json`.

`env-wizard` (`:4092`) and `env-hostile-a11y` (`:4093`) were not driven in v2 due the rosetta/swapped runs stalling at the human-gate/worker-stop state.

## Live E2E v3 — after empty-choice type-gate fix (b9a6e2c)

Date: 2026-09-09 (computerUse), extension removed and freshly loaded unpacked from `/workspace/intake-1a/extension`.

| Environment | Ground-truth dump | Score | Demographics without human type-gate | Outcome |
|---|---|---:|---|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after-v3.json` | **0.37%** (4/1067) | **No** | Run reached Screening → Demographics, encountered a human type decision, then stalled with incomplete field-level output. |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after-v3.json` | **0.37%** (4/1067) | **No** | Run reached Screening → Demographics, encountered a human type decision, then stalled with incomplete field-level output. |
| `env-wizard` (`:4092`) | `generalization-runs/env-wizard-after-v3.json` | **0.00%** (0/1067) | **No** | Build finished with 0 verified, 0 escalated, 0 failed, 208 skipped; no visits/forms were created. |
| `env-hostile-a11y` (`:4093`) | `generalization-runs/env-hostile-a11y-after-v3.json` | **0.00%** (0/1067) | **No** | Visit-level decisions were approved; queue ended empty and no visits/forms were created. |

Machine-readable scorecards: `generalization-runs/env-*-after-v3-score.json`.

## Live E2E v3 residual diagnosis + fix (aa1f2ec)

**Why 0.37% after b9a6e2c:** Demographics still blocked on human type-gate for `radio` ("No binding found for type").

Root cause (jsdom against real `env-rosetta` / `env-swapped-controls` HTML):
1. Empty Dial Group / Beam Pick still looked like a **nameless Required checkbox** (label[for] points at a missing id), so inspect reported `checkbox` + optionsEditor → vacuous **multi_select**, never radio.
2. `deepenChoiceProbe` ranked **"Apply Pasted Values" / "Append Pasted Choices"** above **"+ Add Value" / "+ Add Choice"**. Paste-apply with an empty box added nothing and aborted deepen, so options never materialised and `role=radio` never appeared.

**text Subject Initials:** `field.add` *does* require `typeBindings['text']`. On rosetta, `bindFieldAdd('text')` is **null** ("Free String" has no text synonym), so the map stays empty until `probePalette`. Text probe itself succeeds (Free String → textbox); the blocking escalate was radio, not text. Swapped name-binds text via "Glyph Line"/`line`.

**Fix (Mac `fix/skip-logic-and-formula-writes` @ `aa1f2ec`):**
- Ignore nameless canvas checkbox/switch when choosing the placed control.
- `orderChoiceDeepenCandidates`: prefer add-row; keep trying after no-op paste-apply.
- Tests: `test/hostile-empty-choice-deepen.test.mjs` (15/15 with choice-type-readback).
- Extension rebuilt (`background.js` fresh). Do not drive Chrome from this pass.

## Live E2E v4 — after choice-deepen fix (aa1f2ec)

Date: 2026-09-09 (computerUse), extension removed and freshly loaded unpacked from `/workspace/intake-1a/extension`; IR `takehome/data/abc-101-study.ir.json`.

| Environment | Ground-truth dump | Score | Demographics without human type-gate | Outcome / exact escalation |
|---|---|---:|---|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after-v4.json` | **0.37%** (4/1067) | **No** | Run reached Screening → Demographics but stopped at a review gate: `Screening — Not built — missing from the study`; `I could not open this visit, so nothing under it was built.`; `What to check: Check the visit schedule for "Screening". If it's missing, it needs adding by hand.` No approval was made. |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after-v4.json` | **0.37%** (4/1067) | **No** | Run reached Screening → Demographics and stopped at the human type-gate: `Screening › Demographics › Date of Birth`; `Not built — missing from the study`; `Nothing on this platform matched a date, so "Date of Birth" was not built.`; `What to check: Use Change type to point me at the right control, or Skip to leave it out and record the gap.` It affected **20 fields across 19 forms**. No approval/change/skip was made. |

Machine-readable scorecards: `generalization-runs/env-rosetta-after-v4-score.json`, `generalization-runs/env-swapped-controls-after-v4-score.json`.

Neither priority environment completed Demographics with fields building, so `env-wizard` (`:4092`) and `env-hostile-a11y` (`:4093`) were not attempted.

Gate text observed in the side panel was left untouched: `Nothing here has been built yet, and the build will not go past this until you answer.` For the swapped-controls type gate, the panel also stated: `Approve keeps the agent's choice for all 20 fields of this type. Change lets you pick the right control and it rebuilds them.`

## Live E2E v5 — after date+visit-open fix (11c2c91)

Date: 2026-09-09 (computerUse), extension removed and freshly loaded unpacked from `/workspace/intake-1a/extension`; IR `takehome/data/abc-101-study.ir.json`.

| Env | Ground-truth dump | Score | Demographics fields built without a human type-gate | Outcome / exact gate text |
|---|---|---:|---|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after-v5.json` | **3.37%** (36/1067) | **Yes (before the blocking visit gate)** — Demographics fields were present; no human type-gate was answered. | Build paused at a blocking visit gate: `Screening` / `Not built — missing from the study` / `I could not open this visit, so nothing under it was built.` / `What to check: Check the visit schedule for "Screening". If it is missing, it needs adding by hand.` Also: `Nothing here has been built yet, and the build will not go past this until you answer.` |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after-v5.json` | **0.37%** (4/1067) | **No** — Demographics had no fields at the blocking type-gate. | Build paused at `Screening › Demographics › Sex at Birth`: `Not built — missing from the study`; `Nothing on this platform matched radio buttons — pick exactly one, so "Sex at Birth" was not built.`; `What to check: Use Change type to point me at the right control, or Skip to leave it out and record the gap.` It affected `10 fields across 10 forms`. No approval/change/skip was made. |

Neither priority environment progressed beyond Demographics, so `env-wizard` (`:4092`) and `env-hostile-a11y` (`:4093`) were not attempted under the conditional rule. Score artifacts: `generalization-runs/env-rosetta-after-v5-score.json` and `generalization-runs/env-swapped-controls-after-v5-score.json`.

## Live E2E v6 — after v5 fixes (567bab8)

Date: 2026-09-10 (computerUse), extension removed and freshly loaded unpacked from `/workspace/intake-1a/extension`; IR `takehome/data/abc-101-study.ir.json`. Human gates were left untouched.

| Env | Ground-truth dump | Score | Outcome / exact gate text |
|---|---|---:|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after-v6.json` | **3.37%** (36/1067) | Demographics fields built with IR labels; run later blocked at the Screening visit gate: `Not built — missing from the study`; `I could not open this visit, so nothing under it was built.`; `What to check: Check the visit schedule for "Screening". If it is missing, it needs adding by hand.` |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after-v6.json` | **0.37%** (4/1067) | Stalled at a human gate in Demographics; no gate action taken. |
| `env-wizard` (`:4092`) | `generalization-runs/env-wizard-after-v6.json` | **0.37%** (4/1067) | Stalled at a human gate; no gate action taken. |
| `env-hostile-a11y` (`:4093`) | `generalization-runs/env-hostile-a11y-after-v6.json` | **0.00%** (0/1067) | Gate: `Not built — missing from the study`; `I could not open this visit, so nothing under it was built.`; `What to check: Check the visit schedule for "Screening". If it is missing, it needs adding by hand.` No approval/change/skip. |

Demographics labels from GT dumps:
- env-rosetta / Screening: `Derived Value`, `Single Choice Box`, `Multi Choice Box`, `Calendar Day`, `Stamp`, `Picker`, `Long String`, `Fractional Number`, `Whole Number`, `Dial Group`, `Free String`, `Clock Time`, `Binary Flip`, `Subject Initials`, `Date of Birth`, `Sex at Birth`, `Race`, `Ethnicity`, `Height`, `Weight`, `Body Mass Index`.
- env-swapped-controls / env-wizard: Demographics form present but empty in the dump.
- env-hostile-a11y: no Demographics form present in the dump.

Scorecards: `generalization-runs/env-{rosetta,swapped-controls,wizard,hostile-a11y}-after-v6-score.json`.

## Live E2E v7 — after probe-delete + visit-climb fix (748f353)

Date: 2026-09-10 (computerUse), extension removed and freshly loaded unpacked from `/workspace/intake-1a/extension`; IR `takehome/data/abc-101-study.ir.json`. Fresh runs were started without pausing; all human gates were left untouched (no approve/change/skip).

| Env | Ground-truth dump | Score | Demographics labels / gate outcome |
|---|---|---:|---|
| `env-rosetta` (`:4091`) | `generalization-runs/env-rosetta-after-v7.json` | **3.37%** (36/1067) | Demographics labels present, but the first 13 are palette chrome names: `Derived Value`, `Single Choice Box`, `Multi Choice Box`, `Calendar Day`, `Stamp`, `Picker`, `Long String`, `Fractional Number`, `Whole Number`, `Dial Group`, `Free String`, `Clock Time`, `Binary Flip`; IR labels followed (`Subject Initials`, `Date of Birth`, `Sex at Birth`, `Race`, `Ethnicity`, `Height`, `Weight`, `Body Mass Index`). Run blocked at Screening visit gate: `Not built — missing from the study`; `I could not open this visit, so nothing under it was built.`; `What to check: Check the visit schedule for "Screening". If it is missing, it needs adding by hand.` |
| `env-swapped-controls` (`:4094`) | `generalization-runs/env-swapped-controls-after-v7.json` | **19.4%** (207/1067) | Demographics had only IR labels: `Subject Initials`, `Date of Birth`, `Sex at Birth`, `Race`, `Ethnicity`, `Height`, `Weight`, `Body Mass Index`; no palette-name contamination. Run progressed past Demographics, then stopped at untouched gate `Built — needs a look` for `Screening › Demographics › Sex at Birth`: `"Sex at Birth" needs a second pair of eyes.`; `What to check: Open Screening › Demographics and compare "Sex at Birth" against the study file.`; `It is already in the study but does not match the file. Approving leaves it exactly as is.` |
| `env-wizard` (`:4092`) | `generalization-runs/env-wizard-after-v7.json` | **0.37%** (4/1067) | Demographics form present but had no fields in the export. Untouched gate observed: `Not built — missing from the study`; `Nothing on this platform matched radio buttons — pick exactly one, so "Sex at Birth" was not built.`; `What to check: Use Change type to point me at the right control, or Skip to leave it out and record the gap.` It affected `10 fields across 10 forms`. |
| `env-hostile-a11y` (`:4093`) | `generalization-runs/env-hostile-a11y-after-v7.json` | **0.00%** (0/1067) | No visits/Demographics form in the export. Run was left at the untouched `Built — needs a look` gate for `Screening › Demographics › Sex at Birth`: `"Sex at Birth" needs a second pair of eyes.`; `What to check: Open Screening › Demographics and compare "Sex at Birth" against the study file.`; `It is already in the study but does not match the file. Approving leaves it exactly as is.` |

Demographics label check: **palette chrome contamination found only in env-rosetta** (the 13 names listed above); env-swapped-controls had IR-only labels; env-wizard had no labels; env-hostile-a11y had no Demographics form. Scorecards: `generalization-runs/env-{rosetta,swapped-controls,wizard,hostile-a11y}-after-v7-score.json`.


## Live E2E v7 residual diagnosis (probe delete / swapped 19%)

### Why removePlacedProbe cleaned swapped but not rosetta
- Env delete UX is the same (no confirm): `deleteSelectedElement()` clears `selectedElementId` and drops the tile from working. Freeze/Lock only copies working → study for export — delete does not need Freeze to stick in working, but **Freeze after a failed cleanup persists palette chrome** into `__groundTruth` (rosetta Demographics: 13 palette names then IR labels).
- jsdom without inlined CSS missed live Chrome: empty choice cards use `cursor:pointer` and contain no controls, so they are observed as `role=generic`. Deselect drops panel chrome (Delete Element) back near baseline size; old cleanup treated that as success **without a Delete click**, and `findPlacedProbeSelectTarget` could not re-select generics/Yes-No buttons.
- Rosetta also allowed **Go Live** as a safe palette probe candidate (filter listed `activate`, not `go live`). Clicking it while dirty inserts the "Freeze the sheet before going live." toast under the builder bar and **shifts structural handles**, so ACT_EXECUTE’s re-perceive made Delete Element clicks stale more often on the horizontal-palette layout than on swapped.

### Fix (this commit)
- Residue check (`probeTileResiduePresent`) instead of size-only early exit; require a real Delete click when the place exposed one.
- Re-select targets: boolean Yes/No, fresh generic cards; re-resolve Delete/select by name before ACT; more retries.
- `isSafePaletteProbeCandidate` rejects Go Live / Phases / Sites / page chrome; palette tiles re-resolved by name each trial.

### Swapped 19.4% — residual failure families (easy wins)
Scorecard: 207/1067. Screening Demographics IR-clean; run stopped at untouched **Built — needs a look** gate for Sex at Birth.
| Family | Signal | Easy win |
|---|---|---|
| Visit coverage | visits/forms 25% — Baseline/Week4/EOT MISSING | After review-gate, continue schedule (don’t park forever on "needs a look") |
| Required | Screening fields required expected True got False | Ensure required checkbox write after label/type |
| Coded pairs | Sex/Race/Ethnicity options `[]` | Choice deepen / coded_values write on Beam Pick path |
| Ranges | Height/Weight min/max empty | Range write after type settle (known trap on type flips) |
| Downstream | All Baseline+ field MISSING | Unblock gate → rest of tree builds |

