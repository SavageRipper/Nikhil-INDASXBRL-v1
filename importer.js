// XBRL instance importer. Every source fact either maps to a canonical internal fact or is listed in
// the unresolved-import report; nothing disappears silently.
// sourceContextId -> internal context key (period + dimensions) -> export id (assigned by the generator).
import { Filing, FactValueError, normDims, dimKey } from './model.js';
import { periodKey, isoDate, scopeOf, addDays as addDaysIso } from './periods.js';
import { addMonths as addMonthsIso } from './expr.js';

// The financial year after p (same length; its start is the day after p ends) — the new current year of a roll-forward.
export function nextFinancialYear(p) {
  const start = addDaysIso(p.end, 1);
  const months = (Number(p.end.slice(0, 4)) - Number(p.start.slice(0, 4))) * 12 + (Number(p.end.slice(5, 7)) - Number(p.start.slice(5, 7))) + 1;
  return { start, end: addDaysIso(addMonthsIso(start, months), -1) };
}
import { SCALE_POWERS } from './scaling.js';
import * as Dec from './decimal.js';
import { Applicability, openingConcepts } from './applicability.js';

const NS = {
  xbrli: 'http://www.xbrl.org/2003/instance',
  link: 'http://www.xbrl.org/2003/linkbase',
  xlink: 'http://www.w3.org/1999/xlink',
  xbrldi: 'http://xbrl.org/2006/xbrldi',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  iso4217: 'http://www.xbrl.org/2003/iso4217',
};

const kids = (el) => { const out = []; for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n); return out; };
const child = (el, ns, local) => kids(el).find((k) => k.namespaceURI === ns && k.localName === local) || null;
const text = (el) => (el ? el.textContent.trim() : null);
const xl = (el, local) => el.getAttributeNS(NS.xlink, local) || el.getAttribute('xlink:' + local) || null;

function resolveQName(el, qn) {
  const [p, l] = qn.includes(':') ? qn.split(':') : [null, qn];
  const ns = el.lookupNamespaceURI(p);
  return { ns, local: l };
}

// yearMode: 'rollforward' — the instance is LAST YEAR's filing: it becomes the previous year of a new filing. The new
//                       previous year = the source current year (same dates, so no fact is shifted): source current-year
//                       durations and current-year-end instants are the new previous-year figures, source previous-year-end
//                       instants are the new previous-year opening balances. Source previous-year durations and opening
//                       instants are not imported. Company identity and structure elements (name, CIN, PAN, address,
//                       report settings, subsidiary/holding answers) are also carried into the new current year (origin
//                       'carried'); every other current-year cell starts empty.
// yearMode: 'both'    — current-year and previous-year facts populate the CY and PY columns
//           'current' — facts of the current reporting period (CY duration, CY-end instant) are imported, plus the
//                       CURRENT-YEAR OPENING BALANCES: instant facts at the previous-year end of the opening-balance
//                       concepts (concepts the taxonomy presents with a periodStartLabel — reconciliations of share
//                       capital, reserves, tangible/intangible assets, cash, ...). MCA generic rule GR-7: "there is a
//                       common element for specifying the opening and closing balance ... the Opening balance of current
//                       year be shown as the closing balance of previous year", so the current-year opening balance is
//                       that one XBRL fact. Every other previous-period fact (PY durations, PY-end instants of other
//                       concepts = comparative column, PY opening instants) is skipped and counted. Nothing is shifted.
// Periods are classified from the actual context dates against the detected reporting periods.
export const openingBalanceConcepts = (A) => openingConcepts(A);
export function importInstance(A, xmlText, { DOMParserImpl = globalThis.DOMParser, fileName = 'instance.xml', yearMode = 'both', cashFlowMethod = null } = {}) {
  if (!['both', 'current', 'rollforward'].includes(yearMode)) throw new Error(`Unknown import year mode ${yearMode}`);
  const report = {
    fileName, schemaRef: null, schemaRefMatches: false, errors: [], warnings: [],
    contexts: [], units: [], unknownConcepts: [], unresolvedFacts: [], duplicates: [], conflicts: [], periodDetection: null,
    yearMode,
    counts: { sourceFacts: 0, imported: 0, unresolved: 0, footnotes: 0 },
    byYear: { current: 0, previous: 0, previousOpening: 0, other: 0, skippedPrevious: 0, skippedPreviousOpening: 0, carriedOpening: 0, cyOpeningAtPyEnd: 0 },
    carriedOpeningConcepts: [],
    cashFlow: null, notApplicable: [],
  };
  const errors = [];
  const doc = new DOMParserImpl({ onError: (l, m) => { if (l !== 'warning') errors.push(m); } }).parseFromString(xmlText, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName === 'parsererror' || doc.getElementsByTagName('parsererror').length || errors.length) throw new Error('Not well-formed XML: ' + (errors[0] || 'parser error'));
  if (root.namespaceURI !== NS.xbrli || root.localName !== 'xbrl') throw new Error('Root element is not xbrli:xbrl');

  const nsToPrefix = new Map(Object.entries(A.namespaces).map(([p, ns]) => [ns, p]));
  const sr = child(root, NS.link, 'schemaRef');
  report.schemaRef = sr ? xl(sr, 'href') : null;
  const accepted = (A.meta.acceptedSchemaRefs || [{ href: A.meta.schemaRef }]).map((x) => x.href);
  report.schemaRefMatches = accepted.includes(report.schemaRef);
  if (!report.schemaRefMatches) report.warnings.push(`schemaRef '${report.schemaRef}' is not an accepted Ind AS 2017 entry point; the export will use '${A.meta.schemaRef}'`);

  // ---- contexts
  const contexts = new Map();
  const cins = new Set();
  for (const c of kids(root).filter((k) => k.namespaceURI === NS.xbrli && k.localName === 'context')) {
    const id = c.getAttribute('id');
    const ent = child(c, NS.xbrli, 'entity');
    const ident = child(ent, NS.xbrli, 'identifier');
    const scheme = ident?.getAttribute('scheme');
    if (ident) cins.add(text(ident));
    if (scheme !== A.meta.cinScheme) report.warnings.push(`Context ${id}: identifier scheme '${scheme}' is not ${A.meta.cinScheme}`);
    const per = child(c, NS.xbrli, 'period');
    let period;
    if (child(per, NS.xbrli, 'instant')) period = { type: 'instant', date: text(child(per, NS.xbrli, 'instant')).slice(0, 10) };
    else if (child(per, NS.xbrli, 'startDate')) period = { type: 'duration', start: text(child(per, NS.xbrli, 'startDate')).slice(0, 10), end: text(child(per, NS.xbrli, 'endDate')).slice(0, 10) };
    else { report.errors.push(`Context ${id}: unsupported period (forever)`); continue; }
    const dims = [];
    const issues = [];
    const seg = child(ent, NS.xbrli, 'segment');
    if (seg) issues.push('segment element present (Filing Manual #32: not allowed) — dimensions read from it');
    const holders = [child(c, NS.xbrli, 'scenario'), seg].filter(Boolean);
    for (const h of holders) for (const m of kids(h)) {
      const dq = m.getAttribute('dimension');
      const { ns, local } = resolveQName(m, dq);
      const axis = nsToPrefix.has(ns) ? `${nsToPrefix.get(ns)}:${local}` : null;
      if (!axis || !A.concept(axis)) { issues.push(`unknown dimension ${dq}`); continue; }
      if (m.localName === 'explicitMember') {
        const mq = resolveQName(m, text(m));
        const member = nsToPrefix.has(mq.ns) ? `${nsToPrefix.get(mq.ns)}:${mq.local}` : null;
        if (!member || !A.concept(member)) { issues.push(`unknown member ${text(m)}`); continue; }
        dims.push({ axis, member });
      } else if (m.localName === 'typedMember') {
        const val = kids(m)[0];
        const dom = val && nsToPrefix.has(val.namespaceURI) ? `${nsToPrefix.get(val.namespaceURI)}:${val.localName}` : null;
        if (dom !== A.typedDomain(axis)) issues.push(`typed member of ${axis} uses element ${dom}, expected ${A.typedDomain(axis)}`);
        dims.push({ axis, typed: val ? val.textContent : '' });
      }
    }
    const nd = normDims(dims);
    contexts.set(id, { id, period, dims: nd, internalKey: `${periodKey(period)}#${dimKey(nd)}`, issues });
    report.contexts.push({ sourceContextId: id, internalContextKey: `${periodKey(period)}#${dimKey(nd)}`, issues });
  }
  // collision-safe: several source contexts may collapse to one internal context (duplicates)
  const byInternal = new Map();
  for (const c of contexts.values()) (byInternal.get(c.internalKey) || byInternal.set(c.internalKey, []).get(c.internalKey)).push(c.id);
  for (const [k, ids] of byInternal) if (ids.length > 1) report.warnings.push(`Duplicate contexts (Filing Manual #5) ${ids.join(', ')} share period+dimensions; merged`);

  // ---- units
  const units = new Map();
  for (const u of kids(root).filter((k) => k.namespaceURI === NS.xbrli && k.localName === 'unit')) {
    const id = u.getAttribute('id');
    const div = child(u, NS.xbrli, 'divide');
    const mq = (m) => { const r = resolveQName(m, text(m)); const p = r.ns === NS.iso4217 ? 'iso4217' : r.ns === NS.xbrli ? 'xbrli' : r.ns; return `${p}:${r.local}`; };
    let def;
    if (div) def = { id, numerator: kids(child(div, NS.xbrli, 'unitNumerator')).map(mq), denominator: kids(child(div, NS.xbrli, 'unitDenominator')).map(mq) };
    else def = { id, measures: kids(u).filter((m) => m.localName === 'measure').map(mq) };
    units.set(id, def);
    report.units.push(def);
  }
  const unitInternal = (def) => {
    if (!def) return null;
    if (def.denominator) return def.numerator[0] === 'iso4217:INR' && def.denominator[0] === 'xbrli:shares' ? 'INRPerShare' : `${def.numerator[0].split(':')[1]}PerShare`;
    const m = def.measures[0];
    if (m === 'xbrli:shares') return 'shares';
    if (m === 'xbrli:pure') return 'pure';
    if (m.startsWith('iso4217:')) return m.split(':')[1];
    return null;
  };

  // ---- facts
  const rawFacts = [];
  const factsById = new Map();
  for (const el of kids(root)) {
    if (el.namespaceURI === NS.xbrli || el.namespaceURI === NS.link) continue;
    report.counts.sourceFacts++;
    const prefix = nsToPrefix.get(el.namespaceURI);
    const concept = prefix ? `${prefix}:${el.localName}` : null;
    const src = {
      element: `{${el.namespaceURI}}${el.localName}`, contextRef: el.getAttribute('contextRef'), unitRef: el.getAttribute('unitRef') || null,
      decimals: el.getAttribute('decimals') || null, precision: el.getAttribute('precision') || null, lang: el.getAttribute('xml:lang') || null,
      id: el.getAttribute('id') || null, nil: (el.getAttributeNS(NS.xsi, 'nil') || el.getAttribute('xsi:nil')) === 'true', value: el.textContent,
    };
    if (!concept || !A.concept(concept)) {
      report.unknownConcepts.push(src.element);
      report.unresolvedFacts.push({ ...src, reason: 'Unknown concept (not in the Ind AS 2017 taxonomy)' });
      continue;
    }
    const ctx = contexts.get(src.contextRef);
    if (!ctx) { report.unresolvedFacts.push({ ...src, concept, reason: `contextRef '${src.contextRef}' not defined` }); continue; }
    if (src.precision) report.errors.push(`Fact ${concept} in ${src.contextRef} uses precision (prohibited, Filing Manual #27); decimals must be supplied`);
    rawFacts.push({ concept, ctx, src });
  }

  // ---- reporting periods from actual dates (DateOfStart/EndOfReportingPeriod), never from fact order
  const qStart = A.qnameOfLocal('DateOfStartOfReportingPeriod');
  const qEnd = A.qnameOfLocal('DateOfEndOfReportingPeriod');
  const byCtx = new Map();
  for (const f of rawFacts) if (f.concept === qStart || f.concept === qEnd) {
    const e = byCtx.get(f.ctx.id) || { ctx: f.ctx };
    e[f.concept === qStart ? 'start' : 'end'] = f.src.value.trim();
    byCtx.set(f.ctx.id, e);
  }
  let pairs = [...byCtx.values()].filter((e) => isoDate(e.start) && isoDate(e.end)).map((e) => ({ start: e.start, end: e.end }));
  let method = 'DateOfStartOfReportingPeriod/DateOfEndOfReportingPeriod facts';
  if (!pairs.length) {
    pairs = [...contexts.values()].filter((c) => c.period.type === 'duration').map((c) => ({ start: c.period.start, end: c.period.end }));
    method = 'duration contexts (no reporting-period facts found)';
  }
  const uniq = [...new Map(pairs.map((p) => [p.start + p.end, p])).values()].sort((a, b) => b.end.localeCompare(a.end));
  const cy = uniq[0] || { start: '', end: '' };
  const py = uniq.find((p) => p.end < cy.start) || { start: '', end: '' };
  report.periodDetection = { method, cy, py, candidates: uniq };
  if (!py.end) report.warnings.push('No previous-year period detected; treat as first financial year or set the previous-year dates');

  const nextYear = nextFinancialYear;
  const roll = yearMode === 'rollforward';
  if (roll && !cy.end) throw new Error('Roll-forward needs the reporting period of the source instance');
  if (roll) report.rollForward = { sourceCurrent: cy, sourcePrevious: py, newCurrent: nextYear(cy), newPrevious: cy, carriedIdentity: [], skippedPreviousDurations: 0, skippedPreviousOpening: 0 };
  const filing = new Filing(A, {
    name: fileName.replace(/\.xml$/i, ''),
    cin: [...cins][0] || '',
    periods: roll ? { cy: report.rollForward.newCurrent, py: cy } : { cy, py },
    firstFinancialYear: roll ? false : !py.end,
    schemaRef: report.schemaRefMatches ? report.schemaRef : A.meta.schemaRef,
  });
  if (cins.size > 1) report.errors.push(`Contexts use different CINs (${[...cins].join(', ')}) — Filing Manual #4 requires one CIN`);

  // ---- materialise facts
  const skippedIds = new Set();
  const yearOf = (period) => scopeOf({ cy, py }, period); // CY | PY | PYO | OTHER
  for (const { concept, ctx, src } of rawFacts) {
    const y = py.end || cy.end ? yearOf(ctx.period) : 'CY';
    if (roll && (y === 'PYO' || y === 'OTHER' || (y === 'PY' && ctx.period.type === 'duration'))) {
      report.rollForward[y === 'PY' ? 'skippedPreviousDurations' : 'skippedPreviousOpening']++;
      if (src.id) skippedIds.add(src.id);
      continue;
    }
    const isCyOpening = y === 'PY' && ctx.period.type === 'instant' && openingBalanceConcepts(A).has(concept);
    if (isCyOpening) report.byYear.cyOpeningAtPyEnd++;
    const carry = yearMode === 'current' && isCyOpening;
    if (yearMode === 'current' && (y === 'PY' || y === 'PYO') && !carry) {
      report.byYear[y === 'PY' ? 'skippedPrevious' : 'skippedPreviousOpening']++;
      if (src.id) skippedIds.add(src.id);
      continue;
    }
    const unitDef = src.unitRef ? units.get(src.unitRef) : null;
    if (src.unitRef && !unitDef) { report.unresolvedFacts.push({ ...src, concept, reason: `unitRef '${src.unitRef}' not defined` }); continue; }
    const existing = filing.get(concept, ctx.period, ctx.dims);
    try {
      const value = src.nil ? null : (A.isNumeric(concept) || ['date', 'boolean', 'enum'].includes(A.dataType(concept)) ? src.value.trim() : src.value);
      if (existing) {
        const canon = src.nil ? null : filing.canonicalValue(concept, value);
        if (canon === existing.value) report.duplicates.push({ concept, contextRef: src.contextRef, note: 'identical duplicate dropped (Filing Manual #7)' });
        else report.conflicts.push({ concept, contextRef: src.contextRef, kept: existing.value, dropped: canon, note: 'inconsistent duplicate (Filing Manual #7) — first kept' });
        continue;
      }
      const fact = filing.setFact({
        concept, period: ctx.period, dims: ctx.dims, value, nil: src.nil,
        decimals: src.decimals, unit: unitInternal(unitDef) || undefined, lang: src.lang, origin: 'import',
        source: { contextRef: src.contextRef, unitRef: src.unitRef, decimals: src.decimals, lang: src.lang, id: src.id, file: fileName },
        id: src.id,
      });
      if (A.isNumeric(concept) && !src.decimals && !src.nil) fact.decimals = null; // keep the gap visible to the gate
      if (src.id) factsById.set(src.id, fact.key);
      report.counts.imported++;
      if (carry) { report.byYear.carriedOpening++; if (!report.carriedOpeningConcepts.includes(concept)) report.carriedOpeningConcepts.push(concept); }
      else report.byYear[{ CY: 'current', PY: 'previous', PYO: 'previousOpening' }[y] || 'other']++;
    } catch (e) {
      if (!(e instanceof FactValueError)) throw e;
      report.unresolvedFacts.push({ ...src, concept, reason: e.message });
    }
  }
  report.counts.unresolved = report.unresolvedFacts.length;

  // ---- footnotes
  for (const fl of kids(root).filter((k) => k.namespaceURI === NS.link && k.localName === 'footnoteLink')) {
    const locs = new Map(), notes = new Map();
    for (const n of kids(fl)) {
      if (n.localName === 'loc') locs.set(xl(n, 'label'), (xl(n, 'href') || '').replace(/^#/, ''));
      if (n.localName === 'footnote') notes.set(xl(n, 'label'), { text: n.textContent, lang: n.getAttribute('xml:lang') || 'en' });
    }
    const linked = new Map();
    for (const n of kids(fl)) if (n.localName === 'footnoteArc') {
      const fk = factsById.get(locs.get(xl(n, 'from')));
      const note = xl(n, 'to');
      if (!fk) { if (!skippedIds.has(locs.get(xl(n, 'from')))) report.warnings.push(`Footnote arc from unknown fact ${locs.get(xl(n, 'from'))}`); continue; }
      (linked.get(note) || linked.set(note, []).get(note)).push(fk);
    }
    for (const [label, note] of notes) {
      if (yearMode === 'current' && !linked.get(label)) continue; // footnote only on skipped previous-year facts
      filing.addFootnote(note.text, linked.get(label) || [], note.lang); report.counts.footnotes++;
    }
  }

  // ---- roll-forward: company identity carried into the new current year; year split recounted on the new periods
  if (roll) {
    const IDENTITY = ['NameOfCompany', 'CorporateIdentityNumber', 'PermanentAccountNumberOfEntity', 'AddressOfRegisteredOfficeOfCompany', 'TypeOfIndustry', 'NatureOfReportStandaloneConsolidated', 'ContentOfReport', 'DescriptionOfPresentationCurrency', 'LevelOfRoundingUsedInFinancialStatements', 'TypeOfCashFlowStatement', 'WhetherCompanyIsSubsidiaryCompany', 'WhetherCompanyHasSubsidiaryCompanies'];
    for (const local of IDENTITY) {
      const q = A.qnameOfLocal(local);
      if (!q) continue;
      const src = filing.get(q, filing.period(q, 'PY'), []);
      if (!src || src.nil) continue;
      filing.setFact({ concept: q, period: filing.period(q, 'CY'), value: src.value, lang: src.lang, decimals: src.decimals, unit: src.unit || undefined, origin: 'carried', source: { ...(src.source || {}), carriedFrom: 'previous-year filing' } });
      report.rollForward.carriedIdentity.push(local);
    }
    const P2 = filing.meta.periods;
    report.byYear = { current: 0, previous: 0, previousOpening: 0, other: 0, skippedPrevious: report.rollForward.skippedPreviousDurations, skippedPreviousOpening: report.rollForward.skippedPreviousOpening, carriedOpening: 0, cyOpeningAtPyEnd: 0 };
    for (const f of filing.all()) report.byYear[{ CY: 'current', PY: 'previous', PYO: 'previousOpening' }[scopeOf(P2, f.period)] || 'other']++;
  }

  // ---- meta from general information facts
  const metaVal = (local) => { const q = A.qnameOfLocal(local); return q && cy.end ? filing.value(q, 'CY', []) : null; };
  const nat = metaVal('NatureOfReportStandaloneConsolidated');
  if (nat) filing.meta.reportType = nat;
  const lvl = metaVal('LevelOfRoundingUsedInFinancialStatements');
  if (lvl) filing.meta.level = lvl;
  // presented decimal places = the finest monetary accuracy in the source, expressed in the display scale
  // (Lakhs with decimals="-3" -> 2 places), so editing never rounds away reported digits
  const pow = SCALE_POWERS[filing.meta.level] ?? 0;
  let places = 0;
  for (const f of filing.all()) {
    if (!A.isMonetary(f.concept) || f.nil || f.value == null) continue;
    const req = Dec.requiredDecimals(Dec.parse(f.value)); // digits actually present (zero -> Infinity, skipped)
    if (req !== Infinity) places = Math.max(places, req + pow);
  }
  filing.meta.displayPlaces = Math.min(places, 2 + pow);

  // ---- cash flow statement method: from the declared TypeOfCashFlowStatement, else from which statement the
  // reported facts belong to (concepts presented only in [100300] vs only in [100400]); never guessed
  report.cashFlow = detectCashFlow(A, filing, cy.end ? 'CY' : null);
  if (report.cashFlow && !report.cashFlow.declared) {
    const chosen = report.cashFlow.detected || cashFlowMethod;
    if (!chosen && report.cashFlow.ambiguous) throw new CashFlowChoiceError(report.cashFlow);
    if (chosen) {
      const q = A.qnameOfLocal('TypeOfCashFlowStatement');
      filing.setFact({ concept: q, period: filing.period(q, 'CY'), value: chosen, origin: report.cashFlow.detected ? 'derived' : 'user', lang: 'en' });
      report.cashFlow.applied = chosen;
      report.cashFlow.source = report.cashFlow.detected ? 'detected from the reported facts' : 'selected by the user';
      report.warnings.push(`TypeOfCashFlowStatement not reported in the source; set to '${chosen}' (${report.cashFlow.source})`);
    }
  } else if (report.cashFlow) report.cashFlow.applied = report.cashFlow.declared;

  // ---- applicability: a fact whose cell is not applicable (previous year of an ELR excluded for the previous
  // year, the cash-flow statement not selected, a Yes/No-dependent field under the other answer, a table whose
  // condition is not met) does not become filing data. The same Applicability.planFacts decision is used by the
  // UI, the gate and the generator. Retained in the report for traceability. Repeated until stable because
  // removing a fact can change a condition.
  filing.meta.yearMode = yearMode;
  const app = new Applicability(A);
  for (let pass = 0; pass < 6; pass++) {
    const { excluded } = app.planFacts(filing);
    if (!excluded.length) break;
    for (const x of excluded) {
      const f = x.fact;
      filing.removeFact(f.key);
      const y = scopeOf(roll ? filing.meta.periods : { cy, py }, f.period);
      const bucket = { CY: 'current', PY: f.period.type === 'instant' && openingBalanceConcepts(A).has(f.concept) && yearMode === 'current' ? 'carriedOpening' : 'previous', PYO: 'previousOpening' }[y] || 'other';
      if (report.byYear[bucket] > 0) report.byYear[bucket]--;
      report.counts.imported--;
      report.notApplicable.push({ concept: f.concept, period: f.period, dims: f.dims, value: f.nil ? null : f.value, scope: y, reasons: x.reasons, contextRef: f.source?.contextRef || null });
    }
  }
  report.counts.notApplicable = report.notApplicable.length;
  report.byYear.notApplicablePrevious = report.notApplicable.filter((x) => x.scope === 'PY' || x.scope === 'PYO').length;
  report.byYear.notApplicableCurrent = report.notApplicable.filter((x) => x.scope === 'CY').length;

  report.unknownConcepts = [...new Set(report.unknownConcepts)];
  filing.importReport = report;
  return { filing, report };
}

export class CashFlowChoiceError extends Error {
  constructor(info) { super('The cash flow statement method cannot be determined from the XML: choose Direct or Indirect'); this.cashFlow = info; }
}

// Facts of concepts presented only in one cash-flow statement decide the method.
export function detectCashFlow(A, filing, scope) {
  if (!scope) return null;
  const q = A.qnameOfLocal('TypeOfCashFlowStatement');
  const declared = filing.value(q, 'CY', []);
  const code = (u) => A.elr(u)?.code.slice(0, 6);
  let direct = 0, indirect = 0;
  const D = A.meta.profile.cashFlowDirect, I = A.meta.profile.cashFlowIndirect;
  for (const f of filing.all()) {
    const codes = new Set(A.conceptElrs(f.concept).map(code));
    if (codes.has(D) && !codes.has(I) && [...codes].every((c) => c === D)) direct++;
    else if (codes.has(I) && !codes.has(D) && [...codes].every((c) => c === I)) indirect++;
  }
  const detected = direct && !indirect ? 'Direct Method' : indirect && !direct ? 'Indirect Method' : null;
  return { declared: declared || null, directFacts: direct, indirectFacts: indirect, detected, ambiguous: !declared && !detected && (direct > 0 && indirect > 0) };
}
