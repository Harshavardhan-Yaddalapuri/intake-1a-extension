/**
 * ACT primitives (proposal-b section 2, ACT bullet).
 *
 * The executor consumes Bindings and performs concrete UI interactions through
 * tiny DOM primitives. Handles come ONLY from the CURRENT Observation; a handle
 * that is not in the current snapshot is a hard stale-handle exception, never a
 * best-effort click.
 *
 * HARD WALLS:
 *   - ACT cannot decide. It replays Bindings against values from the IR.
 *   - ZERO LLM calls. ZERO judgment.
 *
 * Retry policy (proposal-b section 2, ACT bullet; Skyvern's rule):
 *   - TRANSIENT ONLY: one settle-wait, one Escape to dismiss overlays, one
 *     retry. Never re-click a possibly-succeeded write (no double-submit).
 *   - A failed or unsure write is NOT retried; it is handed to VERIFY.
 *
 * In a Chrome MV3 extension, these primitives run inside the content script
 * context (they need the live DOM). For unit testing, a doc parameter is
 * injected so jsdom fixtures work.
 */

import type { Observation, ObservationElement } from '../perceive/core';
import { computeAccname, computeRole } from '../perceive/core';

// ---------------------------------------------------------------------------

/** A handle is the structural path from <html>: e.g. "0.1.2.0". */
export type Handle = string;

/** Raised when a handle does not resolve to an element in the current snapshot
 *  or the DOM. This is a HARD stop, never a best-effort click. */
export class StaleHandleError extends Error {
  readonly handle: Handle;
  constructor(handle: Handle, msg: string) {
    super(`stale handle "${handle}": ${msg}`);
    this.name = 'StaleHandleError';
    this.handle = handle;
  }
}

/** Raised when an element is found but is not interactable (disabled,
 *  aria-hidden, display:none). This is NOT a retryable transient. */
export class NotInteractableError extends Error {
  readonly handle: Handle;
  constructor(handle: Handle, msg: string) {
    super(`element at "${handle}" not interactable: ${msg}`);
    this.name = 'NotInteractableError';
    this.handle = handle;
  }
}

/** Raised when a write (setValue/check/selectOption) fails to take effect and
 *  must be handed to VERIFY rather than retried. */
export class WriteFailedError extends Error {
  readonly handle: Handle;
  constructor(handle: Handle, msg: string) {
    super(`write at "${handle}" failed: ${msg}`);
    this.name = 'WriteFailedError';
    this.handle = handle;
  }
}

// ---------------------------------------------------------------------------
// Handle resolution: structural path -> live DOM element.
// ---------------------------------------------------------------------------

/** Resolve a handle (structural path like "0.1.2") to a live DOM element.
 *  Throws StaleHandleError if the path no longer matches. */
export function resolveHandle(doc: Document, handle: Handle): Element {
  const parts = handle.split('.');
  let node: Element = doc.documentElement;
  for (let i = 0; i < parts.length; i++) {
    const idx = parseInt(parts[i], 10);
    if (isNaN(idx) || idx < 0 || idx >= node.children.length) {
      throw new StaleHandleError(handle, `path segment ${i} (index ${parts[i]}) out of range`);
    }
    node = node.children[idx];
  }
  return node;
}

/** Verify a handle exists in the current Observation AND that the resolved
 *  DOM element still matches the observation (role + name). This detects
 *  stale handles where the DOM structure changed but the handle path now
 *  points to a different element. */
export function assertHandleInObservation(obs: Observation, handle: Handle, doc: Document): ObservationElement {
  const obsEl = obs.elements.find((e) => e.handle === handle);
  if (!obsEl) {
    throw new StaleHandleError(handle, 'handle not in current observation snapshot');
  }
  // Resolve the handle in the current DOM and verify it matches the observation.
  const domEl = resolveHandle(doc, handle);
  const actualRole = computeRole(domEl);
  const expectedRole = obsEl.role;
  // Role mismatch: the handle now points to a different element.
  if (actualRole !== expectedRole) {
    throw new StaleHandleError(handle, `role mismatch: observation had ${expectedRole}, DOM has ${actualRole}`);
  }
  // Name mismatch (if observation had a name): the handle points to a different element.
  if (obsEl.name && obsEl.nameSource !== 'none' && obsEl.nameSource !== 'placeholder' && obsEl.nameSource !== 'title') {
    const acc = computeAccname(domEl, doc);
    if (acc.name && acc.name !== obsEl.name) {
      throw new StaleHandleError(handle, `name mismatch: observation had "${obsEl.name}", DOM has "${acc.name}"`);
    }
  }
  return obsEl;
}

// ---------------------------------------------------------------------------
// Interactability check.
// ---------------------------------------------------------------------------

function checkInteractable(el: Element): void {
  if (el.hasAttribute('disabled')) {
    throw new NotInteractableError('', 'disabled attribute set');
  }
  if (el.getAttribute('aria-disabled') === 'true') {
    throw new NotInteractableError('', 'aria-disabled=true');
  }
  if (el.getAttribute('aria-hidden') === 'true') {
    throw new NotInteractableError('', 'aria-hidden=true');
  }
  if (el.hasAttribute('hidden')) {
    throw new NotInteractableError('', 'hidden attribute set');
  }
}

// ---------------------------------------------------------------------------
// Settle-wait: a short delay for async DOM updates (React re-render, etc.).
// In the extension this is chrome.scripting / requestAnimationFrame. In tests
// it is a microtask or setTimeout(0).
// ---------------------------------------------------------------------------

export type SettleWait = () => Promise<void>;

/** Default settle-wait: one animation frame (~16ms) in a browser, or a
 *  microtask in Node. */
export const defaultSettleWait: SettleWait = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });

/** Send an Escape key to dismiss overlays/modals that might intercept the
 *  next action. */
export function sendEscape(doc: Document): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  doc.dispatchEvent(event);
  if (doc.activeElement && doc.activeElement !== doc.body) {
    doc.activeElement.dispatchEvent(event);
  }
}

// ---------------------------------------------------------------------------
// Transient retry wrapper.
// ---------------------------------------------------------------------------

export interface ActResult {
  ok: boolean;
  error?: string;
  /** Whether a settle-wait + Escape + retry was attempted. */
  retried: boolean;
}

/**
 * Transient-only retry: one settle-wait, one Escape, one retry.
 * NEVER re-clicks a possibly-succeeded write -- the caller decides whether
 * the operation is idempotent enough to retry. For mutating writes, set
 * canRetry=false and a failure is returned immediately for VERIFY.
 */
export async function withTransientRetry(
  fn: () => Promise<ActResult>,
  opts: { settle: SettleWait; doc: Document; canRetry: boolean },
): Promise<ActResult> {
  try {
    const result = await fn();
    if (result.ok) return { ...result, retried: false };
    // Non-transient errors (StaleHandle, NotInteractable) are hard stops.
    if (!opts.canRetry) return { ...result, retried: false };

    // Transient retry: settle, Escape, retry once.
    await opts.settle();
    sendEscape(opts.doc);
    await opts.settle();
    const retryResult = await fn();
    return { ...retryResult, retried: true };
  } catch (err) {
    if (err instanceof StaleHandleError || err instanceof NotInteractableError) {
      throw err; // Hard stops, never retry.
    }
    // Unknown error during fn -- treat as transient if canRetry.
    if (!opts.canRetry) throw err;
    await opts.settle();
    sendEscape(opts.doc);
    await opts.settle();
    const retryResult = await fn();
    return { ...retryResult, retried: true };
  }
}

// ---------------------------------------------------------------------------
// Primitives: click, setValue, check, selectOption.
// ---------------------------------------------------------------------------

export interface ActContext {
  doc: Document;
  obs: Observation;
  settle: SettleWait;
}

/**
 * Click the element at the given handle. Clicks are idempotent for
 * navigation/palette-open actions (canRetry=true) but NOT for submit-like
 * writes (canRetry=false to avoid double-submit).
 */
export async function click(ctx: ActContext, handle: Handle, canRetry = true): Promise<ActResult> {
  const obsEl = assertHandleInObservation(ctx.obs, handle, ctx.doc);
  void obsEl;

  return withTransientRetry(
    async () => {
      const el = resolveHandle(ctx.doc, handle);
      checkInteractable(el);
      (el as HTMLElement).click();
      return { ok: true, retried: false };
    },
    { settle: ctx.settle, doc: ctx.doc, canRetry },
  );
}

/** Contenteditable host (attribute or live isContentEditable). Mirrors
 *  perceive/core — a11y-hostile platforms use role-less contenteditable divs
 *  as textboxes; perceive maps them to role=textbox and ACT must write them. */
function isContentEditableHost(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (typeof htmlEl.isContentEditable === 'boolean' && htmlEl.isContentEditable) {
    return true;
  }
  const attr = el.getAttribute('contenteditable');
  if (attr === null) return false;
  const v = attr.trim().toLowerCase();
  return v === '' || v === 'true';
}

/**
 * Set a text value on an input/textarea OR a contenteditable host.
 * Writes are NOT retried (canRetry=false): a possibly-succeeded write
 * is handed to VERIFY, never double-submitted.
 *
 * Live env-hostile-a11y (Prism Wave Roster): visit Name/Window cells are
 * contenteditable divs. Perceive sees them as textboxes, but setValue used
 * to throw WriteFailedError on non-input tags → Snapshot Wave saved nothing
 * (empty name) → visit-open escalated → empty GT.
 */
export async function setValue(ctx: ActContext, handle: Handle, text: string): Promise<ActResult> {
  assertHandleInObservation(ctx.obs, handle, ctx.doc);

  return withTransientRetry(
    async () => {
      const el = resolveHandle(ctx.doc, handle);
      checkInteractable(el);

      const tag = el.tagName.toLowerCase();
      const EventCtor = ctx.doc.defaultView?.Event ?? Event;

      if (tag === 'input' || tag === 'textarea') {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        input.value = text;
        // Dispatch input event so React/Vue listeners fire. Use doc.defaultView.Event
        // to get the correct constructor in jsdom/browser contexts.
        input.dispatchEvent(new EventCtor('input', { bubbles: true }));
        input.dispatchEvent(new EventCtor('change', { bubbles: true }));
        // Verify the value took.
        if (input.value !== text) {
          return { ok: false, error: `value did not stick: expected "${text}", got "${input.value}"`, retried: false };
        }
        return { ok: true, retried: false };
      }

      if (isContentEditableHost(el)) {
        // Replace contents (hostile cells wrap a .cell-text span; platforms
        // read host.textContent on input). Avoid hardcoding class names.
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(ctx.doc.createTextNode(text));
        el.dispatchEvent(new EventCtor('input', { bubbles: true }));
        el.dispatchEvent(new EventCtor('change', { bubbles: true }));
        const got = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (got !== text) {
          return {
            ok: false,
            error: `contenteditable value did not stick: expected "${text}", got "${got}"`,
            retried: false,
          };
        }
        return { ok: true, retried: false };
      }

      throw new WriteFailedError(handle, `setValue on non-input tag <${tag}>`);
    },
    { settle: ctx.settle, doc: ctx.doc, canRetry: false },
  );
}

/**
 * Check a checkbox or radio at the given handle.
 * NOT retried (canRetry=false): a check is a write.
 */
export async function check(ctx: ActContext, handle: Handle, checked = true): Promise<ActResult> {
  assertHandleInObservation(ctx.obs, handle, ctx.doc);

  return withTransientRetry(
    async () => {
      const el = resolveHandle(ctx.doc, handle);
      checkInteractable(el);

      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        if (input.type === 'checkbox' || input.type === 'radio') {
          input.checked = checked;
          const EventCtor = ctx.doc.defaultView?.Event ?? Event;
          input.dispatchEvent(new EventCtor('change', { bubbles: true }));
          if (input.checked !== checked) {
            return { ok: false, error: `check did not stick: expected ${checked}, got ${input.checked}`, retried: false };
          }
          return { ok: true, retried: false };
        }
      }
      // ARIA checkbox/switch (role-based)
      if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
        el.setAttribute('aria-checked', checked ? 'true' : 'false');
        const EventCtor = ctx.doc.defaultView?.Event ?? Event;
        el.dispatchEvent(new EventCtor('change', { bubbles: true }));
        return { ok: true, retried: false };
      }
      throw new WriteFailedError(handle, `check on non-checkbox element (tag=${tag}, role=${el.getAttribute('role')})`);
    },
    { settle: ctx.settle, doc: ctx.doc, canRetry: false },
  );
}

/**
 * Select an option from a <select> by visible label.
 * NOT retried (canRetry=false): a selection is a write.
 */
export async function selectOption(ctx: ActContext, handle: Handle, label: string): Promise<ActResult> {
  assertHandleInObservation(ctx.obs, handle, ctx.doc);

  return withTransientRetry(
    async () => {
      const el = resolveHandle(ctx.doc, handle);
      checkInteractable(el);

      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const select = el as HTMLSelectElement;
        for (const opt of select.options) {
          if (opt.text.trim() === label || opt.value === label) {
            select.value = opt.value;
            const EventCtor = ctx.doc.defaultView?.Event ?? Event;
            select.dispatchEvent(new EventCtor('change', { bubbles: true }));
            if (select.value !== opt.value) {
              return { ok: false, error: `select did not stick: expected "${label}", got "${select.value}"`, retried: false };
            }
            return { ok: true, retried: false };
          }
        }
        return { ok: false, error: `option "${label}" not found in select`, retried: false };
      }

      // ARIA listbox: find the option by role + name and click it.
      if (el.getAttribute('role') === 'listbox' || el.getAttribute('role') === 'combobox') {
        const options = el.querySelectorAll('[role="option"], option');
        for (const opt of options) {
          const optText = (opt.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (optText === label) {
            (opt as HTMLElement).click();
            return { ok: true, retried: false };
          }
        }
        return { ok: false, error: `option "${label}" not found in listbox`, retried: false };
      }

      throw new WriteFailedError(handle, `selectOption on non-select element (tag=${tag})`);
    },
    { settle: ctx.settle, doc: ctx.doc, canRetry: false },
  );
}

// ---------------------------------------------------------------------------
// Convenience: take a fresh observation and execute one recipe step.
// ---------------------------------------------------------------------------

export interface RecipeExecResult {
  ok: boolean;
  error?: string;
  retried: boolean;
}

/** Execute a single click step from a binding recipe. */
export async function execClick(ctx: ActContext, handle: Handle): Promise<RecipeExecResult> {
  return click(ctx, handle, true);
}