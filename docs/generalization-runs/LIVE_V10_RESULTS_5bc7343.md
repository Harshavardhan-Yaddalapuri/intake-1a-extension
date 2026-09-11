# Intake-1a live hostile E2E v10 results

Synced tip: `5bc7343` (nav-gate approve / Required via groupText / prune blank coded rows)
Box extension: `/workspace/intake-1a/extension` (`.synced-tip` set; `node build.mjs` OK)
openRouterApiKey: has=true (len=73; value never printed)
Hostile servers: 4091–4094 HTTP 200 throughout
Drive method: CDP harness (Task/computerUse tool not available on this executor)

## Overall % (real score.py output; not invented)

| Env | v9 overall | v10 overall | notes |
|-----|------------|-------------|-------|
| env-swapped-controls (4094) | **0.37%** | **70.85%** | Main fix validated: 4 visits / 28 forms / 152 fields; did **not** skip-208 after approve |
| env-rosetta (4091) | **84.25%** | **76.29%** | Overall down; **required** 52.82%→78.46%, **coded-pairs** 77.44%→78.46% |
| env-hostile-a11y (4093) | **0.0%** | **0.0%** | visit-open gates failed; approve+retry without surface still refused continue → empty GT |
| env-wizard (4092) | **0.37%** | **6.94%** | visits 100%; many binding escalations (radio/select); GT 4 visits / 23 forms / 8 fields |

## Artifacts
- `env-*-after-v10.json` + `env-*-after-v10-score.json` under `/workspace/intake-1a/generalization-runs/`
- Scorer: `python3 extension/generalization/score.py --ir takehome/data/abc-101-study.ir.json --ground-truth <gt> --json`
