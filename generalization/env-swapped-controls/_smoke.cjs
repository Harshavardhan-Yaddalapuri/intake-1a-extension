// Smoke test for env-swapped-controls using vm module
const vm = require('vm');
const fs = require('fs');

const code = fs.readFileSync('core.js', 'utf8');
const sandbox = {
  window: { location: { search: '' } },
  URLSearchParams: require('url').URLSearchParams,
  console: console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const w = sandbox.window;
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  OK: ' + name); }
  else { fail++; console.log('  FAIL: ' + name); }
}

// Access vars from sandbox (var declarations go to sandbox in vm)
const ELEMENT_TYPES = sandbox.ELEMENT_TYPES;
const FIELD_TYPE_DEFS = sandbox.FIELD_TYPE_DEFS;
const state = sandbox.state;
const PLATFORM_LABEL = sandbox.PLATFORM_LABEL;

// 1. All 13 canonical types
const types = ['calculated','multi_select','checkbox','date','datetime','single_select','textarea','decimal','integer','radio','text','time','boolean'];
const have = ELEMENT_TYPES.map(t=>t.canonical).sort().join(',');
const want = types.sort().join(',');
check('13 canonical types present', have === want);

// 2. Ground truth
check('__groundTruth is function', typeof w.__groundTruth === 'function');
const gt = w.__groundTruth();
check('gt.platform = env-swapped-controls', gt.platform === 'env-swapped-controls');
check('gt.study is object', typeof gt.study === 'object');
check('gt.study.visits is array', Array.isArray(gt.study.visits));

// 3. Library order traps
const radioIdx = ELEMENT_TYPES.findIndex(t=>t.canonical==='radio');
const ssIdx = ELEMENT_TYPES.findIndex(t=>t.canonical==='single_select');
check('radio before single_select (swap)', radioIdx < ssIdx);

const cbIdx = ELEMENT_TYPES.findIndex(t=>t.canonical==='checkbox');
const msIdx = ELEMENT_TYPES.findIndex(t=>t.canonical==='multi_select');
check('checkbox before multi_select (adjacency flip)', cbIdx < msIdx);

// 4. Vocabulary distinct
const labels = ELEMENT_TYPES.map(t=>t.label);
const forbidden = ['Check List','Checkbox','Dropdown','Radio Buttons','Yes/No Toggle','Single Line Textbox','Multi-line Textbox','Number (Decimal)','Number (Whole)','Calculated Field','Date','Date/Time','Save','Activate','Derived Value','Single Choice Box','Multi Choice Box','Picker','Dial Group','Free String','Long String','Whole Number','Fractional Number','Calendar Day','Clock Time','Stamp','Binary Flip'];
const clashes = labels.filter(l => forbidden.includes(l));
check('no vocab clashes', clashes.length === 0);

// 5. No em-dashes
let emDash = false;
['index.html','style.css','core.js','ui.js'].forEach(f => {
  const c = fs.readFileSync(f,'utf8');
  if (c.includes('\u2014') || c.includes('\u2013')) { emDash = true; console.log('  em-dash in ' + f); }
});
check('no em-dashes', !emDash);

// 6. Platform label
check('PLATFORM_LABEL is Nexus Form Engine', PLATFORM_LABEL === 'Nexus Form Engine');

// 7. Type-change range clearing (BOTH directions)
sandbox.openVisitForm();
sandbox.setVisitDraft({ name: 'V1', windowStart: '0', windowEnd: '7' });
sandbox.saveVisit();
const vid = sandbox.state.study.visits[0].id;
sandbox.navigate({ kind: 'visit', visitId: vid });

sandbox.openFormForm();
sandbox.setFormDraft({ name: 'F1', repeating: false });
sandbox.createForm();
const fid = sandbox.state.study.visits[0].forms[0].id;
sandbox.openBuilder(vid, fid);

sandbox.addElement('integer');
const elId = sandbox.state.ui.builder.selectedElementId;

sandbox.patchSelected({ min: '10', max: '100', units: 'mg' });
let el0 = sandbox.selectedElement();
check('integer has min=10', el0.min === '10');
check('integer has max=100', el0.max === '100');
check('integer has units=mg', el0.units === 'mg');

// integer -> decimal: should CLEAR (BOTH directions trap)
sandbox.setSelectedType('decimal');
el0 = sandbox.selectedElement();
check('decimal after integer: min cleared', el0.min === '');
check('decimal after integer: max cleared', el0.max === '');
check('decimal after integer: units cleared', el0.units === '');

// Set range on decimal
sandbox.patchSelected({ min: '5.5', max: '99.9', units: 'kg', decimalPlaces: '2' });

// decimal -> integer: should ALSO clear (BOTH directions)
sandbox.setSelectedType('integer');
el0 = sandbox.selectedElement();
check('integer after decimal: min cleared', el0.min === '');
check('integer after decimal: max cleared', el0.max === '');
check('integer after decimal: units cleared', el0.units === '');

// 8. Range -> non-range should also clear
sandbox.patchSelected({ min: '1', max: '50', units: 'ml' });
sandbox.setSelectedType('text');
el0 = sandbox.selectedElement();
check('text after integer: min cleared', el0.min === '');

// 9. Non-range -> non-range should not crash
sandbox.setSelectedType('text');
sandbox.setSelectedType('date');
el0 = sandbox.selectedElement();
check('text->date type is date', el0.type === 'date');

// 10. Bulk paste APPENDS
sandbox.addElement('single_select');
sandbox.addValue();
sandbox.addValue();
sandbox.setValueCode(0, 'A');
sandbox.setValueLabel(0, 'Alpha');
sandbox.setValueCode(1, 'B');
sandbox.setValueLabel(1, 'Bravo');
let el1 = sandbox.selectedElement();
check('select has 2 values before paste', el1.values.length === 2);

sandbox.setPasteText('C=Charlie\nD=Delta');
sandbox.applyPasteValues();
el1 = sandbox.selectedElement();
check('select has 4 values after append paste', el1.values.length === 4);
check('first value still Alpha (appended, not replaced)', el1.values[0].label === 'Alpha');
check('third value is Charlie (appended)', el1.values[2].label === 'Charlie');
check('fourth value is Delta (appended)', el1.values[3].label === 'Delta');

// 11. Options types have code+label
check('single_select hasOptions', FIELD_TYPE_DEFS.single_select.hasOptions);
check('multi_select hasOptions', FIELD_TYPE_DEFS.multi_select.hasOptions);
check('radio hasOptions', FIELD_TYPE_DEFS.radio.hasOptions);

// 12. Range types
check('integer hasRange', FIELD_TYPE_DEFS.integer.hasRange);
check('decimal hasRange', FIELD_TYPE_DEFS.decimal.hasRange);

// 13. Formula type
check('calculated hasFormula', FIELD_TYPE_DEFS.calculated.hasFormula);

// 14. Skip logic / visibility
sandbox.addElement('text');
const skipEl = sandbox.selectedElement();
check('default visibility always', skipEl.visibility.mode === 'always');
sandbox.setVisibilityMode('when');
const skipEl2 = sandbox.selectedElement();
check('visibility mode when', skipEl2.visibility.mode === 'when');
check('visibility has whenElementId', 'whenElementId' in skipEl2.visibility);
check('visibility has equalsValue', 'equalsValue' in skipEl2.visibility);

// 15. Ground truth structure after all elements
// Must save the working copy first -- __groundTruth reads from state.study, not builder.working
sandbox.lockWorking();
// Must save the working copy first -- __groundTruth reads from state.study, not builder.working
sandbox.lockWorking();
const gt2 = w.__groundTruth();
const form0 = gt2.study.visits[0].forms[0];
check('gt form has fields array', Array.isArray(form0.fields));
check('gt field has label', typeof form0.fields[0].label === 'string');
check('gt field has type', typeof form0.fields[0].type === 'string');
check('gt field has options array', Array.isArray(form0.fields[0].options));
check('gt field has min', 'min' in form0.fields[0]);
check('gt field has max', 'max' in form0.fields[0]);
check('gt field has units', 'units' in form0.fields[0]);
check('gt field has formula', 'formula' in form0.fields[0]);
check('gt field has skipLogic', 'skipLogic' in form0.fields[0]);

// 16. UI.js references core functions
const uiCode = fs.readFileSync('ui.js', 'utf8');
check('ui.js references typeLabel', uiCode.includes('typeLabel('));
check('ui.js references ELEMENT_TYPES', uiCode.includes('ELEMENT_TYPES'));
check('ui.js references build()', uiCode.includes('function build()'));
check('ui.js references selectedElement', uiCode.includes('selectedElement()'));
check('ui.js has preview modal', uiCode.includes('previewModal'));
check('ui.js has palette sidebar', uiCode.includes('paletteSidebar'));

console.log('\n=== Results: ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) process.exit(1);