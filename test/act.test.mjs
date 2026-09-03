/**
 * ACT primitive unit tests (S3 verify step 1).
 *
 * Tests click/setValue/check/selectOption/stale-handle/transient-retry rules
 * against jsdom fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  resolveHandle,
  StaleHandleError,
  NotInteractableError,
  click,
  setValue,
  check,
  selectOption,
  assertHandleInObservation,
} from '../dist/act-primitives.mjs';
import { observe } from '../dist/perceive-core.mjs';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeDoc(html) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

const instantSettle = () => Promise.resolve();

function makeCtx(doc, obs) {
  return {
    doc,
    obs: obs ?? observe(doc),
    settle: instantSettle,
  };
}

// ---------------------------------------------------------------------------
// resolveHandle: structural path resolution.
// ---------------------------------------------------------------------------

test('ACT: resolveHandle finds element by structural path', () => {
  const doc = makeDoc('<div><p>hello</p><button>click</button></div>');
  // html(1) > body(0) > div(0) > button(1)  [html children: head(0), body(1); body.children: div(0); div.children: p(0), button(1)]
  const el = resolveHandle(doc, '1.0.1');
  assert.equal(el.tagName, 'BUTTON');
  assert.equal(el.textContent, 'click');
});

test('ACT: resolveHandle throws StaleHandleError for invalid path', () => {
  const doc = makeDoc('<div><p>hello</p></div>');
  assert.throws(
    () => resolveHandle(doc, '0.5'),
    (err) => err instanceof StaleHandleError,
  );
});

test('ACT: resolveHandle throws for deeply invalid path', () => {
  const doc = makeDoc('<div></div>');
  assert.throws(
    () => resolveHandle(doc, '0.0.0'),
    (err) => err instanceof StaleHandleError,
  );
});

// ---------------------------------------------------------------------------
// assertHandleInObservation: stale-handle guard.
// ---------------------------------------------------------------------------

test('ACT: assertHandleInObservation returns element for valid handle', () => {
  const doc = makeDoc('<button id="x">test</button>');
  const obs = observe(doc);
  const el = assertHandleInObservation(obs, obs.elements[0].handle, doc);
  assert.equal(el.name, 'test');
});

test('ACT: assertHandleInObservation throws for stale handle', () => {
  const doc = makeDoc('<button>test</button>');
  const obs = observe(doc);
  assert.throws(
    () => assertHandleInObservation(obs, '99.99.99', doc),
    (err) => err instanceof StaleHandleError,
  );
});

// ---------------------------------------------------------------------------
// click: basic click works.
// ---------------------------------------------------------------------------

test('ACT: click fires click event on target', async () => {
  const doc = makeDoc('<button id="btn">click me</button>');
  const btn = doc.getElementById('btn');
  let clicked = false;
  btn.addEventListener('click', () => { clicked = true; });
  const ctx = makeCtx(doc);
  const result = await click(ctx, ctx.obs.elements[0].handle);
  assert.equal(result.ok, true);
  assert.equal(clicked, true);
});

test('ACT: click on disabled button throws NotInteractableError', async () => {
  const doc = makeDoc('<button disabled>disabled</button>');
  const ctx = makeCtx(doc);
  await assert.rejects(
    () => click(ctx, ctx.obs.elements[0].handle),
    (err) => err instanceof NotInteractableError,
  );
});

test('ACT: click on stale handle throws StaleHandleError', async () => {
  const doc = makeDoc('<button>test</button>');
  const obs = observe(doc);
  const ctx = makeCtx(doc, obs);
  await assert.rejects(
    () => click(ctx, '99.99'),
    (err) => err instanceof StaleHandleError,
  );
});

// ---------------------------------------------------------------------------
// setValue: text input.
// ---------------------------------------------------------------------------

test('ACT: setValue sets value on input and fires events', async () => {
  const doc = makeDoc('<input type="text" id="x" />');
  const input = doc.getElementById('x');
  let inputEvent = false;
  let changeEvent = false;
  input.addEventListener('input', () => { inputEvent = true; });
  input.addEventListener('change', () => { changeEvent = true; });
  const ctx = makeCtx(doc);
  const result = await setValue(ctx, ctx.obs.elements[0].handle, 'hello');
  assert.equal(result.ok, true);
  assert.equal(input.value, 'hello');
  assert.equal(inputEvent, true);
  assert.equal(changeEvent, true);
});

test('ACT: setValue on textarea works', async () => {
  const doc = makeDoc('<textarea id="x"></textarea>');
  const ta = doc.getElementById('x');
  const ctx = makeCtx(doc);
  const result = await setValue(ctx, ctx.obs.elements[0].handle, 'multi\nline');
  assert.equal(result.ok, true);
  assert.equal(ta.value, 'multi\nline');
});

test('ACT: setValue on non-input throws WriteFailedError', async () => {
  const doc = makeDoc('<button id="x">click</button>');
  const ctx = makeCtx(doc);
  await assert.rejects(
    () => setValue(ctx, ctx.obs.elements[0].handle, 'text'),
    (err) => err instanceof Error && err.name === 'WriteFailedError',
  );
});

test('ACT: setValue is NOT retried (no double-submit)', async () => {
  const doc = makeDoc('<input type="text" id="x" />');
  const input = doc.getElementById('x');
  let writeCount = 0;
  input.addEventListener('input', () => { writeCount++; });
  const ctx = makeCtx(doc);
  await setValue(ctx, ctx.obs.elements[0].handle, 'test');
  assert.equal(writeCount, 1, 'setValue should write exactly once, no retry');
});

// ---------------------------------------------------------------------------
// check: checkbox and radio.
// ---------------------------------------------------------------------------

test('ACT: check sets checkbox checked=true', async () => {
  const doc = makeDoc('<input type="checkbox" id="x" />');
  const cb = doc.getElementById('x');
  let changeFired = false;
  cb.addEventListener('change', () => { changeFired = true; });
  const ctx = makeCtx(doc);
  const result = await check(ctx, ctx.obs.elements[0].handle, true);
  assert.equal(result.ok, true);
  assert.equal(cb.checked, true);
  assert.equal(changeFired, true);
});

test('ACT: check unchecks when checked=false', async () => {
  const doc = makeDoc('<input type="checkbox" id="x" checked />');
  const cb = doc.getElementById('x');
  const ctx = makeCtx(doc);
  const result = await check(ctx, ctx.obs.elements[0].handle, false);
  assert.equal(result.ok, true);
  assert.equal(cb.checked, false);
});

test('ACT: check on radio sets checked', async () => {
  const doc = makeDoc('<input type="radio" id="x" name="grp" />');
  const radio = doc.getElementById('x');
  const ctx = makeCtx(doc);
  const result = await check(ctx, ctx.obs.elements[0].handle, true);
  assert.equal(result.ok, true);
  assert.equal(radio.checked, true);
});

test('ACT: check on ARIA checkbox sets aria-checked', async () => {
  const doc = makeDoc('<div role="checkbox" aria-checked="false" tabindex="0">agree</div>');
  const ctx = makeCtx(doc);
  const result = await check(ctx, ctx.obs.elements[0].handle, true);
  assert.equal(result.ok, true);
  const el = doc.querySelector('[role="checkbox"]');
  assert.equal(el.getAttribute('aria-checked'), 'true');
});

test('ACT: check on non-checkbox throws WriteFailedError', async () => {
  const doc = makeDoc('<input type="text" id="x" />');
  const ctx = makeCtx(doc);
  await assert.rejects(
    () => check(ctx, ctx.obs.elements[0].handle, true),
    (err) => err instanceof Error && err.name === 'WriteFailedError',
  );
});

// ---------------------------------------------------------------------------
// selectOption: <select> and ARIA listbox.
// ---------------------------------------------------------------------------

test('ACT: selectOption selects by visible label in <select>', async () => {
  const doc = makeDoc(`
    <select id="x">
      <option value="a">Apple</option>
      <option value="b">Banana</option>
      <option value="c">Cherry</option>
    </select>
  `);
  const sel = doc.getElementById('x');
  let changeFired = false;
  sel.addEventListener('change', () => { changeFired = true; });
  const ctx = makeCtx(doc);
  const result = await selectOption(ctx, ctx.obs.elements[0].handle, 'Banana');
  assert.equal(result.ok, true);
  assert.equal(sel.value, 'b');
  assert.equal(changeFired, true);
});

test('ACT: selectOption returns error for missing option', async () => {
  const doc = makeDoc(`
    <select id="x">
      <option value="a">Apple</option>
    </select>
  `);
  const ctx = makeCtx(doc);
  const result = await selectOption(ctx, ctx.obs.elements[0].handle, 'Grape');
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('not found'));
});

test('ACT: selectOption on ARIA listbox clicks matching option', async () => {
  const doc = makeDoc(`
    <div role="listbox" id="x" tabindex="0">
      <div role="option" id="a">Apple</div>
      <div role="option" id="b">Banana</div>
    </div>
  `);
  let clickedOption = '';
  const optB = doc.getElementById('b');
  optB.addEventListener('click', () => { clickedOption = 'b'; });
  const ctx = makeCtx(doc);
  const result = await selectOption(ctx, ctx.obs.elements[0].handle, 'Banana');
  assert.equal(result.ok, true);
  assert.equal(clickedOption, 'b');
});

test('ACT: selectOption is NOT retried (write, no double-submit)', async () => {
  const doc = makeDoc(`
    <select id="x">
      <option value="a">Apple</option>
      <option value="b">Banana</option>
    </select>
  `);
  const sel = doc.getElementById('x');
  let changeCount = 0;
  sel.addEventListener('change', () => { changeCount++; });
  const ctx = makeCtx(doc);
  await selectOption(ctx, ctx.obs.elements[0].handle, 'Banana');
  assert.equal(changeCount, 1, 'selectOption should fire change exactly once');
});

// ---------------------------------------------------------------------------
// Transient retry: click with canRetry=true.
// ---------------------------------------------------------------------------

test('ACT: click succeeds on first try (retried=false)', async () => {
  const doc = makeDoc('<button id="btn">retry me</button>');
  let clickCount = 0;
  const btn = doc.getElementById('btn');
  btn.addEventListener('click', () => { clickCount++; });
  const ctx = makeCtx(doc);
  const result = await click(ctx, ctx.obs.elements[0].handle, true);
  assert.equal(result.ok, true);
  assert.equal(clickCount, 1);
  assert.equal(result.retried, false);
});

// ---------------------------------------------------------------------------
// Stale handle: handle from old observation.
// ---------------------------------------------------------------------------

test('ACT: stale handle from old observation is caught before click', async () => {
  const doc = makeDoc('<button>old</button>');
  const oldObs = observe(doc);
  // Now change the DOM so the handle is stale.
  doc.body.innerHTML = '<div><button>new</button></div>';
  // The handle from oldObs refers to the old button which is gone.
  const ctx = makeCtx(doc, oldObs);
  await assert.rejects(
    () => click(ctx, oldObs.elements[0].handle),
    (err) => err instanceof StaleHandleError,
  );
});

// ---------------------------------------------------------------------------
// Bind rung0 tests: structural binding from observation.
// ---------------------------------------------------------------------------

test('BIND rung0: bindFieldSetLabel finds textbox with "label" in name', async () => {
  const { bindFieldSetLabel } = await import('../dist/bind-rung0.mjs');
  const doc = makeDoc(`
    <div>
      <label for="lbl">Label</label>
      <input type="text" id="lbl" />
    </div>
  `);
  const obs = observe(doc);
  const binding = bindFieldSetLabel(obs);
  assert.ok(binding, 'should find a binding');
  assert.equal(binding.op, 'field.set_label');
  assert.equal(binding.rung, 0);
});

test('BIND rung0: bindCtxCommit finds save button as hypothesis', async () => {
  const { bindCtxCommit } = await import('../dist/bind-rung0.mjs');
  const doc = makeDoc(`
    <button>Save</button>
    <button>Activate</button>
  `);
  const obs = observe(doc);
  const binding = bindCtxCommit(obs);
  assert.ok(binding, 'should find a commit candidate');
  assert.equal(binding.op, 'ctx.commit');
  assert.ok(binding.evidence.some((e) => e.includes('hypothesis')), 'should be flagged as hypothesis');
});

test('BIND rung0: bindFieldAdd for single_select finds hypothesis button', async () => {
  const { bindFieldAdd } = await import('../dist/bind-rung0.mjs');
  const doc = makeDoc(`
    <button>Dropdown</button>
    <button>Radio Buttons</button>
  `);
  const obs = observe(doc);
  const binding = bindFieldAdd(obs, 'single_select');
  assert.ok(binding, 'should find a candidate for single_select');
  assert.equal(binding.op, 'field.add');
  assert.ok(binding.evidence.some((e) => e.includes('hypothesis')), 'name-only match should be hypothesis');
});

test('BIND rung0: bindFieldAdd for radio finds different button than single_select', async () => {
  const { bindFieldAdd } = await import('../dist/bind-rung0.mjs');
  const doc = makeDoc(`
    <button>Dropdown</button>
    <button>Radio Buttons</button>
  `);
  const obs = observe(doc);
  const singleBinding = bindFieldAdd(obs, 'single_select');
  const radioBinding = bindFieldAdd(obs, 'radio');
  assert.ok(singleBinding, 'single_select binding should exist');
  assert.ok(radioBinding, 'radio binding should exist');
  // They should bind to different buttons (different names in evidence).
  const singleName = singleBinding.recipe[0].evidence_name;
  const radioName = radioBinding.recipe[0].evidence_name;
  assert.notEqual(singleName, radioName, 'single_select and radio must bind to different buttons');
});

// ---------------------------------------------------------------------------
// Bind rung1 tests: probe analysis functions.
// ---------------------------------------------------------------------------

test('BIND rung1: classifyTypeFromProbe distinguishes single_select from radio', async () => {
  const { classifyTypeFromProbe } = await import('../dist/bind-rung1.mjs');
  // A combobox is single_select, not radio.
  const comboProbe = {
    observedRole: 'combobox',
    observedOptions: ['A', 'B'],
    mutualExclusivity: 'single',
    evidence: [],
    destructive: false,
    discarded: false,
  };
  const singleResult = classifyTypeFromProbe('single_select', comboProbe);
  assert.equal(singleResult.matches, true, 'combobox matches single_select');
  const radioResult = classifyTypeFromProbe('radio', comboProbe);
  assert.equal(radioResult.matches, false, 'combobox does NOT match radio');

  // A radiogroup is radio, not single_select.
  const radioProbe = {
    observedRole: 'radiogroup',
    observedOptions: ['A', 'B', 'C'],
    mutualExclusivity: 'single',
    evidence: [],
    destructive: false,
    discarded: false,
  };
  const singleFromRadio = classifyTypeFromProbe('single_select', radioProbe);
  assert.equal(singleFromRadio.matches, false, 'radiogroup does NOT match single_select');
  const radioFromRadio = classifyTypeFromProbe('radio', radioProbe);
  assert.equal(radioFromRadio.matches, true, 'radiogroup matches radio');
});

test('BIND rung1: classifyTypeFromProbe distinguishes checkbox from multi_select', async () => {
  const { classifyTypeFromProbe } = await import('../dist/bind-rung1.mjs');
  // A single checkbox is checkbox, not multi_select.
  const checkboxProbe = {
    observedRole: 'checkbox',
    observedOptions: [],
    mutualExclusivity: 'n/a',
    evidence: [],
    destructive: false,
    discarded: false,
  };
  const cbResult = classifyTypeFromProbe('checkbox', checkboxProbe);
  assert.equal(cbResult.matches, true, 'single checkbox matches checkbox');
  const multiResult = classifyTypeFromProbe('multi_select', checkboxProbe);
  assert.equal(multiResult.matches, false, 'single checkbox does NOT match multi_select');

  // A listbox is multi_select, not checkbox.
  const listboxProbe = {
    observedRole: 'listbox',
    observedOptions: ['A', 'B'],
    mutualExclusivity: 'multiple',
    evidence: [],
    destructive: false,
    discarded: false,
  };
  const cbFromListbox = classifyTypeFromProbe('checkbox', listboxProbe);
  assert.equal(cbFromListbox.matches, false, 'listbox does NOT match checkbox');
  const multiFromListbox = classifyTypeFromProbe('multi_select', listboxProbe);
  assert.equal(multiFromListbox.matches, true, 'listbox matches multi_select');
});

test('BIND rung1: analyzeAppendReplace detects append mode', async () => {
  const { analyzeAppendReplace } = await import('../dist/bind-rung1.mjs');
  const result = analyzeAppendReplace(['First'], ['First', 'Second']);
  assert.equal(result.mode, 'append');
  assert.ok(result.evidence.some((e) => e.includes('append')));
});

test('BIND rung1: analyzeAppendReplace detects replace mode', async () => {
  const { analyzeAppendReplace } = await import('../dist/bind-rung1.mjs');
  const result = analyzeAppendReplace(['First'], ['Second']);
  assert.equal(result.mode, 'replace');
  assert.ok(result.evidence.some((e) => e.includes('replace')));
});

test('BIND rung1: analyzeFormReuse detects reuse policy', async () => {
  const { analyzeFormReuse } = await import('../dist/bind-rung1.mjs');
  const reuse = analyzeFormReuse('Demographics', true);
  assert.equal(reuse.policy, 'reuse');
  const rebuild = analyzeFormReuse('Demographics', false);
  assert.equal(rebuild.policy, 'rebuild');
});

test('BIND rung1: detectDisposability detects persistent creation', async () => {
  const { detectDisposability } = await import('../dist/bind-rung1.mjs');
  const before = observe(makeDoc('<button>test</button><div>placed control</div>'));
  const after = observe(makeDoc('<button>test</button><div>placed control</div>'));
  const result = detectDisposability(before, after);
  assert.equal(result.disposable, false, 'same elements survive = not disposable');
});

test('BIND rung1: detectDisposability detects disposable working copy', async () => {
  const { detectDisposability } = await import('../dist/bind-rung1.mjs');
  // The "placed control" needs to be interactive to appear in observation.
  const before = observe(makeDoc('<button>test</button><div role="button">placed control</div>'));
  const after = observe(makeDoc('<button>test</button>'));
  const result = detectDisposability(before, after);
  assert.equal(result.disposable, true, 'element removed = disposable');
});