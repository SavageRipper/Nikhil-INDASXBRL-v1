// Suites: taxonomy parser, table compiler, dimension/hypercube compiler (all / notAll / defaults / typed axes),
// formula linkbase, ELR profile, provenance, determinism — counts derived independently from the raw MCA files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { authority, q } from './helpers.mjs';
import { buildTableView, buildElrView } from './views.js';

const ROOT = new URL('./', import.meta.url).pathname;
const A = authority();
const dtsFiles = (ext) => A.meta.sources.filter((s) => s.file.startsWith('.taxonomy/') && s.file.endsWith(ext)).map((s) => path.join(ROOT, s.file));
const countIn = (files, re) => files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(re) || []).length, 0);
const arcrole = (r) => new RegExp(`arcrole="http://xbrl.org/int/dim/arcrole/${r}"`, 'g');

test('entry point, schemaRef and identifier scheme are the ones prescribed for Ind AS (Filing Manual)', () => {
  assert.equal(A.meta.entryPoint, 'in-ci-ent-2017-03-31.xsd');
  assert.equal(A.meta.schemaRef, 'http://www.mca.gov.in/XBRL/2017/07/16/Taxonomy/Ind/in-ci-ent-2017-03-31.xsd');
  assert.equal(A.meta.cinScheme, 'http://www.mca.gov.in/CIN');
  assert.match(A.meta.taxonomyVersion, /Ind AS Taxonomy 2017-03-31 V1\.2/);
  assert.deepEqual(Object.keys(A.namespaces).sort(), ['in-ca', 'in-ca-roles', 'in-ca-types', 'in-ci-ent', 'ind-as', 'ind-as-roles']);
  assert.match(A.namespaces['ind-as'], /icai\.org\/xbrl\/taxonomy\/2017-03-31\/ind-as$/);
  assert.ok(!Object.keys(A.concepts).some((c) => c.startsWith('in-gaap:')), 'no C&I (Indian GAAP) concept leaks into the Ind AS authority');
});

test('concept inventory equals the element count of the DTS schemas', () => {
  const xsd = ['ind-as/ind-as-2017-03-31.xsd', 'in-ca/in-ca-2017-03-31.xsd'].map((f) => readFileSync(path.join(ROOT, '.taxonomy/IndAS', f), 'utf8')).join('\n');
  const els = xsd.match(/^\s*<(?:xsd?:)?element [^>]*>/gm);
  assert.equal(Object.keys(A.concepts).length, els.length);
  assert.equal(Object.keys(A.concepts).length, 5647);
  const kinds = {}; for (const c of Object.values(A.concepts)) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  assert.equal(kinds.typedAxis, els.filter((e) => /dimensionItem/.test(e) && /typedDomainRef=/.test(e)).length);
  assert.equal(kinds.explicitAxis, els.filter((e) => /dimensionItem/.test(e) && !/typedDomainRef=/.test(e)).length);
  assert.equal(kinds.hypercube, els.filter((e) => /hypercubeItem/.test(e)).length);
  assert.equal(kinds.member, els.filter((e) => /domainItemType/.test(e)).length);
  const c = A.concept(q('PropertyPlantAndEquipment'));
  assert.equal(c.periodType, 'instant'); assert.equal(c.balance, 'debit');
  assert.equal(A.dataType(q('PropertyPlantAndEquipment')), 'monetary');
  assert.deepEqual(A.enumerations(q('LevelOfRoundingUsedInFinancialStatements')), ['Actual', 'Hundreds', 'Thousands', 'Lakhs', 'Millions', 'Crores', 'Billions']);
  assert.deepEqual(A.enumerations(q('TypeOfCashFlowStatement')), ['Direct Method', 'Indirect Method']);
});

test('relationship counts equal the arcs of the DTS linkbases (derived, not hard-coded)', () => {
  const xml = dtsFiles('.xml');
  const s = A.meta.relationshipStats;
  assert.equal(s.all, countIn(xml, arcrole('all')));
  assert.equal(s.notAll, countIn(xml, arcrole('notAll')));
  assert.equal(s.dimensionDefault, countIn(xml, arcrole('dimension-default')));
  assert.equal(s.hypercubeDimension, countIn(xml, arcrole('hypercube-dimension')));
  assert.equal(s.calculationArcs, countIn(xml, /<link:calculationArc /g));
  assert.ok(countIn(xml, /<link:presentationArc /g) >= s.presentationArcs);
  assert.equal(A.tables.length, s.all, 'one application table per all-arc');
  assert.equal(Object.keys(A.defaults).length, s.dimensionDefault);
  assert.deepEqual([A.elrs.length, A.tables.length, s.notAll, s.dimensionDefault, s.calculationArcs], [60, 175, 71, 70, 1269]);
  console.log(`# Ind AS DTS: ${xml.length} linkbases, ${A.elrs.length} ELRs, ${A.tables.length} tables, notAll ${s.notAll}, defaults ${s.dimensionDefault}, calc ${s.calculationArcs}, typed axes ${Object.values(A.concepts).filter((c) => c.kind === 'typedAxis').length}`);
});

test('every table: ELR, primary item, line items, axes, members, labels, renderable', () => {
  const ids = new Set();
  for (const t of A.tables) {
    assert.ok(!ids.has(t.id), `duplicate table id ${t.id}`); ids.add(t.id);
    assert.ok(A.json.roles[t.elr], `${t.id}: ELR role defined`);
    assert.equal(A.concept(t.hypercube).kind, 'hypercube');
    assert.ok(t.lineItems.length > 0, `${t.id}: line items discovered`);
    // [900000] Typed-Default is a definition-only technical role (closed hypercube, TypedDefaultAxis): not a filing tab
    if (!t.presentationElr) { assert.deepEqual(A.json.roles[t.elr].usedOn, ['link:definitionLink'], `${t.id}: only definition-only roles lack a presentation ELR`); continue; }
    for (const li of t.lineItems) assert.ok(A.isReportable(li), `${t.id}: ${li} reportable`);
    for (const ax of t.axes) {
      if (ax.typed) assert.equal(A.concept(ax.typedDomain).kind, 'typedDomain');
      else assert.ok(ax.members.length > 0, `${t.id} ${ax.axis}: members`);
    }
    const v = buildTableView(A, t.id);
    assert.ok(v.title, `${t.id}: labelled`);
    const lineSet = new Set(v.lineItems.filter((l) => !l.abstract).map((l) => l.concept));
    for (const li of t.lineItems) assert.ok(lineSet.has(li), `${t.id}: line item ${li} rendered`);
  }
  // typed axes of Ind AS tables (98 typed axes in the DTS, every one used by a table)
  assert.equal(new Set(A.tables.flatMap((t) => t.axes.filter((a) => a.typed).map((a) => a.axis))).size, Object.values(A.concepts).filter((c) => c.kind === 'typedAxis').length);
});

test('hypercube compiler: notAll exclusions, unusable members, defaults are resolvable', () => {
  const withNotAll = A.tables.filter((t) => t.notAll?.length);
  assert.ok(withNotAll.length > 0);
  for (const sets of Object.values(A.json.conceptHypercubes)) for (const bs of sets) for (const h of bs.hypercubes) assert.ok(A.hypercube(h.hypercube, h.hcElr), `${h.hypercube}@${h.hcElr}`);
  for (const [axis, member] of Object.entries(A.defaults)) { assert.ok(A.concept(axis), axis); assert.equal(A.concept(member).kind, 'member', member); }
  const eq = A.table(A.tables.find((t) => t.hypercube.endsWith(':DisclosureOfClassesOfEquityShareCapitalTable')).id);
  const ax = eq.axes.find((a) => a.axis === q('ClassesOfEquityShareCapitalAxis'));
  assert.ok(ax.members.some((m) => m.member === q('EquityShares1Member') && m.usable));
});

test('table → filing tab: a hypercube presented in several ELRs belongs to the tab of its own definition ELR', () => {
  for (const t of A.tables.filter((x) => x.presentationElr)) assert.equal(A.elr(t.presentationElr).code.slice(0, 6), t.id.slice(0, 6), t.id);
  assert.equal(A.elr(A.table('611500:DisclosureOfDetailsOfSubsidiariesTable').presentationElr).code, '611500', 'standalone subsidiaries note, not the consolidated-only [613400]');
});

test('ELR views: every presentation ELR renders and places all its tables', () => {
  let placed = 0;
  for (const e of A.elrs) {
    const v = buildElrView(A, e.uri);
    const tableRows = v.rows.filter((r) => r.kind === 'table').map((r) => r.tableId);
    assert.deepEqual(new Set(tableRows), new Set(v.tables));
    placed += new Set(tableRows).size;
  }
  assert.equal(placed, A.tables.filter((t) => t.presentationElr).length);
  assert.deepEqual(A.tables.filter((t) => !t.presentationElr).map((t) => t.id), ['900000:TypedDefaultTable']);
});

test('ELR profile: statements found from the role URIs (no hard-coded codes in the runtime)', () => {
  const p = A.meta.profile;
  assert.deepEqual({ bs: p.balanceSheet, pl: p.profitAndLoss, cfd: p.cashFlowDirect, cfi: p.cashFlowIndirect, soce: p.changesInEquity, gi: p.generalInformation }, { bs: '110000', pl: '210000', cfd: '310000', cfi: '320000', soce: '400200', gi: '700300' });
  for (const code of [p.balanceSheet, p.profitAndLoss, p.cashFlowDirect, p.cashFlowIndirect, p.changesInEquity, p.generalInformation]) assert.ok(A.elrByCode(code), code);
  assert.deepEqual(p.cashFlowMethods, { 'Direct Method': '310000', 'Indirect Method': '320000' });
});

test('formula linkbase: every value assertion read from the DTS and classified', () => {
  const xml = dtsFiles('.xml').filter((f) => /Formula/.test(f));
  assert.equal(A.json.formulas.assertions.length, countIn(xml, /<va:valueAssertion /g));
  assert.equal(A.json.formulas.assertions.length, 36);
  for (const fa of A.json.formulas.assertions) {
    assert.equal(fa.test, '$beginningBalance + $change1 eq $endingBalance', fa.id);
    assert.ok(fa.form && fa.form.kind === 'crossPeriod', fa.id);
    assert.ok(A.concept(fa.form.balance) && A.concept(fa.form.change), fa.id);
    assert.equal(A.concept(fa.form.balance).periodType, 'instant');
  }
  // one assertion binds its change to an abstract element (taxonomy defect): recorded, never executed
  const abs = A.json.formulas.assertions.filter((fa) => A.concept(fa.form.change).abstract);
  assert.deepEqual(abs.map((x) => x.id), ['crossPeriod_BiologicalAssetsOtherThanBearerPlantsAtCost']);
  assert.equal(A.rules.rules.find((r) => r.id === 'FX-BiologicalAssetsOtherThanBearerPlantsAtCost').status, 'NOT_APPLICABLE');
});

test('provenance: every source file hash matches the authority package', () => {
  for (const s of A.meta.sources) {
    const buf = readFileSync(path.join(ROOT, s.file));
    assert.equal(createHash('sha256').update(buf).digest('hex'), s.sha256, s.file);
  }
  assert.ok(A.meta.sources.some((s) => s.file === 'Filing_Manual_IndAS_V1.0.pdf'));
  assert.ok(A.meta.sources.some((s) => s.file === 'Business_Rules_IndAS_Taxonomy_V1.2.xlsx'));
});

test('authority compiler is deterministic', async () => {
  const { compile } = await import('./compile.mjs');
  const before = readFileSync(path.join(ROOT, 'MCA_AUTHORITY.json'));
  compile();
  const after = readFileSync(path.join(ROOT, 'MCA_AUTHORITY.json'));
  assert.equal(createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'));
});
