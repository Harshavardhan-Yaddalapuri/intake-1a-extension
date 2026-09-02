# Intake 1a - eSource Build Agent

Chrome MV3 extension that builds a clinical study (4 visits, 28 form
appearances, 195 fields, 13 skip rules) in an UNKNOWN eSource form-designer
web app, with a human gate. Architecture: B-backbone composite (Platform
Contract + graded binding), per the intake-1a-debate verdict.

## Module walls (proposal-b section 2)

- PERCEIVE cannot write. It reads the DOM and serializes an Observation.
- BIND cannot click. It maps contract operations to interaction recipes.
- ACT cannot decide. It replays bindings against IR values.
- VERIFY cannot fix. It compares read-back against declared intent.

## Layout

- src/perceive/ - accessibility-tree Observation serializer (this stage)
- src/bind/ - binding ladder (S3)
- src/act/ - DOM primitives (S3)
- src/verify/ - read-back comparator (S2)
- src/plan/ - IR parser + DAG + topo sort (S2)
- src/ui/ - human gate (S4)
- src/shared/ - shared types
- test/ - unit tests + dev harness

## Build and test

    npm install
    npm run typecheck   # tsc --noEmit, zero errors
    npm run build       # esbuild -> dist/ (loadable unpacked extension)
    npm test            # node --test (accname ladder, handle stability, diff)

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
