/**
 * Rung 2: LLM candidate ranking.
 *
 * Invoked only when rung 0 (structural role + accessible name) and rung 1
 * (place-and-inspect probe) both fail to resolve a canonical type to a
 * platform control. Most types on most platforms never reach it.
 *
 * HARD WALLS:
 *   - The model sees only what PERCEIVE already observed: role, name, name
 *     source, probe outcome. No HTML, no DOM, no CSS, no ACT handles.
 *   - The model may only REORDER the candidates it was given. It cannot
 *     introduce one. parseResponse rejects any answer that tries.
 *   - The model never has the last word. Its top pick is placed and read back;
 *     if the read-back disagrees, the item escalates with both opinions shown.
 *   - Every failure path returns null, which means "ask a human", never
 *     "guess". A confidently wrong answer must not be able to reach the study.
 */

import type { CanonicalType } from '../shared/contract';
import type { RankedCandidate } from './ranking';

const MODEL = 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface LlmRankedCandidate extends RankedCandidate {
  llmRationale: string;
  llmRank: number;
}

/** What each canonical type means, so the model reasons about semantics rather
 *  than matching spelling. The brief is explicit that the two are related by
 *  meaning, not by spelling. */
const TYPE_MEANING: Record<CanonicalType, string> = {
  text: 'a single line of free text',
  textarea: 'multiple lines of free text',
  integer: 'a whole number',
  decimal: 'a number with a fractional part',
  date: 'a calendar date',
  time: 'a time of day',
  datetime: 'a date together with a time',
  boolean: 'a single yes/no answer',
  single_select: 'a list of choices from which exactly ONE is chosen',
  multi_select: 'a list of choices from which SEVERAL may be chosen',
  radio: 'a set of mutually exclusive options, all visible at once',
  checkbox: 'a single independent tick box, NOT a list of choices',
  calculated: 'a read-only value derived from other fields',
};

export function buildRequest(
  canonicalType: CanonicalType,
  candidates: readonly RankedCandidate[],
): Record<string, unknown> {
  const listing = candidates
    .map((c, i) => {
      const probe = c.signals.map((s) => s.detail).join('; ');
      return (
        `${i}. role="${c.el.role}" name="${c.el.name}" nameSource="${c.el.nameSource}"` +
        (probe ? ` observed: ${probe}` : '')
      );
    })
    .join('\n');

  return {
    model: MODEL,
    max_tokens: 1024,
    system:
      'You help an automated agent choose which control in a form-designer ' +
      'element library corresponds to a canonical field type. You are given ' +
      'only what the agent observed through the accessibility tree. ' +
      'Platforms routinely place near-identical names next to each other: a ' +
      'list-of-choices control and a single tick box may sit one row apart ' +
      'with almost the same name, and names may be in any language or ' +
      'invented vocabulary. Reason from role and observed behaviour first, ' +
      'and from names only as weak evidence. ' +
      'Reply with JSON only: {"ranking":[{"index":<number>,"reason":"<short>"}]} ' +
      'ordered best first. Use ONLY the indices given. Do not invent a ' +
      'candidate. If nothing fits, return {"ranking":[]}.',
    messages: [
      {
        role: 'user',
        content:
          `Canonical type: ${canonicalType} — ${TYPE_MEANING[canonicalType]}\n\n` +
          `Observed candidates:\n${listing}\n\n` +
          `Which candidates could realise this type? Rank them best first.`,
      },
    ],
  };
}

export interface ParsedRanking {
  index: number;
  reason: string;
}

/** Parse the model's reply. Strict: anything that is not a ranking over the
 *  supplied indices throws, and the caller degrades to human escalation. */
export function parseResponse(text: string, candidateCount: number): ParsedRanking[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('rung 2: could not parse a JSON object from the model reply');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('rung 2: could not parse the model reply as JSON');
  }

  const ranking = (parsed as { ranking?: unknown }).ranking;
  if (!Array.isArray(ranking)) {
    throw new Error('rung 2: the model reply has no ranking array');
  }

  return ranking.map((entry) => {
    const index = (entry as { index?: unknown }).index;
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw new Error(
        'rung 2: a ranking entry has no integer index (the model may have invented a candidate)',
      );
    }
    if (index < 0 || index >= candidateCount) {
      throw new Error(`rung 2: ranking index ${index} is out of range 0..${candidateCount - 1}`);
    }
    const reason = (entry as { reason?: unknown }).reason;
    return { index, reason: typeof reason === 'string' ? reason : '' };
  });
}

export interface RankWithLlmDeps {
  apiKey: string | null;
  fetch: (url: string, init?: unknown) => Promise<any>;
}

/**
 * Reorder candidates using the model. Returns null on EVERY failure path — no
 * key, network error, non-200, unparseable reply, invented candidate —
 * because the correct response to "the model could not help" is to ask a
 * human, never to guess.
 */
export async function rankWithLlm(
  canonicalType: CanonicalType,
  candidates: readonly RankedCandidate[],
  deps: RankWithLlmDeps,
): Promise<LlmRankedCandidate[] | null> {
  if (!deps.apiKey) return null;
  if (candidates.length === 0) return null;

  try {
    const response = await deps.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': deps.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequest(canonicalType, candidates)),
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const text = (payload?.content ?? [])
      .filter((b: { type?: string }) => b?.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('');
    if (!text) return null;

    return parseResponse(text, candidates.length).map((entry, rank) => ({
      ...candidates[entry.index],
      llmRationale: entry.reason,
      llmRank: rank,
    }));
  } catch {
    return null;
  }
}
