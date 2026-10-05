// Application controller: the only API the UI talks to. Enforces applicability and dimensional
// validity on every write (independently of any disabled UI control).
import { Filing, FactValueError, normDims, dimKey } from './model.js';
import { Applicability, ApplicabilityError } from './applicability.js';
import { checkDimensionSyntax, dimensionallyValid, nextTypedMember, nondimAllowed } from './dimensions.js';
import { buildElrView, buildTableView, tableSlices, defaultSliceAllowed } from './views.js';
import { reportingYear, openingPeriodFor, addDays as addDaysIso } from './periods.js';
import { Gate, exportXml } from './gate.js';
import { importInstance, CashFlowChoiceError, nextFinancialYear } from './importer.js';
import { toDisplay } from './scaling.js';
import * as Dec from './decimal.js';

// decimals of a derived total: the lowest accuracy of its operands (XBRL), but never coarser than the digits the exact
// total carries — Filing Manual #13: non-significant digits of a numeric fact must be 0 (operands entered at different
// rounding levels, e.g. after the level of rounding was changed)
export function sumDecimals(facts, total) {
  const decs = facts.map((x) => x.decimals).filter((d) => d != null && d !== 'INF').map(Number);
  if (!decs.length) return 'INF';
  let d = Math.min(...decs);
  const req = Dec.requiredDecimals(total);
  if (req !== Infinity && req > d) d = Math.min(req, Math.max(...decs));
  return String(d);
}

export class DimensionError extends Error { constructor(msg, details) { super(msg); this.details = details; } }
export class CalculatedCellError extends Error {}

// Calculation-network index from the taxonomy calculation linkbase (read-only; the arcs are never changed).
const CALC = new WeakMap();
function calcIndex(A) {
  if (CALC.has(A)) return CALC.get(A);
  const parentsByChild = new Map(), childrenOf = new Map(), byParent = new Map();
  for (const [elr, arcs] of Object.entries(A.json.calculation)) {
    const code = A.json.roles[elr]?.code?.slice(0, 6);
    for (const a of arcs) {
      (parentsByChild.get(a.to) || parentsByChild.set(a.to, []).get(a.to)).push({ elr, code, parent: a.from });
      const k = elr + '|' + a.from;
      (childrenOf.get(k) || childrenOf.set(k, []).get(k)).push(a);
      (byParent.get(a.from) || byParent.set(a.from, []).get(a.from)).push({ elr, code });
    }
  }
  const idx = { parentsByChild, childrenOf, byParent };
  CALC.set(A, idx);
  return idx;
}

// Formula-linkbase roll-forward index (closing = opening + change), from the compiled authority.
const FX = new WeakMap();
function formulaIndex(A) {
  if (FX.has(A)) return FX.get(A);
  const byBalance = new Map(), byChange = new Map();
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || r.ast?.type !== 'crossPeriod') continue;
    (byBalance.get(r.ast.balance) || byBalance.set(r.ast.balance, []).get(r.ast.balance)).push(r.ast);
    (byChange.get(r.ast.change) || byChange.set(r.ast.change, []).get(r.ast.change)).push(r.ast);
  }
  const idx = { byBalance, byChange };
  FX.set(A, idx);
  return idx;
}

export class Session {
  constructor(A, filing = null) {
    this.A = A;
    this.app = new Applicability(A);
    this.filing = filing || new Filing(A);
    this._views = new Map();
  }

  // ---- filing setup: meta values are mirrored into the general-information facts
  setMeta(patch) {
    Object.assign(this.filing.meta, patch);
    if (patch.periods) this.filing.meta.periods = { ...this.filing.meta.periods, ...patch.periods };
    const f = this.filing, A = this.A, P = f.meta.periods;
    const mirror = (local, value, scopes = ['CY']) => {
      const q = A.qnameOfLocal(local);
      if (!q || value == null || value === '') return;
      for (const s of scopes) { const p = f.period(q, s); if (p) f.setFact({ concept: q, period: p, value, origin: 'meta', lang: A.isNumeric(q) ? null : 'en' }); }
    };
    if (P.cy.start && P.cy.end) {
      mirror('CorporateIdentityNumber', f.meta.cin);
      mirror('NatureOfReportStandaloneConsolidated', f.meta.reportType);
      mirror('LevelOfRoundingUsedInFinancialStatements', f.meta.level);
      mirror('DateOfStartOfReportingPeriod', P.cy.start);
      mirror('DateOfEndOfReportingPeriod', P.cy.end);
      if (!f.meta.firstFinancialYear && P.py.start && P.py.end) {
        const qs = A.qnameOfLocal('DateOfStartOfReportingPeriod'), qe = A.qnameOfLocal('DateOfEndOfReportingPeriod');
        f.setFact({ concept: qs, period: f.period(qs, 'PY'), value: P.py.start, origin: 'meta' });
        f.setFact({ concept: qe, period: f.period(qe, 'PY'), value: P.py.end, origin: 'meta' });
      }
    }
    f.revision++;
  }

  elrView(uri) { if (!this._views.has(uri)) this._views.set(uri, buildElrView(this.A, uri)); return this._views.get(uri); }
  tableView(id) { const k = 'T' + id; if (!this._views.has(k)) this._views.set(k, buildTableView(this.A, id)); return this._views.get(k); }

  elrStatus(uri, scope) { return this.app.elrStatus(this.filing, uri, scope); }
  conceptStatus(q, scope) { return this.app.conceptStatus(this.filing, q, scope); }
  tableStatus(id, scope) { return this.app.tableStatus(this.filing, id, scope); }

  // ---- non-dimensional values
  periodForCell(concept, scope, preferredLabel) {
    const c = this.A.concept(concept);
    if (c.periodType === 'instant' && preferredLabel === 'periodStartLabel') return openingPeriodFor(this.filing.meta.periods, scope);
    return this.filing.period(concept, scope);
  }
  getValue(concept, scope, dims = [], preferredLabel = null) {
    const p = this.periodForCell(concept, scope, preferredLabel);
    return p ? this.filing.get(concept, p, dims) : null;
  }
  displayOf(fact) {
    if (!fact || fact.nil) return '';
    return this.A.dataType(fact.concept) === 'monetary' ? toDisplay(fact.value, this.filing.meta.level) : fact.value;
  }
  // Editing options (UI): tab = the filing tab (ELR) the cell is on — its applicability decides (cellStatus);
  // recalc = re-derive calculated parent cells; override = the tab's "edit calculated cells" option is on.
  setValue(concept, scope, display, { preferredLabel = null, tab = null, recalc = false, override = false } = {}) {
    const st = tab ? this.app.cellStatus(this.filing, tab, concept, scope) : this.app.conceptStatus(this.filing, concept, scope);
    if (!st.applicable) throw new ApplicabilityError(`${concept} is not applicable for ${scope}`, st.reasons);
    if (!nondimAllowed(this.A, concept)) throw new DimensionError(`${concept} can only be reported inside its table`);
    if (tab && !override && this.calculatedCell(concept, scope, [], tab)) throw new CalculatedCellError(`${this.A.label(concept)} is calculated from its child elements — enable editing of calculated cells for this tab to override it`);
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) throw new FactValueError('Reporting periods are not set');
    const f = this.filing.setDisplayValue({ concept, period: p, display });
    if (f && override && this.calculatedCell(concept, scope, [], tab)) f.origin = 'override';
    if (recalc) this.recalcFrom(concept, p, []);
    return f;
  }

  // ---- calculated (auto-populated) cells
  // A cell is calculated when the tab's own calculation network (same ELR code) defines the concept as a parent
  // with at least one child that can be reported in the cell's context, and that network applies to the filing.
  calculatedCell(concept, scope, dims = [], tabElrUri = null) {
    const A = this.A;
    const idx = calcIndex(A);
    const code = tabElrUri ? A.elr(tabElrUri)?.code.slice(0, 6) : null;
    for (const { elr, code: c } of idx.byParent.get(concept) || []) {
      if (code && c !== code) continue;
      const pres = A.elrs.find((e) => e.code === c);
      if (pres && !this.app.elrStatus(this.filing, pres.uri, scope).applicable) continue;
      const kids = idx.childrenOf.get(elr + '|' + concept) || [];
      if (kids.some((a) => (dims.length ? dimensionallyValid(A, a.to, dims).valid : nondimAllowed(A, a.to)))) return { elr, children: kids.map((a) => a.to) };
    }
    return null;
  }
  // Re-derive the calculation parents of an edited cell (same period and dimensions), bottom-up. The parent is
  // Σ(child × weight) of the children reported in its network; a manual override is never replaced.
  recalcFrom(concept, period, dims = [], depth = 0) {
    if (depth > 12) return;
    const A = this.A, f = this.filing, idx = calcIndex(A);
    const nd = normDims(dims);
    this.rollForwardFrom(concept, period, nd, depth);
    const seen = new Set();
    for (const { elr, code, parent } of idx.parentsByChild.get(concept) || []) {
      if (seen.has(parent)) continue;
      const pc = A.concept(parent);
      if (!pc || (pc.periodType === 'instant') !== (period.type === 'instant')) continue;
      const pres = A.elrs.find((e) => e.code === code);
      const scope = reportingYear(f.meta.periods, period);
      if (scope !== 'CY' && scope !== 'PY') continue;
      if (pres && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
      if (!this.app.conceptStatus(f, parent, scope).applicable) continue;
      if (nd.length ? !dimensionallyValid(A, parent, nd).valid : !nondimAllowed(A, parent)) continue;
      const existing = f.get(parent, period, nd);
      if (existing && existing.origin === 'override') { seen.add(parent); continue; }
      const kids = (idx.childrenOf.get(elr + '|' + parent) || []).map((a) => ({ a, fact: f.get(a.to, period, nd) })).filter((k) => k.fact && !k.fact.nil);
      seen.add(parent);
      if (!kids.length) { if (existing && existing.origin === 'calculated') { f.removeFact(existing.key); this.recalcFrom(parent, period, nd, depth + 1); } continue; }
      const total = Dec.sum(kids.map((k) => Dec.mul(Dec.parse(k.fact.value), Dec.parse(String(k.a.weight)))));
      const decimals = sumDecimals(kids.map((k) => k.fact), total);
      f.setFact({ concept: parent, period, dims: nd, value: Dec.toString(total), decimals, unit: kids[0].fact.unit, origin: 'calculated' });
      this.recalcFrom(parent, period, nd, depth + 1);
    }
  }

  // Roll-forward auto-population from the formula linkbase: when an opening balance or a change is entered, the
  // closing balance of the same context is derived as opening + change (an opening that is not entered counts as 0,
  // Filing Manual Annexure II #19). Only derived where the change is reported, and never over a value that was typed
  // or imported (origin 'calculated' only) — the FX-* rule still checks every closing balance.
  rollForwardFrom(concept, period, nd, depth = 0) {
    if (depth > 12) return;
    const A = this.A, f = this.filing, fx = formulaIndex(A), P = f.meta.periods;
    const targets = [];
    if (period.type === 'duration') for (const a of fx.byChange.get(concept) || []) targets.push({ a, cp: period });
    if (period.type === 'instant') for (const a of fx.byBalance.get(concept) || []) {
      // the instant is the opening of the year that starts the next day (CY opening = PY end; PY opening = PYO)
      for (const scope of ['CY', 'PY']) { const cp = f.period(a.change, scope); if (cp && cp.start && addDaysIso(period.date, 1) === cp.start) targets.push({ a, cp }); }
    }
    for (const { a, cp } of targets) {
      const scope = reportingYear(P, cp);
      if (scope !== 'CY' && scope !== 'PY') continue;
      if (!this.app.conceptStatus(f, a.balance, scope).applicable) continue;
      const change = f.get(a.change, cp, nd);
      if (!change || change.nil) continue;
      const openP = { type: 'instant', date: addDaysIso(cp.start, -1) }, closeP = { type: 'instant', date: cp.end };
      const opening = f.get(a.balance, openP, nd);
      const closing = f.get(a.balance, closeP, nd);
      if (closing && closing.origin !== 'calculated') continue;
      if (nd.length ? !dimensionallyValid(A, a.balance, nd).valid : !nondimAllowed(A, a.balance)) continue;
      const total = Dec.add(opening && !opening.nil ? Dec.parse(opening.value) : Dec.ZERO, Dec.parse(change.value));
      f.setFact({ concept: a.balance, period: closeP, dims: nd, value: Dec.toString(total), decimals: sumDecimals([opening, change].filter(Boolean), total), unit: change.unit, origin: 'calculated' });
      this.recalcFrom(a.balance, closeP, nd, depth + 1);
    }
  }
  // Roll-forward relationships of a concept (for the UI: which cells are derived from opening + change)
  rollForward(concept) { const fx = formulaIndex(this.A); return { asBalance: fx.byBalance.get(concept) || [], asChange: fx.byChange.get(concept) || [] }; }

  // ---- tables (authoritative controller layer)
  openTable(tableId, scope) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    const view = this.tableView(tableId);
    const slices = tableSlices(this.A, this.filing, tableId, scope, reportingYear);
    return { view, slices, status: this.app.tableStatus(this.filing, tableId, scope) };
  }
  validateSlice(tableId, dims) {
    const t = this.A.table(tableId);
    const nd = normDims(dims);
    const errs = checkDimensionSyntax(this.A, nd);
    for (const d of nd) if (!t.axes.some((a) => a.axis === d.axis)) errs.push({ code: 'dim.notInTable', msg: `${d.axis} is not an axis of ${t.hypercube}` });
    if (!nd.length && t.axes.length && !defaultSliceAllowed(this.A, t)) errs.push({ code: 'dim.none', msg: 'At least one axis member is required for a table row' });
    if (errs.length) throw new DimensionError(errs.map((e) => e.msg).join('; '), errs);
    return nd;
  }
  setTableValue(tableId, scope, dims, concept, display, { preferredLabel = null, recalc = false, override = false, lockCalculated = false } = {}) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    const t = this.A.table(tableId);
    if (!t.lineItems.includes(concept)) throw new DimensionError(`${concept} is not a line item of ${t.hypercube}`);
    const nd = this.validateSlice(tableId, dims);
    const dv = dimensionallyValid(this.A, concept, nd);
    if (!dv.valid) throw new DimensionError(`${concept} is not valid for [${dimKey(nd)}]: ${dv.reason}`);
    const st = this.app.conceptStatus(this.filing, concept, scope);
    if (!st.applicable) throw new ApplicabilityError(`${concept} is not applicable for ${scope}`, st.reasons);
    const calc = lockCalculated || override ? this.calculatedCell(concept, scope, nd, t.presentationElr) : null;
    if (lockCalculated && !override && calc) throw new CalculatedCellError(`${this.A.label(concept)} is calculated from its child elements — enable editing of calculated cells for this tab to override it`);
    const p = this.periodForCell(concept, scope, preferredLabel);
    const f = this.filing.setDisplayValue({ concept, period: p, dims: nd, display });
    if (f && override && calc) f.origin = 'override';
    if (recalc) this.recalcFrom(concept, p, nd);
    return f;
  }
  // rename a typed member (edit imported or new typed members) — moves every fact of the slice
  renameTypedMember(tableId, scope, dims, axis, newValue) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    if (!String(newValue).trim()) throw new DimensionError('Typed member value must not be empty');
    const from = dimKey(normDims(dims));
    const to = normDims(dims.map((d) => (d.axis === axis ? { axis, typed: newValue } : d)));
    this.validateSlice(tableId, to);
    const moved = [];
    for (const f of this.filing.all()) {
      if (dimKey(f.dims) !== from || reportingYear(this.filing.meta.periods, f.period) !== scope) continue;
      if (this.filing.get(f.concept, f.period, to)) throw new DimensionError(`A row with ${axis}="${newValue}" already exists`);
      moved.push(f);
    }
    for (const f of moved) {
      this.filing.removeFact(f.key);
      this.filing.setFact({ ...f, dims: to, value: f.value, origin: f.origin === 'import' ? 'edited' : f.origin });
    }
    return to;
  }
  removeSlice(tableId, scope, dims) {
    // only the table's own line items: the default slice shares its (empty) context with every non-dimensional fact
    const items = new Set(this.A.table(tableId).lineItems);
    const k = dimKey(normDims(dims));
    for (const f of this.filing.all()) if (items.has(f.concept) && dimKey(f.dims) === k && reportingYear(this.filing.meta.periods, f.period) === scope) this.filing.removeFact(f.key);
  }
  suggestTypedValue(tableId, scope, axis) {
    const view = this.tableView(tableId);
    const ax = view.axes.find((a) => a.axis === axis);
    const prefix = (ax.typedDomain || axis).split(':')[1].replace(/Domain$/, '').replace(/ies$/, 'y').replace(/s$/, '');
    const existing = this.filing.all().flatMap((f) => f.dims.filter((d) => d.axis === axis && d.typed != null).map((d) => d.typed));
    // keep the naming already used on this axis (uniform, sequential member names — Filing Manual §1.3.2(6))
    const used = existing.map((v) => /^(.*?)\d+$/.exec(v)?.[1]).filter((x) => x != null);
    return nextTypedMember(existing, used.length ? used.sort()[0] : prefix);
  }

  // ---- validation / XML
  validate(opts) { return new Gate(this.A).run(this.filing, opts); }
  validateTab(elrUri, opts = {}) { return new Gate(this.A).run(this.filing, { ...opts, tab: elrUri }); }
  cellStatus(elrUri, concept, scope) { return this.app.cellStatus(this.filing, elrUri, concept, scope); }
  dependencies() { return this.app.deps; }
  exportXml(opts) { return exportXml(this.A, this.filing, opts); }
  // Dry run used by the import dialog: year breakdown of the source before the user chooses a mode.
  previewXml(text, opts = {}) {
    let res;
    try { res = importInstance(this.A, text, { ...opts, yearMode: 'both' }); }
    catch (e) {
      if (!(e instanceof CashFlowChoiceError)) throw e;
      // ambiguous cash-flow method: preview with either method to show the year split, then ask the user
      res = importInstance(this.A, text, { ...opts, yearMode: 'both', cashFlowMethod: 'Indirect Method' });
      res.report.cashFlow = { ...e.cashFlow, needsChoice: true };
    }
    const { report } = res;
    const per = report.periodDetection;
    const rollForward = per?.cy?.start && per?.cy?.end ? { newCurrent: nextFinancialYear(per.cy), newPrevious: per.cy } : null;
    return { periods: per, rollForward, byYear: report.byYear, counts: report.counts, unresolved: report.unresolvedFacts.length, errors: report.errors, cashFlow: report.cashFlow, notApplicable: report.notApplicable.length };
  }
  importXml(text, opts) {
    const { filing, report } = importInstance(this.A, text, opts);
    this.filing = filing;
    this._views.clear();
    return report;
  }
}

export { ApplicabilityError };
