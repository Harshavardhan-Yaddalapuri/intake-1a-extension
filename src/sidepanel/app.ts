/**
 * Side panel entry point (Human Gate UI).
 *
 * Three tabs:
 *   1. Pre-Flight: upload IR file, review capability report, start/pause/resume.
 *   2. Ambiguity Queue: review and resolve escalated items.
 *   3. Report: live progress and end-of-run summary.
 *
 * Communicates with the service worker via chrome.runtime messages.
 */

import type { CapabilityReport, BindingRecord, ContractOpId, CanonicalType } from '../shared/contract';
import type { TreeSummary } from '../engine/reconcile';
import type { JournalExport } from '../shared/messages';
import { CANONICAL_TYPES } from '../shared/contract';
import type {
  EscalationItem,
  RunProgress,
  RunSummary,
  PlanSummary,
  HumanDecision,
} from '../shared/messages';

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

let irJson: string | null = null;
let isRunning = false;
let isPaused = false;
let escalationQueue: EscalationItem[] = [];
let runtimeLog: Array<{ timestamp: number; event: string; detail: string }> = [];

// ---------------------------------------------------------------------------
// DOM references.
// ---------------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id);
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

// ---------------------------------------------------------------------------
// Tab switching.
// ---------------------------------------------------------------------------

function switchTab(target: string): void {
  tabs.forEach((t) => t.classList.remove('active'));
  panels.forEach((p) => p.classList.remove('active'));
  const activeTab = document.querySelector(`[data-tab="${target}"]`);
  if (activeTab) activeTab.classList.add('active');
  $(target)?.classList.add('active');
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = (tab as HTMLElement).dataset.tab!;
    switchTab(target);
  });
});

// ---------------------------------------------------------------------------
// File upload.
// ---------------------------------------------------------------------------

const fileInput = $('ir-file') as HTMLInputElement;
const fileDrop = $('file-drop')!;

fileDrop.addEventListener('click', () => fileInput.click());
fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.style.borderColor = '#53c28b'; });
fileDrop.addEventListener('dragleave', () => { fileDrop.style.borderColor = ''; });
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.style.borderColor = '';
  const file = (e as DragEvent).dataTransfer?.files[0];
  if (file) loadFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) loadFile(fileInput.files[0]);
});

function loadFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    irJson = reader.result as string;
    try {
      const data = JSON.parse(irJson);
      const visits = data.visits?.length ?? 0;
      let forms = 0, fields = 0;
      for (const v of data.visits ?? []) {
        forms += v.forms?.length ?? 0;
        for (const f of v.forms ?? []) {
          fields += f.fields?.length ?? 0;
        }
      }
      $('ir-summary')!.innerHTML = `
        <strong>${file.name}</strong> loaded<br>
        <span style="color:var(--text-muted)">${data.study?.protocol_id ?? 'Unknown'} — ${visits} visits, ${forms} forms, ${fields} fields</span>
      `;
      $('ir-summary')!.classList.remove('hidden');
      ($('start-btn') as HTMLButtonElement).disabled = false;
      logEvent('ir_loaded', `${file.name}: ${visits}v/${forms}f/${fields}d`);
    } catch {
      $('ir-summary')!.innerHTML = '<span style="color:var(--danger)">Invalid JSON</span>';
      $('ir-summary')!.classList.remove('hidden');
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Start / Pause / Resume.
// ---------------------------------------------------------------------------

$('start-btn')!.addEventListener('click', async () => {
  if (!irJson) return;

  ($('start-btn') as HTMLButtonElement).disabled = true;
  updateStatus('running', '<div class="spinner"></div> Starting pre-flight discovery...');

  const response = await chrome.runtime.sendMessage({ type: 'START_RUN', irJson });
  if (!response?.ok) {
    updateStatus('idle', `Error: ${response?.error ?? 'unknown'}`);
    ($('start-btn') as HTMLButtonElement).disabled = false;
    return;
  }

  isRunning = true;
  $('pause-btn')!.classList.remove('hidden');
  $('start-btn')!.classList.add('hidden');
  logEvent('run_started', '');
});

$('pause-btn')!.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'PAUSE_RUN' });
  isPaused = true;
  $('pause-btn')!.classList.add('hidden');
  $('resume-btn')!.classList.remove('hidden');
  updateStatus('paused', '⏸ Paused');
  logEvent('run_paused', '');
});

$('resume-btn')!.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESUME_RUN' });
  isPaused = false;
  $('resume-btn')!.classList.add('hidden');
  $('pause-btn')!.classList.remove('hidden');
  updateStatus('running', '<div class="spinner"></div> Running...');
  logEvent('run_resumed', '');
});

// ---------------------------------------------------------------------------
// Incoming messages from the service worker.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type) return;

  switch (message.type) {
    case 'RECONCILE_SUMMARY':
      renderReconcileSummary(message.summary, message.deepReconcileAvailable);
      break;
    case 'PARKED_REVIEW':
      renderParkedReview(message.items);
      break;
    case 'PREFLIGHT_REPORT':
      handlePreflightReport(message.report, message.plan);
      break;
    case 'RUN_PROGRESS':
      handleProgress(message.progress);
      break;
    case 'ESCALATION':
      handleEscalation(message.item);
      break;
    case 'RUN_COMPLETE':
      handleComplete(message.summary);
      break;
  }
});

// ---------------------------------------------------------------------------
// Pre-flight report.
// ---------------------------------------------------------------------------

function handlePreflightReport(report: CapabilityReport, plan: PlanSummary): void {
  updateStatus('paused', '⏸ Pre-flight complete — review and resume');

  // Show plan summary.
  $('ir-summary')!.innerHTML = `
    <strong>${plan.protocolId}</strong>: ${plan.studyTitle.substring(0, 60)}...<br>
    <span style="color:var(--text-muted)">${plan.visitCount} visits · ${plan.formAppearances} forms (${plan.distinctForms} distinct) · ${plan.fieldNodes} fields · ${plan.skipEdges} skip rules</span>
    ${plan.errors.length > 0 ? `<br><span style="color:var(--danger)">${plan.errors.length} compile errors</span>` : ''}
  `;

  // Show capability report.
  const capCard = $('capability-card')!;
  capCard.classList.remove('hidden');

  const container = $('capability-report')!;
  container.innerHTML = '';

  const entries = Object.entries(report.bindings) as Array<[ContractOpId, BindingRecord | null]>;
  for (const [op, binding] of entries) {
    const row = document.createElement('div');
    row.className = 'binding-row';

    const statusClass = !binding ? 'unbindable' : binding.status === 'needs-human' ? 'needs-human' : 'bound';

    row.innerHTML = `
      <div class="status-dot ${statusClass}"></div>
      <div class="op">${op}</div>
      <div class="rung" title="Binding rung">${binding?.rung ?? '—'}</div>
    `;
    container.appendChild(row);
  }

  // Show resume button (user reviews, then clicks resume to start execution).
  $('resume-btn')!.classList.remove('hidden');
  $('pause-btn')!.classList.add('hidden');

  logEvent('preflight_complete', `${entries.length} ops, ${report.unbindable.length} unbindable`);
}

// ---------------------------------------------------------------------------
// Progress.
// ---------------------------------------------------------------------------

function handleProgress(progress: RunProgress): void {
  const pct = progress.total > 0 ? Math.round((progress.cursor / progress.total) * 100) : 0;

  // Update progress bar.
  ($('progress-fill') as HTMLElement).style.width = `${pct}%`;
  $('progress-label')!.textContent = `${progress.cursor} / ${progress.total} steps — ${progress.currentField}`;

  // Update stats.
  $('stat-verified')!.textContent = String(progress.verified);
  $('stat-escalated')!.textContent = String(progress.escalated);
  $('stat-failed')!.textContent = String(progress.failed);
  $('stat-pending')!.textContent = String(progress.pending);

  // Update status.
  if (progress.phase === 'executing') {
    updateStatus('running', `<div class="spinner"></div> ${progress.currentVisit} → ${progress.currentForm} → ${progress.currentField}`);
  }

  // Switch to report tab status.
  $('report-status')!.className = 'status-banner running';
  $('report-status')!.innerHTML = `<div class="spinner"></div> ${pct}% — ${progress.currentField}`;
}

// ---------------------------------------------------------------------------
// Escalation.
// ---------------------------------------------------------------------------

function handleEscalation(item: EscalationItem): void {
  escalationQueue.push(item);
  updateQueueBadge();
  renderEscalationItem(item);
  logEvent('escalation', `${item.fieldLabel} (${item.canonicalType}): ${item.reason}`);

  // Automatically switch to the queue tab so the human sees the prompt immediately
  switchTab('queue');
}

function renderEscalationItem(item: EscalationItem): void {
  const container = $('queue-items')!;
  const el = document.createElement('div');
  el.className = 'escalation-item';
  el.dataset.key = item.key;

  // Blast radius turns 195 confirmations into at most 13 decisions: a type
  // mapping answered once settles every field of that type.
  const radius = item.blastRadius
    ? `<div class="radius" style="font-size:11px;color:var(--text-muted);margin-top:4px;">` +
      `Affects ${item.blastRadius.fields} field${item.blastRadius.fields === 1 ? '' : 's'} ` +
      `across ${item.blastRadius.forms} form${item.blastRadius.forms === 1 ? '' : 's'}. ` +
      `Answering once settles all of them.</div>`
    : '';

  const gate = item.blocking
    ? `<span class="type-badge" style="background:#7a2e2e;" title="The run is waiting on this">Blocking</span>`
    : `<span class="type-badge" style="background:#3a3a46;" title="The run continued; review at your convenience">Parked</span>`;

  const skipLabel = item.blastRadius && item.blastRadius.fields > 1
    ? `⊘ Skip these ${item.blastRadius.fields}`
    : '⊘ Skip';

  el.innerHTML = `
    <div class="header">
      <span class="field-name">${esc(item.fieldLabel)}</span>
      <span class="type-badge">${esc(item.canonicalType)}</span>
      ${gate}
    </div>
    <div class="context">${esc(item.visitName)} → ${esc(item.formName)}</div>
    <div class="reason">⚠ ${esc(item.reason)}</div>
    ${item.suspectedTrap ? `<div class="trap">🪤 ${esc(item.suspectedTrap)}</div>` : ''}
    ${item.evidence.length > 0 ? `<div class="evidence">${item.evidence.map(esc).join('<br>')}</div>` : ''}
    ${radius}
    <div class="btn-group">
      <button class="btn btn-sm btn-primary" data-action="approve" data-key="${item.key}">✓ Approve</button>
      <button class="btn btn-sm btn-warning" data-action="override" data-key="${item.key}">✎ Override</button>
      <button class="btn btn-sm" data-action="skip" data-key="${item.key}">${skipLabel}</button>
    </div>
    <input data-role="note" placeholder="Note (recorded in the audit trail)"
           style="width:100%;margin-top:6px;padding:4px;font-size:11px;box-sizing:border-box;">
  `;

  // Action handlers.
  el.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action as HumanDecision['action'];
      const key = (btn as HTMLElement).dataset.key!;

      if (action === 'override') {
        // Show a type selector.
        showTypeOverrideDialog(key, item.canonicalType);
        return;
      }

      const noteInput = el.querySelector('[data-role="note"]') as HTMLInputElement | null;
      const note = noteInput?.value.trim();
      sendDecision(key, { action, note: note || `human ${action}` });
      el.remove();
      escalationQueue = escalationQueue.filter((i) => i.key !== key);
      updateQueueBadge();
    });
  });

  container.appendChild(el);

  // Update queue status.
  $('queue-status')!.className = 'status-banner paused';
  $('queue-status')!.textContent = `${escalationQueue.length} item(s) need your input`;
  $('queue-actions')!.classList.toggle('hidden', escalationQueue.length < 3);
}

function showTypeOverrideDialog(key: string, currentType: CanonicalType): void {
  const select = document.createElement('select');
  select.style.cssText = 'margin:4px 0;padding:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;';
  for (const t of CANONICAL_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === currentType) opt.selected = true;
    select.appendChild(opt);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-sm btn-primary';
  confirmBtn.textContent = 'Apply';
  confirmBtn.style.marginLeft = '4px';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:4px;';
  wrapper.appendChild(document.createTextNode('Override type: '));
  wrapper.appendChild(select);
  wrapper.appendChild(confirmBtn);

  const item = document.querySelector(`[data-key="${key}"]`)!;
  item.appendChild(wrapper);

  confirmBtn.addEventListener('click', () => {
    sendDecision(key, {
      action: 'override',
      overrideType: select.value as CanonicalType,
      note: `human override: ${currentType} -> ${select.value}`,
    });
    item.remove();
    escalationQueue = escalationQueue.filter((i) => i.key !== key);
    updateQueueBadge();
  });
}

function sendDecision(key: string, decision: HumanDecision): void {
  chrome.runtime.sendMessage({ type: 'HUMAN_DECISION', key, decision });
  logEvent('human_decision', `${key}: ${decision.action}${decision.overrideType ? ` -> ${decision.overrideType}` : ''}`);
}

// Approve all remaining.
$('approve-all-btn')!.addEventListener('click', () => {
  for (const item of [...escalationQueue]) {
    sendDecision(item.key, { action: 'approve', note: 'bulk approve' });
  }
  $('queue-items')!.innerHTML = '';
  escalationQueue = [];
  updateQueueBadge();
  logEvent('bulk_approve', 'all remaining');
});

function updateQueueBadge(): void {
  const badge = $('queue-badge')!;
  badge.textContent = String(escalationQueue.length);
  badge.classList.toggle('hidden', escalationQueue.length === 0);
}

// ---------------------------------------------------------------------------
// Run complete.
// ---------------------------------------------------------------------------

function handleComplete(summary: RunSummary): void {
  isRunning = false;
  isPaused = false;

  updateStatus('done', `✓ Complete — ${summary.verified} verified, ${summary.escalated} escalated, ${summary.failed} failed`);

  $('pause-btn')!.classList.add('hidden');
  $('resume-btn')!.classList.add('hidden');
  $('start-btn')!.classList.remove('hidden');
  ($('start-btn') as HTMLButtonElement).disabled = false;

  // Report tab.
  const pct = summary.totalSteps > 0 ? Math.round((summary.verified / summary.totalSteps) * 100) : 0;
  ($('progress-fill') as HTMLElement).style.width = `${pct}%`;
  $('progress-label')!.textContent = `${summary.verified} / ${summary.totalSteps} verified`;

  $('stat-verified')!.textContent = String(summary.verified);
  $('stat-escalated')!.textContent = String(summary.escalated);
  $('stat-failed')!.textContent = String(summary.failed);
  $('stat-pending')!.textContent = String(summary.skipped);

  $('report-status')!.className = 'status-banner done';
  $('report-status')!.textContent = `✓ Done in ${(summary.durationMs / 1000).toFixed(1)}s`;

  // Summary card.
  const summaryCard = $('summary-card')!;
  summaryCard.classList.remove('hidden');
  $('summary-content')!.innerHTML = `
    <table class="summary-table">
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Total Steps</td><td>${summary.totalSteps}</td></tr>
      <tr><td>Verified</td><td style="color:var(--accent)">${summary.verified}</td></tr>
      <tr><td>Escalated</td><td style="color:var(--warning)">${summary.escalated}</td></tr>
      <tr><td>Failed</td><td style="color:var(--danger)">${summary.failed}</td></tr>
      <tr><td>Skipped</td><td>${summary.skipped}</td></tr>
      <tr><td>Duration</td><td>${(summary.durationMs / 1000).toFixed(1)}s</td></tr>
    </table>
  `;

  // Export button.
  $('export-btn')!.classList.remove('hidden');

  logEvent('run_complete', `${summary.verified}/${summary.totalSteps} verified in ${(summary.durationMs / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------

$('export-btn')!.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(runtimeLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `intake-runtime-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function updateStatus(state: string, html: string): void {
  const banner = $('status-banner')!;
  banner.className = `status-banner ${state}`;
  banner.innerHTML = html;
}

function logEvent(event: string, detail: string): void {
  runtimeLog.push({ timestamp: Date.now(), event, detail });
}

// ---------------------------------------------------------------------------
// On load: reconnect to running orchestrator.
// ---------------------------------------------------------------------------

(async () => {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
    if (state?.phase === 'executing') {
      isRunning = true;
      updateStatus('running', '<div class="spinner"></div> Reconnected to running build...');
      $('pause-btn')!.classList.remove('hidden');
      $('start-btn')!.classList.add('hidden');
    } else if (state?.phase === 'paused') {
      isPaused = true;
      updateStatus('paused', '⏸ Paused — resume when ready');
      $('resume-btn')!.classList.remove('hidden');
      $('start-btn')!.classList.add('hidden');
    }
    if (state?.escalationQueue) {
      for (const item of state.escalationQueue) {
        handleEscalation(item);
      }
    }
  } catch {
    // Service worker not ready yet -- that's fine.
  }
})();


// ---------------------------------------------------------------------------
// Reconcile summary (pre-flight): what is already there.
// ---------------------------------------------------------------------------

function esc(v: string): string {
  const d = document.createElement('div');
  d.textContent = v;
  return d.innerHTML;
}

function renderReconcileSummary(summary: TreeSummary, deepAvailable: boolean): void {
  const card = $('reconcile-card')!;
  const body = $('reconcile-summary')!;
  card.classList.remove('hidden');

  const toBuild = summary.formAppearancesToCreate.length;
  const rows: string[] = [
    `<div><strong>${summary.visitsPresent} of ${summary.visitsWanted}</strong> visits already exist.</div>`,
    `<div><strong>${summary.formAppearancesPresent} of ${summary.formAppearancesWanted}</strong> form appearances present.</div>`,
    `<div><strong>${toBuild}</strong> form${toBuild === 1 ? '' : 's'} to create.</div>`,
  ];

  if (summary.visitsToCreate.length > 0) {
    rows.push(
      `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">` +
      `Visits to create: ${summary.visitsToCreate.map(esc).join(', ')}</div>`,
    );
  }

  if (!deepAvailable) {
    // Stating the limitation is the point. Silently degrading here would mean
    // a re-run cannot tell an already-built field from a missing one.
    rows.push(
      `<div class="trap" style="margin-top:8px;">⚠ <strong>Field-level reconciliation unavailable.</strong> ` +
      `This platform's form contents could not be enumerated, so a re-run cannot ` +
      `detect fields that already exist and may create duplicates.</div>`,
    );
  }

  body.innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------
// Parked review: the non-blocking pile, cleared in one sitting at the end.
// ---------------------------------------------------------------------------

function renderParkedReview(items: EscalationItem[]): void {
  const status = $('queue-status')!;
  status.className = 'status-banner warning';
  status.textContent =
    `Build finished. ${items.length} item${items.length === 1 ? '' : 's'} parked for review — ` +
    `nothing else is waiting on you.`;
  for (const item of items) {
    if (!escalationQueue.some((q) => q.key === item.key)) {
      escalationQueue.push(item);
      renderEscalationItem(item);
    }
  }
  updateQueueBadge();
}

// ---------------------------------------------------------------------------
// Rung 2 API key. Stored locally; never bundled, never sent anywhere but the
// Anthropic API.
// ---------------------------------------------------------------------------

async function refreshKeyStatus(justChanged = false): Promise<void> {
  const el = $('key-status');
  if (!el) return;
  const stored = await chrome.storage.local.get('openRouterApiKey');
  const has = typeof stored?.openRouterApiKey === 'string' && stored.openRouterApiKey.length > 0;
  el.textContent = has
    ? (justChanged ? 'Key saved. AI assist enabled.' : 'Key configured. AI assist enabled.')
    : 'No key. Ambiguous types will be escalated instead.';
}

$('save-key')?.addEventListener('click', async () => {
  const input = $('api-key') as HTMLInputElement | null;
  if (!input) return;
  const value = input.value.trim();
  if (!value) return;
  await chrome.storage.local.set({ openRouterApiKey: value });
  input.value = '';
  await refreshKeyStatus(true);
});

$('clear-key')?.addEventListener('click', async () => {
  await chrome.storage.local.remove('openRouterApiKey');
  await refreshKeyStatus(true);
});

void refreshKeyStatus();

// ---------------------------------------------------------------------------
// Journal export: the provenance record.
// ---------------------------------------------------------------------------

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function fetchJournal(): Promise<JournalExport | null> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_JOURNAL' });
  if (!res?.ok) {
    const status = $('report-status');
    if (status) {
      status.className = 'status-banner idle';
      status.textContent = res?.error ?? 'No journal yet — start a run first.';
    }
    return null;
  }
  return res as JournalExport;
}

$('export-jsonl')?.addEventListener('click', async () => {
  const j = await fetchJournal();
  if (!j) return;
  download(`build-${j.runId}.jsonl`, j.jsonl, 'application/x-ndjson');
});

$('export-report')?.addEventListener('click', async () => {
  const j = await fetchJournal();
  if (!j) return;
  download(`build-report-${j.runId}.html`, j.html, 'text/html');
});
