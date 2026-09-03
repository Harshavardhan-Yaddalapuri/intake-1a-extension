#!/usr/bin/env python3
"""
Scoring harness for the Intake 1a generalization environments.

Compares a ground-truth export (from an env's __groundTruth() call) against
the canonical IR (abc-101-study.ir.json) and produces a per-env scorecard.

Usage:
    python3 score.py --ir <path/to/abc-101-study.ir.json> --ground-truth <path/to/ground-truth.json>
    python3 score.py --ir <path> --ground-truth <path> --json   # machine-readable output

Ground-truth JSON format (from any env's window.__groundTruth()):
    {
      "platform": "env-rosetta",
      "specVersion": "...",
      "study": {
        "name": "ABC-101",
        "visits": [
          {
            "name": "Screening",
            "windowStart": "-28",
            "windowEnd": "-1",
            "forms": [
              {
                "name": "Demographics",
                "repeating": false,
                "status": "draft",
                "fields": [
                  {
                    "label": "Subject Initials",
                    "type": "text",
                    "required": true,
                    "options": [],
                    "min": "",
                    "max": "",
                    "units": "",
                    "formula": "",
                    "skipLogic": null
                  }
                ]
              }
            ]
          }
        ]
      }
    }

IR JSON format (abc-101-study.ir.json):
    {
      "visits": [
        {
          "name": "Screening",
          "window_start_day": -28,
          "window_end_day": -1,
          "forms": [
            {
              "name": "Demographics",
              "repeating": false,
              "fields": [
                {
                  "label": "Subject Initials",
                  "type": "text",
                  "required": true,
                  "options": [],
                  "min": null,
                  "max": null,
                  "units": null,
                  "formula": null,
                  "skip_logic": null
                }
              ]
            }
          ]
        }
      ]
    }

Scoring criteria (per criterion, exact-match only):
  1. visits        -- visit count and names
  2. forms         -- form count, names, repeating flag
  3. fields        -- field count per form
  4. types         -- field type matches expected
  5. required      -- required flag matches
  6. coded-pairs   -- options: code + label pairs (order-insensitive)
  7. ranges        -- min, max, units match
  8. skip-rules    -- skip logic: controlling field + equals value
  9. repeating     -- form repeating flag (separate from form count)
  10. visit-windows -- window start/end days

Output: per-env scorecard with exact-match %, per-criterion breakdown,
         escalations count, LLM calls count, human decisions count.

The escalations/LLM/human counts come from the extension's own runtime
log, NOT from the ground truth. Pass them via --runtime-log <path> if
available (JSON with keys: escalations, llm_calls, human_decisions).
If not provided, those columns show "N/A".
"""

import argparse
import json
import sys
from collections import OrderedDict


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def norm_str(v):
    """Normalize a value to a comparable string. Empty/None -> ''."""
    if v is None:
        return ''
    return str(v).strip()


def norm_options(opts):
    """Normalize options list to a set of (code, label) tuples (order-insensitive)."""
    if not opts:
        return set()
    result = set()
    for o in opts:
        code = norm_str(o.get('code', ''))
        label = norm_str(o.get('label', ''))
        result.add((code, label))
    return result


def norm_skip_logic(gt_sl, ir_sl):
    """Normalize skip logic for comparison."""
    # Ground truth: { whenFieldLabel, equalsValue } or null
    # IR: { when_field_label, equals_value } or null
    gt_norm = None
    ir_norm = None
    if gt_sl:
        gt_norm = (norm_str(gt_sl.get('whenFieldLabel', '')),
                   norm_str(gt_sl.get('equalsValue', '')))
    if ir_sl:
        ir_norm = (norm_str(ir_sl.get('when_field_label', '')),
                   norm_str(ir_sl.get('equals_value', '')))
    return gt_norm, ir_norm


# ---------------------------------------------------------------------------
# Comparison engine
# ---------------------------------------------------------------------------

class Scorecard:
    def __init__(self, platform):
        self.platform = platform
        self.criteria = OrderedDict([
            ('visits',         {'expected': 0, 'matched': 0, 'details': []}),
            ('visit-windows',  {'expected': 0, 'matched': 0, 'details': []}),
            ('forms',          {'expected': 0, 'matched': 0, 'details': []}),
            ('repeating',      {'expected': 0, 'matched': 0, 'details': []}),
            ('fields',         {'expected': 0, 'matched': 0, 'details': []}),
            ('types',          {'expected': 0, 'matched': 0, 'details': []}),
            ('required',       {'expected': 0, 'matched': 0, 'details': []}),
            ('coded-pairs',    {'expected': 0, 'matched': 0, 'details': []}),
            ('ranges',         {'expected': 0, 'matched': 0, 'details': []}),
            ('skip-rules',     {'expected': 0, 'matched': 0, 'details': []}),
        ])

    def record(self, criterion, matched, detail):
        self.criteria[criterion]['expected'] += 1
        if matched:
            self.criteria[criterion]['matched'] += 1
        else:
            self.criteria[criterion]['details'].append(detail)

    @property
    def total_expected(self):
        return sum(c['expected'] for c in self.criteria.values())

    @property
    def total_matched(self):
        return sum(c['matched'] for c in self.criteria.values())

    @property
    def overall_pct(self):
        if self.total_expected == 0:
            return 0.0
        return (self.total_matched / self.total_expected) * 100.0

    def to_dict(self, runtime_log=None):
        result = {
            'platform': self.platform,
            'overall_match_pct': round(self.overall_pct, 2),
            'total_expected': self.total_expected,
            'total_matched': self.total_matched,
            'criteria': {},
        }
        for name, c in self.criteria.items():
            pct = (c['matched'] / c['expected'] * 100.0) if c['expected'] > 0 else None
            result['criteria'][name] = {
                'expected': c['expected'],
                'matched': c['matched'],
                'match_pct': round(pct, 2) if pct is not None else None,
                'mismatches': c['details'][:20],  # cap details
            }
        if runtime_log:
            result['runtime'] = runtime_log
        else:
            result['runtime'] = {
                'escalations': 'N/A',
                'llm_calls': 'N/A',
                'human_decisions': 'N/A',
            }
        return result


def compare(gt, ir, runtime_log=None):
    """Compare ground truth against IR and return a Scorecard."""
    platform = gt.get('platform', 'unknown')
    sc = Scorecard(platform)

    gt_visits = gt.get('study', {}).get('visits', [])
    ir_visits = ir.get('visits', [])

    # 1. Visits -- count + names
    gt_visit_names = [norm_str(v.get('name', '')) for v in gt_visits]
    ir_visit_names = [norm_str(v.get('name', '')) for v in ir_visits]
    for i, ir_name in enumerate(ir_visit_names):
        matched = i < len(gt_visit_names) and gt_visit_names[i] == ir_name
        sc.record('visits', matched,
                   f"visit[{i}] expected '{ir_name}', got '{gt_visit_names[i] if i < len(gt_visit_names) else 'MISSING'}'")

    # Build lookup: visit name -> visit object
    gt_visit_map = {norm_str(v.get('name', '')): v for v in gt_visits}
    ir_visit_map = {norm_str(v.get('name', '')): v for v in ir_visits}

    for ir_vname in ir_visit_names:
        gt_visit = gt_visit_map.get(ir_vname)

        # 2. Visit windows
        ir_ws = norm_str(ir_visit_map[ir_vname].get('window_start_day', ''))
        ir_we = norm_str(ir_visit_map[ir_vname].get('window_end_day', ''))
        if gt_visit:
            gt_ws = norm_str(gt_visit.get('windowStart', ''))
            gt_we = norm_str(gt_visit.get('windowEnd', ''))
            sc.record('visit-windows',
                       gt_ws == ir_ws and gt_we == ir_we,
                       f"visit '{ir_vname}' window expected [{ir_ws},{ir_we}], got [{gt_ws},{gt_we}]")
        else:
            sc.record('visit-windows', False,
                       f"visit '{ir_vname}' MISSING -- cannot check window")

        ir_forms = ir_visit_map[ir_vname].get('forms', [])
        gt_forms = (gt_visit.get('forms', []) if gt_visit else [])

        # 3. Forms -- count + names
        gt_form_names = [norm_str(f.get('name', '')) for f in gt_forms]
        ir_form_names = [norm_str(f.get('name', '')) for f in ir_forms]
        for i, ir_fname in enumerate(ir_form_names):
            matched = i < len(gt_form_names) and gt_form_names[i] == ir_fname
            sc.record('forms', matched,
                       f"visit '{ir_vname}' form[{i}] expected '{ir_fname}', got '{gt_form_names[i] if i < len(gt_form_names) else 'MISSING'}'")

        gt_form_map = {norm_str(f.get('name', '')): f for f in gt_forms}
        ir_form_map = {norm_str(f.get('name', '')): f for f in ir_forms}

        for ir_fname in ir_form_names:
            gt_form = gt_form_map.get(ir_fname)
            ir_form = ir_form_map[ir_fname]

            # 4. Repeating flag
            ir_rep = ir_form.get('repeating', False)
            gt_rep = gt_form.get('repeating', False) if gt_form else None
            sc.record('repeating', gt_form is not None and gt_rep == ir_rep,
                       f"visit '{ir_vname}' form '{ir_fname}' repeating expected {ir_rep}, got {gt_rep}")

            ir_fields = ir_form.get('fields', [])
            gt_fields = (gt_form.get('fields', []) if gt_form else [])

            # 5. Fields -- count
            sc.record('fields', len(gt_fields) == len(ir_fields),
                       f"visit '{ir_vname}' form '{ir_fname}' field count expected {len(ir_fields)}, got {len(gt_fields)}")

            # Build field lookup by label (case-sensitive, trimmed)
            gt_field_map = {norm_str(f.get('label', '')): f for f in gt_fields}

            for ir_field in ir_fields:
                ir_label = norm_str(ir_field.get('label', ''))
                gt_field = gt_field_map.get(ir_label)

                if not gt_field:
                    # Field missing entirely
                    sc.record('types', False, f"field '{ir_label}' MISSING in visit '{ir_vname}' form '{ir_fname}'")
                    sc.record('required', False, f"field '{ir_label}' MISSING")
                    sc.record('coded-pairs', False, f"field '{ir_label}' MISSING")
                    sc.record('ranges', False, f"field '{ir_label}' MISSING")
                    sc.record('skip-rules', False, f"field '{ir_label}' MISSING")
                    continue

                # 6. Type
                ir_type = ir_field.get('type', '')
                gt_type = gt_field.get('type', '')
                sc.record('types', gt_type == ir_type,
                           f"field '{ir_label}' type expected '{ir_type}', got '{gt_type}'")

                # 7. Required
                ir_req = ir_field.get('required', False)
                gt_req = gt_field.get('required', False)
                sc.record('required', gt_req == ir_req,
                           f"field '{ir_label}' required expected {ir_req}, got {gt_req}")

                # 8. Coded pairs (options)
                ir_opts = ir_field.get('options', [])
                gt_opts = gt_field.get('options', [])
                if not ir_opts and not gt_opts:
                    sc.record('coded-pairs', True, None)  # both empty = match
                else:
                    ir_set = norm_options(ir_opts)
                    gt_set = norm_options(gt_opts)
                    sc.record('coded-pairs', ir_set == gt_set,
                               f"field '{ir_label}' options expected {sorted(ir_set)}, got {sorted(gt_set)}")

                # 9. Ranges (min, max, units)
                has_ir_range = any(ir_field.get(k) is not None for k in ('min', 'max', 'units'))
                if has_ir_range:
                    ir_min = norm_str(ir_field.get('min'))
                    ir_max = norm_str(ir_field.get('max'))
                    ir_units = norm_str(ir_field.get('units'))
                    gt_min = norm_str(gt_field.get('min'))
                    gt_max = norm_str(gt_field.get('max'))
                    gt_units = norm_str(gt_field.get('units'))
                    sc.record('ranges',
                               gt_min == ir_min and gt_max == ir_max and gt_units == ir_units,
                               f"field '{ir_label}' range expected [{ir_min},{ir_max},{ir_units}], got [{gt_min},{gt_max},{gt_units}]")
                else:
                    # No range expected; check ground truth also has none
                    gt_has_range = any(norm_str(gt_field.get(k)) for k in ('min', 'max', 'units'))
                    sc.record('ranges', not gt_has_range,
                               f"field '{ir_label}' no range expected, gt has range: {gt_has_range}")

                # 10. Skip rules
                ir_sl = ir_field.get('skip_logic')
                gt_sl = gt_field.get('skipLogic')
                if not ir_sl and not gt_sl:
                    sc.record('skip-rules', True, None)  # both none = match
                else:
                    gt_norm, ir_norm = norm_skip_logic(gt_sl, ir_sl)
                    sc.record('skip-rules', gt_norm == ir_norm,
                               f"field '{ir_label}' skip expected {ir_norm}, got {gt_norm}")

    return sc.to_dict(runtime_log)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Score a ground-truth export against the IR.')
    parser.add_argument('--ir', required=True,
                        help='Path to the IR JSON file (abc-101-study.ir.json)')
    parser.add_argument('--ground-truth', required=True,
                        help='Path to the ground-truth JSON file (from env __groundTruth())')
    parser.add_argument('--runtime-log', default=None,
                        help='Path to runtime log JSON (escalations, llm_calls, human_decisions)')
    parser.add_argument('--json', action='store_true',
                        help='Output machine-readable JSON instead of human-readable text')
    args = parser.parse_args()

    with open(args.ir) as f:
        ir = json.load(f)

    with open(args.ground_truth) as f:
        gt = json.load(f)

    runtime_log = None
    if args.runtime_log:
        with open(args.runtime_log) as f:
            runtime_log = json.load(f)

    result = compare(gt, ir, runtime_log)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_human_readable(result)


def print_human_readable(result):
    """Print a human-readable scorecard."""
    print(f"\n{'='*60}")
    print(f"  SCORECARD: {result['platform']}")
    print(f"{'='*60}")
    print(f"  Overall match: {result['overall_match_pct']}%")
    print(f"  Total: {result['total_matched']}/{result['total_expected']}")
    print(f"{'-'*60}")
    print(f"  {'Criterion':<18} {'Matched':>8} {'Expected':>8} {'%':>7}")
    print(f"{'-'*60}")
    for name, c in result['criteria'].items():
        pct = f"{c['match_pct']:.1f}%" if c['match_pct'] is not None else 'N/A'
        print(f"  {name:<18} {c['matched']:>8} {c['expected']:>8} {pct:>7}")
        for detail in c['mismatches'][:5]:
            if detail:
                print(f"    ! {detail}")
        if len(c['mismatches']) > 5:
            print(f"    ... and {len(c['mismatches']) - 5} more")
    print(f"{'-'*60}")
    rt = result['runtime']
    print(f"  Escalations:     {rt.get('escalations', 'N/A')}")
    print(f"  LLM calls:       {rt.get('llm_calls', 'N/A')}")
    print(f"  Human decisions: {rt.get('human_decisions', 'N/A')}")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()