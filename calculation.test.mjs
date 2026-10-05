// Suite: calculations — every calculation relationship of the taxonomy is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, newSession } from './helpers.mjs';
import { exampleSession, T } from './fixtures.mjs';
import { CalculatedCellError } from './session.js';
import { calculationNetworks, runCalculations, CalcStatus } from './calculation.js';
import { dimensionallyValid, nondimAllowed } from './dimensions.js';
import { Filing } from './model.js';
import * as Dec from './decimal.js';

const A = authority();
const periods = { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } };

// Candidate contexts in which the parent is dimensionally valid (non-dimensional first, then
// combinations of usable members / defaults of the parent's tables).
function contextsFor(parent) {
  const out = [];
  if (nondimAllowed(A, parent)) out.push([]);
  for (const t of A.tablesForConcept(parent)) {
    let combos = [[]];
    for (const ax of t.axes) {
      const opts = ax.typed ? [{ axis: ax.axis, typed: '1' }] : [...(A.dimensionDefault(ax.axis) ? [null] : []), ...ax.members.filter((m) => m.usable && m.member !== A.dimensionDefault(ax.axis)).map((m) => ({ axis: ax.axis, member: m.member }))];
      const next = [];
      for (const c of combos) for (const o of opts) { next.push(o ? [...c, o] : c); if (next.length > 4000) break; }
      combos = next;
    }
    for (const c of combos) if (dimensionallyValid(A, parent, c).valid) out.push(c);
  }
  return out;
}

// For each network, every child arc is exercised in some context where parent and child are valid
// (children that are mutually exclusive through notAll are exercised in different contexts).
function plan(net) {
  const groups = new Map();
  const uncovered = [];
  const ctxs = contextsFor(net.parent);
  for (const c of net.children) {
    const ctx = ctxs.find((d) => dimensionallyValid(A, c.to, d).valid && A.concept(c.to).periodType === A.concept(net.parent).periodType);
    if (!ctx) { uncovered.push(c.to); continue; }
    const k = JSON.stringify(ctx);
    (groups.get(k) || groups.set(k, { dims: ctx, children: [] }).get(k)).children.push(c);
  }
  // put every child that is also valid in a group's context into that group (XBRL sums all present children)
  for (const g of groups.values()) for (const c of net.children) if (!g.children.includes(c) && dimensionallyValid(A, c.to, g.dims).valid && A.concept(c.to).periodType === A.concept(net.parent).periodType) g.children.push(c);
  return { groups: [...groups.values()], uncovered };
}

test('every calculation relationship: consistent values PASS, perturbed parent FAIL (per ELR)', () => {
  const nets = calculationNetworks(A);
  assert.equal(nets.reduce((n, x) => n + x.children.length, 0), A.meta.relationshipStats.calculationArcs, 'all calculation arcs are covered by networks');
  const covered = new Set();
  const uncovered = [];
  for (const net of nets) {
    const { groups, uncovered: u } = plan(net);
    uncovered.push(...u.map((c) => `${net.elr} ${net.parent} -> ${c}`));
    for (const g of groups) {
      const f = new Filing(A, { periods, cin: 'U00000XX0000XXX000000' });
      const per = (c) => f.period(c, 'CY');
      let total = Dec.ZERO;
      g.children.forEach((c, i) => {
        const v = String((i + 1) * 10);
        f.setFact({ concept: c.to, period: per(c.to), dims: g.dims, value: v, decimals: '0' });
        total = Dec.add(total, Dec.mul(v, String(c.weight)));
      });
      f.setFact({ concept: net.parent, period: per(net.parent), dims: g.dims, value: Dec.toString(total), decimals: '0' });
      const res = runCalculations(A, f).filter((r) => r.elr === net.elr && r.parent === net.parent);
      assert.equal(res.length, 1, `${net.elr} ${net.parent}`);
      assert.equal(res[0].status, CalcStatus.PASS, `${net.elr} ${net.parent}: ${res[0].reported} vs ${res[0].computed}`);
      f.setFact({ concept: net.parent, period: per(net.parent), dims: g.dims, value: Dec.toString(Dec.add(total, '1')), decimals: '0' });
      assert.equal(runCalculations(A, f).find((r) => r.elr === net.elr && r.parent === net.parent).status, CalcStatus.FAIL);
      for (const c of g.children) covered.add(`${net.elr}|${net.parent}|${c.to}`);
    }
  }
  assert.deepEqual(uncovered, [], 'every calculation arc can be exercised in a dimensionally valid context');
  assert.equal(covered.size, A.meta.relationshipStats.calculationArcs);
});

test('calculation trees of different ELRs are never merged', () => {
  // a parent present in several calculation ELRs is evaluated separately in each
  const nets = calculationNetworks(A);
  const multi = new Map();
  for (const n of nets) (multi.get(n.parent) || multi.set(n.parent, []).get(n.parent)).push(n);
  const [parent, list] = [...multi].find(([, l]) => l.length > 1 && new Set(l.map((x) => x.elr)).size > 1) || [];
  assert.ok(parent, 'taxonomy has a parent with networks in several ELRs');
  const f = new Filing(A, { periods });
  const dims = [];
  if (!nondimAllowed(A, parent)) return;
  f.setFact({ concept: parent, period: f.period(parent, 'CY'), value: '10', decimals: '0' });
  const res = runCalculations(A, f).filter((r) => r.parent === parent);
  assert.equal(new Set(res.map((r) => r.elr)).size, list.length);
  void dims;
});

test('rounding tolerance follows the lowest decimals (XBRL 2.1)', () => {
  const s = newSession({ level: 'Lakhs', displayPlaces: 2 });
  const f = s.filing;
  const net = calculationNetworks(A).find((n) => n.parent === q('CurrentFinancialAssets'));
  const p = f.period(q('CurrentFinancialAssets'), 'CY');
  f.setFact({ concept: q('CurrentInvestments'), period: p, value: '1234000', decimals: '-3' });
  f.setFact({ concept: q('TradeReceivablesCurrent'), period: p, value: '1000', decimals: '-3' });
  f.setFact({ concept: q('CurrentFinancialAssets'), period: p, value: '1235000', decimals: '-3' });
  const r = runCalculations(A, f).find((x) => x.elr === net.elr && x.parent === q('CurrentFinancialAssets'));
  assert.equal(r.status, CalcStatus.PASS);
  assert.equal(r.decimals, -3);
});

test('GR-1: non-zero parent without children fails; zero parent does not', async () => {
  const { RuleEngine } = await import('./rules.js');
  const s = newSession();
  s.setValue(q('CurrentAssets'), 'CY', '0');
  let res = new RuleEngine(A).run(s.filing, { today: '2018-09-30' });
  assert.ok(!res.results.some((r) => r.ruleId === 'GR-1' && r.status === 'FAIL' && /CurrentAssets'? is entered/.test(r.message)));
  s.setValue(q('CurrentAssets'), 'CY', '100');
  res = new RuleEngine(A).run(s.filing, { today: '2018-09-30' });
  assert.ok(res.results.some((r) => r.ruleId === 'GR-1' && r.status === 'FAIL' && /none of its calculation children/.test(r.message)));
});

test('auto-population: totals are derived bottom-up from leaf entries (balance sheet, P&L, cash flow)', () => {
  const s = exampleSession();
  const v = (l, sc = 'CY') => s.getValue(q(l), sc);
  for (const [l, cy, py] of [['CashAndCashEquivalents', '1850000', '1520000'], ['CurrentAssets', '2300000', '1820000'], ['Assets', '2300000', '1820000'], ['Equity', '2000000', '1600000'], ['EquityAndLiabilities', '2300000', '1820000'], ['ProfitBeforeTax', '540000', '300000'], ['ProfitLossForPeriod', '400000', '200000'], ['CashFlowsFromUsedInOperatingActivities', '330000', '320000']]) {
    assert.equal(v(l).value, cy, l); assert.equal(v(l, 'PY').value, py, l + ' PY');
    assert.equal(v(l).origin, 'calculated', l);
  }
  // an edit re-derives every ancestor in the same context
  s.setValue(q('CashOnHand'), 'CY', '60000', { recalc: true });
  assert.equal(v('CashAndCashEquivalents').value, '1860000');
  assert.equal(v('Assets').value, '2310000');
});

test('calculated cells: locked on their tab unless the tab override is on; overrides are kept and checked by GR-1', () => {
  const s = exampleSession();
  const bs = A.elrByCode('110000').uri;
  assert.throws(() => s.setValue(q('CurrentAssets'), 'CY', '1', { tab: bs }), CalculatedCellError);
  const f = s.setValue(q('CurrentAssets'), 'CY', '2300001', { tab: bs, override: true });
  assert.equal(f.origin, 'override');
  s.setValue(q('CashOnHand'), 'CY', '60000', { recalc: true }); // never replaces an override
  assert.equal(s.getValue(q('CurrentAssets'), 'CY').value, '2300001');
  const g = s.validate({ today: '2018-09-30' });
  assert.ok(g.issues.some((i) => i.ruleId === 'GR-1' && i.severity === 'ERROR'));
});

test('roll-forward auto-population (formula linkbase): closing = opening + change, only where the change is reported', () => {
  const s = exampleSession();
  const SC = T('DisclosureOfClassesOfEquityShareCapitalTable');
  const cls = [{ axis: q('ClassesOfEquityShareCapitalAxis'), member: q('EquityShares1Member') }];
  for (const f of s.filing.factsOf(q('EquityShareCapital')).filter((x) => x.dims.length && x.period.date === s.filing.meta.periods.cy.end)) s.filing.removeFact(f.key);
  s.setTableValue(SC, 'CY', cls, q('IncreaseDecreaseInEquityShareCapital'), '50000', { recalc: true });
  const closing = s.filing.get(q('EquityShareCapital'), { type: 'instant', date: s.filing.meta.periods.cy.end }, cls);
  assert.equal(closing.value, '1050000');
  assert.equal(closing.origin, 'calculated');
  s.setTableValue(SC, 'CY', cls, q('EquityShareCapital'), '1060000'); // typed closing wins; FX-* reports the difference
  s.setTableValue(SC, 'CY', cls, q('IncreaseDecreaseInEquityShareCapital'), '40000', { recalc: true });
  assert.equal(s.filing.get(q('EquityShareCapital'), { type: 'instant', date: s.filing.meta.periods.cy.end }, cls).value, '1060000');
  assert.deepEqual(s.rollForward(q('EquityShareCapital')).asBalance.map((x) => x.change), [q('IncreaseDecreaseInEquityShareCapital')]);
});

test('XBRL Calculations 1.1: round-to-nearest at the lowest decimals of the facts in the summation', () => {
  const s = newSession();
  const f = s.filing;
  const P = q('CurrentFinancialAssets');
  const p = f.period(P, 'CY');
  const net = calculationNetworks(A).find((n) => n.parent === P);
  f.setFact({ concept: q('TradeReceivablesCurrent'), period: p, value: '1240', decimals: '-1' });
  f.setFact({ concept: q('CurrentInvestments'), period: p, value: '1250', decimals: '-2' }); // 1250 → 1300 (half away from zero)
  f.setFact({ concept: P, period: p, value: '2500', decimals: '-2' });
  const r = runCalculations(A, f).find((x) => x.elr === net.elr && x.parent === P);
  assert.equal(r.decimals, -2);
  assert.equal(r.status, CalcStatus.PASS, `${r.reported} vs ${r.computed}`); // round(1240,-2)=1200 + 1300 = 2500
  f.setFact({ concept: P, period: p, value: '2600', decimals: '-2' });
  assert.equal(runCalculations(A, f).find((x) => x.elr === net.elr && x.parent === P).status, CalcStatus.FAIL);
});
