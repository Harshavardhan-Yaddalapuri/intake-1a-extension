/**
 * Background service worker.
 *
 * S1 scope: receive Observations from the content script and hold the latest
 * one (plus its diff) in memory and chrome.storage.session. Later stages
 * (BIND/ACT/VERIFY/plan) will consume this as their perception source.
 */
import type { Observation, Diff } from './perceive/core';

interface ObserveResult {
  ok: boolean;
  observation?: Observation;
  diff?: Diff | null;
  error?: string;
}

async function observeTab(tabId: number): Promise<ObserveResult> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PERCEIVE_OBSERVE' });
    return response as ObserveResult;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'OBSERVE_ACTIVE_TAB') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      const result = await observeTab(tab.id);
      if (result.ok && result.observation) {
        await chrome.storage.session.set({
          lastObservation: result.observation,
          lastDiff: result.diff ?? null,
        });
      }
      sendResponse(result);
    })();
    return true; // async response
  }
  return false;
});
