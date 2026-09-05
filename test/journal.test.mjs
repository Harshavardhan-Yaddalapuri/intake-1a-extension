import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, toJsonl, toHtmlReport } from '../dist/journal.mjs';

function fixture() {
  const j = new Journal('run-abc', 1_700_000_000_000);
  j.created(
    { path: 'visits[0].forms[2].fields[1]', visit_name: 'Screening', form_name: 'Vital Signs',
      field_label: 'Heart Rate', declared_type: 'integer' },
    'field.add',
    { rung: 1, evidence: ['probe placed control; read back role "spinbutton"'] },
    { verdict: 'VERIFIED', reason: 'label, required and range all match' },
  );
  j.adopted(
    { path: 'visits[1].forms[0].fields[0]', visit_name: 'Week 4', form_name: 'Vital Signs',
      field_label: 'Heart Rate', declared_type: 'integer' },
    'already present and matching; left alone',
  );
  j.escalated(
    { path: 'visits[0].forms[1].fields[3]', visit_name: 'Screening', form_name: 'Demographics',
      field_label: 'Sex', declared_type: 'single_select' },
    'names and behaviour disagree',
    { action: 'override', note: 'Beam Pick is the dropdown here' },
  );
  return j;
}

test('every record carries a monotonically increasing seq', () => {
  assert.deepEqual(fixture().records().map((r) => r.seq), [1, 2, 3]);
});

test('every record traces back to a path in the input file', () => {
  for (const r of fixture().records()) {
    assert.match(r.ir_source.path, /^visits\[\d+\]/);
    assert.ok(r.ir_source.visit_name);
    assert.ok(r.ir_source.form_name);
  }
});

test('a created record carries the binding rung and its evidence', () => {
  const r = fixture().records()[0];
  assert.equal(r.outcome, 'created');
  assert.equal(r.binding.rung, 1);
  assert.ok(r.binding.evidence.length > 0);
  assert.equal(r.verification.verdict, 'VERIFIED');
});

test('an adopted record explains why nothing was built', () => {
  const r = fixture().records()[1];
  assert.equal(r.outcome, 'adopted');
  assert.match(r.verification.reason, /already present/i);
});

test('an escalated record carries the human decision', () => {
  const r = fixture().records()[2];
  assert.equal(r.outcome, 'escalated');
  assert.equal(r.human.action, 'override');
  assert.match(r.human.note, /Beam Pick/);
});

test('records are frozen: the journal is append-only', () => {
  const r = fixture().records()[0];
  assert.throws(() => { r.outcome = 'tampered'; }, TypeError);
});

test('records() returns a copy, so callers cannot splice history', () => {
  const j = fixture();
  j.records().pop();
  assert.equal(j.records().length, 3);
});

test('toJsonl emits one parseable object per line', () => {
  const lines = toJsonl(fixture().records()).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const p = JSON.parse(line);
    assert.ok(p.seq);
    assert.ok(p.ir_source.path);
  }
});

test('toHtmlReport groups by visit then form', () => {
  const html = toHtmlReport(fixture(), { studyTitle: 'ABC-101' });
  for (const s of ['Screening', 'Week 4', 'Vital Signs', 'Heart Rate', 'ABC-101']) {
    assert.match(html, new RegExp(s));
  }
});

test('toHtmlReport escapes content rather than injecting it', () => {
  const j = new Journal('run-x', 0);
  j.adopted({ path: 'visits[0].forms[0].fields[0]', visit_name: 'V', form_name: 'F',
              field_label: '<script>alert(1)</script>' }, 'present');
  const html = toHtmlReport(j, { studyTitle: 'T' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('a note records something worth remembering without a field', () => {
  const j = new Journal('run-y', 0);
  j.note('v0.f0', 'form arrived already populated; platform shares definitions');
  const r = j.records()[0];
  assert.equal(r.outcome, 'note');
  assert.match(r.verification.reason, /shares definitions/);
});
