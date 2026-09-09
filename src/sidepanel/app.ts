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
/** Once the build is over, the queue is a review pile rather than a gate, and
 *  the banner should say so instead of implying something is still waiting. */
let buildFinished = false;
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

  // Jump to the queue only when the build is actually waiting. Parked items
  // used to steal the tab mid-run, which made a long build feel like a stream
  // of emergencies when nothing was blocked.
  if (item.blocking) switchTab('queue');
}

/** Placeholders the orchestrator uses when an escalation is about a whole form
 *  or a whole visit rather than one field. They should never reach the screen. */
function isScopePlaceholder(v: string): boolean {
  return !v || v.startsWith('(');
}

/** Visit › Form › Field, with the deepest real level emphasised. This is the
 *  first line on every card: the commonest complaint about the old queue was
 *  not knowing which form an item belonged to. */
function locationLine(item: EscalationItem): string {
  const parts = [item.visitName, item.formName, item.fieldLabel]
    .filter((p) => p && !isScopePlaceholder(p));
  if (parts.length === 0) return '<b>This study</b>';
  const leaf = parts.pop()!;
  const trail = parts.map((p) => `${esc(p)}<span class="sep">›</span>`).join('');
  return `${trail}<b>${esc(leaf)}</b>`;
}

/** A short title for what went wrong. The location line already says WHERE,
 *  so this says WHAT — the old card led with the field name and repeated it. */
function headline(item: EscalationItem): string {
  // Lead with what is at stake, not with which internal stage produced the
  // finding. A reviewer triaging a long queue needs to see "work will be lost"
  // separated from "built, worth a look" at a glance -- live, the one form that
  // was genuinely unsaved sat among 99 cosmetic items and read identically.
  return RISK_LABEL[plainFinding(item).risk];
}

/** The control the input file asked for, named the way a coordinator would
 *  name it rather than by its canonical type. */
const CONTROL_IN_WORDS: Record<string, string> = {
  text: 'a single-line text box',
  textarea: 'a multi-line text box',
  integer: 'a whole number',
  decimal: 'a number that can have decimals',
  date: 'a date',
  time: 'a time',
  datetime: 'a date and time',
  boolean: 'a yes/no answer',
  single_select: 'a dropdown — pick one',
  multi_select: 'a tick-box list — pick any number',
  radio: 'radio buttons — pick exactly one',
  checkbox: 'a single tick box',
  calculated: 'a calculated field',
};

interface PlainFinding {
  /** What happened, in the reviewer's vocabulary. */
  what: string;
  /** What to go and look at, concretely. */
  check: string;
  /** Whether anything is actually at stake. */
  risk: 'data-loss' | 'may-be-wrong' | 'not-built';
}

/**
 * Say the finding in the language of the study.
 *
 * The reviewer is a coordinator, not an engineer: "element", "role",
 * "accessible name" and "fresh observation" are the agent's words for its own
 * internals and mean nothing at the point of review. The engine's exact wording
 * is kept, in the evidence panel, for the audit trail.
 */
function plainFinding(item: EscalationItem): PlainFinding {
  const r = item.reason;
  const field = item.fieldLabel;
  const wanted = CONTROL_IN_WORDS[item.canonicalType] ?? item.canonicalType;
  const where = [item.visitName, item.formName].filter(Boolean).join(' › ');

  // The raiser's own statement wins over any reading of its prose.
  if (item.severity === 'data-loss' || /could not commit|work in this form is unsaved/i.test(r)) {
    return {
      risk: 'data-loss',
      what: `This form was never saved. Everything built in it is still a draft and will be lost.`,
      check: `Open ${where || 'the form'} and press its Save button yourself, then Approve.`,
    };
  }

  if (/could not confirm the designer|surface never showed this form/i.test(r)) {
    return {
      risk: 'not-built',
      what: `I could not open this form, so none of its fields were built.`,
      check: `Open ${where || 'the form'} and check whether it is empty. If it is, it needs building by hand.`,
    };
  }

  if (/could not (reach|confirm).*visit|not listed after creation/i.test(r)) {
    return {
      risk: 'not-built',
      what: `I could not open this visit, so nothing under it was built.`,
      check: `Check the visit schedule for "${item.visitName}". If it is missing, it needs adding by hand.`,
    };
  }

  if (/more than one element resolves/i.test(r)) {
    return {
      risk: 'may-be-wrong',
      what: `I found more than one thing called "${field}" on this form, and stopped rather than ` +
            `check the wrong one. Usually that means it was built twice.`,
      check: `Open ${where} and count the fields named "${field}". One is correct — Approve. ` +
             `More than one — delete the extras.`,
    };
  }

  if (/no element with accessible name/i.test(r)) {
    return {
      risk: 'may-be-wrong',
      what: `I built "${field}" (${wanted}) but could not find it again when I looked back at the form.`,
      check: `Open ${where} and look for "${field}". If it is there and correct — Approve. ` +
             `If it is missing — Skip, and it will be listed as not built.`,
    };
  }

  if (/declares no range bounds|range/i.test(r) && /intent specifies/i.test(r)) {
    return {
      risk: 'may-be-wrong',
      what: `"${field}" was built, but the allowed range the file asks for is not showing on it. ` +
            `Some platforms drop a range when the field type changes.`,
      check: `Open ${where}, select "${field}", and check its minimum and maximum.`,
    };
  }

  if (/has role .* but intent .* expects/i.test(r)) {
    return {
      risk: 'may-be-wrong',
      what: `"${field}" was built, but I could not confirm it is ${wanted}.`,
      check: `Open ${where} and look at "${field}". If it behaves as "${wanted}" — Approve. ` +
             `Otherwise use Change type.`,
    };
  }

  if (item.phase === 'binding') {
    return {
      risk: 'not-built',
      what: `Nothing on this platform matched ${wanted}, so "${field}" was not built.`,
      check: `Use Change type to point me at the right control, or Skip to leave it out and record the gap.`,
    };
  }

  return {
    risk: 'may-be-wrong',
    what: `"${field}" needs a second pair of eyes.`,
    check: `Open ${where} and compare "${field}" against the study file.`,
  };
}

const RISK_LABEL: Record<PlainFinding['risk'], string> = {
  'data-loss': 'Work will be lost unless you act',
  'not-built': 'Not built — missing from the study',
  'may-be-wrong': 'Built — needs a look',
};

/** Changing the canonical type only means something when the item IS a type
 *  decision. Offering it on a whole-form failure invites a meaningless answer. */
function offersTypeChange(item: EscalationItem): boolean {
  if (isScopePlaceholder(item.fieldLabel)) return false;
  return item.phase === 'binding' || (item.blastRadius?.fields ?? 0) > 1;
}

/** What the buttons will actually do to THIS item, in plain words.
 *  Keyed off the phase, because "could not build it" and "built it but it
 *  does not match" leave the study in genuinely different states. */
function actionExplanation(item: EscalationItem): string {
  const n = item.blastRadius?.fields ?? 0;
  if (n > 1) {
    return `Approve keeps the agent's choice for all ${n} fields of this type. ` +
           `Change lets you pick the right control and it rebuilds them.`;
  }
  switch (item.phase) {
    case 'acting':
      return item.blocking
        ? 'Nothing here has been built yet, and the build will not go past this until you answer.'
        : 'This was not built — it is missing from the study. Approving records the gap; it will not be retried.';
    case 'verifying':
      return 'It is already in the study but does not match the file. ' +
             'Approving leaves it exactly as it is.';
    case 'binding':
      return item.blocking
        ? 'Every field of this type is stuck until you answer.'
        : 'No control matched, so this field was left out.';
    default:
      return 'Approving records your decision in the audit trail.';
  }
}

function renderEscalationItem(item: EscalationItem): void {
  const container = $(item.blocking ? 'queue-blocking' : 'queue-parked')!;
  const el = document.createElement('div');
  el.className = `escalation-item ${item.blocking ? 'blocking' : 'parked'}`;
  el.dataset.key = item.key;

  // Blast radius turns 195 confirmations into at most 13 decisions: a type
  // mapping answered once settles every field of that type.
  const radius = item.blastRadius
    ? `<div class="radius" style="font-size:11px;color:var(--text-muted);margin-top:4px;">` +
      `Affects ${item.blastRadius.fields} field${item.blastRadius.fields === 1 ? '' : 's'} ` +
      `across ${item.blastRadius.forms} form${item.blastRadius.forms === 1 ? '' : 's'}. ` +
      `Answering once settles all of them.</div>`
    : '';

  const skipLabel = item.blastRadius && item.blastRadius.fields > 1
    ? `Skip these ${item.blastRadius.fields}`
    : 'Skip it';

  const plain = plainFinding(item);
  el.dataset.risk = plain.risk;

  // The type badge is only meaningful when the item is actually about a field
  // of that type. On a whole-form or whole-visit escalation it is noise.
  const typeBadge = isScopePlaceholder(item.fieldLabel)
    ? ''
    : `<span class="type-badge">${esc(item.canonicalType)}</span>`;

  el.innerHTML = `
    <div class="loc">${locationLine(item)}</div>
    <div class="header">
      <span class="field-name">${esc(headline(item))}</span>
      ${typeBadge}
    </div>
    <div class="reason">${esc(plain.what)}</div>
    <div class="check"><b>What to check:</b> ${esc(plain.check)}</div>
    ${item.suspectedTrap ? `<div class="trap">Why this happens: ${esc(item.suspectedTrap)}</div>` : ''}
    ${radius}
    <div class="ask">${esc(actionExplanation(item))}</div>
    <details class="evidence">
      <summary>Technical detail (for the audit trail)</summary>
      <div class="body">${[item.reason, ...item.evidence].map(esc).join('<br>')}</div>
    </details>
    <div class="btn-group">
      <button class="btn btn-sm btn-primary" data-action="approve" data-key="${item.key}">✓ Approve</button>
      ${offersTypeChange(item)
        ? `<button class="btn btn-sm btn-warning" data-action="override" data-key="${item.key}">✎ Change type</button>`
        : ''}
      <button class="btn btn-sm" data-action="skip" data-key="${item.key}">⊘ ${skipLabel}</button>
    </div>
    <input data-role="note" placeholder="Note (optional, recorded in the audit trail)"
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
      updateQueueStatus();
    });
  });

  // Severest first. Cards arrive in build order, which buries the one item
  // that loses work under however many merely want a second look -- live, an
  // unsaved form sat at position 100 of 100. Insert ahead of the first card
  // that matters less than this one; equal severity keeps build order.
  const RANK: Record<string, number> = { 'data-loss': 0, 'not-built': 1, 'may-be-wrong': 2 };
  const mine = RANK[plain.risk] ?? 3;
  const after = [...container.children].find(
    (c) => (RANK[(c as HTMLElement).dataset.risk ?? ''] ?? 3) > mine,
  );
  container.insertBefore(el, after ?? null);
  updateQueueStatus();
}

/** One place that decides what the queue tab says about itself. Blocking and
 *  parked items are counted separately because they ask different things of
 *  the reviewer: one halts the build, the other is a to-read pile. */
function updateQueueStatus(): void {
  const blocking = escalationQueue.filter((i) => i.blocking).length;
  const parked = escalationQueue.length - blocking;

  $('queue-blocking-group')!.classList.toggle('hidden', blocking === 0);
  $('queue-parked-group')!.classList.toggle('hidden', parked === 0);
  $('queue-legend')!.classList.toggle('hidden', escalationQueue.length === 0);
  $('queue-blocking-count')!.textContent = String(blocking);
  $('queue-parked-count')!.textContent = String(parked);
  $('queue-actions')!.classList.toggle('hidden', parked < 3);

  const status = $('queue-status')!;
  if (buildFinished) {
    status.className = 'status-banner idle';
    status.textContent = parked + blocking === 0
      ? 'Build finished. Nothing needed review.'
      : `Build finished. ${parked + blocking} item${parked + blocking === 1 ? '' : 's'} to review — ` +
        `nothing is waiting on you.`;
  } else if (blocking > 0) {
    status.className = 'status-banner paused';
    status.textContent = parked > 0
      ? `Build paused — ${blocking} to answer now, ${parked} to review later.`
      : `Build paused — ${blocking} ${blocking === 1 ? 'item needs' : 'items need'} your answer.`;
  } else if (parked > 0) {
    status.className = 'status-banner idle';
    status.textContent = `Nothing is blocking the build. ${parked} ${parked === 1 ? 'item' : 'items'} parked for review.`;
  } else {
    status.className = 'status-banner idle';
    status.textContent = 'No escalations yet';
  }
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
    updateQueueStatus();
  });
}

function sendDecision(key: string, decision: HumanDecision): void {
  chrome.runtime.sendMessage({ type: 'HUMAN_DECISION', key, decision });
  logEvent('human_decision', `${key}: ${decision.action}${decision.overrideType ? ` -> ${decision.overrideType}` : ''}`);
}

// Approve every PARKED item. Blocking items are deliberately excluded: they
// are the handful of questions the build genuinely could not answer, and
// sweeping them up with one click is how a real decision gets rubber-stamped.
$('approve-all-btn')!.addEventListener('click', () => {
  const parked = escalationQueue.filter((i) => !i.blocking);
  for (const item of parked) {
    sendDecision(item.key, { action: 'approve', note: 'bulk approve (parked)' });
  }
  $('queue-parked')!.innerHTML = '';
  escalationQueue = escalationQueue.filter((i) => i.blocking);
  updateQueueBadge();
  updateQueueStatus();
  logEvent('bulk_approve', `${parked.length} parked item(s)`);
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
// Keep the service worker alive while this panel is open.
// ---------------------------------------------------------------------------

function connectKeepAlive(): void {
  try {
    const port = chrome.runtime.connect({ name: 'sidepanel-keepalive' });
    port.onDisconnect.addListener(() => {
      // Port drops on worker restart OR transient disconnect while the panel
      // sits on a blocking gate. Reconnect first and ask the worker whether a
      // run is still alive before declaring the build stopped — otherwise a
      // keep-alive blip collapses the queue UI while execute() is still
      // waiting on HUMAN_DECISION.
      setTimeout(async () => {
        connectKeepAlive();
        try {
          const state = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
          const stillGoing =
            state?.phase === 'executing' ||
            state?.phase === 'paused' ||
            (Array.isArray(state?.escalationQueue) &&
              state.escalationQueue.some((e: { blocking?: boolean }) => e.blocking));
          if (stillGoing) {
            if (state.phase === 'paused') {
              isPaused = true;
              isRunning = false;
            } else {
              isRunning = true;
              isPaused = false;
            }
            if (Array.isArray(state.escalationQueue)) {
              for (const item of state.escalationQueue) {
                if (!escalationQueue.some((q) => q.key === item.key)) {
                  handleEscalation(item);
                }
              }
            }
            return;
          }
        } catch {
          // Worker really gone — fall through.
        }
        if (isRunning || isPaused) {
          isRunning = false;
          isPaused = false;
          updateStatus(
            'idle',
            'Build agent stopped (extension worker restarted). Click Start to resume from saved progress.',
          );
          $('pause-btn')?.classList.add('hidden');
          $('resume-btn')?.classList.add('hidden');
          $('start-btn')?.classList.remove('hidden');
        }
      }, 750);
    });
  } catch {
    setTimeout(connectKeepAlive, 1500);
  }
}
connectKeepAlive();

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
  buildFinished = true;
  for (const item of items) {
    if (!escalationQueue.some((q) => q.key === item.key)) {
      escalationQueue.push(item);
      renderEscalationItem(item);
    }
  }
  updateQueueBadge();
  updateQueueStatus();
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
