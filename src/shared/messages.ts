/**
 * Message protocol types for inter-component communication.
 *
 * Three communication channels exist in the extension:
 *   1. Side Panel <-> Service Worker (chrome.runtime.sendMessage)
 *   2. Service Worker <-> Content Script (chrome.tabs.sendMessage)
 *   3. Side Panel <-> Service Worker (chrome.runtime.onMessage for broadcasts)
 *
 * Every message has a `type` discriminant. This file is the single source of
 * truth for all message shapes.
 */

import type { CanonicalType, CapabilityReport, BindingRecord, ContractOpId } from './contract';
import type { Observation, Diff } from '../perceive/core';
import type { ActResult } from '../act/primitives';
import type { Plan, LinearItem } from '../plan/compiler';
import type { TreeSummary } from '../engine/reconcile';
import type { Verdict, VerdictResult } from '../verify/verify';
import type { ItemState, RunState } from '../engine/state-machine';

// ---------------------------------------------------------------------------
// Content Script messages (Service Worker <-> Content Script).
// ---------------------------------------------------------------------------

/** Request: take a fresh accessibility-tree observation. */
export interface PerceiveObserveMsg {
  type: 'PERCEIVE_OBSERVE';
}

/** Response to PERCEIVE_OBSERVE. */
export interface PerceiveObserveResult {
  ok: boolean;
  observation?: Observation;
  diff?: Diff | null;
  error?: string;
}

/** Request: execute a DOM action on the current page. */
export interface ActExecuteMsg {
  type: 'ACT_EXECUTE';
  action: ActAction;
}

/** A single DOM action to execute. The content script resolves the handle
 *  against the current DOM and executes the primitive. */
export interface ActAction {
  primitive: 'click' | 'setValue' | 'check' | 'selectOption';
  handle: string;
  /** For setValue: the text to set. */
  value?: string;
  /** For check: the desired checked state. */
  checked?: boolean;
  /** For selectOption: the option label to select. */
  optionLabel?: string;
  /** Whether this action is safe to retry (clicks=true, writes=false). */
  canRetry?: boolean;
}

/** Response to ACT_EXECUTE. */
export interface ActExecuteResult {
  ok: boolean;
  error?: string;
  retried?: boolean;
}

// ---------------------------------------------------------------------------
// Side Panel -> Service Worker messages.
// ---------------------------------------------------------------------------

/** Start a new build run. */
export interface StartRunMsg {
  type: 'START_RUN';
  irJson: string;
}

/** Pause the current run. */
export interface PauseRunMsg {
  type: 'PAUSE_RUN';
}

/** Resume a paused run. */
export interface ResumeRunMsg {
  type: 'RESUME_RUN';
}

/** Human decision on an escalated item. */
export interface HumanDecisionMsg {
  type: 'HUMAN_DECISION';
  key: string;
  decision: HumanDecision;
}

export interface HumanDecision {
  action: 'approve' | 'override' | 'skip' | 'retry';
  /** For override: the correct canonical type to use instead. */
  overrideType?: CanonicalType;
  /** For override: a manual binding to use. */
  overrideHandle?: string;
  /** Human note explaining the decision (traceability). */
  note?: string;
}

/** Request the current run state (for panel reload/reconnect). */
export interface GetRunStateMsg {
  type: 'GET_RUN_STATE';
}

/** Side panel -> background: existing observe request (preserved). */
export interface ObserveActiveTabMsg {
  type: 'OBSERVE_ACTIVE_TAB';
}

// ---------------------------------------------------------------------------
// Service Worker -> Side Panel messages (broadcasts via chrome.runtime).
// ---------------------------------------------------------------------------

/** Pre-flight capability report is ready for human review. */
export interface PreflightReportMsg {
  type: 'PREFLIGHT_REPORT';
  report: CapabilityReport;
  plan: PlanSummary;
}

/** A plan summary for side panel display. */
export interface PlanSummary {
  studyTitle: string;
  protocolId: string;
  visitCount: number;
  formAppearances: number;
  distinctForms: number;
  fieldNodes: number;
  skipEdges: number;
  errors: Array<{ message: string }>;
}

/** Progress update during execution. */
export interface RunProgressMsg {
  type: 'RUN_PROGRESS';
  progress: RunProgress;
}

export interface RunProgress {
  /** Current step index (0-based). */
  cursor: number;
  /** Total number of steps. */
  total: number;
  /** Current visit/form/field being processed. */
  currentVisit: string;
  currentForm: string;
  currentField: string;
  /** Counts by state. */
  verified: number;
  escalated: number;
  failed: number;
  pending: number;
  /** Current phase. */
  phase: 'preflight' | 'executing' | 'paused' | 'done';
}

/** An item has been escalated and needs human input. */
export interface EscalationMsg {
  type: 'ESCALATION';
  item: EscalationItem;
}

export interface EscalationItem {
  key: string;
  fieldLabel: string;
  formName: string;
  visitName: string;
  canonicalType: CanonicalType;
  reason: string;
  suspectedTrap?: string;
  evidence: string[];
  verdict?: VerdictResult;
  /** The binding that was attempted (if any). */
  binding?: BindingRecord;
  /** What phase the escalation happened in. */
  phase: 'binding' | 'acting' | 'verifying';
  /** Blocking escalations pause the run because it cannot proceed without an
   *  answer (no commit control; an unresolved canonical type gating every
   *  field of that type). Non-blocking ones are parked and reviewed at the
   *  end, so a long build is not an interrupt-driven review session. */
  blocking: boolean;
  /** Stable key grouping items that share ONE decision, e.g. the canonical
   *  type. Answering once settles every item in the group. */
  groupKey?: string;
  /** How many other items share this decision. A type mapping affecting 14
   *  fields is one decision, not fourteen. */
  blastRadius?: { fields: number; forms: number };
}

/** Shallow-pass reconcile result, shown on the pre-flight screen so the human
 *  authorises the run from a concrete statement of the work rather than an
 *  empty progress bar. */
export interface ReconcileSummaryMsg {
  type: 'RECONCILE_SUMMARY';
  summary: TreeSummary;
  /** When false, field-level reconciliation is unavailable on this platform
   *  and a re-run cannot tell an already-built field from a missing one. */
  deepReconcileAvailable: boolean;
}

/** The parked (non-blocking) escalations, delivered at the end of the run to
 *  be cleared in one review session. */
export interface ParkedReviewMsg {
  type: 'PARKED_REVIEW';
  items: EscalationItem[];
}

/** Side panel -> background: fetch the provenance journal for export. */
export interface GetJournalMsg {
  type: 'GET_JOURNAL';
}

export interface JournalExport {
  runId: string;
  jsonl: string;
  html: string;
  recordCount: number;
}

/** The run is complete. */
export interface RunCompleteMsg {
  type: 'RUN_COMPLETE';
  summary: RunSummary;
}

export interface RunSummary {
  totalSteps: number;
  verified: number;
  escalated: number;
  failed: number;
  skipped: number;
  durationMs: number;
  escalations: EscalationItem[];
}

/** Current run state snapshot (response to GET_RUN_STATE). */
export interface RunStateSnapshot {
  type: 'RUN_STATE_SNAPSHOT';
  running: boolean;
  phase: 'idle' | 'preflight' | 'executing' | 'paused' | 'done';
  progress?: RunProgress;
  escalationQueue: EscalationItem[];
  preflightReport?: CapabilityReport;
  summary?: RunSummary;
}

// ---------------------------------------------------------------------------
// Union types for dispatch.
// ---------------------------------------------------------------------------

/** All messages the content script can receive. */
export type ContentScriptMsg = PerceiveObserveMsg | ActExecuteMsg;

/** All messages the side panel can send to the service worker. */
export type SidePanelToBackgroundMsg =
  | GetJournalMsg
  | StartRunMsg
  | PauseRunMsg
  | ResumeRunMsg
  | HumanDecisionMsg
  | GetRunStateMsg
  | ObserveActiveTabMsg;

/** All messages the service worker can broadcast to the side panel. */
export type BackgroundToSidePanelMsg =
  | ReconcileSummaryMsg
  | ParkedReviewMsg
  | PreflightReportMsg
  | RunProgressMsg
  | EscalationMsg
  | RunCompleteMsg
  | RunStateSnapshot;
