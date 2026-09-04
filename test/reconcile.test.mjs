// test/reconcile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileField, reconcileForm, summariseTree, normaliseLabel as reconcileNormalise } from '../dist/reconcile.mjs';
import { normaliseLabel as verifyNormalise } from '../dist/verify.mjs';

const intent = {
  visit_id: 'v0', form_id: 'v0.f0', field_id: 'v0.f0.d0',
  label: 'Heart Rate', canonical_type: 'integer', required: true,
  range_units: { min: 30, max: 200, units: 'bpm' },
};

function observed(o = {}) {
  return { label: 'Heart Rate bpm', role: 'spinbutton', required: true,
           range: { min: 30, max: 200 }, options: [], handle: '0.1.5', ...o };
}

test('absent field decides BUILD', () => {
  assert.equal(reconcileField(intent, []).action, 'build');
});

test('matching field decides ADOPT', () => {
  const d = reconcileField(intent, [observed()]);
  assert.equal(d.action, 'adopt', d.reason);
});

test('wrong role decides ESCALATE, never repair', () => {
  // 'textbox' would be legitimate for an integer; 'checkbox' cannot hold one.
  const d = reconcileField(intent, [observed({ role: 'checkbox' })]);
  assert.equal(d.action, 'escalate');
  assert.equal(d.mismatch, 'role');
});

test('wrong range decides ESCALATE', () => {
  const d = reconcileField(intent, [observed({ range: { min: 0, max: 300 } })]);
  assert.equal(d.action, 'escalate');
  assert.equal(d.mismatch, 'range');
});

test('missing range decides ESCALATE - the silent-discard trap', () => {
  const d = reconcileField(intent, [observed({ range: undefined })]);
  assert.equal(d.action, 'escalate');
  assert.equal(d.mismatch, 'range');
});

test('wrong required flag decides ESCALATE', () => {
  const d = reconcileField(intent, [observed({ required: false })]);
  assert.equal(d.action, 'escalate');
  assert.equal(d.mismatch, 'required');
});

test('duplicate labels decide ESCALATE', () => {
  const d = reconcileField(intent, [observed(), observed({ handle: '0.1.6' })]);
  assert.equal(d.action, 'escalate');
  assert.equal(d.mismatch, 'duplicate');
});

test('label matching tolerates normalisation and the declared unit', () => {
  assert.equal(reconcileField(intent, [observed({ label: '  heart   rate  (bpm) ' })]).action, 'adopt');
  assert.equal(reconcileField(intent, [observed({ label: 'Heart Rate' })]).action, 'adopt');
});

test('a label never resolves against a longer neighbouring label', () => {
  const d = reconcileField(intent, [observed({ label: 'Heart Rate Variability (ms)' })]);
  assert.equal(d.action, 'build', 'must build Heart Rate, not adopt its neighbour');
});

test('an unnamed control never counts as a match', () => {
  assert.equal(reconcileField(intent, [observed({ label: '' })]).action, 'build');
});

test('coded values must match as pairs, not just count', () => {
  const coded = { ...intent, label: 'Sex', canonical_type: 'single_select',
                  range_units: undefined,
                  coded_pairs: [{ code: 'M', label: 'Male' }, { code: 'F', label: 'Female' }] };
  const ok = reconcileField(coded, [{ label: 'Sex', role: 'combobox', required: true, options: ['Male', 'Female'], handle: 'h' }]);
  assert.equal(ok.action, 'adopt', ok.reason);
  const wrong = reconcileField(coded, [{ label: 'Sex', role: 'combobox', required: true, options: ['Male', 'Other'], handle: 'h' }]);
  assert.equal(wrong.action, 'escalate');
  assert.equal(wrong.mismatch, 'coded_values');
});

// --- form level ------------------------------------------------------------

const form = {
  form_id: 'v0.f0', name: 'Vital Signs',
  fields: [
    { ...intent, field_id: 'd0', label: 'Heart Rate' },
    { ...intent, field_id: 'd1', label: 'Temperature', range_units: { min: 30, max: 45, units: 'C' } },
  ],
};
const populated = [
  { label: 'Heart Rate bpm', role: 'spinbutton', required: true, range: { min: 30, max: 200 }, options: [], handle: 'a' },
  { label: 'Temperature C', role: 'spinbutton', required: true, range: { min: 30, max: 45 }, options: [], handle: 'b' },
];

test('an empty form means the platform rebuilds per visit: build everything', () => {
  const r = reconcileForm(form, []);
  assert.equal(r.decisions.filter((d) => d.action === 'build').length, 2);
  assert.equal(r.sharedDefinition, false);
});

test('a populated form means the platform shares definitions: adopt everything', () => {
  const r = reconcileForm(form, populated);
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 2);
  assert.equal(r.sharedDefinition, true, 'arriving populated is how a shared definition reveals itself');
});

test('a partially populated form builds the remainder', () => {
  const r = reconcileForm(form, populated.slice(0, 1));
  assert.equal(r.decisions.filter((d) => d.action === 'adopt').length, 1);
  assert.deepEqual(r.decisions.filter((d) => d.action === 'build').map((d) => d.label), ['Temperature']);
});

test('extra fields on the platform are reported but never deleted', () => {
  const r = reconcileForm(form, [...populated, { label: 'Investigator Note', role: 'textbox', options: [], handle: 'c' }]);
  assert.deepEqual(r.unexpected.map((f) => f.label), ['Investigator Note']);
  assert.ok(!r.decisions.some((d) => d.action === 'delete'));
});

// --- tree level ------------------------------------------------------------

test('summariseTree counts what exists against what is wanted', () => {
  const s = summariseTree(
    [
      { visit_id: 'v0', name: 'Screening', forms: [{ form_id: 'a', name: 'Demographics' }, { form_id: 'b', name: 'Vital Signs' }] },
      { visit_id: 'v1', name: 'Week 4', forms: [{ form_id: 'c', name: 'Vital Signs' }] },
    ],
    { Screening: ['Demographics'] },
  );
  assert.equal(s.visitsWanted, 2);
  assert.equal(s.visitsPresent, 1);
  assert.deepEqual(s.visitsToCreate, ['Week 4']);
  assert.equal(s.formAppearancesWanted, 3);
  assert.equal(s.formAppearancesPresent, 1);
  assert.equal(s.formAppearancesToCreate.length, 2);
});

test('reconcile and verify normalise labels identically', () => {
  for (const s of ['Heart Rate', 'Heart Rate *', 'Heart Rate (required)', '  Heart   Rate  ', 'HEART RATE', 'Sex †', '', 'Weight (kg)']) {
    assert.equal(reconcileNormalise(s), verifyNormalise(s),
      `divergent normalisation for "${s}" -- the agent would disagree with itself about whether a field exists`);
  }
});
