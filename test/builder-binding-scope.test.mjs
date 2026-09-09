// The form builder must not rebind controls that live on other screens.
//
// Live (2026-09-05, run-1788663541434): discoverFormBuilder re-bound EVERY
// rung-0 op from the builder surface. There, "+ Page" (add a page to this
// form) satisfies the same add-ish shape as "+ Add Visit", so visit.create
// became "+ Page" the moment the first form was opened. The journal caught it:
//
//   visit.create:Screening         recipe steps=2 | add control="+ Add Visit"
//   visit.create:Baseline (Day 1)  recipe steps=3 | add control="+ Page"
//                                  text inputs=[Find, Duration of Diagnosis]
//                                  name input="Find"
//
// Three of four visits were lost this way: each was "created" by adding a page
// to the open form and typing the visit name into the palette's filter box.
// Worse, atVisitList accepts the create control as proof of arrival, so the run
// believed it stood on the visit list while inside the designer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { observe } from '../dist/perceive-core.mjs';
import { bindAllRung0, atVisitList } from '../dist/bind-rung0.mjs';

const VISITS = ['Screening', 'Baseline (Day 1)', 'Week 4', 'End of Treatment (Week 12)'];

const TOP_NAV = `<nav><button>Patients</button><button>Calendar</button>
  <button>Study Plan</button><button>Reports</button></nav>`;

// The builder, as the mock renders it: a palette with a Find filter, a paged
// canvas whose "+ Page" is the only add-ish control, and the Options panel.
const builderScreen = () => new JSDOM(`<!doctype html><html><body><div id="app">
  ${TOP_NAV}
  <header><button>← Screening</button><span class="builder-title">Demographics</span>
    <button>Preview Form</button><button>Save As Template</button>
    <button>Save</button><button>Activate</button></header>
  <aside class="palette"><h3>Elements</h3>
    <div class="row"><label for="find">Find</label><input type="text" id="find"></div>
    <button>Calculated Field</button><button>Check List</button><button>Checkbox</button>
    <button>Date</button><button>Dropdown</button><button>Radio Buttons</button>
    <button>Single Line Textbox</button></aside>
  <main><button>Page 1</button><button>+ Page</button></main>
</div></body></html>`).window.document;

// Ops whose controls live on the visit list or the document list, never here.
const FOREIGN_OPS = [
  'nav.to_study_root', 'nav.to_visit_list',
  'visit.create', 'visit.open',
  'form.create', 'form.open', 'form.exists',
];

// The whitelist discoverFormBuilder applies.
const BUILDER_OWNED = [
  'field.add', 'field.set_label', 'field.set_required', 'field.set_range',
  'field.set_coded_values', 'field.set_skip_logic', 'field.set_formula',
  'ctx.commit', 'ctx.is_committed', 'ctx.discard',
  'form.list_fields', 'field_palette.open',
];

test('the builder screen DOES offer a bogus visit.create — which is why the filter is needed', () => {
  const bound = bindAllRung0(observe(builderScreen()));
  const bogus = bound['visit.create'];
  assert.ok(
    bogus,
    'if this ever stops binding, the filter is belt-and-braces rather than load-bearing',
  );
  assert.equal(
    bogus.recipe[0]?.evidence_name, '+ Page',
    'the builder binds visit.create to the page-adding control',
  );
});

test('no foreign op survives the builder whitelist', () => {
  for (const op of FOREIGN_OPS) {
    assert.ok(
      !BUILDER_OWNED.includes(op),
      `${op} lives on another screen and must not be rebound from the builder`,
    );
  }
});

// The same defect, on a platform this fix was NOT written against. If the
// whitelist were overfitted to the supplied mock's "+ Page", it would do
// nothing here -- instead env-rosetta poisons visit.create with a top-level
// nav item, which is worse.
test('the whitelist is load-bearing on env-rosetta too, not just the supplied mock', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'generalization', 'env-rosetta');
  let html = readFileSync(join(dir, 'index.html'), 'utf8');
  for (const f of ['core.js', 'ui.js']) {
    html = html.replace(`<script src="${f}"></script>`,
      '<script>' + readFileSync(join(dir, f), 'utf8') + '</script>');
  }
  const w = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true }).window;
  w.eval(`(function(){
    var v={id:"v1",name:"Phase 1",windowStart:"0",windowEnd:"7",forms:[]};
    var f={id:"f1",name:"Sheet 1",repeating:false,status:"draft",version:1,pages:[{id:"pg1",name:"Page 1",elements:[]}]};
    v.forms.push(f); state.study={name:"ABC-101",visits:[v]}; openBuilder("v1","f1");
  })();`);

  const obs = observe(w.document);
  const bound = bindAllRung0(obs);
  const create = bound['visit.create'];
  assert.ok(create, 'env-rosetta\'s builder also binds a bogus visit.create');
  assert.notEqual(
    create.recipe[0]?.evidence_name, '+ Add Visit',
    'it is emphatically not the real create control',
  );
  // looksLikeCreateControl now rejects inert "Phases", so THAT particular
  // poison no longer fools atVisitList. The remaining load-bearing case is
  // "+ Page" (present on the designer): it looks like a create control and
  // would make the builder read as the visit list if visit.create rebound to it.
  assert.equal(
    atVisitList(obs, VISITS, 'Phases'), false,
    'inert Phases chrome must not witness the visit list',
  );
  assert.equal(
    atVisitList(obs, VISITS, '+ Page'), true,
    '+ Page on the designer still fools atVisitList -- why the whitelist remains',
  );
  for (const op of FOREIGN_OPS) {
    assert.ok(!BUILDER_OWNED.includes(op), `${op} must stay out of the builder whitelist`);
  }
});

test('a poisoned create control makes the builder look like the visit list', () => {
  const obs = observe(builderScreen());
  // This is the second half of the failure: arrival is confirmed by finding the
  // create control, so a create control bound to "+ Page" proves "arrival"
  // without the agent having gone anywhere.
  assert.equal(
    atVisitList(obs, VISITS, '+ Page'), true,
    'demonstrates the false positive the rebinding caused',
  );
  assert.equal(
    atVisitList(obs, VISITS, '+ Add Visit'), false,
    'with the correct create control, the builder is correctly rejected',
  );
});
