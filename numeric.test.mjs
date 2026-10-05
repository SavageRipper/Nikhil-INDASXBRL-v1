// Suites: units, decimals, financial scaling, decimal arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, importSession } from './helpers.mjs';
import { baseSession, exampleSession, T } from './fixtures.mjs';
import * as Dec from './decimal.js';
import { toCanonical, toDisplay, monetaryDecimals, SCALE_POWERS } from './scaling.js';
import { Gate } from './gate.js';
import { generateInstance } from './generator.js';

const A = authority();
const today = '2018-09-30';
// a non-dimensional monetary duration element outside every calculation network
const X = 'AmountOfContributionsMadeToPoliticalPartyOrForPoliticalPurpose';

test('decimal arithmetic is exact (no binary floating point)', () => {
  assert.equal(Dec.toString(Dec.add('0.1', '0.2')), '0.3');
  assert.equal(Dec.toString(Dec.mul('1234.5', '100000')), '123450000');
  assert.equal(Dec.toString(Dec.round('1234567', -3)), '1235000');
  assert.equal(Dec.toString(Dec.round('-2.5', 0)), '-3');
  assert.equal(Dec.toString(Dec.parse('1.20E3')), '1200');
  assert.equal(Dec.requiredDecimals('1234500'), -2);
  assert.equal(Dec.toString(Dec.shift('12.345', 5)), '1234500');
});

test('scaling: every LevelOfRounding enumeration value has a power of ten', () => {
  for (const v of A.enumerations(q('LevelOfRoundingUsedInFinancialStatements'))) assert.ok(v in SCALE_POWERS, v);
  assert.equal(toCanonical('12.34', 'Lakhs'), '1234000');
  assert.equal(toCanonical('1.5', 'Crores'), '15000000');
  assert.equal(toCanonical('2', 'Billions'), '2000000000');
  assert.equal(toCanonical('7.25', 'Millions'), '7250000');
  assert.equal(toCanonical('99.9', 'Thousands'), '99900');
  assert.equal(toCanonical('4.5', 'Hundreds'), '450');
  assert.equal(toDisplay('1234000', 'Lakhs'), '12.34');
  assert.equal(monetaryDecimals('Lakhs', 2), -3);
  assert.equal(monetaryDecimals('Actual', 2), 2);
  assert.equal(monetaryDecimals('Crores', 2), -5);
});

for (const [level, places, display, canonical, decimals] of [
  ['Actual', 0, '1234', '1234', '0'],
  ['Actual', 2, '1234.567', '1234.57', '2'],
  ['Hundreds', 0, '12', '1200', '-2'],
  ['Thousands', 0, '1234', '1234000', '-3'],
  ['Lakhs', 2, '12.345', '1235000', '-3'],
  ['Millions', 1, '3.25', '3300000', '-5'],
  ['Crores', 2, '1.5', '15000000', '-5'],
  ['Billions', 3, '0.0015', '2000000', '-6'],
]) {
  test(`scaling round trip ${level}/${places}dp: display ${display} → canonical ${canonical} → XML → display`, () => {
    const s = baseSession({ level, displayPlaces: places });
    const f = s.setValue(q(X), 'CY', display);
    s.setValue(q(X), 'PY', display); // GR-5: current and previous year are paired
    assert.equal(f.value, canonical);
    assert.equal(f.decimals, decimals);
    assert.equal(s.displayOf(f), toDisplay(canonical, level));
    // edit again in display scale
    const f2 = s.setValue(q(X), 'CY', s.displayOf(f));
    assert.equal(f2.value, canonical);
    const g = new Gate(A).run(s.filing, { today });
    assert.ok(!g.issues.some((i) => i.code.startsWith('decimals')), g.issues.filter((i) => i.code.startsWith('decimals')).map((i) => i.message).join());
    const { xml } = s.exportXml({ today });
    assert.match(xml, new RegExp(`<${q(X)} contextRef="D2018" unitRef="INR" decimals="${decimals}">${canonical.replace('.', '\\.')}</${q(X)}>`));
    assert.ok(!/precision=|scale=/.test(xml));
  });
}

test('decimals: imported decimals are preserved through import → edit → save → XML → re-import', () => {
  const s = exampleSession();
  let { xml } = s.exportXml({ today });
  // a source instance reports Rent with decimals="-3"
  const re = /(<ind-as:Rent contextRef="D2018" unitRef="INR" decimals=)"0">400000</;
  assert.match(xml, re);
  xml = xml.replace(re, '$1"-3">400000<');
  const { s: s2 } = importSession(xml);
  const f = s2.getValue(q('Rent'), 'CY');
  assert.equal(f.decimals, '-3');
  s2.setValue(q('Rent'), 'CY', '401000'); // consistent with -3 → kept
  assert.equal(s2.getValue(q('Rent'), 'CY').decimals, '-3');
  assert.equal(s2.filing.toJSON().facts.find((x) => x.concept === q('Rent') && x.period.end === '2018-03-31').decimals, '-3');
  s2.setValue(q('Rent'), 'CY', '400000', { recalc: true });
  const { xml: xml2 } = s2.exportXml({ today });
  assert.match(xml2, /<ind-as:Rent contextRef="D2018" unitRef="INR" decimals="-3">400000</);
  const { s: s3 } = importSession(xml2);
  assert.equal(s3.getValue(q('Rent'), 'CY').decimals, '-3');
  // an edit NOT consistent with the source decimals switches deterministically to the filing policy
  s3.setValue(q('Rent'), 'CY', '400001');
  assert.equal(s3.getValue(q('Rent'), 'CY').decimals, '0');
});

test('decimals: non-significant digits must be zero (Filing Manual #13); precision is rejected', () => {
  const s = baseSession();
  s.filing.setFact({ concept: q(X), period: s.filing.period(q(X), 'CY'), value: '1234', decimals: '-2' });
  const g = new Gate(A).run(s.filing, { today });
  assert.ok(g.issues.some((i) => i.code === 'decimals.nonSignificant'));
  const { xml } = exampleSession().exportXml({ today });
  const { report } = importSession(xml.replace('decimals="0">400000</ind-as:Rent>', 'precision="4">400000</ind-as:Rent>'));
  assert.ok(report.errors.some((e) => /precision/.test(e)));
});

test('units: INR, shares, pure and INR/share are emitted correctly and type-checked', () => {
  const s = exampleSession();
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'true');
  const SH = T('DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable');
  const dims = [{ axis: q('ClassesOfEquityShareCapitalAxis'), member: q('EquityShares1Member') }, { axis: q('NameOfShareholderAxis'), member: q('Shareholder1Member') }];
  s.setTableValue(SH, 'CY', dims, q('NumberOfSharesHeldInCompany'), '60000');
  s.setTableValue(SH, 'CY', dims, q('PercentageOfShareholdingInCompany'), '0.6');
  const facts = s.filing.all();
  const unitOf = (local) => facts.find((f) => f.concept === q(local)).unit;
  assert.equal(unitOf('Rent'), 'INR');
  assert.equal(unitOf('NumberOfSharesHeldInCompany'), 'shares');
  assert.equal(unitOf('PercentageOfShareholdingInCompany'), 'pure');
  assert.equal(unitOf('BasicEarningsLossPerShare'), 'INRPerShare');
  const { xml } = generateInstance(A, s.filing);
  assert.match(xml, /<xbrli:unit id="INR"><xbrli:measure>iso4217:INR<\/xbrli:measure><\/xbrli:unit>/);
  assert.match(xml, /<xbrli:unit id="shares"><xbrli:measure>xbrli:shares<\/xbrli:measure><\/xbrli:unit>/);
  assert.match(xml, /<xbrli:unit id="pure"><xbrli:measure>xbrli:pure<\/xbrli:measure><\/xbrli:unit>/);
  assert.match(xml, /<xbrli:unit id="INRPerShare"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:INR<\/xbrli:measure><\/xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares<\/xbrli:measure><\/xbrli:unitDenominator><\/xbrli:divide><\/xbrli:unit>/);
  assert.match(xml, /decimals="1">0.6</);
  // shares values are never scaled even in Lakhs filings
  const sl = exampleSession({ level: 'Lakhs', displayPlaces: 2 });
  sl.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'true');
  assert.equal(sl.setTableValue(SH, 'CY', dims, q('NumberOfSharesHeldInCompany'), '5000').value, '5000');
  // a wrong unit is a blocking error
  s.filing.setFact({ concept: q(X), period: s.filing.period(q(X), 'CY'), value: '1', decimals: '0', unit: 'shares' });
  assert.ok(new Gate(A).run(s.filing, { today }).issues.some((i) => i.code === 'unit.type'));
});

test('Filing Manual #20/#21/#13: no scale factor in values or units; derived totals keep non-significant digits at 0', () => {
  const s = exampleSession();
  s.setMeta({ level: 'Crores', displayPlaces: 2 }); // level changed after data entry
  const f = s.setValue(q('Rent'), 'CY', '0.04', { recalc: true });
  assert.equal(f.value, '400000'); assert.equal(f.decimals, '-5');
  // OtherExpenses = 400000 (−5) + 560000 (0): exact total 960000 → decimals −4, never −5 with digits below 10^5
  const tot = s.getValue(q('OtherExpenses'), 'CY');
  assert.equal(tot.value, '960000'); assert.equal(tot.decimals, '-4');
  const { xml } = s.exportXml({ today });
  assert.equal((xml.match(/<xbrli:unit id="INR">/g) || []).length, 1);
  assert.ok(!/scale|precision=/.test(xml));
  assert.match(xml, /<ind-as:Rent contextRef="D2018" unitRef="INR" decimals="-5">400000</);
});
