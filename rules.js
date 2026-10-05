// Business-rule engine: executes every EXECUTABLE rule of the compiled MCA corpus.
// Rule results: PASS | FAIL | WARN | NOT_APPLICABLE | REVIEW_ONLY_EXTERNAL_DATA | UNIMPLEMENTED | APPROVED_LIMITATION_NOT_EXECUTED.
// No rule is ever reported PASS unless it was actually evaluated.
import * as Dec from './decimal.js';
import { evalPred, evalExpr } from './expr.js';
import { Applicability } from './applicability.js';
import { dimensionallyValid, sequentialGaps, tablesForFact, factInTable } from './dimensions.js';
import { runCalculations, CalcStatus } from './calculation.js';
import { reportingYear } from './periods.js';
import { dimKey } from './model.js';
import { addDays as addDaysIso } from './periods.js';

// Filing Manual Annexure II #14 (FM-14): the parent member of `member` on `axis` that must also be reported, or
// null. The default member is the axis total, reported without the axis (often on the face of the statements), so
// only non-default parents are required (Annex II #14 example: OfficeEquipmentMember); "if parent member is not
// exempted": sheet "Exempt parent member Dimension" (table, axis, parent) for the given hypercube names. Shared by the
// rule engine and the table UI hints (member-hints.js, display only), so both use the same decision.
export function fm14RequiredParent(A, axis, member, tableNames) {
  const info = A.axisInfo(axis);
  const parent = info?.parents.get(member);
  if (!parent || parent === A.dimensionDefault(axis) || info.members.get(parent)?.usable === false) return null;
  if (A.rules.exemptions.parentMember.some((e) => e.axis === axis && e.member === parent && tableNames.includes(e.table))) return null;
  return parent;
}

// Axes whose members partition the outcome of a single item (see lineItems)
const OUTCOME_AXES = new Set(['in-ca:AuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportAxis']);

export class RuleEngine {
  constructor(A) {
    this.A = A;
    this.app = new Applicability(A);
    this.rules = A.rules.rules;
    this._mandatoryConcepts = new Set(this.rules.filter((r) => r.status === 'EXECUTABLE' && r.ast?.type === 'mandatory' && !r.ast.when).map((r) => r.ast.concept));
    this._calcExempt = null;
  }

  run(filing, { today = new Date().toISOString().slice(0, 10), only = null } = {}) {
    this.today = today;
    const results = [];
    const executed = {};
    const ctx = { filing, results, calc: null };
    for (const r of this.rules) {
      if (only && !only.has(r.id)) continue;
      if (r.status !== 'EXECUTABLE') {
        if (r.status === 'UNIMPLEMENTED' && r.approvedLimitation) {
          results.push({ ruleId: r.id, scope: null, status: 'APPROVED_LIMITATION_NOT_EXECUTED', message: `APPROVED LIMITATION / NOT EXECUTED: ${r.text}` });
          executed[r.id] = 'APPROVED LIMITATION / NOT EXECUTED';
          continue;
        }
        if (r.status === 'REVIEW_ONLY_EXTERNAL_DATA' || r.status === 'UNIMPLEMENTED') results.push({ ruleId: r.id, scope: null, status: r.status, message: r.reason || r.text });
        executed[r.id] = r.status;
        continue;
      }
      if (!r.ast) { executed[r.id] = 'EXECUTED'; continue; } // data rows consumed by generic handlers
      const before = results.length;
      try {
        this.exec(r, ctx);
      } catch (e) {
        results.push({ ruleId: r.id, scope: null, status: 'FAIL', message: `Rule engine error: ${e.message}`, engineError: true });
      }
      executed[r.id] = 'EXECUTED';
      if (results.length === before) results.push({ ruleId: r.id, scope: null, status: 'NOT_APPLICABLE', message: 'No facts or conditions in scope' });
    }
    return { results, ruleStatus: executed, calculations: ctx.calc };
  }

  env(filing, scope, extra = {}) { return this.app.env(filing, scope, { today: this.today, ...extra }); }
  // 'PYO' = opening balance sheet of the previous year (instant at the day before the previous-year start): evaluated
  // for rules marked "Applicable for First Time Adoption" when WhetherCompanyHasAdoptedIndAsFirstTime is Yes (GR-16)
  scopes(r, filing) {
    const s = r.scope?.periods || ['CY', 'PY'];
    const fta = s.includes('PYO') && this.ftaActive(filing);
    return s.filter((x) => x === 'CY' || (!filing.meta.firstFinancialYear && (x === 'PY' || (x === 'PYO' && fta))));
  }
  ftaActive(filing) {
    if (this._fta === undefined) this._fta = this.A.qnameOfLocal('WhetherCompanyHasAdoptedIndAsFirstTime');
    return !!this._fta && filing.value(this._fta, 'CY', []) === 'true';
  }
  factsIn(filing, concept, scope) {
    if (scope === 'PYO') return filing.factsOf(concept).filter((f) => !f.nil && filing.scopeOf(f.period) === 'PYO');
    return filing.factsOf(concept).filter((f) => !f.nil && reportingYear(filing.meta.periods, f.period) === scope && filing.scopeOf(f.period) !== 'PYO');
  }
  out(ctx, r, scope, status, message, extra = {}) {
    // a rule contradicted by an MCA-validated instance reports failures as warnings (evidence attached)
    if (status === 'FAIL' && r.severity === 'WARNING') { status = 'WARN'; message += ` — not blocking: ${r.divergence}`; }
    // location anchor for the UI (cell navigation): the rule's subject concept unless the result names its own
    const a = r.ast || {};
    if (a.type === 'tableRequired') { if (!extra.tableId) extra.tableId = a.tables?.[0] || null; }
    else if (extra.concept === undefined && !extra.factKey) extra.concept = r.subject || a.concept || (a.concepts || [])[0] || null;
    ctx.results.push({ ruleId: r.id, scope, status, message, ...extra });
  }
  label(q) { return this.A.concept(q)?.name || q; }

  exec(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    switch (a.type) {
      case 'mandatory': return this.mandatory(r, ctx);
      case 'eachFact': case 'eachFactOf': {
        for (const scope of this.scopes(r, filing)) {
          for (const f of this.factsIn(filing, a.concept, scope)) {
            const env = this.env(filing, scope, { self: f, dims: f.dims });
            if (a.when && evalPred(a.when, env) !== true) continue;
            const v = evalPred(a.assert, env);
            if (v === true) this.out(ctx, r, scope, 'PASS', r.text, { factKey: f.key });
            else if (v === false) {
              // "X is mandatory if <trigger>": the error belongs to the missing X cell, not to the trigger
              const missing = a.type === 'eachFactOf' && a.assert?.op === 'entered' && a.assert.e?.fact;
              const loc = missing ? { concept: missing, dims: dimensionallyValid(this.A, missing, f.dims).valid ? f.dims : [], relatedFactKey: f.key } : { factKey: f.key };
              this.out(ctx, r, scope, 'FAIL', `${this.label(a.concept)}${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''}: ${r.text}`, loc);
            }
          }
        }
        return;
      }
      case 'assert': {
        for (const scope of this.scopes(r, filing)) {
          if (r.subject && !this.app.conceptStatus(filing, r.subject, scope).applicable) continue;
          const env = this.env(filing, scope);
          if (a.when && evalPred(a.when, env) !== true) continue;
          const v = evalPred(a.assert, env);
          if (v === true) this.out(ctx, r, scope, 'PASS', r.text);
          else if (v === false) this.out(ctx, r, scope, 'FAIL', `${this.label(r.subject)}: ${r.text}`);
        }
        return;
      }
      case 'iffEntered': {
        const [p, q] = a.concepts;
        for (const scope of this.scopes(r, filing)) {
          const ctxs = new Map();
          for (const c of a.concepts) for (const f of this.factsIn(filing, c, scope)) ctxs.set(dimKey(f.dims), f.dims);
          for (const dims of ctxs.values()) {
            const hp = filing.value(p, scope, dims) != null, hq = filing.value(q, scope, dims) != null;
            if (hp && hq) this.out(ctx, r, scope, 'PASS', r.text);
            else this.out(ctx, r, scope, 'FAIL', `${this.label(hp ? q : p)} is required because ${this.label(hp ? p : q)} is entered${dims.length ? ' [' + dimKey(dims) + ']' : ''}`, { concept: hp ? q : p, dims });
          }
        }
        return;
      }
      case 'memberMandatory': {
        const tables = this.A.tablesForConcept(a.concept);
        const mset = new Set(a.members || [a.member]);
        if (!tables.some((t) => t.axes.some((x) => (x.members || []).some((m) => mset.has(m.member))))) {
          // the element describing the member is reported outside the member's table (non-dimensional): required
          // when the member is used anywhere in the scope
          for (const scope of this.scopes(r, filing)) {
            const used = filing.all().find((f) => !f.nil && reportingYear(filing.meta.periods, f.period) === scope && filing.scopeOf(f.period) !== 'PYO' && f.dims.some((d) => mset.has(d.member)));
            if (!used) continue;
            const present = filing.value(a.concept, scope, []) != null || this.factsIn(filing, a.concept, scope).length > 0;
            this.out(ctx, r, scope, present ? 'PASS' : 'FAIL', present ? r.text : `${this.label(a.concept)} is mandatory because ${this.label(a.member)} is used [${dimKey(used.dims)}]`, { concept: a.concept });
          }
          return;
        }
        const items = new Set(tables.flatMap((t) => t.lineItems));
        for (const scope of this.scopes(r, filing)) {
          const ctxs = new Map();
          const members = new Set(a.members || [a.member]);
          for (const f of filing.all()) if (items.has(f.concept) && !f.nil && reportingYear(filing.meta.periods, f.period) === scope && f.dims.some((d) => members.has(d.member))) ctxs.set(dimKey(f.dims), f.dims);
          for (const dims of ctxs.values()) {
            if (!dimensionallyValid(this.A, a.concept, dims).valid) continue;
            if (filing.value(a.concept, scope, dims) != null) this.out(ctx, r, scope, 'PASS', r.text);
            else this.out(ctx, r, scope, 'FAIL', `${this.label(a.concept)} is mandatory for ${this.label(a.member)} [${dimKey(dims)}]`, { concept: a.concept, dims });
          }
        }
        return;
      }
      case 'tableRequired': {
        for (const scope of this.scopes(r, filing)) {
          const elrOk = a.tables.some((t) => this.app.elrStatus(filing, this.A.table(t).presentationElr, scope).applicable);
          if (!elrOk) continue;
          const v = evalPred(a.when, this.env(filing, scope));
          if (v !== true) continue;
          const has = this.tableHasData(filing, a.tables, scope);
          this.out(ctx, r, scope, has ? 'PASS' : 'FAIL', has ? r.text : `Table ${this.label(this.A.table(a.tables[0]).hypercube)} is mandatory for ${scope}: ${r.text}`);
        }
        return;
      }
      case 'tableIffMembers': {
        for (const scope of this.scopes(r, filing)) {
          const members = this.app.membersHaveData(filing, scope, a.otherTables, a.axis, a.members);
          const table = this.tableHasData(filing, a.tables, scope);
          if (!members && !table) continue;
          this.out(ctx, r, scope, members === table ? 'PASS' : 'FAIL', members === table ? r.text : members ? 'DetailsOfBondsOrDebenturesTable is mandatory because Bonds/Debentures borrowings are reported' : 'Bonds/Debentures borrowings must be reported because DetailsOfBondsOrDebenturesTable is provided');
        }
        return;
      }
      case 'groupSum': {
        for (const scope of this.scopes(r, filing)) {
          const groups = new Map();
          const tol = new Map();
          for (const f of this.factsIn(filing, a.concept, scope)) {
            const g = f.dims.find((d) => d.axis === a.groupAxis);
            if (!g || !this.isUnder(a.groupAxis, g.member, a.groupUnder)) continue;
            // the rule adds up the individual members of sumAxis (e.g. shareholders); the total (axis at default) is not a part
            if (a.sumAxis && !f.dims.some((d) => d.axis === a.sumAxis)) continue;
            const k = g.member;
            groups.set(k, Dec.add(groups.get(k) || Dec.ZERO, Dec.parse(f.value)));
            // each reported percentage is accurate to its decimals (±½ unit of the last place)
            const dd = f.decimals == null || f.decimals === 'INF' ? null : Number(f.decimals);
            if (dd != null) tol.set(k, Dec.add(tol.get(k) || Dec.ZERO, Dec.shift(Dec.parse('5'), -(dd + 1))));
          }
          for (const [m, total] of groups) {
            const ok = Dec.cmp(Dec.sub(total, tol.get(m) || Dec.ZERO), Dec.parse(a.limit)) <= 0;
            this.out(ctx, r, scope, ok ? 'PASS' : 'FAIL', ok ? r.text : `Σ ${this.label(a.concept)} for ${this.label(m)} = ${Dec.toString(total)} exceeds ${a.limit} (100%)`);
          }
        }
        return;
      }
      case 'unique': {
        const tables = (a.tables || []).map((id) => this.A.table(id)).filter(Boolean);
        const axes = new Set(tables.flatMap((t) => t.axes.map((x) => x.axis)));
        for (const scope of this.scopes(r, filing)) {
          const facts = this.factsIn(filing, a.concept, scope).filter((f) => !axes.size || (f.dims.length && f.dims.every((d) => axes.has(d.axis)) && tables.some((t) => factInTable(this.A, f, t))));
          if (!facts.length) continue;
          const seen = new Map();
          for (const f of facts) { const k = String(f.value).trim().toUpperCase(); (seen.get(k) || seen.set(k, []).get(k)).push(f); }
          const dups = [...seen.entries()].filter(([, fs]) => fs.length > 1);
          if (!dups.length) this.out(ctx, r, scope, 'PASS', r.text);
          for (const [v, fs] of dups) this.out(ctx, r, scope, 'FAIL', `${this.label(a.concept)} '${v}' is entered for ${fs.length} members [${fs.map((f) => dimKey(f.dims)).join(' | ')}]: ${r.text}`, { factKey: fs[1].key });
        }
        return;
      }
      case 'memberArith': {
        const def = this.A.dimensionDefault(a.axis);
        const withMember = (dims, m) => (m === def ? dims : [...dims, { axis: a.axis, member: m }]);
        for (const scope of this.scopes(r, filing)) {
          for (const f of this.factsIn(filing, a.concept, scope)) {
            if (!f.dims.some((d) => d.axis === a.axis && d.member === a.plus[0])) continue;
            const others = f.dims.filter((d) => d.axis !== a.axis);
            const val = (m) => { const v = filing.value(a.concept, scope, withMember(others, m)); return v == null ? null : Dec.parse(v); };
            const target = val(a.target);
            const parts = [...a.plus.map((m) => val(m)), ...a.minus.map((m) => val(m))];
            if (target == null || parts.some((x) => x == null)) continue;
            const computed = Dec.sub(Dec.sum(parts.slice(0, a.plus.length)), Dec.sum(parts.slice(a.plus.length)));
            const okv = Dec.eq(target, computed);
            this.out(ctx, r, scope, okv ? 'PASS' : 'FAIL', okv ? r.text : `${this.label(a.concept)}${others.length ? ' [' + dimKey(others) + ']' : ''}: ${this.label(a.target)} ${Dec.toString(target)} ≠ ${Dec.toString(computed)} (${a.plus.map((m) => this.label(m)).join(' + ')} − ${a.minus.map((m) => this.label(m)).join(' − ')})`, { factKey: f.key });
          }
        }
        return;
      }
      case 'tableOneComplete': {
        const except = new Set(a.except || []);
        for (const id of a.tables) {
          const t = this.A.table(id);
          for (const scope of this.scopes(r, filing)) {
            const groups = this.tableGroups(filing, t, scope);
            if (!groups.size) continue;
            const items = t.lineItems.filter((q) => !except.has(q) && !this.A.concept(q)?.abstract && this.app.conceptStatus(filing, q, scope).applicable);
            const complete = [...groups.values()].some((dims) => items.every((q) => !dimensionallyValid(this.A, q, dims).valid || filing.value(q, scope, dims) != null));
            this.out(ctx, r, scope, complete ? 'PASS' : 'FAIL', complete ? r.text : `Table ${this.label(t.hypercube)}: no member has all details entered (${r.text})`);
          }
        }
        return;
      }
      case 'lineItemSingleMember': {
        for (const id of a.tables) {
          const t = this.A.table(id);
          const items = new Set(t.lineItems);
          const axes = new Set(t.axes.map((x) => x.axis));
          for (const scope of this.scopes(r, filing)) {
            const where = new Map();
            for (const f of filing.all()) {
              if (!items.has(f.concept) || f.nil || !f.dims.length || !f.dims.every((d) => axes.has(d.axis)) || reportingYear(filing.meta.periods, f.period) !== scope || !factInTable(this.A, f, t)) continue;
              (where.get(f.concept) || where.set(f.concept, new Set()).get(f.concept)).add(dimKey(f.dims));
            }
            if (!where.size) continue;
            const multi = [...where.entries()].filter(([, ks]) => ks.size > 1);
            if (!multi.length) this.out(ctx, r, scope, 'PASS', r.text);
            for (const [q, ks] of multi) this.out(ctx, r, scope, 'FAIL', `${this.label(q)} is provided against ${ks.size} members [${[...ks].join(' | ')}]: ${r.text}`);
          }
        }
        return;
      }
      case 'cashFlowMethod': {
        const type = filing.value(a.concept, 'CY', []);
        if (type == null) return;
        const methods = this.A.meta.profile.cashFlowMethods; // { 'Direct Method': '310000', 'Indirect Method': '320000' }
        const mine = methods[type];
        if (!mine) return;
        const cfCodes = new Set(Object.values(methods));
        const other = [...cfCodes].find((c) => c !== mine);
        let bad = 0;
        for (const f of filing.all()) {
          if (f.nil) continue;
          const codes = this.A.conceptElrs(f.concept).map((u) => this.A.elr(u).code.slice(0, 6));
          if (codes.includes(other) && !codes.includes(mine) && codes.every((c) => cfCodes.has(c))) {
            bad++;
            this.out(ctx, r, reportingYear(filing.meta.periods, f.period), 'FAIL', `'${this.label(f.concept)}' belongs only to the ${other === methods['Direct Method'] ? 'direct' : 'indirect'}-method cash flow statement but TypeOfCashFlowStatement is '${type}'`, { factKey: f.key });
          }
        }
        if (!bad) this.out(ctx, r, 'CY', 'PASS', r.text);
        return;
      }
      case 'crossPeriod': return this.crossPeriod(r, ctx);
      case 'lineItemsMandatory': return this.lineItems(r, ctx);
      case 'generic': return this.generic(r, ctx);
      default: throw new Error(`Unknown rule AST type ${a.type}`);
    }
  }

  isUnder(axis, member, ancestor) {
    let m = member;
    for (let i = 0; i < 20 && m; i++) { if (m === ancestor) return true; m = this.A.memberParent(axis, m); }
    return false;
  }

  tableGroups(filing, t, scope) {
    const items = new Set(t.lineItems);
    const axes = new Set(t.axes.map((x) => x.axis));
    const groups = new Map();
    for (const f of filing.all()) {
      if (!items.has(f.concept) || f.nil || !f.dims.length || !f.dims.every((d) => axes.has(d.axis)) || !factInTable(this.A, f, t)) continue;
      if (reportingYear(filing.meta.periods, f.period) !== scope || filing.scopeOf(f.period) === 'PYO') continue;
      groups.set(dimKey(f.dims), f.dims);
    }
    return groups;
  }

  tableHasData(filing, tableIds, scope) {
    for (const id of tableIds) {
      const t = this.A.table(id);
      const items = new Set(t.lineItems);
      const axes = new Set(t.axes.map((x) => x.axis));
      if (filing.all().some((f) => items.has(f.concept) && !f.nil && f.dims.length && f.dims.every((d) => axes.has(d.axis)) && reportingYear(filing.meta.periods, f.period) === scope && factInTable(this.A, f, t))) return true;
    }
    return false;
  }

  mandatory(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    for (const scope of this.scopes(r, filing)) {
      if (!this.app.conceptStatus(filing, a.concept, scope).applicable) continue;
      // an element the previous-year ELR exclusion removes from one of its ELRs (e.g. DescriptionOfPresentationCurrency,
      // a general-information element also presented in [613100]) is not required for the previous year; the
      // MCA-validated ICOM 2022-23 instance reports it for the current year only
      if (scope === 'PY' && this.app.pyExcludedSomewhere(filing, a.concept)) { this.out(ctx, r, scope, 'NOT_APPLICABLE', 'previous year excluded for this element (general information / GR-11)'); continue; }
      if (a.when) { const v = evalPred(a.when, this.env(filing, scope)); if (v !== true) continue; }
      const nd = filing.value(a.concept, scope, []) != null;
      const any = nd || this.factsIn(filing, a.concept, scope).length > 0;
      this.out(ctx, r, scope, any ? 'PASS' : 'FAIL', any ? r.text : `'${this.label(a.concept)}' is mandatory — not present for ${scope === 'PYO' ? 'the opening balance sheet of the previous year' : scope} (${scope === 'CY' ? filing.meta.periods.cy.end : scope === 'PY' ? filing.meta.periods.py.end : addDaysIso(filing.meta.periods.py.start, -1)})`, { concept: a.concept });
    }
  }

  lineItems(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    for (const id of a.tables) {
      const t = this.A.table(id);
      const items = new Set(t.lineItems);
      const axes = new Set(t.axes.map((x) => x.axis));
      for (const scope of this.scopes(r, filing)) {
        if (!this.app.tableStatus(filing, id, scope).applicable && !this.tableHasData(filing, [id], scope)) continue;
        const groups = new Map();
        for (const f of filing.all()) {
          if (!items.has(f.concept) || f.nil || !f.dims.length || !f.dims.every((d) => axes.has(d.axis)) || !factInTable(this.A, f, t)) continue;
          if (!tablesForFact(this.A, f).some((x) => x.hypercube === t.hypercube)) continue;
          if (reportingYear(filing.meta.periods, f.period) !== scope || filing.scopeOf(f.period) === 'PYO') continue;
          groups.set(dimKey(f.dims), f.dims);
        }
        const all = [...groups.values()];
        // Outcome axes (each clause of the auditor's report order is reported under exactly one member: favourable,
        // not applicable, qualified): a mandatory element is satisfied when it is reported under any member, not
        // necessarily under every member. Per-row lists (e.g. shareholder details) keep the per-row check.
        const outcome = t.axes.some((x) => OUTCOME_AXES.has(x.axis));
        const reportedSomewhere = (q) => outcome && all.some((d) => filing.value(q, scope, d) != null);
        for (const dims of groups.values()) {
          const missing = [];
          // a row that is the total of other reported rows (same members plus one more axis, e.g. all shareholders of a
          // class) carries the amounts; descriptive per-row elements (name, country, …) belong to the detailed rows
          const aggregate = all.some((o) => o.length > dims.length && dims.every((d) => o.some((x) => x.axis === d.axis && x.member === d.member && x.typed === d.typed)));
          for (const q of a.concepts) {
            if (!dimensionallyValid(this.A, q, dims).valid) continue; // notAll exemption
            if (aggregate && !['monetary', 'shares', 'decimal', 'percent', 'pure', 'integer'].includes(this.A.dataType(q))) continue;
            if (!this.app.conceptStatus(filing, q, scope).applicable) continue;
            if (filing.value(q, scope, dims) == null && !reportedSomewhere(q)) missing.push(this.label(q));
          }
          for (const grp of a.atLeastOne || []) {
            const valid = grp.filter((q) => dimensionallyValid(this.A, q, dims).valid);
            if (valid.length && !valid.some((q) => filing.value(q, scope, dims) != null)) missing.push(`at least one of ${valid.length} elements under the transactions abstract`);
          }
          const firstMissing = a.concepts.find((q) => dimensionallyValid(this.A, q, dims).valid && this.app.conceptStatus(filing, q, scope).applicable && filing.value(q, scope, dims) == null) || (a.atLeastOne || []).flat().find((q) => dimensionallyValid(this.A, q, dims).valid) || null;
          // elements calibrated against MCA-validated instances (GOLDEN_CALIBRATION.json) are reported, not blocking
          const soft = new Set((a.softConcepts || []).map((q) => this.label(q)));
          const hard = missing.filter((m) => !soft.has(m));
          if (missing.length) this.out(ctx, r, scope, hard.length ? 'FAIL' : 'WARN', `Table ${this.label(t.hypercube)} mandatory element(s) [${missing.join(', ')}] not present on [${dimKey(dims)}] for ${scope}${hard.length ? '' : ' (calibrated: accepted in an MCA-validated instance — not blocking)'}`, { concept: firstMissing, dims, tableId: id });
          else this.out(ctx, r, scope, 'PASS', r.text);
        }
      }
    }
  }

  // Formula linkbase cross-period assertion ($beginningBalance + $change1 eq $endingBalance), per context (dimensions
  // matched — dimensional aspect model, implicit filtering) for the current and previous year. Filing Manual Annexure II
  // #19: an item that is not entered counts as 0. Evaluated where the change is reported, or both balances are and the
  // change element is dimensionally valid in that context (so it could have been entered).
  // Compared at the lowest decimals of the facts present (XBRL Calculations 1.1 rounding).
  crossPeriod(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    for (const scope of this.scopes(r, filing)) {
      if (!this.app.conceptStatus(filing, a.change, scope).applicable && !this.app.conceptStatus(filing, a.balance, scope).applicable) continue;
      const cp = filing.period(a.change, scope);
      if (!cp || cp.type !== 'duration' || !cp.start) continue;
      const open = { type: 'instant', date: addDaysIso(cp.start, -1) }, close = { type: 'instant', date: cp.end };
      const ctxs = new Map();
      const note = (f, kind) => { const k = dimKey(f.dims); const e = ctxs.get(k) || { dims: f.dims, kinds: new Set() }; e.kinds.add(kind); ctxs.set(k, e); };
      for (const f of filing.factsOf(a.change)) if (!f.nil && f.period.type === 'duration' && f.period.start === cp.start && f.period.end === cp.end) note(f, 'change');
      for (const f of filing.factsOf(a.balance)) if (!f.nil && f.period.type === 'instant') { if (f.period.date === open.date) note(f, 'open'); else if (f.period.date === close.date) note(f, 'close'); }
      for (const { dims, kinds } of ctxs.values()) {
        if (!kinds.has('change') && !(kinds.has('open') && kinds.has('close'))) continue;
        // a context in which the change element cannot be reported at all (not dimensionally valid for it) is never
        // an evaluation of the assertion: change1 binds no fact and has no fallback, and the user cannot enter one
        if (!kinds.has('change') && !dimensionallyValid(this.A, a.change, dims).valid) continue;
        const get = (q, p) => { const f = filing.get(q, p, dims); return f && !f.nil ? f : null; };
        const fo = get(a.balance, open), fc = get(a.change, cp), fe = get(a.balance, close);
        const present = [fo, fc, fe].filter(Boolean);
        let d = Infinity;
        for (const f of present) { const x = f.decimals == null || f.decimals === 'INF' ? Infinity : Number(f.decimals); if (x < d) d = x; }
        const rnd = (v) => Dec.round(v, d === Infinity ? 'INF' : d);
        const val = (f) => (f ? Dec.parse(f.value) : Dec.ZERO);
        const sum = rnd(Dec.add(val(fo), val(fc)));
        const end = rnd(val(fe));
        const ok = Dec.eq(sum, end);
        const where = dims.length ? ' [' + dimKey(dims) + ']' : '';
        const anchor = fe || fc || fo;
        this.out(ctx, r, scope, ok ? 'PASS' : 'FAIL', ok ? r.text
          : `Reported value at end of period is not equal to sum of reported value at beginning of period and changes in that value during period for '${this.label(a.balance)}'${where}: opening ${fo ? fo.value : '0 (not entered)'} + change ${fc ? fc.value : '0 (not entered)'} = ${Dec.toString(sum)} ≠ closing ${fe ? fe.value : '0 (not entered)'} (${scope === 'CY' ? 'current' : 'previous'} year)`,
          { factKey: anchor.key, concept: a.balance, formula: true });
      }
    }
  }

  calcExemptions() {
    if (this._calcExempt) return this._calcExempt;
    const ex = new Set();
    const A = this.A;
    for (const e of A.rules.exemptions.calculation) {
      if (e.abstract) {
        const desc = new Set();
        for (const uri of A.conceptElrs(e.abstract)) {
          const stack = [e.abstract];
          while (stack.length) { const c = stack.pop(); for (const arc of A.presentationChildren(uri, c)) { desc.add(arc.to); stack.push(arc.to); } }
        }
        for (const q of desc) if (e.mode !== 'except' || !e.concepts.includes(q)) ex.add(q);
      } else if (e.mode === 'listed') for (const q of e.concepts) ex.add(q);
    }
    for (const q of this._mandatoryConcepts) ex.delete(q); // "In case an element is mandatory, then the same shall not be exempt"
    this._calcExempt = ex;
    return ex;
  }

  generic(r, ctx) {
    const { filing } = ctx;
    const A = this.A;
    const h = r.ast.handler;
    const P = filing.meta.periods;
    switch (h) {
      case 'calc-parent-child': {
        const isElrApplicable = (elr) => {
          const code = A.json.roles[elr]?.code?.slice(0, 6);
          const pres = A.elrs.find((e) => e.code === code);
          return pres ? this.app.elrStatus(filing, pres.uri, 'CY').applicable : true;
        };
        const calc = runCalculations(A, filing, { isElrApplicable });
        ctx.calc = calc;
        const ex = this.calcExemptions();
        const reported = new Set();
        for (const c of calc) {
          if (c.status === CalcStatus.FAIL) {
            const exempt = c.children.some((k) => ex.has(k.concept)) || c.missingChildren.some((q) => ex.has(q));
            this.out(ctx, r, reportingYear(P, c.period), exempt ? 'WARN' : 'FAIL', `Calculation inconsistency in ${A.json.roles[c.elr]?.definition || c.elr}: ${this.label(c.parent)} reported ${c.reported} ≠ Σ children ${c.computed}${c.dims.length ? ' [' + dimKey(c.dims) + ']' : ''}`, { factKey: c.factKey, calc: true });
          } else if (c.status === CalcStatus.INSUFFICIENT_DATA) {
            const pf = filing.facts.get(c.factKey);
            if (!pf || Dec.isZero(Dec.parse(pf.value))) continue;
            // a parent with networks in several ELRs is satisfied when any of them has children in this context
            if (calc.some((o) => o.factKey === c.factKey && o.status !== CalcStatus.INSUFFICIENT_DATA && o.status !== CalcStatus.NOT_APPLICABLE)) continue;
            if (reported.has(c.factKey)) continue;
            reported.add(c.factKey);
            const net = A.json.calculation[c.elr].filter((x) => x.from === c.parent);
            if (net.every((x) => ex.has(x.to))) continue;
            // a network whose children cannot be reported in this context does not apply to it
            if (!net.some((x) => dimensionallyValid(A, x.to, c.dims).valid)) continue;
            this.out(ctx, r, reportingYear(P, c.period), 'FAIL', `${this.label(c.parent)} is entered (non-zero) but none of its calculation children are entered (${A.json.roles[c.elr]?.definition})${c.dims.length ? ' [' + dimKey(c.dims) + ']' : ''}`, { factKey: c.factKey });
          } else if (c.status === CalcStatus.PASS) this.out(ctx, r, reportingYear(P, c.period), 'PASS', 'calculation consistent');
        }
        // vice-versa: child entered (non-zero) => parent entered in same context, within applicable ELRs
        const parentsOf = new Map();
        for (const [elr, arcs] of Object.entries(A.json.calculation)) {
          if (!isElrApplicable(elr)) continue;
          for (const a of arcs) (parentsOf.get(a.to) || parentsOf.set(a.to, []).get(a.to)).push({ elr, parent: a.from });
        }
        // the opening instant of the previous year carries roll-forward opening balances (and their calculation
        // components); totals of the opening balance sheet are required there only under first-time adoption
        // (Filing Manual Annexure II #21: "GR-1 and calculation linkbase remain applicable for third year")
        const fta = this.app.ftaActive(filing);
        for (const f of filing.all()) {
          if (f.nil || !parentsOf.has(f.concept) || ex.has(f.concept) || !A.isNumeric(f.concept) || Dec.isZero(Dec.parse(f.value))) continue;
          if (!fta && filing.scopeOf(f.period) === 'PYO') continue;
          const ps = parentsOf.get(f.concept);
          const ok = ps.some((p) => filing.get(p.parent, f.period, f.dims) || !dimensionallyValid(A, p.parent, f.dims).valid || A.concept(p.parent).periodType !== A.concept(f.concept).periodType);
          if (!ok) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `${this.label(f.concept)} is entered but its calculation parent ${ps.map((p) => this.label(p.parent)).join(' / ')} is not${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''}`, { factKey: f.key });
        }
        return;
      }
      case 'mandatory-line-items-driver': this.out(ctx, r, null, 'PASS', 'Executed through the ML-* rules (one per table in sheet "Mandatory Line Items")'); return;
      case 'dimension-parent-child-members': {
        const exC = A.rules.exemptions.childMember;
        const excluded = new Set(r.ast.excludedLineItems);
        const doParent = r.ast.mode !== 'child', doChild = r.ast.mode !== 'parent';
        // the manual's examples are amounts (TangibleAssets, Borrowings); for text/date/boolean elements the member
        // hierarchy carries no aggregate, so a gap is reported as a warning until an MCA-validated instance confirms
        // the validation tool's behaviour for non-numeric elements
        const sev = (f) => (A.isNumeric(f.concept) ? 'FAIL' : 'WARN');
        const note = (f) => (A.isNumeric(f.concept) ? '' : ' (non-numeric element: not blocking)');
        let failed = 0; const before = ctx.results.length;
        // The validation tool reports these per element, axis and period ("The parent member {X} for element 'E'
        // should be present, for axis :(A) for period as on D"): the parent / a child must be reported for that
        // element on that axis in the period, in any combination of the other axes. The MCA-validated ICOM 2022-23
        // instance reports the parent class members only without the category axis (DisclosureOfFinancialAssetsTable)
        // and is accepted.
        const pk = (f) => (f.period.type === 'instant' ? 'I' + f.period.date : 'D' + f.period.start + '/' + f.period.end);
        const present = new Map(); // concept|axis|period -> Set(member)
        for (const f of filing.all()) {
          if (f.nil) continue;
          for (const d of f.dims) if (d.member) { const k = `${f.concept}|${d.axis}|${pk(f)}`; (present.get(k) || present.set(k, new Set()).get(k)).add(d.member); }
        }
        const done = new Set();
        for (const f of filing.all()) {
          if (f.nil || !f.dims.length || excluded.has(f.concept)) continue;
          const tables = tablesForFact(A, f);
          const tnames = tables.map((t) => t.hypercube.split(':')[1]);
          const scope = reportingYear(P, f.period);
          for (const d of f.dims) {
            if (!d.member) continue;
            const info = A.axisInfo(d.axis);
            const have = present.get(`${f.concept}|${d.axis}|${pk(f)}`);
            const parent = fm14RequiredParent(A, d.axis, d.member, tnames);
            if (doParent && parent && !have.has(parent)) {
              const key = `P|${f.concept}|${d.axis}|${pk(f)}|${parent}`;
              const pd = f.dims.map((x) => (x.axis === d.axis ? { axis: x.axis, member: parent } : x));
              const canReport = dimensionallyValid(A, f.concept, pd).valid || dimensionallyValid(A, f.concept, [{ axis: d.axis, member: parent }]).valid;
              if (canReport && !done.has(key)) {
                done.add(key);
                this.out(ctx, r, scope, sev(f), `The parent member {${this.label(parent)}} for element '${this.label(f.concept)}' should be present for axis (${this.label(d.axis)}) — child {${this.label(d.member)}} is reported${note(f)}`, { factKey: f.key });
              }
            }
            // sheet "Exempt Child Member Dimension" (table, axis, parent, exempted child): an exempted child does not
            // count as a required child; when every child of the parent is exempted, the parent stands alone
            const kids = [...info.parents.entries()].filter(([, p]) => p === d.member).map(([m]) => m).filter((m) => info.members.get(m)?.usable)
              .filter((k) => !exC.some((e) => e.axis === d.axis && e.parent === d.member && e.member === k && tnames.includes(e.table)));
            if (doChild && kids.length && !kids.some((k) => have.has(k))) {
              const kidValid = kids.some((k) => dimensionallyValid(A, f.concept, f.dims.map((x) => (x.axis === d.axis ? { axis: x.axis, member: k } : x))).valid);
              const key = `C|${f.concept}|${d.axis}|${pk(f)}|${d.member}`;
              if (kidValid && !done.has(key)) {
                done.add(key);
                this.out(ctx, r, scope, sev(f), `At least one child member of {${this.label(d.member)}} should be present for element '${this.label(f.concept)}' on axis (${this.label(d.axis)})${note(f)}`, { factKey: f.key });
              }
            }
          }
        }
        failed = ctx.results.length - before;
        if (!failed && filing.all().some((f) => !f.nil && f.dims.some((d) => d.member))) this.out(ctx, r, 'CY', 'PASS', r.text);
        return;
      }
      case 'sequential-members': {
        const groups = new Map();
        if (r.ast.perElement) {
          // Filing Manual Annexure II #16: for each element and period, numbered members on
          // an axis are reported without gaps (EquityShares2Member requires EquityShares1Member for that element)
          for (const f of filing.all()) {
            if (f.nil) continue;
            for (const d of f.dims) {
              if (!d.member) continue;
              // per element, axis and period across the other axes (message names element, member and period only);
              // the ICOM 2022-23 instance reports Class2 without Class1 under one category and Class1 elsewhere
              const k = `${f.concept}|${d.axis}|${reportingYear(P, f.period)}|${f.period.type === 'instant' ? f.period.date : f.period.start + '/' + f.period.end}`;
              (groups.get(k) || groups.set(k, new Set()).get(k)).add(d.member.split(':')[1]);
            }
          }
          let bad = 0;
          for (const [k, vals] of groups) {
            const [concept, axis, scope] = k.split('|');
            for (const g of sequentialGaps([...vals])) { bad++; this.out(ctx, r, scope, 'FAIL', `The value for item '${this.label(concept)}' should be present for the member {${g.prefix}${g.missing}${g.suffix || ''}} on axis (${this.label(axis)}): it is entered for ${g.prefix}${g.max}${g.suffix || ''}`, { concept }); }
          }
          if (!bad && groups.size) this.out(ctx, r, 'CY', 'PASS', r.text);
          return;
        }
        // "members defined as 1, 2, 3 … n" = members defined in the taxonomy (EquityShares1Member, Shareholder1Member,
        // FinancialYearMember1 …). Typed members are free identifiers chosen by the filer: the MCA-validated CHARVAK
        // instance uses _NoncurrentInvestment_2/_3 and "DEVANSH DUA_17" style values without 1.
        for (const f of filing.all()) for (const d of f.dims) {
          if (!d.member) continue;
          const k = `${d.axis}|${reportingYear(P, f.period)}`;
          (groups.get(k) || groups.set(k, new Set()).get(k)).add(d.member.split(':')[1]);
        }
        for (const [k, vals] of groups) {
          const [axis, scope] = k.split('|');
          const gaps = sequentialGaps([...vals]);
          if (gaps.length) for (const g of gaps) this.out(ctx, r, scope, 'FAIL', `Members on (${this.label(axis)}) are not sequential: ${g.prefix}${g.missing}${g.suffix || ''} missing while ${g.prefix}${g.max}${g.suffix || ''} is provided`);
          else this.out(ctx, r, scope, 'PASS', 'sequential');
        }
        return;
      }
      case 'no-images': {
        for (const f of filing.all()) if (!f.nil && !A.isNumeric(f.concept) && /<img\b|data:image\/|<svg\b|<object\b|<embed\b/i.test(f.value)) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `Images/charts are not allowed (${this.label(f.concept)})`, { factKey: f.key });
        return;
      }
      case 'cy-py-pairing': {
        if (filing.meta.firstFinancialYear) { this.out(ctx, r, null, 'NOT_APPLICABLE', 'First financial year'); return; }
        const exemptElr = new Set(r.ast.exemptElrCodes);
        for (const f of filing.all()) {
          if (f.nil || !A.isMonetary(f.concept)) continue;
          const scope = filing.scopeOf(f.period);
          if (scope !== 'CY' && scope !== 'PY') continue;
          const elrs = A.conceptElrs(f.concept).map((u) => A.elr(u).code.slice(0, 6));
          if (elrs.length && elrs.every((c) => exemptElr.has(c))) continue;
          // "this rule shall not be applicable in case of dimensional tables. However, in case the table itself is
          // mandatory ... the previous year figures shall be made as mandatory" — the table must carry previous-year
          // figures (enforced per year by the table rules), not every member combination of the other year: the
          // MCA-validated CHARVAK instance has borrowing / investment rows reported in one year only.
          if (f.dims.length) continue;
          const other = scope === 'CY' ? 'PY' : 'CY';
          if (!this.app.conceptStatus(filing, f.concept, other).applicable) continue;
          const op = filing.period(f.concept, other);
          // the error belongs to the missing cell (the other year), so validation navigates to where the value goes
          if (!filing.get(f.concept, op, f.dims)) this.out(ctx, r, other, 'FAIL', `Since '${this.label(f.concept)}' is entered for the ${scope === 'CY' ? 'current' : 'previous'} year, the corresponding ${other === 'CY' ? 'current' : 'previous'}-year value should be entered${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''}`, { concept: f.concept, dims: f.dims, relatedFactKey: f.key });
        }
        return;
      }
      case 'opening-equals-prior-closing': this.out(ctx, r, null, 'PASS', 'Structural: CY opening and PY closing balances share one instant context in the filing model'); return;
      case 'monetary-max-2-decimals': {
        for (const f of filing.all()) {
          if (f.nil || !A.isMonetary(f.concept)) continue;
          const fd = Dec.fractionDigits(Dec.parse(f.value));
          if (fd > 2 || (f.decimals !== 'INF' && Number(f.decimals) > 2)) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `'${this.label(f.concept)}' has more than 2 decimal places`, { factKey: f.key });
        }
        return;
      }
      case 'inr-currency': {
        const exemptTables = new Set(r.ast.exemptTables);
        const exemptConcepts = new Set(r.ast.exemptConcepts || []);
        for (const f of filing.all()) {
          if (f.nil || !A.isMonetary(f.concept) || f.unit === 'INR' || exemptConcepts.has(f.concept)) continue;
          if (tablesForFact(A, f).some((t) => exemptTables.has(t.id))) continue;
          this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `Reporting currency should be INR for '${this.label(f.concept)}' (unit ${f.unit})`, { factKey: f.key });
        }
        return;
      }
      case 'elr-not-for-consolidated': case 'elr-not-for-prior-year': case 'elr-not-for-standalone': case 'general-info-consolidated': {
        for (const f of filing.all()) {
          const scope = reportingYear(P, f.period);
          if (scope !== 'CY' && scope !== 'PY') continue;
          const st = this.app.conceptStatus(filing, f.concept, scope);
          if (st.applicable) continue;
          const tag = r.id + ':';
          const tags = Object.values(this.app.tags).map((t) => t + ':');
          const mine = st.reasons.filter((x) => x.startsWith(tag));
          if (mine.length && mine.length === st.reasons.filter((x) => tags.some((t) => x.startsWith(t))).length) this.out(ctx, r, scope, 'FAIL', `'${this.label(f.concept)}' must not be reported: ${mine.join('; ')}`, { factKey: f.key });
        }
        if (h === 'general-info-consolidated') this.out(ctx, r, null, 'REVIEW_ONLY_EXTERNAL_DATA', 'Equality of general-information values between the standalone and consolidated instance documents requires the other instance document');
        return;
      }
      case 'mandatory-axes': {
        // Filing Manual Annexure II #20: for each element and each explicit member entered in the table, at least one
        // context of that element with that member must carry a member on every axis of the table ("all the axes
        // [...] are mandatory for atleast one context id of explicit member {M}") — where such a context is
        // dimensionally possible for the element
        let checked = 0, failed = 0;
        for (const [tname, axesLocal] of Object.entries(r.ast.tables)) {
          for (const t of A.tables.filter((x) => x.hypercube.split(':')[1] === tname)) {
            const items = new Set(t.lineItems);
            const tAxes = new Set(t.axes.map((x) => x.axis));
            const req = axesLocal.map((l) => A.qnameOfLocal(l)).filter(Boolean);
            const groups = new Map();
            for (const f of filing.all()) {
              if (f.nil || !items.has(f.concept) || !f.dims.length || !f.dims.every((d) => tAxes.has(d.axis)) || !factInTable(A, f, t)) continue;
              const k = f.concept + '|' + (f.period.type === 'instant' ? f.period.date : f.period.start + '/' + f.period.end);
              (groups.get(k) || groups.set(k, []).get(k)).push(f);
            }
            for (const fs of groups.values()) {
              const members = new Set(fs.flatMap((f) => f.dims.filter((d) => d.member).map((d) => d.member)));
              for (const m of members) {
                const withM = fs.filter((f) => f.dims.some((d) => d.member === m));
                if (withM.some((f) => req.every((ax) => f.dims.some((d) => d.axis === ax)))) { checked++; continue; }
                // is a full context possible for this element with this member?
                const f0 = withM[0];
                const missing = req.filter((ax) => !f0.dims.some((d) => d.axis === ax));
                const tryFill = (dims, rest) => {
                  if (!rest.length) return dimensionallyValid(A, f0.concept, dims).valid;
                  const ax = t.axes.find((x) => x.axis === rest[0]);
                  const def = A.dimensionDefault(rest[0]);
                  for (const mm of (ax?.members || []).filter((x) => x.usable && x.member !== def).slice(0, 15)) if (tryFill([...dims, { axis: rest[0], member: mm.member }], rest.slice(1))) return true;
                  return false;
                };
                if (!tryFill(f0.dims, missing)) continue;
                checked++; failed++;
                const date = f0.period.type === 'instant' ? f0.period.date : f0.period.end;
                this.out(ctx, r, reportingYear(P, f0.period), 'FAIL', `For element '${this.label(f0.concept)}' all the axes [${axesLocal.map((x) => `'${x}'`).join(',')}] are mandatory for atleast one context of explicit member {${this.label(m)}} on the table '${tname}' as on ${date}`, { factKey: f0.key });
              }
            }
          }
        }
        if (checked && !failed) this.out(ctx, r, 'CY', 'PASS', r.text);
        return;
      }
      case 'fta-opening-balance-sheet': {
        const flag = r.ast.flag ? filing.value(r.ast.flag, 'CY', []) : null;
        if (flag !== 'true') { this.out(ctx, r, 'CY', 'NOT_APPLICABLE', 'WhetherCompanyHasAdoptedIndAsFirstTime is not Yes'); return; }
        if (filing.meta.firstFinancialYear) { this.out(ctx, r, 'CY', 'NOT_APPLICABLE', 'First financial year of the company'); return; }
        const bs = A.elrByCode(r.ast.elr);
        const concepts = new Set();
        for (const arcs of [A.json.presentation[bs.uri] || []]) for (const x of arcs) for (const q of [x.from, x.to]) if (A.isMonetary(q) && A.concept(q).periodType === 'instant') concepts.add(q);
        let missing = 0;
        for (const q of concepts) {
          if (filing.value(q, 'CY', []) == null && filing.value(q, 'PY', []) == null) continue;
          if (filing.value(q, 'PYO', []) != null) continue;
          missing++;
          this.out(ctx, r, 'PYO', 'FAIL', `Since '${this.label(q)}' is entered for the current/previous year and WhetherCompanyHasAdoptedIndAsFirstTime has been selected as Yes, corresponding value for Opening Balance Sheet of Previous Year (${addDaysIso(P.py.start, -1)}) should be entered`, { concept: q, scopeCell: 'PYO' });
        }
        if (!missing) this.out(ctx, r, 'PYO', 'PASS', r.text);
        this.out(ctx, r, null, 'REVIEW_ONLY_EXTERNAL_DATA', 'Exemption for the second financial year of the company: needs the date of incorporation (MCA21 master data)');
        return;
      }
      default: throw new Error(`No generic handler ${h}`);
    }
  }
}
