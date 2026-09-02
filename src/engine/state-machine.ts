/**
 * Runtime state machine (proposal-b section 5).
 *
 * Per plan item:
 *
 *   pending -> binding -> ready -> acting -> verifying -> verified
 *                                                     \-> failed -> (rebind once at most)
 *                                                     \-> ambiguous -> ESCALATED
 *   and any state -> ESCALATED on low evidence or NONE at rung 2.
 *
 * The machine is resumable: state per item persisted to chrome.storage, so a
 * reload (the mock wipes in-memory state on reload) restarts from the last
 * verified item, not from scratch.
 *
 * This module is pure and deterministic: it exposes a transition function and
 * a persistence adapter. The chrome.storage adapter is injected so the core
 * is unit-testable against a stub.
 */

// ---------------------------------------------------------------------------
// States.
// ---------------------------------------------------------------------------

export type ItemState =
  | 'pending'
  | 'binding'
  | 'ready'
  | 'acting'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'ambiguous'
  | 'escalated';

export const ITEM_STATES: readonly ItemState[] = [
  'pending',
  'binding',
  'ready',
  'acting',
  'verifying',
  'verified',
  'failed',
  'ambiguous',
  'escalated',
];

// ---------------------------------------------------------------------------
// Events (the inputs that drive transitions).
// ---------------------------------------------------------------------------

export type ItemEvent =
  | 'begin_binding'
  | 'bound'
  | 'bind_failed'
  | 'begin_acting'
  | 'act_done'
  | 'act_failed'
  | 'verify_verified'
  | 'verify_failed'
  | 'verify_ambiguous'
  | 'escalate';

// ---------------------------------------------------------------------------
// Item record.
// ---------------------------------------------------------------------------

export interface ItemRecord {
  /** Idempotency key (M5): visit_id + form_id + field_id, from IR ids. */
  key: string;
  visit_id: string;
  form_id: string;
  field_id: string;
  state: ItemState;
  /** Number of rebinds already attempted (max 1). */
  rebind_count: number;
  /** Set when the item is escalated, with the reason. */
  escalation_reason?: string;
  /** Last verdict, if any. */
  last_verdict?: 'VERIFIED' | 'FAILED' | 'AMBIGUOUS';
}

// ---------------------------------------------------------------------------
// Transition table.
// ---------------------------------------------------------------------------

export interface TransitionResult {
  ok: boolean;
  item: ItemRecord;
  error?: string;
}

/**
 * Apply an event to an item, returning the new item. Pure: no side effects.
 * The caller persists the returned item.
 */
export function transition(item: ItemRecord, event: ItemEvent): TransitionResult {
  const next: ItemRecord = { ...item };

  switch (event) {
    case 'begin_binding':
      if (item.state !== 'pending') return reject(item, event, 'begin_binding requires pending');
      next.state = 'binding';
      return { ok: true, item: next };

    case 'bound':
      if (item.state !== 'binding') return reject(item, event, 'bound requires binding');
      next.state = 'ready';
      return { ok: true, item: next };

    case 'bind_failed':
      if (item.state !== 'binding') return reject(item, event, 'bind_failed requires binding');
      // Binding failure escalates (no rebind at the binding stage; rebind is
      // for a failed VERIFY after acting).
      next.state = 'escalated';
      next.escalation_reason = 'binding failed';
      return { ok: true, item: next };

    case 'begin_acting':
      if (item.state !== 'ready') return reject(item, event, 'begin_acting requires ready');
      next.state = 'acting';
      return { ok: true, item: next };

    case 'act_done':
      if (item.state !== 'acting') return reject(item, event, 'act_done requires acting');
      next.state = 'verifying';
      return { ok: true, item: next };

    case 'act_failed':
      if (item.state !== 'acting') return reject(item, event, 'act_failed requires acting');
      // A failed/unsure write is handed to VERIFY, never blind-retried.
      next.state = 'verifying';
      return { ok: true, item: next };

    case 'verify_verified':
      if (item.state !== 'verifying') return reject(item, event, 'verify_verified requires verifying');
      next.state = 'verified';
      next.last_verdict = 'VERIFIED';
      return { ok: true, item: next };

    case 'verify_failed':
      if (item.state !== 'verifying') return reject(item, event, 'verify_failed requires verifying');
      next.last_verdict = 'FAILED';
      if (item.rebind_count < 1) {
        // Rebind once at most.
        next.rebind_count += 1;
        next.state = 'binding';
      } else {
        next.state = 'escalated';
        next.escalation_reason = 'failed after one rebind';
      }
      return { ok: true, item: next };

    case 'verify_ambiguous':
      if (item.state !== 'verifying') return reject(item, event, 'verify_ambiguous requires verifying');
      next.last_verdict = 'AMBIGUOUS';
      // AMBIGUOUS is first-class: escalate, never auto-retry.
      next.state = 'escalated';
      next.escalation_reason = 'ambiguous read-back';
      return { ok: true, item: next };

    case 'escalate':
      // Any state -> ESCALATED on low evidence or NONE at rung 2.
      next.state = 'escalated';
      next.escalation_reason = next.escalation_reason ?? 'escalated';
      return { ok: true, item: next };

    default:
      return reject(item, event, 'unknown event');
  }
}

function reject(item: ItemRecord, event: ItemEvent, reason: string): TransitionResult {
  return { ok: false, item, error: `invalid transition: ${event} from ${item.state} (${reason})` };
}

// ---------------------------------------------------------------------------
// Persistence adapter (chrome.storage, injected for testability).
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** A chrome.storage.local-backed adapter. */
export function chromeStorageAdapter(area: 'local' | 'session' = 'local'): StorageAdapter {
  return {
    async get(key: string): Promise<unknown> {
      const result = await chrome.storage[area].get(key);
      return result[key];
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage[area].set({ [key]: value });
    },
  };
}

/** In-memory adapter for unit tests. */
export function memoryStorageAdapter(initial: Record<string, unknown> = {}): StorageAdapter {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key: string): Promise<unknown> {
      return store.get(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// Run state (the whole build, persisted).
// ---------------------------------------------------------------------------

export interface RunState {
  run_id: string;
  platform_origin: string;
  items: Record<string, ItemRecord>;
  /** Order of item keys, for resume. */
  order: string[];
  /** Index of the next item to process. */
  cursor: number;
  status: 'running' | 'paused' | 'done' | 'escalated';
}

const RUN_KEY = 'intake-1a:run-state';

export function newRunState(run_id: string, platform_origin: string, keys: string[]): RunState {
  const items: Record<string, ItemRecord> = {};
  for (const key of keys) {
    const [visit_id, form_id, field_id] = key.split('\u0000');
    items[key] = {
      key,
      visit_id,
      form_id,
      field_id,
      state: 'pending',
      rebind_count: 0,
    };
  }
  return {
    run_id,
    platform_origin,
    items,
    order: keys,
    cursor: 0,
    status: 'running',
  };
}

export async function loadRunState(adapter: StorageAdapter): Promise<RunState | null> {
  const value = await adapter.get(RUN_KEY);
  return (value as RunState) ?? null;
}

export async function saveRunState(adapter: StorageAdapter, state: RunState): Promise<void> {
  await adapter.set(RUN_KEY, state);
}

/** Apply a transition to one item and persist the whole run state. */
export async function applyTransition(
  adapter: StorageAdapter,
  state: RunState,
  key: string,
  event: ItemEvent,
): Promise<TransitionResult> {
  const item = state.items[key];
  if (!item) {
    return { ok: false, item: item as ItemRecord, error: `no item for key ${key}` };
  }
  const result = transition(item, event);
  if (result.ok) {
    state.items[key] = result.item;
    await saveRunState(adapter, state);
  }
  return result;
}
