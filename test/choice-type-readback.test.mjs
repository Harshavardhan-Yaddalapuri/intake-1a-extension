// A choice control's type IS its options. Until they are entered the platform
// renders nothing to read, so adjudicating the type at add time judges a
// control that does not exist yet.
//
// Live (2026-09-05, run-1788662063427): "Sex at Birth" escalated with
// `Placed "Radio Buttons" for radio and a generic control appeared instead`,
// blocking all 10 radio fields on a mapping that was correct. text and date
// passed in the same run because a textbox renders immediately.
//
// Markup transcribed from esource-mock/src/ui/render.ts (elementCard,
// inertControl, optionsColumn). render.ts:474-482 is the crux: the loop over
// `element.values` emits nothing when the list is empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { inspectPlacedControl, classifyTypeFromProbe } from '../dist/bind-rung1.mjs';

const card = (label, type, preview) => `
<div class="element-card" id="element-${label.replace(/\W/g, '')}">
  <div class="element-head"><span class="element-label">${label}</span>
  <span class="element-meta">${type}</span></div>
  <div class="element-preview">${preview}</div></div>`;

const textPrev = (l) => `<input type="text" aria-label="${l}">`;
const choicePrev = (kind, l, vals) => vals.length
  ? vals.map((v) => `<span class="choice"><input type="${kind}" aria-label="${l}: ${v}">${v}</span>`).join('')
  : '<span class="element-meta">No values defined.</span>';

const PALETTE = ['Calculated Field', 'Check List', 'Checkbox', 'Date', 'Date/Time', 'Dropdown',
  'Multi-line Textbox', 'Number (Decimal)', 'Number (Whole)', 'Radio Buttons',
  'Single Line Textbox', 'Time', 'Yes/No Toggle']
  .map((n) => `<button type="button">${n}</button>`).join('');

const OPTIONS = `<aside class="options"><h3>Options</h3>
<div class="row"><label for="opt-label">Label</label><input type="text" id="opt-label"></div>
<div class="row"><label for="opt-type">Element Type</label><select id="opt-type"><option>Radio Buttons</option></select></div>
<div class="row"><label for="opt-req">Required</label><input type="checkbox" id="opt-req"></div>
<fieldset><legend>Values</legend><button type="button">+ Add Value</button>
<div class="row"><label for="opt-paste">Paste Values (replaces list)</label><textarea id="opt-paste"></textarea></div>
<button type="button">Apply Pasted Values</button></fieldset>
<button type="button">Delete Element</button></aside>`;

const screen = (cards, options) => `
<header><button>← Screening</button><span class="builder-title">Demographics</span>
<button>Save</button><button>Activate</button></header>
<aside class="palette"><h3>Elements</h3>
<div class="row"><label for="find">Find</label><input type="text" id="find"></div>${PALETTE}</aside>
<main><button>Page 1</button><button>+ Page</button>${cards}</main>${options ? OPTIONS : ''}`;

const doc = (h) => new JSDOM(`<!doctype html><html><body><div id="app">${h}</div></body></html>`).window.document;

const EXISTING = card('Subject Initials *', 'Single Line Textbox · Required', textPrev('Subject Initials'))
               + card('Date of Birth *', 'Date · Required', textPrev('Date of Birth'));

const place = (preview) => {
  const pre = observe(doc(screen(EXISTING, false)));
  const post = observe(doc(screen(EXISTING + card('Radio Buttons', 'Radio Buttons', preview), true)));
  return inspectPlacedControl(pre, post);
};

test('a radio with no values yet is NOT classifiable as radio', () => {
  // Not a bug in the classifier -- there is genuinely nothing to read. The bug
  // was escalating on it instead of asking again later.
  const probe = place(choicePrev('radio', 'Sex at Birth', []));
  assert.equal(probe.observedOptions.length, 0, 'no options are observable yet');
  assert.equal(
    classifyTypeFromProbe('radio', probe).matches, false,
    'a valueless choice control cannot prove its type',
  );
});

test('the same radio IS classifiable once its coded values exist', () => {
  const probe = place(choicePrev('radio', 'Sex at Birth', ['Female', 'Male', 'Undisclosed']));
  assert.equal(
    classifyTypeFromProbe('radio', probe).matches, true,
    `deferring the read-back must let it pass; got role=${probe.observedRole}`,
  );
});

test('multi_select passes even with no options — vacuously, on no evidence', () => {
  // Documents current behaviour, not desired behaviour. classifyTypeFromProbe's
  // multi_select fallback accepts ANY control carrying an options editor that
  // is not a combobox/radiogroup/radio, so an unrendered control matches for a
  // reason that proves nothing. This is why multi_select never escalated live
  // while radio did -- not because it was verified, but because it is
  // unfalsifiable here.
  // ponytail: vacuous match left as-is; tighten only with a probe that can tell
  // multi from single exclusivity, or every choice type escalates on this mock.
  const empty = place(choicePrev('checkbox', 'Race', []));
  assert.equal(empty.observedOptions.length, 0, 'nothing observable yet');
  assert.equal(
    classifyTypeFromProbe('multi_select', empty).matches, true,
    'current behaviour: matches on the options-editor fallback alone',
  );

  const filled = place(choicePrev('checkbox', 'Race', ['Asian', 'Black', 'White']));
  assert.equal(
    classifyTypeFromProbe('multi_select', filled).matches, true,
    `got role=${filled.observedRole}`,
  );
});

test('a textbox type is readable immediately, so it must NOT defer', () => {
  // Why text and date passed in the live run: their control renders at once.
  const probe = place(textPrev('Subject Initials'));
  assert.equal(classifyTypeFromProbe('text', probe).matches, true);
  assert.ok(probe.observedOptions.length === 0);
});

test('inverted-library: Node Type picker is not the placed choice control', () => {
  // env-swapped-controls labels the type select "Node Type" (not "Element Type").
  // Leaving it in the canvas pool made empty radio/multi_select classify as
  // single_select and poisoned palette bindings.
  const OPTIONS_SWAPPED = `<aside class="options"><h3>Node Properties</h3>
<div class="row"><label for="opt-label">Label</label><input type="text" id="opt-label"></div>
<div class="row"><label for="opt-type">Node Type</label>
<select id="opt-type"><option>Beam Pick</option><option>Orbit List</option>
<option>Multi Mark Grid</option><option>Flag Toggle Grid</option></select></div>
<div class="row"><label for="opt-req">Required</label><input type="checkbox" id="opt-req"></div>
<fieldset><legend>Choices</legend><button type="button">+ Add Choice</button>
<div class="row"><label for="opt-paste">Paste Choices (appends to list)</label>
<textarea id="opt-paste"></textarea></div>
<button type="button">Append Pasted Choices</button></fieldset>
<button type="button">Delete Node</button></aside>`;

  const placeSwapped = (preview) => {
    const pre = observe(doc(screen(EXISTING, false)));
    const post = observe(doc(
      screen(EXISTING + card('Multi Mark Grid', 'Multi Mark Grid', preview), false)
        .replace('</main>', `</main>${OPTIONS_SWAPPED}`),
    ));
    return inspectPlacedControl(pre, post);
  };

  const empty = placeSwapped(choicePrev('checkbox', 'Meds', []));
  assert.notEqual(
    empty.observedRole, 'combobox',
    `Node Type must not be read as the placed field; got ${empty.evidence[0]}`,
  );
  assert.equal(
    classifyTypeFromProbe('single_select', empty).matches, false,
    'empty multi_select must not classify as single_select via the type picker',
  );

  const filled = placeSwapped(choicePrev('checkbox', 'Meds', ['A', 'B']));
  assert.equal(classifyTypeFromProbe('multi_select', filled).matches, true);
  assert.equal(classifyTypeFromProbe('single_select', filled).matches, false);
});

test('inverted-library: Beam Pick radio with values is not a dropdown', () => {
  const OPTIONS_SWAPPED = `<aside class="options"><h3>Node Properties</h3>
<div class="row"><label for="opt-label">Label</label><input type="text" id="opt-label"></div>
<div class="row"><label for="opt-type">Node Type</label>
<select id="opt-type"><option>Beam Pick</option><option>Orbit List</option></select></div>
<div class="row"><label for="opt-req">Required</label><input type="checkbox" id="opt-req"></div>
<fieldset><legend>Choices</legend><button type="button">+ Add Choice</button></fieldset>
<button type="button">Delete Node</button></aside>`;

  const pre = observe(doc(screen(EXISTING, false)));
  const post = observe(doc(
    screen(
      EXISTING + card('Beam Pick', 'Beam Pick', choicePrev('radio', 'Sex', ['F', 'M'])),
      false,
    ).replace('</main>', `</main>${OPTIONS_SWAPPED}`),
  ));
  const probe = inspectPlacedControl(pre, post);
  assert.equal(classifyTypeFromProbe('radio', probe).matches, true, `role=${probe.observedRole}`);
  assert.equal(classifyTypeFromProbe('single_select', probe).matches, false);
});

test('empty Dial Group must not read the panel Label as the placed control', () => {
  // Hostile / renamed palettes place an empty choice with only "No values
  // defined." on the canvas. The property panel always brings Label + type
  // picker + Required. Falling back to those made role=textbox, skipped
  // deepen, and escalated radio to the human gate despite a clear tile.
  const OPTIONS_ROSETTA = `<aside class="options"><h3>Options</h3>
<div class="row"><label for="opt-label">Label</label><input type="text" id="opt-label" aria-label="Label"></div>
<div class="row"><label for="opt-type">Element Type</label>
<select id="opt-type" aria-label="Element Type"><option>Dial Group</option><option>Picker</option></select></div>
<div class="row"><label for="opt-req">Required</label><input type="checkbox" id="opt-req" aria-label="Required"></div>
<fieldset><legend>Values</legend><button type="button">+ Add Value</button></fieldset>
<button type="button">Delete Element</button></aside>`;

  const pre = observe(doc(screen(EXISTING, false)));
  const post = observe(doc(
    screen(
      EXISTING + card('Dial Group', 'Dial Group', choicePrev('radio', 'Sex', [])),
      false,
    ).replace('</main>', `</main>${OPTIONS_ROSETTA}`),
  ));
  const probe = inspectPlacedControl(pre, post);
  assert.notEqual(
    probe.observedRole, 'textbox',
    `panel Label must not be the placed control; got ${probe.evidence[0]}`,
  );
  assert.equal(
    probe.hasOptionsEditor, true,
    'options editor on the panel is the deepen signal',
  );
  assert.ok(
    probe.observedRole === 'generic' || probe.observedRole === 'none',
    `empty choice should be generic/none so deepen runs; got ${probe.observedRole}`,
  );
  assert.equal(
    classifyTypeFromProbe('radio', probe).matches, false,
    'still unclassifiable until values exist — deepen, do not escalate yet',
  );
  assert.equal(
    classifyTypeFromProbe('text', probe).matches, false,
    'must not vacously claim text via the Label textbox',
  );
});

test('Dial Group with values classifies as radio, not single_select', () => {
  const OPTIONS_ROSETTA = `<aside class="options"><h3>Options</h3>
<div class="row"><label for="opt-label">Label</label><input type="text" id="opt-label" aria-label="Label"></div>
<div class="row"><label for="opt-type">Element Type</label>
<select id="opt-type" aria-label="Element Type"><option>Dial Group</option></select></div>
<div class="row"><label for="opt-req">Required</label><input type="checkbox" id="opt-req" aria-label="Required"></div>
<fieldset><legend>Values</legend><button type="button">+ Add Value</button></fieldset>
<button type="button">Delete Element</button></aside>`;

  const pre = observe(doc(screen(EXISTING, false)));
  const post = observe(doc(
    screen(
      EXISTING + card('Dial Group', 'Dial Group', choicePrev('radio', 'Sex', ['F', 'M'])),
      false,
    ).replace('</main>', `</main>${OPTIONS_ROSETTA}`),
  ));
  const probe = inspectPlacedControl(pre, post);
  assert.equal(classifyTypeFromProbe('radio', probe).matches, true, `role=${probe.observedRole}`);
  assert.equal(classifyTypeFromProbe('single_select', probe).matches, false);
  assert.equal(classifyTypeFromProbe('text', probe).matches, false);
});
