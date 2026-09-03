/**
 * PERCEIVE + ACT content script.
 *
 * Injected into every page. Handles two message types:
 *   1. PERCEIVE_OBSERVE: observe the live DOM and return an Observation.
 *   2. ACT_EXECUTE: execute a DOM primitive (click, setValue, check, selectOption).
 *   3. PERCEIVE_AND_SETTLE: wait a delay, then observe (for post-mutation read-back).
 *
 * PERCEIVE cannot write; ACT cannot decide. Both walls are enforced here:
 * the content script is a dumb executor of commands from the service worker.
 */
import { observe, diffObservations, type Observation, type Diff } from './core';
import {
  click,
  setValue,
  check,
  selectOption,
  defaultSettleWait,
  StaleHandleError,
  NotInteractableError,
  WriteFailedError,
  type ActContext,
} from '../act/primitives';

let previous: Observation | null = null;

function snapshot(): { observation: Observation; diff: Diff | null } {
  const observation = observe(document);
  const diff = previous ? diffObservations(previous, observation) : null;
  previous = observation;
  return { observation, diff };
}

async function handleActExecute(
  action: {
    primitive: 'click' | 'setValue' | 'check' | 'selectOption';
    handle: string;
    value?: string;
    checked?: boolean;
    optionLabel?: string;
    canRetry?: boolean;
  },
): Promise<{ ok: boolean; error?: string; retried?: boolean }> {
  // Take a fresh observation so handle resolution uses the current DOM.
  const { observation } = snapshot();

  const ctx: ActContext = {
    doc: document,
    obs: observation,
    settle: defaultSettleWait,
  };

  try {
    switch (action.primitive) {
      case 'click': {
        const result = await click(ctx, action.handle, action.canRetry ?? true);
        return result;
      }
      case 'setValue': {
        if (action.value === undefined) {
          return { ok: false, error: 'setValue requires a value' };
        }
        const result = await setValue(ctx, action.handle, action.value);
        return result;
      }
      case 'check': {
        const result = await check(ctx, action.handle, action.checked ?? true);
        return result;
      }
      case 'selectOption': {
        if (action.optionLabel === undefined) {
          return { ok: false, error: 'selectOption requires an optionLabel' };
        }
        const result = await selectOption(ctx, action.handle, action.optionLabel);
        return result;
      }
      default:
        return { ok: false, error: `unknown primitive: ${action.primitive}` };
    }
  } catch (err) {
    if (err instanceof StaleHandleError) {
      return { ok: false, error: `StaleHandleError: ${err.message}` };
    }
    if (err instanceof NotInteractableError) {
      return { ok: false, error: `NotInteractableError: ${err.message}` };
    }
    if (err instanceof WriteFailedError) {
      return { ok: false, error: `WriteFailedError: ${err.message}` };
    }
    return { ok: false, error: String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'PERCEIVE_OBSERVE') {
    try {
      const result = snapshot();
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return false; // Synchronous response.
  }

  if (message.type === 'ACT_EXECUTE') {
    handleActExecute(message.action)
      .then((result) => {
        // After an ACT, update the previous observation (DOM has changed).
        try {
          const postSnap = snapshot();
          void postSnap;
        } catch {
          // Non-fatal: perception update after ACT is best-effort.
        }
        sendResponse(result);
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });
    return true; // Async response.
  }

  if (message.type === 'PERCEIVE_AND_SETTLE') {
    const delayMs = message.delayMs ?? 300;
    setTimeout(() => {
      try {
        const result = snapshot();
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    }, delayMs);
    return true; // Async response.
  }

  return false;
});
