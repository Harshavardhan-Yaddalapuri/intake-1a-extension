/**
 * Null-ACT dry run (S2 verify step 2).
 *
 * Compiles the real IR, prints the linear plan, and asserts the expected
 * counts: 28 form appearances, 195 field nodes, 13 skip rules resolved as
 * edges. Also prints a hash of the plan so byte-identical output across two
 * runs can be confirmed.
 *
 * Usage: node dist/test/dry-run.mjs [path-to-ir.json]
 *   - with no arg, uses the given mock's input file.
 *   - with "--cyclic", compiles a synthetic cyclic IR and prints the cycle
 *     report (S2 verify step 3).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseIRJson, type RawIR } from '../src/plan/ir';
import { compilePlan, linearize } from '../src/plan/compiler';

const DEFAULT_IR =
  '/Users/harshavardhan/Projects/IntakeAI Takehome/1a/intake-takehome-2/data/abc-101-study.ir.json';

function printPlan(irPath: string): void {
  const text = readFileSync(irPath, 'utf8');
  const ir = parseIRJson(text);
  const plan = compilePlan(ir);
  const linear = linearize(plan);

  console.log('=== PLAN COMPILATION ===');
  console.log(`study: ${plan.study.protocol_id} - ${plan.study.title}`);
  console.log(`visits: ${plan.visits.length}`);
  console.log(`form appearances: ${plan.form_appearances}`);
  console.log(`field nodes: ${plan.field_nodes}`);
  console.log(`skip edges: ${plan.skip_edges}`);
  console.log(`form reuse policy: ${plan.form_reuse_policy}`);
  console.log(`compile errors: ${plan.errors.length}`);
  for (const e of plan.errors) {
    console.log(`  [${e.kind}] ${e.message}`);
  }
  console.log(`linear plan steps: ${linear.length}`);

  // Hash the linear plan for byte-identical reproducibility.
  const hash = createHash('sha256').update(JSON.stringify(linear)).digest('hex');
  console.log(`plan hash (sha256): ${hash}`);

  console.log('\n=== LINEAR PLAN (first 12 steps) ===');
  for (const item of linear.slice(0, 12)) {
    console.log(`  ${item.visit_id}/${item.form_id}/${item.field_id} [${item.kind}] ${item.description}`);
  }
  console.log('  ...');
  console.log('=== LINEAR PLAN (last 8 steps) ===');
  for (const item of linear.slice(-8)) {
    console.log(`  ${item.visit_id}/${item.form_id}/${item.field_id} [${item.kind}] ${item.description}`);
  }

  // Assertions.
  const failures: string[] = [];
  if (plan.form_appearances !== 28) failures.push(`form appearances ${plan.form_appearances} != 28`);
  if (plan.field_nodes !== 195) failures.push(`field nodes ${plan.field_nodes} != 195`);
  if (plan.skip_edges !== 13) failures.push(`skip edges ${plan.skip_edges} != 13`);
  if (plan.errors.length !== 0) failures.push(`compile errors present: ${plan.errors.length}`);

  if (failures.length) {
    console.error('\nASSERTION FAILURES:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nASSERTIONS PASS: 28 appearances, 195 fields, 13 skip edges, 0 errors.');
}

function printCyclic(): void {
  // A synthetic IR with a skip-logic cycle: A shown when B, B shown when A.
  const cyclic: RawIR = {
    ir_version: '1.0',
    study: { protocol_id: 'SYNTH', title: 'Synthetic cyclic study' },
    visits: [
      {
        name: 'V1',
        window_start_day: 0,
        window_end_day: 1,
        forms: [
          {
            name: 'Cyclic Form',
            repeating: false,
            fields: [
              {
                label: 'Field A',
                type: 'boolean',
                required: true,
                skip_logic: { when_field_label: 'Field B', equals_value: 'Yes' },
              },
              {
                label: 'Field B',
                type: 'boolean',
                required: true,
                skip_logic: { when_field_label: 'Field A', equals_value: 'Yes' },
              },
            ],
          },
        ],
      },
    ],
  };

  const ir = parseIRJson(JSON.stringify(cyclic));
  const plan = compilePlan(ir);

  console.log('=== CYCLIC IR REPORT ===');
  console.log(`compile errors: ${plan.errors.length}`);
  for (const e of plan.errors) {
    console.log(`  [${e.kind}] ${e.message}`);
  }
  const form = plan.visits[0].forms[0];
  console.log(`form "${form.name}" halted: ${form.halted}`);
  if (form.halt_reason) console.log(`halt reason: ${form.halt_reason}`);
  console.log(`fields in halted form plan: ${form.fields.length}`);

  const cycleError = plan.errors.find((e) => e.kind === 'cycle');
  if (!cycleError || !form.halted) {
    console.error('FAIL: expected a cycle error and a halted form');
    process.exit(1);
  }
  console.log('PASS: cycle detected, affected form halted.');
}

const arg = process.argv[2];
if (arg === '--cyclic') {
  printCyclic();
} else {
  printPlan(arg ?? DEFAULT_IR);
}
