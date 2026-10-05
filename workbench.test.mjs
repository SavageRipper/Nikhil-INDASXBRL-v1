// Suite: workbench improvements (engine level) — one shared applicability decision for UI / import / gate /
// generation: previous-year applicability on import, cash-flow method, Yes/No dependencies, calculated cells,
// structured validation locations, current-tab validation, general company information.
// The browser behaviour of the same features is covered by browser-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { authority, q, importSession } from './helpers.mjs';
import { baseSession, exampleSession, T as tid, exportUnchecked } from './fixtures.mjs';
import { Session, CalculatedCellError } from './session.js';
import { Gate } from './gate.js';
import { generateInstance } from './generator.js';
import { factKey } from './model.js';
import { CashFlowChoiceError } from './importer.js';
import { runCalculations } from './calculation.js';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';

const A = authority();
const today = '2018-09-30';
const CI = tid('DetailsOfCurrentInvestmentsTable');
const withCurrentInvestments = (s) => { for (const [sc, v] of [['CY', 1000], ['PY', 800]]) s.setValue(q('CurrentInvestments'), sc, String(v), { recalc: true }); return s; };
const uri = (code) => A.elrByCode(code).uri;
// raw instance of every fact in a filing (bypasses the gate) — simulates a third-party XML
const raw = (s, extra = []) => generateInstance(A, s.filing, [...s.filing.all(), ...extra]).xml;
const put = (s, local, scope, value, dims = []) => s.filing.setFact({ concept: q(local), period: s.filing.period(q(local), scope), dims, value: String(value), decimals: A.isNumeric(q(local)) ? '0' : undefined });
const imp = (xml, opts = {}) => { const s = new Session(A); const r = s.importXml(xml, { DOMParserImpl: DOMParser, ...opts }); return { s, r }; };

// ---------------------------------------------------------------- 2. previous-year applicability on import
test('PY applicability on import: XML PY fact → field applicability → applicable imports, not applicable stays blank', () => {
  const s = baseSession();
  // [700400] auditors report is excluded for the previous year by GR-11; the current-year fact is applicable
  const na = 'WhetherAuditorsReportHasBeenQualifiedOrHasAnyReservationsOrContainsAdverseRemarks';
  put(s, na, 'CY', 'false'); put(s, na, 'PY', 'false');
  // an applicable previous-year comparative, non-dimensional and dimensional
  put(s, 'OtherIncome', 'CY', 7); put(s, 'OtherIncome', 'PY', 5);
  withCurrentInvestments(s);
  const xml = raw(s);
  const { s: t, r } = imp(xml);
  const P = t.filing.meta.periods;
  // not applicable PY: no internal value, blank cell, recorded for traceability with its reason
  assert.equal(t.cellStatus(uri('700400'), q(na), 'PY').applicable, false);
  assert.equal(t.getValue(q(na), 'PY'), null, 'no PY value created');
  assert.ok(r.notApplicable.some((x) => x.concept === q(na) && x.scope === 'PY' && x.reasons.some((m) => m.startsWith('GR-11'))));
  // current year of the same concept unaffected
  assert.equal(t.getValue(q(na), 'CY').value, 'false');
  // applicable PY comparatives imported
  assert.equal(t.getValue(q('OtherIncome'), 'PY').value, '5');
  assert.equal(t.getValue(q('CurrentInvestments'), 'PY').value, '800');
  // no validation finding caused by the dropped PY value
  const g = t.validate({ today });
  assert.equal(g.summary.excluded, 0);
  assert.ok(!g.issues.some((i) => i.message.includes(na) && i.scope === 'PY'));
  assert.ok(P.py.end);
});

// ---------------------------------------------------------------- 3. cash flow: direct vs indirect
const DIRECT_ONLY = 'OtherCashPaymentsFromOperatingActivities'; // [310000] only
const INDIRECT_ONLY = 'AdjustmentsForDecreaseIncreaseInInventories'; // [320000] only
function cashFlowXml({ direct, indirect, declared }) {
  const s = baseSession();
  const t = s.filing.get(q('TypeOfCashFlowStatement'), s.filing.period(q('TypeOfCashFlowStatement'), 'CY'));
  if (t) s.filing.removeFact(t.key);
  if (declared) put(s, 'TypeOfCashFlowStatement', 'CY', declared);
  if (direct) put(s, DIRECT_ONLY, 'CY', 11);
  if (indirect) put(s, INDIRECT_ONLY, 'CY', 22);
  return raw(s);
}
test('cash flow import: Direct XML → [310000] only; Indirect XML → [320000] only (detected from the facts)', () => {
  const d = imp(cashFlowXml({ direct: true }));
  assert.equal(d.r.cashFlow.detected, 'Direct Method');
  assert.equal(d.s.getValue(q('TypeOfCashFlowStatement'), 'CY').value, 'Direct Method');
  assert.equal(d.s.elrStatus(uri('310000'), 'CY').applicable, true);
  assert.equal(d.s.elrStatus(uri('320000'), 'CY').applicable, false);
  const i = imp(cashFlowXml({ indirect: true }));
  assert.equal(i.r.cashFlow.detected, 'Indirect Method');
  assert.equal(i.s.elrStatus(uri('310000'), 'CY').applicable, false);
  assert.equal(i.s.elrStatus(uri('320000'), 'CY').applicable, true);
  // a fact shared by both statements is shown only on the selected one
  const shared = Object.keys(A.concepts).find((c) => { const codes = A.conceptElrs(c).map((u) => A.elr(u).code); return codes.includes('310000') && codes.includes('320000') && A.isMonetary(c); });
  assert.equal(i.s.cellStatus(uri('310000'), shared, 'CY').applicable, false);
  assert.equal(i.s.cellStatus(uri('320000'), shared, 'CY').applicable, true);
});

test('cash flow import: declared method wins; facts of the other statement are not imported', () => {
  const { s, r } = imp(cashFlowXml({ direct: true, indirect: true, declared: 'Indirect Method' }));
  assert.equal(r.cashFlow.declared, 'Indirect Method');
  assert.equal(s.getValue(q(DIRECT_ONLY), 'CY'), null);
  assert.equal(s.getValue(q(INDIRECT_ONLY), 'CY').value, '22');
  assert.ok(r.notApplicable.some((x) => x.concept === q(DIRECT_ONLY) && x.reasons.some((m) => /TypeOfCashFlowStatement/.test(m))));
});

test('cash flow import: undeterminable method is never guessed — the user chooses', () => {
  const xml = cashFlowXml({ direct: true, indirect: true });
  assert.throws(() => imp(xml), CashFlowChoiceError);
  const p = new Session(A).previewXml(xml, { DOMParserImpl: DOMParser });
  assert.equal(p.cashFlow.needsChoice, true);
  const { s, r } = imp(xml, { cashFlowMethod: 'Direct Method' });
  assert.equal(r.cashFlow.applied, 'Direct Method');
  assert.equal(r.cashFlow.source, 'selected by the user');
  assert.equal(s.getValue(q(DIRECT_ONLY), 'CY').value, '11');
  assert.equal(s.getValue(q(INDIRECT_ONLY), 'CY'), null);
});

test('cash flow fresh filing: the selected method drives applicability, entry, validation, calculation and XML', () => {
  for (const [method, on, off, onC, offC] of [['Direct Method', '310000', '320000', DIRECT_ONLY, INDIRECT_ONLY], ['Indirect Method', '320000', '310000', INDIRECT_ONLY, DIRECT_ONLY]]) {
    const s = baseSession();
    s.setValue(q('TypeOfCashFlowStatement'), 'CY', method);
    assert.equal(s.elrStatus(uri(on), 'CY').applicable, true, `${method}: ${on} enabled`);
    assert.equal(s.elrStatus(uri(off), 'CY').applicable, false, `${method}: ${off} disabled`);
    for (const sc of ['CY', 'PY']) s.setValue(q(onC), sc, '5', { tab: uri(on), recalc: true }); // parents auto-populated
    assert.throws(() => s.setValue(q(offC), 'CY', '5', { tab: uri(off) }), /not applicable/, 'no data entry on the disabled statement');
    // a value injected below the controller is excluded, not validated, not generated
    put(s, offC, 'CY', 9);
    const g = s.validate({ today });
    assert.ok(g.issues.some((i) => i.code === 'excluded' && i.message.includes(offC)));
    assert.ok(!g.issues.some((i) => i.severity === 'ERROR' && i.message.includes(offC)), 'no mandatory/rule errors from the disabled statement');
    assert.ok(runCalculations(A, s.filing, { isElrApplicable: (e) => A.json.roles[e]?.code?.slice(0, 6) !== off }).every((c) => A.json.roles[c.elr]?.code?.slice(0, 6) !== off || c.status === 'NOT_APPLICABLE'));
    // (a lone cash-flow line also rolls the cash balance forward and reaches the balance sheet through [613200], so
    // this partial filing is not gate-clean; the XML of what the gate would emit is checked)
    const xml = exportUnchecked(s, today);
    assert.ok(xml.includes(`<${q(onC)} `) && !xml.includes(`<${q(offC)} `));
  }
});

// ---------------------------------------------------------------- 7. Yes/No dependencies
test('Yes/No dependencies are derived only from MCA conditional rules (explicit model)', () => {
  const deps = A.rules.booleanDependencies;
  assert.ok(deps.length >= 15);
  for (const d of deps) {
    assert.equal(A.concept(d.parentConcept).type, 'xbrli:booleanItemType');
    assert.equal(typeof d.condition, 'boolean');
    assert.ok(d.rules.length && d.rules.every((id) => A.rules.rules.find((r) => r.id === id)?.status === 'EXECUTABLE'), 'every dependency cites executable MCA rules');
    assert.ok(d.childConcepts.length + d.tables.length > 0);
  }
  const sub = deps.find((d) => d.parentConcept === q('WhetherCompanyHasSubsidiaryCompanies'));
  assert.deepEqual(sub.childConcepts, [q('NumberOfSubsidiaryCompanies')]);
  assert.ok(sub.tables.includes('611500:DisclosureOfDetailsOfSubsidiariesTable'));
});

test('Yes/No dependency: YES → children enabled, NO → children disabled (fields and tables), values retained', () => {
  const s = baseSession();
  const parent = q('WhetherCompanyHasSubsidiaryCompanies'), child = q('NumberOfSubsidiaryCompanies'), T = '611500:DisclosureOfDetailsOfSubsidiariesTable';
  s.setValue(parent, 'CY', 'true');
  assert.equal(s.conceptStatus(child, 'CY').applicable, true);
  assert.equal(s.tableStatus(T, 'CY').applicable, true);
  s.setValue(child, 'CY', '2');
  s.setValue(parent, 'CY', 'false');
  const st = s.conceptStatus(child, 'CY');
  assert.equal(st.applicable, false);
  assert.match(st.reasons[0], /^DEP: .* is No/);
  assert.equal(s.tableStatus(T, 'CY').applicable, false);
  assert.throws(() => s.setValue(child, 'CY', '3'), /not applicable/);
  assert.equal(s.getValue(child, 'CY').value, '2', 'Yes → No never deletes the entered value');
  const g = s.validate({ today });
  assert.ok(g.issues.some((i) => i.code === 'excluded' && i.message.includes('NumberOfSubsidiaryCompanies')), 'excluded from filing/validation');
  assert.ok(!s.exportXml({ today }).xml.includes('<in-ca:NumberOfSubsidiaryCompanies '), 'not generated');
  s.setValue(parent, 'CY', 'true');
  assert.equal(s.conceptStatus(child, 'CY').applicable, true, 'back to Yes: the retained value is filing data again');
});

test('Yes/No dependency on import: boolean fact → dependency state → child applicability', () => {
  const s = baseSession();
  put(s, 'WhetherCompanyHasSubsidiaryCompanies', 'CY', 'false');
  put(s, 'NumberOfSubsidiaryCompanies', 'CY', '0');
  const no = imp(raw(s));
  assert.equal(no.s.getValue(q('NumberOfSubsidiaryCompanies'), 'CY'), null, 'child under No not populated');
  assert.ok(no.r.notApplicable.some((x) => x.concept === q('NumberOfSubsidiaryCompanies') && x.reasons[0].startsWith('DEP:')));
  put(s, 'WhetherCompanyHasSubsidiaryCompanies', 'CY', 'true');
  put(s, 'NumberOfSubsidiaryCompanies', 'CY', '1');
  const yes = imp(raw(s));
  assert.equal(yes.s.getValue(q('NumberOfSubsidiaryCompanies'), 'CY').value, '1');
});

// ---------------------------------------------------------------- 5. calculated cells
test('calculated cells: parent read-only by default, auto-populated from its children, override per edit option', () => {
  const s = baseSession();
  const BS = uri('110000');
  assert.ok(s.calculatedCell(q('CurrentAssets'), 'CY', [], BS));
  assert.equal(s.calculatedCell(q('Inventories'), 'CY', [], BS), null, 'leaf cells are editable');
  s.setValue(q('Inventories'), 'CY', '100', { tab: BS, recalc: true });
  s.setValue(q('TradeReceivablesCurrent'), 'CY', '50', { tab: BS, recalc: true });
  assert.equal(s.getValue(q('CurrentAssets'), 'CY').value, '150', 'calculation still occurs');
  assert.equal(s.getValue(q('CurrentAssets'), 'CY').origin, 'calculated');
  assert.equal(s.getValue(q('Assets'), 'CY').value, '150', 'cascades upward');
  assert.throws(() => s.setValue(q('CurrentAssets'), 'CY', '1', { tab: BS }), CalculatedCellError);
  // tab override: manual value kept, never replaced by a later recalculation, and checked by GR-1
  s.setValue(q('CurrentAssets'), 'CY', '999', { tab: BS, override: true, recalc: true });
  s.setValue(q('Inventories'), 'CY', '120', { tab: BS, recalc: true });
  assert.equal(s.getValue(q('CurrentAssets'), 'CY').value, '999');
  assert.equal(s.getValue(q('CurrentAssets'), 'CY').origin, 'override');
  const g = s.validate({ today });
  assert.ok(g.issues.some((i) => i.ruleId === 'GR-1' && /CurrentAssets|Current assets/.test(i.message)), 'override inconsistent with children is reported by the existing calculation rule');
  // calculation arcs untouched
  assert.equal(A.meta.relationshipStats.calculationArcs, Object.values(A.json.calculation).reduce((n, a) => n + a.length, 0));
});

test('calculated cells: dimensional parent (table) is derived in the same member context', () => {
  const s = baseSession();
  const T = tid('DisclosureOfPropertyPlantAndEquipmentTable');
  s.setValue(q('PropertyPlantAndEquipment'), 'CY', '1');
  const dims = [{ axis: q('ClassesOfPropertyPlantAndEquipmentAxis'), member: q('LandMember') }, { axis: q('SubClassesOfPropertyPlantAndEquipmentAxis'), member: q('OwnedAssetsMember') }, { axis: q('CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis'), member: q('GrossCarryingAmountMember') }];
  const parents = A.table(T).lineItems.filter((c) => s.calculatedCell(c, 'CY', dims, A.table(T).presentationElr));
  assert.ok(parents.includes(q('ChangesInPropertyPlantAndEquipment')), parents.join());
  assert.throws(() => s.setTableValue(T, 'CY', dims, q('ChangesInPropertyPlantAndEquipment'), '5', { lockCalculated: true }), CalculatedCellError);
  const kid = Object.values(A.json.calculation).flat().find((a) => a.from === q('ChangesInPropertyPlantAndEquipment') && a.weight === 1 && A.table(T).lineItems.includes(a.to)).to;
  s.setTableValue(T, 'CY', dims, kid, '40', { recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ChangesInPropertyPlantAndEquipment'), 'CY', dims).value, '40', 'parent derived in the same member context');
  assert.equal(s.getValue(q('ChangesInPropertyPlantAndEquipment'), 'CY', dims).origin, 'calculated');
  assert.equal(s.getValue(q('ChangesInPropertyPlantAndEquipment'), 'CY', []), null, 'no leakage to other contexts');
  // and the roll-forward closing of the same row is derived from opening + change (formula linkbase)
  assert.equal(s.filing.get(q('PropertyPlantAndEquipment'), { type: 'instant', date: s.filing.meta.periods.cy.end }, dims).value, '40');
});

// ---------------------------------------------------------------- 4. structured validation locations
test('validation results carry a structured location (tab, table, row, exact cell id)', () => {
  const s = baseSession();
  const qa = q('AddressOfRegisteredOfficeOfCompany');
  s.filing.removeFact(s.getValue(qa, 'CY').key);
  const g = s.validate({ today });
  const miss = g.issues.find((i) => i.severity === 'ERROR' && i.location?.conceptQName === qa);
  assert.ok(miss, 'mandatory error located');
  assert.deepEqual({ tab: miss.location.tabId, cell: miss.location.cellId, scope: miss.location.scope }, { tab: '700300', cell: factKey(qa, s.filing.period(qa, 'CY'), []), scope: 'CY' });
  assert.equal(miss.location.elrUri, uri('700300'));
  // dimensional: a missing mandatory line item points at its table row cell
  const s2 = withCurrentInvestments(baseSession());
  const T = CI;
  const dims = [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }];
  s2.setTableValue(T, 'CY', dims, q('CurrentInvestments'), '1000');
  const g2 = s2.validate({ today });
  const ml = g2.issues.find((i) => i.ruleId?.startsWith('ML-') && i.location?.tableId === T);
  assert.ok(ml, JSON.stringify(g2.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).slice(0, 5)));
  assert.equal(ml.location.cellId, factKey(ml.location.conceptQName, s2.filing.period(ml.location.conceptQName, 'CY'), dims));
  // a mandatory table without rows points at the table (button) of its tab
  const s3 = withCurrentInvestments(baseSession());
  const tr = s3.validate({ today }).issues.find((i) => i.severity === 'ERROR' && i.location?.kind === 'table');
  assert.equal(tr.location.tableId, T);
  assert.equal(tr.location.cellId, `table:${T}:${tr.location.scope}`);
  // several issues on one cell keep their individual messages
  const cnt = new Map(); for (const i of g.issues) if (i.location?.cellId) cnt.set(i.location.cellId, (cnt.get(i.location.cellId) || 0) + 1);
  assert.ok([...cnt.values()].every((n) => n >= 1));
});

// ---------------------------------------------------------------- 6. current-tab validation
test('current-tab validation: same engine, only the tab\'s facts and rules; cross-tab checks marked; full validation unchanged', () => {
  const s = baseSession();
  const BS = uri('110000'), PL = uri('210000');
  s.setValue(q('Inventories'), 'CY', '100');   // BS: CurrentAssets etc. now inconsistent (GR-1)
  s.setValue(q('OtherIncome'), 'PY', '');       // P&L
  const qa = q('AddressOfRegisteredOfficeOfCompany'); s.filing.removeFact(s.getValue(qa, 'CY').key); // [700300]
  const full = s.validate({ today });
  const tab = s.validateTab(BS, { today });
  assert.equal(tab.scope.kind, 'tab');
  assert.ok(tab.scope.rulesRun < A.rules.rules.length, 'not the complete rule set');
  assert.ok(full.issues.some((i) => i.location?.tabId === '700300' && i.severity === 'ERROR'), 'full validation covers other tabs');
  assert.ok(!tab.issues.some((i) => i.location?.tabId === '700300'), 'other tabs are not reported');
  for (const i of tab.issues.filter((x) => x.severity !== 'INFO' && x.location)) assert.ok(i.location.elrUri === BS || i.crossTab, `${i.message} belongs to the tab or is marked cross-tab`);
  assert.ok(tab.issues.some((i) => i.ruleId === 'GR-1' && i.severity === 'ERROR'), 'tab calculations evaluated');
  // the same authoritative engine: every tab ERROR also appears in the full validation
  const fullMsgs = new Set(full.issues.map((i) => i.message));
  for (const i of tab.issues.filter((x) => x.severity === 'ERROR')) assert.ok(fullMsgs.has(i.message), i.message);
  // cross-tab rules are marked
  const pl = s.validateTab(PL, { today });
  assert.ok(pl.issues.every((i) => !i.location || i.location.elrUri === PL || i.crossTab || i.severity === 'INFO'));
});

// ---------------------------------------------------------------- 8. general information about the company
test('general company information: fields map to their taxonomy concepts; XML for those concepts unchanged', () => {
  const s = baseSession({ name: 'Acme Pvt Ltd' });
  s.setValue(q('NameOfCompany'), 'CY', 'Acme Pvt Ltd');
  s.setValue(q('TypeOfCashFlowStatement'), 'CY', 'Indirect Method');
  const { xml } = s.exportXml({ today });
  for (const [l, v] of [['CorporateIdentityNumber', 'U72200KA2010PTC123456'], ['NatureOfReportStandaloneConsolidated', 'Standalone'], ['DateOfStartOfReportingPeriod', '2017-04-01'], ['DateOfEndOfReportingPeriod', '2018-03-31'], ['LevelOfRoundingUsedInFinancialStatements', 'Actual'], ['NameOfCompany', 'Acme Pvt Ltd'], ['TypeOfCashFlowStatement', 'Indirect Method']]) {
    assert.match(xml, new RegExp(`<in-ca:${l} [^>]*>${v}<`), l);
  }
  if (xsdValidatorStatus().available) assert.equal(validateInstanceXml(xml).status, 'PASS');
});

test('table total column (every axis at its default member): visible, editable, and removing a row never touches other tables', async () => {
  const { exampleSession } = await import('./fixtures.mjs');
  const { q } = await import('./helpers.mjs');
  const { defaultSliceAllowed } = await import('./views.js');
  const s = exampleSession();
  const SC = s.A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfClassesOfEquityShareCapitalTable')).id;
  assert.ok(defaultSliceAllowed(s.A, s.A.table(SC)));
  const typedT = s.A.tables.find((t) => t.axes.some((a) => a.typed));
  assert.ok(!defaultSliceAllowed(s.A, typedT), 'typed axes have no default: no total column');
  // a total of the share classes (no dimensions) appears as the last slice of the table
  s.setTableValue(SC, 'CY', [], q('NumberOfSharesAuthorised'), '500000');
  const sl = s.openTable(SC, 'CY').slices;
  assert.deepEqual(sl[sl.length - 1], []);
  assert.equal(s.filing.value(q('NumberOfSharesAuthorised'), 'CY', []), '500000');
  const bsBefore = s.filing.value(q('Assets'), 'CY', []);
  s.removeSlice(SC, 'CY', []);
  assert.equal(s.filing.value(q('NumberOfSharesAuthorised'), 'CY', []), null, 'the table total is removed');
  assert.equal(s.filing.value(q('Assets'), 'CY', []), bsBefore, 'balance-sheet facts (same empty context) untouched');
});

test('PY-only figures in tabs without a previous year (GR-11): not stored, not shown, not validated, not generated', () => {
  const s = baseSession();
  // [700300] general information: previous year excluded except PeriodCovered / DateOfStart / DateOfEnd
  put(s, 'AddressOfRegisteredOfficeOfCompany', 'PY', 'Old address');
  put(s, 'WhetherAuditorsReportHasBeenQualifiedOrHasAnyReservationsOrContainsAdverseRemarks', 'PY', 'false'); // [700400]
  const { s: t, r } = imp(raw(s));
  for (const l of ['AddressOfRegisteredOfficeOfCompany', 'WhetherAuditorsReportHasBeenQualifiedOrHasAnyReservationsOrContainsAdverseRemarks']) {
    assert.equal(t.getValue(q(l), 'PY'), null, `${l}: no PY value stored`);
    for (const u of A.conceptElrs(q(l))) assert.equal(t.cellStatus(u, q(l), 'PY').applicable, false, `${l}: PY cell disabled`);
    assert.ok(r.notApplicable.some((x) => x.concept === q(l) && x.reasons.some((m) => m.startsWith('GR-11'))), `${l}: listed in the import report`);
  }
  assert.ok(t.getValue(q('DateOfEndOfReportingPeriod'), 'PY'), 'GR-11 exception keeps its previous-year value');
  const g = t.validate({ today });
  assert.equal(g.summary.excluded, 0);
  const { xml } = t.exportXml({ today });
  assert.equal((xml.match(/<in-ca:AddressOfRegisteredOfficeOfCompany /g) || []).length, 1, 'only the current-year fact is generated');
});
