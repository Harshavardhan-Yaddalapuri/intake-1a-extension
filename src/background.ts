/**
 * Background service worker.
 *
 * Hosts the orchestrator and relays messages between the side panel and
 * the content script. Manages the run lifecycle:
 *   - START_RUN: instantiate and run the orchestrator.
 *   - PAUSE_RUN / RESUME_RUN: pause/resume execution.
 *   - HUMAN_DECISION: resolve an escalated item.
 *   - GET_RUN_STATE: snapshot for side panel reconnect.
 *   - OBSERVE_ACTIVE_TAB: legacy observation (preserved for dev/debug).
 */

import type { Observation, Diff } from './perceive/core';
import type {
  PreflightReportMsg,
  RunProgressMsg,
  EscalationMsg,
  RunCompleteMsg,
  RunStateSnapshot,
} from './shared/messages';
import { Orchestrator, type OrchestratorCallbacks } from './engine/orchestrator';

// ---------------------------------------------------------------------------
// Orchestrator state.
// ---------------------------------------------------------------------------

let orchestrator: Orchestrator | null = null;

/** Broadcast a message to all extension contexts (side panel, popup, etc.). */
function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open -- ignore.
  });
}

/** Build orchestrator callbacks that broadcast to the side panel. */
function makeCallbacks(): OrchestratorCallbacks {
  return {
    onPreflightReport(report, planSummary) {
      broadcast({
        type: 'PREFLIGHT_REPORT',
        report,
        plan: planSummary,
      } satisfies PreflightReportMsg);
    },
    onProgress(progress) {
      broadcast({
        type: 'RUN_PROGRESS',
        progress,
      } satisfies RunProgressMsg);
    },
    onEscalation(item) {
      broadcast({
        type: 'ESCALATION',
        item,
      } satisfies EscalationMsg);
    },
    onComplete(summary) {
      broadcast({
        type: 'RUN_COMPLETE',
        summary,
      } satisfies RunCompleteMsg);
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy observation handler (preserved from S1).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Message handler.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'START_RUN': {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) {
            sendResponse({ ok: false, error: 'no active tab' });
            return;
          }

          orchestrator = new Orchestrator(
            message.irJson,
            tab.id,
            makeCallbacks(),
          );

          sendResponse({ ok: true });

          // Run asynchronously (don't block the response).
          orchestrator.execute().catch((err) => {
            console.error('[orchestrator] execution error:', err);
            broadcast({
              type: 'RUN_COMPLETE',
              summary: {
                totalSteps: 0,
                verified: 0,
                escalated: 0,
                failed: 0,
                skipped: 0,
                durationMs: 0,
                escalations: [],
              },
            });
          });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true; // Async response.
    }

    case 'PAUSE_RUN': {
      if (orchestrator) {
        orchestrator.pause();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'no run in progress' });
      }
      return false;
    }

    case 'RESUME_RUN': {
      if (orchestrator) {
        orchestrator.resume();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'no run in progress' });
      }
      return false;
    }

    case 'HUMAN_DECISION': {
      if (orchestrator) {
        orchestrator.resolveEscalation(message.key, message.decision);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'no run in progress' });
      }
      return false;
    }

    case 'GET_RUN_STATE': {
      const phase = orchestrator?.getPhase() ?? 'idle';
      const snapshot: RunStateSnapshot = {
        type: 'RUN_STATE_SNAPSHOT',
        running: phase === 'executing',
        phase,
        escalationQueue: orchestrator?.getEscalationQueue() ?? [],
      };
      sendResponse(snapshot);
      return false;
    }

    case 'OBSERVE_ACTIVE_TAB': {
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
      return true; // Async response.
    }

    default:
      return false;
  }
});

// Open side panel when extension icon is clicked.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
      // Side panel API not available -- ignore.
    });
  }
});
