// Two live defects in the commit path (2026-09-05, run-1788663541434):
//
//   could not commit "Eligibility Criteria": tried 5 candidate(s)
//   (Save, Patients, Calendar, Study Plan, Reports) and none cleared the
//   working copy.
//
//  1. FALSE NEGATIVE. The fast path asked "is any status-ish word still on
//     screen?" using LEXICAL_HINTS.status, which contains BOTH halves of the
//     distinction -- 'saved' and 'unsaved', 'draft' and 'committed'. After a
//     real save the platform announces "Saved." and the document is still
//     "Draft" (a lifecycle state, unrelated to whether the working copy is
//     pending), so a successful save proved itself a failure. The form had
//     actually been saved; everything after that was noise.
//
//  2. DESTRUCTIVE PROBING. Four top-level navigation tabs were clicked to
//     find out whether they save. On any platform where navigating away
//     discards the draft -- this one does -- that destroys the work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observe } from '../dist/perceive-core.mjs';
import { analyzeCommit, sameSurface } from '../dist/bind-rung1.mjs';
import { rankCommitCandidates, rankAscendCandidates } from '../dist/bind-rung0.mjs';
import { LEXICAL_HINTS, enumerateActionable } from '../dist/bind-ranking.mjs';
import { normaliseLabel } from '../dist/reconcile.mjs';

const doc = (h) => new JSDOM(`<!doctype html><html><body><div id="app">${h}</div></body></html>`).window.document;

const TOP_NAV = `<nav><button>Patients</button><button>Calendar</button>
  <button>Study Plan</button><button>Reports</button></nav>`;

// The builder header, as the mock renders it before and after a real save.
const builder = (statusLine, notice) => `${TOP_NAV}
  <header><button>← Screening</button><span class="builder-title">Eligibility Criteria</span>
    <p class="meta">${statusLine}</p>
    ${notice ? `<p class="notice">${notice}</p>` : ''}
    <button>Preview Form</button><button>Save As Template</button>
    <button>Save</button><button>Activate</button></header>
  <main><button>+ Page</button></main>`;

const DIRTY = observe(doc(builder('v1 · Draft · Unsaved changes', null)));
const SAVED = observe(doc(builder('v1 · Draft', 'Saved.')));

test("a successful save's own announcement reads as proof it did not save", () => {
  // Documents WHY the old check was unusable, so nobody reintroduces it.
  // The list holds both halves of the distinction:
  for (const w of ['saved', 'unsaved', 'draft', 'committed']) {
    assert.ok(LEXICAL_HINTS.status.includes(w), `'${w}' is in the list`);
  }
  // The old fast path ran this AFTER clicking, and treated a match as
  // "there is still unsaved work".
  const oldHasUnsaved = (obs) => obs.elements.some(
    (e) => e.name.length > 0 && LEXICAL_HINTS.status.some((w) => e.name.toLowerCase().includes(w)),
  );
  const saved = SAVED.elements.find((e) => e.name === 'Saved.');
  assert.ok(saved, 'the platform announces the save as a status element');
  assert.equal(
    oldHasUnsaved(SAVED), true,
    'so the announcement of SUCCESS matched the unsaved-work list -- the check could never pass',
  );
});

test('the structural test does distinguish them', () => {
  assert.equal(
    analyzeCommit(DIRTY, SAVED).committed, true,
    'the "Unsaved changes" indicator disappeared; that is the commit signal',
  );
  assert.equal(
    analyzeCommit(SAVED, SAVED).committed, false,
    'nothing disappeared, so nothing was committed',
  );
});

test('a decoy that persists nothing is not reported as a commit', () => {
  // "Save As Template" announces success and leaves the working copy pending.
  const afterDecoy = observe(doc(builder('v1 · Draft · Unsaved changes', 'Saved as a reusable template.')));
  assert.equal(
    analyzeCommit(DIRTY, afterDecoy).committed, false,
    'the working-copy indicator is still there, so it did not commit',
  );
});

test('navigating away is never mistaken for a commit', () => {
  // The dangerous inverse of the fix: leaving the builder loses ALL the text,
  // including the pending marker. If that counted, the agent would record a
  // control that discards the working copy as the platform's save control.
  const elsewhere = observe(doc(`${TOP_NAV}<h2>Visit Schedule</h2>
    <table><tbody><tr><td><button class="link">Screening</button></td></tr></tbody></table>
    <button>+ Add Visit</button>`));
  assert.equal(
    analyzeCommit(DIRTY, elsewhere).committed, false,
    'the whole surface changed -- that is navigation, not persistence',
  );
});

test('departure is detected after the fact, not predicted', () => {
  // Live: with nav chrome filtered the remaining order was
  //   Save -> "← Screening" -> "Preview Form" -> Activate
  // so a Save that went unrecognised meant clicking the breadcrumb (which
  // discards the working copy) and then Preview (which opened the modal that
  // made the next form's designer unreachable).
  //
  // The ascend ranker used to miss the breadcrumb here: it sits in the
  // builder's largest control cluster, which is excluded structurally as the
  // palette, and "+ Page" ranked top and goes nowhere. rankAscendCandidates
  // now exempts ascend-shaped controls from that exclusion, so the breadcrumb
  // ranks first -- above four top-nav tabs that lexically resemble a visit
  // list and do not lead to one.
  const visitNames = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];
  const ascendNames = rankAscendCandidates(DIRTY, visitNames).map((e) => e.name);
  assert.equal(
    ascendNames[0], '← Screening',
    'the control naming a known visit outranks nav chrome and "+ Page"',
  );

  // Ranking it first is still only a guess about an unseen platform, so the
  // commit loop does not rely on it: it stops as soon as a click has
  // demonstrably left the surface, whichever control did it.

  const elsewhere = observe(doc(`${TOP_NAV}<h2>Visit Schedule</h2>
    <table><tbody><tr><td><button class="link">Screening</button></td></tr></tbody></table>
    <button>+ Add Visit</button>`));
  assert.equal(sameSurface(DIRTY, elsewhere), false, 'leaving the builder is detected');
  assert.equal(sameSurface(DIRTY, SAVED), true, 'saving in place is not mistaken for leaving');
});

test('navigation chrome is excluded from commit trials', () => {
  // Names seen on the visit list, where there is no working copy at all.
  const visitList = observe(doc(`${TOP_NAV}<h2>Visit Schedule</h2>
    <table><tbody><tr><td><button class="link">Screening</button></td></tr></tbody></table>
    <button>+ Add Visit</button>`));
  const chrome = new Set(
    enumerateActionable(visitList).map((e) => normaliseLabel(e.name)).filter(Boolean),
  );

  const trials = rankCommitCandidates(DIRTY)
    .map((r) => r.el)
    .filter((el) => !chrome.has(normaliseLabel(el.name)));
  const names = trials.map((t) => t.name);

  for (const nav of ['Patients', 'Calendar', 'Study Plan', 'Reports']) {
    assert.ok(!names.includes(nav), `"${nav}" navigates away and must never be probed as a commit`);
  }
  assert.ok(names.includes('Save'), `the real commit control must survive; got: ${names.join(', ')}`);
});
