/**
 * PERCEIVE core - pure, deterministic accessibility-tree observation.
 *
 * This module is the foundation of the whole extension. It turns a live DOM
 * into an Observation: a filtered list of interactive elements, each with a
 * computed ARIA role, an accessible name (accname-1.2 fallback ladder), state,
 * an option vocabulary where relevant, and a stable structural handle.
 *
 * HARD WALLS (proposal-b section 2):
 *   - ZERO LLM calls. ZERO knowledge of the 13 canonical field types.
 *   - ZERO form-domain knowledge. It does not believe in forms, visits, or
 *     fields. It believes in roles, names, states, and handles.
 *   - PERCEIVE cannot write. It only reads and serializes.
 *
 * The accessible-name ladder is implemented IN CODE, in this exact order:
 *   aria-labelledby -> aria-label -> label[for] -> wrapped label ->
 *   placeholder -> title -> (native content / value / alt).
 * A name that falls through to placeholder/title, or is absent, is marked
 * label-uncertain at perception time (proposal-b section 2, PERCEIVE bullet 2).
 */

export type NameSource =
  | 'labelledby'
  | 'aria-label'
  | 'for'
  | 'wrapped'
  | 'placeholder'
  | 'title'
  | 'content'
  | 'value'
  | 'alt'
  | 'none';

export interface ElementState {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  value?: string;
  /** aria-required, falling back to the native `required` attribute.
   *  Scoring criterion 7 read-back. Absent when the platform expresses
   *  neither, which is not the same as false. */
  required?: boolean;
  /** aria-valuemin/aria-valuemax, falling back to native min/max/step.
   *  Scoring criterion 9 read-back. */
  range?: { min?: number; max?: number; step?: number };
}

export interface ObservationElement {
  /** 1-based position in this snapshot's candidate list (presentation order). */
  index: number;
  /** Stable structural path (child indices from <html>). Survives unchanged
   *  across snapshots of an unchanged page. This is the ACT handle. */
  handle: string;
  role: string;
  name: string;
  nameSource: NameSource;
  /** True when the name fell through to placeholder/title or is absent. */
  labelUncertain: boolean;
  state: ElementState;
  /** Option vocabulary for listbox/radiogroup/combobox/spinbutton roles. */
  options: string[];
  tagName: string;
  inputType?: string;
}

export interface Observation {
  snapshotId: string;
  url: string;
  title: string;
  timestamp: number;
  elements: ObservationElement[];
}

export interface Diff {
  added: string[];
  removed: string[];
  changed: string[];
}

// ---------------------------------------------------------------------------
// Role computation (W3C ARIA in HTML: native host-language semantics).
// ---------------------------------------------------------------------------

const NATIVE_ROLE_BY_TAG: Record<string, string> = {
  a: 'link',
  article: 'article',
  aside: 'complementary',
  button: 'button',
  dialog: 'dialog',
  fieldset: 'group',
  footer: 'contentinfo',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'banner',
  img: 'img',
  li: 'listitem',
  main: 'main',
  nav: 'navigation',
  ol: 'list',
  option: 'option',
  optgroup: 'group',
  section: 'region',
  summary: 'button',
  table: 'table',
  td: 'cell',
  th: 'columnheader',
  tr: 'row',
  ul: 'list',
};

const INPUT_TYPE_ROLE: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  password: 'textbox',
  text: 'textbox',
};

/** Roles that are presentation-only; they contribute no role. */
const PRESENTATION_ROLES = new Set(['presentation', 'none']);

export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const trimmed = explicit.trim().toLowerCase();
    if (PRESENTATION_ROLES.has(trimmed)) return 'generic';
    // A single valid role token is used; multi-token fallback lists are rare
    // in the wild and we take the first non-presentation token.
    const first = trimmed.split(/\s+/)[0];
    if (first) return first;
  }

  // Recognize status messages, toasts, alerts as live regions
  const className = el.getAttribute('class') || '';
  if (className.includes('toast') || className.includes('notice') || className.includes('alert')) {
    return 'status';
  }

  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type || 'text';
    return INPUT_TYPE_ROLE[type] ?? 'textbox';
  }
  if (tag === 'select') {
    return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'a' && !el.hasAttribute('href')) return 'generic';
  if (tag === 'img' && (el as HTMLImageElement).alt === '') return 'presentation';
  return NATIVE_ROLE_BY_TAG[tag] ?? 'generic';
}

// ---------------------------------------------------------------------------
// Accessible name computation (accname-1.2 fallback ladder, in code).
// ---------------------------------------------------------------------------

function textAlternative(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return (el as HTMLImageElement).alt.trim();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'submit' || type === 'reset' || type === 'button') {
      return (el as HTMLInputElement).value.trim();
    }
  }
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function resolveLabelledby(el: Element, doc: Document): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const id of ids) {
    const ref = doc.getElementById(id);
    if (ref) {
      const text = textAlternative(ref);
      if (text) parts.push(text);
    }
  }
  return parts.join(' ').trim();
}

function labelForName(el: Element, doc: Document): string {
  const id = el.getAttribute('id');
  if (!id) return '';
  const labels = doc.querySelectorAll(`label[for="${cssEscape(id)}"]`);
  for (const label of labels) {
    const text = textAlternative(label);
    if (text) return text;
  }
  return '';
}

function wrappedLabelName(el: Element): string {
  const label = el.closest('label');
  if (!label) return '';
  const text = textAlternative(label);
  return text;
}

export interface AccnameResult {
  name: string;
  source: NameSource;
}

export function computeAccname(el: Element, doc: Document): AccnameResult {
  // 1. aria-labelledby
  const labelledby = resolveLabelledby(el, doc);
  if (labelledby) return { name: labelledby, source: 'labelledby' };

  // 2. aria-label
  const ariaLabel = (el.getAttribute('aria-label') ?? '').trim();
  if (ariaLabel) return { name: ariaLabel, source: 'aria-label' };

  // 3. label[for]
  const forName = labelForName(el, doc);
  if (forName) return { name: forName, source: 'for' };

  // 4. wrapped label
  const wrapped = wrappedLabelName(el);
  if (wrapped) return { name: wrapped, source: 'wrapped' };

  // 5. placeholder
  const placeholder = (el.getAttribute('placeholder') ?? '').trim();
  if (placeholder) return { name: placeholder, source: 'placeholder' };

  // 6. title
  const title = (el.getAttribute('title') ?? '').trim();
  if (title) return { name: title, source: 'title' };

  // 7. native content / value / alt
  const content = textAlternative(el);
  if (content) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return { name: content, source: 'alt' };
    if (tag === 'input') return { name: content, source: 'value' };
    return { name: content, source: 'content' };
  }

  return { name: '', source: 'none' };
}

// ---------------------------------------------------------------------------
// State computation.
// ---------------------------------------------------------------------------

function isChecked(el: Element): boolean | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio') return (el as HTMLInputElement).checked;
  }
  const ariaChecked = el.getAttribute('aria-checked');
  if (ariaChecked === 'true') return true;
  if (ariaChecked === 'false') return false;
  if (ariaChecked === 'mixed') return undefined;
  return undefined;
}

function isDisabled(el: Element): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return false;
}

function isExpanded(el: Element): boolean | undefined {
  const ariaExpanded = el.getAttribute('aria-expanded');
  if (ariaExpanded === 'true') return true;
  if (ariaExpanded === 'false') return false;
  return undefined;
}

function currentValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio') return undefined;
    return (el as HTMLInputElement).value;
  }
  if (tag === 'textarea') return (el as HTMLTextAreaElement).value;
  if (tag === 'select') return (el as HTMLSelectElement).value;
  return undefined;
}

/** Required state. ARIA wins over the native attribute, per ARIA in HTML:
 *  an explicit aria-required="false" is an author override of `required`. */
function isRequired(el: Element): boolean | undefined {
  const aria = el.getAttribute('aria-required');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (el.hasAttribute('required')) return true;
  return undefined;
}

/** Parse an attribute as a finite number, or undefined. A platform that
 *  writes a non-numeric bound has not declared a usable range. */
function numAttr(el: Element, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = el.getAttribute(name);
    if (raw === null || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    // A present-but-unparseable value on the preferred attribute should not
    // fall through to a less-preferred one: the author declared it here.
    return undefined;
  }
  return undefined;
}

/** Range bounds. ARIA value attributes take precedence over native ones. */
function readRange(el: Element): ElementState['range'] {
  const min = numAttr(el, 'aria-valuemin', 'min');
  const max = numAttr(el, 'aria-valuemax', 'max');
  const step = numAttr(el, 'step');
  if (min === undefined && max === undefined && step === undefined) return undefined;
  const range: NonNullable<ElementState['range']> = {};
  if (min !== undefined) range.min = min;
  if (max !== undefined) range.max = max;
  if (step !== undefined) range.step = step;
  return range;
}

export function computeState(el: Element): ElementState {
  const state: ElementState = {};
  const checked = isChecked(el);
  if (checked !== undefined) state.checked = checked;
  if (isDisabled(el)) state.disabled = true;
  const expanded = isExpanded(el);
  if (expanded !== undefined) state.expanded = expanded;
  const required = isRequired(el);
  if (required !== undefined) state.required = required;
  const range = readRange(el);
  if (range !== undefined) state.range = range;
  const value = currentValue(el);
  if (value !== undefined) state.value = value;
  return state;
}

// ---------------------------------------------------------------------------
// Option vocabulary (for listbox / radiogroup / combobox / spinbutton).
// ---------------------------------------------------------------------------

function optionText(el: Element, doc: Document): string {
  const acc = computeAccname(el, doc);
  if (acc.name) return acc.name;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function computeOptions(el: Element, role: string, doc: Document): string[] {
  const tag = el.tagName.toLowerCase();

  // Native <select>: read its <option> children.
  if (tag === 'select') {
    return Array.from((el as HTMLSelectElement).options).map((o) => optionText(o, doc));
  }

  // Native <input list="...">: read the referenced <datalist>.
  if (tag === 'input' && el.hasAttribute('list')) {
    const listId = el.getAttribute('list');
    if (listId) {
      const datalist = doc.getElementById(listId);
      if (datalist) {
        return Array.from(datalist.querySelectorAll('option')).map((o) => optionText(o, doc));
      }
    }
  }

  // ARIA widgets: read descendant option/radio elements.
  if (role === 'listbox' || role === 'combobox' || role === 'radiogroup') {
    const selector = role === 'radiogroup' ? '[role="radio"], input[type="radio"]' : '[role="option"], option';
    return Array.from(el.querySelectorAll(selector)).map((o) => optionText(o, doc));
  }

  // spinbutton has no option vocabulary.
  return [];
}

// ---------------------------------------------------------------------------
// Interactivity and perceivability filters.
// ---------------------------------------------------------------------------

const NATIVE_INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'summary',
  'details',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'area',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'combobox',
  'listbox',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'scrollbar',
  'separator',
  'tree',
  'grid',
  'menu',
  'menubar',
  'tablist',
  'toolbar',
  'radiogroup',
  'progressbar',
  'meter',
  'dialog',
  'alertdialog',
  'status',
  'alert',
  'log',
]);

// Structural roles that are only interactive inside a grid/treegrid (or when
// they carry a tabindex). A plain <table> row/header is NOT interactive.
const GRID_ONLY_ROLES = new Set(['row', 'columnheader', 'rowheader', 'cell', 'gridcell', 'rowgroup']);

function insideGrid(el: Element): boolean {
  let node: Element | null = el.parentElement;
  while (node) {
    const role = node.getAttribute('role');
    if (role === 'grid' || role === 'treegrid') return true;
    node = node.parentElement;
  }
  return false;
}

function nativeInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (!NATIVE_INTERACTIVE_TAGS.has(tag)) return false;
  if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href');
  if (tag === 'audio' || tag === 'video') return el.hasAttribute('controls');
  return true;
}

function hasCursorPointer(el: Element): boolean {
  try {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style && style.cursor === 'pointer') return true;
  } catch {
    // jsdom or detached node: no computed style available.
  }
  return false;
}

export function isInteractive(el: Element): boolean {
  if (nativeInteractive(el)) return true;
  const role = computeRole(el);
  if (GRID_ONLY_ROLES.has(role)) {
    // Only interactive inside a grid/treegrid, or when explicitly focusable.
    if (insideGrid(el)) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    return false;
  }
  if (INTERACTIVE_ROLES.has(role)) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  if (hasCursorPointer(el)) return true;
  return false;
}

export function isPerceivable(el: Element): boolean {
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  try {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
  } catch {
    // jsdom: no computed style; fall through to perceivable.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stable structural handle.
// ---------------------------------------------------------------------------

export function structuralPath(el: Element): string {
  const parts: number[] = [];
  let node: Element | null = el;
  while (node && node !== node.ownerDocument.documentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    let idx = 0;
    for (const child of Array.from(parent.children)) {
      if (child === node) break;
      idx += 1;
    }
    parts.unshift(idx);
    node = parent;
  }
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// Observation assembly.
// ---------------------------------------------------------------------------

let snapshotCounter = 0;

export function observe(root?: Document | Element): Observation {
  // nodeType 9 === Document. Avoid `instanceof Document` so this runs in Node
  // (jsdom) where the global `Document` constructor does not exist.
  const isDoc = root ? root.nodeType === 9 : true;
  const doc: Document = isDoc
    ? (root as Document)
    : ((root as Element).ownerDocument ?? (globalThis as unknown as { document: Document }).document);
  const scope: Element = isDoc ? doc.documentElement : (root as Element);

  snapshotCounter += 1;
  const snapshotId = `snap-${Date.now()}-${snapshotCounter}`;

  const elements: ObservationElement[] = [];
  const all = scope.querySelectorAll('*');
  let index = 0;
  for (const el of all) {
    if (!isPerceivable(el)) continue;
    if (!isInteractive(el)) continue;
    const role = computeRole(el);
    const acc = computeAccname(el, doc);
    const labelUncertain = acc.source === 'placeholder' || acc.source === 'title' || acc.source === 'none';
    index += 1;
    elements.push({
      index,
      handle: structuralPath(el),
      role,
      name: acc.name,
      nameSource: acc.source,
      labelUncertain,
      state: computeState(el),
      options: computeOptions(el, role, doc),
      tagName: el.tagName.toLowerCase(),
      inputType: el.tagName.toLowerCase() === 'input' ? (el as HTMLInputElement).type : undefined,
    });
  }

  return {
    snapshotId,
    url: doc.URL,
    title: doc.title,
    timestamp: Date.now(),
    elements,
  };
}

// ---------------------------------------------------------------------------
// Snapshot diff.
// ---------------------------------------------------------------------------

function elementSignature(el: ObservationElement): string {
  return JSON.stringify({
    role: el.role,
    name: el.name,
    state: el.state,
    options: el.options,
  });
}

export function diffObservations(prev: Observation, curr: Observation): Diff {
  const prevByHandle = new Map(prev.elements.map((e) => [e.handle, e]));
  const currByHandle = new Map(curr.elements.map((e) => [e.handle, e]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [handle, el] of currByHandle) {
    if (!prevByHandle.has(handle)) {
      added.push(handle);
    } else if (elementSignature(prevByHandle.get(handle)!) !== elementSignature(el)) {
      changed.push(handle);
    }
  }
  for (const handle of prevByHandle.keys()) {
    if (!currByHandle.has(handle)) removed.push(handle);
  }

  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// CSS id escaping for label[for] lookups.
// ---------------------------------------------------------------------------

function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  return id.replace(/["\\]/g, '\\$&');
}
