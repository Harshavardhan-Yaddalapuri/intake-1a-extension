# Intake-1a live hostile E2E v14 results

Synced tip: `d220d9d` (fix(wizard): stop Done decoy commit; narrow required/range stepper)
Parent: after `22403d1` (fix(bind): score groupText so Wave Name is not a window-day field)
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` = d220d9d; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 (restarted onto synced generalization dirs after tip swap)
Drive method: CDP harness `generalization-runs/live-drive-v14.mjs`

## Overall % (real score.py output; not invented)

| Env | v12 overall | v13 overall | v14 overall | notes |
|-----|-------------|-------------|-------------|-------|
| env-wizard | **66.45%** | **7.87%** | **77.51%** | Recovered past v12 / aim ≥70%. Visits/forms/windows/repeating 100%. Fields criterion back to 39.29% (189 fields in GT; was 19 / 0.0% on v13 after Done-decoy discard). 827/1067 matched |
| env-rosetta | **98.97%** | **99.44%** | **99.44%** | Protected ≥99% (held). Same as v13. ranges 96.92%; all other criteria 100%. 1061/1067 matched |
| env-swapped-controls | **93.44%** | **94.47%** | **93.91%** | Near-protect (≥94%); −0.56pp vs v13. Missing Screening/Demographics `Subject Initials` (fields 96.43%; types/required/coded-pairs/skip-rules 99.49%). ranges 69.23%. 1002/1067 matched |
| env-hostile-a11y | **0.0%** | **4.4%** | **4.4%** | Held vs v13. Visit names + windows (−28/−1, 0/0, 25/31, 81/87). Forms 21/28; fields still 0 (known). 47/1067 matched |

## Criterion match_pct (score.py)

### env-wizard — overall 77.51%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 100.0 |
| fields | 39.29 |
| types | 80.51 |
| required | 75.38 |
| coded-pairs | 64.62 |
| ranges | 85.64 |
| skip-rules | 79.49 |

### env-rosetta — overall 99.44%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 100.0 |
| fields | 100.0 |
| types | 100.0 |
| required | 100.0 |
| coded-pairs | 100.0 |
| ranges | 96.92 |
| skip-rules | 100.0 |

### env-swapped-controls — overall 93.91%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 100.0 |
| fields | 96.43 |
| types | 99.49 |
| required | 99.49 |
| coded-pairs | 99.49 |
| ranges | 69.23 |
| skip-rules | 99.49 |

### env-hostile-a11y — overall 4.4%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 75.0 |
| repeating | 64.29 |
| fields | 0.0 |
| types | 0.0 |
| required | 0.0 |
| coded-pairs | 0.0 |
| ranges | 0.0 |
| skip-rules | 0.0 |

## Artifacts

- GT: `env-*-after-v14.json`
- Scores: `env-*-after-v14-score.json` (+ `.txt` human scorecards)
- Drive logs: `live-drive-v14-{wizard,rosetta,swapped,a11y}.log`
- Harness: `live-drive-v14.mjs`

## Run notes

- Sync: Mac worktree tip `d220d9d` → tarball → `/workspace/intake-1a/extension` (node_modules preserved; `.env` / `.openrouter_key` not overwritten from Mac)
- Extension reloaded via `chrome.runtime.reload()` on SW; CDP port 9227; EXT id `ajiefcdgacflpbimnldodaloegdjhcpf`
- Drive order (priority): wizard → rosetta → swapped → a11y
- Wizard GT fields=189 (vs v13 fields=19) — Done decoy no longer discarding drafts via blind Next onto terminal Done
- Scores produced only by `extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth …`
