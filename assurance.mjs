// Assurance harness (v1.1, ported from C&I v12–v14): machine checks that the tool never leaves the user with an error
// he cannot resolve himself. Run on the MCA-validated instances (golden-*.xml) by assurance.test.mjs.
//
//   rekey(xml, order)      start from an empty filing and type every fact of the accepted instance through the screen's
//                          own entry path (Session.setValue / setTableValue with tab, label role, recalculation and the
//                          calculated-cell lock, exactly as app.js does), in a given order → every value equal to the
//                          accepted filing, no validation error
//   mistakes(xml, n, seed) make n mistakes through the screen (clear a cell, change a value, flip a Yes/No, pick another
//                          option) → every error raised points to a cell/table the user can open and edit, and typing the
//                          original value back in the same cell restores the filing exactly (no error left behind)
//   lockedCells(xml)       every read-only (calculated) cell shown holds exactly the value its calculation gives; none
//                          is locked and empty
//   ruleLocations(filings) every element named by an executable MCA business rule locates, for both years, to a cell or
//                          table the user can open
// Ind AS: the opening balance sheet column of a first-time adoption (GR-16) is a screen cell like any other (scope PYO).
import { Session } from './session.js';
import { Filing } from './model.js';
import { tablesForFact, dimensionallyValid } from './dimensions.js';
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';
import { Gate } from './gate.js';
import * as Dec from './decimal.js';

export const TODAY = '2025-09-30';
export const errorsOf = (S) => S.validate({ today: TODAY }).issues.filter((i) => i.severity === 'ERROR');

function rowsIndex(S) {
  const m = new Map();
  for (const e of S.A.elrs) for (const r of S.elrView(e.uri).rows) if (r.kind === 'item') (m.get(r.concept) || m.set(r.concept, []).get(r.concept)).push({ uri: e.uri, pl: r.preferredLabel });
  return m;
}
const scopesOf = (S, uri) => (S.app.ftaActive(S.filing) && S.A.elr(uri)?.code === S.A.meta.profile?.balanceSheet ? ['CY', 'PY', 'PYO'] : ['CY', 'PY']);
// the screen cells that show a fact
export function cellsFor(S, rows, f) {
  const A = S.A, out = [], same = (p) => p && JSON.stringify(p) === JSON.stringify(f.period);
  if (!f.dims.length) for (const r of rows.get(f.concept) || []) for (const sc of scopesOf(S, r.uri)) {
    if (sc === 'PYO' && r.pl === 'periodStartLabel') continue; // the opening column holds balances only
    if (same(S.periodForCell(f.concept, sc, r.pl))) out.push({ kind: 'elr', uri: r.uri, pl: r.pl, scope: sc });
  }
  const tables = f.dims.length ? tablesForFact(A, f) : A.tables.filter((t) => t.lineItems.includes(f.concept));
  for (const t of tables) for (const l of S.tableView(t.id).lineItems) if (l.concept === f.concept) for (const sc of ['CY', 'PY']) if (same(S.periodForCell(f.concept, sc, l.preferredLabel))) out.push({ kind: 'table', tableId: t.id, pl: l.preferredLabel, scope: sc });
  return out;
}
export function enter(S, f, c, display) {
  const o = { preferredLabel: c.pl || null, recalc: true };
  if (c.kind === 'elr') return S.setValue(f.concept, c.scope, display, { ...o, tab: c.uri });
  return S.setTableValue(c.tableId, c.scope, f.dims, f.concept, display, { ...o, lockCalculated: true });
}
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const importIt = (A, xml, DOMParserImpl, yearMode = 'both') => { const s = new Session(A); s.importXml(xml, { DOMParserImpl, yearMode }); return s; };

export function rekey(A, xml, { order = 'rank', seed = 1, DOMParserImpl } = {}) {
  const src = importIt(A, xml, DOMParserImpl);
  const G = src.filing, m = G.meta;
  const S = new Session(A);
  S.setMeta({ name: m.name, cin: m.cin, reportType: m.reportType, level: m.level, displayPlaces: m.displayPlaces, firstFinancialYear: m.firstFinancialYear, periods: JSON.parse(JSON.stringify(m.periods)) });
  const rows = rowsIndex(S);
  const facts = G.all().filter((f) => !f.nil);
  const r = rng(seed), key = new Map(facts.map((f, i) => [f, order === 'reverse' ? -i : order === 'random' ? r() : i]));
  const answer = (f) => !f.dims.length && ['boolean', 'enum'].includes(A.dataType(f.concept)); // Yes/No and choices first (the screen disables dependent cells until answered)
  facts.sort((a, b) => (answer(b) - answer(a)) || (order === 'rank' ? (a.dims.length > 0) - (b.dims.length > 0) : key.get(a) - key.get(b)));
  const done = new Set();
  for (let pass = 0; pass < 3; pass++) for (const f of facts) {
    if (done.has(f)) continue;
    for (const c of cellsFor(S, rows, f)) { try { enter(S, f, c, S.displayOf(f)); done.add(f); break; } catch { /* calculated or not yet applicable */ } }
  }
  // imported zeros kept on a main statement although a Yes/No answer makes their cell not applicable
  // (Applicability.sourceZeroStatement — GE's OCI totals): no screen cell can take them, by design; counted apart
  const keptZero = (f) => f.origin === 'import' && !S.app.conceptStatus(S.filing, f.concept, S.filing.scopeOf(f.period) === 'PYO' ? 'PY' : S.filing.scopeOf(f.period)).applicable && S.app.sourceZeroStatement(f, S.app.conceptStatus(S.filing, f.concept, S.filing.scopeOf(f.period) === 'PYO' ? 'PY' : S.filing.scopeOf(f.period)).reasons);
  const notTypable = facts.filter((f) => !S.filing.get(f.concept, f.period, f.dims) && keptZero(f));
  const differing = facts.filter((f) => S.filing.get(f.concept, f.period, f.dims)?.value !== f.value && !notTypable.includes(f));
  const extra = S.filing.all().filter((g) => !G.get(g.concept, g.period, g.dims));
  const noCell = facts.filter((f) => !cellsFor(S, rows, f).length);
  return { facts: facts.length, typed: done.size, differing, extra, noCell: noCell.filter((f) => !notTypable.includes(f)), notTypable, errors: errorsOf(S) };
}

// can the user reach the place an error points to and act on it? null = yes, else the reason
export function reachable(S, loc) {
  const A = S.A;
  if (!loc) return 'no location';
  if (loc.kind === 'general') return null;
  if (loc.kind === 'tab') return 'only a tab, no cell';
  if (loc.kind === 'pyo') return S.filing.facts.has(loc.factKey) ? null : 'opening value not found'; // removable from the message
  const sc = loc.scope;
  const tsc = sc === 'PYO' ? 'PY' : sc;
  if (loc.kind === 'table') return S.tableStatus(loc.tableId, tsc).applicable ? null : 'table cannot be opened';
  if (loc.tableId) {
    if (!S.tableStatus(loc.tableId, tsc).applicable) return 'table cannot be opened';
    if (!S.tableView(loc.tableId).lineItems.some((l) => l.concept === loc.conceptQName)) return 'row not in the table';
    try { S.validateSlice(loc.tableId, loc.dims || []); } catch (e) { return 'column cannot be added: ' + e.message; }
    if (!dimensionallyValid(A, loc.conceptQName, loc.dims || []).valid) return 'cell not valid for the column';
    if (!S.conceptStatus(loc.conceptQName, tsc).applicable) return 'cell not applicable';
    return null;
  }
  if (!loc.elrUri || !S.elrView(loc.elrUri).rows.some((r) => r.concept === loc.conceptQName)) return 'row not on the tab';
  return S.cellStatus(loc.elrUri, loc.conceptQName, sc).applicable ? null : 'cell disabled';
}

// v1.3: yearMode 'next' sweeps a filing prepared with "Prepare next year's filing" (its previous year unlocked, so the
// mistakes reach the previous-year column, its opening balances and this year's opening balances)
export function mistakes(A, xml, { n = 100, seed = 7, DOMParserImpl, yearMode = 'both' } = {}) {
  const base = importIt(A, xml, DOMParserImpl, yearMode);
  if (yearMode === 'next') base.filing.meta.pyLocked = false;
  const json = JSON.stringify(base.filing.toJSON());
  const fresh = () => new Session(A, Filing.fromJSON(A, JSON.parse(json)));
  const S0 = fresh(), rows = rowsIndex(S0), r = rng(seed);
  const baseline = errorsOf(S0).map((e) => e.message).sort().join('\n');
  const facts = S0.filing.all().filter((f) => !f.nil && f.origin !== 'calculated' && cellsFor(S0, rows, f).length);
  const out = { made: 0, errorsRaised: 0, unreachable: [], notRestored: [], restoreRefused: [], benignZeroTotals: [] };
  for (let i = 0; i < n; i++) {
    const S = fresh();
    const f0 = facts[Math.floor(r() * facts.length)];
    const f = S.filing.get(f0.concept, f0.period, f0.dims);
    const cells = cellsFor(S, rows, f), c = cells[Math.floor(r() * cells.length)];
    const t = A.dataType(f.concept), orig = S.displayOf(f), k = r();
    let bad;
    if (t === 'boolean') bad = orig === 'true' ? 'false' : 'true';
    else if (t === 'enum') { const en = A.enumerations(f.concept).filter((x) => x !== orig); bad = en.length ? en[Math.floor(r() * en.length)] : ''; }
    else if (k < 0.4) bad = '';
    else if (A.isNumeric(f.concept)) bad = String(Number(String(orig).replace(/,/g, '')) + (k < 0.7 ? 1 : 1000));
    else if (t === 'date') bad = '2020-01-01';
    else bad = 'changed text';
    try { enter(S, f, c, bad); } catch { continue; } // a calculated cell: the screen refuses typing there
    out.made++;
    const what = `${f.concept}${f.dims.length ? ' [dims]' : ''} ${c.scope} → '${bad}'`;
    for (const e of errorsOf(S)) { out.errorsRaised++; const why = reachable(S, e.location); if (why) out.unreachable.push(`${what}: ${e.ruleId || e.code} ${e.message.slice(0, 120)} — ${why}`); }
    try { enter(S, f, c, orig); } catch (e) { out.restoreRefused.push(`${what}: ${e.message}`); continue; }
    const now = errorsOf(S).map((e) => e.message).sort().join('\n');
    const changed = S0.filing.all().filter((g) => S.filing.get(g.concept, g.period, g.dims)?.value !== g.value);
    const added = S.filing.all().filter((g) => !S0.filing.get(g.concept, g.period, g.dims));
    // a total of 0 the tool calculated from parts that are all 0 (no error, no figure changed): harmless, counted apart
    const benign = added.filter((g) => g.origin === 'calculated' && !g.nil && Dec.isZero(Dec.parse(g.value)));
    if (now !== baseline || changed.length || added.length > benign.length) out.notRestored.push(`${what}: ${changed.length} value(s) differ, ${added.length} added, errors ${now === baseline ? 'unchanged' : 'differ'}`);
    else if (benign.length) out.benignZeroTotals.push(`${what}: ${benign.map((g) => g.concept).join(', ')} = 0`);
  }
  return out;
}

// the value a locked (calculated) cell must show: Σ(child × weight) of the children reported in its network, or null
function derived(S, lk, q, period, dims) {
  if (lk.derived === 'carrying') { const v = S.carryingValue(q, period, dims); return v ? Dec.parse(v.value) : null; }
  const arcs = (S.A.json.calculation[lk.elr] || []).filter((a) => a.from === q);
  const kids = arcs.map((a) => ({ a, f: S.filing.get(a.to, period, dims) })).filter((k) => k.f && !k.f.nil);
  if (!kids.length) return null;
  return Dec.sum(kids.map((k) => Dec.mul(Dec.parse(k.f.value), Dec.parse(String(k.a.weight)))));
}
export function lockedCells(A, xml, { DOMParserImpl } = {}) {
  const S = importIt(A, xml, DOMParserImpl);
  const wrong = [], empty = [];
  let locked = 0;
  const chk = (q, sc, dims, tab, pl) => {
    if (!A.isNumeric(q)) return;
    const lk = S.calculatedCell(q, sc, dims, tab, pl);
    if (!lk) return;
    locked++;
    const p = S.periodForCell(q, sc, pl);
    if (!p) return;
    const a = S.filing.get(q, p, dims), d = derived(S, lk, q, p, dims);
    // a statement figure taken from its note may be empty (C&I v13): its note is open (Session.noteLink) and a nil (0) can be reported
    if ((!a || a.nil) && lk.note) { if (!S.noteLink(q, sc, tab) || !S.nilAllowed(lk.note, q, sc, '0', pl)) empty.push(`${q} ${sc}: taken from its note, empty, and no nil possible`); return; }
    if (lk.note) { const v = lk.note.kind === 'sum' ? S.noteValue(lk.note, sc) : null; if (v && !v.undetermined && !Dec.eq(v.total, Dec.parse(a.value))) wrong.push(`${q} ${sc}: shows ${a.value}, its note gives ${Dec.toString(v.total)}`); return; }
    if (!a || a.nil) { if (d == null) empty.push(`${q} ${sc}${dims.length ? ' [dims]' : ''}: locked and empty`); else wrong.push(`${q} ${sc}: empty, derives ${Dec.toString(d)}`); return; }
    if (d != null && !Dec.eq(d, Dec.parse(a.value))) wrong.push(`${q} ${sc}${dims.length ? ' [dims]' : ''}: shows ${a.value}, derives ${Dec.toString(d)}`);
  };
  for (const e of A.elrs) for (const r of S.elrView(e.uri).rows) if (r.kind === 'item') for (const sc of ['CY', 'PY']) if (S.cellStatus(e.uri, r.concept, sc).applicable) chk(r.concept, sc, [], e.uri, r.preferredLabel);
  for (const t of A.tables) for (const sc of ['CY', 'PY']) {
    if (!S.tableStatus(t.id, sc).applicable) continue;
    for (const d of t.axes.length ? tableSlices(A, S.filing, t.id, sc, reportingYear) : [[]]) for (const l of S.tableView(t.id).lineItems) if (!l.abstract) chk(l.concept, sc, d, t.presentationElr, l.preferredLabel);
  }
  return { locked, wrong, empty };
}

// every element an executable MCA rule names resolves, for both years, to a cell or table the user can open — so any
// error that rule raises can be clicked through to a place to fix it
export function ruleLocations(A, sessions) {
  const g = new Gate(A);
  const missing = [];
  let checked = 0;
  for (const S of sessions) for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE') continue;
    for (const c of [r.subject, r.ast?.concept, ...(r.ast?.concepts || [])].filter((x) => typeof x === 'string' && A.concept(x))) for (const sc of ['CY', 'PY']) {
      checked++;
      const l = g.locate(S.filing, { concept: c, scope: sc, ruleId: r.id, code: 'rule.' + r.id });
      if (!l || l.kind === 'tab' || (l.kind === 'cell' && !l.elrUri && !l.tableId)) missing.push(`${r.id} ${c} ${sc}`);
    }
  }
  return { checked, missing };
}
