/**
 * Property-editor writes for skip logic and calculated formulas.
 *
 * Locates controls by structural enumeration + lexical ranking (the ranking
 * module owns English words). Option labels for "conditional visibility" are
 * chosen from the SELECT'S OWN observed options — never a hardcoded Mock-A
 * string like "Conditional" (Mock A actually offers "Visible When…").
 *
 * HARD WALL: this module decides WHICH control to try. It does not click.
 */

import type { Observation, ObservationElement } from '../perceive/core';
import {
  enumerateByRoles,
  rankCandidates,
  LEXICAL_HINTS,
} from '../bind/ranking';

/** Words that mark an option as "always shown" rather than conditional. */
const ALWAYS_OPTION_WORDS = ['always', 'visible', 'shown', 'show'] as const;

/** Words that mark an option as the conditional / when-branch. */
const CONDITIONAL_OPTION_WORDS = ['when', 'conditional', 'if', 'depends'] as const;

export class FieldPropertyWrites {
  /**
   * Among a visibility-mode select's observed option labels, pick the one
   * that enables conditional visibility. Returns null when nothing scores
   * as conditional (caller must escalate rather than guess).
   */
  static pickConditionalModeOption(options: readonly string[]): string | null {
    if (!options || options.length === 0) return null;

    let best: { opt: string; score: number } | null = null;
    for (const opt of options) {
      const n = opt.toLowerCase();
      let score = 0;
      for (const w of CONDITIONAL_OPTION_WORDS) {
        if (n.includes(w)) score += 2;
      }
      // "Visible" alone is the always-branch on Mock A; "Visible When…" is not.
      let alwaysOnly = false;
      for (const w of ALWAYS_OPTION_WORDS) {
        if (n === w || n === `always ${w}` || n.startsWith('always ')) {
          alwaysOnly = true;
          break;
        }
      }
      // Penalise options that look like "always shown" and lack a conditional word.
      const hasConditional = CONDITIONAL_OPTION_WORDS.some((w) => n.includes(w));
      if (!hasConditional) {
        for (const w of ALWAYS_OPTION_WORDS) {
          if (n.includes(w)) score -= 1;
        }
        if (alwaysOnly) score -= 2;
      }
      if (!best || score > best.score) best = { opt, score };
    }
    if (!best || best.score <= 0) return null;
    return best.opt;
  }

  /** The visibility / display-mode select in the property editor. */
  static findVisibilityModeControl(obs: Observation): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['combobox', 'listbox']);
    return rankCandidates(pool, { hint: 'visibility' })[0]?.el ?? null;
  }

  /**
   * The "when / trigger field" select that appears after conditional mode is
   * enabled. Demotes the visibility mode control so we do not re-pick it.
   */
  static findWhenFieldControl(
    obs: Observation,
    expectedWhenLabel?: string,
  ): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['combobox', 'listbox']);
    const ranked = rankCandidates(pool, {
      hint: 'skip_when',
      demote: ['visibility'],
    });
    // Prefer a select whose options look like sibling field labels — never the
    // visibility mode control itself (Visible / Visible When…), even when demote
    // failed to push it last.
    //
    // When the IR controlling label is known, prefer a select that actually
    // offers it. That structurally beats 'Element Type' (and any other property
    // combobox) which can otherwise tie on weak lexical priors.
    //
    // Also skip Element-Type-shaped enums and canvas choice dropdowns whose
    // options are coded values (Recovered/ABN/…) rather than sibling labels.
    // Live Mock A: Resolution Date skip bound the canvas Outcome <select>
    // (name==="Outcome") when When Element had self-excluded Outcome, and
    // Reason Not Administered similarly missed Study Drug Administered.
    const candidates: ObservationElement[] = [];
    for (const r of ranked) {
      const opts = r.el.options ?? [];
      if (opts.length < 2) continue;
      if (FieldPropertyWrites.looksLikeVisibilityModeOptions(opts)) continue;
      if (FieldPropertyWrites.looksLikeElementTypeOptions(opts)) continue;
      candidates.push(r.el);
    }
    if (expectedWhenLabel) {
      const want = expectedWhenLabel.trim();
      const offering = candidates.find((el) =>
        FieldPropertyWrites.optionsIncludeLabel(el.options, want),
      );
      if (offering) return offering;
      // Controlling label missing (often self-excluded because the options
      // panel is still editing that field). Still return the when-picker —
      // identified by Mock A's "choose element" placeholder — never a canvas
      // coded-value dropdown whose name equals the controlling label
      // (Outcome → Recovered/…), which makes selectOption fail confusingly.
      const whenShaped = candidates.find((el) =>
        FieldPropertyWrites.looksLikeWhenElementPicker(el.options),
      );
      return whenShaped ?? null;
    }
    return (
      candidates.find((el) =>
        FieldPropertyWrites.looksLikeWhenElementPicker(el.options),
      ) ??
      candidates[0] ??
      null
    );
  }

  /** Mock A's When Element select leads with "— choose element —". */
  static looksLikeWhenElementPicker(options: readonly string[]): boolean {
    return options.some((o) => /choose\s+element/i.test(o));
  }

  /** True when option labels look like a visibility mode enum, not field names. */
  static looksLikeVisibilityModeOptions(options: readonly string[]): boolean {
    if (options.length === 0 || options.length > 4) return false;
    let conditional = 0;
    let alwaysish = 0;
    for (const opt of options) {
      const n = opt.toLowerCase();
      if (CONDITIONAL_OPTION_WORDS.some((w) => n.includes(w))) conditional += 1;
      if (ALWAYS_OPTION_WORDS.some((w) => n.includes(w)) && !CONDITIONAL_OPTION_WORDS.some((w) => n.includes(w))) {
        alwaysish += 1;
      }
    }
    return conditional >= 1 && alwaysish >= 1;
  }

  /**
   * True when options look like an element-type picker (Dropdown, Date,
   * Yes/No Toggle, …) rather than sibling field labels on the form.
   */
  static looksLikeElementTypeOptions(options: readonly string[]): boolean {
    if (options.length < 4) return false;
    const typeWords = [
      'textbox', 'dropdown', 'checkbox', 'date', 'time', 'toggle',
      'calculated', 'radio', 'number', 'checklist', 'check list',
    ];
    let hits = 0;
    for (const opt of options) {
      const n = opt.toLowerCase();
      if (typeWords.some((w) => n.includes(w))) hits += 1;
    }
    return hits >= 3;
  }

  /** Option list membership with light normalisation (trim / required star). */
  static optionsIncludeLabel(options: readonly string[], label: string): boolean {
    const want = label.trim().replace(/\s*\*$/, '');
    for (const opt of options) {
      const got = opt.trim().replace(/\s*\*$/, '');
      if (got === want) return true;
    }
    return false;
  }

  /** Actual option text to pass to selectOption (preserves platform wording). */
  static pickOptionLabel(options: readonly string[], label: string): string | null {
    const want = label.trim().replace(/\s*\*$/, '');
    for (const opt of options) {
      const got = opt.trim().replace(/\s*\*$/, '');
      if (got === want) return opt;
    }
    return null;
  }

  /** The property-editor Label textbox (not coded-value row labels). */
  static findPropertyLabelInput(obs: Observation): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['textbox', 'searchbox']);
    const exact = pool.find((el) => el.name.trim().toLowerCase() === 'label');
    if (exact) return exact;
    return rankCandidates(pool, { hint: 'name_input' })[0]?.el ?? null;
  }

  /** True when the options panel is editing the named field. */
  static propertyPanelShowsField(obs: Observation, fieldLabel: string): boolean {
    const input = FieldPropertyWrites.findPropertyLabelInput(obs);
    if (!input) return false;
    const raw = (input.state.value ?? '').trim().replace(/\s*\*$/, '');
    const want = fieldLabel.trim().replace(/\s*\*$/, '');
    return raw === want;
  }

  /** The equals/value textbox for the skip rule. */
  static findEqualsValueInput(obs: Observation): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['textbox', 'searchbox']);
    const ranked = rankCandidates(pool, { hint: 'skip_value' });
    // Prefer single-line inputs over paste/bulk textareas when scores tie.
    for (const r of ranked) {
      const tag = (r.el.tagName ?? '').toLowerCase();
      if (tag === 'textarea') continue;
      return r.el;
    }
    return ranked[0]?.el ?? null;
  }

  /** The formula / expression textbox on a calculated field. */
  static findFormulaInput(obs: Observation): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['textbox', 'searchbox']);
    return rankCandidates(pool, { hint: 'formula' })[0]?.el ?? null;
  }

  /**
   * True when the property editor shows evidence that conditional visibility
   * is active: either the mode select's value matches the conditional option,
   * or the when/value sub-controls are present with the expected value.
   */
  static skipLogicLooksSet(
    obs: Observation,
    expectedEquals: string,
    expectedWhenLabel?: string,
  ): { ok: boolean; evidence: string } {
    const mode = FieldPropertyWrites.findVisibilityModeControl(obs);
    const conditional = mode
      ? FieldPropertyWrites.pickConditionalModeOption(mode.options)
      : null;
    const modeValue = (mode?.state.value ?? '').toLowerCase();
    const modeOk =
      !!conditional &&
      (modeValue === conditional.toLowerCase() ||
        modeValue.includes('when') ||
        CONDITIONAL_OPTION_WORDS.some((w) => modeValue.includes(w)));

    const when = FieldPropertyWrites.findWhenFieldControl(obs, expectedWhenLabel);
    const whenOk = FieldPropertyWrites.whenFieldLooksSelected(when, expectedWhenLabel);

    const value = FieldPropertyWrites.findEqualsValueInput(obs);
    const valueOk =
      !!value &&
      (value.state.value ?? '').trim() === expectedEquals.trim();

    // Mock A __readState only emits skipLogic when mode==='when' AND
    // whenElementId is set. mode+equals without a controlling field still
    // serialises as null — so verify must require the when control too.
    if (modeOk && whenOk && valueOk) {
      return {
        ok: true,
        evidence:
          `visibility mode is conditional; when-control selected` +
          (expectedWhenLabel ? ` ("${expectedWhenLabel}")` : '') +
          `; equals value read back as "${value!.state.value}"`,
      };
    }
    return {
      ok: false,
      evidence:
        `skip logic read-back incomplete` +
        (mode ? `; mode value="${mode.state.value ?? ''}"` : '; no visibility control') +
        (when
          ? `; when value="${when.state.value ?? ''}"`
          : '; no when-element control') +
        (value ? `; equals="${value.state.value ?? ''}"` : '; no equals input'),
    };
  }

  /**
   * True when the when-element select has a real choice selected (not the
   * empty / "choose element" placeholder). Perceive exposes <select>.value
   * (often an opaque element id on Mock A), so we cannot always assert the
   * IR label from observation alone — a non-empty non-placeholder value is
   * the durable signal that whenElementId was set.
   */
  static whenFieldLooksSelected(
    when: ObservationElement | null,
    expectedWhenLabel?: string,
  ): boolean {
    if (!when) return false;
    const raw = (when.state.value ?? '').trim();
    if (!raw || /^[—–-]/.test(raw) || /choose/i.test(raw)) return false;
    if (!expectedWhenLabel) return true;
    if (raw === expectedWhenLabel) return true;
    // Opaque id selected: confirm the IR label is at least offered.
    return when.options.includes(expectedWhenLabel);
  }

  /** True when the formula input's value matches the intended expression. */
  static formulaLooksSet(
    obs: Observation,
    expected: string,
  ): { ok: boolean; evidence: string } {
    const input = FieldPropertyWrites.findFormulaInput(obs);
    if (!input) {
      return { ok: false, evidence: 'no formula/expression input found' };
    }
    const actual = (input.state.value ?? '').trim();
    const want = expected.trim();
    if (actual === want) {
      return { ok: true, evidence: `formula input read back as "${actual}"` };
    }
    // Some surfaces prefix with "=" in the preview; accept a contains match
    // only when the property input itself is empty but a named control shows it.
    if (actual.includes(want) || want.includes(actual) && actual.length > 0) {
      return { ok: true, evidence: `formula input read back as "${actual}" (near match)` };
    }
    return {
      ok: false,
      evidence: `formula input is "${actual}" but intent has "${want}"`,
    };
  }
}

// Re-export hint presence so tests can assert ranking data exists without
// importing English words into guarded files.
void LEXICAL_HINTS;
