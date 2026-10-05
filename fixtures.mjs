// Deterministic Ind AS test filings, built only through the Session controller.
import { newSession, q, authority, CIN } from './helpers.mjs';
import { completeMandatory, sampleValue, buildExample, EXAMPLE_PERIODS } from './example.js';
import { Session } from './session.js';
import { Filing } from './model.js';
import { RuleEngine } from './rules.js';
import { Gate } from './gate.js';
import { generateInstance } from './generator.js';

export const TODAY = '2018-09-30';
export const placeholder = (A, c) => sampleValue(A, c);

// Every unconditionally mandatory element and one complete row in every mandatory table (gate-clean).
export function baseSession(meta = {}) { return completeMandatory(newSession(meta), { name: 'Test Co' }); }
// The in-app example (standalone, FY 2017-18 with comparatives; totals auto-calculated; gate-clean).
export function exampleSession(meta = {}) { const s = new Session(authority()); buildExample(s, { meta }); return s; }
export const consolidatedSession = () => baseSession({ reportType: 'Consolidated', cin: 'U72200KA2010PLC123456' });
export const cloneSession = (s) => new Session(s.A, Filing.fromJSON(s.A, s.filing.toJSON()));
export { EXAMPLE_PERIODS, CIN };

// table id by hypercube local name (optionally restricted to an ELR code prefix)
export function T(hc, code = null) {
  const t = authority().tables.find((x) => x.hypercube.endsWith(':' + hc) && (!code || x.id.startsWith(code)));
  if (!t) throw new Error('no table ' + hc);
  return t.id;
}
export const rule = (id) => { const r = authority().rules.rules.find((x) => x.id === id); if (!r) throw new Error('no rule ' + id); return r; };
// results of one rule (production engine, that rule only)
export function runRule(s, id, { today = TODAY, scope = null } = {}) {
  const res = new RuleEngine(s.A).run(s.filing, { today, only: new Set([id]) }).results.filter((x) => x.ruleId === id && (!scope || x.scope === scope));
  return { res, pass: res.some((x) => x.status === 'PASS'), fail: res.some((x) => x.status === 'FAIL' || x.status === 'WARN'), statuses: res.map((x) => x.status) };
}
export const set = (s, local, cy, py) => { if (cy != null) s.setValue(q(local), 'CY', String(cy), { recalc: true }); if (py != null) s.setValue(q(local), 'PY', String(py), { recalc: true }); };
export const val = (s, local, scope = 'CY', dims = []) => s.filing.value(q(local), scope, dims);
export const errorsOf = (g) => g.issues.filter((i) => i.severity === 'ERROR');

// the XML of what the gate would emit, without blocking on errors (round-trip tests of partial data only — the
// production export path is Session.exportXml, which always blocks on errors)
export function exportUnchecked(s, today = TODAY) {
  const A = s.A;
  const g = new Gate(A).run(s.filing, { today });
  return generateInstance(A, s.filing, g.emit.map((f) => (!A.isNumeric(f.concept) && !f.nil && ['string', 'textBlock', 'token', 'enum'].includes(A.dataType(f.concept)) && !f.lang ? { ...f, lang: 'en' } : f))).xml;
}
