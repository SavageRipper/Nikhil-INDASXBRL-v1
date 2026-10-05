// Expression / predicate evaluator shared by the business-rule engine and the
// applicability engine. Three-valued logic: true / false / null (not determinable).
import * as Dec from './decimal.js';
import { dimKey } from './model.js';
import { dimensionallyValid, factInTable } from './dimensions.js';

export const FORMATS = {
  // Corporate Identity Number structure published by MCA: listing status, 5-digit industry code,
  // state code, year of incorporation, ownership, 6-digit registration number (21 chars;
  // the taxonomy type in-ca-types:CINNumber fixes length 21).
  CIN: /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/,
  // in-ca-types:PANNumber pattern from the taxonomy.
  PAN: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  DIN: /^\d{8}$/,
  // Filing Manual Annexure II #9: membership number of the auditor — numeric only
  NUMERIC: /^\d+$/,
};

function typed(A, concept, raw) {
  if (raw == null) return null;
  if (A.isNumeric(concept)) return Dec.parse(raw);
  const t = A.dataType(concept);
  if (t === 'boolean') return raw === 'true';
  return raw;
}

export function factValue(env, concept, dims, scopeOverride) {
  const { filing, A } = env;
  const v = filing.value(concept, scopeOverride || env.scope, dims);
  return typed(A, concept, v);
}

// ISO date arithmetic (calendar months; day clamped to the month length).
export function addMonths(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export function addDays(iso, n) {
  const t = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

function factsInScope(env, concept) {
  const period = env.filing.period(concept, env.scope);
  if (!period) return [];
  return env.filing.factsOf(concept).filter((f) => !f.nil && f.value != null && samePeriod(f.period, period));
}

export function evalExpr(e, env) {
  if (e == null) return null;
  if (e.self) return env.self == null ? null : typed(env.A, env.self.concept, env.self.nil ? null : env.self.value);
  if (e.fact) return factValue(env, e.fact, e.ctx === 'nondim' ? [] : env.dims || [], e.scope);
  if (e.addMonths) { const v = evalExpr(e.addMonths.e, env); return isIsoDate(v) ? addMonths(v.trim(), e.addMonths.n) : null; }
  if (e.addDays) { const v = evalExpr(e.addDays.e, env); return isIsoDate(v) ? addDays(v.trim(), e.addDays.n) : null; }
  if (e.avgAxis) {
    const picked = sumAxisFacts(e.avgAxis, env);
    if (!picked || !picked.length) return null;
    return Dec.div(Dec.sum(picked.map((f) => Dec.parse(f.value))), picked.length);
  }
  if (e.maxFacts) {
    const vals = e.maxFacts.flatMap((q) => factsInScope(env, q)).map((f) => String(f.value).trim()).filter(isIsoDate);
    return vals.length ? vals.sort().at(-1) : null;
  }
  if ('const' in e) return typeof e.const === 'number' ? Dec.parse(e.const) : e.const;
  if (e.today) return env.today;
  if (e.upper) { const v = evalExpr(e.upper, env); return v == null ? null : String(v).toUpperCase().trim(); }
  if (e.mul) { const vs = e.mul.map((x) => evalExpr(x, env)); return vs.some((v) => v == null) ? null : vs.reduce((a, b) => Dec.mul(a, b)); }
  if (e.add) { const vs = e.add.map((x) => evalExpr(x, env)); return vs.some((v) => v == null) ? null : Dec.sum(vs); }
  if (e.sumAxis) return sumAxis(e.sumAxis, env);
  // Σ of several operands where a missing operand counts as 0; null only when every operand is missing
  if (e.sumOf) { const vs = e.sumOf.map((x) => evalExpr(x, env)); return vs.every((v) => v == null) ? null : Dec.sum(vs.filter((v) => v != null)); }
  throw new Error('Unknown expression ' + JSON.stringify(e));
}

// Σ of a concept's dimensional facts along an axis.
//  level 'all'        every member/typed value on the axis
//  level 'members'    listed members only
//  level 'pattern'    members whose local name matches `pattern`
//  level 'firstLevel' first-level children of the domain; a first-level member that is not
//                     reported is replaced by its reported descendants (MCA rule text)
// `fixed` pins other axes to a member; other axes must be absent unless anyOther.
export function sumAxis(spec, env) {
  const picked = sumAxisFacts(spec, env);
  if (!picked || !picked.length) return null;
  return Dec.sum(picked.map((f) => Dec.parse(f.value)));
}
function sumAxisFacts(spec, env) {
  const { filing, A, scope } = env;
  const period = filing.period(spec.concept, scope);
  if (!period) return null;
  const facts = filing.factsOf(spec.concept).filter((f) => !f.nil && f.value != null && samePeriod(f.period, period));
  const fixed = spec.fixed || {};
  const candidates = facts.filter((f) => {
    const on = f.dims.find((d) => d.axis === spec.axis);
    if (!on) return false;
    for (const [ax, mem] of Object.entries(fixed)) if (!f.dims.some((d) => d.axis === ax && d.member === mem)) return false;
    if (!spec.anyOther) for (const d of f.dims) if (d.axis !== spec.axis && !(d.axis in fixed)) return false;
    return true;
  });
  const memberOf = (f) => { const d = f.dims.find((x) => x.axis === spec.axis); return d.member ?? `"${d.typed}"`; };
  let picked;
  if (spec.level === 'all') picked = candidates;
  else if (spec.level === 'members') picked = candidates.filter((f) => spec.members.includes(memberOf(f)));
  else if (spec.level === 'pattern') { const re = new RegExp(spec.pattern); picked = candidates.filter((f) => re.test(memberOf(f).split(':').pop())); }
  else if (spec.level === 'firstLevel') {
    const info = A.axisInfo(spec.axis);
    const children = new Map();
    for (const [m, p] of info.parents) (children.get(p) || children.set(p, []).get(p)).push(m);
    const roots = [...info.members.values()].filter((m) => !info.parents.has(m.member)).map((m) => m.member);
    const byMember = new Map();
    for (const f of candidates) byMember.set(memberOf(f), f);
    picked = [];
    const take = (m) => {
      if (byMember.has(m)) { picked.push(byMember.get(m)); return; }
      for (const c of children.get(m) || []) take(c);
    };
    for (const r of roots) for (const c of children.get(r) || []) take(c);
  } else throw new Error('Unknown sumAxis level ' + spec.level);
  return picked;
}

function tableFacts(env, tableId) {
  const { filing, A, scope } = env;
  const t = A.table(tableId);
  if (!t) return [];
  const items = new Set(t.lineItems);
  const axes = new Set(t.axes.map((x) => x.axis));
  return filing.all().filter((f) => items.has(f.concept) && !f.nil && f.dims.length && f.dims.every((d) => axes.has(d.axis)) && filing.scopeOf(f.period) === scope && factInTable(A, f, t));
}

function samePeriod(a, b) { return a.type === b.type && (a.type === 'instant' ? a.date === b.date : a.start === b.start && a.end === b.end); }

function compare(cmp, l, r) {
  let c;
  if (l && typeof l === 'object' && 'n' in l && r && typeof r === 'object' && 'n' in r) c = Dec.cmp(l, r);
  else if (typeof l === 'boolean' || typeof r === 'boolean') { if (cmp === '==') return l === r; if (cmp === '!=') return l !== r; return null; }
  else { const a = String(l), b = String(r); c = a < b ? -1 : a > b ? 1 : 0; }
  switch (cmp) {
    case '==': return c === 0; case '!=': return c !== 0; case '>': return c > 0; case '>=': return c >= 0; case '<': return c < 0; case '<=': return c <= 0;
    default: throw new Error('Unknown comparator ' + cmp);
  }
}

export function evalPred(p, env) {
  if (!p) return true;
  switch (p.op) {
    case 'entered': {
      if (p.e.fact) {
        let dims = p.e.ctx === 'nondim' ? [] : env.dims || [];
        // an element that cannot carry the trigger's dimensions is reported without dimensions
        if (dims.length && !dimensionallyValid(env.A, p.e.fact, dims).valid) dims = [];
        return env.filing.value(p.e.fact, env.scope, dims) != null;
      }
      return evalExpr(p.e, env) != null;
    }
    case 'cmp': {
      const l = evalExpr(p.l, env);
      let r = evalExpr(p.r, env);
      if (l == null || r == null) return null;
      // "equivalent to" a computed value: the computed value is rounded to the precision of the
      // reported value (its decimals attribute, else its own fraction digits)
      if (p.approx && l && typeof l === 'object' && 'n' in l && r && typeof r === 'object' && 'n' in r) {
        const dec = env.self && env.self.decimals != null && env.self.decimals !== 'INF' ? Number(env.self.decimals) : Dec.fractionDigits(l);
        r = Dec.round(r, dec);
      }
      return compare(p.cmp, l, r);
    }
    case 'notInFacts': {
      const v = evalExpr(p.e, env);
      if (v == null) return null;
      const others = factsInScope(env, p.concept).filter((f) => !env.self || f.key !== env.self.key);
      return !others.some((f) => String(f.value).trim().toUpperCase() === String(v).trim().toUpperCase());
    }
    case 'existsFact': return factsInScope(env, p.concept).some((f) => evalPred(p.pred, { ...env, self: f, dims: f.dims }) === true);
    case 'iff': { const a = evalPred(p.args[0], env), b = evalPred(p.args[1], env); return a == null || b == null ? null : a === b; }
    case 'tableData': return p.tables.some((id) => tableFacts(env, id).length > 0);
    case 'memberHasData': return p.tables.some((id) => tableFacts(env, id).some((f) => f.dims.some((d) => d.member === p.member)));
    case 'and': { let unk = false; for (const a of p.args) { const v = evalPred(a, env); if (v === false) return false; if (v == null) unk = true; } return unk ? null : true; }
    case 'or': { let unk = false; for (const a of p.args) { const v = evalPred(a, env); if (v === true) return true; if (v == null) unk = true; } return unk ? null : false; }
    case 'not': { const v = evalPred(p.arg, env); return v == null ? null : !v; }
    case 'reportType': return env.filing.meta.reportType === p.value;
    case 'format': {
      const v = evalExpr(p.e, env);
      if (v == null) return null;
      if (p.format === 'country') return env.countries.has(String(v).trim().toUpperCase());
      if (p.format === 'currency') return (env.currencies || new Set()).has(String(v).trim().toUpperCase());
      return FORMATS[p.format].test(String(v).trim());
    }
    case 'anyFact': {
      const period = env.filing.period(p.concept, env.scope);
      const facts = env.filing.factsOf(p.concept).filter((f) => !f.nil && samePeriod(f.period, period));
      if (!facts.length) return null;
      return facts.some((f) => evalPred(p.pred, { ...env, self: f, dims: f.dims }) === true);
    }
    case 'hasMember': return (env.dims || []).some((d) => d.member === p.member && (!p.axis || d.axis === p.axis));
    default: throw new Error('Unknown predicate ' + p.op);
  }
}

export function ctxKey(dims) { return dimKey(dims); }
