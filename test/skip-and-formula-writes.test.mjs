/**
 * Skip-logic and formula write paths.
 *
 * Live Mock A showed 0/13 skip rules and 0/7 formulas despite structure being
 * otherwise correct. Defects found across iterations:
 *
 *  1. FORMULAS were never planned (no set_formula micro-step / contract op).
 *  2. SKIP LOGIC was planned at form end but (a) shared the field idempotency
 *     key so verified fields skipped the step, and (b) hardcoded selectOption
 *     (..., 'Conditional') which Mock A does not offer — options are
 *     "Visible" / "Visible When…".
 *  3. Reconcile adopts on structure only; adopt short-circuited set_skip_logic
 *     on re-runs, and prior escalated skip steps were never retried. Also,
 *     verify could pass on mode+equals without a whenElementId — but Mock A
 *     __readState only emits skipLogic when whenElementId is set.
 *
 * Markup transcribed from esource-mock options panel (Visibility + Formula).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { FieldPropertyWrites } from '../dist/field-properties.mjs';
import { stepIdempotencyKey, idempotencyKey } from '../dist/contract.mjs';
import { parseIRJson } from '../dist/plan-ir.mjs';
import { compilePlan, linearize, microOrder } from '../dist/plan-compiler.mjs';

const optionsPanel = ({
  visibilityMode = 'always',
  whenOptions = [],
  whenSelected = '',
  equalsValue = '',
  formula = '',
  showFormula = false,
} = {}) => {
  const modeOpts =
    visibilityMode === 'when'
      ? `<option value="always">Visible</option><option value="when" selected>Visible When…</option>`
      : `<option value="always" selected>Visible</option><option value="when">Visible When…</option>`;

  const whenBlock =
    visibilityMode === 'when'
      ? `<div class="row"><label for="opt-visibility-when">When Element</label>
           <select id="opt-visibility-when">
             <option value="">— choose element —</option>
             ${whenOptions
               .map(
                 (l) =>
                   `<option value="${l}"${l === whenSelected ? ' selected' : ''}>${l}</option>`,
               )
               .join('')}
           </select></div>
         <div class="row"><label for="opt-visibility-value">Equals Value</label>
           <input type="text" id="opt-visibility-value" value="${equalsValue}"></div>`
      : '';

  const formulaBlock = showFormula
    ? `<div class="row"><label for="opt-formula">Formula</label>
         <input type="text" id="opt-formula" value="${formula}"
           placeholder="e.g. Weight / (Height / 100) ^ 2"></div>`
    : '';

  return `<aside class="options"><h3>Options</h3>
<div class="row"><label for="opt-label">Label</label>
  <input type="text" id="opt-label" value="Gated Field"></div>
${formulaBlock}
<fieldset><legend>Element Visibility</legend>
  <div class="row"><label for="opt-visibility">Visibility</label>
    <select id="opt-visibility">${modeOpts}</select></div>
  ${whenBlock}
</fieldset></aside>`;
};

const obsOf = (opts) =>
  observe(
    new JSDOM(
      `<!doctype html><html><body><div id="app">${optionsPanel(opts)}</div></body></html>`,
    ).window.document,
  );

// ---------------------------------------------------------------------------
// Option picking — must use the select's own labels, never "Conditional".
// ---------------------------------------------------------------------------

test('pickConditionalModeOption prefers Visible When… over Visible', () => {
  const picked = FieldPropertyWrites.pickConditionalModeOption([
    'Visible',
    'Visible When…',
  ]);
  assert.equal(picked, 'Visible When…');
});

test('pickConditionalModeOption works on swapped-control wording', () => {
  const picked = FieldPropertyWrites.pickConditionalModeOption([
    'Always Shown',
    'Shown When...',
  ]);
  assert.equal(picked, 'Shown When...');
});

test('pickConditionalModeOption returns null when nothing looks conditional', () => {
  assert.equal(
    FieldPropertyWrites.pickConditionalModeOption(['Always', 'Never']),
    null,
  );
});

// ---------------------------------------------------------------------------
// Locating controls via ranking (Mock A labels).
// ---------------------------------------------------------------------------

test('findVisibilityModeControl finds the Visibility select', () => {
  const o = obsOf();
  const mode = FieldPropertyWrites.findVisibilityModeControl(o);
  assert.ok(mode, 'visibility control must be findable');
  assert.equal(mode.name.toLowerCase().includes('visibility'), true);
  assert.ok(mode.options.includes('Visible When…'));
});

test('after conditional mode, when + equals controls are findable', () => {
  const o = obsOf({
    visibilityMode: 'when',
    whenOptions: ['Controller', 'Other'],
    whenSelected: 'Controller',
    equalsValue: 'Yes',
  });
  const when = FieldPropertyWrites.findWhenFieldControl(o);
  const value = FieldPropertyWrites.findEqualsValueInput(o);
  assert.ok(when, 'when-element select present');
  assert.ok(value, 'equals-value input present');
  assert.equal(value.state.value, 'Yes');
  const check = FieldPropertyWrites.skipLogicLooksSet(o, 'Yes');
  assert.equal(check.ok, true, check.evidence);
});

test('findFormulaInput finds the Formula textbox on calculated fields', () => {
  const o = obsOf({ showFormula: true, formula: '' });
  const input = FieldPropertyWrites.findFormulaInput(o);
  assert.ok(input);
  assert.match(input.name.toLowerCase(), /formula|expression/);
});

test('formulaLooksSet confirms a matching expression', () => {
  const expr = 'Weight / (Height / 100) ^ 2';
  const o = obsOf({ showFormula: true, formula: expr });
  const check = FieldPropertyWrites.formulaLooksSet(o, expr);
  assert.equal(check.ok, true, check.evidence);
});

test('formulaLooksSet rejects a mismatched expression', () => {
  const o = obsOf({ showFormula: true, formula: '1 + 1' });
  const check = FieldPropertyWrites.formulaLooksSet(o, '2 + 2');
  assert.equal(check.ok, false);
});

// ---------------------------------------------------------------------------
// Step keys: skip logic must not share the field's verified key.
// ---------------------------------------------------------------------------

test('stepIdempotencyKey isolates set_skip_logic from the field body key', () => {
  const fieldKey = idempotencyKey('v0', 'v0.f0', 'v0.f0.d1');
  const body = stepIdempotencyKey({
    visit_id: 'v0',
    form_id: 'v0.f0',
    field_id: 'v0.f0.d1',
    kind: 'set_required',
  });
  const skip = stepIdempotencyKey({
    visit_id: 'v0',
    form_id: 'v0.f0',
    field_id: 'v0.f0.d1',
    kind: 'set_skip_logic',
  });
  assert.equal(body, fieldKey);
  assert.notEqual(skip, fieldKey);
  assert.ok(skip.endsWith('set_skip_logic'));
});

test('linearize emits set_formula for calculated fields and set_skip_logic at form end', () => {
  const ir = parseIRJson(
    JSON.stringify({
      ir_version: '1.0',
      study: { protocol_id: 'T', title: 'T' },
      visits: [
        {
          name: 'V1',
          window_start_day: 0,
          window_end_day: 1,
          forms: [
            {
              name: 'F1',
              repeating: false,
              fields: [
                { label: 'Controller', type: 'boolean', required: false },
                {
                  label: 'BMI',
                  type: 'calculated',
                  required: false,
                  formula: 'Weight / (Height / 100) ^ 2',
                  skip_logic: {
                    when_field_label: 'Controller',
                    equals_value: 'Yes',
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const field = ir.visits[0].forms[0].fields[1];
  assert.ok(microOrder(field).includes('set_formula'));
  const linear = linearize(compilePlan(ir));
  assert.ok(
    linear.some((i) => i.kind === 'set_formula' && i.label === 'BMI'),
    'set_formula must be planned',
  );
  const last = linear[linear.length - 1];
  assert.equal(last.kind, 'set_skip_logic');
  assert.equal(last.label, 'BMI');
});

test('swapped-control Expression label still ranks as the formula input', () => {
  // generalization/env-swapped-controls renames Formula -> Expression.
  const html = `<aside><label for="f">Expression</label>
    <input type="text" id="f" value="a + b"></aside>`;
  const o = observe(new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document);
  const input = FieldPropertyWrites.findFormulaInput(o);
  assert.ok(input);
  assert.equal(input.name.toLowerCase(), 'expression');
  assert.equal(FieldPropertyWrites.formulaLooksSet(o, 'a + b').ok, true);
});

test('findWhenFieldControl never returns the visibility mode select', () => {
  const o = obsOf({
    visibilityMode: 'when',
    whenOptions: ['Controller', 'Other'],
    whenSelected: 'Controller',
    equalsValue: 'Yes',
  });
  const when = FieldPropertyWrites.findWhenFieldControl(o);
  assert.ok(when);
  assert.equal(when.name, 'When Element');
  assert.equal(
    FieldPropertyWrites.looksLikeVisibilityModeOptions(when.options),
    false,
  );
  const mode = FieldPropertyWrites.findVisibilityModeControl(o);
  assert.ok(mode);
  assert.equal(
    FieldPropertyWrites.looksLikeVisibilityModeOptions(mode.options),
    true,
  );
});

test('skipLogicLooksSet fails when when-element is still the placeholder', () => {
  // Mode is conditional and equals is filled, but whenElementId is empty —
  // Mock A serialises skipLogic as null in that case.
  const html = `<aside class="options">
<fieldset><legend>Element Visibility</legend>
  <div class="row"><label for="opt-visibility">Visibility</label>
    <select id="opt-visibility">
      <option value="always">Visible</option>
      <option value="when" selected>Visible When…</option>
    </select></div>
  <div class="row"><label for="opt-visibility-when">When Element</label>
    <select id="opt-visibility-when">
      <option value="" selected>— choose element —</option>
      <option value="a">Controller</option>
    </select></div>
  <div class="row"><label for="opt-visibility-value">Equals Value</label>
    <input type="text" id="opt-visibility-value" value="Yes"></div>
</fieldset></aside>`;
  const o = observe(
    new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document,
  );
  const check = FieldPropertyWrites.skipLogicLooksSet(o, 'Yes', 'Controller');
  assert.equal(check.ok, false, check.evidence);
});

test('skipLogicLooksSet passes when when value is an opaque element id', () => {
  const html = `<aside class="options">
<fieldset><legend>Element Visibility</legend>
  <div class="row"><label for="opt-visibility">Visibility</label>
    <select id="opt-visibility">
      <option value="always">Visible</option>
      <option value="when" selected>Visible When…</option>
    </select></div>
  <div class="row"><label for="opt-visibility-when">When Element</label>
    <select id="opt-visibility-when">
      <option value="">— choose element —</option>
      <option value="el_42" selected>Controller</option>
    </select></div>
  <div class="row"><label for="opt-visibility-value">Equals Value</label>
    <input type="text" id="opt-visibility-value" value="Yes"></div>
</fieldset></aside>`;
  const o = observe(
    new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document,
  );
  const check = FieldPropertyWrites.skipLogicLooksSet(o, 'Yes', 'Controller');
  assert.equal(check.ok, true, check.evidence);
});
