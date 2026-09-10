# Intake-1a live hostile E2E v15 results

Synced tip: `5dc7ac7` (fix: place fields on zero-ARIA designers (generic tiles + Label groupText))
Parent: after `26762b3` (docs: record v14 hostile scores (wizard 77.5%; 3/4 proxies ≥70%))
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` = 5dc7ac7; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 (restarted onto synced generalization dirs after tip swap)
Drive method: CDP harness `generalization-runs/live-drive-v15.mjs`

## Overall % (real score.py output; not invented)

| Env | v13 overall | v14 overall | v15 overall | notes |
|-----|-------------|-------------|-------------|-------|
| env-hostile-a11y | **4.4%** | **4.4%** | **5.53%** | Small lift (+1.13pp). Forms 100% (was 75%); repeating 82.14% (was 64.29%). **fields still 0** — Prism place tip did not land any field writes. 59/1067 matched. GT fields=0 |
| env-wizard | **7.87%** | **77.51%** | **30.93%** | **Protect miss (≥77%).** −46.58pp vs v14. Visits/forms/windows/repeating still 100%. Fields criterion 3.57% (GT fields=245 but counts wrong / types largely multi_select). 330/1067 matched |
| env-rosetta | **99.44%** | **99.44%** | **99.06%** | Protected ≥99% (held, −0.38pp). ranges 94.87% (was 96.92%). All other criteria 100%. 1057/1067 matched |
| env-swapped-controls | **94.47%** | **93.91%** | **93.91%** | Protected ≥93% (held, flat vs v14). Same Subject Initials miss; ranges 69.23%. 1002/1067 matched |

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

### env-wizard — overall 30.93%

| criterion | match_pct |
|-----------|-----------|
| visits | 100.0 |
| visit-windows | 100.0 |
| forms | 100.0 |
| repeating | 100.0 |
| fields | 3.57 |
| types | 6.67 |
| required | 35.38 |
| coded-pairs | 32.31 |
| ranges | 23.59 |
| skip-rules | 37.95 |

### env-rosetta — overall 99.06%

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
| ranges | 94.87 |
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

## Priority vs goals

1. env-hostile-a11y — fields must leave 0; aim meaningful overall lift from 4.4% → **FAIL fields still 0**; overall 5.53% (minor lift only via forms/repeating)
2. env-wizard — protect ≥77% → **FAIL 30.93%**
3. env-rosetta — protect ≥99% → **PASS 99.06%**
4. env-swapped-controls — protect ≥93% → **PASS 93.91%**

## Artifacts

- GT: `env-*-after-v15.json`
- Scores: `env-*-after-v15-score.json` (+ `.txt` human scorecards)
- Drive logs: `live-drive-v15-{a11y,wizard,rosetta,swapped}.log`
- Harness: `live-drive-v15.mjs`

## Run notes

- Sync: Mac worktree tip `5dc7ac7` → `intake-1a-v15-5dc7ac7.tgz` → `/workspace/intake-1a/extension` (node_modules preserved; API key storage untouched)
- Extension reloaded via `chrome.runtime.reload()` on SW; CDP port 9227; EXT id `ajiefcdgacflpbimnldodaloegdjhcpf`
- Drive order (priority): a11y → wizard → rosetta → swapped
- a11y GT fields=0 (place tip did not materialize fields); wizard GT fields=245 but field-count criterion 1/28; Done in 504.4s / 1858.9s / ~9m / ~9m
- Scores produced only by `extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth …`
