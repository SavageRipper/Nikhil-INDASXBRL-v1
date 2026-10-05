// Internal XML validation gate. Runs BEFORE every download; blocking errors stop generation.
// This is an internal pre-check only — it is NOT the official MCA XBRL Validator.
import * as Dec from './decimal.js';
import { validatePeriods, periodsOverlap, reportingYear } from './periods.js';
import { checkDimensionSyntax, dimensionallyValid, tablesForFact } from './dimensions.js';
import { unitDef, unitMatchesType } from './units.js';
import { RuleEngine } from './rules.js';
import { Applicability } from './applicability.js';
import { FORMATS } from './expr.js';
import { Filing, factKey } from './model.js';
import { generateInstance } from './generator.js';
import { parseHtml, xmlSafe } from './richtext.js';

export const Severity = { ERROR: 'ERROR', WARNING: 'WARNING', INFO: 'INFO' };

// Filing Manual HTML guidelines (a)–(i) for textual content, plus the structure the MCA Validator's HTML schema
// (namespace http://www.mca.gov.in/XBRL/HTML) enforces. Evidence: the MCA Validator rejected
//   <colgroup> inside <table>   "cvc-complex-type.2.4.a … One of thead, tfoot, tbody, tr is expected"
//   colspan on <td>              "cvc-complex-type.3.2.2: Attribute 'colspan' is not allowed"
// MCA-validated instances (golden-*.xml) use only the class attribute.
const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'br', 'table', 'td', 'tr', 'thead', 'tfoot', 'tbody', 'th']);
const SCHEMA_REJECTED_TAGS = new Set(['col', 'colgroup', 'caption']);
const SCHEMA_REJECTED_ATTRS = new Set(['colspan', 'rowspan', 'style']);
const CHILDREN = { table: ['thead', 'tfoot', 'tbody', 'tr'], thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], tr: ['td', 'th'] };
export const HTML_FIX_HINT = 'open the text block (Text Block button) and click Save Text — the editor rebuilds tables and formatting in the MCA subset';
export function htmlGuidelineIssues(s, { detail = false } = {}) {
  const out = [];
  const warn = [];
  if (!/[<&]/.test(s)) return detail ? { errors: out, warnings: warn } : out;
  const tagRe = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(s))) {
    const name = m[2];
    const lc = name.toLowerCase();
    if (name !== lc) out.push(`tag <${name}> must be lower case`);
    if (SCHEMA_REJECTED_TAGS.has(lc)) out.push(`tag <${lc}> is rejected by the MCA Validator HTML schema`);
    else if (!ALLOWED_TAGS.has(lc)) out.push(`tag <${name}> is not allowed`);
    if (m[1]) continue;
    for (const [, an] of m[3].matchAll(/([A-Za-z_:][-\w:.]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const a = an.toLowerCase();
      if (a === 'class') continue;
      if (a === 'style') out.push('style attribute is not allowed');
      else if (SCHEMA_REJECTED_ATTRS.has(a)) out.push(`attribute '${a}' on <${lc}> is rejected by the MCA Validator HTML schema`);
      else if (a !== '/') warn.push(`attribute '${a}' on <${lc}> is not used in MCA-validated instances (only class) and may be rejected`);
    }
  }
  if (/<\?/.test(s)) out.push('processing instructions are not allowed');
  // table content model
  if (/<t[a-z]/i.test(s)) {
    const walk = (n) => {
      for (const c of n.children || []) {
        if (!c.tag) { if (CHILDREN[n.tag] && c.text.trim()) out.push(`text directly inside <${n.tag}> is not allowed`); continue; }
        if (CHILDREN[n.tag] && !CHILDREN[n.tag].includes(c.tag) && !SCHEMA_REJECTED_TAGS.has(c.tag)) out.push(`<${c.tag}> inside <${n.tag}> is not allowed (expected ${CHILDREN[n.tag].join('/')})`);
        walk(c);
      }
    };
    walk(parseHtml(s));
  }
  const ents = s.match(/&[A-Za-z0-9#]+;/g) || [];
  for (const e of ents) if (!['&nbsp;', '&amp;', '&lt;', '&gt;'].includes(e)) out.push(`entity ${e} is not allowed`);
  return detail ? { errors: [...new Set(out)], warnings: [...new Set(warn)] } : [...new Set(out)];
}

export class Gate {
  constructor(A) { this.A = A; this.app = new Applicability(A); this.engine = new RuleEngine(A); }

  // Split facts into emitted vs excluded (not applicable for this filing/scope) — the shared applicability decision.
  plan(filing) { return this.app.planFacts(filing); }

  // Concepts belonging to one filing tab (ELR): its presented concepts and the line items of its tables.
  tabConcepts(elrUri) {
    const A = this.A;
    const set = new Set(Object.keys(A.concepts).filter((q) => A.conceptElrs(q).includes(elrUri)));
    for (const t of A.tablesInElr(elrUri)) for (const q of t.lineItems) set.add(q);
    return set;
  }
  // Concepts a rule reads or writes (from its compiled AST)
  ruleOperands(r) {
    const cache = (this._ops ||= new Map());
    if (cache.has(r.id)) return cache.get(r.id);
    const out = new Set();
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      for (const [k, v] of Object.entries(x)) {
        if ((k === 'fact' || k === 'concept') && typeof v === 'string') out.add(v);
        else if (k === 'concepts' && Array.isArray(v)) v.forEach((c) => typeof c === 'string' ? out.add(c) : walk(c));
        else if ((k === 'tables' || k === 'otherTables') && Array.isArray(v)) for (const id of v) for (const q of this.A.table(id)?.lineItems || []) out.add(q);
        else if (typeof v === 'object') walk(v);
      }
    };
    walk(r.ast);
    if (r.subject) out.add(r.subject);
    cache.set(r.id, out);
    return out;
  }

  // Structured location of an issue: the filing tab (ELR), table, scope and the exact cell (fact key).
  locate(filing, i, preferElr = null) {
    const A = this.A;
    const general = { 'cin.missing': 'f-cin', 'cin.format': 'f-cin', 'cin.mismatch': 'f-cin', periods: 'f-cys', reportType: 'f-rt', schemaRef: null };
    if (i.code in general) return { kind: 'general', field: general[i.code], tabId: 'general' };
    let concept = i.concept || null, period = null, dims = i.dims || [];
    const fact = i.factKey ? filing.facts.get(i.factKey) : null;
    if (fact) { concept = fact.concept; period = fact.period; dims = fact.dims; }
    const P = filing.meta.periods;
    const scope = period ? reportingYear(P, period) : i.scope || 'CY';
    if (!concept && i.tableId) {
      const t = A.table(i.tableId);
      return { kind: 'table', tabId: A.elr(t.presentationElr)?.code, elrUri: t.presentationElr, tableId: i.tableId, scope, cellId: `table:${i.tableId}:${scope}` };
    }
    if (!concept || !A.concept(concept)) return null;
    if (!period) period = filing.period(concept, scope === 'PYO' ? 'PY' : scope);
    if (!period) return null;
    const cellId = factKey(concept, period, dims);
    if (dims.length) {
      const axes = new Set(dims.map((d) => d.axis));
      const ts = A.tables.filter((t) => t.lineItems.includes(concept) && dims.every((d) => t.axes.some((x) => x.axis === d.axis)));
      const t = (i.tableId && A.table(i.tableId)) || ts.find((x) => x.axes.length === axes.size) || ts[0];
      if (t) return { kind: 'cell', tabId: A.elr(t.presentationElr)?.code, elrUri: t.presentationElr, tableId: t.id, scope: scope === 'PYO' ? 'PY' : scope, conceptQName: concept, rowId: concept, cellId, dims };
    }
    const elrs = A.conceptElrs(concept);
    const sc = scope === 'PYO' ? 'PY' : scope;
    // the tab being validated, else the ELR under which the MCA rule is written, else the first applicable one
    const ruleElr = i.ruleId ? A.elrByCode?.(this._ruleElr(i.ruleId))?.uri : null;
    const ok = (u) => this.app.cellStatus(filing, u, concept, sc).applicable;
    const elrUri = [preferElr, ruleElr].find((u) => u && elrs.includes(u) && ok(u)) || elrs.find(ok) || elrs[0];
    // a table-only concept without dimensions (totals table) is still shown in its ELR
    return { kind: 'cell', tabId: elrUri ? A.elr(elrUri)?.code : null, elrUri: elrUri || null, tableId: null, scope: sc, conceptQName: concept, rowId: concept, cellId, dims: [] };
  }

  _ruleElr(id) { const r = (this._rules ||= new Map(this.A.rules.rules.map((x) => [x.id, x]))).get(id); return r?.elr || null; }

  run(filing, { today, tab = null } = {}) {
    const A = this.A;
    const issues = [];
    const add = (severity, code, message, extra = {}) => issues.push({ severity, code, message, ...extra });
    const P = filing.meta.periods;
    // current-tab validation: same checks and rule engine, restricted to the facts and rules of one ELR
    const inTab = tab ? this.tabConcepts(tab) : null;
    const tabFact = (f) => !inTab || inTab.has(f.concept);

    // ---- document level (whole filing only)
    if (!tab) {
    const sref = filing.meta.schemaRef || A.meta.schemaRef;
    if (!(A.meta.acceptedSchemaRefs || [{ href: A.meta.schemaRef }]).some((x) => x.href === sref)) add('ERROR', 'schemaRef', `schemaRef '${sref}' is not an accepted Ind AS 2017 entry point`);
    if (!filing.meta.cin) add('ERROR', 'cin.missing', 'CIN (entity identifier) is required');
    else if (!FORMATS.CIN.test(filing.meta.cin)) add('ERROR', 'cin.format', `CIN '${filing.meta.cin}' is not a valid 21-character CIN`);
    else {
      // Filing Manual technical specification #3: the identifier of every context is the CIN of the company — the same
      // CIN as reported in the general information (CorporateIdentityNumber)
      const qc = A.qnameOfLocal('CorporateIdentityNumber');
      const reported = qc ? filing.value(qc, 'CY', []) : null;
      if (reported && reported.trim().toUpperCase() !== filing.meta.cin.trim().toUpperCase()) add('ERROR', 'cin.mismatch', `Context identifier CIN '${filing.meta.cin}' differs from CorporateIdentityNumber '${reported}' (Filing Manual #3: the identifier must be the CIN of the company)`);
    }
    for (const e of validatePeriods(P)) if (!(filing.meta.firstFinancialYear && e.startsWith('PY'))) add('ERROR', 'periods', e);
    if (!['Standalone', 'Consolidated'].includes(filing.meta.reportType)) add('ERROR', 'reportType', 'Nature of report must be Standalone or Consolidated');
    }

    const { emit, excluded } = this.plan(filing);
    for (const x of excluded) if (tabFact(x.fact)) add('WARNING', 'excluded', `Not applicable — excluded from XML: ${x.fact.concept}${x.fact.dims.length ? ' (dimensional)' : ''} ${x.fact.period.type === 'instant' ? x.fact.period.date : x.fact.period.start + '…' + x.fact.period.end}: ${x.reasons.join('; ')}`, { factKey: x.fact.key });

    // effective filing = what will be emitted; business rules run on exactly this content
    const eff = new Filing(A, filing.meta);
    for (const f of emit) eff.facts.set(f.key, f);
    eff.footnotes = filing.footnotes;

    // ---- fact level
    const byConcept = new Map();
    for (const f of emit) {
      if (!tabFact(f)) continue;
      const c = A.concept(f.concept);
      const where = `${f.concept}${f.dims.length ? ' [' + f.dims.map((d) => (d.member || JSON.stringify(d.typed))).join(', ') + ']' : ''} @ ${f.period.type === 'instant' ? f.period.date : f.period.start + '…' + f.period.end}`;
      if (!c || !A.isReportable(f.concept)) { add('ERROR', 'concept.unknown', `Unknown/non-reportable concept ${f.concept}`, { factKey: f.key }); continue; }
      if (c.periodType !== (f.period.type === 'instant' ? 'instant' : 'duration')) add('ERROR', 'period.type', `${where}: period type must be ${c.periodType}`, { factKey: f.key });
      const y = reportingYear(P, f.period);
      if (y === 'OTHER') add('ERROR', 'period.unmapped', `${where}: period is neither current nor previous reporting period`, { factKey: f.key });
      if (f.nil && !c.nillable) add('ERROR', 'nil', `${where}: concept is not nillable`, { factKey: f.key });
      // value re-validation
      if (!f.nil) {
        try { if (filing.canonicalValue(f.concept, f.value) !== f.value && A.isNumeric(f.concept)) add('ERROR', 'value.canonical', `${where}: value not canonical`, { factKey: f.key }); }
        catch (e) { add('ERROR', 'value.type', `${where}: ${e.message}`, { factKey: f.key }); }
        const facets = A.typeFacets(f.concept);
        if (facets?.pattern && !new RegExp(`^(?:${facets.pattern})$`).test(f.value)) add('ERROR', 'value.pattern', `${where}: '${f.value}' does not match ${c.type} pattern`, { factKey: f.key });
        if (facets?.length && String(f.value).length !== Number(facets.length)) add('ERROR', 'value.length', `${where}: length must be ${facets.length} (${c.type})`, { factKey: f.key });
        if (typeof f.value === 'string' && xmlSafe(f.value) !== f.value) add('ERROR', 'value.xmlChar', `${where}: contains control characters XML does not allow (e.g. a Word line break) — the MCA Validator rejects the whole file. Re-enter or re-paste the value.`, { factKey: f.key });
        if (A.dataType(f.concept) === 'textBlock' || A.dataType(f.concept) === 'string') {
          const hd = htmlGuidelineIssues(f.value, { detail: true });
          // entity usage is reported as a warning: MCA-validated instances contain &apos;/&quot; in text blocks
          const ent = hd.errors.filter((x) => x.startsWith('entity'));
          const other = hd.errors.filter((x) => !x.startsWith('entity'));
          if (other.length) add('ERROR', 'html', `${where}: HTML guidelines — ${other.join('; ')}. To fix: ${HTML_FIX_HINT}.`, { factKey: f.key });
          if (ent.length || hd.warnings.length) add('WARNING', 'html.entity', `${where}: HTML guidelines — ${[...ent, ...hd.warnings].join('; ')}`, { factKey: f.key });
        }
      }
      if (A.isNumeric(f.concept)) {
        const u = f.unit && unitDef(f.unit);
        if (!u) add('ERROR', 'unit.missing', `${where}: numeric fact requires a unit`, { factKey: f.key });
        else if (!unitMatchesType(A.dataType(f.concept), u)) add('ERROR', 'unit.type', `${where}: unit ${f.unit} does not match ${A.dataType(f.concept)}`, { factKey: f.key });
        if (!f.nil) {
          if (f.decimals == null || !(f.decimals === 'INF' || /^-?\d+$/.test(String(f.decimals)))) add('ERROR', 'decimals', `${where}: decimals attribute required (precision is prohibited)`, { factKey: f.key });
          else if (!Dec.eq(Dec.round(Dec.parse(f.value), f.decimals), Dec.parse(f.value))) add('ERROR', 'decimals.nonSignificant', `${where}: non-significant digits must be 0 for decimals=${f.decimals} (Filing Manual #13)`, { factKey: f.key });
        }
      } else if (!f.nil && A.langAllowed(f.concept) && f.lang !== 'en') add('INFO', 'lang', `${where}: textual facts should carry xml:lang="en" (Filing Manual #28) — will be emitted as 'en'`, { factKey: f.key });
      // dimensions
      for (const e of checkDimensionSyntax(A, f.dims)) add('ERROR', e.code, `${where}: ${e.msg}`, { factKey: f.key });
      const dv = dimensionallyValid(A, f.concept, f.dims);
      if (!dv.valid) add('ERROR', 'dim.hypercube', `${where}: dimensionally invalid — ${dv.reason}`, { factKey: f.key });
      (byConcept.get(f.concept) || byConcept.set(f.concept, []).get(f.concept)).push(f);
    }
    // #9 overlapping periods for one concept/dimension set
    for (const [q, list] of byConcept) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.dims.length === b.dims.length && JSON.stringify(a.dims) === JSON.stringify(b.dims) && periodsOverlap(a.period, b.period)) add('ERROR', 'period.overlap', `${q}: overlapping periods (Filing Manual #9)`, { factKey: a.key });
      }
    }
    // monetary unit consistency (#8) — subsidiary details may differ (GR-9 handled by rules)
    // import findings carried forward
    const ir = filing.importReport;
    if (ir && !tab) {
      for (const e of ir.errors) add('ERROR', 'import', e);
      for (const u of ir.unresolvedFacts) add('WARNING', 'import.unresolved', `Unresolved source fact ${u.element} (${u.contextRef}): ${u.reason}`);
      for (const c of ir.conflicts) add('ERROR', 'import.conflict', `Inconsistent duplicate facts for ${c.concept} in ${c.contextRef}`);
    }

    // ---- business rules + calculations (on the effective filing)
    let only = null;
    if (tab) {
      only = new Set();
      for (const r of A.rules.rules) {
        if (r.status !== 'EXECUTABLE' && r.status !== 'UNIMPLEMENTED') continue;
        if (r.family === 'generic' || [...this.ruleOperands(r)].some((q) => inTab.has(q))) only.add(r.id);
      }
    }
    const br = this.engine.run(eff, { today, only });
    const ruleById = new Map(A.rules.rules.map((r) => [r.id, r]));
    for (const r of br.results) {
      const loc = { ruleId: r.ruleId, scope: r.scope, factKey: r.factKey, concept: r.concept, dims: r.dims, tableId: r.tableId };
      if (tab) {
        const def = ruleById.get(r.ruleId);
        const ops = this.ruleOperands(def);
        // results of generic rules are kept only where they point into this tab
        if (def.family === 'generic' && r.status !== 'PASS') { const l = this.locate(eff, { ...loc, code: 'rule' }, tab); if (!l || l.elrUri !== tab) continue; }
        if (ops.size && [...ops].some((q) => !inTab.has(q))) loc.crossTab = true;
      }
      if (r.status === 'FAIL') add('ERROR', `rule.${r.ruleId}`, `[${r.ruleId}] ${r.message}`, loc);
      else if (r.status === 'WARN') add('WARNING', `rule.${r.ruleId}`, `[${r.ruleId}] ${r.message}`, loc);
      else if (r.status === 'REVIEW_ONLY_EXTERNAL_DATA') add('INFO', `review.${r.ruleId}`, `[${r.ruleId}] review manually (needs data outside the instance): ${r.message}`, { ruleId: r.ruleId });
      else if (r.status === 'UNIMPLEMENTED') add('WARNING', `unimplemented.${r.ruleId}`, `[${r.ruleId}] not executed (known limitation): ${r.message}`, { ruleId: r.ruleId });
      else if (r.status === 'APPROVED_LIMITATION_NOT_EXECUTED') add('WARNING', `limitation.${r.ruleId}`, `[${r.ruleId}] ${r.message} — not an MCA validation result`, { ruleId: r.ruleId });
    }
    const corpus = A.rules.corpus;
    if (corpus?.specificRulesSheetTruncated) add('WARNING', 'rules.corpus', `Business-rule corpus incomplete: ${corpus.note}`);
    if (!emit.length && !tab) add('ERROR', 'empty', 'No facts to generate');
    for (const i of issues) i.location = this.locate(filing, i, tab);

    const errors = issues.filter((i) => i.severity === 'ERROR');
    return {
      ok: errors.length === 0,
      blocking: errors.length,
      issues,
      summary: { errors: errors.length, warnings: issues.filter((i) => i.severity === 'WARNING').length, info: issues.filter((i) => i.severity === 'INFO').length, facts: emit.length, excluded: excluded.length },
      ruleResults: br.results,
      ruleStatus: br.ruleStatus,
      calculations: br.calculations,
      emit,
      scope: tab ? { kind: 'tab', elrUri: tab, code: A.elr(tab)?.code, rulesRun: only.size } : { kind: 'filing' },
      officialValidation: 'NOT_RUN',
    };
  }
}

export class GateError extends Error { constructor(result) { super(`Internal validation gate blocked XML generation: ${result.blocking} error(s)`); this.result = result; } }

// The only export path: gate → generator. Blocked on any ERROR.
export function exportXml(A, filing, opts = {}) {
  const gate = new Gate(A).run(filing, opts);
  if (!gate.ok) throw new GateError(gate);
  // Filing Manual #28: textual facts carry xml:lang="en" — only where the concept's type permits the attribute
  const emit = gate.emit.map((f) => (A.isNumeric(f.concept) ? f : A.langAllowed(f.concept) ? (!f.nil && !f.lang ? { ...f, lang: 'en' } : f) : f.lang ? { ...f, lang: null } : f));
  const { xml } = generateInstance(A, filing, emit);
  return { xml, gate };
}
