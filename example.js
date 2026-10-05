// Example filing shown on first open (clearly marked as example data in the UI).
// Built only through the Session controller, so it obeys every applicability and dimension rule.
// Deterministic sample values that satisfy the format / ordering rules of the MCA corpus
// (signing dates after the board meeting and after the year end, distinct valid PANs, INR, ...).
import { addDays } from './periods.js';
import { nondimAllowed } from './dimensions.js';
const nondim = (A, c) => nondimAllowed(A, c);

// signing/meeting dates relative to the current-year end (board meeting 40 days after, auditors 42 days after)
function sampleDates(cyEnd) {
  const d = (n) => addDays(cyEnd, n);
  return {
    DateOfBoardMeetingWhenFinalAccountsWereApproved: d(40),
    DateOfSigningOfFinancialStatementsByDirector: d(40),
    DateOfSigningOfFinancialStatementsByCompanySecretary: d(40),
    DateOfSigningOfFinancialStatementsByChiefFinancialOfficer: d(40),
    DateOfSigningOfFinancialStatementsByManager: d(40),
    DateOfSigningOfBalanceSheetByAuditors: d(42),
    DateOfSigningAuditReportByAuditors: d(42),
    DateOfBoardOfDirectorsMeetingInWhichBoardReportReferredToUnderSection134WasApproved: d(40),
    DateOfSigningBoardReport: d(40),
    DateOfSigningSecretarialAuditReport: d(42),
    DateOfBirthOfKeyManagerialPersonnelOrDirector: '1970-01-01',
  };
}
const STRINGS = { PermanentAccountNumberOfEntity: 'AAACE1234A', TypeOfIndustry: 'Commercial and Industrial', DescriptionOfPresentationCurrency: 'INR', SRNOfFormADT1: 'Z99999999', ContentOfReport: 'Financial Statements' };

export function sampleValue(A, c, seq = { pan: 0 }, cyEnd = '2018-03-31') {
  const local = A.concept(c).name;
  const t = A.dataType(c);
  if (A.isNumeric(c)) return '0';
  if (t === 'boolean') return 'false';
  const DATES = sampleDates(cyEnd);
  if (DATES[local]) return DATES[local];
  if (STRINGS[local]) return STRINGS[local];
  const en = A.enumerations(c);
  if (en && en.length) return en[0];
  if (t === 'date') return DATES.DateOfBoardMeetingWhenFinalAccountsWereApproved;
  if (/^(PermanentAccountNumber|PAN)/.test(local)) return `ABCDE${String(1000 + (++seq.pan % 9000))}F`;
  if (/DirectorIdentificationNumber/.test(local)) return '00012345';
  if (/^MembershipNumberOf/.test(local)) return /Secretarial/.test(local) ? 'A12345' : '123456';
  if (/^CIN/.test(local)) return 'U72200KA2010PTC654321';
  if (/^Country/.test(local)) return 'INDIA';
  if (t === 'textBlock') return 'Nil';
  return 'Sample';
}

// Every unconditionally mandatory element (and report-type mandatory element of this report type) for
// CY and PY where applicable, and one complete member in every unconditionally mandatory (typed) table.
export function completeMandatory(S, { name = 'Sample' } = {}) {
  const A = S.A;
  const q = (l) => A.qnameOfLocal(l);
  const seq = { pan: 0 };
  const meta = S.filing.meta;
  const cyEnd = meta.periods.cy.end || '2018-03-31';
  const sv = (c) => sampleValue(A, c, seq, cyEnd);
  const scopes = meta.firstFinancialYear ? ['CY'] : ['CY', 'PY'];
  if (!S.getValue(q('NameOfCompany'), 'CY')) S.setValue(q('NameOfCompany'), 'CY', name);
  if (!S.getValue(q('TypeOfCashFlowStatement'), 'CY')) S.setValue(q('TypeOfCashFlowStatement'), 'CY', 'Indirect Method');
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || r.ast?.type !== 'mandatory') continue;
    if (r.ast.when && !(r.ast.when.op === 'reportType' && r.ast.when.value === meta.reportType)) continue;
    const c = r.ast.concept;
    if (!nondim(A, c)) continue; // dimensional only: filled through its table below
    for (const scope of r.scope?.periods || ['CY', 'PY']) {
      if (!scopes.includes(scope) || !S.conceptStatus(c, scope).applicable || S.getValue(c, scope)) continue;
      S.setValue(c, scope, sv(c));
    }
  }
  if (meta.reportType === 'Standalone') for (const scope of scopes) { const p = q('WhetherMoneyRaisedFromPublicOfferingDuringYear'); if (p && S.conceptStatus(p, scope).applicable) S.setValue(p, scope, 'false'); }
  // one complete row in every unconditionally mandatory table (typed axes: member "1"; explicit axes: the first
  // numbered member — EquityShares1Member — or the first usable non-default member)
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || r.ast?.type !== 'tableRequired' || r.ast.when) continue;
    for (const id of r.ast.tables) {
      const t = A.table(id);
      for (const scope of (r.scope?.periods || ['CY', 'PY']).filter((x) => scopes.includes(x))) {
        if (!S.tableStatus(id, scope).applicable) continue;
        const dims = t.axes.map((x) => {
          if (x.typed) return { axis: x.axis, typed: '1' };
          const def = A.dimensionDefault(x.axis);
          const cands = x.members.filter((m) => m.usable && m.member !== def);
          const numbered = cands.find((m) => /1Member$/.test(m.member));
          return { axis: x.axis, member: (numbered || cands.find((m) => m.depth === 1) || cands[0]).member };
        });
        for (const c of t.lineItems) {
          if (A.concept(c).abstract || !S.conceptStatus(c, scope).applicable) continue;
          try { S.setTableValue(id, scope, dims, c, sv(c)); } catch { /* not valid for this member combination (notAll) */ }
        }
      }
    }
  }
  return S;
}

// The in-app example: a small, internally consistent Ind AS standalone filing (FY 2017-18 with comparative 2016-17).
// Leaf values are entered with auto-calculation on, so every total (balance sheet, profit and loss, cash flow, share
// capital and equity roll-forwards) is derived by the taxonomy calculation and formula linkbases, as a user would.
export const EXAMPLE_PERIODS = { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } };
export function buildExample(S, { meta = {} } = {}) {
  const A = S.A;
  const q = (l) => { const x = A.qnameOfLocal(l); if (!x) throw new Error('example: no element ' + l); return x; };
  S.setMeta({ name: 'Example Industries Pvt Ltd (sample data)', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0, periods: EXAMPLE_PERIODS, ...meta });
  const set = (l, cy, py, opt = {}) => {
    if (cy != null) S.setValue(q(l), 'CY', String(cy), { recalc: true, ...opt });
    if (py != null && !S.filing.meta.firstFinancialYear) S.setValue(q(l), 'PY', String(py), { recalc: true, ...opt });
  };
  // ---- general information (identity first: the rest of the mandatory set is completed afterwards)
  set('NameOfCompany', 'Example Industries Private Limited');
  set('AddressOfRegisteredOfficeOfCompany', '12, Industrial Area, Phase II, Bengaluru 560058');
  set('TypeOfCashFlowStatement', 'Indirect Method');
  set('WhetherCompanyHasAdoptedIndAsFirstTime', 'false', 'false');
  // ---- balance sheet (CY, PY)
  set('CashOnHand', 50000, 20000);
  set('OtherBalancesWithBanks', 1800000, 1500000);
  set('TradeReceivablesCurrent', 450000, 300000);
  set('TradePayablesCurrent', 300000, 220000);
  set('EquityShareCapital', 1000000, 1000000);
  set('OtherEquity', 1000000, 600000);
  // ---- profit and loss
  set('DomesticRevenueServices', 3000000, 2500000);
  set('SalariesAndWages', 1350000, 1170000);
  set('ContributionToProvidentAndOtherFundsForOthers', 150000, 130000);
  for (const [l, cy, py] of [['Rent', 400000, 380000], ['PowerAndFuel', 200000, 190000], ['TravellingConveyance', 160000, 150000], ['LegalProfessionalCharges', 100000, 95000], ['MiscellaneousExpenses', 100000, 85000]]) set(l, cy, py);
  set('CurrentTaxPertainingToCurrentYear', 140000, 100000);
  set('CurrentTaxExpenseIncome', 140000, 100000);
  set('BasicEarningsLossPerShare', 4, 2);
  set('DilutedEarningsLossPerShare', 4, 2);
  set('BasicEarningsLossPerShareFromContinuingOperations', 4, 2);
  set('DilutedEarningsLossPerShareFromContinuingOperations', 4, 2);
  // ---- cash flow (indirect)
  set('AdjustmentsForDecreaseIncreaseInTradeReceivablesCurrent', -150000, 0);
  set('AdjustmentsForIncreaseDecreaseInTradePayablesCurrent', 80000, 120000);
  set('IncomeTaxesPaidRefundClassifiedAsOperatingActivities', 140000, 100000);
  // cash and cash equivalents for the cash flow statement: opening of the previous year (PYO) and both year ends
  const cce = q('CashAndCashEquivalentsCashFlowStatement');
  const P = S.filing.meta.periods;
  S.filing.setFact({ concept: cce, period: { type: 'instant', date: addDays(P.py.start, -1) }, value: '1200000', origin: 'user' });
  set('CashAndCashEquivalentsCashFlowStatement', 1850000, 1520000);
  // ---- [400100] equity share capital: one class (EquityShares1Member), 1,00,000 shares of ₹10
  const SC = A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfClassesOfEquityShareCapitalTable')).id;
  const cls = [{ axis: q('ClassesOfEquityShareCapitalAxis'), member: q('EquityShares1Member') }];
  const shareRow = { TypeOfShare: 'Equity shares', NumberOfSharesAuthorised: 200000, ValueOfSharesAuthorised: 2000000, NumberOfSharesIssued: 100000, ValueOfSharesIssued: 1000000,
    NumberOfSharesSubscribedAndFullyPaid: 100000, ValueOfSharesSubscribedAndFullyPaid: 1000000, NumberOfSharesSubscribedButNotFullyPaid: 0, ValueOfSharesSubscribedButNotFullyPaid: 0,
    NumberOfSharesSubscribed: 100000, ValueOfSharesSubscribed: 1000000, NumberOfSharesPaidUp: 100000, ValueOfSharesCalled: 1000000, ValueOfSharesPaidUp: 1000000, ParValuePerShare: 10,
    AmountPerShareCalledInCaseSharesNotFullyCalled: 0, IncreaseDecreaseInNumberOfSharesOutstanding: 0, IncreaseDecreaseInEquityShareCapital: 0 };
  const scopes = S.filing.meta.firstFinancialYear ? ['CY'] : ['CY', 'PY'];
  for (const scope of scopes) for (const [l, v] of Object.entries(shareRow)) S.setTableValue(SC, scope, cls, q(l), String(v), { recalc: true });
  // previous-year opening of the reconciliation (instant at the day before the previous-year start)
  const pyo = { type: 'instant', date: addDays(P.py.start, -1) };
  S.filing.setFact({ concept: q('NumberOfSharesOutstanding'), period: pyo, dims: cls, value: '100000', origin: 'user' });
  S.filing.setFact({ concept: q('EquityShareCapital'), period: pyo, dims: cls, value: '1000000', origin: 'user' });
  for (const scope of scopes) { S.setTableValue(SC, scope, cls, q('NumberOfSharesOutstanding'), '100000'); S.setTableValue(SC, scope, cls, q('EquityShareCapital'), '1000000'); }
  set('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany', 'false', 'false');
  // ---- [210000] earnings per share table (mandatory)
  const EPS = A.tables.find((t) => t.hypercube.endsWith(':EarningsPerShareTable')).id;
  for (const [scope, v] of [['CY', 4], ['PY', 2]]) if (scopes.includes(scope)) { S.setTableValue(EPS, scope, cls, q('BasicEarningsLossPerShare'), String(v)); S.setTableValue(EPS, scope, cls, q('DilutedEarningsLossPerShare'), String(v)); }
  // ---- [400200] statement of changes in equity: retained earnings carry the profit (opening 4,00,000 at PYO)
  const SOCE = A.tables.find((t) => t.hypercube.endsWith(':StatementOfChangesInEquityTable')).id;
  const axE = q('ComponentsOfEquityAxis');
  const members = ['EquityAttributableToTheEquityHoldersOfTheParentMember', 'ReservesMember', 'RetainedEarningsMember', 'OtherRetainedEarningMember'];
  const profit = { CY: 400000, PY: 200000 };
  const opening = 400000;
  for (const m of members) {
    const dims = [{ axis: axE, member: q(m) }];
    S.filing.setFact({ concept: q('OtherEquityBalances'), period: pyo, dims, value: String(opening), origin: 'user' });
    for (const scope of scopes) {
      S.setTableValue(SOCE, scope, dims, q('ProfitLossForPeriod'), String(profit[scope]), { recalc: true });
    }
  }
  // ---- [401100] trade receivables: current, unsecured considered good
  const TR = A.tables.find((t) => t.hypercube.endsWith(':SubclassificationOfTradeReceivablesTable')).id;
  const trDims = [{ axis: q('ClassificationBasedOnCurrentNoncurrentAxis'), member: q('CurrentMember') }, { axis: q('ClassificationOfAssetsBasedOnSecurityAxis'), member: q('UnsecuredConsideredGoodMember') }];
  for (const [scope, v] of [['CY', 450000], ['PY', 300000]]) if (scopes.includes(scope)) {
    for (const [l, x] of Object.entries({ TradeReceivablesGross: v, AllowanceForBadAndDoubtfulDebts: 0, TradeReceivablesDueByDirectors: 0, TradeReceivablesDueByOtherOfficers: 0, TradeReceivablesDueByFirmsOrCompaniesInWhichAnyDirectorIsPartnerOrDirector: 0 })) S.setTableValue(TR, scope, trDims, q(l), String(x), { recalc: true });
  }
  // ---- [611100] financial assets and liabilities by class (amortised cost)
  const FA = A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfFinancialAssetsTable')).id;
  const FL = A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfFinancialLiabilitiesTable')).id;
  const fa = (m) => [{ axis: q('ClassesOfFinancialAssetsAxis'), member: q(m) }];
  const fl = (m) => [{ axis: q('ClassesOfFinancialLiabilitiesAxis'), member: q(m) }];
  // member hierarchy kept complete (Filing Manual Annexure II #14/#15): Class1 → its parent "other … class" → amortised cost
  const faRows = { CY: { TradeReceivablesMember: 450000, OtherFinancialAssetsAtAmortisedCostClass1Member: 1850000, OtherFinancialAssetsAtAmortisedCostClassMember: 1850000, FinancialAssetsAtAmortisedCostMember: 2300000 }, PY: { TradeReceivablesMember: 300000, OtherFinancialAssetsAtAmortisedCostClass1Member: 1520000, OtherFinancialAssetsAtAmortisedCostClassMember: 1520000, FinancialAssetsAtAmortisedCostMember: 1820000 } };
  for (const scope of scopes) {
    for (const [m, v] of Object.entries(faRows[scope])) { S.setTableValue(FA, scope, fa(m), q('FinancialAssets'), String(v)); S.setTableValue(FA, scope, fa(m), q('FinancialAssetsAtFairValue'), String(v)); }
    for (const m of ['OtherFinancialAssetsAtAmortisedCostClass1Member', 'OtherFinancialAssetsAtAmortisedCostClassMember', 'FinancialAssetsAtAmortisedCostMember']) S.setTableValue(FA, scope, fa(m), q('DescriptionOfOtherFinancialAssetsAtAmortisedCostClass'), 'Cash and bank balances');
    const lv = scope === 'CY' ? 300000 : 220000;
    S.setTableValue(FL, scope, fl('FinancialLiabilitiesAtAmortisedCostMember'), q('FinancialLiabilities'), String(lv));
    S.setTableValue(FL, scope, fl('FinancialLiabilitiesAtAmortisedCostMember'), q('FinancialLiabilitiesAtFairValue'), String(lv));
  }
  // ---- [700300] principal product or service (revenue from services > 0)
  const PP = A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfPrincipalProductOrServicesTable')).id;
  const pd = [{ axis: q('TypesOfPrincipalProductOrServicesAxis'), typed: '1' }];
  for (const [l, v] of Object.entries({ ProductOrServiceCategoryITC4DigitCode: '9983', DescriptionOfProductOrServiceCategory: 'Other professional, technical and business services', TurnoverOfProductOrServiceCategory: 3000000,
    HighestTurnoverContributingProductOrServiceITC8DigitCode: '99831313', DescriptionOfProductOrService: 'Information technology consulting services', TurnoverOfHighestContributingProductOrService: 3000000 })) S.setTableValue(PP, 'CY', pd, q(l), String(v));
  // ---- everything else the MCA rules make mandatory (zero / sample values)
  completeMandatory(S, { name: 'Example Industries Private Limited' });
  return S;
}
