// Rule-by-rule audit of the compiled MCA business rules (mutation testing against the real engine).
//
// For every EXECUTABLE rule the audit tries to build two filings from a clean base filing:
//   PASS witness — the rule is activated (its condition made true, its subject reported) and evaluates PASS;
//   FAIL witness — one mutation that violates the rule (value removed or changed) and the rule evaluates FAIL.
// Each witness is checked by running ONLY that rule through the production RuleEngine (rules.js), so a rule is
// "VERIFIED" only when the engine both accepts a compliant filing and rejects a violating one. Rules whose AST shape
// has no automatic witness builder are reported as COVERED_BY_TEST (family tests in rule-families.test.mjs) — never
// as verified. Nothing here changes the engine; it only exercises it.
import { Session } from './session.js';
import { Filing, dimKey } from './model.js';
import { RuleEngine } from './rules.js';
import { buildExample, completeMandatory, sampleValue } from './example.js';
import { dimensionallyValid, nondimAllowed } from './dimensions.js';
import { reportingYear, addDays } from './periods.js';
import { evalPred, evalExpr } from './expr.js';
import * as Dec from './decimal.js';

export const AUDIT_TODAY = '2018-09-30';
const CIN2 = 'U72200KA2010PTC654321';

export function auditBases(A) {
  const P = { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } };
  const sa = new Session(A); buildExample(sa);
  const co = new Session(A);
  co.setMeta({ name: 'Audit Group Ltd', cin: 'U72200KA2010PLC123456', reportType: 'Consolidated', level: 'Actual', displayPlaces: 0, periods: P });
  completeMandatory(co, { name: 'Audit Group Limited' });
  return { Standalone: sa, Consolidated: co };
}

export function auditRules(A, { ids = null, bases = null } = {}) {
  const engine = new RuleEngine(A);
  const B = bases || auditBases(A);
  const out = [];
  for (const r of A.rules.rules) {
    if (ids && !ids.has(r.id)) continue;
    if (r.status !== 'EXECUTABLE') { out.push({ id: r.id, status: r.status, evidence: 'not executable', reason: r.reason || null }); continue; }
    if (!r.ast) { out.push({ id: r.id, status: 'DATA', evidence: r.implementation || 'data rows consumed by a generic rule' }); continue; }
    const builder = BUILDERS[r.ast.type];
    if (!builder || (r.ast.type === 'assert' && !assertBuildable(r.ast))) { out.push({ id: r.id, status: 'COVERED_BY_TEST', evidence: familyTest(r) }); continue; }
    let best = null;
    for (const base of baseOrder(A, r, B)) {
      const W = new Witness(A, engine, r, base);
      let res;
      try { res = builder(W); } catch (e) { res = { pass: false, fail: false, note: 'builder error: ' + e.message }; }
      const rec = { id: r.id, base: base.filing.meta.reportType, pass: !!res.pass, fail: !!res.fail, note: res.note || null, passNote: res.passNote || null, failNote: res.failNote || null };
      if (!best || score(rec) > score(best)) best = rec;
      if (rec.pass && rec.fail) break;
    }
    best.status = best.pass && best.fail ? 'VERIFIED' : best.pass || best.fail ? 'PARTIAL' : 'NOT_WITNESSED';
    if (best.status !== 'VERIFIED' && FALLBACK_TESTS[r.implementation]) best.evidence = FALLBACK_TESTS[r.implementation];
    out.push(best);
  }
  const summary = {};
  for (const x of out) summary[x.status] = (summary[x.status] || 0) + 1;
  return { today: AUDIT_TODAY, summary, results: out };
}
const score = (x) => (x.pass ? 1 : 0) + (x.fail ? 1 : 0);
function baseOrder(A, r, B) {
  const when = JSON.stringify(r.ast.when || '');
  if (/"reportType","value":"Consolidated"/.test(when) || /consolidated/i.test(r.implementation || '')) return [B.Consolidated, B.Standalone];
  return [B.Standalone, B.Consolidated];
}
const ASSERT_IMPLS = new Set(['curated:typed-members-eq-total', 'curated:typed-members-sum', 'pattern:sum-two-eq', 'curated:biological-assets-sum', 'curated:trade-receivables-security-sum', 'curated:typed-members-carrying-sum', 'curated:classes-carrying-sum', 'curated:ppe-classes-sum']);
function assertBuildable(a) {
  const p = a.assert;
  return p && p.op === 'cmp' && p.cmp === '==' && (p.l.sumAxis || p.l.sumOf || p.l.add) && p.r.fact && !a.when;
}
function familyTest(r) {
  const impl = r.implementation || '';
  if (impl.startsWith('generic:')) return 'rule-families.test.mjs#generic ' + impl.slice(8);
  if (impl.startsWith('curated:') || impl.startsWith('pattern:')) return 'rule-families.test.mjs#curated ' + impl.split(':')[1];
  return 'rule-families.test.mjs';
}
const FALLBACK_TESTS = {};

// ---------------------------------------------------------------------------------------------- witness toolkit
class Witness {
  constructor(A, engine, rule, base) { this.A = A; this.engine = engine; this.r = rule; this.base = base; }
  clone(S = this.base) { return new Session(this.A, Filing.fromJSON(this.A, S.filing.toJSON())); }
  run(S, scope = null) {
    const res = this.engine.run(S.filing, { today: AUDIT_TODAY, only: new Set([this.r.id]) }).results.filter((x) => x.ruleId === this.r.id && (!scope || x.scope === scope || x.scope == null));
    return { pass: res.some((x) => x.status === 'PASS'), fail: res.some((x) => x.status === 'FAIL' || x.status === 'WARN'), engineError: res.find((x) => x.engineError)?.message || null, res };
  }
  env(S, scope, extra = {}) { return S.app.env(S.filing, scope, { today: AUDIT_TODAY, ...extra }); }
  scopes() { return (this.r.scope?.periods || ['CY', 'PY']).filter((s) => s === 'CY' || s === 'PY'); }

  // contexts in which a concept can be reported for a scope: [] (non-dimensional) or a table row
  contexts(S, concept, scope, { limit = 4, member = null, activate = true } = {}) {
    const A = this.A;
    const out = [];
    // contexts the base filing already uses for this concept (rows with related data) come first
    for (const f of S.filing.factsOf(concept)) {
      if (out.length >= 2 || reportingYear(S.filing.meta.periods, f.period) !== scope || S.filing.scopeOf(f.period) === 'PYO') continue;
      if (member && !f.dims.some((d) => d.member === member)) continue;
      const c = this.ctxForDims(concept, f.dims);
      if (c && !out.some((x) => dimKey(x.dims) === dimKey(c.dims))) out.push(c);
    }
    if (!member && nondimAllowed(A, concept) && !out.some((x) => !x.dims.length)) out.push({ tableId: null, dims: [] });
    for (const t of A.tablesForConcept(concept)) {
      if (out.length >= limit) break;
      if (member && !t.axes.some((x) => (x.members || []).some((m) => m.member === member))) continue;
      if (!S.tableStatus(t.id, scope).applicable && !(activate && this.activateTable(S, t.id, scope))) continue;
      for (const dims of this.combos(S, t, scope, concept, member)) { out.push({ tableId: t.id, dims }); break; }
    }
    return out;
  }
  combos(S, t, scope, concept, member = null, max = 400) {
    const A = this.A;
    const lists = t.axes.map((x) => {
      if (x.typed) return [{ axis: x.axis, typed: S.suggestTypedValue(t.id, scope, x.axis) }];
      const def = A.dimensionDefault(x.axis);
      let ms = (x.members || []).filter((m) => m.usable && m.member !== def);
      if (member && ms.some((m) => m.member === member)) ms = ms.filter((m) => m.member === member);
      ms = [...ms].sort((a, b) => (a.depth ?? 9) - (b.depth ?? 9));
      const opts = ms.slice(0, 12).map((m) => ({ axis: x.axis, member: m.member }));
      if (def) opts.push(null); // the default member = axis omitted
      return opts;
    });
    const res = [];
    const rec = (i, acc) => {
      if (res.length >= 3 || max-- <= 0) return;
      if (i === lists.length) {
        const dims = acc.filter(Boolean);
        if (!dims.length) return;
        if (member && !dims.some((d) => d.member === member)) return;
        if (!concept || dimensionallyValid(A, concept, dims).valid) res.push(dims);
        return;
      }
      for (const o of lists[i]) rec(i + 1, [...acc, o]);
    };
    rec(0, []);
    return res;
  }
  // make a conditional table applicable by satisfying one of its MCA conditions (guarded against recursion:
  // activating a table may need a row in another conditional table)
  activateTable(S, tableId, scope) {
    if (S.tableStatus(tableId, scope).applicable) return true;
    this._active ||= new Set();
    const key = tableId + '|' + scope;
    if (this._active.has(key) || this._active.size > 4) return false;
    this._active.add(key);
    try {
      const conds = this.A.rules.tableApplicability[tableId] || [];
      for (const c of conds) if (this.satisfy(S, c.when, scope, [], 2) && S.tableStatus(tableId, scope).applicable) return true;
      // Bonds/Debentures details: available when Bonds/Debentures borrowings are reported (tableIffMembers)
      const bonds = this.A.rules.rules.find((r) => r.status === 'EXECUTABLE' && r.ast?.type === 'tableIffMembers' && r.ast.tables.includes(tableId));
      if (bonds) for (const id of bonds.ast.otherTables) for (const m of bonds.ast.members) if (this.addRow(S, id, scope, { member: m }) && S.tableStatus(tableId, scope).applicable) return true;
      return S.tableStatus(tableId, scope).applicable;
    } finally { this._active.delete(key); }
  }
  // make a concept applicable: answer its Yes/No questions with the condition that includes it
  guard(key, fn) {
    this._g ||= new Set();
    if (this._g.has(key) || this._g.size > 6) return false;
    this._g.add(key);
    try { return fn(); } finally { this._g.delete(key); }
  }
  makeApplicable(S, concept, scope) {
    if (S.conceptStatus(concept, scope).applicable) return true;
    for (const d of S.app.depsByChild.get(concept) || []) {
      this.putAny(S, d.parentConcept, scope, String(d.condition));
      if (S.conceptStatus(concept, scope).applicable) return true;
    }
    return S.conceptStatus(concept, scope).applicable;
  }
  put(S, concept, scope, ctx, value, preferredLabel = null) {
    try {
      if (ctx.tableId) S.setTableValue(ctx.tableId, scope, ctx.dims, concept, String(value), { preferredLabel });
      else S.setValue(concept, scope, String(value), { preferredLabel });
      return null;
    } catch (e) { return e.message || String(e); }
  }
  // set a concept at the first context that accepts it
  putAny(S, concept, scope, value, { dims = null, member = null } = {}) {
    if (!S.conceptStatus(concept, scope).applicable && !this.guard('app:' + concept + scope, () => this.makeApplicable(S, concept, scope))) return null;
    const ctxs = dims ? [this.ctxForDims(concept, dims)].filter(Boolean) : this.contexts(S, concept, scope, { member });
    for (const c of ctxs) if (!this.put(S, concept, scope, c, value)) return c;
    return null;
  }
  ctxForDims(concept, dims) {
    if (!dims.length) return nondimAllowed(this.A, concept) ? { tableId: null, dims: [] } : null;
    if (!dimensionallyValid(this.A, concept, dims).valid) return null;
    const axes = new Set(dims.map((d) => d.axis));
    const t = this.A.tablesForConcept(concept).find((x) => x.axes.length >= axes.size && [...axes].every((a) => x.axes.some((y) => y.axis === a)));
    return t ? { tableId: t.id, dims } : null;
  }
  remove(S, concept, scope, dims = null) {
    for (const f of S.filing.factsOf(concept)) {
      if (reportingYear(S.filing.meta.periods, f.period) !== scope || S.filing.scopeOf(f.period) === 'PYO') continue;
      if (dims && dimKey(f.dims) !== dimKey(dims)) continue;
      S.filing.removeFact(f.key);
    }
  }
  removeTableData(S, tableIds, scope) {
    for (const id of tableIds) {
      const t = this.A.table(id);
      const items = new Set(t.lineItems), axes = new Set(t.axes.map((x) => x.axis));
      for (const f of S.filing.all()) if (items.has(f.concept) && f.dims.length && f.dims.every((d) => axes.has(d.axis)) && reportingYear(S.filing.meta.periods, f.period) === scope) S.filing.removeFact(f.key);
    }
  }
  // add one row to a table (one reportable, applicable line item filled)
  addRow(S, tableId, scope, { member = null, avoid = new Set(), value = null } = {}) {
    const A = this.A;
    const t = A.table(tableId);
    if (!S.tableStatus(tableId, scope).applicable && !this.activateTable(S, tableId, scope)) return null;
    const items = t.lineItems.filter((q) => A.isReportable(q) && !A.concept(q).abstract && !avoid.has(q) && S.conceptStatus(q, scope).applicable);
    items.sort((a, b) => (A.isNumeric(b) ? 1 : 0) - (A.isNumeric(a) ? 1 : 0));
    for (const q of items.slice(0, 25)) {
      for (const dims of this.combos(S, t, scope, q, member)) {
        const v = value ?? this.sample(S, q, scope);
        if (!this.put(S, q, scope, { tableId, dims }, v)) return { tableId, dims, concept: q };
      }
    }
    return null;
  }
  sample(S, q, scope) {
    const A = this.A;
    if (A.isNumeric(q)) return A.dataType(q) === 'percent' ? '0.1' : '10';
    return sampleValue(A, q, { pan: 7 }, S.filing.meta.periods.cy.end);
  }
  // candidate values for a concept: type-driven pool + values derived from an expression being compared with
  candidates(S, q, extra = []) {
    const A = this.A;
    const t = A.dataType(q);
    const P = S.filing.meta.periods;
    const derived = [];
    for (const x of extra) {
      if (x == null) continue;
      if (typeof x === 'object' && 'n' in x) for (const d of [0, 1, -1, 2]) derived.push(Dec.toString(Dec.add(x, Dec.parse(String(d)))));
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(x))) derived.push(String(x), addDays(String(x), 1), addDays(String(x), -1), addDays(String(x), 400), addDays(String(x), -400));
      else derived.push(String(x), String(x) + 'X');
    }
    let pool;
    if (t === 'boolean') pool = ['true', 'false'];
    else if (t === 'enum') pool = A.enumerations(q);
    else if (A.isNumeric(q)) pool = ['10', '0', '-10', '1', '0.5', '0.6', '100', '1000', '1.5', '2', '0.1', '1000000'];
    else if (t === 'date') pool = [addDays(AUDIT_TODAY, -1), addDays(AUDIT_TODAY, 1), P.cy.end, P.cy.start, P.py.end, P.py.start, addDays(P.cy.end, 40), '2018-05-10', '1970-01-01', '2010-01-01', '2016-11-08', '2016-12-30', '2100-01-01', '2015-03-31', '2015-04-01'];
    else if (t === 'textBlock') pool = ['Nil'];
    else {
      const cin = S.filing.meta.cin || '';
      const pan = S.filing.value(A.qnameOfLocal('PermanentAccountNumberOfEntity'), 'CY', []) || 'AAACE1234A';
      pool = ['Sample', 'INDIA', 'india', 'INR', 'USD', 'Others', 'OTHERS', 'Other', CIN2, cin, 'ABCDE1234F', 'ABCDE5678G', pan, '00012345', 'Auditors firm', 'Directly by company', 'DIRECTLY BY COMPANY', 'Power', 'Equity shares', '1', 'X1', 'invalid value', 'abcde1234f', 'Individual'];
      for (const e of A.enumerations(q) || []) pool.push(e);
    }
    if (t === 'enum' || t === 'boolean') return [...new Set([...derived.filter((v) => pool.includes(v)), ...pool])];
    return [...new Set([...derived, ...pool])];
  }

  // ---- predicate solver: mutate S until evalPred(p) is `want` (true/false); returns success
  solve(S, p, scope, dims = [], want = true, depth = 3, self = null) {
    const env = () => this.env(S, scope, self ? { self: S.filing.facts.get(self.key) || self, dims: self.dims } : { dims });
    const ok = () => { try { return evalPred(p, env()) === want; } catch { return false; } };
    if (!p) return want;
    if (ok()) return true;
    if (depth <= 0) return false;
    switch (p.op) {
      case 'and': case 'or': {
        const all = (p.op === 'and') === want; // every arg must reach `want`
        if (all) { for (const a of p.args) if (!this.solve(S, a, scope, dims, want, depth - 1, self)) return false; return ok(); }
        for (const a of p.args) if (this.solve(S, a, scope, dims, want, depth - 1, self)) return ok();
        return false;
      }
      case 'not': return this.solve(S, p.arg, scope, dims, !want, depth - 1, self) && ok();
      case 'reportType': return false;
      case 'entered': {
        const e = p.e.fact ? p.e : p.e.upper?.fact ? p.e.upper : null;
        if (!e) return false;
        const sc = e.scope || scope;
        let d = e.ctx === 'nondim' ? [] : dims;
        if (d.length && !dimensionallyValid(this.A, e.fact, d).valid) d = [];
        if (want) return !!this.putAny(S, e.fact, sc, this.sample(S, e.fact, sc), { dims: d.length ? d : null }) && ok();
        this.remove(S, e.fact, sc, d); return ok();
      }
      case 'tableData': {
        if (want) { for (const id of p.tables) if (this.addRow(S, id, scope)) return ok(); return false; }
        this.removeTableData(S, p.tables, scope); return ok();
      }
      case 'memberHasData': {
        if (want) { for (const id of p.tables) if (this.addRow(S, id, scope, { member: p.member })) return ok(); return false; }
        return false;
      }
      case 'cmp': case 'format': case 'iff': {
        // choose a value for one settable fact operand
        const sides = p.op === 'cmp' ? [[p.l, p.r], [p.r, p.l]] : p.op === 'format' ? [[p.e, null]] : [];
        for (const [mine, other] of sides) {
          const e = mine.fact ? mine : mine.upper?.fact ? mine.upper : null;
          if (!e) continue;
          const sc = e.scope || scope;
          let d = e.ctx === 'nondim' ? [] : dims;
          if (d.length && !dimensionallyValid(this.A, e.fact, d).valid) d = [];
          let ov = null;
          try { ov = other ? evalExpr(other, env()) : null; } catch { ov = null; }
          for (const v of this.candidates(S, e.fact, [ov])) {
            const c = this.putAny(S, e.fact, sc, v, { dims: d.length ? d : null });
            if (c && ok()) return true;
          }
        }
        return false;
      }
      case 'existsFact': case 'anyFact': {
        if (!want) return false;
        for (const v of this.candidates(S, p.concept)) {
          const c = this.putAny(S, p.concept, scope, v);
          if (c && ok()) return true;
        }
        return false;
      }
      default: return false;
    }
  }
  satisfy(S, p, scope, dims = [], depth = 3) { return this.solve(S, p, scope, dims, true, depth); }
}

// ---------------------------------------------------------------------------------------------- builders
// each returns { pass, fail, note }
const BUILDERS = {
  mandatory(W) {
    const { A, r } = W; const a = r.ast;
    let note = '';
    for (const scope of W.scopes()) {
      const S = W.clone();
      if (a.when && !W.satisfy(S, a.when, scope)) { note += `${scope}: condition could not be made true; `; continue; }
      if (!W.makeApplicable(S, a.concept, scope)) { note += `${scope}: subject not applicable after activation; `; continue; }
      const P = W.clone(S);
      if (!W.run(P, scope).pass) { if (!W.putAny(P, a.concept, scope, W.sample(P, a.concept, scope))) { note = `${scope}: subject could not be entered`; } }
      const pass = W.run(P, scope).pass;
      const F = W.clone(S); W.remove(F, a.concept, scope);
      const fail = W.run(F, scope).fail;
      if (pass && fail) return { pass, fail, passNote: `${scope}: present`, failNote: `${scope}: removed → FAIL` };
      note += `${scope}: pass=${pass} fail=${fail}; `;
    }
    return { pass: false, fail: false, note };
  },
  tableRequired(W) {
    const a = W.r.ast;
    let note = '';
    for (const scope of W.scopes()) {
      const S = W.clone();
      if (!W.satisfy(S, a.when, scope)) { note += `${scope}: condition could not be made true; `; continue; }
      const P = W.clone(S);
      if (!W.run(P, scope).pass) for (const id of a.tables) if (W.addRow(P, id, scope)) break;
      const pass = W.run(P, scope).pass;
      const F = W.clone(S); W.removeTableData(F, a.tables, scope);
      const fail = W.run(F, scope).fail;
      if (pass && fail) return { pass, fail, passNote: `${scope}: condition true + table row`, failNote: `${scope}: condition true, no rows → FAIL` };
      note += `${scope}: pass=${pass} fail=${fail}; `;
    }
    return { pass: false, fail: false, note };
  },
  lineItemsMandatory(W) {
    const { A } = W; const a = W.r.ast;
    let note = '';
    for (const id of a.tables) for (const scope of W.scopes()) {
      const S = W.clone();
      for (const q of [...a.concepts, ...(a.atLeastOne || []).flat()]) W.makeApplicable(S, q, scope);
      W.removeTableData(S, [id], scope);
      // anchor the row with an element that is not itself required, so removing a required one keeps the row
      const anchored = W.addRow(S, id, scope, { avoid: new Set([...a.concepts, ...(a.atLeastOne || []).flat()]) });
      const row = anchored || W.addRow(S, id, scope);
      if (!row) { note += `${scope}: no row could be added to ${id}; `; continue; }
      const req = a.concepts.filter((q) => dimensionallyValid(A, q, row.dims).valid && S.conceptStatus(q, scope).applicable);
      for (const q of req) if (S.filing.value(q, scope, row.dims) == null) W.put(S, q, scope, { tableId: id, dims: row.dims }, W.sample(S, q, scope));
      for (const grp of a.atLeastOne || []) { const q = grp.find((x) => dimensionallyValid(A, x, row.dims).valid); if (q) W.put(S, q, scope, { tableId: id, dims: row.dims }, W.sample(S, q, scope)); }
      const rp = W.run(S, scope);
      const pass = rp.pass && !rp.fail;
      const victim = anchored ? req[0] : req.find((q) => q !== row.concept);
      const F = W.clone(S);
      if (victim) W.remove(F, victim, scope, row.dims);
      else if (anchored) for (const grp of a.atLeastOne || []) for (const q of grp) W.remove(F, q, scope, row.dims);
      const fail = (victim || anchored) && W.run(F, scope).fail;
      if (pass && fail) return { pass, fail, passNote: `${scope}: row [${dimKey(row.dims)}] complete`, failNote: `${scope}: ${victim ? A.concept(victim).name : 'at-least-one group'} removed → FAIL` };
      note += `${scope}: pass=${pass} fail=${!!fail}; `;
    }
    return { pass: false, fail: false, note };
  },
  eachFact: eachFactBuilder,
  eachFactOf: eachFactBuilder,
  crossPeriod(W) {
    const { A } = W; const a = W.r.ast;
    const S0 = W.clone();
    for (const sc of ['CY', 'PY']) { W.makeApplicable(S0, a.change, sc); W.makeApplicable(S0, a.balance, sc); }
    const cands = W.contexts(S0, a.change, 'CY', { limit: 6 });
    if (!cands.length) return { pass: false, fail: false, note: 'no context for the change element: ' + JSON.stringify(S0.conceptStatus(a.change, 'CY').reasons) };
    for (const c of cands) {
      if (c.dims.length ? !dimensionallyValid(A, a.balance, c.dims).valid : !nondimAllowed(A, a.balance)) continue;
      const bctx = c.dims.length ? W.ctxForDims(a.balance, c.dims) || c : c;
      const mk = (closing) => {
        const S = W.clone(S0);
        // as in the UI: the opening balance is the periodStart row of the current-year table (instant at the PY end)
        const e1 = W.put(S, a.balance, 'CY', bctx, '100', 'periodStartLabel') || W.put(S, a.change, 'CY', c, '20') || W.put(S, a.balance, 'CY', bctx, closing);
        return e1 ? null : S;
      };
      const P = mk('120'), F = mk('130');
      if (!P || !F) { W._lastErr = [W.put(W.clone(S0), a.balance, 'CY', bctx, '100', 'periodStartLabel'), W.put(W.clone(S0), a.change, 'CY', c, '20')].filter(Boolean).join('; '); continue; }
      const pass = W.run(P, 'CY').pass && !W.run(P, 'CY').fail;
      const fail = W.run(F, 'CY').fail;
      if (pass && fail) return { pass, fail, passNote: `CY [${dimKey(c.dims)}]: 100 + 20 = 120`, failNote: 'closing 130 → FAIL' };
    }
    return { pass: false, fail: false, note: 'no context accepts balance and change together' + (W._lastErr ? ': ' + W._lastErr : '') };
  },
  memberMandatory(W) {
    const { A } = W; const a = W.r.ast;
    for (const member of a.members || [a.member]) for (const scope of W.scopes()) {
      const S = W.clone();
      W.makeApplicable(S, a.concept, scope);
      if (!A.tablesForConcept(a.concept).some((t) => t.axes.some((x) => (x.members || []).some((m) => m.member === member)))) {
        // subject reported outside the member's table: use the member in its own table, then the subject non-dimensionally
        const host = A.tables.find((t) => t.axes.some((x) => (x.members || []).some((m) => m.member === member && m.usable)) && W.addRow(W.clone(S), t.id, scope, { member }));
        if (!host || !W.addRow(S, host.id, scope, { member })) continue;
        const P = W.clone(S); W.remove(P, a.concept, scope); const c = W.putAny(P, a.concept, scope, W.sample(P, a.concept, scope));
        const F = W.clone(S); W.remove(F, a.concept, scope);
        const pass = !!c && W.run(P, scope).pass, fail = W.run(F, scope).fail;
        if (pass && fail) return { pass, fail, passNote: `${scope}: member used in ${host.id}, element entered`, failNote: 'element removed → FAIL' };
        continue;
      }
      for (const t of A.tablesForConcept(a.concept)) {
        if (!t.axes.some((x) => (x.members || []).some((m) => m.member === member))) continue;
        const row = W.addRow(S, t.id, scope, { member, avoid: new Set([a.concept]) });
        if (!row || !dimensionallyValid(A, a.concept, row.dims).valid) continue;
        const P = W.clone(S); W.put(P, a.concept, scope, { tableId: t.id, dims: row.dims }, W.sample(P, a.concept, scope));
        const F = W.clone(S); W.remove(F, a.concept, scope, row.dims);
        const pass = W.run(P, scope).pass, fail = W.run(F, scope).fail;
        if (pass && fail) return { pass, fail, passNote: `${scope} [${dimKey(row.dims)}]`, failNote: 'element removed → FAIL' };
      }
    }
    return { pass: false, fail: false, note: 'no row with the member could be built' };
  },
  unique(W) {
    const { A } = W; const a = W.r.ast;
    const tables = a.tables?.length ? a.tables : A.tablesForConcept(a.concept).map((t) => t.id);
    for (const scope of W.scopes()) for (const id of tables) {
      const S = W.clone();
      const t = A.table(id);
      if (!S.tableStatus(id, scope).applicable && !W.activateTable(S, id, scope)) continue;
      const typed = t.axes.find((x) => x.typed);
      W.removeTableData(S, [id], scope);
      const rows = [];
      if (typed) for (const v of ['1', '2']) rows.push(t.axes.map((x) => (x === typed ? { axis: x.axis, typed: v } : null)).filter(Boolean));
      else { const cs = W.combos(S, t, scope, a.concept, null, 2000); if (cs.length < 2) continue; rows.push(cs[0], cs[1]); }
      if (rows.some((d) => !dimensionallyValid(A, a.concept, d).valid)) continue;
      const vals = a.concept.endsWith('PermanentAccountNumber') || /PAN|PermanentAccount/i.test(a.concept) ? ['ABCDE1234F', 'ABCDE5678G'] : /CIN|CorporateIdentity/i.test(a.concept) ? [CIN2, 'U72200KA2011PTC654322'] : /Director/i.test(a.concept) ? ['00012345', '00012346'] : ['A1', 'B2'];
      const mk = (v2) => { const X = W.clone(S); for (const [i, d] of rows.entries()) if (W.put(X, a.concept, scope, { tableId: id, dims: d }, i ? v2 : vals[0])) return null; return X; };
      const P = mk(vals[1]), F = mk(vals[0]);
      if (!P || !F) continue;
      const pass = W.run(P, scope).pass && !W.run(P, scope).fail, fail = W.run(F, scope).fail;
      if (pass && fail) return { pass, fail, passNote: `${scope}: two rows, distinct values`, failNote: 'same value twice → FAIL' };
    }
    return { pass: false, fail: false, note: 'two rows could not be built' };
  },
  iffEntered(W) {
    const { A } = W; const [p, q] = W.r.ast.concepts;
    for (const scope of W.scopes()) {
      const S = W.clone();
      W.remove(S, p, scope); W.remove(S, q, scope);
      for (const c of W.contexts(S, p, scope, { limit: 6 })) {
        const cq = c.dims.length ? W.ctxForDims(q, c.dims) : (nondimAllowed(A, q) ? c : null);
        if (!cq) continue;
        const P = W.clone(S); if (W.put(P, p, scope, c, W.sample(P, p, scope)) || W.put(P, q, scope, cq, W.sample(P, q, scope))) continue;
        const F = W.clone(S); if (W.put(F, p, scope, c, W.sample(F, p, scope))) continue;
        const pass = W.run(P, scope).pass && !W.run(P, scope).fail, fail = W.run(F, scope).fail;
        if (pass && fail) return { pass, fail, passNote: `${scope}: both entered`, failNote: 'only one entered → FAIL' };
      }
    }
    return { pass: false, fail: false, note: 'no common context' };
  },
  memberArith(W) {
    const { A } = W; const a = W.r.ast;
    const def = A.dimensionDefault(a.axis);
    for (const scope of W.scopes()) for (const t of A.tablesForConcept(a.concept)) {
      if (!t.axes.some((x) => x.axis === a.axis)) continue;
      const S = W.clone();
      if (!S.tableStatus(t.id, scope).applicable && !W.activateTable(S, t.id, scope)) continue;
      const others = [];
      for (const x of t.axes) if (x.axis !== a.axis) { if (x.typed) others.push({ axis: x.axis, typed: '1' }); else { const d = A.dimensionDefault(x.axis); const m = (x.members || []).find((mm) => mm.usable && mm.member !== d); if (!d && m) others.push({ axis: x.axis, member: m.member }); } }
      const dimsOf = (m) => (m === def ? others : [...others, { axis: a.axis, member: m }]);
      const set = (X, m, v) => { const d = dimsOf(m); const c = d.length ? { tableId: t.id, dims: d } : (nondimAllowed(A, a.concept) ? { tableId: null, dims: [] } : null); return c ? W.put(X, a.concept, scope, c, v) : 'no context'; };
      const plus = a.plus.map((_, i) => 100 + 10 * i), minus = a.minus.map((_, i) => 5 + i);
      const total = plus.reduce((x, y) => x + y, 0) - minus.reduce((x, y) => x + y, 0);
      const mk = (tv) => { const X = W.clone(S); const err = [...a.plus.map((m, i) => set(X, m, plus[i])), ...a.minus.map((m, i) => set(X, m, minus[i])), set(X, a.target, tv)].find(Boolean); return err ? null : X; };
      const P = mk(total), F = mk(total + 1);
      if (!P || !F) continue;
      const pass = W.run(P, scope).pass && !W.run(P, scope).fail, fail = W.run(F, scope).fail;
      if (pass && fail) return { pass, fail, passNote: `${scope}: target = Σplus − Σminus`, failNote: 'target off by 1 → FAIL' };
    }
    return { pass: false, fail: false, note: 'members could not be entered' };
  },
  assert(W) {
    // Σ along an axis (or Σ of facts) = reported total: two members 30 + 70 = 100 (PASS), total 101 (FAIL)
    const { A } = W; const a = W.r.ast; const p = a.assert;
    const terms = p.l.sumOf ? p.l.sumOf : p.l.add ? p.l.add : [p.l];
    for (const scope of W.scopes()) {
      const S = W.clone();
      for (const t of [...terms, p.r]) { const q = t.sumAxis?.concept || t.fact; if (q) W.makeApplicable(S, q, scope); }
      if (W.r.subject) W.makeApplicable(S, W.r.subject, scope);
      if (W.r.subject && !S.conceptStatus(W.r.subject, scope).applicable) continue;
      // clear the operands
      for (const t of terms) { const q = t.sumAxis?.concept || t.fact; if (q) for (const f of S.filing.factsOf(q)) if (reportingYear(S.filing.meta.periods, f.period) === scope) S.filing.removeFact(f.key); }
      let total = 0; let err = null;
      for (const [ti, t] of terms.entries()) {
        if (t.fact) { const c = W.putAny(S, t.fact, scope, '50', { dims: t.ctx === 'nondim' ? [] : null }); if (!c) err = 'operand ' + t.fact; else total += 50; continue; }
        const sa = t.sumAxis;
        const tab = A.tablesForConcept(sa.concept).find((x) => x.axes.some((y) => y.axis === sa.axis));
        if (!tab) { err = 'no table'; break; }
        if (!S.tableStatus(tab.id, scope).applicable && !W.activateTable(S, tab.id, scope)) { err = 'table not applicable'; break; }
        const axisDef = tab.axes.find((y) => y.axis === sa.axis);
        let members;
        if (axisDef.typed) members = [{ typed: '1' }, { typed: '2' }];
        else {
          const info = A.axisInfo(sa.axis);
          const def = A.dimensionDefault(sa.axis);
          let cands = (axisDef.members || []).filter((m) => m.usable && m.member !== def);
          if (sa.level === 'members') cands = cands.filter((m) => sa.members.includes(m.member));
          else if (sa.level === 'pattern') cands = cands.filter((m) => new RegExp(sa.pattern).test(m.member.split(':').pop()));
          else if (sa.level === 'firstLevel') { const roots = [...info.members.values()].filter((m) => !info.parents.has(m.member)).map((m) => m.member); cands = cands.filter((m) => roots.includes(info.parents.get(m.member))); }
          members = cands.slice(0, 2).map((m) => ({ member: m.member }));
          if (sa.level === 'members' && members.length > 1 && sa.members.length > 2) members = members.slice(0, 2);
        }
        const fixed = Object.entries(sa.fixed || {}).map(([axis, member]) => ({ axis, member }));
        const othersReq = tab.axes.filter((y) => y.axis !== sa.axis && !(y.axis in (sa.fixed || {})) && !A.dimensionDefault(y.axis) && !y.typed);
        if (othersReq.length && !sa.anyOther) { err = 'other axes without default'; break; }
        let n = 0;
        for (const m of members) {
          const dims = [...fixed, { axis: sa.axis, ...m }];
          if (!dimensionallyValid(A, sa.concept, dims).valid) continue;
          const v = 30 + 40 * n;
          if (!W.put(S, sa.concept, scope, { tableId: tab.id, dims }, String(v))) { total += v; n++; }
        }
        if (!n) { err = 'no member accepted'; break; }
      }
      if (err) continue;
      const r = p.r;
      const mk = (v) => { const X = W.clone(S); const c = W.putAny(X, r.fact, r.scope || scope, String(v), { dims: r.ctx === 'nondim' || !r.ctx ? [] : null }); return c ? X : null; };
      const P = mk(total), F = mk(total + 1);
      if (!P || !F) continue;
      const pass = W.run(P, scope).pass && !W.run(P, scope).fail, fail = W.run(F, scope).fail;
      if (pass && fail) return { pass, fail, passNote: `${scope}: Σ = ${total}`, failNote: `total ${total + 1} → FAIL` };
    }
    return { pass: false, fail: false, note: 'operands could not be entered' };
  },
};

// eachFact / eachFactOf: a fact of the subject in a valid context; brute-force candidate values for the subject;
// then make the assertion true (PASS) / false (FAIL) — through the subject value or the other operands.
function eachFactBuilder(W) {
  const { A } = W; const a = W.r.ast;
  let note = 'no context for the subject';
  for (const scope of W.scopes()) {
    const S0 = W.clone();
    if (!W.makeApplicable(S0, a.concept, scope)) { note = `${scope}: subject not applicable`; continue; }
    const ctxs = W.contexts(S0, a.concept, scope, { limit: 3, member: a.when?.op === 'hasMember' ? a.when.member : null });
    for (const c of ctxs) {
      let passDone = null, failDone = null;
      const other = a.assert?.op === 'cmp' ? (a.assert.l.self ? a.assert.r : a.assert.r.self ? a.assert.l : null) : null;
      let ov = null;
      try { ov = other ? evalExpr(other, W.env(S0, scope, { dims: c.dims })) : null; } catch { ov = null; }
      for (const v of W.candidates(S0, a.concept, [ov, ...constsOf(a)])) {
        const S1 = W.clone(S0);
        if (W.put(S1, a.concept, scope, c, v)) continue;
        const self = S1.filing.get(a.concept, S1.filing.period(a.concept, scope), c.dims);
        if (!self) continue;
        if (a.when && !W.solve(S1, a.when, scope, c.dims, true, 3, self)) continue;
        if (!passDone) {
          const P = W.clone(S1);
          const selfP = P.filing.get(self.concept, self.period, self.dims);
          if (W.solve(P, a.assert, scope, c.dims, true, 3, selfP)) { const rr = W.run(P, scope); if (rr.pass && !rr.fail) passDone = `${scope} [${dimKey(c.dims)}] value '${v}'`; }
        }
        if (!failDone) {
          const F = W.clone(S1);
          const selfF = F.filing.get(self.concept, self.period, self.dims);
          if (W.solve(F, a.assert, scope, c.dims, false, 3, selfF)) { if (W.run(F, scope).fail) failDone = `${scope} [${dimKey(c.dims)}] value '${v}'`; }
        }
        if (passDone && failDone) return { pass: true, fail: true, passNote: passDone, failNote: failDone };
      }
      note = `${scope}: pass=${!!passDone} fail=${!!failDone}`;
      if (passDone || failDone) return { pass: !!passDone, fail: !!failDone, note, passNote: passDone, failNote: failDone };
    }
  }
  return { pass: false, fail: false, note };
}
function constsOf(ast) {
  const out = [];
  const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if ('const' in x) out.push(typeof x.const === 'number' || (x.kind !== 'date' && /^-?\d+(\.\d+)?$/.test(String(x.const))) ? Dec.parse(String(x.const)) : x.const); for (const v of Object.values(x)) walk(v); };
  walk(ast.assert); walk(ast.when);
  return out;
}
