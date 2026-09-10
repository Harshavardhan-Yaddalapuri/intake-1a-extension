/**
 * Rosetta v9 residuals:
 *   - required ~53%: Required checkbox often has empty accessible name because
 *     label[for=opt-required] points at a missing id; groupText still says
 *     "Required".
 *   - coded-pairs polluted with ('',''): canvas-refresh nudge clicked
 *     "+ Add Value" then failed to click the row delete control labelled "x"
 *     (only matched "×" / "remove").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import {
  findByRole,
  findAddCodedValueControl,
  findCodedValueRemoveControls,
  isCodedValueRemoveControl,
  bindFieldSetRequired,
} from '../dist/bind-rung0.mjs';

const hostileRequiredPanel = `
<aside class="options-panel">
  <div class="row"><label for="opt-label">Label</label>
    <input type="text" id="opt-label" value="Sex at Birth"></div>
  <div class="row checkbox">
    <input type="checkbox">
    <label for="opt-required">Required</label>
  </div>
  <div class="row checkbox">
    <input type="checkbox">
    <label for="opt-hidden">Hidden</label>
  </div>
  <fieldset class="values"><legend>Choices</legend>
    <div class="value-row">
      <div class="row"><label for="val-code-0">Code</label>
        <input type="text" id="val-code-0" value="F"></div>
      <div class="row"><label for="val-label-0">Label</label>
        <input type="text" id="val-label-0" value="Female"></div>
      <button type="button">x</button>
    </div>
    <div class="value-row">
      <div class="row"><label for="val-code-1">Code</label>
        <input type="text" id="val-code-1" value=""></div>
      <div class="row"><label for="val-label-1">Label</label>
        <input type="text" id="val-label-1" value=""></div>
      <button type="button">x</button>
    </div>
    <button type="button" id="val-add">+ Add Value</button>
    <button type="button" id="val-add-choice">+ Add Choice</button>
  </fieldset>
</aside>`;

const obsOf = (html) =>
  observe(new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document);

test('nameless Required checkbox is found via groupText', () => {
  const o = obsOf(hostileRequiredPanel);
  const cbs = findByRole(o, 'checkbox', { contains: 'require' });
  assert.ok(cbs.length >= 1, 'Required must resolve despite empty accessible name');
  assert.equal((cbs[0].el.name || cbs[0].el.groupText || '').toLowerCase().includes('requir'), true);
  const binding = bindFieldSetRequired(o);
  assert.ok(binding, 'field.set_required must bind on hostile Required markup');
});

test('Hidden is not preferred over Required when both are nameless', () => {
  const o = obsOf(hostileRequiredPanel);
  const cbs = findByRole(o, 'checkbox', { contains: 'require' });
  // Only Required's groupText contains "requir"; Hidden must not match.
  assert.ok(cbs.every((c) => /requir/i.test(c.el.name || c.el.groupText || '')));
});

test('row delete control labelled "x" is recognised', () => {
  assert.equal(isCodedValueRemoveControl('x'), true);
  assert.equal(isCodedValueRemoveControl('×'), true);
  assert.equal(isCodedValueRemoveControl('Remove'), true);
  assert.equal(isCodedValueRemoveControl('+ Add Value'), false);
  // Must not match field-level delete — live Rosetta v10 pruned choice fields
  // by clicking "Delete Element" (last delete_element match in document order).
  assert.equal(isCodedValueRemoveControl('Delete Element'), false);
  assert.equal(isCodedValueRemoveControl('Delete Node'), false);
  const o = obsOf(hostileRequiredPanel);
  const removes = findCodedValueRemoveControls(o);
  assert.ok(removes.length >= 2, `expected x buttons, got ${removes.map((e) => e.name)}`);
  assert.ok(removes.every((e) => e.name.toLowerCase() === 'x'));
});

test('"+ Add Choice" is accepted as a row-adding control (Nexus)', () => {
  const o = obsOf(hostileRequiredPanel);
  const valueOnly = obsOf(`<button type="button">+ Add Value</button>`);
  const choiceOnly = obsOf(`<button type="button">+ Add Choice</button>`);
  assert.equal(findAddCodedValueControl(valueOnly)?.name, '+ Add Value');
  assert.equal(findAddCodedValueControl(choiceOnly)?.name, '+ Add Choice');
  assert.ok(findAddCodedValueControl(o), 'panel with both add buttons still finds one');
});

test('nudge residue: blank trailing row is removable via x', () => {
  const o = obsOf(hostileRequiredPanel);
  const codes = findByRole(o, 'textbox', { contains: 'code' });
  assert.equal(codes.length, 2);
  const lastBlank = (codes[1].el.state.value ?? '') === '';
  assert.equal(lastBlank, true);
  const removes = findCodedValueRemoveControls(o);
  assert.ok(removes.length >= 1);
  assert.equal(removes[removes.length - 1].name.toLowerCase(), 'x');
});
