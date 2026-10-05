// Regression tests for two import/rule fixes found with the GE Power Boilers 2024-25 MCA-accepted instance:
//  (1) ML-52 (auditor's report outcome axis): each clause is reported under one member, so it is complete when the
//      element is reported under any member of that axis.
//  (2) Source-reported zero statements (OCI totals presented as 0 while the OCI flag is "No") are kept on import.
// No XML parser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Authority } from './authority.js';
import { Session } from './session.js';
import { Gate } from './gate.js';
import { Applicability } from './applicability.js';

const RAW = JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url)));
const A = new Authority(RAW);
const q = (local) => { const r = A.qnameOfLocal(local); assert.ok(r, 'no concept ' + local); return r; };
const meta = (s) => s.setMeta({ name: 'Test Co', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0,
  periods: { cy: { start: '2024-04-01', end: '2025-03-31' }, py: { start: '2023-04-01', end: '2024-03-31' } } });

// ---- (1) ML-52
const AUD = '700400:DisclosureOfAuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportTable';
const AX = q('AuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportAxis');
const ML52 = RAW.businessRules.rules.find((r) => r.id === 'ML-52').ast.concepts;
const FAVOURABLE = ['StatutoryDuesExplanatory', 'FraudByTheCompanyOrOnTheCompanyByItsOfficersOrItsEmployeesReportedDuringPeriod', 'ManagerialRemuneration', 'TransactionsWithRelatedParties'];
function auditorSession({ skip = null } = {}) {
  const s = new Session(A);
  meta(s);
  s.setValue(q('WhetherCompaniesAuditorsReportOrderIsApplicableOnCompany'), 'CY', 'true');
  for (const c of ML52) {
    const local = c.split(':').pop();
    if (local === skip) continue;
    const fav = FAVOURABLE.some((f) => local.endsWith(f));
    s.setTableValue(AUD, 'CY', [{ axis: AX, member: q(fav ? 'AuditorsFavourableRemarkMember' : 'ClauseNotApplicableMember') }], q(local), 'As stated by the auditor');
  }
  return s;
}
const ml52Errors = (s) => new Gate(A).run(s.filing, { today: '2025-10-05' }).issues.filter((x) => x.ruleId === 'ML-52' && x.severity === 'ERROR');

test('ML-52: clauses split between favourable and not-applicable members are complete', () => {
  assert.equal(ml52Errors(auditorSession()).length, 0);
});

test('ML-52: an element reported under no member of the axis is still an error', () => {
  const errs = ml52Errors(auditorSession({ skip: 'DisclosureInAuditorsReportRelatingToFixedAssets' }));
  assert.ok(errs.length >= 1);
  assert.ok(errs.some((x) => /FixedAssets/.test(x.message)));
});

// ---- (2) source-reported zero statements
test('a zero reported by the source is kept when only a Yes/No dependency would hide it', () => {
  const s = new Session(A);
  meta(s);
  s.setValue(q('WhetherCompanyHasOtherComprehensiveIncomeOCIComponentsPresentedNetOfTax'), 'CY', 'false');
  const concept = q('OtherComprehensiveIncome');
  const period = s.filing.period(concept, 'CY');
  s.filing.setFact({ concept, period, value: '0', origin: 'import', source: { contextRef: 'D2025' } });
  const emitted = new Applicability(A).planFacts(s.filing).emit.some((f) => f.concept === concept);
  assert.equal(emitted, true);
});

test('a zero typed by the user is never kept by this rule (entry is refused, and a user-origin fact is hidden)', () => {
  const s = new Session(A);
  meta(s);
  s.setValue(q('WhetherCompanyHasOtherComprehensiveIncomeOCIComponentsPresentedNetOfTax'), 'CY', 'false');
  const concept = q('OtherComprehensiveIncome');
  assert.throws(() => s.setValue(concept, 'CY', '0'), /not applicable/);
  s.filing.setFact({ concept, period: s.filing.period(concept, 'CY'), value: '0', origin: 'user' });
  const emitted = new Applicability(A).planFacts(s.filing).emit.some((f) => f.concept === concept);
  assert.equal(emitted, false);
});

test('a non-zero imported value hidden by a dependency is still excluded', () => {
  const s = new Session(A);
  meta(s);
  s.setValue(q('WhetherCompanyHasOtherComprehensiveIncomeOCIComponentsPresentedNetOfTax'), 'CY', 'false');
  const concept = q('OtherComprehensiveIncome');
  s.filing.setFact({ concept, period: s.filing.period(concept, 'CY'), value: '5', origin: 'import', source: {} });
  const emitted = new Applicability(A).planFacts(s.filing).emit.some((f) => f.concept === concept);
  assert.equal(emitted, false);
});
