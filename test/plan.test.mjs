import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIRJson } from '../dist/plan-ir.mjs';
import { compilePlan, linearize, microOrder } from '../dist/plan-compiler.mjs';
import { CONTRACT_OPS } from '../dist/contract.mjs';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function syntheticIR(fields) {
  return {
    ir_version: '1.0',
    study: { protocol_id: 'SYNTH', title: 'Synthetic' },
    visits: [
      {
        name: 'V1',
        window_start_day: 0,
        window_end_day: 1,
        forms: [{ name: 'F1', repeating: false, fields }],
      },
    ],
  };
}

function field(label, type, extra = {}) {
  return { label, type, required: false, ...extra };
}

// ---------------------------------------------------------------------------
// IR parser.
// ---------------------------------------------------------------------------

test('parser: derives stable structural ids from position', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('A', 'text'),
        field('B', 'boolean'),
      ]),
    ),
  );
  assert.equal(ir.visits[0].visit_id, 'v0');
  assert.equal(ir.visits[0].forms[0].form_id, 'v0.f0');
  assert.equal(ir.visits[0].forms[0].fields[0].field_id, 'v0.f0.d0');
  assert.equal(ir.visits[0].forms[0].fields[1].field_id, 'v0.f0.d1');
});

test('parser: rejects unknown canonical type', () => {
  assert.throws(
    () => parseIRJson(JSON.stringify(syntheticIR([field('A', 'not_a_type')]))),
    /unknown type/,
  );
});

test('parser: rejects partial range (min without max/units)', () => {
  assert.throws(
    () => parseIRJson(JSON.stringify(syntheticIR([field('A', 'integer', { min: 0 })])),
    ),
    /partial range/,
  );
});

test('parser: preserves coded pairs and skip logic', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('Choice', 'single_select', {
          options: [
            { code: 'X', label: 'X Label' },
            { code: 'Y', label: 'Y Label' },
          ],
        }),
        field('Gated', 'text', {
          skip_logic: { when_field_label: 'Choice', equals_value: 'X' },
        }),
      ]),
    ),
  );
  const f0 = ir.visits[0].forms[0].fields[0];
  assert.deepEqual(f0.options, [
    { code: 'X', label: 'X Label' },
    { code: 'Y', label: 'Y Label' },
  ]);
  const f1 = ir.visits[0].forms[0].fields[1];
  assert.deepEqual(f1.skip_logic, { when_field_label: 'Choice', equals_value: 'X' });
});

// ---------------------------------------------------------------------------
// Topo sort stability.
// ---------------------------------------------------------------------------

test('topo sort: controlling field precedes controlled field', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('Gated', 'text', { skip_logic: { when_field_label: 'Controller', equals_value: 'Yes' } }),
        field('Controller', 'boolean'),
      ]),
    ),
  );
  const plan = compilePlan(ir);
  const form = plan.visits[0].forms[0];
  assert.equal(form.halted, false);
  const order = form.fields.map((f) => f.label);
  assert.deepEqual(order, ['Controller', 'Gated']);
});

test('topo sort: stable secondary ordering preserves input order for independents', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('A', 'text'),
        field('B', 'text'),
        field('C', 'text'),
      ]),
    ),
  );
  const plan = compilePlan(ir);
  const order = plan.visits[0].forms[0].fields.map((f) => f.label);
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('topo sort: cycle is detected and halts the form', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('A', 'boolean', { skip_logic: { when_field_label: 'B', equals_value: 'Yes' } }),
        field('B', 'boolean', { skip_logic: { when_field_label: 'A', equals_value: 'Yes' } }),
      ]),
    ),
  );
  const plan = compilePlan(ir);
  const form = plan.visits[0].forms[0];
  assert.equal(form.halted, true);
  assert.equal(form.fields.length, 0);
  assert.ok(plan.errors.some((e) => e.kind === 'cycle'));
});

test('topo sort: unknown controlling label is an error, field built without skip', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('Gated', 'text', { skip_logic: { when_field_label: 'Does Not Exist', equals_value: 'Yes' } }),
      ]),
    ),
  );
  const plan = compilePlan(ir);
  assert.ok(plan.errors.some((e) => e.kind === 'unknown_label'));
  // The field is still built (recall over precision), just without skip logic.
  const form = plan.visits[0].forms[0];
  assert.equal(form.halted, false);
  assert.equal(form.fields.length, 1);
  assert.equal(form.skip_steps.length, 0);
});

// ---------------------------------------------------------------------------
// Micro-ordering.
// ---------------------------------------------------------------------------

// Was: add -> label -> range -> type -> coded -> required. That order set the
// range BEFORE refining the type, and a platform that discards values the new
// type cannot hold does so silently — so the range vanished with nothing to
// report it. Type is now settled first, and a verify_range read-back closes
// the field.
test('micro-order: add -> label -> type -> range -> coded -> required -> verify', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('Num', 'integer', {
          min: 0,
          max: 10,
          units: 'mg',
          options: [{ code: 'A', label: 'A' }],
        }),
      ]),
    ),
  );
  const f = ir.visits[0].forms[0].fields[0];
  assert.deepEqual(microOrder(f), [
    'add',
    'set_label',
    'type_refinement',
    'set_range',
    'set_coded_values',
    'set_required',
    'verify_range',
  ]);
});

test('micro-order: no range step when field has no range', () => {
  const ir = parseIRJson(JSON.stringify(syntheticIR([field('T', 'text')])));
  const f = ir.visits[0].forms[0].fields[0];
  assert.deepEqual(microOrder(f), ['add', 'set_label', 'type_refinement', 'set_required']);
});

// ---------------------------------------------------------------------------
// Linearization.
// ---------------------------------------------------------------------------

test('linearize: skip logic steps are appended at form end', () => {
  const ir = parseIRJson(
    JSON.stringify(
      syntheticIR([
        field('Controller', 'boolean'),
        field('Gated', 'text', { skip_logic: { when_field_label: 'Controller', equals_value: 'Yes' } }),
      ]),
    ),
  );
  const plan = compilePlan(ir);
  const linear = linearize(plan);
  const last = linear[linear.length - 1];
  assert.equal(last.kind, 'set_skip_logic');
  assert.match(last.description, /Gated/);
  assert.match(last.description, /Controller/);
});

test('linearize: deterministic across two compilations', () => {
  const text = JSON.stringify(
    syntheticIR([
      field('A', 'text'),
      field('B', 'boolean'),
      field('C', 'text', { skip_logic: { when_field_label: 'B', equals_value: 'Yes' } }),
    ]),
  );
  const plan1 = compilePlan(parseIRJson(text));
  const plan2 = compilePlan(parseIRJson(text));
  assert.deepEqual(linearize(plan1), linearize(plan2));
});

// ---------------------------------------------------------------------------
// form.list_fields: the operation reconciliation is built on.
// ---------------------------------------------------------------------------

test('contract includes form.list_fields', () => {
  assert.ok(
    CONTRACT_OPS.includes('form.list_fields'),
    'reconciliation requires an operation that enumerates the fields in an open form',
  );
});

test('contract has 18 operations', () => {
  assert.equal(CONTRACT_OPS.length, 18);
});

test('every linear item carries its canonical type and human-readable names', () => {
  const plan = compilePlan(
    parseIRJson(JSON.stringify(syntheticIR([
      field('Age', 'integer', { min: 0, max: 120 }),
      field('Sex', 'single_select', { options: [{ code: 'M', label: 'Male' }] }),
    ]))),
  );
  for (const item of linearize(plan)) {
    assert.ok(item.canonical_type, `item ${item.field_id} has no canonical_type`);
    assert.ok(item.visit_name, `item ${item.field_id} has no visit_name`);
    assert.ok(item.form_name, `item ${item.field_id} has no form_name`);
  }
});

// ---------------------------------------------------------------------------
// Type-before-range ordering (the silent-discard trap).
// ---------------------------------------------------------------------------

test('the type is settled before the range is set', () => {
  const order = microOrder({ label: 'HR', canonical_type: 'integer', required: false,
                             range: { min: 30, max: 200, units: 'bpm' } });
  assert.ok(
    order.indexOf('type_refinement') < order.indexOf('set_range'),
    'setting a range before refining the type loses it silently when the type changes',
  );
});

test('a field with a range re-reads it after every step that could touch the type', () => {
  const order = microOrder({ label: 'HR', canonical_type: 'integer', required: false,
                             range: { min: 30, max: 200, units: 'bpm' } });
  assert.equal(order[order.length - 1], 'verify_range', 'the read-back must come last');
  assert.ok(order.lastIndexOf('verify_range') > order.lastIndexOf('set_range'));
});

test('a field with no range gets no range steps at all', () => {
  const order = microOrder({ label: 'Name', canonical_type: 'text', required: false });
  assert.ok(!order.includes('set_range'));
  assert.ok(!order.includes('verify_range'));
});

test('set_range never precedes the add step for the same field', () => {
  const plan = compilePlan(parseIRJson(JSON.stringify(syntheticIR([
    field('HR', 'integer', { min: 30, max: 200, units: 'bpm' }),
  ]))));
  const seen = new Map();
  for (const item of linearize(plan)) {
    const prior = seen.get(item.field_id) ?? [];
    if (item.kind === 'set_range') {
      assert.ok(prior.includes('add'),
        `set_range for "${item.label}" is ordered before the control exists`);
    }
    seen.set(item.field_id, [...prior, item.kind]);
  }
});
