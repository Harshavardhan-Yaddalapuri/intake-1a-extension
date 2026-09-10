# Submit baseline

## Code

| Item | Value |
|---|---|
| Branch | `fix/skip-logic-and-formula-writes` |
| Behavior tip | `d220d9d` — wizard Done-decoy / required-range stepper fix (v14 live) |
| Docs tip | includes v14 scores + this baseline note; Prism field experiments from `5dc7ac7` / `2347106` were **reverted** (`321b501`, `4a02143`) after wizard collapsed ~77% → ~30% without lifting a11y fields |

Load unpacked from `.claude/worktrees/review-queue-signal` after `npm run build`. Do **not** load `main` for the skip/formula/queue fixes.

## Best proven live board (v14)

| Environment | Overall | Notes |
|---|---:|---|
| env-rosetta | **99.44%** | Invented vocabulary |
| env-swapped-controls | **93.91%** | Inverted type labels |
| env-wizard | **77.51%** | Wizard / hamburger / icon tiles |
| env-hostile-a11y | **4.4%** | Zero ARIA; visits/forms OK, **fields 0** |

Friendly Mock A: **99.53%** GT (`docs/after-live-run-skipfix4.json`).

Primary write-up: root `README.md`.  
Run notes: `LIVE_V14_RESULTS_d220d9d.md`.  
Do **not** treat v15/v16 live scores as the submit package.
