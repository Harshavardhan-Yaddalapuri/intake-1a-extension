// test/tab-driver.test.mjs
//
// Covers the self-healing re-injection added to sendToTab: when the content
// script is missing from a tab -- most commonly because the extension was
// reloaded (a new build) while the tab was already open, which Chrome does
// not retroactively fix -- the driver re-injects it once via
// chrome.scripting.executeScript rather than retrying the same dead message
// forever.
//
// chrome.* is a global the extension APIs are called on directly (no import),
// so it is stubbed as a plain global object here.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TabDriver, TabDriverError } from '../dist/tab-driver.mjs';

const NO_RECEIVER = new Error(
  'Could not establish connection. Receiving end does not exist.',
);

function observation() {
  return { snapshotId: 's', url: 'u', title: 't', timestamp: 0, elements: [] };
}

let sendMessageCalls;
let executeScriptCalls;

beforeEach(() => {
  sendMessageCalls = [];
  executeScriptCalls = [];
});

function installChrome({ sendMessageImpl, executeScriptImpl }) {
  globalThis.chrome = {
    tabs: {
      sendMessage: async (tabId, message) => {
        sendMessageCalls.push({ tabId, message });
        return sendMessageImpl(sendMessageCalls.length);
      },
    },
    scripting: {
      executeScript: async (opts) => {
        executeScriptCalls.push(opts);
        return executeScriptImpl ? executeScriptImpl() : undefined;
      },
    },
  };
}

test('re-injects the content script once when no receiver exists, then succeeds', async () => {
  installChrome({
    sendMessageImpl: (n) => {
      if (n === 1) throw NO_RECEIVER;
      return { ok: true, observation: observation(), diff: null };
    },
  });

  const driver = new TabDriver(42);
  const result = await driver.perceive();

  assert.equal(executeScriptCalls.length, 1, 'must re-inject exactly once');
  assert.deepEqual(executeScriptCalls[0].target, { tabId: 42 });
  assert.deepEqual(executeScriptCalls[0].files, ['content.js']);
  assert.equal(sendMessageCalls.length, 2, 'the retry after injection must resend the same message');
  assert.deepEqual(sendMessageCalls[1].message, sendMessageCalls[0].message);
  assert.ok(result.observation);
});

test('does not re-inject more than once even if the no-receiver error persists', async () => {
  installChrome({
    sendMessageImpl: () => { throw NO_RECEIVER; },
  });

  const driver = new TabDriver(7);
  await assert.rejects(() => driver.perceive(), TabDriverError);

  assert.equal(
    executeScriptCalls.length, 1,
    'injection is attempted once, not on every retry -- a platform that ' +
    'genuinely has no listener must not be hammered with repeated injections',
  );
});

test('a hard error is not treated as a missing content script', async () => {
  installChrome({
    sendMessageImpl: () => { throw new Error('some other failure'); },
  });

  const driver = new TabDriver(7);
  await assert.rejects(() => driver.perceive(), (err) => {
    assert.ok(err instanceof TabDriverError);
    assert.match(err.message, /some other failure/);
    return true;
  });

  assert.equal(executeScriptCalls.length, 0, 'a non-connection error must not trigger injection');
  assert.equal(sendMessageCalls.length, 1, 'a hard error must not be retried');
});

test('an injection failure falls through to the timing-race retry rather than crashing', async () => {
  installChrome({
    sendMessageImpl: (n) => {
      if (n === 1) throw NO_RECEIVER;
      return { ok: true, observation: observation(), diff: null };
    },
    // Injection itself can fail (e.g. a page executeScript cannot reach);
    // that must not be fatal on its own.
    executeScriptImpl: () => { throw new Error('Cannot access this page'); },
  });

  const driver = new TabDriver(9);
  const result = await driver.perceive();

  assert.equal(executeScriptCalls.length, 1);
  assert.ok(result.observation, 'must still recover via the wait-and-retry path');
});
