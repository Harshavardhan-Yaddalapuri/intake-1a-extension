// test/idempotency.test.mjs
//
// Idempotency stated as something CHECKED rather than claimed. Uses the
// reconcile decision table directly: given the platform state a first run
// produces, a second run must decide 'adopt' for everything and 'build' for
// nothing. The brief is explicit that running twice must not produce two
// Demographics forms or two copies of every field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileForm } from '../dist/reconcile.mjs';

const form = {
  form_id: 'v0.f0',
  name: 'Vital Signs',
  fields: [
    { visit_id: 'v0', form_id: 'v0.f0', field_id: 'd0', label: 'Heart Rate',
      canonical_type: 'integer', required: true, range_units: { min: 30, max: 200, units: 'bpm' } },
    { visit_id: 'v0', form_id: 'v0.f0', field_id: 'd1', label: 'Sex',
      canonical_type: 'single_select', required: true,
      coded_pairs: [{ code: 'M', label: 'Male' }, { code: 'F', label: 'Female' }] },
    { visit_id: 'v0', form_id: 'v0.f0', field_id: 'd2', label: 'Comments',
      canonical_type: 'textarea', required: false },
  ],
};

/** What the platform looks like after a correct first run. */
function afterFirstRun() {
  return [
    { label: 'Heart Rate bpm', role: 'spinbutton', required: true, range: { min: 30, max: 200 }, options: [], handle: 'a' },
    { label: 'Sex', role: 'combobox', required: true, options: ['Male', 'Female'], handle: 'b' },
    { label: 'Comments', role: 'textbox', required: false, options: [], handle: 'c' },
  ];
}

test('first run against an empty platform builds everything', () => {
  const r = reconcileForm(form, []);
  assert.equal(r.decisions.filter((d) => d.action === 'build').length, 3);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 0);
});

test('second run builds NOTHING', () => {
  const builds = reconcileForm(form, afterFirstRun()).decisions.filter((d) => d.action === 'build');
  assert.deepEqual(
    builds.map((d) => d.label), [],
    'a second run must not create a duplicate of anything the first run built',
  );
});

test('second run adopts everything', () => {
  assert.equal(reconcileForm(form, afterFirstRun()).decisions.filter((d) => d.action === 'adopt').length, 3);
});

test('reconcile works from live state alone, with no journal involved', () => {
  // No run state is passed anywhere in this call. The decision comes purely
  // from what the platform shows, so a cleared chrome.storage cannot cause
  // duplicates -- which is the whole reason reconcile exists rather than
  // trusting the journal.
  const r = reconcileForm(form, afterFirstRun());
  assert.ok(r.decisions.every((d) => d.action === 'adopt'));
});

test('an interrupted first run resumes without duplicating what it finished', () => {
  const r = reconcileForm(form, afterFirstRun().slice(0, 2));
  assert.deepEqual(r.decisions.filter((d) => d.action === 'build').map((d) => d.label), ['Comments']);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 2);
});

test('a hand-edited field is reported, not silently overwritten', () => {
  const edited = afterFirstRun();
  edited[2].role = 'combobox'; // someone changed Comments to a dropdown
  const d = reconcileForm(form, edited).decisions.find((x) => x.label === 'Comments');
  assert.equal(d.action, 'escalate');
  assert.equal(d.mismatch, 'role');
});

test('shared form definitions are detected on a second appearance', () => {
  assert.equal(reconcileForm(form, afterFirstRun()).sharedDefinition, true);
});

test('per-visit rebuild is detected when the second appearance is empty', () => {
  assert.equal(reconcileForm(form, []).sharedDefinition, false);
});
