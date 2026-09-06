// "Not visible from here" is not "does not exist".
//
// Live (2026-09-06, run-1788666852586): all four visits were created
// correctly, and then 24 of 28 forms failed with
//
//   Could not confirm the designer for "Informed Consent" opened.
//   Tried 0 candidate control(s); the surface never showed this form.
//
// After building a form the agent stands inside THAT form's designer. A
// designer lists no forms, so the search for the next form's row found zero,
// concluded it was absent, and "created" it onto the designer surface.
// navigateToVisit has an ascend loop for exactly this reason; navigateToForm
// had none and assumed it was already on the document list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { resolveFormOpenCandidates, surfaceShowsForm } from '../dist/bind-rung0.mjs';

const doc = (h) => new JSDOM(`<!doctype html><html><body><div id="app">${h}</div></body></html>`).window.document;

const TOP_NAV = `<nav><button>Patients</button><button>Calendar</button>
  <button>Study Plan</button><button>Reports</button></nav>`;

/** The document list: one row per form, each with identical action controls. */
const documentList = (names) => observe(doc(`${TOP_NAV}
  <p class="breadcrumb">Study Plan / Screening</p>
  <button>← Visit Schedule</button>
  <h2>Screening — Source Documents</h2>
  <table><tbody>${names.map((n) => `
    <tr><td class="doc-name">${n}</td>
    <td><button>✎ Edit</button><button>Activate</button><button>Delete</button></td></tr>`).join('')}
  </tbody></table>
  <button>+ New Source Document</button>`));

/** The form designer: the surface the agent is left on after building a form. */
const designer = (formName, visitName = 'Screening') => observe(doc(`${TOP_NAV}
  <header><button>← ${visitName}</button><span class="builder-title">${formName}</span>
    <button>Preview Form</button><button>Save As Template</button>
    <button>Save</button><button>Activate</button></header>
  <aside class="palette"><h3>Elements</h3>
    <div class="row"><label for="find">Find</label><input type="text" id="find"></div>
    <button>Checkbox</button><button>Date</button><button>Dropdown</button></aside>
  <main><button>Page 1</button><button>+ Page</button></main>`));

const SCREENING_FORMS = [
  'Demographics', 'Informed Consent', 'Eligibility Criteria', 'Medical History',
  'Prior and Concomitant Medications', 'Vital Signs', 'Local Laboratory - Hematology',
];

test('a form IS findable from the document list', () => {
  const obs = documentList(SCREENING_FORMS);
  for (const name of SCREENING_FORMS) {
    assert.ok(
      resolveFormOpenCandidates(obs, name).length > 0,
      `"${name}" must be openable from the list that names it`,
    );
  }
});

test('no OTHER form is findable from inside a form\'s designer', () => {
  // The exact condition that produced "Tried 0 candidate control(s)": the
  // agent had just built Demographics and went looking for Informed Consent
  // without leaving the Demographics designer.
  const obs = designer('Demographics');
  for (const name of SCREENING_FORMS.filter((n) => n !== 'Demographics')) {
    assert.equal(
      resolveFormOpenCandidates(obs, name).length, 0,
      `"${name}" cannot be resolved from another form's designer -- so zero ` +
      `candidates here means "wrong surface", never "this form does not exist"`,
    );
  }
  // The designer does name the form it is editing, which is why the run
  // sometimes reported 2 or 3 candidates instead of 0 rather than a clean zero.
  assert.ok(
    resolveFormOpenCandidates(obs, 'Demographics').length > 0,
    'a designer names its own form, so the count alone is not a reliable signal',
  );
});

test('the designer is distinguishable from the list, so the two are never confused', () => {
  const list = documentList(SCREENING_FORMS);
  const built = designer('Demographics');
  const siblings = SCREENING_FORMS.filter((n) => n !== 'Demographics');

  assert.equal(
    surfaceShowsForm(built, 'Demographics', siblings), true,
    'the designer shows one form and none of its siblings',
  );
  assert.equal(
    surfaceShowsForm(list, 'Demographics', siblings), false,
    'the list names every sibling, so it is not this form\'s designer',
  );
});

// Live (2026-09-06, run-1788668782068): visit "End of Treatment (Week 12)"
// holds a form called "End of Treatment". Its breadcrumb therefore contains a
// sibling form's name, the designer read as a list screen, and six of that
// visit's seven forms were refused. Only "End of Treatment" itself opened,
// because a form is never its own sibling.
const EOT_VISIT = 'End of Treatment (Week 12)';
const EOT_FORMS = ['Visit Status', 'Vital Signs', 'Physical Examination', '12-Lead ECG',
  'Adverse Events', 'Disease Activity Assessment', 'End of Treatment'];

test('a form name inside the VISIT name does not disqualify the designer', () => {
  for (const form of EOT_FORMS) {
    const siblings = EOT_FORMS.filter((n) => n !== form);
    assert.equal(
      surfaceShowsForm(designer(form, EOT_VISIT), form, siblings, [EOT_VISIT]), true,
      `"${form}" must open under a visit whose name contains a sibling form name`,
    );
  }
});

test('discounting the visit name does not blind the list-versus-designer test', () => {
  // The weakening this fix could have caused: a real document list must still
  // be rejected, even with the visit name discounted.
  const list = documentList(EOT_FORMS);
  const siblings = EOT_FORMS.filter((n) => n !== 'Visit Status');
  assert.equal(
    surfaceShowsForm(list, 'Visit Status', siblings, [EOT_VISIT]), false,
    'the list names every sibling; discounting the visit name must not hide that',
  );
});

// Live (2026-09-06, run-1788670028717): 27 of 28 forms built. The one that
// did not was "End of Treatment", whose name is a prefix of its own visit's
// name. Its document list's breadcrumb and heading both carry the visit name,
// every control on the page inherits that through its groupText, so an ABSENT
// form resolved to 6 candidates -- the agent concluded it already existed and
// never created it.
const eotList = (names) => observe(doc(`${TOP_NAV}
  <p class="breadcrumb">Study Plan / ${EOT_VISIT}</p>
  <button>← Visit Schedule</button>
  <h2>${EOT_VISIT} — Source Documents</h2>
  <table><tbody>${names.map((n) => `
    <tr><td class="doc-name">${n}</td>
    <td><button>✎ Edit</button><button>Activate</button><button>Delete</button></td></tr>`).join('')}
  </tbody></table>
  <button>+ New Source Document</button>`));

const SIX = EOT_FORMS.filter((n) => n !== 'End of Treatment');

test('a form absent from a visit that NAMES it still reads as absent', () => {
  assert.equal(
    resolveFormOpenCandidates(eotList(SIX), 'End of Treatment', [EOT_VISIT]).length, 0,
    'otherwise the page heading fakes its existence and it is never created',
  );
});

test('the same form, once present, is still found', () => {
  // The way this fix could have gone wrong: discount too much and the real row
  // disappears too, turning a missing form into an infinitely re-created one.
  assert.ok(
    resolveFormOpenCandidates(eotList([...SIX, 'End of Treatment']), 'End of Treatment', [EOT_VISIT]).length > 0,
    'a real row must survive the discounting',
  );
  assert.ok(
    resolveFormOpenCandidates(eotList(SIX), 'Vital Signs', [EOT_VISIT]).length > 0,
    'forms that never overlapped the visit name are unaffected',
  );
});

test('discounting the visit name does not break sibling-name overlap', () => {
  // The case the prefix rule already existed for.
  const overlapping = observe(doc(`<h2>Screening — Source Documents</h2>
    <table><tbody>
      <tr><td class="doc-name">Prior and Concomitant Medications</td><td><button>✎ Edit</button></td></tr>
      <tr><td class="doc-name">Concomitant Medications</td><td><button>✎ Edit</button></td></tr>
    </tbody></table>`));
  const hits = resolveFormOpenCandidates(overlapping, 'Concomitant Medications', ['Screening']);
  assert.ok(hits.length > 0, 'the shorter name still resolves');
  assert.equal(
    hits[0].groupText, 'Concomitant Medications',
    'and to its OWN row, not the row that merely contains its name',
  );
});

test('an empty visit offers a way to create the first form', () => {
  // The first form in a visit is genuinely absent; the fix must not mistake
  // that for the wrong-surface case and loop.
  const empty = documentList([]);
  assert.equal(resolveFormOpenCandidates(empty, 'Demographics').length, 0);
  const create = empty.elements.find((e) => /new source document/i.test(e.name));
  assert.ok(create, 'the list still offers a create control when it holds no forms');
});
