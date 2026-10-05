// Suite: rule-by-rule mutation audit (rule-audit.mjs). Every executable MCA rule must be either VERIFIED (the
// production engine accepted a compliant filing AND rejected a violating one, built automatically from the rule's
// AST) or covered by a named hand-written test in rule-families.test.mjs. Nothing is accepted as "verified" on trust.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authority } from './helpers.mjs';
import { auditRules } from './rule-audit.mjs';

const A = authority();
const report = auditRules(A);
const families = readFileSync(new URL('./rule-families.test.mjs', import.meta.url), 'utf8');

test('rule audit: summary', () => {
  console.log('# rule audit ' + JSON.stringify(report.summary));
  assert.ok(report.summary.VERIFIED >= 1100, 'at least 1100 rules verified by PASS + FAIL witnesses');
  assert.equal(report.results.length, A.rules.rules.length);
});

test('rule audit: no executable rule is left without evidence', () => {
  const open = report.results.filter((x) => ['NOT_WITNESSED', 'PARTIAL', 'COVERED_BY_TEST'].includes(x.status));
  const missing = open.filter((x) => !new RegExp(`\\b${x.id.replace(/[-]/g, '\\-')}\\b`).test(families));
  assert.deepEqual(missing.map((x) => `${x.id} (${x.status}: ${x.note || x.evidence})`), [], 'every rule without an automatic witness has a hand test naming it');
});

test('rule audit: every VERIFIED rule really produced both verdicts', () => {
  for (const x of report.results.filter((r) => r.status === 'VERIFIED')) assert.ok(x.pass && x.fail, x.id);
});

test('rule audit: statuses agree with the compiled ledger', () => {
  const by = new Map(A.rules.rules.map((r) => [r.id, r]));
  for (const x of report.results) {
    const r = by.get(x.id);
    if (r.status !== 'EXECUTABLE') assert.equal(x.status, r.status, x.id);
    else assert.ok(['VERIFIED', 'COVERED_BY_TEST', 'NOT_WITNESSED', 'PARTIAL', 'DATA'].includes(x.status), x.id);
  }
});
