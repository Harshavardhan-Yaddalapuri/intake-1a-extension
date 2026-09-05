/**
 * Append-only provenance journal.
 *
 * The assignment requires that for every element the agent creates, it can say
 * WHICH ENTRY in the input file it came from and WHY it was believed correct.
 * In a regulated environment that is not optional.
 *
 * Adoptions and skips are recorded alongside creations: "already present,
 * matched, left alone" is what explains why a second run touched nothing, and
 * it is as load-bearing as a creation record.
 *
 * Records are frozen on write and records() returns a copy. This is a log, not
 * a working set.
 */

import type { BindingRung, CanonicalType, ContractOpId } from '../shared/contract';
import type { Verdict } from '../verify/verify';
import type { HumanDecision } from '../shared/messages';

export interface IrSource {
  /** Path into the input file, e.g. "visits[0].forms[2].fields[1]". */
  path: string;
  visit_name: string;
  form_name: string;
  field_label?: string;
  declared_type?: CanonicalType;
}

export type JournalOutcome =
  | 'created' | 'adopted' | 'skipped' | 'escalated' | 'failed' | 'note';

export interface JournalBinding {
  rung: BindingRung;
  evidence: string[];
  llm_rationale?: string;
  llm_rank?: number;
}

export interface JournalVerification {
  verdict: Verdict | 'N/A';
  reason: string;
  suspected_trap?: string;
}

export interface JournalRecord {
  seq: number;
  run_id: string;
  timestamp: number;
  ir_source: IrSource;
  op: ContractOpId | 'note';
  outcome: JournalOutcome;
  binding: JournalBinding | null;
  verification: JournalVerification | null;
  human: { action: HumanDecision['action']; note?: string } | null;
}

export class Journal {
  private readonly runId: string;
  private readonly clock: () => number;
  private seq = 0;
  private log: JournalRecord[] = [];

  /** `now` accepts a fixed number for deterministic tests. */
  constructor(runId: string, now: number | (() => number) = () => Date.now()) {
    this.runId = runId;
    this.clock = typeof now === 'number' ? () => now : now;
  }

  private append(record: Omit<JournalRecord, 'seq' | 'run_id' | 'timestamp'>): void {
    this.seq += 1;
    this.log.push(
      Object.freeze({
        seq: this.seq,
        run_id: this.runId,
        timestamp: this.clock(),
        ...record,
      }) as JournalRecord,
    );
  }

  created(
    source: IrSource,
    op: ContractOpId,
    binding: JournalBinding,
    verification: JournalVerification,
    human?: { action: HumanDecision['action']; note?: string },
  ): void {
    this.append({
      ir_source: source, op, outcome: 'created', binding, verification,
      human: human ?? null,
    });
  }

  adopted(source: IrSource, reason: string): void {
    this.append({
      ir_source: source, op: 'form.list_fields', outcome: 'adopted', binding: null,
      verification: { verdict: 'VERIFIED', reason }, human: null,
    });
  }

  skipped(
    source: IrSource,
    reason: string,
    human?: { action: HumanDecision['action']; note?: string },
  ): void {
    this.append({
      ir_source: source, op: 'note', outcome: 'skipped', binding: null,
      verification: { verdict: 'N/A', reason }, human: human ?? null,
    });
  }

  escalated(
    source: IrSource,
    reason: string,
    human: { action: HumanDecision['action']; note?: string } | null,
    binding: JournalBinding | null = null,
  ): void {
    this.append({
      ir_source: source, op: 'note', outcome: 'escalated', binding,
      verification: { verdict: 'AMBIGUOUS', reason }, human,
    });
  }

  failed(
    source: IrSource,
    op: ContractOpId,
    reason: string,
    binding: JournalBinding | null = null,
  ): void {
    this.append({
      ir_source: source, op, outcome: 'failed', binding,
      verification: { verdict: 'FAILED', reason }, human: null,
    });
  }

  /** Something worth recording that is not about one field. */
  note(scope: string, message: string): void {
    this.append({
      ir_source: { path: scope, visit_name: '', form_name: '' },
      op: 'note', outcome: 'note', binding: null,
      verification: { verdict: 'N/A', reason: message }, human: null,
    });
  }

  records(): JournalRecord[] {
    return this.log.slice();
  }
}

export function toJsonl(records: readonly JournalRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Readable report grouped visit -> form -> field. */
export function toHtmlReport(journal: Journal, meta: { studyTitle: string }): string {
  const records = journal.records();

  const byVisit = new Map<string, Map<string, JournalRecord[]>>();
  for (const r of records) {
    const visit = r.ir_source.visit_name || '(run-level)';
    const form = r.ir_source.form_name || '(form-level)';
    if (!byVisit.has(visit)) byVisit.set(visit, new Map());
    const forms = byVisit.get(visit)!;
    if (!forms.has(form)) forms.set(form, []);
    forms.get(form)!.push(r);
  }

  const counts = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  const sections: string[] = [];
  for (const [visit, forms] of byVisit) {
    const formBlocks: string[] = [];
    for (const [form, rows] of forms) {
      const trs = rows
        .map(
          (r) => `
        <tr class="${esc(r.outcome)}">
          <td>${esc(r.ir_source.field_label ?? '—')}</td>
          <td>${esc(r.ir_source.declared_type ?? '—')}</td>
          <td>${esc(r.outcome)}</td>
          <td>${r.binding ? `rung ${r.binding.rung}` : '—'}</td>
          <td>${esc(r.verification?.reason ?? '')}</td>
          <td>${esc(r.binding?.evidence.join('; ') ?? '')}</td>
          <td>${r.human ? esc(`${r.human.action}${r.human.note ? `: ${r.human.note}` : ''}`) : '—'}</td>
          <td><code>${esc(r.ir_source.path)}</code></td>
        </tr>`,
        )
        .join('');
      formBlocks.push(`
        <h3>${esc(form)}</h3>
        <table>
          <thead><tr>
            <th>Field</th><th>Type</th><th>Outcome</th><th>Rung</th>
            <th>What confirmed it</th><th>Why this binding</th><th>Human</th><th>Input file</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>`);
    }
    sections.push(`<section><h2>${esc(visit)}</h2>${formBlocks.join('')}</section>`);
  }

  return `<!doctype html>
<meta charset="utf-8">
<title>Build report — ${esc(meta.studyTitle)}</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #d0d0d0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  tr.created { background: #f6fff6; }
  tr.adopted { background: #f6f9ff; }
  tr.escalated { background: #fffbf0; }
  tr.failed { background: #fff5f5; }
  code { font-size: 12px; color: #555; }
  .summary { margin-bottom: 2rem; padding: 1rem; background: #f8f8f8; border-radius: 4px; }
</style>
<h1>Build report — ${esc(meta.studyTitle)}</h1>
<div class="summary">
  ${Object.entries(counts).map(([k, v]) => `<strong>${esc(k)}:</strong> ${v}`).join(' &middot; ')}
  <br><small>${records.length} records. Every row names the entry in the input file it came from.</small>
</div>
${sections.join('')}
`;
}
