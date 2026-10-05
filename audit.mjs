// CLI: writes RULE_AUDIT.json (rule-by-rule PASS/FAIL witness evidence) — `npm run audit`.
import { writeFileSync } from 'node:fs';
import { authority } from './helpers.mjs';
import { auditRules } from './rule-audit.mjs';

const A = authority();
const t0 = Date.now();
const rep = auditRules(A);
const by = new Map(A.rules.rules.map((r) => [r.id, r]));
const out = {
  generatedBy: 'audit.mjs (rule-audit.mjs)', authorityHash: A.meta.authorityHash, today: rep.today, summary: rep.summary,
  method: 'For each executable rule, a compliant filing (PASS witness) and a one-mutation violating filing (FAIL witness) are built from a clean base filing and checked by running only that rule through the production engine (rules.js).',
  rules: rep.results.map((x) => ({ ...x, implementation: by.get(x.id).implementation || null, text: by.get(x.id).text })),
};
writeFileSync(new URL('./RULE_AUDIT.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`RULE_AUDIT.json ${JSON.stringify(rep.summary)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
