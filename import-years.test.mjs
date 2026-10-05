// Suite: import year-mapping — "Both years", "Current year only" and "Roll forward" (last year's filing → next year),
// mapped by XBRL period dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { authority, q } from './helpers.mjs';
import { Session } from './session.js';
import { DOMParser } from '@xmldom/xmldom';
import { dimKey } from './model.js';
import { openingBalanceConcepts } from './importer.js';
import { exampleSession, T } from './fixtures.mjs';

const A = authority();
const opts = (yearMode) => ({ DOMParserImpl: DOMParser, yearMode, fileName: 'src.xml' });
const row = (f) => `${f.concept}|${f.period.type === 'instant' ? f.period.date : f.period.start + '/' + f.period.end}|${dimKey(f.dims)}|${f.value}|${f.decimals}|${f.unit}`;
const sources = [...readdirSync('.').filter((x) => /^golden-.*\.xml$/.test(x)).map((f) => [f, readFileSync(f, 'utf8')]),
  ['generated-example.xml', exampleSession().exportXml({ today: '2018-09-30' }).xml]];

for (const [name, xml] of sources) {
  test(`${name}: preview shows the year split before anything is committed`, () => {
    const s = new Session(A);
    const before = s.filing.all().length;
    const p = s.previewXml(xml, { DOMParserImpl: DOMParser });
    assert.ok(p.byYear.current > 0 && p.byYear.previous > 0);
    assert.equal(s.filing.all().length, before, 'preview does not change the filing');
  });

  test(`${name}: Both years — CY and PY populated losslessly by period dates`, () => {
    const s = new Session(A);
    const r = s.importXml(xml, opts('both'));
    assert.equal(r.yearMode, 'both');
    assert.equal(r.byYear.current + r.byYear.previous + r.byYear.previousOpening + r.byYear.other, r.counts.imported);
    // every source fact is accounted for: imported, unresolved, or not applicable (kept in the report only)
    assert.equal(r.counts.imported + r.counts.unresolved + r.counts.notApplicable, r.counts.sourceFacts);
    for (const x of r.notApplicable) assert.ok(x.reasons.length, 'reason recorded');
    assert.equal(s.filing.inScope('CY').length, r.byYear.current);
    assert.equal(s.filing.inScope('PY').length, r.byYear.previous);
    assert.ok(s.filing.all().some((f) => s.filing.scopeOf(f.period) === 'PY' && f.dims.length), 'dimensional PY facts');
  });

  test(`${name}: Current year only — comparative previous-year data not imported, CY identical to Both years, nothing shifted`, () => {
    const both = new Session(A); both.importXml(xml, opts('both'));
    const cur = new Session(A);
    const r = cur.importXml(xml, opts('current'));
    assert.equal(r.yearMode, 'current');
    const opening = openingBalanceConcepts(A);
    const pyEnd = cur.filing.meta.periods.py.end;
    // previous-year facts present after a current-year-only import are exactly the current-year opening balances
    const pyFacts = cur.filing.inScope('PY');
    assert.equal(pyFacts.length, r.byYear.carriedOpening);
    for (const f of pyFacts) {
      assert.equal(f.period.type, 'instant', `${f.concept}: no previous-year duration fact`);
      assert.equal(f.period.date, pyEnd);
      assert.ok(opening.has(f.concept), `${f.concept} is presented with an opening (periodStart) row`);
    }
    assert.equal(cur.filing.inScope('PYO').length, 0, 'no previous-year opening facts');
    assert.equal(r.byYear.previous, 0);
    const bothPy = both.filing.inScope('PY');
    const expectedCarry = bothPy.filter((f) => f.period.type === 'instant' && opening.has(f.concept));
    assert.deepEqual(pyFacts.map(row).sort(), expectedCarry.map(row).sort(), 'carried values identical to the source, nothing else');
    // previous-year source facts = imported PY (Both years) + PY facts not applicable in Both years
    const bothNaPY = both.filing.importReport.notApplicable.filter((x) => x.scope === 'PY').length;
    assert.equal(r.byYear.skippedPrevious, bothPy.length + bothNaPY - expectedCarry.length);
    assert.equal(r.byYear.skippedPreviousOpening, both.filing.inScope('PYO').length);
    // every previous-year duration (P&L, cash flow, changes) and every PY-end instant of a non-opening concept is skipped
    assert.ok(!pyFacts.some((f) => !opening.has(f.concept)));
    // CY content identical to the Both-years import (normal, dimensional, typed, numeric and text facts)
    const cyRows = (s) => s.filing.inScope('CY').map(row).sort();
    assert.deepEqual(cyRows(cur), cyRows(both));
    const cyFacts = cur.filing.inScope('CY');
    assert.ok(cyFacts.some((f) => f.dims.some((d) => d.typed != null)), 'typed dimensions kept');
    assert.ok(cyFacts.some((f) => f.dims.some((d) => d.member)) || name.startsWith('generated'), 'explicit dimensions kept');
    assert.ok(cyFacts.some((f) => A.isNumeric(f.concept)) && cyFacts.some((f) => !A.isNumeric(f.concept)), 'numeric and text facts');
    for (const f of cyFacts) assert.ok(f.period.type === 'instant' ? f.period.date === cur.filing.meta.periods.cy.end : f.period.end === cur.filing.meta.periods.cy.end, 'only current-period dates');
    assert.equal(cur.filing.meta.periods.py.end, both.filing.meta.periods.py.end);
    for (const t of A.tables.filter((x) => x.presentationElr)) assert.equal(cur.tableStatus(t.id, 'CY').applicable, both.tableStatus(t.id, 'CY').applicable, t.id);
    // the current-year opening cell of every carried balance resolves to the carried fact
    for (const f of pyFacts) {
      const v = cur.getValue(f.concept, 'CY', f.dims, 'periodStartLabel');
      assert.ok(v && v.value === f.value, `${f.concept}: CY opening balance available`);
    }
    // no previous-year duration context and no PY-end context other than opening balances in the generated XML
    assert.ok(!cur.filing.all().some((f) => f.period.type === 'duration' && f.period.end === pyEnd));
  });
}

test('current-year opening balances (audit): MCA generic rule GR-6 and the taxonomy periodStart rows', () => {
  const gr6 = A.rules.rules.find((r) => r.id === 'GR-6');
  assert.match(gr6.text, /common element for specifying the opening and closing balance/);
  assert.match(gr6.text, /Opening balance of current year be shown as the closing balance of previous year/);
  const opening = openingBalanceConcepts(A);
  assert.ok(opening.size >= 20);
  for (const c of opening) assert.equal(A.concept(c).periodType, 'instant');
  for (const l of ['EquityShareCapital', 'NumberOfSharesOutstanding', 'OtherEquityBalances', 'CashAndCashEquivalentsCashFlowStatement', 'PropertyPlantAndEquipment']) assert.ok(opening.has(q(l)), l);
  for (const [name, xml] of sources) {
    const cur = new Session(A);
    const r = cur.importXml(xml, opts('current'));
    console.log(`# ${name}: current-year-only import carried ${r.byYear.carriedOpening} opening-balance facts (${r.carriedOpeningConcepts.length} concepts), skipped ${r.byYear.skippedPrevious} previous-year facts`);
    assert.ok(r.byYear.carriedOpening > 0);
    assert.ok(cur.filing.all().find((f) => f.concept === q('NumberOfSharesOutstanding') && cur.filing.scopeOf(f.period) === 'PY'), 'share-count opening balance carried');
    assert.ok(!cur.filing.all().some((f) => cur.filing.scopeOf(f.period) === 'PY' && ['Assets', 'EquityAndLiabilities', 'TradePayablesCurrent', 'RevenueFromOperations', 'ProfitLossForPeriod'].includes(A.concept(f.concept).name)));
  }
});

for (const [name, xml] of sources) {
  test(`${name}: Roll forward — last year's filing becomes the previous year of the next filing`, () => {
    const both = new Session(A); both.importXml(xml, opts('both'));
    const src = both.filing.meta.periods;
    const s = new Session(A);
    const r = s.importXml(xml, opts('rollforward'));
    const P = s.filing.meta.periods;
    assert.deepEqual(P.py, src.cy, 'new previous year = source current year (same dates, nothing shifted)');
    assert.equal(P.cy.start, '2018-04-01'.replace('2018', String(Number(src.cy.end.slice(0, 4)))));
    assert.equal(r.rollForward.newCurrent.start, P.cy.start);
    assert.equal(s.filing.meta.firstFinancialYear, false);
    // source CY durations and CY-end instants → new PY; source PY-end instants → new PY opening (PYO)
    const srcCy = both.filing.inScope('CY').filter((f) => !both.filing.importReport.notApplicable.some((x) => x.key === f.key));
    for (const f of srcCy) {
      const g = s.filing.get(f.concept, f.period, f.dims);
      const na = r.notApplicable.some((x) => x.concept === f.concept && dimKey(x.dims || []) === dimKey(f.dims));
      assert.ok(g || na, `${f.concept} ${dimKey(f.dims)} carried into the new previous year`);
    }
    for (const f of s.filing.inScope('PY')) assert.ok(both.filing.get(f.concept, f.period, f.dims), 'nothing invented');
    assert.ok(s.filing.inScope('PYO').length > 0, 'previous-year opening balances from the source previous-year end');
    for (const f of s.filing.inScope('PYO')) assert.equal(f.period.date, src.py.end);
    // nothing of the source previous year's durations
    assert.ok(!s.filing.all().some((f) => f.period.type === 'duration' && f.period.end === src.py.end));
    // the new current year starts empty except carried company identity
    const cy = s.filing.inScope('CY');
    assert.equal(cy.length, r.rollForward.carriedIdentity.length);
    for (const f of cy) { assert.equal(f.origin, 'carried'); assert.ok(r.rollForward.carriedIdentity.includes(A.concept(f.concept).name), f.concept); assert.ok(!A.isNumeric(f.concept), 'no amount is carried into the new year'); }
    assert.ok(cy.some((f) => f.concept === q('NameOfCompany')));
    // a roll-forward opening balance feeds the new year's reconciliation: CY opening = new PY closing
    const sh = s.getValue(q('NumberOfSharesOutstanding'), 'CY', [{ axis: q('ClassesOfEquityShareCapitalAxis'), member: q('EquityShares1Member') }], 'periodStartLabel');
    assert.ok(!name.startsWith('generated') || (sh && sh.value === '100000'));
  });
}

test('duplicate contexts in the source are merged consistently in both modes', () => {
  const xml = exampleSession().exportXml({ today: '2018-09-30' }).xml;
  const dup = xml.replace('<xbrli:context id="D2018">', '<xbrli:context id="D2018dup"><xbrli:entity><xbrli:identifier scheme="http://www.mca.gov.in/CIN">U72200KA2010PTC123456</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2017-04-01</xbrli:startDate><xbrli:endDate>2018-03-31</xbrli:endDate></xbrli:period></xbrli:context>\n  <xbrli:context id="D2018">');
  assert.notEqual(dup, xml);
  for (const mode of ['both', 'current', 'rollforward']) {
    const s = new Session(A);
    const r = s.importXml(dup, opts(mode));
    assert.ok(r.warnings.some((w) => /Duplicate contexts/.test(w)), mode);
  }
  void q; void T;
});
