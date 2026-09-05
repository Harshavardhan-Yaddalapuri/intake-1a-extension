// test/ranking.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEXICAL_HINTS,
  enumerateActionable,
  enumerateByRoles,
  explainRanking,
  rankCandidates,
} from '../dist/bind-ranking.mjs';
import { elem, obs, resetSeq } from './fixtures/obs.mjs';

function screen() {
  resetSeq();
  return obs([
    elem('button', 'Save'),
    elem('button', 'Cancel'),
    elem('button', 'Zzyzx'),
    elem('link', 'Study Plan'),
    elem('textbox', 'Field Label'),
    elem('heading', 'Form Designer'),
  ]);
}

test('enumerateActionable selects by role, never by name', () => {
  const pool = enumerateActionable(screen());
  const names = pool.map((e) => e.name);
  assert.ok(names.includes('Zzyzx'), 'a nonsense-named button must still be enumerated');
  assert.ok(names.includes('Save'));
  assert.ok(!names.includes('Form Designer'), 'a heading is not actionable');
  assert.ok(!names.includes('Field Label'), 'a textbox is not actionable');
});

test('enumerateByRoles selects exactly the requested roles', () => {
  const pool = enumerateByRoles(screen(), ['textbox', 'heading']);
  assert.deepEqual(pool.map((e) => e.name).sort(), ['Field Label', 'Form Designer']);
});

// THE invariant. If this ever fails, the defect has regrown.
test('rankCandidates returns every candidate it was given', () => {
  const pool = enumerateActionable(screen());
  for (const hint of Object.keys(LEXICAL_HINTS)) {
    const ranked = rankCandidates(pool, { hint });
    assert.equal(
      ranked.length,
      pool.length,
      `hint "${hint}" dropped ${pool.length - ranked.length} candidate(s); ` +
      `lexical hints must rank, never exclude`,
    );
  }
});

test('rankCandidates with no options still returns everything', () => {
  const pool = enumerateActionable(screen());
  assert.equal(rankCandidates(pool).length, pool.length);
});

test('a lexical hint raises rank but does not remove others', () => {
  const pool = enumerateActionable(screen());
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked[0].el.name, 'Save', 'the hinted candidate should rank first');
  assert.ok(
    ranked.some((r) => r.el.name === 'Zzyzx'),
    'an unhinted candidate must remain in the ranking',
  );
});

test('a nonsense-named pool still produces a ranking', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Vashild'),
    elem('button', 'Ponmir'),
    elem('button', 'Gelsot'),
  ]));
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].el.name, 'a top candidate must exist even with zero lexical signal');
});

test('diff membership outranks a lexical hint', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Save', { handle: '0.1.1' }),
    elem('button', 'Zzyzx', { handle: '0.1.2' }),
  ]));
  const ranked = rankCandidates(pool, { hint: 'commit', diffAdded: ['0.1.2'] });
  assert.equal(
    ranked[0].el.name,
    'Zzyzx',
    'structural evidence (appeared in the diff) must outweigh an English word',
  );
});

test('a disabled control is demoted but not removed', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Save', { state: { disabled: true } }),
    elem('button', 'Zzyzx'),
  ]));
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked[0].el.name, 'Zzyzx');
  assert.equal(ranked.length, 2, 'the disabled control stays in the pool');
});

test('ranking is stable: equal scores preserve input order', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Alpha'),
    elem('button', 'Beta'),
    elem('button', 'Gamma'),
  ]));
  const ranked = rankCandidates(pool);
  assert.deepEqual(ranked.map((r) => r.el.name), ['Alpha', 'Beta', 'Gamma']);
});

test('every ranked candidate carries its signals as evidence', () => {
  const pool = enumerateActionable(screen());
  const ranked = rankCandidates(pool, { hint: 'commit' });
  const top = ranked[0];
  assert.ok(Array.isArray(top.signals));
  assert.ok(top.signals.length > 0, 'the top candidate must explain its score');
  for (const signal of top.signals) {
    assert.ok(typeof signal.detail === 'string' && signal.detail.length > 0);
  }
});

test('a div-based control with no ARIA role is still enumerated', () => {
  resetSeq();
  // What an accessibility-hostile platform looks like after PERCEIVE:
  // clickable divs, role 'generic', no semantic markup anywhere.
  const pool = enumerateActionable(obs([
    elem('generic', 'Publish'),
    elem('generic', 'Discard'),
    elem('generic', 'Vashild'),
  ]));
  assert.equal(
    pool.length, 3,
    'role-less clickable divs are how hostile platforms build buttons; ' +
    'dropping them empties the candidate pool exactly as a lexical gate would',
  );
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].el.name, 'Publish', 'the commit hint should still order them');
});

test('regionHandle matches descendants, not siblings', () => {
  resetSeq();
  const pool = enumerateActionable(obs([
    elem('button', 'Inside', { handle: '0.3.1.0' }),
    elem('button', 'Sibling', { handle: '0.3.12' }),
  ]));
  const ranked = rankCandidates(pool, { regionHandle: '0.3.1' });
  const inside = ranked.find((r) => r.el.name === 'Inside');
  const sibling = ranked.find((r) => r.el.name === 'Sibling');
  assert.ok(inside.signals.some((s) => s.name === 'in-region'));
  assert.ok(!sibling.signals.some((s) => s.name === 'in-region'), '0.3.12 is not inside 0.3.1');
});

test('explainRanking reports the candidate\'s real position, not always 1st', () => {
  const pool = enumerateActionable(screen());
  const ranked = rankCandidates(pool, { hint: 'commit' });
  assert.match(explainRanking(ranked[0], pool.length), /^ranked 1 of 4 /);
  assert.match(
    explainRanking(ranked[2], pool.length, 2),
    /^ranked 3 of 4 /,
    'a probe falling through to its third candidate must not record "1st"',
  );
});
