# Intake-1a live hostile E2E v11 results

Synced tip: `79d9fe5` (fix: stop coded-prune deleting fields; open Prism/wizard surfaces)
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` = 79d9fe5; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 (restarted after sync onto fresh generalization dirs)
Drive method: CDP harness `generalization-runs/live-drive-v11.mjs`

## Overall % (real score.py output; not invented)

| Env | v10 overall | v11 overall | notes |
|-----|-------------|-------------|-------|
| env-rosetta | **76.29%** | **98.97%** | Recovered past ≥84%; required 100.0%, coded-pairs 100.0%; GT 4/28/195; 1056/1067 matched |
| env-swapped-controls | **70.85%** | **93.44%** | Improved vs 70.85%; required 99.49%; GT 4/28/194 |
| env-hostile-a11y | **0.0%** | **0.0%** | visit-open failed on Prism Wave Roster; approve without surface refused continue → empty GT |
| env-wizard | **6.94%** | **7.59%** | GT fields=18 (>8) and overall 7.59% > 6.94%; visits 4 / forms 27; run 10 verified / 198 escalated |

## Criterion match_pct (score.py)

### env-rosetta — overall 98.97%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 82.14 |
| fields | 100.0 |
| types | 100.0 |
| required | 100.0 |
| coded-pairs | 100.0 |
| ranges | 96.92 |
| skip-rules | 100.0 |

### env-swapped-controls — overall 93.44%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 82.14 |
| fields | 96.43 |
| types | 99.49 |
| required | 99.49 |
| coded-pairs | 99.49 |
| ranges | 69.23 |
| skip-rules | 99.49 |

### env-hostile-a11y — overall 0.0%

| criterion | match_pct |
|-----------|-----------|
| visits | 0.0 |
| visit-windows | 0.0 |
| forms | 0.0 |
| repeating | 0.0 |
| fields | 0.0 |
| types | 0.0 |
| required | 0.0 |
| coded-pairs | 0.0 |
| ranges | 0.0 |
| skip-rules | 0.0 |

### env-wizard — overall 7.59%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 71.43 |
| repeating | 75.0 |
| fields | 0.0 |
| types | 0.0 |
| required | 4.62 |
| coded-pairs | 4.62 |
| ranges | 2.56 |
| skip-rules | 4.62 |

## Artifacts
- `env-*-after-v11.json` + `env-*-after-v11-score.json` under `/workspace/intake-1a/generalization-runs/`
- Scorer: `python3 extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth <gt> --json`
- Tip commit: `79d9fe5` (after `5bc7343`)
