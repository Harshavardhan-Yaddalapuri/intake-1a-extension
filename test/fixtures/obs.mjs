// Builds synthetic Observation objects for tests that exercise BIND and
// VERIFY without needing a DOM. Mirrors the shape emitted by
// src/perceive/core.ts observe().

let seq = 0;

/** One ObservationElement. Only `role` and `name` are usually interesting;
 *  everything else gets a sane default. */
export function elem(role, name, extra = {}) {
  seq += 1;
  return {
    index: extra.index ?? seq,
    handle: extra.handle ?? `0/1/${seq}`,
    role,
    name,
    nameSource: extra.nameSource ?? 'content',
    labelUncertain: extra.labelUncertain ?? false,
    state: extra.state ?? {},
    options: extra.options ?? [],
    tagName: extra.tagName ?? 'button',
    inputType: extra.inputType,
  };
}

/** A whole Observation wrapping the given elements. */
export function obs(elements, extra = {}) {
  return {
    snapshotId: extra.snapshotId ?? 'test-snapshot',
    url: extra.url ?? 'http://localhost:4091/',
    title: extra.title ?? 'Test Platform',
    timestamp: extra.timestamp ?? 1_700_000_000_000,
    elements,
  };
}

/** Reset the handle counter so tests are independent. */
export function resetSeq() {
  seq = 0;
}
