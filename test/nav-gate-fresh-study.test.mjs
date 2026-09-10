/**
 * Swapped/Nexus live v8–v9: visit-open gate → human Approve → orchestrator
 * still skipSpan'd the visit → ~208 pending ("skipped") and GT stuck at
 * Screening + empty Demographics.
 *
 * Approve must NOT by itself continue. Re-perceived surface evidence must.
 * Skip without surface must still refuse (do not build into the wrong visit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { observe } from '../dist/perceive-core.mjs';
import {
  atVisitList,
  atVisitDetail,
  bindVisitCreate,
} from '../dist/bind-rung0.mjs';
import {
  navGateAllowsContinue,
  navGateShouldRetryOpen,
} from '../dist/nav-gate.mjs';

const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];

test('approve alone does not continue without visit detail on screen', () => {
  // The live defect: Approve was treated as success and the loop still
  // skipSpan'd — or worse, would have continued into the wrong surface.
  assert.equal(navGateAllowsContinue({ action: 'approve' }, false), false);
  assert.equal(navGateAllowsContinue({ action: 'retry' }, false), false);
  assert.equal(navGateAllowsContinue({ action: 'skip' }, false), false);
  assert.equal(navGateAllowsContinue(null, false), false);
});

test('surface evidence continues even when the prior open attempt failed', () => {
  // Human opened Screening while the gate was up, or a retry landed.
  assert.equal(navGateAllowsContinue({ action: 'approve' }, true), true);
  assert.equal(navGateAllowsContinue({ action: 'skip' }, true), true);
  assert.equal(navGateAllowsContinue(null, true), true);
});

test('approve/retry ask for one more open click; skip does not', () => {
  assert.equal(navGateShouldRetryOpen({ action: 'approve' }), true);
  assert.equal(navGateShouldRetryOpen({ action: 'retry' }), true);
  assert.equal(navGateShouldRetryOpen({ action: 'skip' }), false);
  assert.equal(navGateShouldRetryOpen(null), false);
});

test('fresh Nexus roadmap: create+open Screening is recognisable (no false skip)', async () => {
  const core = readFileSync('./generalization/env-swapped-controls/core.js', 'utf8');
  const ui = readFileSync('./generalization/env-swapped-controls/ui.js', 'utf8');
  const style = readFileSync('./generalization/env-swapped-controls/style.css', 'utf8');
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><style>${style}</style></head><body><div id="root"></div>
     <script>${core}</script><script>${ui}</script></body></html>`,
    { runScripts: 'dangerously', url: 'http://127.0.0.1:4094/?reset=1' },
  );
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 30));

  const empty = observe(window.document);
  const create = bindVisitCreate(empty)?.recipe?.[0]?.evidence_name;
  assert.equal(create, '+ New Cycle');
  assert.equal(atVisitList(empty, VISITS, create), true);
  assert.equal(atVisitDetail(empty, 'Screening', VISITS), false);

  window.document.getElementById('add-visit').click();
  await new Promise((r) => setTimeout(r, 20));
  for (const [id, val] of [
    ['visit-name', 'Screening'],
    ['visit-start', '-28'],
    ['visit-end', '-1'],
  ]) {
    const el = window.document.getElementById(id);
    el.value = val;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  window.document.getElementById('save-visit').click();
  await new Promise((r) => setTimeout(r, 20));

  const listed = observe(window.document);
  assert.equal(atVisitList(listed, VISITS, create), true);
  const openBtn = [...window.document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Screening',
  );
  assert.ok(openBtn, 'Screening must appear on the fresh roadmap after create');
  openBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  const detail = observe(window.document);
  const onVisitList = (o) => atVisitList(o, VISITS, create) && !atVisitDetail(o);
  const opened =
    atVisitDetail(detail, 'Screening', VISITS) ||
    (Boolean(openBtn) && !onVisitList(detail));
  assert.equal(opened, true, 'fresh Screening open must confirm — not skipSpan');
  assert.equal(
    navGateAllowsContinue({ action: 'approve' }, atVisitDetail(detail, 'Screening', VISITS)),
    true,
  );
});
