# Intake-1a live hostile E2E v12 results

Synced tip: `2f09705` (fix(act): write contenteditable; open field libraries before probing)
Parent: after `b76a5e0` (docs: record hostile live v11 scores)
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` = 2f09705; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 (restarted after sync onto fresh generalization dirs)
Drive method: CDP harness `generalization-runs/live-drive-v12.mjs`

## Overall % (real score.py output; not invented)

| Env | v11 overall | v12 overall | notes |
|-----|-------------|-------------|-------|
| env-rosetta | **98.97%** | **98.97%** | Protected ≥98% baseline (unchanged); required 100.0%, coded-pairs 100.0%; GT 4/28/195; 1056/1067 matched |
| env-swapped-controls | **93.44%** | **93.44%** | Protected ≥93% baseline (unchanged); required 99.49%; GT 4/28/194; 997/1067 matched |
| env-hostile-a11y | **0.0%** | **0.0%** | Contenteditable writes stick (4 waves created) but names became window-start days (-1/0/31/87), windowStart/End blank; visit-open failed → forms=0/fields=0 |
| env-wizard | **7.59%** | **66.45%** | Lifted far above 7.59%; GT fields=189 (was 18); fields criterion 39.29% (11/28) vs 0.0%; 709/1067 matched |

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

### env-wizard — overall 66.45%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 82.14 |
| fields | 39.29 |
| types | 75.38 |
| required | 48.72 |
| coded-pairs | 66.67 |
| ranges | 56.92 |
| skip-rules | 80.0 |

## Artifacts
- `env-*-after-v12.json` + `env-*-after-v12-score.json` under `/workspace/intake-1a/generalization-runs/`
- Scorer: `python3 extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth <gt> --json`
- Tip commit: `2f09705` (after `b76a5e0`)
- Sync tarball: `/workspace/intake-1a/intake-1a-v12-2f09705.tgz`
