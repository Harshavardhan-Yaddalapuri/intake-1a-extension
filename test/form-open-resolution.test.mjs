// Regression tests for the wrong-form-opens defect.
//
// Observed live against the supplied mock (2026-09-05): a visit containing
// three draft forms renders three identical "✎ Edit" buttons. The orchestrator
// resolved the open-control by scanning the whole observation for the first
// element whose name contained "edit", so every form resolved to row 0's
// button and all fields were built into the first form in the list.
//
// The deeper cause: observe() emitted only interactive elements, so the
// form-name cells that identify each row were absent from the Observation
// entirely. No selection logic could have been correct on that input.
//
// These tests pin both halves: PERCEIVE must carry the row context, and BIND
// must use it to resolve a NAMED form to ITS OWN control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { resolveFormOpenCandidates, surfaceShowsForm } from '../dist/bind-rung0.mjs';

/** The supplied mock's visit screen, reproduced from esource-mock/src/ui/render.ts.
 *  Three draft forms, each row carrying an identical action cluster. */
function visitScreen(formNames) {
  const rows = formNames
    .map(
      (name) => `
      <tr>
        <td class="doc-name">${name}</td>
        <td>v1</td>
        <td><span class="chip draft">Draft</span></td>
        <td>Standard</td>
        <td class="row-actions">
          <button class="btn small">✎ Edit</button>
          <button class="btn small teal">Activate</button>
          <button class="btn small danger">Delete</button>
        </td>
      </tr>`,
    )
    .join('');

  return new JSDOM(`<!doctype html><html><body>
    <main>
      <button>← Visit Schedule</button>
      <table>
        <thead><tr><th>Document</th><th>Version</th><th>Status</th><th>Type</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button class="btn primary">+ New Source Document</button>
    </main>
  </body></html>`).window.document;
}

const FORMS = ['Demographics', 'Informed Consent', 'Eligibility Criteria'];

test('PERCEIVE carries the containing row text on each interactive element', () => {
  const obs = observe(visitScreen(FORMS));
  const edits = obs.elements.filter((e) => e.name.toLowerCase().includes('edit'));

  assert.equal(edits.length, 3, 'expected one Edit button per form row');

  // Without this, three identical buttons are indistinguishable and the
  // orchestrator is choosing blind.
  for (const [i, name] of FORMS.entries()) {
    assert.ok(
      (edits[i].groupText ?? '').includes(name),
      `Edit button ${i} should carry row context "${name}", got ${JSON.stringify(edits[i].groupText)}`,
    );
  }
});

test('a named form resolves to its OWN open-control, not the first row', () => {
  const obs = observe(visitScreen(FORMS));

  const picked = FORMS.map((name) => {
    const cands = resolveFormOpenCandidates(obs, name);
    assert.ok(cands.length > 0, `no open-control candidate found for "${name}"`);
    return cands[0].handle;
  });

  assert.equal(new Set(picked).size, 3, `each form must resolve to a distinct control, got ${JSON.stringify(picked)}`);

  // And specifically: the handle must belong to the row bearing that name.
  const edits = obs.elements.filter((e) => e.name.toLowerCase().includes('edit'));
  for (const [i, name] of FORMS.entries()) {
    assert.equal(picked[i], edits[i].handle, `"${name}" resolved to the wrong row's control`);
  }
});

test('a form that is not on screen yields no candidate rather than a wrong one', () => {
  const obs = observe(visitScreen(FORMS));
  const cands = resolveFormOpenCandidates(obs, 'Vital Signs');
  assert.equal(cands.length, 0, 'an absent form must resolve to nothing, never to another form\'s control');
});

test('resolution tolerates whitespace and case variation in the form name', () => {
  const obs = observe(visitScreen(FORMS));
  const edits = obs.elements.filter((e) => e.name.toLowerCase().includes('edit'));
  const cands = resolveFormOpenCandidates(obs, '  informed   consent ');
  assert.ok(cands.length > 0, 'normalised name should still resolve');
  assert.equal(cands[0].handle, edits[1].handle);
});

// ── read-back: did the RIGHT form's designer actually open? ─────────────────

/** The designer surface: one form named, header actions, palette. */
function designerScreen(formName) {
  return new JSDOM(`<!doctype html><html><body>
    <header>
      <button>← Screening</button>
      <span class="builder-title">${formName}</span>
      <span>v1 · Draft</span>
      <button>Preview Form</button><button>Save</button><button>Activate</button>
    </header>
    <aside><h3>Elements</h3><button>Single Line Textbox</button><button>Date</button></aside>
  </body></html>`).window.document;
}

test('read-back accepts the designer for the intended form', () => {
  const obs = observe(designerScreen('Informed Consent'));
  assert.equal(surfaceShowsForm(obs, 'Informed Consent', FORMS), true);
});

test('read-back rejects the designer for a DIFFERENT form', () => {
  // The exact live failure: asked for Informed Consent, Demographics opened.
  const obs = observe(designerScreen('Demographics'));
  assert.equal(surfaceShowsForm(obs, 'Informed Consent', FORMS), false);
});

test('read-back rejects the list screen, where every form is named', () => {
  const obs = observe(visitScreen(FORMS));
  assert.equal(
    surfaceShowsForm(obs, 'Informed Consent', FORMS),
    false,
    'the list names the intended form too; siblings present means we never left it',
  );
});

test('read-back handles overlapping form names', () => {
  // Real collision in ABC-101: one name contains the other.
  const overlapping = ['Prior and Concomitant Medications', 'Concomitant Medications'];
  const obs = observe(designerScreen('Concomitant Medications'));
  assert.equal(surfaceShowsForm(obs, 'Concomitant Medications', overlapping), true);
});

test('resolution distinguishes overlapping form names on the list screen', () => {
  const overlapping = ['Prior and Concomitant Medications', 'Concomitant Medications'];
  const obs = observe(visitScreen(overlapping));
  const edits = obs.elements.filter((e) => e.name.toLowerCase().includes('edit'));

  const prior = resolveFormOpenCandidates(obs, 'Prior and Concomitant Medications');
  const plain = resolveFormOpenCandidates(obs, 'Concomitant Medications');

  assert.equal(prior[0].handle, edits[0].handle, 'longer name resolved to the wrong row');
  assert.equal(plain[0].handle, edits[1].handle, 'shorter name matched the row that merely contains it');
});
