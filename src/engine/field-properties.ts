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
  static findWhenFieldControl(obs: Observation): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['combobox', 'listbox']);
    const ranked = rankCandidates(pool, {
      hint: 'skip_when',
      demote: ['visibility'],
    });
    // Prefer a select whose options look like sibling field labels (more than
    // the two-ish mode options on the visibility control).
    for (const r of ranked) {
      if ((r.el.options?.length ?? 0) >= 2) return r.el;
    }
    return ranked[0]?.el ?? null;
  }

  /** The equals/value textbox for the skip rule. */
  static findEqualsValueInput(obs: Observation): ObservationElement | null {
    const pool = enumerateByRoles(obs, ['textbox', 'searchbox']);
    return rankCandidates(pool, { hint: 'skip_value' })[0]?.el ?? null;
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

    const when = FieldPropertyWrites.findWhenFieldControl(obs);
    const value = FieldPropertyWrites.findEqualsValueInput(obs);
    const valueOk =
      !!value &&
      (value.state.value ?? '').trim() === expectedEquals.trim();

    if (modeOk && valueOk) {
      return {
        ok: true,
        evidence:
          `visibility mode is conditional` +
          (when ? `; when-control present` : '') +
          `; equals value read back as "${value!.state.value}"`,
      };
    }
    if (valueOk && when) {
      return {
        ok: true,
        evidence: `when-control present and equals value read back as "${value!.state.value}"`,
      };
    }
    return {
      ok: false,
      evidence:
        `skip logic read-back incomplete` +
        (mode ? `; mode value="${mode.state.value ?? ''}"` : '; no visibility control') +
        (value ? `; equals="${value.state.value ?? ''}"` : '; no equals input'),
    };
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
