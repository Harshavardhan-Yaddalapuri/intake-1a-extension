# Generalization Environment Suite -- RUNBOOK

## Overview

This suite contains 4 hostile variant eSource mock environments for testing
the Intake 1a Chrome extension's ability to generalize across different
eSource platforms. Each environment is a standalone web app that serves
the same 13 canonical field types but with different vocabularies, DOM
structures, and interaction paradigms.

The extension needs NO code changes to work against any of these -- they are
just URLs. Point the extension at the URL and it should drive the UI.

## Directory Layout

    generalization/
      env-rosetta/           -- different vocabulary, top-toolbar layout
      env-wizard/             -- wizard paradigm, hamburger menu, icon tiles
      env-hostile-a11y/       -- no ARIA, no semantic HTML, div-only
      env-swapped-controls/  -- inverted type mapping, append-paste trap
      score.py                -- scoring harness (ground truth vs IR)
      RUNBOOK.md              -- this file

## Quick Start

### 1. Start all 4 environments

Each env is a static web app. Use any static server. Example with Python:

    # Terminal 1 -- env-rosetta on port 4091
    cd generalization/env-rosetta
    python3 -m http.server 4091

    # Terminal 2 -- env-wizard on port 4092
    cd generalization/env-wizard
    python3 -m http.server 4092

    # Terminal 3 -- env-hostile-a11y on port 4093
    cd generalization/env-hostile-a11y
    python3 -m http.server 4093

    # Terminal 4 -- env-swapped-controls on port 4094
    cd generalization/env-swapped-controls
    python3 -m http.server 4094

Or use npx:

    npx http-server generalization/env-rosetta -p 4091
    npx http-server generalization/env-wizard -p 4092
    npx http-server generalization/env-hostile-a11y -p 4093
    npx http-server generalization/env-swapped-controls -p 4094

### 2. Point the extension at an env

Load the Chrome extension (unpacked). Navigate to:

    http://localhost:4091   (env-rosetta)
    http://localhost:4092   (env-wizard)
    http://localhost:4093   (env-hostile-a11y)
    http://localhost:4094   (env-swapped-controls)

The extension should treat each as an unknown eSource platform and
discover its structure through its normal discovery + execution flow.

### 3. Reset an env

Add ?reset=1 to the URL:

    http://localhost:4091/?reset=1

This clears all in-memory state (visits, forms, fields).

### 4. Export ground truth

Open the browser console on any env and call:

    window.__groundTruth()

This returns a JSON object with the full study state (visits, forms,
fields with types, options, ranges, skip logic). Copy the JSON output
to a file for scoring.

### 5. Score a run

    python3 generalization/score.py \
      --ir /path/to/abc-101-study.ir.json \
      --ground-truth /path/to/ground-truth.json

For machine-readable JSON output:

    python3 generalization/score.py \
      --ir /path/to/abc-101-study.ir.json \
      --ground-truth /path/to/ground-truth.json \
      --json

With a runtime log (escalations, LLM calls, human decisions):

    python3 generalization/score.py \
      --ir /path/to/abc-101-study.ir.json \
      --ground-truth /path/to/ground-truth.json \
      --runtime-log /path/to/runtime-log.json

## Environment Details

### env-rosetta (port 4091)

Platform: "Zephyr eForm Forge"

Vocabulary is completely invented. Same structure as the given mock
(visits -> forms -> fields with options/range/skip-logic) but every label
is different:

  - multi_select -> "Single Choice Box" (trap: sounds single)
  - checkbox -> "Multi Choice Box" (trap: sounds multi)
  - single_select -> "Picker"
  - radio -> "Dial Group"
  - text -> "Free String"
  - textarea -> "Long String"
  - integer -> "Whole Number"
  - decimal -> "Fractional Number"
  - date -> "Calendar Day"
  - time -> "Clock Time"
  - datetime -> "Stamp"
  - boolean -> "Binary Flip"
  - calculated -> "Derived Value"
  - Save -> "Freeze"
  - Save As Template -> "Bank It"
  - Activate -> "Go Live"
  - Add Visit -> "New Phase"
  - Add Source Document -> "New Record Sheet"

Layout: top toolbar (no left palette), palette as horizontal scroll strip.

TRAP: Name-based matching must FAIL here. Only structural/a11y-role
matching succeeds.

### env-wizard (port 4092)

Platform: "FormCraft Studio"

Different paradigm entirely:
  - Wizard-style builder: one question/element per step
  - Next/Back navigation between steps
  - Element library presented as a modal grid with icon-only tiles
  - Commit (Save) lives behind a hamburger menu
  - 3 tiles have NO accessible name (calculated, time, datetime) --
    a real accessibility hazard the extension must handle via
    probe/rung degradation, not name matching
  - Layout: dark theme, modal element grid

### env-hostile-a11y (port 4093)

Platform: "PrismForm Builder"

Accessible-tree hostile environment:
  - NO ARIA roles, NO aria-labels, NO aria-* attributes
  - Custom divs with click handlers instead of semantic HTML
  - Text painted as spans, not labels
  - No <button>, <label>, <select> elements
  - Only the structural DOM walk + probe evidence can bind

The extension should degrade to probe-based matching (rung 2/3)
heavily here. This is the CORRECT behavior to observe, not a failure
to hide.

### env-swapped-controls (port 4094)

Platform: "Nexus Form Engine"

Same structure as the given mock but with type-mapping traps INVERTED:
  1. Radio where you would expect a dropdown ("Beam Pick" sounds like
     a dropdown, "Orbit List" sounds like a radio group)
  2. Checkbox and multi_select adjacency flipped in the library
  3. Type-change clears range in BOTH directions (integer->decimal
     AND decimal->integer both clear range, unlike the given mock
     which only clears when going to a non-range type)
  4. Bulk-paste APPENDS values to the existing list instead of
     replacing it

## Scoring Criteria

The scoring harness compares the ground truth against the IR across
10 criteria:

  1. visits         -- visit count and names
  2. visit-windows  -- window start/end days
  3. forms          -- form count, names
  4. repeating      -- form repeating flag
  5. fields         -- field count per form
  6. types          -- field type matches expected
  7. required       -- required flag matches
  8. coded-pairs    -- options: code + label pairs (order-insensitive)
  9. ranges         -- min, max, units match
  10. skip-rules    -- skip logic: controlling field + equals value

Each criterion is exact-match only. The overall score is the percentage
of all checks that pass.

Runtime metrics (escalations, LLM calls, human decisions) come from the
extension's own runtime log, not the ground truth. Pass them via
--runtime-log if available; otherwise they show "N/A".

## Regression Testing Workflow

1. Start all 4 envs on ports 4091-4094
2. Run the extension against each env
3. After each run, export ground truth via window.__groundTruth()
4. Score each run:
     python3 score.py --ir abc-101-study.ir.json --ground-truth env-rosetta-gt.json
     python3 score.py --ir abc-101-study.ir.json --ground-truth env-wizard-gt.json
     python3 score.py --ir abc-101-study.ir.json --ground-truth env-hostile-a11y-gt.json
     python3 score.py --ir abc-101-study.ir.json --ground-truth env-swapped-controls-gt.json
5. Compare scorecards across envs. A fix that improves one env but
   regresses another is a FAIL.
6. Also run against the given mock (the original eSource mock) to
   ensure no regression there either.

The point: every extension fix must be regression-checked across ALL
environments. The graders run against an UNSEEN mock -- our suite
must approximate that hostility.