# Submit baseline

**Code behavior tip for submit:** `d220d9d` (wizard Done-decoy fix), with docs through `26762b3` / later score dumps.

**Current branch HEAD** includes reverts `321b501` + `4a02143` that undo Prism zero-ARIA field experiments (`5dc7ac7`, `2347106`) after they collapsed wizard live scores (~77% → ~30%) without lifting a11y fields off 0.

## Best proven live board (v14, tip d220d9d)

| Env | Overall |
|-----|--------:|
| env-rosetta | 99.44% |
| env-swapped-controls | 93.91% |
| env-wizard | 77.51% |
| env-hostile-a11y | 4.4% (fields 0) |

See `LIVE_V14_RESULTS_d220d9d.md`. Do not claim v15/v16 as improvements for submit.
