// Suites: rule engine semantics specific to Ind AS — formula linkbase cross-period checks (Annexure II #19), first-time
// adoption scope (PYO), per-row conditions, member-driven requirements, evaluation date, issue locations, and the
// approved-limitation path (never a PASS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authority, q } from './helpers.mjs';
import { exampleSession, cloneSession, T, runRule, TODAY } from './fixtures.mjs';
import { RuleEngine } from './rules.js';
import { Authority } from './authority.js';
import { Gate } from './gate.js';
import { addDays } from './periods.js';

const A = authority();
const SC = T('DisclosureOfClassesOfEquityShareCapitalTable');
const cls = [{ axis: q('ClassesOfEquityShareCapitalAxis'), member: q('EquityShares1Member') }];

test('FX formula: closing = opening + change per context; a missing item counts as 0 (Annexure II #19)', () => {
  const s = exampleSession();
  const r0 = runRule(s, 'FX-EquityShareCapital');
  assert.ok(r0.pass && !r0.fail, JSON.stringify(r0.res));
  const a = cloneSession(s);
  a.setTableValue(SC, 'CY', cls, q('IncreaseDecreaseInEquityShareCapital'), '50000'); // closing typed 1000000 stays
  const r1 = runRule(a, 'FX-EquityShareCapital', { scope: 'CY' });
  assert.ok(r1.fail);
  assert.match(r1.res.find((x) => x.status === 'FAIL').message, /opening 1000000 \+ change 50000 = 1050000 ≠ closing 1000000/);
  const b = cloneSession(s); // change and closing present, opening removed → opening counts as 0
  for (const f of b.filing.factsOf(q('EquityShareCapital')).filter((x) => x.dims.length && x.period.date === b.filing.meta.periods.py.end)) b.filing.removeFact(f.key);
  assert.match(runRule(b, 'FX-EquityShareCapital', { scope: 'CY' }).res.find((x) => x.status === 'FAIL').message, /opening 0 \(not entered\)/);
});

test('FX formula: a context in which the change element cannot be reported is not an evaluation (FinancialAssets by class)', () => {
  const s = exampleSession(); // FinancialAssets per class differs between years, IncreaseDecreaseInFinancialAssets is not valid in that table
  const r = runRule(s, 'FX-FinancialAssets');
  assert.ok(!r.fail, JSON.stringify(r.res.slice(0, 2)));
  assert.equal(A.rules.rules.find((x) => x.id === 'FX-BiologicalAssetsOtherThanBearerPlantsAtCost').status, 'NOT_APPLICABLE', 'change bound to an abstract element');
  assert.equal(A.rules.rules.find((x) => x.id === 'FX-EquityShareCapital').ast.taxonomySeverity, 'WARNING', 'taxonomy severity recorded; MCA lists it as an error (blocking)');
});

test('first-time adoption: PYO-scoped rules run on the opening balance sheet of the previous year with its own date', () => {
  const s = exampleSession();
  const ppe = A.rules.rules.find((r) => r.id === 'SR-L7-1');
  assert.deepEqual(ppe.scope.periods, ['CY', 'PY', 'PYO']);
  assert.deepEqual(runRule(s, 'SR-L7-1', { scope: 'PYO' }).res, [], 'not evaluated without FTA');
  s.setValue(q('WhetherCompanyHasAdoptedIndAsFirstTime'), 'CY', 'true');
  const r = runRule(s, 'SR-L7-1', { scope: 'PYO' });
  assert.ok(r.fail);
  assert.match(r.res[0].message, new RegExp(`opening balance sheet of the previous year \\(${addDays(s.filing.meta.periods.py.start, -1)}\\)`));
  s.setValue(q('PropertyPlantAndEquipment'), 'PYO', '0');
  assert.ok(runRule(s, 'SR-L7-1', { scope: 'PYO' }).pass);
  // FTA reconciliations become mandatory
  const rec = A.rules.rules.filter((x) => /AsPerIndianGaap$/.test(x.subject || '') && x.ast?.type === 'mandatory');
  assert.ok(rec.length >= 3);
  for (const x of rec) assert.ok(runRule(s, x.id, { scope: 'CY' }).fail, x.id);
});

test('per-row condition: firm details required on the auditor row whose category is "Auditors firm" (SR-L6479-1)', () => {
  const s = exampleSession();
  const AUD = T('DetailsRegardingAuditorsTable');
  const row = [{ axis: q('AuditorsAxis'), typed: '1' }];
  s.setTableValue(AUD, 'CY', row, q('CategoryOfAuditor'), 'Individual');
  assert.ok(!runRule(s, 'SR-L6479-1').fail, 'individual auditor: no firm name required');
  s.setTableValue(AUD, 'CY', row, q('CategoryOfAuditor'), 'Auditors firm');
  for (const f of s.filing.factsOf(q('NameOfAuditFirm'))) s.filing.removeFact(f.key);
  const r = runRule(s, 'SR-L6479-1', { scope: 'CY' });
  assert.ok(r.fail);
  assert.equal(r.res.find((x) => x.status === 'FAIL').concept, q('NameOfAuditFirm'), 'the error points at the missing cell');
  s.setTableValue(AUD, 'CY', row, q('NameOfAuditFirm'), 'A B & Co');
  assert.ok(runRule(s, 'SR-L6479-1', { scope: 'CY' }).pass);
});

test('member-driven requirement for an element outside the member\'s table (SR-L5173-1 other contingent liabilities)', () => {
  const s = exampleSession();
  const CL = T('DisclosureOfContingentLiabilitiesTable');
  assert.deepEqual(runRule(s, 'SR-L5173-1').res.map((x) => x.status), ['NOT_APPLICABLE']);
  s.filing.setFact({ concept: q('ContingentLiabilities'), period: s.filing.period(q('ContingentLiabilities'), 'CY'), dims: [{ axis: q('ClassesOfContingentLiabilitiesAxis'), member: q('OtherContingentLiabilitiesOthersMember') }], value: '1000' });
  assert.ok(A.table(CL));
  assert.ok(runRule(s, 'SR-L5173-1', { scope: 'CY' }).fail);
  s.filing.setFact({ concept: q('DescriptionOfOtherContingentLiabilitiesOthers'), period: s.filing.period(q('DescriptionOfOtherContingentLiabilitiesOthers'), 'CY'), value: 'Disputed claims', lang: 'en' });
  assert.ok(runRule(s, 'SR-L5173-1', { scope: 'CY' }).pass);
});

test('dates: "less than or equal to today" uses the evaluation date', () => {
  const r = A.rules.rules.find((x) => x.implementation === 'pattern:lte-today' && x.ast.concept === q('DateOfSigningOfFinancialStatementsByDirector')) || A.rules.rules.find((x) => x.implementation === 'pattern:lte-today');
  const s = exampleSession();
  const facts = s.filing.factsOf(r.ast.concept);
  if (!facts.length) s.filing.setFact({ concept: r.ast.concept, period: s.filing.period(r.ast.concept, 'CY'), dims: [], value: '2018-05-10' });
  const f = s.filing.factsOf(r.ast.concept)[0];
  s.filing.setFact({ ...f, value: '2018-05-10' });
  assert.ok(runRule(s, r.id, { today: '2018-09-30' }).pass);
  assert.ok(runRule(s, r.id, { today: '2018-05-09' }).fail);
});

test('gate issues carry a structured location (tab, table, scope, cell id) for navigation', () => {
  const s = exampleSession();
  s.setValue(q('LoansNoncurrent'), 'CY', '-5'); // SR-L18-2: should be >= 0
  const g = s.validate({ today: TODAY });
  const i = g.issues.find((x) => x.severity === 'ERROR' && x.ruleId === 'SR-L18-2' && x.location?.cellId?.startsWith(q('LoansNoncurrent') + '#'));
  assert.ok(i, g.issues.filter((x) => x.severity === 'ERROR').map((x) => x.message).join('\n'));
  assert.equal(i.location.scope, 'CY');
  assert.ok(i.location.elrUri);
});

test('ML-43-b stays UNIMPLEMENTED; if the release owner approves it, it is shown as APPROVED LIMITATION / NOT EXECUTED, never PASS', () => {
  const lim = JSON.parse(readFileSync(new URL('./APPROVED_LIMITATIONS.json', import.meta.url), 'utf8')).limitations;
  const l43 = lim.find((l) => l.id === 'ML-43-b');
  assert.ok(l43, 'listed in APPROVED_LIMITATIONS.json');
  const r = A.rules.rules.find((x) => x.id === 'ML-43-b');
  assert.equal(r.status, 'UNIMPLEMENTED', 'approval never turns the rule into an executable one');
  assert.equal(!!r.approvedLimitation, l43.approved === true, 'compiled approval follows the release owner\'s file');
  if (l43.approved) assert.ok(l43.approvedBy, 'an approval names who approved it');
  const json = JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url), 'utf8'));
  json.businessRules.rules.find((x) => x.id === 'ML-43-b').approvedLimitation = { approvedBy: 'release owner (test)' };
  const A2 = new Authority(json);
  const s = exampleSession();
  const res = new RuleEngine(A2).run(s.filing, { today: TODAY }).results.filter((x) => x.ruleId === 'ML-43-b');
  assert.equal(res.length, 1); assert.equal(res[0].status, 'APPROVED_LIMITATION_NOT_EXECUTED');
  const g = new Gate(A2).run(s.filing, { today: TODAY });
  assert.match(g.issues.find((i) => i.ruleId === 'ML-43-b').message, /APPROVED LIMITATION \/ NOT EXECUTED/);
  assert.equal(g.officialValidation, 'NOT_RUN');
});

test('shared line items: a share-capital row (TypeOfShare [class]) is not a row of the >5% shareholders table', async () => {
  const { factInTable } = await import('./dimensions.js');
  const s = exampleSession();
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'true');
  const SH = T('DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable');
  const f = s.filing.factsOf(q('TypeOfShare')).find((x) => x.dims.length === 1);
  assert.ok(f);
  assert.equal(factInTable(A, f, A.table(SC)), true);
  assert.equal(factInTable(A, f, A.table(SH)), false);
  const req = A.rules.tableApplicability[SH][0].rule;
  assert.ok(runRule(s, req, { scope: 'CY' }).fail, 'Yes but no shareholder rows: the table is required');
  assert.deepEqual(s.openTable(SH, 'CY').slices, [], 'the shareholder table shows no rows from the share-capital table');
  s.setTableValue(SH, 'CY', [...cls, { axis: q('NameOfShareholderAxis'), member: q('Shareholder1Member') }], q('NumberOfSharesHeldInCompany'), '60000');
  assert.ok(runRule(s, req, { scope: 'CY' }).pass);
});
