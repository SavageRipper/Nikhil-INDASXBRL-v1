// Suites: conditional table applicability (CY and PY separately), Yes/No-driven tables and fields (incl. several
// questions for one field), report-type and previous-year ELR exclusions (GR-10..GR-13), cash flow direct / indirect,
// first-time adoption (opening balance sheet of the previous year).
import test from 'node:test';
import assert from 'node:assert/strict';
import { q, authority } from './helpers.mjs';
import { baseSession, exampleSession, consolidatedSession, T, runRule, TODAY } from './fixtures.mjs';
import { ApplicabilityError } from './session.js';
import { Gate } from './gate.js';
import { addDays } from './periods.js';

const A = authority();
const CI = T('DetailsOfCurrentInvestmentsTable');
const CIAX = q('ClassificationOfCurrentInvestmentsAxis');
const ciRule = A.rules.tableApplicability[CI][0].rule;

for (const scope of ['CY', 'PY']) {
  test(`[400500] current investments — none (${scope}): table closed, cannot be opened or written, injected facts never emitted`, () => {
    const s = baseSession(); // CurrentInvestments = 0
    const st = s.tableStatus(CI, scope);
    assert.equal(st.applicable, false); assert.equal(st.conditional, true);
    assert.match(st.reasons[0], new RegExp(ciRule));
    assert.throws(() => s.openTable(CI, scope), ApplicabilityError);
    assert.throws(() => s.setTableValue(CI, scope, [{ axis: CIAX, typed: '1' }], q('CurrentInvestments'), '10'), ApplicabilityError);
    s.filing.setFact({ concept: q('CurrentInvestments'), period: s.filing.period(q('CurrentInvestments'), scope), dims: [{ axis: CIAX, typed: '1' }], value: '10' });
    const gate = new Gate(A).run(s.filing, { today: TODAY });
    assert.ok(gate.issues.some((i) => i.code === 'excluded'));
    assert.equal(gate.ok, true, gate.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).join('\n'));
    assert.ok(!/ClassificationOfCurrentInvestmentsAxis/.test(s.exportXml({ today: TODAY }).xml));
  });

  test(`[400500] current investments > 0 (${scope}): table opens, is required, rows carry the typed dimension`, () => {
    const s = baseSession();
    s.setValue(q('CurrentInvestments'), scope, '1000', { recalc: true });
    const st = s.tableStatus(CI, scope);
    assert.equal(st.applicable, true); assert.equal(st.mandatory, true);
    const { view, slices } = s.openTable(CI, scope);
    assert.equal(slices.length, 0);
    assert.equal(view.axes.length, 1); assert.equal(view.axes[0].typed, true);
    assert.ok(runRule(s, ciRule, { scope }).fail, 'required table without rows');
    s.setTableValue(CI, scope, [{ axis: CIAX, typed: '1' }], q('CurrentInvestments'), '1000');
    assert.ok(runRule(s, ciRule, { scope }).pass);
    const other = scope === 'CY' ? 'PY' : 'CY';
    assert.equal(s.tableStatus(CI, other).applicable, false, 'the other year is evaluated on its own fact');
  });
}

test('Yes/No-driven table: shareholders > 5% table follows its question per year', () => {
  const SH = T('DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable');
  const s = baseSession();
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'No');
  assert.equal(s.tableStatus(SH, 'CY').applicable, false);
  assert.throws(() => s.openTable(SH, 'CY'), ApplicabilityError);
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'Yes');
  assert.equal(s.tableStatus(SH, 'CY').applicable, true);
  s.openTable(SH, 'CY');
});

test('Yes/No-driven fields: a field required by two questions is open when either is Yes (OCI net of tax / before tax)', () => {
  const s = exampleSession();
  const oci = q('OtherComprehensiveIncome');
  const net = q('WhetherCompanyHasOtherComprehensiveIncomeOCIComponentsPresentedNetOfTax'), before = q('WhetherCompanyHasComprehensiveIncomeOCIComponentsPresentedBeforeTax');
  s.setValue(net, 'CY', 'false'); s.setValue(before, 'CY', 'false');
  assert.equal(s.conceptStatus(oci, 'CY').applicable, false);
  assert.ok(s.conceptStatus(oci, 'CY').reasons.every((r) => r.startsWith('DEP:')));
  s.setValue(before, 'CY', 'true');
  assert.equal(s.conceptStatus(oci, 'CY').applicable, true, 'one Yes is enough');
  s.setValue(before, 'CY', 'false'); s.setValue(net, 'CY', 'true');
  assert.equal(s.conceptStatus(oci, 'CY').applicable, true);
  const d = s.dependencies().filter((x) => x.childConcepts.includes(oci));
  assert.equal(d.length, 2);
});

test('GR-10 / GR-13: consolidated vs standalone ELR exclusions; GR-12: general information in a consolidated instance', () => {
  const st = baseSession();
  const cons = consolidatedSession();
  const elr = (code) => A.elrByCode(code).uri;
  assert.equal(st.elrStatus(elr('613400'), 'CY').applicable, false, 'consolidated note not for standalone');
  assert.equal(cons.elrStatus(elr('613400'), 'CY').applicable, true);
  for (const code of ['700400', '700500', '700600', '700700', '700100'].filter((c) => A.elrByCode(c))) {
    const not = A.rules.rules.find((r) => r.id === 'GR-10').ast.codes.includes(code);
    assert.equal(cons.elrStatus(elr(code), 'CY').applicable, !not, `[${code}] consolidated`);
  }
  assert.equal(cons.conceptStatus(q('NameOfCompany'), 'CY').applicable, true);
  assert.equal(cons.conceptStatus(q('WhetherCompanyIsListedCompany'), 'CY').applicable, false);
});

test('GR-11: previous-year exclusions with element exceptions', () => {
  const s = baseSession();
  assert.equal(s.conceptStatus(q('DateOfBoardMeetingWhenFinalAccountsWereApproved'), 'PY').applicable, false);
  assert.equal(s.conceptStatus(q('DateOfStartOfReportingPeriod'), 'PY').applicable, true);
  assert.equal(s.conceptStatus(q('PeriodCoveredByFinancialStatements'), 'PY').applicable, true);
  assert.throws(() => s.setValue(q('DateOfBoardMeetingWhenFinalAccountsWereApproved'), 'PY', '2017-05-30'), ApplicabilityError);
  // Directors report: share-holding elements stay available for the previous year
  const ex = A.rules.rules.find((r) => r.id === 'GR-11').ast.exceptions['700600'];
  assert.ok(ex.includes('NumberOfSharesHeld'));
});

test('cash flow: TypeOfCashFlowStatement selects [310000] direct or [320000] indirect; only applicable facts are generated', () => {
  for (const [type, on, off] of [['Indirect Method', '320000', '310000'], ['Direct Method', '310000', '320000']]) {
    const s = baseSession();
    s.setValue(q('TypeOfCashFlowStatement'), 'CY', type);
    assert.equal(s.elrStatus(A.elrByCode(on).uri, 'CY').applicable, true);
    assert.equal(s.elrStatus(A.elrByCode(off).uri, 'CY').applicable, false);
    const otherOnly = Object.keys(A.concepts).find((c) => A.isReportable(c) && A.isMonetary(c) && A.conceptElrs(c).length === 1 && A.elr(A.conceptElrs(c)[0]).code === off);
    assert.ok(otherOnly);
    assert.equal(s.conceptStatus(otherOnly, 'CY').applicable, false);
    s.filing.setFact({ concept: otherOnly, period: s.filing.period(otherOnly, 'CY'), value: '5' });
    const g = s.validate({ today: TODAY });
    assert.ok(g.issues.some((i) => i.code === 'excluded'));
  }
});

test('first-time adoption: opening balance sheet of the previous year only under FTA = Yes; roll-forward openings always', () => {
  const s = exampleSession();
  const pyo = addDays(s.filing.meta.periods.py.start, -1);
  assert.equal(s.conceptStatus(q('TradeReceivablesCurrent'), 'PYO').applicable, false, 'no FTA → no opening balance sheet');
  assert.match(s.conceptStatus(q('TradeReceivablesCurrent'), 'PYO').reasons[0], /GR-16/);
  assert.equal(s.conceptStatus(q('CashAndCashEquivalentsCashFlowStatement'), 'PYO').applicable, true, 'cash-flow opening (periodStart row) is always available');
  assert.throws(() => s.setValue(q('TradeReceivablesCurrent'), 'PYO', '1'), ApplicabilityError);
  s.filing.setFact({ concept: q('TradeReceivablesCurrent'), period: { type: 'instant', date: pyo }, value: '1' });
  assert.ok(s.validate({ today: TODAY }).issues.some((i) => i.code === 'excluded' && /GR-16/.test(i.message)));
  s.setValue(q('WhetherCompanyHasAdoptedIndAsFirstTime'), 'CY', 'true');
  assert.equal(s.conceptStatus(q('TradeReceivablesCurrent'), 'PYO').applicable, true);
  const f = s.setValue(q('TradeReceivablesCurrent'), 'PYO', '250000', { recalc: true });
  assert.equal(f.period.date, pyo);
  assert.equal(s.getValue(q('CurrentFinancialAssets'), 'PYO').value, '250000', 'totals auto-calculated in the opening column');
  assert.equal(s.getValue(q('Assets'), 'PYO').value, '250000');
  assert.equal(s.getValue(q('CurrentFinancialAssets'), 'PYO').origin, 'calculated');
});
