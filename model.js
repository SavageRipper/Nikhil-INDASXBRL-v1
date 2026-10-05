// Filing-state engine: the single source of truth for a filing's facts.
// Facts are keyed by (concept, period, dimensions). CURRENT/PRIOR is derived from the
// period dates, never from fact order.
import * as Dec from './decimal.js';
import { periodKey, periodFor, scopeOf, validatePeriods, isoDate } from './periods.js';
import { scalePower, toCanonical, monetaryDecimals, enteredDecimals } from './scaling.js';
import { defaultUnitFor } from './units.js';
import { xmlSafe } from './richtext.js';

export function normDims(dims) {
  return (dims || []).map((d) => (d.typed != null ? { axis: d.axis, typed: String(d.typed) } : { axis: d.axis, member: d.member }))
    .sort((a, b) => a.axis.localeCompare(b.axis));
}
export function dimKey(dims) {
  return normDims(dims).map((d) => (d.member ? `${d.axis}=${d.member}` : `${d.axis}="${d.typed}"`)).join('|');
}
export function factKey(concept, period, dims) { return `${concept}#${periodKey(period)}#${dimKey(dims)}`; }

export class FactValueError extends Error {}

export function defaultMeta() {
  return {
    name: 'Untitled filing',
    cin: '',
    reportType: 'Standalone',
    firstFinancialYear: false,
    periods: { cy: { start: '', end: '' }, py: { start: '', end: '' } },
    level: 'Actual',
    displayPlaces: 0,
    currency: 'INR',
    schemaRef: null, // null = authority default (Filing Manual); set from an imported validated instance
    textEmphasis: 'highlight', // text blocks: bold/italic/underline -> highlightedText1/2/3 ('none' = plain text)
  };
}

export class Filing {
  constructor(authority, meta = {}) {
    this.A = authority;
    this.meta = { ...defaultMeta(), ...meta, periods: { ...defaultMeta().periods, ...(meta.periods || {}) } };
    this.facts = new Map();
    this.footnotes = new Map(); // id -> {id, text, lang, factKeys:Set}
    this.importReport = null;
    this.revision = 0;
  }

  periodsValid() { return validatePeriods(this.meta.periods).length === 0; }
  period(concept, scope) {
    const c = this.A.concept(concept);
    return periodFor(this.meta.periods, c.periodType, scope);
  }
  scopeOf(period) { return scopeOf(this.meta.periods, period); }

  // ---- canonicalisation of a raw value for a concept
  canonicalValue(concept, raw) {
    const A = this.A;
    const t = A.dataType(concept);
    if (raw == null) throw new FactValueError('Empty value');
    const s = String(raw).trim();
    if (A.isNumeric(concept)) {
      if (!Dec.isDecimalString(s.replace(/,/g, ''))) throw new FactValueError(`'${s}' is not a number`);
      return Dec.toString(Dec.parse(s));
    }
    switch (t) {
      case 'boolean': {
        if (/^(true|yes)$/i.test(s)) return 'true';
        if (/^(false|no)$/i.test(s)) return 'false';
        throw new FactValueError(`'${s}' is not true/false`);
      }
      case 'date': if (!isoDate(s)) throw new FactValueError(`'${s}' is not a yyyy-mm-dd date`); return s;
      case 'enum': {
        const en = A.enumerations(concept);
        if (!en.includes(s)) throw new FactValueError(`'${s}' is not one of: ${en.join(', ')}`);
        return s;
      }
      default: return xmlSafe(String(raw));
    }
  }

  // ---- low-level fact API (used by importer and controller)
  setFact({ concept, period, dims = [], value = null, nil = false, decimals, unit, lang, origin = 'user', source = null, id = null }) {
    const A = this.A;
    const c = A.concept(concept);
    if (!c) throw new FactValueError(`Unknown concept ${concept}`);
    if (!A.isReportable(concept)) throw new FactValueError(`${concept} is not a reportable item`);
    if (c.periodType === 'instant' && period.type !== 'instant') throw new FactValueError(`${concept} requires an instant period`);
    if (c.periodType === 'duration' && period.type !== 'duration') throw new FactValueError(`${concept} requires a duration period`);
    const nd = normDims(dims);
    const key = factKey(concept, period, nd);
    const numeric = A.isNumeric(concept);
    const canonical = nil ? null : this.canonicalValue(concept, value);
    const prev = this.facts.get(key);
    const fact = {
      key, concept, period: { ...period }, dims: nd, value: canonical, nil: !!nil,
      decimals: numeric && !nil ? (decimals ?? null) : null,
      unit: numeric ? (unit || defaultUnitFor(A.dataType(concept), this.meta.currency)) : null,
      lang: numeric || !A.langAllowed(concept) ? null : (lang || null),
      origin, source: source || prev?.source || null, sourceId: id || prev?.sourceId || null,
    };
    if (numeric && !nil && fact.decimals == null) fact.decimals = String(this.defaultDecimals(concept, canonical));
    this.facts.set(key, fact);
    this.revision++;
    return fact;
  }

  defaultDecimals(concept, canonical) {
    if (this.A.dataType(concept) === 'monetary') {
      // accuracy of the filing's display scale, raised if the value carries finer digits (capped at 2, GR-8)
      const d = monetaryDecimals(this.meta.level, this.meta.displayPlaces);
      const req = Dec.requiredDecimals(Dec.parse(canonical));
      return Math.min(2, Math.max(d, req === Infinity ? d : req));
    }
    return enteredDecimals(canonical);
  }

  // UI/editing entry point: value typed in the filing's display scale.
  // Monetary values are rounded (half away from zero) to displayPlaces, then scaled to canonical.
  setDisplayValue({ concept, period, dims = [], display, origin = 'user' }) {
    const A = this.A;
    const key = factKey(concept, period, dims);
    if (display == null || String(display).trim() === '') { this.removeFact(key); return null; }
    const prev = this.facts.get(key);
    const t = A.dataType(concept);
    if (t === 'monetary') {
      const raw = String(display).trim().replace(/,/g, '');
      if (!Dec.isDecimalString(raw)) throw new FactValueError(`'${display}' is not a number`);
      const rounded = Dec.toString(Dec.round(Dec.parse(raw), this.meta.displayPlaces));
      const canonical = toCanonical(rounded, this.meta.level);
      let decimals = String(this.defaultDecimals(concept, canonical));
      // keep imported decimals when the edited value is still consistent with them
      if (prev?.decimals != null && prev.origin !== 'user' && Dec.eq(Dec.round(Dec.parse(canonical), prev.decimals), Dec.parse(canonical))) decimals = prev.decimals;
      return this.setFact({ concept, period, dims, value: canonical, decimals, origin: prev ? prev.origin === 'user' ? 'user' : 'edited' : origin, unit: prev?.unit });
    }
    const canonical = this.canonicalValue(concept, display);
    let decimals;
    if (A.isNumeric(concept)) {
      decimals = String(enteredDecimals(canonical));
      if (prev?.decimals != null && prev.origin !== 'user' && Dec.eq(Dec.round(Dec.parse(canonical), prev.decimals), Dec.parse(canonical))) decimals = prev.decimals;
    }
    return this.setFact({ concept, period, dims, value: canonical, decimals, origin: prev ? prev.origin === 'user' ? 'user' : 'edited' : origin, unit: prev?.unit, lang: prev?.lang || (A.isNumeric(concept) ? null : 'en') });
  }

  removeFact(key) { const ok = this.facts.delete(key); if (ok) this.revision++; for (const f of this.footnotes.values()) f.factKeys.delete(key); return ok; }
  get(concept, period, dims = []) { return this.facts.get(factKey(concept, period, dims)) || null; }
  all() { return [...this.facts.values()]; }
  factsOf(concept) { return this.all().filter((f) => f.concept === concept); }
  inScope(scope) { return this.all().filter((f) => this.scopeOf(f.period) === scope); }

  // value lookup by concept + scope + dims (period resolved from the concept's periodType)
  value(concept, scope, dims = []) {
    const p = this.period(concept, scope);
    if (!p) return null;
    const f = this.get(concept, p, dims);
    return f && !f.nil ? f.value : null;
  }

  // ---- metadata facts mirrored into the general-information ELR
  addFootnote(text, factKeys = [], lang = 'en') {
    let n = this.footnotes.size + 1; while (this.footnotes.has(`fn${n}`)) n++;
    const id = `fn${n}`;
    this.footnotes.set(id, { id, text, lang, factKeys: new Set(factKeys) });
    this.revision++;
    return id;
  }

  // ---- persistence (local-first project file)
  toJSON() {
    return {
      format: 'mca-indas-xbrl-project', version: 1, authorityHash: this.A.meta.authorityHash,
      meta: this.meta,
      facts: this.all().map(({ key, ...f }) => f),
      footnotes: [...this.footnotes.values()].map((f) => ({ ...f, factKeys: [...f.factKeys] })),
      importReport: this.importReport,
    };
  }
  static fromJSON(authority, json) {
    if (json.format !== 'mca-indas-xbrl-project') throw new Error('Not an MCA Ind AS XBRL project file (Nikhil-IndASXBRL)');
    const f = new Filing(authority, json.meta);
    for (const x of json.facts) {
      const fact = { ...x, dims: normDims(x.dims) };
      fact.key = factKey(fact.concept, fact.period, fact.dims);
      f.facts.set(fact.key, fact);
    }
    for (const fn of json.footnotes || []) f.footnotes.set(fn.id, { ...fn, factKeys: new Set(fn.factKeys) });
    f.importReport = json.importReport || null;
    return f;
  }
}

export { scalePower };
