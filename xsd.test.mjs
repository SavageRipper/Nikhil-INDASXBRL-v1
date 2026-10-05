// Suite: genuine XML Schema + XBRL 2.1 + XBRL Dimensions + Formula validation of generated instances (Arelle, offline,
// against the local MCA Ind AS 2017 package). Independent of the internal gate; skipped (with an explicit reason) only
// when Arelle is not installed — never reported as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { q, importSession, authority } from './helpers.mjs';
import { exampleSession, consolidatedSession, baseSession, cloneSession, T, runRule, TODAY, exportUnchecked } from './fixtures.mjs';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';
import { generateInstance } from './generator.js';
import { Gate } from './gate.js';
import { addDays } from './periods.js';

const A = authority();
const st = xsdValidatorStatus();
const run = (name, xml, opts = {}) => {
  const r = validateInstanceXml(xml, { label: name, ...opts });
  assert.equal(r.status, 'PASS', r.errors.slice(0, 10).map((e) => `[${e.code}] ${e.message}`).join('\n'));
  return r;
};
const emitAll = (s) => exportUnchecked(s);

test(`XSD validator availability: ${st.available ? `${st.tool} ${st.version}` : 'NOT AVAILABLE — ' + st.reason}`, () => { assert.ok(true); });
const maybe = st.available ? test : (name) => test(name, (t) => t.skip(`XSD validator not available: ${st.reason}`));

maybe('Arelle: in-app example (standalone, auto-calculated totals, typed + explicit dimensions) — schema, XBRL 2.1, dimensions, formulas', () => {
  const r = run('example.xml', exampleSession().exportXml({ today: TODAY }).xml, { formulas: true });
  assert.equal(r.formulaMessages.length, 0, JSON.stringify(r.formulaMessages));
});

maybe('Arelle: consolidated filing with every mandatory element', () => { run('consolidated.xml', consolidatedSession().exportXml({ today: TODAY }).xml, { formulas: true }); });

maybe('Arelle: first financial year (current year only)', () => {
  run('first-year.xml', baseSession({ firstFinancialYear: true, periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '', end: '' } } }).exportXml({ today: TODAY }).xml);
});

maybe('Arelle: first-time adoption filing with the opening balance sheet of the previous year (third balance sheet)', () => {
  const s = exampleSession();
  s.setValue(q('WhetherCompanyHasAdoptedIndAsFirstTime'), 'CY', 'true');
  const pyo = { type: 'instant', date: addDays(s.filing.meta.periods.py.start, -1) };
  for (const f of s.filing.all().filter((x) => !x.dims.length && x.period.type === 'instant' && x.period.date === s.filing.meta.periods.py.end && A.conceptElrs(x.concept).some((u) => A.elr(u).code === '110000'))) s.filing.setFact({ ...f, period: pyo, origin: 'user' });
  const xml = emitAll(s);
  assert.match(xml, new RegExp(`<xbrli:instant>${pyo.date}</xbrli:instant>`));
  run('fta.xml', xml);
});

maybe('Arelle formula linkbase and the FX-* rules agree on a broken roll-forward (independent cross-check)', () => {
  const s = exampleSession();
  const cls = [{ axis: q('ClassesOfEquityShareCapitalAxis'), member: q('EquityShares1Member') }];
  s.setTableValue(T('DisclosureOfClassesOfEquityShareCapitalTable'), 'CY', cls, q('IncreaseDecreaseInEquityShareCapital'), '50000');
  const ours = A.rules.rules.filter((r) => r.family === 'formula' && r.status === 'EXECUTABLE' && runRule(s, r.id).fail).map((r) => r.ast.assertion).sort();
  const r = validateInstanceXml(emitAll(s), { label: 'fx.xml', formulas: true });
  assert.equal(r.status, 'PASS', 'schema/dimension valid; only the formula assertion is unsatisfied');
  const arelle = [...new Set(r.formulaMessages.map((m) => /crossPeriod_\w+/.exec(m.code + ' ' + m.message)?.[0]).filter(Boolean))].sort();
  assert.deepEqual(arelle, ['crossPeriod_EquityShareCapital']);
  assert.deepEqual(ours, arelle);
});

for (const f of readdirSync(new URL('./', import.meta.url).pathname).filter((x) => /^golden-.*\.xml$/.test(x))) {
  maybe(`Arelle: MCA-validated source ${f} and its regenerated instance`, () => {
    const xml = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    const src = run(f, xml, { formulas: true });
    assert.equal(src.formulaMessages.length, 0, JSON.stringify(src.formulaMessages.slice(0, 3)));
    const { s } = importSession(xml);
    // evaluation date after the filing (the fixtures' 2018 date precedes a 2023 instance's signing dates)
    const r = run('regen-' + f, s.exportXml({ today: new Date().toISOString().slice(0, 10) }).xml, { formulas: true });
    assert.equal(r.formulaMessages.length, 0, 'every formula assertion satisfied');
  });
}

maybe('Arelle genuinely rejects schema and dimension errors', () => {
  const xml = exampleSession().exportXml({ today: TODAY }).xml;
  const bad = xml.replace(/(<ind-as:Rent contextRef="D2018" unitRef="INR" decimals="0">)400000</, '$1four lakh<');
  assert.notEqual(bad, xml);
  const r = validateInstanceXml(bad, { label: 'bad.xml' });
  assert.equal(r.status, 'FAIL');
  assert.ok(r.errors.some((e) => /xmlSchema/.test(e.code)));
  const s = cloneSession(exampleSession());
  // a primary item of a closed hypercube reported with a foreign axis (XBRL Dimensions: dimensionally invalid)
  s.filing.setFact({ concept: q('PropertyPlantAndEquipment'), period: s.filing.period(q('PropertyPlantAndEquipment'), 'CY'), dims: [{ axis: q('ClassificationOfBorrowingsAxis'), member: q('BondsMember') }], value: '1', decimals: '0' });
  const f = s.filing.all().find((x) => x.concept === q('PropertyPlantAndEquipment') && x.dims.length);
  assert.ok(new Gate(A).run(s.filing, { today: TODAY }).issues.some((i) => i.code === 'dim.hypercube'), 'the internal gate also rejects it');
  const r2 = validateInstanceXml(generateInstance(A, s.filing, [...new Gate(A).run(s.filing, { today: TODAY }).emit, f]).xml, { label: 'dim.xml' });
  assert.equal(r2.status, 'FAIL');
  assert.ok(r2.errors.some((e) => /xbrldie|xbrldte|dimension/i.test(e.code + e.message)), JSON.stringify(r2.errors.slice(0, 3)));
});
