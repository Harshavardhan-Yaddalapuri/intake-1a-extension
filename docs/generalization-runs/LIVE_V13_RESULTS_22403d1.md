# Intake-1a live hostile E2E v13 results

Synced tip: `22403d1` (fix(bind): score groupText so Wave Name is not a window-day field)
Parent: after `f43ae7d` (docs: record hostile live v12 scores)
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` = 22403d1; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 (restarted after sync onto fresh generalization dirs)
Drive method: CDP harness `generalization-runs/live-drive-v13.mjs`

## Overall % (real score.py output; not invented)

| Env | v12 overall | v13 overall | notes |
|-----|-------------|-------------|-------|
| env-hostile-a11y | **0.0%** | **4.4%** | First non-zero. Visit names Screening / Baseline (Day 1) / Week 4 / End of Treatment (Week 12) with correct windows (−28/−1, 0/0, 25/31, 81/87) — NOT −1/0/31/87. Forms 21/28; fields still 0 (open/write path incomplete). 47/1067 matched |
| env-wizard | **66.45%** | **7.87%** | REGRESSION vs aim ≥70%. Visits/forms/windows held 100%; fields collapsed 189→19 (fields criterion 39.29%→0.0%). 84/1067 matched |
| env-rosetta | **98.97%** | **99.44%** | Protected ≥98% (lifted). repeating 82.14%→100%; required/coded-pairs/types 100%; ranges 96.92%. 1061/1067 matched |
| env-swapped-controls | **93.44%** | **94.47%** | Protected ≥93% (lifted). fields/types/required/coded-pairs/skip-rules →100%; repeating 82.14%→100%; ranges 69.74%. 1008/1067 matched |

## Criterion match_pct (score.py)

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

### env-wizard — overall 7.87%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 100.0 |
| fields | 0.0 |
| types | 2.56 |
| required | 1.54 |
| coded-pairs | 1.03 |
| ranges | 2.56 |
| skip-rules | 2.56 |

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

### env-swapped-controls — overall 94.47%

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
| ranges | 69.74 |
| skip-rules | 100.0 |

## Priority checklist

1. env-hostile-a11y 4093 — named visits OK; first non-zero overall (4.4%); fields still empty
2. env-wizard 4092 — FAIL aim ≥70% (7.87%; was 66.45%)
3. env-rosetta 4091 — PASS protect ≥98% (99.44%)
4. env-swapped-controls 4094 — PASS protect ≥93% (94.47%)

## Artifacts
- `env-*-after-v13.json` + `env-*-after-v13-score.json` under `/workspace/intake-1a/generalization-runs/`
- Logs: `live-drive-v13-{a11y,wizard,rosetta,swapped}.log`
- Scorer: `python3 extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth <gt> --json`
- Tip commit: `22403d1` (after `f43ae7d`)
- Sync tarball: `/workspace/intake-1a/intake-1a-v13-22403d1.tgz`
