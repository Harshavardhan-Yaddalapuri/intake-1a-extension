/**
 * PERCEIVE standalone bundle entry.
 *
 * Exposes the pure core on globalThis.__PERCEIVE__ so the dev harness can load
 * it against any page without the extension's message plumbing. Used by
 * S2-S6 to unit-test perception against arbitrary URLs.
 */
import * as core from './core';

(globalThis as unknown as Record<string, unknown>).__PERCEIVE__ = core;
