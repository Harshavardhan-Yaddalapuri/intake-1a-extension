/**
 * Binding results cache (proposal-b section 3, PLATFORM MODEL).
 *
 * The platform model is the set of Binding records + a capability report.
 * It is per-origin cached, versioned, and re-validated on use (a bound op
 * whose post-condition fails falls back to rebinding).
 *
 * Stored in chrome.storage.local, keyed by origin. The cache is injected
 * with a StorageAdapter so the core is unit-testable against a stub.
 */

import type {
  BindingRecord,
  CapabilityReport,
  ContractOpId,
} from '../shared/contract';
import type { StorageAdapter } from '../engine/state-machine';

// ---------------------------------------------------------------------------
// Cache versioning.
// ---------------------------------------------------------------------------

/** Bump when the binding record shape changes. Old caches are invalidated. */
export const BINDING_CACHE_VERSION = 1;

const CACHE_KEY_PREFIX = 'intake-1a:bindings:';

interface CachedReport {
  version: number;
  report: CapabilityReport;
}

// ---------------------------------------------------------------------------
// Read / write.
// ---------------------------------------------------------------------------

export async function loadBindings(
  adapter: StorageAdapter,
  origin: string,
): Promise<CapabilityReport | null> {
  const key = CACHE_KEY_PREFIX + origin;
  const raw = (await adapter.get(key)) as CachedReport | null;
  if (!raw) return null;
  if (raw.version !== BINDING_CACHE_VERSION) return null;
  return raw.report;
}

export async function saveBindings(
  adapter: StorageAdapter,
  origin: string,
  report: CapabilityReport,
): Promise<void> {
  const key = CACHE_KEY_PREFIX + origin;
  const entry: CachedReport = { version: BINDING_CACHE_VERSION, report };
  await adapter.set(key, entry);
}

// ---------------------------------------------------------------------------
// Report assembly helpers.
// ---------------------------------------------------------------------------

export function emptyReport(origin: string): CapabilityReport {
  const bindings: Record<string, BindingRecord | null> = {};
  const needs_human: ContractOpId[] = [];
  const unbindable: ContractOpId[] = [];
  return {
    platform_origin: origin,
    generated_at: Date.now(),
    bindings,
    needs_human,
    unbindable,
  };
}

export function setBinding(report: CapabilityReport, op: ContractOpId, record: BindingRecord): void {
  report.bindings[op] = record;
  const idx = report.needs_human.indexOf(op);
  if (idx >= 0) report.needs_human.splice(idx, 1);
  const uidx = report.unbindable.indexOf(op);
  if (uidx >= 0) report.unbindable.splice(uidx, 1);
  if (record.status === 'needs-human' && !report.needs_human.includes(op)) {
    report.needs_human.push(op);
  }
  if (record.status === 'unbindable' && !report.unbindable.includes(op)) {
    report.unbindable.push(op);
  }
}

export function setNeedsHuman(report: CapabilityReport, op: ContractOpId): void {
  report.bindings[op] = null;
  if (!report.needs_human.includes(op)) report.needs_human.push(op);
}

export function setUnbindable(report: CapabilityReport, op: ContractOpId): void {
  report.bindings[op] = null;
  if (!report.unbindable.includes(op)) report.unbindable.push(op);
}

// ---------------------------------------------------------------------------
// Re-validation: check if a cached binding is still valid.
// ---------------------------------------------------------------------------

export function isCacheValid(report: CapabilityReport, maxAgeMs: number): boolean {
  const age = Date.now() - report.generated_at;
  return age < maxAgeMs;
}