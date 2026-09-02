/**
 * IR parser (proposal-b section 5, step 1).
 *
 * Reads abc-101-study.ir.json into a typed intermediate representation, then
 * hands it to the plan compiler. The parser is deterministic and LLM-free.
 *
 * The input IR has no explicit ids: visits and forms are named, fields are
 * labelled. Idempotency keys (M5) must come from IR ids, never labels, never
 * LLM output. So the parser derives STABLE STRUCTURAL ids from position in the
 * input file: visit index, form index, field index. The same input file always
 * yields the same ids, which is what makes re-runs a no-op by construction.
 */

import type {
  CanonicalType,
  CodedPair,
  RangeSpec,
  SkipRule,
} from '../shared/contract';

// ---------------------------------------------------------------------------
// Raw IR shape (what the JSON actually contains).
// ---------------------------------------------------------------------------

export interface RawField {
  label: string;
  type: string;
  required: boolean;
  options?: { code: string; label: string }[];
  min?: number;
  max?: number;
  units?: string;
  formula?: string;
  skip_logic?: {
    when_field_label: string;
    equals_value: string;
  };
}

export interface RawForm {
  name: string;
  repeating: boolean;
  fields: RawField[];
}

export interface RawVisit {
  name: string;
  window_start_day: number;
  window_end_day: number;
  forms: RawForm[];
}

export interface RawStudy {
  protocol_id: string;
  title: string;
}

export interface RawIR {
  ir_version: string;
  source?: string;
  study: RawStudy;
  visits: RawVisit[];
}

// ---------------------------------------------------------------------------
// Typed IR (what the parser emits).
// ---------------------------------------------------------------------------

export interface IrField {
  /** Structural id: v<visit>.f<form>.d<field>. Stable across runs. */
  field_id: string;
  label: string;
  canonical_type: CanonicalType;
  required: boolean;
  options?: CodedPair[];
  range?: RangeSpec;
  formula?: string;
  skip_logic?: SkipRule;
}

export interface IrForm {
  /** Structural id: v<visit>.f<form>. Appearance-scoped (28 of these). */
  form_id: string;
  name: string;
  repeating: boolean;
  fields: IrField[];
}

export interface IrVisit {
  /** Structural id: v<visit>. */
  visit_id: string;
  name: string;
  window_start_day: number;
  window_end_day: number;
  forms: IrForm[];
}

export interface IrStudy {
  protocol_id: string;
  title: string;
}

export interface Ir {
  ir_version: string;
  source?: string;
  study: IrStudy;
  visits: IrVisit[];
}

// ---------------------------------------------------------------------------
// Canonical type validation.
// ---------------------------------------------------------------------------

const CANONICAL_SET: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'integer',
  'decimal',
  'date',
  'time',
  'datetime',
  'boolean',
  'single_select',
  'multi_select',
  'radio',
  'checkbox',
  'calculated',
]);

export class IrParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IrParseError';
  }
}

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

export function parseIR(raw: RawIR): Ir {
  if (!raw || typeof raw !== 'object') {
    throw new IrParseError('IR is not an object');
  }
  if (!Array.isArray(raw.visits)) {
    throw new IrParseError('IR.visits is not an array');
  }
  if (!raw.study || typeof raw.study !== 'object') {
    throw new IrParseError('IR.study is missing');
  }

  const visits: IrVisit[] = raw.visits.map((v, vi) => {
    if (!Array.isArray(v.forms)) {
      throw new IrParseError(`visit ${vi} ("${v.name}") has no forms array`);
    }
    const forms: IrForm[] = v.forms.map((f, fi) => {
      if (!Array.isArray(f.fields)) {
        throw new IrParseError(`form ${vi}.${fi} ("${f.name}") has no fields array`);
      }
      const fields: IrField[] = f.fields.map((fd, di) => {
        const field_id = `v${vi}.f${fi}.d${di}`;
        if (!CANONICAL_SET.has(fd.type)) {
          throw new IrParseError(
            `field ${field_id} ("${fd.label}") has unknown type "${fd.type}"`,
          );
        }
        const canonical_type = fd.type as CanonicalType;

        let options: CodedPair[] | undefined;
        if (fd.options) {
          options = fd.options.map((o) => ({ code: o.code, label: o.label }));
        }

        let range: RangeSpec | undefined;
        if (fd.min !== undefined || fd.max !== undefined || fd.units !== undefined) {
          if (fd.min === undefined || fd.max === undefined) {
            throw new IrParseError(
              `field ${field_id} ("${fd.label}") has a partial range (min and max are both required)`,
            );
          }
          range = { min: fd.min, max: fd.max, units: fd.units };
        }

        let skip_logic: SkipRule | undefined;
        if (fd.skip_logic) {
          skip_logic = {
            when_field_label: fd.skip_logic.when_field_label,
            equals_value: fd.skip_logic.equals_value,
          };
        }

        return {
          field_id,
          label: fd.label,
          canonical_type,
          required: fd.required,
          options,
          range,
          formula: fd.formula,
          skip_logic,
        };
      });
      return {
        form_id: `v${vi}.f${fi}`,
        name: f.name,
        repeating: f.repeating,
        fields,
      };
    });
    return {
      visit_id: `v${vi}`,
      name: v.name,
      window_start_day: v.window_start_day,
      window_end_day: v.window_end_day,
      forms,
    };
  });

  return {
    ir_version: raw.ir_version,
    source: raw.source,
    study: { protocol_id: raw.study.protocol_id, title: raw.study.title },
    visits,
  };
}

/** Parse a JSON string into a typed IR. */
export function parseIRJson(text: string): Ir {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new IrParseError(`IR is not valid JSON: ${String(err)}`);
  }
  return parseIR(raw as RawIR);
}
