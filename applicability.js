// Applicability engine: which ELRs, concepts and tables apply to a filing, per scope (CY/PY).
// Sources: the generic rules on report type / previous year (Ind AS GR-10..GR-13, found by handler), table rules from the
// specific-rules sheet ("table is mandatory in case ..."), and the cash-flow statement type.
// This is the AUTHORITATIVE gate: the UI reads it to disable controls, and the controller and the
// XML gate enforce it independently.
import { evalPred } from './expr.js';
import { reportingYear } from './periods.js';
import { tablesForFact, nondimAllowed } from './dimensions.js';
import { nondimRowConcepts, totalColumnAllowed } from './views.js';
import { statementNoteLinks } from './derived.js';
import * as Dec from './decimal.js';


// concepts presented with an opening-balance (periodStart) row — the GR-7 common opening/closing element
const OPENING = new WeakMap();
export function openingConcepts(A) {
  if (OPENING.has(A)) return OPENING.get(A);
  const set = new Set();
  for (const arcs of Object.values(A.json?.presentation || {})) for (const a of arcs) if (/periodStartLabel$/.test(a.preferredLabel || '') && A.concept(a.to)?.periodType === 'instant') set.add(a.to);
  // their calculation components too: an opening total entered at that instant needs its children (GR-1); the
  // MCA-validated ICOM 2022-23 instance reports DeferredTaxAssets / DeferredTaxLiabilities with the opening
  // DeferredTaxLiabilityAssets of the previous year ([612700])
  const kids = new Map();
  for (const arcs of Object.values(A.json?.calculation || {})) for (const a of arcs) (kids.get(a.from) || kids.set(a.from, new Set()).get(a.from)).add(a.to);
  const stack = [...set];
  while (stack.length) { const c = stack.pop(); for (const k of kids.get(c) || []) if (!set.has(k) && A.concept(k)?.periodType === 'instant') { set.add(k); stack.push(k); } }
  OPENING.set(A, set);
  return set;
}

// the facts a table condition reads
function conditionFacts(when) {
  const facts = new Set();
  const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(walk); return; } if (typeof x.fact === 'string') facts.add(x.fact); for (const v of Object.values(x)) walk(v); };
  walk(when);
  return facts;
}

export class ApplicabilityError extends Error {
  constructor(msg, reasons) { super(msg); this.reasons = reasons; }
}

export class Applicability {
  constructor(A) {
    this.A = A;
    // generic rules located by their handler (the workbook numbering differs between taxonomies)
    const h = (name) => A.rules.rules.find((r) => r.status === 'EXECUTABLE' && r.ast?.handler === name) || { id: name, ast: {} };
    const notCons = h('elr-not-for-consolidated'), notPy = h('elr-not-for-prior-year'), giCons = h('general-info-consolidated'), notSa = h('elr-not-for-standalone');
    this.tags = { notCons: notCons.id, notPy: notPy.id, giCons: giCons.id, notSa: notSa.id };
    this.gr11 = new Set(notCons.ast.codes || []);
    this.gr12 = new Set(notPy.ast.codes || []);
    this.gr12ex = notPy.ast.exceptions || {};
    this.pyExcludedTables = new Set(notPy.ast.excludedTables || []);
    this.pyExcludedConcepts = new Set(notPy.ast.excludedConcepts || []);
    this.gr13 = new Set(giCons.ast.allowed || []);
    this.gr14 = new Set(notSa.ast.codes || []);
    const prof = A.meta.profile || {};
    this.generalInfoCode = prof.generalInformation || null;
    this.cashFlowByCode = Object.fromEntries(Object.entries(prof.cashFlowMethods || {}).map(([method, code]) => [code, method]));
    this.currencies = new Set(A.rules.currencies || []);
    this.countries = new Set((A.rules.countries || []).map((c) => c.toUpperCase()));
    // Yes/No dependencies compiled from the MCA conditional rules (rule-formalizer.mjs → booleanDependencies)
    this.deps = A.rules.booleanDependencies || [];
    this.depsByChild = new Map();
    for (const d of this.deps) for (const c of d.childConcepts) (this.depsByChild.get(c) || this.depsByChild.set(c, []).get(c)).push(d);
  }

  // Boolean dependency state of a child concept: not applicable when its parent Yes/No element is answered with
  // the opposite of the condition under which the MCA rule requires the child.
  // A child required by several questions ("mandatory if Yes in A", "mandatory if Yes in B") applies when any of
  // them is answered with its condition; it is not applicable only when an answered question excludes it and none
  // includes it.
  dependencyStatus(filing, concept, scope) {
    const reasons = [];
    let included = false;
    for (const d of this.depsByChild.get(concept) || []) {
      const v = filing.value(d.parentConcept, scope === 'PYO' ? 'PY' : scope, []); // the opening balance sheet answers with the previous year
      if (v == null) continue;
      if ((v === 'true') === d.condition) { included = true; continue; }
      reasons.push(`DEP: '${this.A.label(d.parentConcept)}' is ${v === 'true' ? 'Yes' : 'No'} — applies only when ${d.condition ? 'Yes' : 'No'} (${d.rules.join(', ')})`);
    }
    if (included) return { applicable: true, reasons: [] };
    return { applicable: reasons.length === 0, reasons };
  }

  env(filing, scope, extra = {}) {
    return { filing, A: this.A, scope, dims: [], today: new Date().toISOString().slice(0, 10), countries: this.countries, currencies: this.currencies, ...extra };
  }

  cashFlowType(filing) {
    const q = this.A.qnameOfLocal('TypeOfCashFlowStatement');
    return filing.value(q, 'CY', []);
  }

  // ---- ELR level
  elrStatus(filing, elrUri, scope) {
    const e = this.A.elr(elrUri);
    if (!e) return { applicable: false, reasons: ['Unknown ELR'] };
    const code = e.code.slice(0, 6);
    const reasons = [];
    const rt = filing.meta.reportType;
    const T = this.tags;
    if (rt === 'Consolidated' && this.gr11.has(code)) reasons.push(`${T.notCons}: [${code}] not applicable to a consolidated instance`);
    if (rt === 'Standalone' && this.gr14.has(code)) reasons.push(`${T.notSa}: [${code}] not applicable to a standalone instance`);
    if (scope !== 'CY' && this.gr12.has(code)) reasons.push(`${T.notPy}: [${code}] not applicable for the previous year`);
    if (scope !== 'CY' && filing.meta.firstFinancialYear) reasons.push('First financial year: no previous-year figures');
    if (this.cashFlowByCode[code]) {
      const t = this.cashFlowType(filing);
      if (t && t !== this.cashFlowByCode[code]) reasons.push(`TypeOfCashFlowStatement is '${t}'`);
    }
    return { applicable: reasons.length === 0, reasons, partialExceptions: scope !== 'CY' ? this.gr12ex[code] || null : null };
  }

  // ---- concept level: applicable if at least one of its presentation ELRs applies
  // First-time adoption of Ind AS (WhetherCompanyHasAdoptedIndAsFirstTime = Yes, not the first financial year)
  ftaActive(filing) {
    if (this._fta === undefined) this._fta = this.A.qnameOfLocal('WhetherCompanyHasAdoptedIndAsFirstTime');
    return !!this._fta && !filing.meta.firstFinancialYear && filing.value(this._fta, 'CY', []) === 'true';
  }
  // The previous-year opening instant (PYO) carries opening balances of roll-forwards (concepts presented with a
  // periodStart label) in every filing; any other element at that instant belongs to the opening balance sheet of
  // the previous year, which is reported only under first-time adoption (GR-16 / Filing Manual Annexure II #21).
  pyoStatus(filing, concept) {
    if (openingConcepts(this.A).has(concept) || this.ftaActive(filing)) return null;
    return { applicable: false, reasons: [`FTA: '${this.A.concept(concept).name}' at the opening of the previous year belongs to the opening balance sheet of the previous year, reported only when WhetherCompanyHasAdoptedIndAsFirstTime is Yes (GR-16)`] };
  }

  // true when one of the concept's ELRs is excluded for the previous year (GR-11) without an element exception
  pyExcludedSomewhere(filing, concept) {
    if (filing.meta.firstFinancialYear) return false;
    if (this.pyExcludedConcepts.has(concept)) return true;
    const local = this.A.concept(concept).name;
    return this.A.conceptElrs(concept).some((uri) => {
      const code = this.A.elr(uri).code.slice(0, 6);
      if (!this.gr12.has(code) || (this.gr12ex[code] || []).includes(local)) return false;
      const st = this.elrStatus(filing, uri, 'PY');
      return !st.applicable && st.reasons.some((r) => r.startsWith(this.tags.notPy + ':'));
    });
  }

  conceptStatus(filing, concept, scope) {
    if (scope === 'PYO') { const no = this.pyoStatus(filing, concept); if (no) return no; }
    const elrs = this.A.conceptElrs(concept);
    if (!elrs.length) return { applicable: true, reasons: [] };
    const local = this.A.concept(concept).name;
    const reasons = [];
    const T = this.tags;
    // element-level previous-year exclusions inside ELRs that otherwise apply (Ind AS generic rule on previous year)
    if (scope !== 'CY' && this.pyExcludedConcepts.has(concept)) return { applicable: false, reasons: [`${T.notPy}: '${local}' not applicable for the previous year`] };
    for (const uri of elrs) {
      const st = this.elrStatus(filing, uri, scope);
      const code = this.A.elr(uri).code.slice(0, 6);
      let ok = st.applicable;
      // element exceptions to the previous-year ELR exclusion
      if (!ok && scope !== 'CY' && !filing.meta.firstFinancialYear && st.reasons.every((r) => r.startsWith(T.notPy + ':')) && (this.gr12ex[code] || []).includes(local)) ok = true;
      // general information in a consolidated instance only for the listed elements
      if (ok && filing.meta.reportType === 'Consolidated' && code === this.generalInfoCode && !this.gr13.has(local)) { ok = false; st.reasons.push(`${T.giCons}: '${local}' not applicable in a consolidated instance`); }
      if (ok) return this.dependencyStatus(filing, concept, scope);
      reasons.push(...st.reasons);
    }
    return { applicable: false, reasons: [...new Set(reasons)] };
  }

  // ---- cell level: one cell = (filing tab / ELR, concept, scope). The single decision used by the UI (enable,
  // display), the importer (keep/drop), the gate (emit/exclude) and generation.
  cellStatus(filing, elrUri, concept, scope) {
    const st = this.elrStatus(filing, elrUri, scope);
    if (!st.applicable) {
      const code = this.A.elr(elrUri)?.code.slice(0, 6);
      const local = this.A.concept(concept)?.name;
      const gr12only = scope !== 'CY' && !filing.meta.firstFinancialYear && st.reasons.every((r) => r.startsWith(this.tags.notPy + ':')) && (this.gr12ex[code] || []).includes(local);
      if (!gr12only) return { applicable: false, reasons: st.reasons };
    }
    return this.conceptStatus(filing, concept, scope);
  }

  // ---- fact level: which facts of a filing are filing data (emit) and which are not applicable (excluded)
  planFacts(filing) {
    const emit = [], excluded = [];
    const P = filing.meta.periods;
    const opening = filing.meta.yearMode === 'current' ? openingConcepts(this.A) : null;
    for (const f of filing.all()) {
      let y = reportingYear(P, f.period);
      if (y !== 'CY' && y !== 'PY') { emit.push(f); continue; } // reported by period checks
      // current-year-only filing: a previous-year-end instant of an opening-balance concept is the current-year
      // opening balance (GR-7), so it is a current-year cell
      if (opening && y === 'PY' && f.period.type === 'instant' && opening.has(f.concept)) y = 'CY';
      if (filing.scopeOf(f.period) === 'PYO') { const no = this.pyoStatus(filing, f.concept); if (no) { excluded.push({ fact: f, reasons: no.reasons }); continue; } }
      const cs = this.conceptStatus(filing, f.concept, y);
      if (!cs.applicable && !this.sourceZeroStatement(f, cs.reasons)) { excluded.push({ fact: f, reasons: cs.reasons }); continue; }
      if (f.dims.length) {
        const ts = tablesForFact(this.A, f);
        if (ts.length && !ts.some((t) => this.tableStatus(filing, t.id, y).applicable)) {
          excluded.push({ fact: f, reasons: ts.flatMap((t) => this.tableStatus(filing, t.id, y).reasons) });
          continue;
        }
      }
      emit.push(f);
    }
    return { emit, excluded };
  }

  // A monetary zero that the imported instance itself reported on a main statement (balance sheet, statement of profit
  // and loss, cash flow statement: ELR codes 1xxxxx-3xxxxx) is a statement line of the filed accounts (e.g. the OCI
  // totals presented as 0 while the 'OCI presented net of tax' flag is No — GE Power Boilers 2024-25). It is kept only
  // when the sole reason to hide it is a Yes/No dependency; table conditions still apply, and zeros typed by the user
  // are never kept this way. A disclosure under a No answer (e.g. number of subsidiary companies = 0 while 'Whether
  // company has subsidiary companies' is No) stays not applicable (v1.1: v1 kept every numeric zero).
  sourceZeroStatement(f, reasons) {
    return f.origin === 'import' && !f.nil && this.A.isMonetary(f.concept) && Dec.eq(Dec.parse(f.value), Dec.ZERO)
      && reasons.length > 0 && reasons.every((r) => String(r).startsWith('DEP:'))
      && this.A.conceptElrs(f.concept).some((u) => /^[123]/.test(this.A.elr(u)?.code || ''));
  }

  // ---- table level
  tableStatus(filing, tableId, scope) {
    const t = this.A.table(tableId);
    if (!t) return { applicable: false, reasons: ['Unknown table'] };
    if (t.presentationElr) {
      const st = this.elrStatus(filing, t.presentationElr, scope);
      if (!st.applicable) {
        // previous-year ELR exceptions may keep individual line items alive (GR-12)
        const ex = st.partialExceptions || [];
        if (!(st.reasons.every((r) => r.startsWith(this.tags.notPy + ':')) && t.lineItems.some((q) => ex.includes(this.A.concept(q).name)))) return { applicable: false, reasons: st.reasons };
      }
    }
    if (scope !== 'CY' && this.pyExcludedTables.has(tableId)) return { applicable: false, reasons: [`${this.tags.notPy}: table not applicable for the previous year`] };
    const conds = this.A.rules.tableApplicability[tableId] || [];
    const bonds = this.A.rules.rules.find((r) => r.status === 'EXECUTABLE' && r.ast?.type === 'tableIffMembers' && r.ast.tables.includes(tableId));
    if (!conds.length && !bonds) return { applicable: true, reasons: [], conditional: false };
    const env = this.env(filing, scope);
    const met = [];
    const unmet = [];
    const open = [];
    if (!this._ruleText) this._ruleText = new Map(this.A.rules.rules.map((r) => [r.id, String(r.source?.clause || r.text || '').replace(/\s+/g, ' ').trim()]));
    const why = (id) => { const t = this._ruleText.get(id) || ''; return t ? ` — MCA rule: "${t.length > 180 ? t.slice(0, 180) + '…' : t}"` : ''; };
    for (const c of conds) {
      const v = evalPred(c.when, env);
      if (v === true) met.push(`${c.rule}: condition met${why(c.rule)}`);
      // v1.2 (C&I v12): a condition on a total that the taxonomy calculates from this table's own line items, or on the
      // table's own total column, cannot close the table while it holds values — clearing a value would otherwise
      // switch the table off and it could never be entered again
      else if (this.circular(tableId, c.when) && this.tableHasOwnData(filing, t, scope)) met.push(`${c.rule}: condition depends on this table's own values, which are entered`);
      // v1.2 (C&I v13): the condition reads only statement figures taken from this table (derived.js statementNoteLinks):
      // while they are not determined yet, or derived from it (calculated, not entered), the table is open so that they
      // can be derived from it (not mandatory; a figure entered as 0 closes it)
      else if (this.derivedFromTable(tableId, c.when) && (v === null || this.conditionFactsDerived(filing, c.when, scope))) open.push(`${c.rule}: the statement figure is taken from this table — enter the table to derive it`);
      else unmet.push(`${c.rule}: ${v === null ? 'condition not determinable (fact not entered)' : 'condition not met'}${why(c.rule)}`);
    }
    if (bonds) {
      const has = this.membersHaveData(filing, scope, bonds.ast.otherTables, bonds.ast.axis, bonds.ast.members);
      (has ? met : unmet).push(`${bonds.id}: ${has ? 'Bonds/Debentures borrowings reported' : 'no BondsMember/DebenturesMember borrowings reported'}`);
    }
    if (met.length) return { applicable: true, mandatory: true, conditional: true, reasons: met };
    if (open.length) return { applicable: true, mandatory: false, conditional: true, reasons: open };
    return { applicable: false, conditional: true, reasons: unmet };
  }

  // every figure the condition reads is a statement figure taken from this table (statementNoteLinks)
  derivedFromTable(tableId, when) {
    const facts = conditionFacts(when);
    const links = statementNoteLinks(this.A);
    return facts.size > 0 && [...facts].every((q) => links.get(q)?.tableId === tableId);
  }
  // a figure the condition reads is empty or was calculated by the tool from this table (not entered or imported)
  conditionFactsDerived(filing, when, scope) {
    return [...conditionFacts(when)].some((q) => { const x = filing.get(q, filing.period(q, scope), []); return !x || x.nil || x.origin === 'calculated'; });
  }
  // the condition reads a total that is a calculation parent of one of the table's line items, or one of the table's
  // own total-column cells
  circular(tableId, when) {
    const m = (this._circ ||= new Map());
    const k = tableId + JSON.stringify(when);
    if (m.has(k)) return m.get(k);
    const facts = conditionFacts(when);
    const items = new Set(this.A.table(tableId).lineItems);
    let r = false;
    for (const arcs of Object.values(this.A.json.calculation || {})) for (const a of arcs) if (facts.has(a.from) && items.has(a.to)) r = true;
    if (totalColumnAllowed(this.A, tableId) && [...facts].some((q) => items.has(q) && nondimAllowed(this.A, q))) r = true;
    m.set(k, r);
    return r;
  }
  tableHasOwnData(filing, t, scope) {
    const items = new Set(t.lineItems), axes = new Set(t.axes.map((a) => a.axis));
    // values of the table itself: member columns, or the total column of elements that are not a statement row
    const rows = nondimRowConcepts(this.A);
    return filing.all().some((f) => items.has(f.concept) && !f.nil && f.dims.every((d) => axes.has(d.axis)) && reportingYear(filing.meta.periods, f.period) === scope && (f.dims.length > 0 || !rows.has(f.concept)));
  }

  membersHaveData(filing, scope, tableIds, axis, members) {
    const tables = tableIds.map((id) => this.A.table(id));
    const lineItems = new Set(tables.flatMap((t) => t.lineItems));
    return filing.all().some((f) => lineItems.has(f.concept) && filing.scopeOf(f.period) === scope && f.dims.some((d) => d.axis === axis && members.includes(d.member)) && !f.nil);
  }

  // Authoritative controller check: throws when a table may not be opened/edited.
  assertTableOpen(filing, tableId, scope) {
    const st = this.tableStatus(filing, tableId, scope);
    if (!st.applicable) throw new ApplicabilityError(`Table ${tableId} is not applicable for ${scope}`, st.reasons);
    return st;
  }
}
