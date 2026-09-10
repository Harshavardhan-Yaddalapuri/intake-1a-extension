# Intake-1a live hostile E2E v16 results

Synced tip: `2347106` (fix(bind): narrow Prism zero-ARIA paths so FormCraft type bind recovers)
Parent: after `5dc7ac7` (fix: place fields on zero-ARIA designers (generic tiles + Label groupText))
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` = 2347106; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 (restarted onto synced generalization dirs after tip swap)
Drive method: CDP harness `generalization-runs/live-drive-v16.mjs`

## Overall % (real score.py output; not invented)

| Env | v13 overall | v14 overall | v15 overall | v16 overall | notes |
|-----|-------------|-------------|-------------|-------------|-------|
| env-hostile-a11y | **4.4%** | **4.4%** | **5.53%** | **5.53%** | fields still 0.0. Note only; no miracle expected. |
| env-wizard | **7.87%** | **77.51%** | **30.93%** | **29.99%** | Recover toward ≥77% (v14) — **FAIL**. Must not stay ~31%. |
| env-rosetta | **99.44%** | **99.44%** | **99.06%** | **99.44%** | Protect ≥99% — **PASS**. |
| env-swapped-controls | **94.47%** | **93.91%** | **93.91%** | **93.91%** | Protect ≥93% — **PASS**. |

## Criterion match_pct (score.py)

### env-hostile-a11y — overall 5.53%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 82.14 |
| fields | 0.0 |
| types | 0.0 |
| required | 0.0 |
| coded-pairs | 0.0 |
| ranges | 0.0 |
| skip-rules | 0.0 |

59/1067 matched

### env-wizard — overall 29.99%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 100.0 |
| fields | 0.0 |
| types | 9.74 |
| required | 34.87 |
| coded-pairs | 31.28 |
| ranges | 20.51 |
| skip-rules | 34.87 |

320/1067 matched

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

1061/1067 matched

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

1002/1067 matched

## Priority vs goals

1. env-wizard — recover toward ≥77% (v14); must not stay ~31% → **FAIL 29.99%**
2. env-rosetta — protect ≥99% → **PASS 99.44%**
3. env-swapped-controls — protect ≥93% → **PASS 93.91%**
4. env-hostile-a11y — note fields; don't expect miracle → fields=0.0; overall 5.53%

## Artifacts

- GT: `env-*-after-v16.json`
- Scores: `env-*-after-v16-score.json` (+ `.txt` human scorecards)
- Drive logs: `live-drive-v16-{a11y,wizard,rosetta,swapped}.log`
- Harness: `live-drive-v16.mjs`

## Run notes

- Sync: Mac worktree tip `2347106` → `intake-1a-v16-2347106.tgz` → `/workspace/intake-1a/extension` (node_modules preserved; API key storage untouched)
- Extension reloaded via `chrome.runtime.reload()` on SW; CDP port 9227; EXT id `ajiefcdgacflpbimnldodaloegdjhcpf`
- Drive order (priority): wizard → rosetta → swapped → a11y
- Wizard GT fields=265 but field-count criterion still poor (extra/wrong fields; types largely multi_select)
- Rosetta GT fields=195; swapped GT fields=194; a11y GT fields=0
- Scores produced only by `extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth …`

## Release note for parent

**v14 (`d220d9d` / docs `26762b3`) remains the safer submit baseline until v16 wizard recovers.**
Wizard v16=29.99% (still ~31% class); rosetta/swapped held; Prism-narrowing tip did not restore FormCraft wizard field binding quality.
