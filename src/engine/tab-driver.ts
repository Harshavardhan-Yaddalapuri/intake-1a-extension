/**
 * Tab driver: abstraction over content-script communication.
 *
 * The orchestrator calls this instead of raw chrome.tabs.sendMessage.
 * It handles:
 *   - Sending PERCEIVE_OBSERVE / PERCEIVE_AND_SETTLE / ACT_EXECUTE to the
 *     content script in the active tab.
 *   - Waiting for page loads after navigation.
 *   - Retry on content-script-not-ready errors (the script may not have
 *     injected yet after a navigation).
 *
 * HARD WALL: the tab driver does not interpret observations or decide
 * what to do. It only ferries messages and waits for responses.
 */

import type { Observation, Diff } from '../perceive/core';
import type { ActResult } from '../act/primitives';
import type {
  ActAction,
  ActExecuteResult,
  PerceiveObserveResult,
} from '../shared/messages';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface PerceiveResult {
  observation: Observation;
  diff: Diff | null;
}

// ---------------------------------------------------------------------------
// Tab driver.
// ---------------------------------------------------------------------------

export class TabDriver {
  private tabId: number;

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  /** Take a fresh accessibility-tree observation of the current page. */
  async perceive(): Promise<PerceiveResult> {
    const response = await this.sendToTab<PerceiveObserveResult>({
      type: 'PERCEIVE_OBSERVE',
    });
    if (!response.ok || !response.observation) {
      throw new TabDriverError(`PERCEIVE failed: ${response.error ?? 'no observation returned'}`);
    }
    return {
      observation: response.observation,
      diff: response.diff ?? null,
    };
  }

  /** Wait a settle delay, then take a fresh observation. Used after mutations
   *  to let the DOM update before read-back verification. */
  async perceiveAfterSettle(delayMs = 300): Promise<PerceiveResult> {
    const response = await this.sendToTab<PerceiveObserveResult>({
      type: 'PERCEIVE_AND_SETTLE',
      delayMs,
    });
    if (!response.ok || !response.observation) {
      throw new TabDriverError(`PERCEIVE_AND_SETTLE failed: ${response.error ?? 'no observation returned'}`);
    }
    return {
      observation: response.observation,
      diff: response.diff ?? null,
    };
  }

  /** Execute a DOM action (click, setValue, check, selectOption) on the page. */
  async act(action: ActAction): Promise<ActExecuteResult> {
    const response = await this.sendToTab<ActExecuteResult>({
      type: 'ACT_EXECUTE',
      action,
    });
    return response;
  }

  /** Convenience: click an element by its structural handle. */
  async click(handle: string, canRetry = true): Promise<ActExecuteResult> {
    return this.act({ primitive: 'click', handle, canRetry });
  }

  /** Convenience: set a text value on an input. */
  async setValue(handle: string, value: string): Promise<ActExecuteResult> {
    return this.act({ primitive: 'setValue', handle, value });
  }

  /** Convenience: check/uncheck a checkbox. */
  async check(handle: string, checked = true): Promise<ActExecuteResult> {
    return this.act({ primitive: 'check', handle, checked });
  }

  /** Convenience: select an option from a dropdown/listbox. */
  async selectOption(handle: string, optionLabel: string): Promise<ActExecuteResult> {
    return this.act({ primitive: 'selectOption', handle, optionLabel });
  }

  /** Get the current tab ID. */
  getTabId(): number {
    return this.tabId;
  }

  // -------------------------------------------------------------------------
  // Internal messaging.
  // -------------------------------------------------------------------------

  /**
   * Send a message to the content script in the tab. Retries up to 3 times
   * with exponential backoff if the content script is not ready (common after
   * a page navigation before document_idle fires).
   */
  private async sendToTab<T>(message: Record<string, unknown>): Promise<T> {
    const maxRetries = 3;
    let lastError: unknown;
    let reinjected = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(this.tabId, message);
        return response as T;
      } catch (err) {
        lastError = err;
        const errStr = String(err);
        const noReceiver =
          errStr.includes('Receiving end does not exist') ||
          errStr.includes('Could not establish connection');

        if (noReceiver && attempt < maxRetries) {
          // "No receiver" has two different causes that look identical from
          // here: the content script hasn't finished loading yet (a timing
          // race on a fresh navigation), or it was never going to appear at
          // all because the tab predates this content script -- most commonly
          // because the extension was reloaded (a new build) while the tab
          // was already open. Chrome does not retroactively inject a
          // manifest-declared content script into an already-open tab, so
          // resending the same message forever, as this loop used to, fails
          // identically every time in that case.
          //
          // Re-inject ourselves, once, before resorting to a bare wait-and-
          // retry. The "scripting" permission plus the <all_urls> host
          // permission already granted for content_scripts cover this. If
          // injection itself throws (a chrome:// tab, a closed tab), fall
          // through to the timing-race path below rather than treating that
          // as fatal here -- the eventual retryable send will surface the
          // real error.
          if (!reinjected) {
            reinjected = true;
            try {
              await chrome.scripting.executeScript({
                target: { tabId: this.tabId },
                files: ['content.js'],
              });
              continue; // Retry immediately; the script is present now.
            } catch {
              // Fall through to the timing-race wait below.
            }
          }
          await this.sleep(500 * Math.pow(2, attempt));
          continue;
        }

        // Other errors are hard failures.
        throw new TabDriverError(`sendToTab failed: ${errStr}`);
      }
    }

    throw new TabDriverError(`sendToTab failed after ${maxRetries + 1} attempts: ${String(lastError)}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class TabDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TabDriverError';
  }
}
