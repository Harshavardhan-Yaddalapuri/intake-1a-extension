# Submit checklist (human)

Branch: `fix/skip-logic-and-formula-writes` (already on origin).  
**Submit code baseline:** behavior of `d220d9d` (v14 live board). See `docs/generalization-runs/SUBMIT_BASELINE.md`.

## Before you send

1. Rebuild from this worktree (not `main`):
   ```bash
   cd ~/Projects/intake-1a-extension/.claude/worktrees/review-queue-signal
   npm test && npm run build
   ```
2. Chrome → Remove old extension if loaded → **Load unpacked** → this worktree's `dist/`.
3. Record **2–3 minutes unedited** on friendly Mock A with the side panel visible (gate + progress). Prefer a clean study (`?reset=1` if supported).
4. Optional: second Mock A run on the same study (idempotency / adopt-existing).
5. Open or refresh the PR:
   https://github.com/Harshavardhan-Yaddalapuri/intake-1a-extension/pull/new/fix/skip-logic-and-formula-writes
6. Optional: paste OpenRouter key in the side panel for Rung 2 (stored in `chrome.storage` only — **never commit** `.env` / `.openrouter_key`).

## What to claim (honest)

| Claim | OK? |
|---|---|
| Strong Mock A (~99.5% GT; skip 13/13; formulas 7/7) | Yes |
| ~70%+ on vocabulary / swapped-type / wizard proxies (v14) | Yes — cite the table |
| Works on **every** zero-ARIA designer | **No** — env-hostile-a11y ~4.4%, fields still 0 |
| Agent uses `__readState` / `__groundTruth` to build | **No** — scoring only |

## Evidence pointers

- Root `README.md` — architecture + results + special considerations
- `docs/generalization-runs/SUBMIT_BASELINE.md` — which tip to treat as submit
- `docs/generalization-runs/LIVE_V14_RESULTS_d220d9d.md` + `*-after-v14-score.json`
- `docs/after-live-run-skipfix4.json` — Mock A dump
- `docs/GENERALIZATION_EVIDENCE.md` — longer failure-family notes (historical + harness)
