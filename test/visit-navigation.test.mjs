// Regression tests for the wrong-visit defect.
//
// Observed live against the supplied mock (2026-09-05): 15 forms belonging to
// four different visits were all created inside "Screening", and only 1 of 4
// visits existed, while the panel reported it was working on "End of Treatment
// (Week 12)".
//
// Two causes, both confirmed by driving the live mock:
//
//  1. navigateToVisit ascended by replaying the pre-flight `nav.to_study_root`
//     binding, which had bound to the top-level "Study Plan" nav item. That
//     item is the ALREADY-ACTIVE tab: clicking it is a no-op at every depth.
//     The binding reports green in the capability report and never moves.
//     The only control that ascends is the breadcrumb, and its name changes
//     per level ("← Screening", "← Visit Schedule"), so no fixed word finds it.
//
//  2. A naive ranked retry is destructive: the `visit_list` lexical hint
//     contains "list", which matches the palette entry "Check List". Clicking
//     it adds a control to the form under construction. Observed doing exactly
//     that five times in a row.
//
// The visit was then recorded as open regardless, so every later form was
// built into whichever visit happened to be on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { rankAscendCandidates, atVisitList, bindVisitCreate } from '../dist/bind-rung0.mjs';

const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];
const CREATE_CONTROL = '+ Add Visit';

const dom = (body) => new JSDOM(`<!doctype html><html><body>${body}</body></html>`).window.document;

const TOP_NAV = `<nav><button>Patients</button><button>Calendar</button>
  <button>Study Plan</button><button>Reports</button></nav>`;

/** The form designer: breadcrumb names the VISIT; palette includes "Check List". */
const builderScreen = (visitName, formName) => dom(`
  ${TOP_NAV}
  <header><button>← ${visitName}</button><span class="builder-title">${formName}</span>
    <button>Preview Form</button><button>Save</button><button>Activate</button></header>
  <aside><button>Calculated Field</button><button>Check List</button><button>Checkbox</button>
    <button>Date</button><button>Dropdown</button><button>Radio Buttons</button>
    <button>Single Line Textbox</button><button>Time</button></aside>
  <main><button>+ Page</button></main>`);

/** A visit's document list: breadcrumb names the visit LIST. */
const docListScreen = () => dom(`
  ${TOP_NAV}
  <button>← Visit Schedule</button>
  <table><tbody>
    <tr><td>Demographics</td><td class="a"><button>✎ Edit</button><button>Activate</button><button>Delete</button></td></tr>
    <tr><td>Vital Signs</td><td class="a"><button>✎ Edit</button><button>Activate</button><button>Delete</button></td></tr>
  </tbody></table>
  <button>+ New Source Document</button>`);

/** The visit list itself. */
const visitListScreen = (existing) => dom(`
  ${TOP_NAV}
  <table><tbody>${existing.map((v) => `<tr><td><button>${v}</button></td></tr>`).join('')}</tbody></table>
  <button>${CREATE_CONTROL}</button>`);

test('ascend from the designer prefers the breadcrumb that names the visit', () => {
  const obs = observe(builderScreen('Screening', 'Demographics'));
  const best = rankAscendCandidates(obs, VISITS)[0];
  assert.equal(best.name, '← Screening');
});

test('ascend never selects a palette entry, even one matching the hint word', () => {
  // "Check List" matches the `visit_list` hint's "list". Clicking it builds a
  // control into the study, so it must not be reachable by this ranking at all.
  const obs = observe(builderScreen('Screening', 'Demographics'));
  const ranked = rankAscendCandidates(obs, VISITS).map((e) => e.name);
  assert.ok(!ranked.includes('Check List'), `palette entry present in ascend pool: ${ranked.join(', ')}`);
  assert.ok(!ranked.includes('Single Line Textbox'));
});

test('ascend from a document list prefers the breadcrumb to the visit list', () => {
  const obs = observe(docListScreen());
  const best = rankAscendCandidates(obs, VISITS)[0];
  assert.equal(best.name, '← Visit Schedule');
});

test('the inert top-level nav item is never the top ascend candidate', () => {
  // "Study Plan" is the active tab on the supplied mock: it binds and does
  // nothing. Ranking it first is what stalled the run inside one visit.
  for (const screen of [builderScreen('Screening', 'Demographics'), docListScreen()]) {
    const best = rankAscendCandidates(observe(screen), VISITS)[0];
    assert.notEqual(best.name, 'Study Plan');
  }
});

test('read-back recognises the visit list by the input file\'s visit names', () => {
  const obs = observe(visitListScreen(['Screening', 'Week 4']));
  assert.equal(atVisitList(obs, VISITS, CREATE_CONTROL), true);
});

test('read-back recognises an EMPTY visit list via the bound create control', () => {
  // Before the first visit exists there are no visit names to match on.
  const obs = observe(visitListScreen([]));
  assert.equal(atVisitList(obs, VISITS, CREATE_CONTROL), true);
});

test('read-back rejects the designer and the document list', () => {
  assert.equal(
    atVisitList(observe(builderScreen('Screening', 'Demographics')), VISITS, CREATE_CONTROL),
    false,
    'the designer is not the visit list',
  );
  assert.equal(
    atVisitList(observe(docListScreen()), VISITS, CREATE_CONTROL),
    false,
    'a visit\'s document list is not the visit list',
  );
});

test('a full climb reaches the visit list in two verified hops', () => {
  // designer -> document list -> visit list, exactly as observed live.
  const screens = [
    builderScreen('Screening', 'Demographics'),
    docListScreen(),
    visitListScreen(['Screening']),
  ];
  let i = 0;
  const hops = [];
  while (i < screens.length - 1) {
    const obs = observe(screens[i]);
    assert.equal(atVisitList(obs, VISITS, CREATE_CONTROL), false);
    hops.push(rankAscendCandidates(obs, VISITS)[0].name);
    i += 1;
  }
  assert.deepEqual(hops, ['← Screening', '← Visit Schedule']);
  assert.equal(atVisitList(observe(screens[2]), VISITS, CREATE_CONTROL), true);
});

// --- env-rosetta (Zephyr) visit-nav regression ---
// Live E2E 2026-09-09: visit.create bound to inert toolbar "Phases", atVisitList
// stayed true on every screen, createVisit was a no-op, GT visits=[].

const ROSETTA_TOP = `<div class="toolbar">
  <button type="button">Phases</button>
  <button type="button">Sites</button>
  <button type="button">Data Entry</button>
</div>`;

const rosettaVisitList = (existing) => dom(`
  ${ROSETTA_TOP}
  <h2>Protocol Timeline</h2>
  <table><tbody>${existing.map((v) => `<tr><td><button>${v}</button></td></tr>`).join('')}</tbody></table>
  <button type="button" class="btn primary">+ New Phase</button>`);

const rosettaVisitScreen = (visitName) => dom(`
  ${ROSETTA_TOP}
  <p class="breadcrumb">Protocol Timeline / ${visitName}</p>
  <button type="button"><- Back</button>
  <h2>${visitName} -- Record Sheets</h2>
  <button type="button">+ New Record Sheet</button>`);

test('rosetta: visit.create ranks "+ New Phase" above the inert Phases tab', () => {
  const obs = observe(rosettaVisitList([]));
  const binding = bindVisitCreate(obs);
  assert.equal(binding?.recipe?.[0]?.evidence_name, '+ New Phase');
});

test('rosetta: atVisitList rejects Phases as a create-control witness', () => {
  // Phases is on the visit detail screen too; accepting it as the create
  // witness made every screen look like the visit list.
  assert.equal(
    atVisitList(observe(rosettaVisitScreen('Screening')), VISITS, 'Phases'),
    false,
    'inert nav chrome must not witness the visit list',
  );
  assert.equal(
    atVisitList(observe(rosettaVisitList([])), VISITS, '+ New Phase'),
    true,
    'empty list is recognised via the real create control',
  );
  assert.equal(
    atVisitList(observe(rosettaVisitScreen('Screening')), VISITS, '+ New Phase'),
    false,
    'visit detail is not the visit list when the create control is absent',
  );
});

test('rosetta: atVisitList rejects form-create witness on visit detail', () => {
  assert.equal(
    atVisitList(observe(rosettaVisitScreen('Screening')), VISITS, '+ New Record Sheet'),
    false,
    '+ New Record Sheet must not witness the visit list',
  );
});
