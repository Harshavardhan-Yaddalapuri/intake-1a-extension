/**
 * PERCEIVE content script.
 *
 * Injected into every page. Observes the live DOM on demand and posts the
 * serialized Observation (plus a diff against the previous snapshot) to the
 * background service worker. PERCEIVE cannot write: it only reads and reports.
 */
import { observe, diffObservations, type Observation, type Diff } from './core';

let previous: Observation | null = null;

function snapshot(): { observation: Observation; diff: Diff | null } {
  const observation = observe(document);
  const diff = previous ? diffObservations(previous, observation) : null;
  previous = observation;
  return { observation, diff };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'PERCEIVE_OBSERVE') {
    try {
      const result = snapshot();
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return false;
  }
  return false;
});
