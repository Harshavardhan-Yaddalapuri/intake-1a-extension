// test/scramble.mjs
// Seeded, memoised vocabulary scrambler.
//
// The point: if BIND still finds its candidates after every accessible name
// on the page has been replaced with nonsense, then English words are not
// load-bearing. Because the nonsense differs per seed, this cannot be tuned
// to the way a hand-written fixture can.

const SYLLABLES = [
  'ka', 'zo', 'mir', 'tuv', 'lex', 'pon', 'dra', 'feq',
  'wub', 'nyx', 'gel', 'sot', 'ryn', 'quo', 'vash', 'ild',
];

/** Returns a memoised scramble function. Same seed => same mapping. */
export function makeScrambler(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    // Numerical Recipes LCG. Deterministic, adequate for naming.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const memo = new Map();
  return function scramble(name) {
    if (!name) return name;
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const count = 2 + Math.floor(next() * 2);
    let out = '';
    for (let i = 0; i < count; i += 1) {
      out += SYLLABLES[Math.floor(next() * SYLLABLES.length)];
    }
    const word = out.charAt(0).toUpperCase() + out.slice(1);
    memo.set(name, word);
    return word;
  };
}

/** Returns a copy of `observation` with every name and option scrambled.
 *  Roles, handles, indices, and state are untouched — only vocabulary moves. */
export function scrambleObservation(observation, seed) {
  const scramble = makeScrambler(seed);
  return {
    ...observation,
    title: scramble(observation.title),
    elements: observation.elements.map((e) => ({
      ...e,
      name: scramble(e.name),
      options: e.options.map(scramble),
    })),
  };
}
