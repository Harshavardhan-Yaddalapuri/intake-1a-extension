import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transition,
  newRunState,
  memoryStorageAdapter,
  loadRunState,
  saveRunState,
  applyTransition,
} from '../dist/state-machine.mjs';

function item(state = 'pending', rebind_count = 0) {
  return {
    key: 'v0\u0000f0\u0000d0',
    visit_id: 'v0',
    form_id: 'f0',
    field_id: 'd0',
    state,
    rebind_count,
  };
}

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

test('state machine: happy path pending -> verified', () => {
  let it = item();
  const events = [
    'begin_binding',
    'bound',
    'begin_acting',
    'act_done',
    'verify_verified',
  ];
  for (const ev of events) {
    const r = transition(it, ev);
    assert.equal(r.ok, true, `${ev} should be valid from ${it.state}`);
    it = r.item;
  }
  assert.equal(it.state, 'verified');
  assert.equal(it.last_verdict, 'VERIFIED');
});

// ---------------------------------------------------------------------------
// Failed -> rebind once -> escalate.
// ---------------------------------------------------------------------------

test('state machine: failed rebinds once, then escalates', () => {
  let it = item();
  for (const ev of ['begin_binding', 'bound', 'begin_acting', 'act_done']) {
    it = transition(it, ev).item;
  }
  // First failure: rebind.
  let r = transition(it, 'verify_failed');
  assert.equal(r.ok, true);
  assert.equal(r.item.state, 'binding');
  assert.equal(r.item.rebind_count, 1);
  it = r.item;

  // Rebind -> act -> verify -> fail again: escalate.
  for (const ev of ['bound', 'begin_acting', 'act_done']) {
    it = transition(it, ev).item;
  }
  r = transition(it, 'verify_failed');
  assert.equal(r.ok, true);
  assert.equal(r.item.state, 'escalated');
  assert.equal(r.item.rebind_count, 1);
});

// ---------------------------------------------------------------------------
// Ambiguous -> escalate (never auto-retry).
// ---------------------------------------------------------------------------

test('state machine: ambiguous escalates immediately, no rebind', () => {
  let it = item();
  for (const ev of ['begin_binding', 'bound', 'begin_acting', 'act_done']) {
    it = transition(it, ev).item;
  }
  const r = transition(it, 'verify_ambiguous');
  assert.equal(r.ok, true);
  assert.equal(r.item.state, 'escalated');
  assert.equal(r.item.rebind_count, 0);
  assert.equal(r.item.last_verdict, 'AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// Invalid transitions.
// ---------------------------------------------------------------------------

test('state machine: invalid transition is rejected', () => {
  const r = transition(item('pending'), 'bound');
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid transition/);
});

test('state machine: escalate is valid from any state', () => {
  for (const state of ['pending', 'binding', 'ready', 'acting', 'verifying', 'verified']) {
    const r = transition(item(state), 'escalate');
    assert.equal(r.ok, true);
    assert.equal(r.item.state, 'escalated');
  }
});

// ---------------------------------------------------------------------------
// Persistence / resume.
// ---------------------------------------------------------------------------

test('state machine: run state persists and resumes from storage stub', async () => {
  const adapter = memoryStorageAdapter();
  const keys = ['v0\u0000f0\u0000d0', 'v0\u0000f0\u0000d1'];
  const state = newRunState('run-1', 'http://test', keys);
  await saveRunState(adapter, state);

  // Simulate a reload: load from a fresh adapter backed by the same store.
  const loaded = await loadRunState(adapter);
  assert.ok(loaded);
  assert.equal(loaded.run_id, 'run-1');
  assert.equal(loaded.items['v0\u0000f0\u0000d0'].state, 'pending');
  assert.equal(loaded.order.length, 2);
});

test('state machine: applyTransition persists the new state', async () => {
  const adapter = memoryStorageAdapter();
  const keys = ['v0\u0000f0\u0000d0'];
  const state = newRunState('run-1', 'http://test', keys);
  await saveRunState(adapter, state);

  const r = await applyTransition(adapter, state, 'v0\u0000f0\u0000d0', 'begin_binding');
  assert.equal(r.ok, true);
  assert.equal(r.item.state, 'binding');

  const reloaded = await loadRunState(adapter);
  assert.equal(reloaded.items['v0\u0000f0\u0000d0'].state, 'binding');
});

test('state machine: applyTransition on unknown key fails', async () => {
  const adapter = memoryStorageAdapter();
  const state = newRunState('run-1', 'http://test', ['v0\u0000f0\u0000d0']);
  const r = await applyTransition(adapter, state, 'nope', 'begin_binding');
  assert.equal(r.ok, false);
});
