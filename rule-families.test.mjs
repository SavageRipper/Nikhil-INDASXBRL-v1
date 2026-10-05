// Suite: hand-written PASS / FAIL evidence for every rule family the automatic audit (rule-audit.mjs) cannot build a
// witness for: curated cross-table checks, generic rules (GR-*), Filing Manual Annexure II checks (FM-*), and engine
// semantics (no PASS without evaluation, approved limitations, divergence warnings).
// Each test names the rule ids it covers; rule-audit.test.mjs fails if a rule without an automatic witness is not
// named here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q } from './helpers.mjs';
import { exampleSession, baseSession, consolidatedSession, cloneSession, T, runRule, set, TODAY } from './fixtures.mjs';
import { RuleEngine } from './rules.js';
import { addDays } from './periods.js';

const A = authority();
const ex = () => exampleSession();
const m = (axis, member) => ({ axis: q(axis), member: q(member) });
const typed = (axis, v) => ({ axis: q(axis), typed: v });
const both = (s, id, scope = null) => runRule(s, id, { scope });

// ------------------------------------------------------------------------------------------------ curated rules
test('SR-L43-2 equity share capital ≤ Σ value of shares subscribed (first-level classes)', () => {
  const s = ex();
  assert.ok(both(s, 'SR-L43-2', 'CY').pass && !both(s, 'SR-L43-2', 'CY').fail);
  s.setValue(q('EquityShareCapital'), 'CY', '1100000');
  assert.ok(both(s, 'SR-L43-2', 'CY').fail);
});

test('SR-L662-1 Σ shares held by >5% shareholders ≤ shares paid up; SR-L663-1 Σ percentages per class ≤ 100%', () => {
  const s = ex();
  set(s, 'WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany', 'true');
  const SH = T('DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable');
  const d = (n) => [m('ClassesOfEquityShareCapitalAxis', 'EquityShares1Member'), m('NameOfShareholderAxis', `Shareholder${n}Member`)];
  const put = (n, l, v) => s.setTableValue(SH, 'CY', d(n), q(l), v);
  put(1, 'NumberOfSharesHeldInCompany', '60000'); put(2, 'NumberOfSharesHeldInCompany', '30000');
  put(1, 'PercentageOfShareholdingInCompany', '0.65'); put(2, 'PercentageOfShareholdingInCompany', '0.30');
  assert.ok(both(s, 'SR-L662-1', 'CY').pass && !both(s, 'SR-L662-1', 'CY').fail);
  assert.ok(both(s, 'SR-L663-1', 'CY').pass && !both(s, 'SR-L663-1', 'CY').fail);
  put(2, 'NumberOfSharesHeldInCompany', '50000'); // 110000 > 100000 paid up
  put(2, 'PercentageOfShareholdingInCompany', '0.45'); // 110 % (beyond the ±½-unit rounding tolerance of the entered decimals)
  assert.ok(both(s, 'SR-L662-1', 'CY').fail);
  assert.ok(both(s, 'SR-L663-1', 'CY').fail);
});

test('SR-L677-2 public issue amount > 0 requires "money raised by public offering" = Yes', () => {
  const s = ex();
  s.setValue(q('AmountOfPublicIssueDuringPeriod'), 'CY', '500000');
  s.setValue(q('WhetherMoneyRaisedFromPublicOfferingDuringYear'), 'CY', 'false');
  assert.ok(both(s, 'SR-L677-2', 'CY').fail);
  s.setValue(q('WhetherMoneyRaisedFromPublicOfferingDuringYear'), 'CY', 'true');
  assert.ok(both(s, 'SR-L677-2', 'CY').pass);
});

test('SR-L802-1 SOCE closing other equity (parent holders) = balance sheet other equity', () => {
  const s = ex();
  assert.ok(both(s, 'SR-L802-1', 'CY').pass && !both(s, 'SR-L802-1', 'CY').fail, JSON.stringify(both(s, 'SR-L802-1', 'CY').res));
  s.setValue(q('OtherEquity'), 'CY', '1000001');
  assert.ok(both(s, 'SR-L802-1', 'CY').fail);
});

test('SR-L892-1 Bonds/Debentures details table ⇔ Bonds/Debentures borrowings', () => {
  const s = ex();
  const BT = T('ClassificationOfBorrowingsTable');
  s.setValue(q('BorrowingsNoncurrent'), 'CY', '500000');
  s.setTableValue(BT, 'CY', [m('ClassificationBasedOnCurrentNoncurrentAxis', 'NoncurrentMember'), m('ClassificationOfBorrowingsAxis', 'BondsMember'), m('SubclassificationOfBorrowingsAxis', 'SecuredBorrowingsMember')], q('Borrowings'), '500000');
  assert.ok(both(s, 'SR-L892-1', 'CY').fail, 'bonds borrowings without the details table');
  s.setTableValue(T('DetailsOfBondsOrDebenturesTable'), 'CY', [typed('DetailsOfBondsOrDebenturesAxis', '1')], q('NatureOfBondOrDebenture'), A.enumerations(q('NatureOfBondOrDebenture'))[2]);
  assert.ok(both(s, 'SR-L892-1', 'CY').pass && !both(s, 'SR-L892-1', 'CY').fail);
});

test('SR-L1488-1 / SR-L1566-1 / SR-L1720-2 loans, advances and provisions tables agree with the balance sheet', () => {
  const cases = [
    ['SR-L1488-1', 'DetailsOfLoansTable', 'Loans', 'ClassificationOfLoansAxis', 'SecurityDepositsMember', 'LoansNoncurrent', 'LoansCurrent'],
    ['SR-L1566-1', 'DetailsOfAdvancesTable', 'Advances', 'ClassificationOfAdvancesAxis', 'CapitalAdvancesMember', 'NoncurrentAdvances', 'CurrentAdvances'],
    ['SR-L1720-2', 'DisclosureOfBreakupOfProvisionsTable', 'Provisions', null, null, 'ProvisionsNoncurrent', 'ProvisionsCurrent'],
  ];
  for (const [id, tname, item, axis, member, nc, cur] of cases) {
    const s = ex();
    s.setValue(q(nc), 'CY', '500'); s.setValue(q(cur), 'CY', '300');
    const t = T(tname);
    const d = (cm) => [m('ClassificationBasedOnCurrentNoncurrentAxis', cm), ...(axis ? [m(axis, member)] : [])];
    s.setTableValue(t, 'CY', d('NoncurrentMember'), q(item), '500');
    s.setTableValue(t, 'CY', d('CurrentMember'), q(item), '300');
    const r = both(s, id, 'CY');
    assert.ok(r.pass && !r.fail, `${id} PASS ${JSON.stringify(r.res)}`);
    s.setValue(q(cur), 'CY', '301');
    assert.ok(both(s, id, 'CY').fail, `${id} FAIL`);
  }
});

test('SR-L3010-1 subsidiary company = Yes ⇔ a holding / ultimate holding company related party', () => {
  const s = ex();
  s.setValue(q('WhetherCompanyIsSubsidiaryCompany'), 'CY', 'false');
  assert.ok(both(s, 'SR-L3010-1', 'CY').pass, 'No + no holding company');
  s.setValue(q('WhetherCompanyIsSubsidiaryCompany'), 'CY', 'true');
  assert.ok(both(s, 'SR-L3010-1', 'CY').fail, 'Yes but no holding company');
  const RP = T('DisclosureOfTransactionsBetweenRelatedPartiesTable', '610800:');
  s.filing.setFact({ concept: q('DescriptionOfNatureOfRelatedPartyRelationship'), period: s.filing.period(q('DescriptionOfNatureOfRelatedPartyRelationship'), 'CY'), dims: [m('CategoriesOfRelatedPartiesAxis', 'ParentMember'), typed('RelatedPartyAxis', '1')], value: 'Holding company', lang: 'en' });
  assert.ok(A.table(RP));
  assert.ok(both(s, 'SR-L3010-1', 'CY').pass && !both(s, 'SR-L3010-1', 'CY').fail);
});

test('SR-L4674-3 subsidiary details only when "company has subsidiary companies" = Yes', () => {
  const s = ex();
  s.setValue(q('WhetherCompanyHasSubsidiaryCompanies'), 'CY', 'true');
  s.setTableValue(T('DisclosureOfDetailsOfSubsidiariesTable', '611500:'), 'CY', [typed('SignificantInvestmentsInSubsidiariesAxis', '1')], q('NameOfSubsidiary'), 'Sub One Pvt Ltd');
  assert.ok(both(s, 'SR-L4674-3', 'CY').pass);
  s.setValue(q('WhetherCompanyHasSubsidiaryCompanies'), 'CY', 'false'); // rows kept (as from an imported XML)
  assert.ok(both(s, 'SR-L4674-3', 'CY').fail);
});

test('SR-L6310-1 CSR applicable ⇒ net profit of financial year 1; SR-L6327-1 average net profit = average of the three years', () => {
  const s = ex();
  s.setValue(q('WhetherProvisionsOfCorporateSocialResponsibilityAreApplicableOnCompany'), 'CY', 'true');
  assert.ok(both(s, 'SR-L6310-1', 'CY').fail, 'no year-1 member');
  const NP = T('DisclosureOfNetProfitsForLastThreeFinancialYearsTable');
  const np = q('NetProfitComputedUnderSection198AndAdjustedAsPerRule21FOfCompaniesCSRPolicyRules2014');
  [['FinancialYearMember1', '300'], ['FinancialYearMember2', '600'], ['FinancialYearMember3', '900']].forEach(([fy, v]) => s.setTableValue(NP, 'CY', [m('NetProfitsForLastThreeFinancialYearsAxis', fy)], np, v));
  assert.ok(both(s, 'SR-L6310-1', 'CY').pass);
  s.setValue(q('AverageNetProfitForLastThreeFinancialYears'), 'CY', '600');
  assert.ok(both(s, 'SR-L6327-1', 'CY').pass && !both(s, 'SR-L6327-1', 'CY').fail);
  s.setValue(q('AverageNetProfitForLastThreeFinancialYears'), 'CY', '601');
  assert.ok(both(s, 'SR-L6327-1', 'CY').fail);
});

test('SR-L6394-1 cash-flow method: facts of the other method\'s statement are rejected', () => {
  const s = ex(); // indirect method
  assert.ok(both(s, 'SR-L6394-1').pass);
  const directOnly = Object.keys(A.concepts).find((c) => A.isMonetary(c) && A.concept(c).periodType === 'duration' && A.conceptElrs(c).length && A.conceptElrs(c).every((u) => A.elr(u).code === '310000'));
  s.filing.setFact({ concept: directOnly, period: s.filing.period(directOnly, 'CY'), value: '100' }); // as from an imported XML
  assert.ok(both(s, 'SR-L6394-1').fail, directOnly);
  assert.equal(s.conceptStatus(directOnly, 'CY').applicable, false, 'and the UI cell is closed');
});

test('SR-L6448-1 an auditor-remark line item is provided against one member only (Filing Manual Annexure II #13)', () => {
  const s = ex();
  const t = T('DisclosureOfAuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportTable');
  const c = q('DisclosureInAuditorsReportRelatingToFixedAssets');
  const ax = 'AuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportAxis';
  s.filing.setFact({ concept: c, period: s.filing.period(c, 'CY'), dims: [m(ax, 'AuditorsFavourableRemarkMember')], value: 'Nil', lang: 'en' });
  assert.ok(A.table(t));
  assert.ok(both(s, 'SR-L6448-1', 'CY').pass);
  s.filing.setFact({ concept: c, period: s.filing.period(c, 'CY'), dims: [m(ax, 'AuditorsUnfavourableRemarkMember')], value: 'Nil', lang: 'en' });
  assert.ok(both(s, 'SR-L6448-1', 'CY').fail);
});

test('SR-L6475-2 / SR-L6495-2 / SR-L6984-2 at least one complete auditor / director row', () => {
  for (const [id, tname, axis, victim] of [['SR-L6475-2', 'DetailsRegardingAuditorsTable', 'AuditorsAxis', 'NameOfAuditorSigningReport'], ['SR-L6495-2', 'DetailsOfDirectorsSigningFinancialStatementsTable', 'DirectorsSigningFinancialStatementsAxis', 'DesignationOfDirector'], ['SR-L6984-2', 'DetailsOfDirectorsSigningBoardReportTable', 'DirectorsSigningBoardReportAxis', 'DesignationOfDirector']]) {
    const s = ex();
    const t = A.table(T(tname));
    const dims = [typed(axis, '1')];
    for (const li of t.lineItems) if (!s.filing.value(li, 'CY', dims) && s.conceptStatus(li, 'CY').applicable && li !== q('NameOfAuditFirm')) s.filing.setFact({ concept: li, period: s.filing.period(li, 'CY'), dims, value: A.dataType(li) === 'date' ? '2018-05-10' : A.dataType(li) === 'enum' ? A.enumerations(li)[0] : /Identification/.test(li) ? '00012345' : /Membership/.test(li) ? '123456' : 'X', lang: 'en' });
    assert.ok(both(s, id, 'CY').pass, `${id} complete`);
    for (const f of s.filing.factsOf(q(victim))) s.filing.removeFact(f.key);
    assert.ok(both(s, id, 'CY').fail, `${id} incomplete`);
  }
});

// ------------------------------------------------------------------------------------------------ generic rules
test('GR-1 calculation: parent = Σ children (Calculations 1.1); parent without children; child without parent', () => {
  const s = ex();
  assert.ok(both(s, 'GR-1').pass && !both(s, 'GR-1').fail);
  const a = cloneSession(s); a.setValue(q('Assets'), 'CY', '2300001'); // inconsistent total
  assert.ok(both(a, 'GR-1', 'CY').res.some((x) => x.status === 'FAIL' && /Calculation inconsistency/.test(x.message)));
  const b = cloneSession(s); b.setValue(q('CurrentTaxExpenseIncomeAndAdjustmentsForCurrentTaxOfPriorPeriods'), 'CY', '140000');
  for (const k of ['CurrentTaxExpenseIncome']) for (const f of b.filing.factsOf(q(k))) b.filing.removeFact(f.key);
  assert.ok(both(b, 'GR-1', 'CY').res.some((x) => x.status === 'FAIL' && /none of its calculation children/.test(x.message)));
  const c = cloneSession(s); for (const f of c.filing.factsOf(q('EmployeeBenefitExpense'))) c.filing.removeFact(f.key);
  assert.ok(both(c, 'GR-1', 'CY').res.some((x) => x.status === 'FAIL' && /calculation parent/.test(x.message)));
});

test('GR-2 is executed through the ML-* rules (driver reports so, never a silent PASS of its own data)', () => {
  const r = both(ex(), 'GR-2');
  assert.equal(r.res.length, 1); assert.match(r.res[0].message, /ML-\*/);
  assert.ok(A.rules.rules.filter((x) => x.family === 'mandatory-line-items' && x.status === 'EXECUTABLE').length >= 100);
});

test('GR-3 members defined as 1, 2, 3 … are sequential per axis; FM-16 per element (Annexure II #16)', () => {
  const s = ex();
  assert.ok(both(s, 'GR-3').pass && !both(s, 'GR-3').fail);
  assert.ok(both(s, 'FM-16').pass && !both(s, 'FM-16').fail);
  const SC = T('DisclosureOfClassesOfEquityShareCapitalTable');
  s.setTableValue(SC, 'CY', [m('ClassesOfEquityShareCapitalAxis', 'EquityShares3Member')], q('ParValuePerShare'), '10');
  assert.ok(both(s, 'GR-3', 'CY').fail, 'EquityShares3Member without 2');
  assert.ok(both(s, 'FM-16', 'CY').fail);
  s.setTableValue(SC, 'CY', [m('ClassesOfEquityShareCapitalAxis', 'EquityShares2Member')], q('TypeOfShare'), 'Equity shares');
  assert.ok(!both(s, 'GR-3', 'CY').fail, 'axis now has 1, 2, 3');
  assert.ok(both(s, 'FM-16', 'CY').res.some((x) => x.status === 'FAIL' && /ParValuePerShare/.test(x.message)), 'ParValuePerShare entered for 1 and 3 but not 2');
  s.setTableValue(SC, 'CY', [m('ClassesOfEquityShareCapitalAxis', 'EquityShares2Member')], q('ParValuePerShare'), '10');
  assert.ok(!both(s, 'FM-16', 'CY').res.some((x) => x.status === 'FAIL' && /ParValuePerShare/.test(x.message)));
});

test('GR-4 no images / charts in text blocks', () => {
  const s = ex();
  const tb = Object.keys(A.concepts).find((c) => A.dataType(c) === 'textBlock' && s.conceptStatus(c, 'CY').applicable && A.conceptElrs(c).some((u) => A.elr(u).code === '400100'));
  s.setValue(tb, 'CY', '<p>Note</p>');
  assert.ok(!both(s, 'GR-4').fail);
  s.filing.setFact({ concept: tb, period: s.filing.period(tb, 'CY'), value: '<p><img src="data:image/png;base64,AAAA"/></p>', lang: 'en' });
  assert.ok(both(s, 'GR-4').fail);
});

test('GR-5 current year ⇔ previous year for non-dimensional monetary elements; not for the first financial year', () => {
  const s = ex();
  assert.ok(!both(s, 'GR-5').fail);
  s.setValue(q('Rent'), 'CY', '1000'); for (const f of s.filing.factsOf(q('Rent'))) if (f.period.end === s.filing.meta.periods.py.end) s.filing.removeFact(f.key);
  const r5 = both(s, 'GR-5', 'PY');
  assert.ok(r5.fail, 'reported on the missing previous-year cell');
  assert.ok(r5.res.some((x) => x.status === 'FAIL' && x.concept === q('Rent')));
  const f = baseSession({ firstFinancialYear: true, periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '', end: '' } } });
  assert.deepEqual(both(f, 'GR-5').statuses, ['NOT_APPLICABLE']);
});

test('GR-6 opening of the current year is the previous-year closing instant (one fact); closing = opening + changes via FX-*', () => {
  const s = ex();
  const P = s.filing.meta.periods;
  const open = s.periodForCell(q('EquityShareCapital'), 'CY', 'periodStartLabel');
  const pyClose = s.periodForCell(q('EquityShareCapital'), 'PY');
  assert.deepEqual(open, pyClose);
  assert.equal(open.date, P.py.end);
  assert.match(both(s, 'GR-6').res[0].message, /Structural/);
  assert.ok(A.rules.rules.filter((r) => r.family === 'formula' && r.status === 'EXECUTABLE').length === 35);
});

test('GR-7 monetary values with at most 2 decimal places', () => {
  const s = ex();
  assert.ok(!both(s, 'GR-7').fail);
  s.filing.setFact({ concept: q('Rent'), period: s.filing.period(q('Rent'), 'CY'), value: '400000.123', decimals: '3' });
  assert.ok(both(s, 'GR-7', 'CY').fail);
});

test('GR-8 INR for all monetary facts except the listed subsidiary elements', () => {
  const s = ex();
  assert.ok(!both(s, 'GR-8').fail);
  const f = s.filing.setFact({ concept: q('Rent'), period: s.filing.period(q('Rent'), 'CY'), value: '400000', unit: 'USD' });
  assert.equal(f.unit, 'USD');
  assert.ok(both(s, 'GR-8', 'CY').fail);
  const ex8 = A.rules.rules.find((r) => r.id === 'GR-8').ast.exemptConcepts;
  assert.ok(ex8.length >= 15 && ex8.every((c) => A.concept(c)));
});

test('GR-10 / GR-13 / GR-12 / GR-11 ELR applicability by report type and year (facts outside them are errors)', () => {
  const con = consolidatedSession();
  const csr = Object.keys(A.concepts).find((c) => A.isReportable(c) && A.conceptElrs(c).length && A.conceptElrs(c).every((u) => /CorporateSocialResponsibility/.test(u)));
  assert.equal(con.conceptStatus(csr, 'CY').applicable, false);
  con.filing.setFact({ concept: csr, period: con.filing.period(csr, 'CY'), value: A.isNumeric(csr) ? '1' : 'false' });
  assert.ok(both(con, 'GR-10', 'CY').fail, 'CSR in a consolidated instance');
  const sa = ex();
  const cons = Object.keys(A.concepts).find((c) => A.isReportable(c) && A.conceptElrs(c).length && A.conceptElrs(c).every((u) => A.elr(u).code === '613400'));
  assert.equal(sa.conceptStatus(cons, 'CY').applicable, false);
  sa.filing.setFact({ concept: cons, period: sa.filing.period(cons, 'CY'), value: A.isNumeric(cons) ? '1' : 'X' });
  assert.ok(both(sa, 'GR-13', 'CY').fail, 'consolidated-only note in a standalone instance');
  const gi = q('AddressOfRegisteredOfficeOfCompany'), notAllowed = q('WhetherCompanyIsListedCompany');
  assert.equal(con.conceptStatus(gi, 'CY').applicable, true, 'listed general-information element allowed in consolidated');
  assert.equal(con.conceptStatus(notAllowed, 'CY').applicable, false);
  con.filing.setFact({ concept: notAllowed, period: con.filing.period(notAllowed, 'CY'), value: 'false' });
  assert.ok(both(con, 'GR-12', 'CY').fail);
  assert.ok(both(con, 'GR-12').res.some((x) => x.status === 'REVIEW_ONLY_EXTERNAL_DATA'), 'cross-instance equality needs the other instance');
  const s2 = ex();
  assert.equal(s2.conceptStatus(q('DateOfStartOfReportingPeriod'), 'PY').applicable, true, 'GR-11 exception element');
  const auditor = q('NameOfAuditorSigningReport');
  assert.equal(s2.conceptStatus(auditor, 'PY').applicable, false, 'auditors report not for the previous year');
  s2.filing.setFact({ concept: auditor, period: s2.filing.period(auditor, 'PY'), dims: [typed('AuditorsAxis', '1')], value: 'X', lang: 'en' });
  assert.ok(both(s2, 'GR-11', 'PY').fail);
});

test('GR-14 multi-axis tables: every axis carries a member for at least one context of each member (Annexure II #20)', () => {
  const s = ex();
  set(s, 'WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany', 'true');
  const SH = T('DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable');
  s.setTableValue(SH, 'CY', [m('ClassesOfEquityShareCapitalAxis', 'EquityShares1Member'), m('NameOfShareholderAxis', 'Shareholder1Member')], q('NumberOfSharesHeldInCompany'), '60000');
  assert.ok(both(s, 'GR-14', 'CY').pass && !both(s, 'GR-14', 'CY').fail);
  s.filing.setFact({ concept: q('PercentageOfShareholdingInCompany'), period: s.filing.period(q('PercentageOfShareholdingInCompany'), 'CY'), dims: [m('NameOfShareholderAxis', 'Shareholder2Member')], value: '0.2' });
  assert.ok(both(s, 'GR-14', 'CY').res.some((x) => x.status === 'FAIL' && /Shareholder2Member|Shareholder 2/i.test(x.message)), JSON.stringify(both(s, 'GR-14', 'CY').res));
});

test('GR-16 first-time adoption: balance-sheet elements need the opening balance sheet of the previous year', () => {
  const s = ex();
  assert.equal(both(s, 'GR-16').statuses[0], 'NOT_APPLICABLE', 'not Yes');
  s.setValue(q('WhetherCompanyHasAdoptedIndAsFirstTime'), 'CY', 'true');
  const r = both(s, 'GR-16', 'PYO');
  assert.ok(r.fail && r.res.some((x) => /'Assets'/.test(x.message)));
  const pyo = addDays(s.filing.meta.periods.py.start, -1);
  assert.ok(r.res.every((x) => x.message.includes(pyo)));
  for (const f of s.filing.all().filter((x) => !x.dims.length && x.period.type === 'instant' && x.period.date === s.filing.meta.periods.py.end && A.conceptElrs(x.concept).some((u) => A.elr(u).code === '110000'))) s.filing.setFact({ ...f, period: { type: 'instant', date: pyo }, origin: 'user' });
  for (const f of s.filing.all().filter((x) => !x.dims.length && x.period.type === 'instant' && x.period.date === s.filing.meta.periods.cy.end && A.conceptElrs(x.concept).some((u) => A.elr(u).code === '110000'))) if (!s.filing.get(f.concept, { type: 'instant', date: pyo }, [])) s.filing.setFact({ ...f, period: { type: 'instant', date: pyo }, origin: 'user' });
  assert.ok(both(s, 'GR-16', 'PYO').pass && !both(s, 'GR-16', 'PYO').fail);
  assert.ok(both(s, 'GR-16').res.some((x) => x.status === 'REVIEW_ONLY_EXTERNAL_DATA'), 'second-year exemption needs the incorporation date');
});

// ------------------------------------------------------------------------------------------------ Filing Manual
test('FM-14 parent member present when a child member is reported; FM-15 a child member when a parent is reported', () => {
  const s = ex();
  assert.ok(!both(s, 'FM-14').fail && !both(s, 'FM-15').fail);
  const FA = T('DisclosureOfFinancialAssetsTable');
  const fa = (mm) => [m('ClassesOfFinancialAssetsAxis', mm)];
  const a = cloneSession(s);
  a.setTableValue(FA, 'CY', fa('DerivativesMember'), q('FinancialAssets'), '100'); // parent FinancialAssetsAtFairValueMember absent; children absent
  assert.ok(both(a, 'FM-14', 'CY').res.some((x) => x.status === 'FAIL' && /FinancialAssetsAtFairValueMember|fair value/i.test(x.message)));
  assert.ok(both(a, 'FM-15', 'CY').res.some((x) => x.status === 'FAIL' && /child member of \{Derivatives/i.test(x.message)));
  // exempted parent (sheet "Exempt parent member Dimension"): FinancialAssetsMember on DisclosureOfFinancialAssetsTable
  assert.ok(A.rules.exemptions.parentMember.some((e) => e.table === 'DisclosureOfFinancialAssetsTable' && e.member === q('FinancialAssetsMember')));
  // non-numeric elements: reported, not blocking
  const b = cloneSession(s);
  b.setTableValue(FA, 'CY', fa('OtherFinancialAssetsAtAmortisedCostClass2Member'), q('DescriptionOfOtherFinancialAssetsAtAmortisedCostClass'), 'Deposits');
  b.setTableValue(FA, 'CY', fa('OtherFinancialAssetsAtAmortisedCostClass2Member'), q('FinancialAssets'), '1');
  const rb = both(b, 'FM-14', 'CY');
  assert.ok(!rb.res.some((x) => x.status === 'FAIL'), 'description present on parents already');
});

test('FM-14 / FM-15 / FM-16 per element, axis and period across the other axes; exempted children (ICOM 2022-23 calibration)', () => {
  const s = ex();
  const FA = T('DisclosureOfFinancialAssetsTable');
  const cat = m('CategoriesOfFinancialAssetsAxis', 'FinancialAssetsAtAmortisedCostCategoryMember');
  const cls = (mm) => m('ClassesOfFinancialAssetsAxis', mm);
  // child class under a category, parent class reported only without the category: accepted by MCA
  const a = cloneSession(s);
  a.setTableValue(FA, 'CY', [cat, cls('OtherFinancialAssetsAtAmortisedCostClass1Member')], q('FinancialAssets'), '100');
  const parentOnly = a.filing.get(q('FinancialAssets'), a.filing.period(q('FinancialAssets'), 'CY'), [cls('OtherFinancialAssetsAtAmortisedCostClassMember')]);
  assert.ok(parentOnly, 'example reports the parent class without the category');
  assert.ok(!both(a, 'FM-14', 'CY').res.some((x) => x.status === 'FAIL' && /OtherFinancialAssetsAtAmortisedCostClassMember|Other financial assets at amortised cost, class \[Member\]/.test(x.message)));
  a.filing.removeFact(parentOnly.key);
  const r = both(a, 'FM-14', 'CY').res.filter((x) => x.status === 'FAIL' && /FinancialAssets'/.test(x.message) && /class/i.test(x.message));
  assert.equal(r.length, 1, 'parent missing everywhere: one error per element / axis / period / parent');
  // FM-16: Class2 under a category without Class1 there, Class1 reported elsewhere for the element
  const b = cloneSession(s);
  b.setTableValue(FA, 'CY', [cat, cls('OtherFinancialAssetsAtAmortisedCostClass2Member')], q('FinancialAssets'), '5');
  b.setTableValue(FA, 'CY', [cls('OtherFinancialAssetsAtAmortisedCostClass2Member')], q('FinancialAssets'), '5');
  assert.ok(!both(b, 'FM-16', 'CY').res.some((x) => x.status === 'FAIL' && /FinancialAssets'/.test(x.message)));
  for (const f of b.filing.factsOf(q('FinancialAssets')).filter((x) => x.dims.some((d) => d.member === q('OtherFinancialAssetsAtAmortisedCostClass1Member')) && x.period.date === b.filing.meta.periods.cy.end)) b.filing.removeFact(f.key);
  assert.ok(both(b, 'FM-16', 'CY').res.some((x) => x.status === 'FAIL' && /FinancialAssets'/.test(x.message)), 'Class1 nowhere for the element: gap');
  // FM-15: "Exempt Child Member Dimension" lists OtherAssets1…10 under OtherAssetsMember (fair value table):
  // the parent may stand alone
  assert.ok(A.rules.exemptions.childMember.some((e) => e.parent === q('OtherAssetsMember') && e.member === q('OtherAssets1Member')));
  const FV = A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfFairValueMeasurementOfAssetsTable'));
  const c = cloneSession(s);
  const dims = [m('ClassesOfAssetsAxis', 'OtherAssetsMember'), m('LevelsOfFairValueHierarchyAxis', 'Level1OfFairValueHierarchyMember'), m('MeasurementAxis', 'AtFairValueMember')];
  c.filing.setFact({ concept: q('AssetsFairValue'), period: c.filing.period(q('AssetsFairValue'), 'CY'), dims, value: '10' });
  assert.ok(FV.lineItems.includes(q('AssetsFairValue')));
  assert.ok(!both(c, 'FM-15', 'CY').res.some((x) => x.status === 'FAIL' && /child member of \{OtherAssetsMember\}/.test(x.message)), 'all children exempted');
});

test('GR-1 at the opening of the previous year: totals not required without first-time adoption; calculation components of opening balances allowed (ICOM 2022-23)', async () => {
  const { openingConcepts } = await import('./applicability.js');
  const op = openingConcepts(A);
  assert.ok(op.has(q('DeferredTaxLiabilityAssets')) && op.has(q('DeferredTaxAssets')) && op.has(q('DeferredTaxLiabilities')), 'components of the opening deferred tax balance');
  const s = ex();
  const pyo = { type: 'instant', date: addDays(s.filing.meta.periods.py.start, -1) };
  s.filing.setFact({ concept: q('PropertyPlantAndEquipment'), period: pyo, dims: [], value: '1000', decimals: 'INF', unit: 'INR' });
  assert.ok(!both(s, 'GR-1').res.some((x) => x.status === 'FAIL' && /PropertyPlantAndEquipment|Property, plant and equipment/.test(x.message) && /parent/.test(x.message)), 'opening PPE without opening non-current assets');
  s.setValue(q('WhetherCompanyHasAdoptedIndAsFirstTime'), 'CY', 'true');
  assert.ok(both(s, 'GR-1').res.some((x) => x.status === 'FAIL' && /parent/.test(x.message)), 'first-time adoption: the opening balance sheet foots');
});

test('mandatory: an element excluded for the previous year in one of its ELRs (GR-11) is required for the current year only (SR-L6075-1)', () => {
  const s = ex();
  for (const f of s.filing.factsOf(q('DescriptionOfPresentationCurrency'))) if (s.filing.scopeOf(f.period) === 'PY') s.filing.removeFact(f.key);
  for (const id of ['SR-L6075-1', 'SR-L6392-1']) {
    const r = both(s, id);
    assert.ok(!r.fail && r.res.some((x) => x.scope === 'CY' && x.status === 'PASS'), id);
  }
  for (const f of s.filing.factsOf(q('DescriptionOfPresentationCurrency'))) s.filing.removeFact(f.key);
  assert.ok(both(s, 'SR-L6075-1', 'CY').fail);
});

test('director rows: a middle name is not a required detail (SR-L6495-2, ICOM 2022-23); calibrated ML elements warn, the rest still blocks (ML-44)', () => {
  const r = A.rules.rules.find((x) => x.id === 'SR-L6495-2');
  assert.ok(r.ast.except.includes(q('MiddleNameOfDirector')));
  const ml = A.rules.rules.find((x) => x.id === 'ML-44');
  assert.deepEqual(ml.ast.softConcepts, [q('DateOfBirthOfKeyManagerialPersonnelOrDirector')]);
  const s = ex();
  const KMP = T('DisclosureOfKeyManagerialPersonnelsAndDirectorsAndRemunerationToKeyManagerialPersonnelsAndDirectorsTable');
  const rows = [...new Set(s.filing.factsOf(q('NameOfKeyManagerialPersonnelOrDirector')).filter((f) => s.filing.scopeOf(f.period) === 'CY').map((f) => JSON.stringify(f.dims)))];
  assert.ok(rows.length && KMP);
  const a = cloneSession(s);
  for (const f of a.filing.factsOf(q('DateOfBirthOfKeyManagerialPersonnelOrDirector'))) a.filing.removeFact(f.key);
  const ra = both(a, 'ML-44', 'CY');
  assert.ok(!ra.res.some((x) => x.status === 'FAIL') && ra.res.some((x) => x.status === 'WARN' && /calibrated/.test(x.message)), 'date of birth missing: warning');
  for (const f of a.filing.factsOf(q('DesignationOfKeyManagerialPersonnelOrDirector'))) a.filing.removeFact(f.key);
  assert.ok(both(a, 'ML-44', 'CY').res.some((x) => x.status === 'FAIL'), 'designation missing as well: blocking');
});

test('FM-9 membership number of the auditor is numeric (Annexure II #9)', () => {
  const s = ex();
  const r0 = both(s, 'FM-9', 'CY');
  assert.ok(r0.pass && !r0.fail);
  const f = s.filing.factsOf(q('MembershipNumberOfAuditor'))[0];
  s.filing.setFact({ ...f, value: 'A534' });
  assert.ok(both(s, 'FM-9', 'CY').fail);
});

// ------------------------------------------------------------------------------------------------ engine semantics
test('engine: a rule is PASS only when evaluated; data-less rules report NOT_APPLICABLE; unimplemented rules are never PASS', () => {
  const s = ex();
  const { results, ruleStatus } = new RuleEngine(A).run(s.filing, { today: TODAY });
  for (const r of A.rules.rules) assert.ok(ruleStatus[r.id], r.id);
  const ml43 = results.filter((x) => x.ruleId === 'ML-43-b');
  assert.ok(ml43.length && ml43.every((x) => x.status === 'UNIMPLEMENTED' || x.status === 'APPROVED_LIMITATION_NOT_EXECUTED'));
  assert.ok(!results.some((x) => x.engineError), JSON.stringify(results.filter((x) => x.engineError).slice(0, 3)));
  const review = results.filter((x) => x.status === 'REVIEW_ONLY_EXTERNAL_DATA');
  assert.ok(review.length >= 60);
});
