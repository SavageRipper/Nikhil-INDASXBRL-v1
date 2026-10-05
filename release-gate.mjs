// Release gate: dynamic table-count comparison, rule coverage, rule-by-rule audit, test results, Arelle validation,
// build artefact, browser UI regression.
// Writes RELEASE_REPORT.json. Exit code 1 when the release is blocked.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';
import { runBrowserSmoke } from './browser-smoke.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const r = (p) => path.join(ROOT, p);
const A = JSON.parse(readFileSync(r('MCA_AUTHORITY.json'), 'utf8'));
const cov = JSON.parse(readFileSync(r('BUSINESS_RULE_COVERAGE.json'), 'utf8'));
const approved = JSON.parse(readFileSync(r('APPROVED_LIMITATIONS.json'), 'utf8')).limitations;
const isApproved = (id) => approved.some((l) => l.id === id && l.approved === true);

// all-arcs counted directly in the definition linkbases of the DTS (independent of the compiler's table model)
const dtsXml = A.meta.sources.filter((s) => s.file.startsWith('.taxonomy/') && s.file.endsWith('.xml')).map((s) => r(s.file));
const allArcs = dtsXml.map((f) => readFileSync(f, 'utf8')).reduce((n, s) => n + (s.match(/arcrole="http:\/\/xbrl.org\/int\/dim\/arcrole\/all"/g) || []).length, 0);
const audit = existsSync(r('RULE_AUDIT.json')) ? JSON.parse(readFileSync(r('RULE_AUDIT.json'), 'utf8')) : null;

let tests = { ok: false, summary: '' };
try {
  const out = execFileSync(process.execPath, ['--test', ...readdirSync(ROOT).filter((f) => f.endsWith('.test.mjs')).map((f) => r(f))], { encoding: 'utf8', cwd: ROOT });
  tests = { ok: true, summary: out.split('\n').filter((l) => /^# (tests|pass|fail|skipped)/.test(l)).join('; ') };
} catch (e) { tests = { ok: false, summary: String(e.stdout || e.message).split('\n').filter((l) => /^# (tests|pass|fail|skipped)|^not ok/.test(l)).join('; ') }; }

// golden regression run on its own so the report names its result (it is also part of the full suite above)
const golden = { files: readdirSync(ROOT).filter((f) => /^golden-.*\.xml$/.test(f)), ok: false, summary: '' };
if (golden.files.length) {
  try {
    const out = execFileSync(process.execPath, ['--test', r('golden.test.mjs')], { encoding: 'utf8', cwd: ROOT });
    golden.ok = true; golden.summary = out.split('\n').filter((l) => /^# (pass|fail)/.test(l)).join('; ');
  } catch (e) { golden.summary = String(e.stdout || e.message).split('\n').filter((l) => /^# (pass|fail)|^not ok/.test(l)).join('; '); }
}

const unimpl = cov.rules.filter((x) => x.status === 'UNIMPLEMENTED').map((x) => x.ruleId);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// build integrity: the production build embeds exactly the freshly compiled authority model
let integrity = { ok: false, detail: 'index.html missing' };
if (existsSync(r('index.html'))) {
  const html = readFileSync(r('index.html'), 'utf8');
  const m = /<script type="application\/json" id="mca-authority">([\s\S]*?)<\/script>/.exec(html);
  const embedded = m ? m[1].replace(/<\\\//g, '</') : '';
  const fresh = readFileSync(r('MCA_AUTHORITY.json'), 'utf8');
  const same = sha(embedded) === sha(fresh);
  const twin = existsSync(r('indas-xbrl.html')) && sha(readFileSync(r('indas-xbrl.html'))) === sha(Buffer.from(html));
  integrity = { ok: same && twin, detail: `embedded authority sha256 ${sha(embedded).slice(0, 16)} ${same ? '==' : '!='} compiled ${sha(fresh).slice(0, 16)}; indas-xbrl.html ${twin ? 'identical to' : 'DIFFERS from'} index.html` };
}

// genuine XSD / XBRL 2.1 / Dimensions validation of the golden instance and a generated one
const xs = xsdValidatorStatus();
let xsd = { ok: false, detail: `XSD validator not available: ${xs.reason}` };
if (xs.available) {
  const results = [];
  const goldens = readdirSync(ROOT).filter((x) => /^golden-.*\.xml$/.test(x));
  for (const f of goldens) results.push([f, validateInstanceXml(readFileSync(r(f), 'utf8'), { label: f, formulas: true })]);
  try {
    const { Authority } = await import('./authority.js');
    const { Session } = await import('./session.js');
    const { DOMParser } = await import('@xmldom/xmldom');
    for (const f of goldens) {
      const G = new Session(new Authority(A));
      G.importXml(readFileSync(r(f), 'utf8'), { DOMParserImpl: DOMParser });
      results.push([`regenerated ${f}`, validateInstanceXml(G.exportXml({ today: new Date().toISOString().slice(0, 10) }).xml, { label: 'regen-' + f, formulas: true })]);
    }
    const { buildExample } = await import('./example.js');
    const S = new Session(new Authority(A));
    buildExample(S);
    results.push(['generated example (with formula linkbase)', validateInstanceXml(S.exportXml({ today: '2018-09-30' }).xml, { label: 'example.xml', formulas: true })]);
  } catch (e) { results.push(['generated example', { status: 'FAIL', errors: [{ code: 'gate', message: e.message }] }]); }
  xsd = { ok: results.every(([, v]) => v.status === 'PASS' && !(v.formulaMessages || []).length), detail: `${xs.tool} ${xs.version}: ` + results.map(([n, v]) => `${n} ${v.status}${v.errors?.length ? ` (${v.errors.length} errors)` : ''}`).join('; ') };
}

let browser = { ok: true, detail: 'not run' };
try {
  const b = await runBrowserSmoke();
  browser = b.status === 'UNAVAILABLE' ? { ok: true, detail: `browser not available (${b.reason}) — not counted` } : { ok: b.status === 'PASS', detail: `${b.checks.filter((c) => c.ok).length}/${b.checks.length} UI checks passed${b.checks.filter((c) => !c.ok).map((c) => '; FAIL ' + c.name).join('')}` };
} catch (e) { browser = { ok: false, detail: e.message }; }

const checks = [
  { check: 'taxonomy table count == application table model count', ok: allArcs === A.tables.length, detail: `${allArcs} all-arcs in definition linkbases / ${A.tables.length} tables in model` },
  { check: 'automated test suite', ok: tests.ok, detail: tests.summary },
  { check: 'business-rule corpus complete: specificRulesSheetTruncated = false (or approved)', ok: (!cov.corpus.specificRulesSheetTruncated && !(cov.corpus.truncatedSheets || []).length) || isApproved('CORPUS-SPECIFIC-RULES-TRUNCATED'), detail: cov.corpus.note || `complete (${cov.corpus.sourceFile}, ${cov.corpus.sourceForm})` },
  { check: 'UNIMPLEMENTED business rules = 0 (or approved)', ok: unimpl.every(isApproved), detail: unimpl.length ? `${unimpl.join(', ')} — ${unimpl.filter(isApproved).length} approved` : 'none' },
  { check: 'rule-by-rule audit: every executable rule VERIFIED (PASS + FAIL witness) or covered by a named hand test', ok: !!audit && audit.authorityHash === A.meta.authorityHash && !audit.rules.some((x) => ['NOT_WITNESSED', 'PARTIAL'].includes(x.status) && !readFileSync(r('rule-families.test.mjs'), 'utf8').includes(x.id)), detail: audit ? `${JSON.stringify(audit.summary)} (authority ${audit.authorityHash === A.meta.authorityHash ? 'current' : 'STALE'})` : 'RULE_AUDIT.json missing — run npm run audit' },
  { check: 'golden MCA reference instances regression (or approved)', ok: (golden.files.length > 0 && golden.ok) || isApproved('GOLDEN-INSTANCES-MISSING'), detail: golden.files.length ? `${golden.files.join(', ')}: ${golden.summary}` : 'none supplied — add golden-<name>.xml (MCA-validated Ind AS instance) or approve GOLDEN-INSTANCES-MISSING' },
  { check: 'XSD / XBRL 2.1 / Dimensions validation (Arelle, offline)', ok: xsd.ok, detail: xsd.detail },
  { check: 'production build embeds the compiled authority (no stale data)', ok: integrity.ok, detail: integrity.detail },
  { check: 'browser UI regression (headless Chromium)', ok: browser.ok, detail: browser.detail },
];
const report = {
  generatedAt: new Date().toISOString(),
  authorityHash: A.meta.authorityHash,
  ruleCoverage: cov.summary,
  officialMcaValidation: 'NOT_RUN — the MCA XBRL Validation Tool (Ind AS) has not been executed against generated instances by this build',
  arelleXsdNote: 'Arelle XML Schema / XBRL 2.1 / Dimensions / Formula validation is not equivalent to the MCA XBRL Validation Tool and does not run the MCA business rules',
  ruleAudit: audit ? audit.summary : null,
  githubPages: process.env.PAGES_SMOKE_RESULT || 'NOT_RUN — the deployed GitHub Pages site is not reachable from the build environment',
  externalDataRules: cov.rules.filter((x) => x.status === 'REVIEW_ONLY_EXTERNAL_DATA').map((x) => x.ruleId),
  unimplementedRules: unimpl,
  approvedLimitations: approved.filter((l) => l.approved === true).map((l) => `${l.id}: APPROVED LIMITATION / NOT EXECUTED`),
  ruleCorpus: { sourceFile: cov.corpus.sourceFile, sourceSha256: cov.corpus.sourceSha256, sourceForm: cov.corpus.sourceForm, specificRulesSheetTruncated: cov.corpus.specificRulesSheetTruncated, sheets: cov.corpus.sheets, specificRuleRows: cov.corpus.specificRuleRows, genericRuleCount: cov.corpus.genericRuleCount, mandatoryLineItemRows: cov.corpus.mandatoryLineItemRows, firstElr: cov.corpus.firstElrInSpecificRules, lastElr: cov.corpus.lastElrInSpecificRules },
  checks,
  released: checks.every((c) => c.ok),
};
writeFileSync(r('RELEASE_REPORT.json'), JSON.stringify(report, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS ' : 'BLOCK'}  ${c.check} — ${c.detail}`);
console.log(report.released ? '\nRELEASE GATE: PASSED' : '\nRELEASE GATE: BLOCKED (see APPROVED_LIMITATIONS.json)');
process.exit(report.released ? 0 : 1);
