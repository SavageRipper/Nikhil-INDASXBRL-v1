// Suites: XML importer, XML generator, current/prior, internal gate, golden-instance regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { authority, q, importSession, XMLParser, CIN } from './helpers.mjs';
import { baseSession, exampleSession, T } from './fixtures.mjs';
import { scopeOf, periodFor, addDays } from './periods.js';
import { Gate, GateError } from './gate.js';
import { generateInstance } from './generator.js';
import { dimKey } from './model.js';

const A = authority();
const today = '2018-09-30';
const validCurrentInvestmentsSession = exampleSession; // a complete, gate-clean Ind AS filing

// semantic content of an instance: (concept, period, dims, unit measures, decimals, value)
export function semantic(xml) {
  const { s, report } = importSession(xml);
  const rows = s.filing.all().map((f) => [f.concept, f.period.type === 'instant' ? f.period.date : `${f.period.start}/${f.period.end}`, dimKey(f.dims), f.unit, f.decimals, f.nil ? 'NIL' : f.value].join(' | ')).sort();
  return { rows, report, s };
}

test('generator: prescribed schemaRef, CIN scheme, no segment, no precision/scale, unique contexts, no unused units', () => {
  const s = validCurrentInvestmentsSession();
  const { xml } = s.exportXml({ today });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<link:schemaRef xlink:type="simple" xlink:href="http:\/\/www.mca.gov.in\/XBRL\/2017\/07\/16\/Taxonomy\/Ind\/in-ci-ent-2017-03-31.xsd"\/>/);
  assert.match(xml, new RegExp(`<xbrli:identifier scheme="http://www.mca.gov.in/CIN">${CIN}</xbrli:identifier>`));
  assert.ok(!/<xbrli:segment|precision=|scale=/.test(xml));
  const ids = [...xml.matchAll(/<xbrli:context id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(xml.includes(`contextRef="${id}"`), `context ${id} used (Filing Manual #6)`);
  for (const [, u] of xml.matchAll(/<xbrli:unit id="([^"]+)"/g)) assert.ok(xml.includes(`unitRef="${u}"`), `unit ${u} used (#14)`);
  // well-formed and namespace-valid
  const doc = new XMLParser().parseFromString(xml, 'application/xml');
  assert.equal(doc.documentElement.localName, 'xbrl');
  // deterministic
  assert.equal(s.exportXml({ today }).xml, xml);
});

test('importer: round trip is semantically equivalent; context ids are mapped, not reused blindly', () => {
  const s = validCurrentInvestmentsSession();
  const { xml } = s.exportXml({ today });
  const a = semantic(xml);
  assert.equal(a.report.unresolvedFacts.length, 0);
  assert.equal(a.report.counts.sourceFacts, a.report.counts.imported);
  // rename contexts in the source to collision-prone ids and shuffle fact order
  let renamed = xml;
  for (const [i, id] of [...xml.matchAll(/<xbrli:context id="([^"]+)"/g)].map((m) => m[1]).entries()) renamed = renamed.replaceAll(`"${id}"`, `"c${i % 2 ? 'X' : 'x'}${i}"`);
  const lines = renamed.split('\n');
  const factLine = (l) => /^ {2}<(ind-as|in-ca):/.test(l);
  const factLines = lines.filter(factLine).reverse();
  const shuffled = [...lines.filter((l) => !factLine(l) && !/<\/xbrli:xbrl>/.test(l)), ...factLines, '</xbrli:xbrl>'].join('\n');
  const b = semantic(shuffled);
  assert.deepEqual(b.rows, a.rows);
  assert.ok(b.report.contexts.every((c) => c.sourceContextId.startsWith('c')));
  const regenerated = b.s.exportXml({ today }).xml;
  assert.equal(regenerated, xml, 'regenerated XML is identical after normalisation');
});

test('importer: unknown concepts and undefined contexts are reported, never dropped silently', () => {
  const { xml } = validCurrentInvestmentsSession().exportXml({ today });
  const bad = xml.replace('</xbrli:xbrl>', '  <ind-as:NoSuchConcept contextRef="D2018" xml:lang="en">x</ind-as:NoSuchConcept>\n  <ind-as:OtherIncome contextRef="NOPE" unitRef="INR" decimals="0">1</ind-as:OtherIncome>\n</xbrli:xbrl>');
  const { report } = importSession(bad);
  assert.equal(report.unresolvedFacts.length, 2);
  assert.ok(report.unknownConcepts.some((c) => c.endsWith('NoSuchConcept')));
  assert.ok(report.unresolvedFacts.some((u) => /contextRef 'NOPE'/.test(u.reason)));
  assert.equal(report.counts.sourceFacts, report.counts.imported + report.counts.unresolved);
});

test('importer: duplicate facts (identical / inconsistent) are reported', () => {
  const { xml } = validCurrentInvestmentsSession().exportXml({ today });
  const dup = xml.replace('</xbrli:xbrl>', '  <ind-as:Rent contextRef="D2018" unitRef="INR" decimals="0">400000</ind-as:Rent>\n  <ind-as:Rent contextRef="D2017" unitRef="INR" decimals="0">5</ind-as:Rent>\n</xbrli:xbrl>');
  const { report } = importSession(dup);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.conflicts.length, 1);
});

test('current/prior: periods come from reporting dates, not fact order; opening = prior closing (shared instant)', () => {
  const P = { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } };
  assert.equal(scopeOf(P, periodFor(P, 'duration', 'CY')), 'CY');
  assert.equal(scopeOf(P, periodFor(P, 'instant', 'PY')), 'PY');
  assert.equal(scopeOf(P, { type: 'instant', date: addDays(P.py.start, -1) }), 'PYO');
  const s = baseSession();
  // opening balance of CY (periodStart label) is the PY closing fact
  const opening = s.periodForCell(q('OtherEquityBalances'), 'CY', 'periodStartLabel');
  assert.deepEqual(opening, { type: 'instant', date: '2017-03-31' });
  assert.deepEqual(s.periodForCell(q('OtherEquityBalances'), 'PY', 'periodStartLabel'), { type: 'instant', date: '2016-03-31' }, 'PY opening = PYO');
  const { xml } = validCurrentInvestmentsSession().exportXml({ today });
  const { report } = importSession(xml);
  assert.deepEqual(report.periodDetection.cy, P.cy);
  assert.deepEqual(report.periodDetection.py, P.py);
  assert.match(report.periodDetection.method, /DateOfStartOfReportingPeriod/);
});

test('gate: blocks generation on errors; separate from official MCA validation', () => {
  const s = baseSession();
  s.filing.meta.cin = 'BADCIN';
  const g = new Gate(A).run(s.filing, { today });
  assert.equal(g.ok, false);
  assert.equal(g.officialValidation, 'NOT_RUN');
  assert.throws(() => s.exportXml({ today }), GateError);
  // dimension misuse is caught
  const s2 = baseSession();
  s2.filing.setFact({ concept: q('OtherIncome'), period: s2.filing.period(q('OtherIncome'), 'CY'), dims: [{ axis: q('ClassesOfPropertyPlantAndEquipmentAxis'), member: q('LandMember') }], value: '1', decimals: '0' });
  assert.ok(new Gate(A).run(s2.filing, { today }).issues.some((i) => i.code === 'dim.hypercube'));
  // default member in the instance is rejected (#30)
  const s3 = baseSession();
  s3.setValue(q('PropertyPlantAndEquipment'), 'CY', '1'); // the PPE table applies only when the balance-sheet amount > 0
  s3.filing.setFact({ concept: q('PropertyPlantAndEquipment'), period: s3.filing.period(q('PropertyPlantAndEquipment'), 'CY'), dims: [{ axis: q('ClassesOfPropertyPlantAndEquipmentAxis'), member: q('PropertyPlantAndEquipmentMember') }], value: '1', decimals: '0' });
  assert.ok(new Gate(A).run(s3.filing, { today }).issues.some((i) => i.code === 'dim.defaultReported'));
});

test('gate: HTML guidelines for textual content', async () => {
  const { htmlGuidelineIssues } = await import('./gate.js');
  assert.deepEqual(htmlGuidelineIssues('<p>ok <span class="normalText">x</span></p>'), []);
  assert.ok(htmlGuidelineIssues('<b>bold</b>').some((m) => /not allowed/.test(m)));
  assert.ok(htmlGuidelineIssues('<p style="x">a</p>').some((m) => /style/.test(m)));
  assert.ok(htmlGuidelineIssues('<P>a</P>').some((m) => /lower case/.test(m)));
  assert.ok(htmlGuidelineIssues('a &copy; b').some((m) => /entity/.test(m)));
});

test('golden-instance regression (MCA reference instances golden-*.xml)', (t) => {
  const dir = new URL('./', import.meta.url).pathname;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^golden-.*\.xml$/.test(f)) : [];
  if (!files.length) { t.skip('NO MCA-validated reference instances were supplied — golden regression NOT EXECUTED (add golden-<name>.xml at the repository root)'); return; }
  for (const f of files) {
    const xml = readFileSync(dir + f, 'utf8');
    const a = semantic(xml);
    const regenerated = generateInstance(A, a.s.filing).xml;
    const b = semantic(regenerated);
    assert.deepEqual(b.rows, a.rows, `${f}: semantic equivalence after regenerate`);
  }
});

test('generator: Filing Manual technical specifications on the example filing (#1, #3–#8, #13, #14, #20, #24, #26–#28, #30, #32, #35)', () => {
  const s = exampleSession();
  const { xml } = s.exportXml({ today });
  const doc = new XMLParser().parseFromString(xml, 'application/xml');
  const arr = (nl) => Array.from({ length: nl.length }, (_, i) => nl[i]);
  const ctx = arr(doc.getElementsByTagName('xbrli:context'));
  const ids = new Set(ctx.map((c) => c.getAttribute('id')));
  const idents = new Set(ctx.map((c) => c.getElementsByTagName('xbrli:identifier')[0].textContent));
  assert.deepEqual([...idents], [CIN], '#3 one CIN in every context');
  for (const c of ctx) {
    assert.equal(c.getElementsByTagName('xbrli:identifier')[0].getAttribute('scheme'), 'http://www.mca.gov.in/CIN', '#1');
    assert.equal(c.getElementsByTagName('xbrli:segment').length, 0, '#32 no segment');
  }
  // #4 no duplicate contexts (same period + scenario)
  const sig = ctx.map((c) => c.getElementsByTagName('xbrli:period')[0].toString() + (c.getElementsByTagName('xbrli:scenario')[0]?.toString() || ''));
  assert.equal(new Set(sig).size, sig.length);
  // #6 one fact per element and context; #35 non-dimensional elements only in contexts without scenario
  const facts = arr(doc.documentElement.childNodes).filter((n) => n.nodeType === 1 && n.getAttribute('contextRef'));
  const keys = facts.map((f) => f.nodeName + '@' + f.getAttribute('contextRef'));
  assert.equal(new Set(keys).size, keys.length);
  const scen = new Set(ctx.filter((c) => c.getElementsByTagName('xbrli:scenario').length).map((c) => c.getAttribute('id')));
  for (const f of facts) {
    const qn = f.nodeName;
    const dimensional = scen.has(f.getAttribute('contextRef'));
    if (!A.tablesForConcept(qn).length) assert.equal(dimensional, false, `${qn}: #35`);
    assert.ok(ids.has(f.getAttribute('contextRef')));
    if (A.isNumeric(qn)) { assert.ok(f.getAttribute('unitRef'), `#24 ${qn}`); assert.ok(f.hasAttribute('decimals'), qn); assert.ok(!f.hasAttribute('precision'), '#27'); }
    // #28 ("should" carry xml:lang="en") where the type permits it; #29 (schema validity) forbids it on the in-ca
    // restricted types (PAN, CIN, DIN, enumerations: restrictions without the attribute wildcard)
    else if (A.langAllowed(qn)) assert.equal(f.getAttribute('xml:lang'), 'en', `#28 ${qn}`);
    else if (!A.isNumeric(qn)) assert.ok(!f.hasAttribute('xml:lang'), `#29 ${qn}: xml:lang not allowed on ${A.concept(qn).type}`);
  }
  // #7 all monetary facts share one unit (INR) in this filing
  assert.deepEqual([...new Set(facts.filter((f) => A.isMonetary(f.nodeName)).map((f) => f.getAttribute('unitRef')))], ['INR']);
  // #30 no default member
  for (const m of xml.matchAll(/<xbrldi:explicitMember dimension="([^"]+)">([^<]+)</g)) assert.notEqual(A.dimensionDefault(m[1]), m[2], m[0]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/, '#26 UTF-8');
});

test('gate: Filing Manual checks reject a different CIN in the identifier and a context with an overlapping period', () => {
  const s = exampleSession();
  s.filing.meta.cin = 'L24223MH1946PLC005434';
  assert.ok(new Gate(A).run(s.filing, { today }).issues.some((i) => i.severity === 'ERROR' && /CIN/i.test(i.message)), 'CIN of the filing differs from the CIN reported in the general information');
  const s2 = exampleSession();
  s2.filing.setFact({ concept: q('Rent'), period: { type: 'duration', start: '2017-10-01', end: '2018-03-31' }, value: '1', decimals: '0' });
  assert.ok(new Gate(A).run(s2.filing, { today }).issues.some((i) => i.severity === 'ERROR' && /overlap|period/i.test(i.message)), '#8 overlapping periods');
});

test('reference filings are gate-clean: example, mandatory-complete standalone / consolidated, first financial year', async () => {
  const { consolidatedSession } = await import('./fixtures.mjs');
  const first = (rt) => baseSession({ reportType: rt, firstFinancialYear: true, periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '', end: '' } } });
  for (const [name, s] of [['example', exampleSession()], ['standalone', baseSession()], ['consolidated', consolidatedSession()], ['first-year standalone', first('Standalone')], ['first-year consolidated', first('Consolidated')]]) {
    const g = s.validate({ today });
    const errs = g.issues.filter((i) => i.severity === 'ERROR');
    assert.equal(errs.length, 0, `${name}: ${errs.slice(0, 5).map((i) => i.message).join('\n')}`);
    const warn = g.issues.filter((i) => i.severity === 'WARNING').map((i) => i.ruleId || i.code);
    assert.deepEqual(warn, ['ML-43-b'], `${name}: the only warning is the ML-43-b limitation (not executed)`);
    assert.equal(g.summary.excluded, 0);
  }
});
