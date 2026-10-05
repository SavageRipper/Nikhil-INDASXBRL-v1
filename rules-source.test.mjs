// Suite: Ind AS business-rule corpus ingestion (workbook V1.2) and the compiled rule ledger — every source row is
// accounted for, every executable formalization refers only to DTS elements and can actually fire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readWorkbook, specificRules, genericRules, mandatoryLineItemSheets, applicableElrs, openingClosingFormulaList, countryNames, currencyCodes } from './rules-source.mjs';
import { authority } from './helpers.mjs';
import { nondimAllowed } from './dimensions.js';

const A = authority();
const COV = JSON.parse(readFileSync(new URL('./BUSINESS_RULE_COVERAGE.json', import.meta.url), 'utf8'));
const SOURCE = new URL('./' + COV.corpus.sourceFile, import.meta.url).pathname;
const wb = readWorkbook(SOURCE);
const rules = A.rules.rules;

test('corpus inventory: complete original workbook V1.2, every sheet read, no truncation', () => {
  assert.equal(COV.corpus.sourceFile, 'Business_Rules_IndAS_Taxonomy_V1.2.xlsx');
  assert.equal(wb.form, 'workbook');
  const names = wb.sheets.map((s) => s.name.trim());
  for (const n of ['Applicable ELR', 'Specific rules for elements', 'Generic rules', 'Mandatory Line Items', 'Exempt parent member Dimension', 'Exempt Child Member Dimension', 'formulas Linkbase', 'Country Codes', 'Currency Code', 'Parent Child Exempt Calculation']) assert.ok(names.includes(n), n);
  const spec = specificRules(wb);
  assert.equal(spec.truncated, false);
  assert.ok(wb.sheets.every((s) => !s.truncated));
  assert.equal(spec.rows.length, 812);
  assert.equal(genericRules(wb).length, 16);
  assert.equal(mandatoryLineItemSheets(wb)[0].rows.length, 108);
  assert.equal(COV.corpus.specificRuleRows, spec.rows.length);
  assert.equal(COV.corpus.firstElrInSpecificRules, '[110000] Balance sheet');
  assert.equal(COV.corpus.lastElrInSpecificRules, '[700700] Disclosures - Secretarial audit report');
  assert.deepEqual(COV.corpus.elrsWithoutSuppliedSpecificRules, []);
  console.log(`# corpus: ${COV.corpus.sourceFile} sha256=${COV.corpus.sourceSha256.slice(0, 16)} specific=${spec.rows.length} generic=16 ML=108`);
});

test('every source row becomes at least one ledger entry with exactly one status', () => {
  const spec = specificRules(wb);
  const lines = new Set(rules.filter((r) => r.family === 'specific').map((r) => r.line));
  for (const row of spec.rows) assert.ok(lines.has(row.line), `specific row ${row.line} (${row.element}) has no rule`);
  const gens = rules.filter((r) => r.family === 'generic');
  assert.equal(gens.length, genericRules(wb).length);
  assert.equal(rules.filter((r) => r.family === 'mandatory-line-items').length, mandatoryLineItemSheets(wb)[0].rows.length + 1, 'ML rows (+ the qualified duplicate table row)');
  const ok = new Set(['EXECUTABLE', 'REVIEW_ONLY_EXTERNAL_DATA', 'NOT_APPLICABLE', 'UNIMPLEMENTED']);
  for (const r of rules) assert.ok(ok.has(r.status), `${r.id}: ${r.status}`);
  const ids = new Set(); for (const r of rules) { assert.ok(!ids.has(r.id), 'duplicate id ' + r.id); ids.add(r.id); }
  assert.deepEqual(COV.summary, rules.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {}));
});

test('honest statuses: no executable rule without an implementation; every non-executable rule carries a reason', () => {
  for (const r of rules) {
    if (r.status === 'EXECUTABLE') assert.ok(r.implementation, r.id);
    else assert.ok(r.reason, `${r.id} (${r.status}) has no reason`);
  }
  const un = rules.filter((r) => r.status === 'UNIMPLEMENTED');
  assert.deepEqual(un.map((r) => r.id), ['ML-43-b'], 'the only unformalized clause is the ambiguous related-party outstanding-balance sentence');
  assert.match(un[0].reason, /Ambiguous/);
});

test('reference check: every element, member, axis and table of an executable rule exists in the Ind AS 2017 DTS', () => {
  const tables = new Set(A.tables.map((t) => t.id));
  for (const r of rules.filter((x) => x.status === 'EXECUTABLE' && x.ast)) {
    const walk = (x, key) => {
      if (x == null) return;
      if (typeof x === 'string') { if (['fact', 'concept', 'axis', 'member', 'balance', 'change', 'target', 'flag'].includes(key)) assert.ok(A.concept(x), `${r.id}: ${key}=${x}`); return; }
      if (Array.isArray(x)) { for (const v of x) if (key === 'tables' || key === 'otherTables') assert.ok(tables.has(v), `${r.id}: table ${v}`); else walk(v, ['concepts', 'members', 'plus', 'minus'].includes(key) ? 'concept' : key); return; }
      if (typeof x === 'object') for (const [k, v] of Object.entries(x)) if (k !== 'fixed') walk(v, k);
    };
    walk(r.ast, '');
  }
});

test('formalizations can fire: no condition on a non-dimensional fact of an element reportable only in table rows', () => {
  for (const r of rules.filter((x) => x.status === 'EXECUTABLE' && x.ast)) {
    const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (x.fact && x.ctx === 'nondim') assert.ok(nondimAllowed(A, x.fact), `${r.id}: condition on ${x.fact} as a non-dimensional fact can never be true`); Object.values(x).forEach(walk); };
    walk(r.ast.when); walk(r.ast.assert);
  }
  // the auditor-firm rules are evaluated per auditor row
  const a = rules.find((r) => r.id === 'SR-L6479-1').ast;
  assert.equal(a.type, 'eachFactOf'); assert.equal(a.concept, 'in-ca:CategoryOfAuditor'); assert.equal(a.assert.e.fact, 'in-ca:NameOfAuditFirm');
});

test('mandatory line items: never an empty requirement; "All line items are mandatory" lists the table\'s line items', () => {
  for (const r of rules.filter((x) => x.status === 'EXECUTABLE' && x.ast?.type === 'lineItemsMandatory')) assert.ok(r.ast.concepts.length || r.ast.atLeastOne?.length, `${r.id} requires nothing`);
  const ml46 = rules.find((r) => r.id === 'ML-46');
  assert.equal(ml46.implementation, 'pattern:mandatory-line-items-all');
  assert.deepEqual([...ml46.ast.concepts].sort(), [...A.table(ml46.ast.tables[0]).lineItems].sort());
});

test('Applicable ELR sheet lists exactly the 60 ELRs of the taxonomy', () => {
  const rows = applicableElrs(wb);
  assert.equal(rows.length, A.elrs.length);
  assert.deepEqual(new Set(rows.map((r) => r.code)), new Set(A.elrs.map((e) => e.code)));
});

test('formula sheet ("formulas Linkbase") and the taxonomy formula linkbase name the same opening/closing elements', () => {
  const list = openingClosingFormulaList(wb);
  assert.equal(list.length, 108);
  const names = new Set(list.map((x) => x.name));
  for (const fa of A.json.formulas.assertions) {
    assert.ok(names.has(fa.form.balance.split(':')[1]), `${fa.id}: balance on the sheet`);
    assert.ok(names.has(fa.form.change.split(':')[1]), `${fa.id}: change on the sheet`);
  }
  assert.deepEqual(COV.corpus.formulaSheetElementsWithoutTaxonomyAssertion, []);
  assert.equal(rules.filter((r) => r.family === 'formula' && r.status === 'EXECUTABLE').length, 35);
});

test('country and currency code sheets (Filing Manual Annexure III) are loaded', () => {
  assert.ok(countryNames(wb).length > 100 && A.rules.countries.includes('INDIA'));
  assert.ok(currencyCodes(wb).length > 80 && A.rules.currencies.includes('INR') && A.rules.currencies.includes('USD'));
});

test('Yes/No dependencies are derived only from executable MCA rules on non-dimensional booleans', () => {
  const deps = A.rules.booleanDependencies;
  assert.ok(deps.length > 30);
  for (const d of deps) {
    assert.equal(A.dataType(d.parentConcept), 'boolean', d.parentConcept);
    assert.ok(nondimAllowed(A, d.parentConcept), d.parentConcept);
    for (const id of d.rules) assert.equal(rules.find((r) => r.id === id).status, 'EXECUTABLE', id);
  }
});
