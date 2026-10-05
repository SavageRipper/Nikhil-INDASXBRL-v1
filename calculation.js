// Calculation engine — derived exclusively from the taxonomy calculation linkbase.
// Each calculation ELR is evaluated on its own (no merging of trees across ELRs).
// For every reported parent fact, children are taken from the same context (period + dimensions).
// Consistency (XBRL Calculations 1.1, round-to-nearest): Σ(child × weight) is computed from the reported
// (unrounded) child values and compared with the parent after rounding both to the lowest `decimals` among the
// participating facts. (XBRL 2.1 §5.2.5.2 rounded every child first; the MCA-validated CHARVAK instance — children
// with 2 fraction digits at decimals="INF" next to a 0 at decimals="0" — is consistent only under 1.1.)
import * as Dec from './decimal.js';

export const CalcStatus = { PASS: 'PASS', FAIL: 'FAIL', NOT_APPLICABLE: 'NOT_APPLICABLE', INSUFFICIENT_DATA: 'INSUFFICIENT_DATA' };

function minDecimals(facts) {
  let m = Infinity;
  for (const f of facts) { const d = f.decimals === 'INF' || f.decimals == null ? Infinity : Number(f.decimals); if (d < m) m = d; }
  return m;
}

export function calculationNetworks(A) {
  const nets = [];
  for (const [elr, arcs] of Object.entries(A.json.calculation)) {
    const byParent = new Map();
    for (const a of arcs) (byParent.get(a.from) || byParent.set(a.from, []).get(a.from)).push(a);
    for (const [parent, children] of byParent) nets.push({ elr, parent, children: children.sort((x, y) => x.order - y.order) });
  }
  return nets;
}

// isElrApplicable(elrUri) lets the caller drop calculation ELRs that do not apply (e.g. the
// cash-flow method not selected); those report NOT_APPLICABLE.
export function runCalculations(A, filing, { isElrApplicable = () => true } = {}) {
  const results = [];
  const index = new Map();
  for (const f of filing.all()) {
    const k = `${f.concept}#${ctxOf(f)}`;
    index.set(k, f);
  }
  const contexts = new Map(); // ctx -> facts
  for (const f of filing.all()) (contexts.get(ctxOf(f)) || contexts.set(ctxOf(f), []).get(ctxOf(f))).push(f);

  for (const net of calculationNetworks(A)) {
    const parentFacts = filing.factsOf(net.parent).filter((f) => !f.nil);
    for (const pf of parentFacts) {
      const ctx = ctxOf(pf);
      const base = { elr: net.elr, parent: net.parent, period: pf.period, dims: pf.dims, factKey: pf.key };
      if (!isElrApplicable(net.elr)) { results.push({ ...base, status: CalcStatus.NOT_APPLICABLE }); continue; }
      const kids = [];
      for (const a of net.children) {
        // a child's context matches the parent's (same period type is required by XBRL for summation)
        const cf = index.get(`${a.to}#${ctx}`);
        if (cf && !cf.nil) kids.push({ fact: cf, weight: a.weight });
      }
      if (!kids.length) { results.push({ ...base, status: CalcStatus.INSUFFICIENT_DATA, children: [] }); continue; }
      const d = minDecimals([pf, ...kids.map((k) => k.fact)]);
      const r = (v) => Dec.round(Dec.parse(v), d === Infinity ? 'INF' : d);
      const total = r(Dec.toString(Dec.sum(kids.map((k) => Dec.mul(Dec.parse(k.fact.value), Dec.parse(String(k.weight)))))));
      const pv = r(pf.value);
      const ok = Dec.eq(total, pv);
      results.push({
        ...base, status: ok ? CalcStatus.PASS : CalcStatus.FAIL,
        reported: Dec.toString(pv), computed: Dec.toString(total), decimals: d === Infinity ? 'INF' : d,
        children: kids.map((k) => ({ concept: k.fact.concept, value: k.fact.value, weight: k.weight })),
        missingChildren: net.children.filter((a) => !kids.some((k) => k.fact.concept === a.to)).map((a) => a.to),
      });
    }
  }
  return results;
}

export function ctxOf(f) {
  const p = f.period.type === 'instant' ? f.period.date : `${f.period.start}/${f.period.end}`;
  return `${p}#${f.dims.map((d) => `${d.axis}=${d.member ?? d.typed}`).join('|')}`;
}
