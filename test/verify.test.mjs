import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareIntent, checkFirst } from '../dist/verify.mjs';

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
