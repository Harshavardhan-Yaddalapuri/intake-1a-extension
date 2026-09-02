import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIRJson } from '../dist/plan-ir.mjs';
import { compilePlan, linearize, microOrder } from '../dist/plan-compiler.mjs';

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

test('micro-order: add -> label -> range -> type -> coded -> required', () => {
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
    'set_range',
    'type_refinement',
    'set_coded_values',
    'set_required',
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
