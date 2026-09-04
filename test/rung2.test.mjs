import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, rankWithLlm } from '../dist/bind-rung2.mjs';
import { elem, resetSeq } from './fixtures/obs.mjs';

function candidates() {
  resetSeq();
  return [
    { el: elem('button', 'Beam Pick'), score: 1, signals: [] },
    { el: elem('button', 'Orbit List'), score: 1, signals: [] },
    { el: elem('button', 'Tick Box'), score: 0, signals: [] },
  ];
}

test('the request contains only observed candidates, never DOM', () => {
  const body = JSON.stringify(buildRequest('single_select', candidates()));
  assert.ok(body.includes('Beam Pick'));
  assert.ok(body.includes('single_select'));
  assert.ok(!body.includes('handle'), 'ACT handles must not be sent');
  // No page markup may leak. Check for real tag names rather than any
  // angle bracket -- the prompt legitimately contains <number>/<short>
  // placeholders describing the reply schema.
  const HTML_TAGS = /<\/?(?:div|span|button|input|select|option|label|form|table|tr|td|a|p|ul|li)\b/i;
  assert.ok(!HTML_TAGS.test(body), 'no page markup may appear in the request');
  assert.ok(!body.includes('querySelector') && !body.includes('class='), 'no DOM or CSS may be sent');
});

test('the request names a real OpenRouter model id', () => {
  assert.match(buildRequest('single_select', candidates()).model, /\//,
    'OpenRouter model ids are namespaced as "<provider>/<model>", e.g. "deepseek/deepseek-chat-v3.1:free"');
});

test('the request explains the type semantically, not by spelling', () => {
  const body = JSON.stringify(buildRequest('checkbox', candidates()));
  assert.ok(body.includes('single independent tick box'), 'type meaning must be sent');
});

test('parseResponse accepts a valid ranking', () => {
  const r = parseResponse(JSON.stringify({ ranking: [{ index: 1, reason: 'a list control' }, { index: 0, reason: 'a picker' }] }), 3);
  assert.deepEqual(r.map((x) => x.index), [1, 0]);
  assert.equal(r[0].reason, 'a list control');
});

test('parseResponse tolerates prose and fences around the JSON', () => {
  const r = parseResponse('Here you go:\n```json\n{"ranking":[{"index":2,"reason":"tick box"}]}\n```', 3);
  assert.equal(r[0].index, 2);
});

test('parseResponse rejects an out-of-range index', () => {
  assert.throws(() => parseResponse(JSON.stringify({ ranking: [{ index: 9, reason: 'x' }] }), 3), /range/i);
});

test('parseResponse rejects an invented candidate', () => {
  assert.throws(() => parseResponse(JSON.stringify({ ranking: [{ name: 'Something Else', reason: 'x' }] }), 3), /index/i);
});

test('parseResponse rejects unparseable output', () => {
  assert.throws(() => parseResponse('I am not sure, sorry.', 3), /parse/i);
});

test('rankWithLlm returns null when no key is configured', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: null, fetch: async () => { throw new Error('must not be called'); },
  });
  assert.equal(r, null);
});

test('rankWithLlm returns null on a network failure', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test', fetch: async () => { throw new Error('offline'); },
  });
  assert.equal(r, null, 'a failed call degrades to escalation, never to a guess');
});

test('rankWithLlm returns null on a non-200 response', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test', fetch: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
  });
  assert.equal(r, null);
});

test('rankWithLlm returns null on malformed content', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'no idea' } }] }) }),
  });
  assert.equal(r, null);
});

test('rankWithLlm reorders the given candidates and nothing else', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-test',
    fetch: async () => ({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ ranking: [{ index: 1, reason: 'a list' }] }) } }] }) }),
  });
  assert.ok(r);
  assert.equal(r.length, 1);
  assert.equal(r[0].el.name, 'Orbit List');
  assert.equal(r[0].llmRationale, 'a list');
  assert.equal(r[0].llmRank, 0);
});

test('the API key never appears in the returned evidence', async () => {
  const r = await rankWithLlm('single_select', candidates(), {
    apiKey: 'sk-or-v1-secret',
    fetch: async () => ({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ ranking: [{ index: 0, reason: 'r' }] }) } }] }) }),
  });
  assert.ok(!JSON.stringify(r).includes('sk-or-v1-secret'));
});
