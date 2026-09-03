# Intake 1a - eSource Build Agent

Chrome MV3 extension that builds a clinical study (4 visits, 28 form
appearances, 195 fields, 13 skip rules) in an UNKNOWN eSource form-designer
web app, with a human gate for ambiguous decisions.

Architecture: B-backbone composite (Platform Contract + graded binding ladder
+ deterministic plan compiler), per the intake-1a-debate verdict.

## Architecture

```
                    +------------------+
                    |   Side Panel     |
                    |   (Human Gate)   |
                    +--------+---------+
                             |
                    +--------+---------+
                    | Service Worker   |
                    | (Orchestrator)   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
         +----+----+   +----+----+   +-----+-----+
         | PERCEIVE|   |  BIND   |   |   VERIFY   |
         | (read)  |   | (map)   |   | (compare)  |
         +----+----+   +----+----+   +-----+-----+
              |              |              |
         +----+----+        |              |
         |   ACT   |--------+--------------+
         | (click) |   Content Script
         +---------+
```

## Module walls (proposal-b section 2)

- **PERCEIVE** cannot write. It reads the DOM and serializes an Observation.
- **BIND** cannot click. It maps contract operations to interaction recipes.
- **ACT** cannot decide. It replays bindings against IR values.
- **VERIFY** cannot fix. It compares read-back against declared intent.

## Layout

    src/perceive/         Accessibility-tree Observation serializer
    src/bind/             Binding ladder (Rung 0: structural, Rung 1: probes)
    src/act/              DOM primitives (click, setValue, check, selectOption)
    src/verify/           Read-back comparator (VERIFIED / FAILED / AMBIGUOUS)
    src/plan/             IR parser + dependency DAG + topo sort + linearize
    src/engine/           Orchestrator + state machine + tab driver
    src/sidepanel/        Human gate UI (pre-flight, queue, report)
    src/shared/           Platform contract + message protocol types
    test/                 Unit tests (100 passing) + dev harness
    generalization/       4 hostile mock environments + scoring harness

## Build and test

    npm install
    npm run typecheck   # tsc --noEmit, zero errors
    npm run build       # esbuild -> dist/ (loadable unpacked extension)
    npm test            # node --test (100 tests, all passing)

## How it works

1. **Load extension**: load `dist/` as an unpacked Chrome extension.
2. **Open side panel**: click the extension icon to open the side panel.
3. **Upload IR**: upload `abc-101-study.ir.json` in the Pre-Flight tab.
4. **Start build**: the orchestrator runs pre-flight discovery (Rung 0
   structural binding), then displays the capability report.
5. **Review and resume**: review which operations bound successfully, then
   click Resume to start the main execution loop.
6. **Human gate**: escalated items appear in the Queue tab. Approve, override
   the type mapping, or skip each one.
7. **Report**: the Report tab shows live progress and a final summary.

## Type mapping approach

Canonical types are mapped to platform controls through a graded ladder:

- **Rung 0** (structural): match ARIA role + accessible name in the element
  palette. Name-only matches are flagged as hypotheses, not conclusions.
- **Rung 1** (probes): place-and-inspect a scratch control to confirm the
  structural identity. Distinguishes single_select vs radio and checkbox vs
  multi_select by observed role, not label similarity.
- **Rung 2** (LLM, stretch): send observation candidates to an LLM when
  Rungs 0-1 fail (e.g., icon-only tiles with no accessible name).
- **Rung 3** (human): escalate to the human gate.

## Human gate design

- **Per-TYPE approval**: the user confirms the type mapping once (e.g.,
  "single_select -> Dropdown"), and all fields of that type use it.
- **Evidence-based**: each escalation shows what was attempted, what was
  observed, the binding rung, and the suspected trap.
- **One-click override**: the user can override the type mapping directly.
- **Batch approve**: after reviewing a few items, approve all remaining.

## Generalization evidence

Four hostile mock environments in `generalization/`:

| Environment | Port | Trap |
|---|---|---|
| env-rosetta | 4091 | Completely invented vocabulary |
| env-wizard | 4092 | Wizard UI, hamburger save, icon-only tiles |
| env-hostile-a11y | 4093 | Zero ARIA, all divs |
| env-swapped-controls | 4094 | Inverted type mapping, append-paste trap |

Run `python3 generalization/score.py --ir data.json --ground-truth gt.json`
to score.

## PERCEIVE

Pure, deterministic, LLM-free. Walks the DOM computing roles (W3C ARIA in
HTML) and accessible names (accname-1.2 ladder in code: aria-labelledby ->
aria-label -> label[for] -> wrapped label -> placeholder -> title -> content).
Interactive elements only. Each element gets a numbered index, a stable
structural handle (child-index path from <html>), role, name, name-source,
label-uncertain flag, state, and option vocabulary for
listbox/radiogroup/combobox. Emits a diff against the previous snapshot.

Zero canonical-type knowledge. Zero form-domain knowledge. Zero LLM calls.

## Dev harness

Load dist/ as an unpacked extension, open the side panel, or open
test/harness.html and point it at any URL. The harness loads the standalone
PERCEIVE bundle into a target tab via chrome.scripting and prints the
Observation head.
