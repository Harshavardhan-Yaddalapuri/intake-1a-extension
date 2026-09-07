import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareIntent, checkFirst } from '../dist/verify.mjs';
import { elem, obs as mkObs, resetSeq } from './fixtures/obs.mjs';

// ---------------------------------------------------------------------------
// Helpers: build a minimal Observation from a list of {name, role, options}.
// ---------------------------------------------------------------------------

function obs(elements) {
  return {
    snapshotId: 'snap-test',
    url: 'http://test',
    title: 'test',
    timestamp: 0,
    elements: elements.map((e, i) => ({
      index: i + 1,
      handle: `0.0.${i}`,
      role: e.role,
      name: e.name,
      nameSource: 'aria-label',
      labelUncertain: false,
      state: {},
      options: e.options ?? [],
      tagName: 'div',
    })),
  };
}

function intent(overrides = {}) {
  return {
    visit_id: 'v0',
    form_id: 'v0.f0',
    field_id: 'v0.f0.d0',
    canonical_type: 'text',
    label: 'Subject Initials',
    required: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Three-verdict comparator.
// ---------------------------------------------------------------------------

test('verify: matching name and role is VERIFIED', () => {
  const r = compareIntent(obs([{ name: 'Subject Initials', role: 'textbox' }]), intent());
  assert.equal(r.verdict, 'VERIFIED');
});

test('verify: absent field is FAILED', () => {
  const r = compareIntent(obs([{ name: 'Other', role: 'textbox' }]), intent());
  assert.equal(r.verdict, 'FAILED');
});

test('verify: wrong role is AMBIGUOUS (not FAILED)', () => {
  const r = compareIntent(
    obs([{ name: 'Subject Initials', role: 'checkbox' }]),
    intent({ canonical_type: 'text' }),
  );
  assert.equal(r.verdict, 'AMBIGUOUS');
  assert.ok(r.suspected_trap);
});

test('verify: coded value count mismatch is AMBIGUOUS', () => {
  const r = compareIntent(
    obs([{ name: 'Race', role: 'listbox', options: ['White'] }]),
    intent({
      canonical_type: 'multi_select',
      label: 'Race',
      coded_pairs: [
        { code: 'WH', label: 'White' },
        { code: 'BL', label: 'Black' },
      ],
    }),
  );
  assert.equal(r.verdict, 'AMBIGUOUS');
  assert.match(r.suspected_trap, /replace|append|dropped/);
});

test('verify: coded value label mismatch is AMBIGUOUS', () => {
  const r = compareIntent(
    obs([{ name: 'Race', role: 'listbox', options: ['White', 'Asian'] }]),
    intent({
      canonical_type: 'multi_select',
      label: 'Race',
      coded_pairs: [
        { code: 'WH', label: 'White' },
        { code: 'BL', label: 'Black' },
      ],
    }),
  );
  assert.equal(r.verdict, 'AMBIGUOUS');
});

test('verify: matching coded values is VERIFIED', () => {
  const r = compareIntent(
    obs([{ name: 'Race', role: 'listbox', options: ['White', 'Black'] }]),
    intent({
      canonical_type: 'multi_select',
      label: 'Race',
      coded_pairs: [
        { code: 'WH', label: 'White' },
        { code: 'BL', label: 'Black' },
      ],
    }),
  );
  assert.equal(r.verdict, 'VERIFIED');
});

test('verify: single_select vs radio distinguished by role', () => {
  // A radiogroup role is NOT a valid single_select realization (single_select
  // expects combobox/listbox/radiogroup per the semantic map, but radio is a
  // distinct canonical type). Here we assert the role map keeps them apart.
  const radioIntent = intent({ canonical_type: 'radio', label: 'Sex' });
  const r = compareIntent(obs([{ name: 'Sex', role: 'radiogroup', options: ['F', 'M'] }]), radioIntent);
  assert.equal(r.verdict, 'VERIFIED');

  // checkbox vs multi_select: a checkbox role is not a multi_select.
  const multiIntent = intent({ canonical_type: 'multi_select', label: 'Race' });
  const r2 = compareIntent(obs([{ name: 'Race', role: 'checkbox' }]), multiIntent);
  assert.equal(r2.verdict, 'AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// Check-first (idempotency).
// ---------------------------------------------------------------------------

test('check-first: existing matching element is VERIFIED (skip)', () => {
  const r = checkFirst(obs([{ name: 'Subject Initials', role: 'textbox' }]), intent());
  assert.equal(r.verdict, 'VERIFIED');
});

test('check-first: absent element is FAILED (build it)', () => {
  const r = checkFirst(obs([{ name: 'Other', role: 'textbox' }]), intent());
  assert.equal(r.verdict, 'FAILED');
});

test('check-first: same name wrong role is AMBIGUOUS', () => {
  const r = checkFirst(obs([{ name: 'Subject Initials', role: 'checkbox' }]), intent());
  assert.equal(r.verdict, 'AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// Label normalisation.
// ---------------------------------------------------------------------------

const baseIntent = {
  visit_id: 'v0',
  form_id: 'v0.f0',
  field_id: 'v0.f0.d0',
  canonical_type: 'text',
  label: 'Subject Initials',
  required: false,
};

test('findByName tolerates a trailing required marker', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Subject Initials *')]);
  const v = compareIntent(o, baseIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('findByName tolerates a "(required)" suffix', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Subject Initials (required)')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

test('findByName tolerates collapsed and padded whitespace', () => {
  resetSeq();
  const o = mkObs([elem('textbox', '  Subject   Initials  ')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

test('findByName tolerates case differences', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'SUBJECT INITIALS')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

test('findByName still reports a genuinely absent field as FAILED', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Something Else Entirely')]);
  assert.equal(compareIntent(o, baseIntent).verdict, 'FAILED');
});

test('an ambiguous normalised match escalates rather than guessing', () => {
  resetSeq();
  const o = mkObs([
    elem('textbox', 'Subject Initials *'),
    elem('textbox', 'subject initials'),
  ]);
  const v = compareIntent(o, baseIntent);
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /more than one/i);
});

test('an exact match is preferred over a normalised one', () => {
  resetSeq();
  const o = mkObs([
    elem('checkbox', 'subject initials'),
    elem('textbox', 'Subject Initials'),
  ]);
  // The exact match is a textbox and matches type `text`; the normalised-only
  // candidate is a checkbox and would fail the role check.
  assert.equal(compareIntent(o, baseIntent).verdict, 'VERIFIED');
});

// ---------------------------------------------------------------------------
// Required comparison (scoring criterion 7).
// ---------------------------------------------------------------------------

test('required intent matched by required state is VERIFIED', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: { required: true } })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: true });
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('required intent contradicted by observed state is AMBIGUOUS', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: { required: false } })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: true });
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.suspected_trap ?? '', /required/i);
});

test('optional intent contradicted by observed required is AMBIGUOUS', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: { required: true } })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: false });
  assert.equal(v.verdict, 'AMBIGUOUS');
});

test('unobservable required state does not fail the comparison', () => {
  resetSeq();
  const o = mkObs([elem('textbox', 'Age', { state: {} })]);
  const v = compareIntent(o, { ...baseIntent, label: 'Age', required: true });
  assert.equal(v.verdict, 'VERIFIED', 'absence of evidence is not evidence of absence');
});

// ---------------------------------------------------------------------------
// Range comparison (scoring criterion 9).
// ---------------------------------------------------------------------------

const rangeIntent = {
  ...baseIntent,
  label: 'Heart Rate',
  canonical_type: 'integer',
  range_units: { min: 30, max: 200, units: 'bpm' },
};

test('a matching observed range is VERIFIED', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: { range: { min: 30, max: 200 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
});

test('a numeric control that states NO range is counted, not reported', () => {
  // Was AMBIGUOUS "the platform may have discarded the range". It does not
  // discard it: this designer keeps min/max in its own state and renders a
  // preview control carrying neither, so all 59 bounded fields in the study
  // reported a range that had in fact been applied. Absence of evidence is
  // not evidence of loss. The run still says so once, via `unobservable`.
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: {} })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
  assert.deepEqual(v.unobservable, ['range bounds']);
});

test('a wrong observed range is AMBIGUOUS', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: { range: { min: 0, max: 999 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'AMBIGUOUS');
  assert.match(v.reason, /30|200/);
});

test('a unit stated nowhere observable is counted, not reported', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate', { state: { range: { min: 30, max: 200 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
  assert.deepEqual(v.unobservable, ['units (bpm)']);
});

test('units stated beside the control satisfy the unit check', () => {
  // Units are not an ARIA concept, so a platform renders them where it likes.
  // This one puts them in a span next to the input, which PERCEIVE reports as
  // the group the control sits in.
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate', {
    state: { range: { min: 30, max: 200 } }, groupText: 'bpm',
  })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(v.verdict, 'VERIFIED', v.reason);
  assert.equal(v.unobservable, undefined, 'nothing went unchecked');
});

test('units found in the accessible name satisfy the unit check', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate bpm', { state: { range: { min: 30, max: 200 } } })]);
  assert.equal(compareIntent(o, rangeIntent).verdict, 'VERIFIED');
});

test('a label never resolves against a longer neighbouring label', () => {
  resetSeq();
  const o = mkObs([elem('spinbutton', 'Heart Rate Variability (ms)', { state: { range: { min: 0, max: 300 } } })]);
  const v = compareIntent(o, rangeIntent);
  assert.equal(
    v.verdict,
    'FAILED',
    'Heart Rate must not resolve against Heart Rate Variability — a field that ' +
    'resolves to its neighbour is a field that never gets built',
  );
});

test('a declared unit in the label is tolerated, an undeclared suffix is not', () => {
  resetSeq();
  const withUnit = mkObs([elem('spinbutton', 'Heart Rate (bpm)', { state: { range: { min: 30, max: 200 } } })]);
  assert.equal(compareIntent(withUnit, rangeIntent).verdict, 'VERIFIED');

  resetSeq();
  const withJunk = mkObs([elem('spinbutton', 'Heart Rate Extended', { state: { range: { min: 30, max: 200 } } })]);
  assert.equal(compareIntent(withJunk, rangeIntent).verdict, 'FAILED');
});
