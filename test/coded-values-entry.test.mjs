// Coded values are entered row by row. Two things make that non-obvious, and
// both were live defects (2026-09-05):
//
//  1. An editor that renders one row per existing value offers NO code/label
//     inputs until a row exists. The old code required those inputs before it
//     would press "+ Add Value" -- so on a field with no values it found
//     nothing, entered nothing, and reported nothing. Every choice field in
//     the study was left with "No values defined."
//
//  2. The element's OWN "Label" field shares its accessible name with each
//     row's "Label". Taking the last match is only safe if row labels are
//     aligned from the end; taking the first would rename the field to an
//     option label.
//
// Markup transcribed from esource-mock/src/ui/render.ts:583-609.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { findByRole, findAddCodedValueControl } from '../dist/bind-rung0.mjs';

const valueRow = (i, code, label) => `
<div class="value-row">
  <div class="row compact"><label for="value-code-${i}">Code</label>
    <input type="text" id="value-code-${i}" value="${code}"></div>
  <div class="row compact"><label for="value-label-${i}">Label</label>
    <input type="text" id="value-label-${i}" value="${label}"></div>
  <button type="button" id="value-remove-${i}">×</button></div>`;

const optionsPanel = (rows) => `<aside class="options"><h3>Options</h3>
<div class="row"><label for="opt-label">Label</label><input type="text" id="opt-label" value="Sex at Birth"></div>
<div class="row"><label for="opt-type">Element Type</label><select id="opt-type"><option>Radio Buttons</option></select></div>
<fieldset class="values"><legend>Values</legend>
${rows.map((r, i) => valueRow(i, r.code, r.label)).join('')}
<button type="button" id="value-add">+ Add Value</button>
<div class="row"><label for="value-paste">Paste Values (replaces list)</label><textarea id="value-paste"></textarea></div>
<button type="button" id="value-paste-apply">Apply Pasted Values</button></fieldset></aside>`;

const obsOf = (rows) => observe(
  new JSDOM(`<!doctype html><html><body><div id="app">${optionsPanel(rows)}</div></body></html>`).window.document,
);

// The selectors under test, mirroring executeFieldSetCodedValues.
const codesOf = (o) => findByRole(o, 'textbox', { contains: 'code' });
const rowLabelsOf = (o, codeCount) => {
  const codes = codesOf(o);
  const labels = findByRole(o, 'textbox', { contains: 'label' })
    .filter((c) => !codes.some((ci) => ci.el.handle === c.el.handle));
  return labels.slice(Math.max(0, labels.length - codeCount));
};
const addRowControlOf = (o) => findAddCodedValueControl(o);

test('an editor with no rows yet offers no code inputs — but does offer a way to add one', () => {
  const o = obsOf([]);
  assert.equal(codesOf(o).length, 0, 'no code inputs before a row exists');
  assert.ok(addRowControlOf(o), 'the row-adding control must be findable with zero rows');
  // This is the whole bug: the old guard `codeInputs.length > 0` was false
  // here, so the method returned having entered nothing.
});

test('once rows exist, each row pairs its own code and label', () => {
  const o = obsOf([{ code: '', label: '' }, { code: '', label: '' }, { code: '', label: '' }]);
  const codes = codesOf(o);
  assert.equal(codes.length, 3);
  const rowLabels = rowLabelsOf(o, codes.length);
  assert.equal(rowLabels.length, 3, 'one row label per code input');
});

test("a row label is never the element's own Label field", () => {
  const o = obsOf([{ code: '', label: '' }]);
  const codes = codesOf(o);
  const rowLabels = rowLabelsOf(o, codes.length);
  const ownLabel = findByRole(o, 'textbox', { contains: 'label' })
    .find((c) => c.el.state.value === 'Sex at Birth');
  assert.ok(ownLabel, 'the field\'s own Label input is present and shares the name');
  assert.equal(rowLabels.length, 1);
  assert.notEqual(
    rowLabels[0].el.handle, ownLabel.el.handle,
    "writing an option label into the field's own Label would rename the field",
  );
});

test('"Apply Pasted Values" is not mistaken for the row-adding control', () => {
  const o = obsOf([]);
  const add = addRowControlOf(o);
  assert.ok(add, 'Add Value must still be found');
  assert.equal(add.name, '+ Add Value');
  assert.ok(!add.name.toLowerCase().includes('paste'));
});
