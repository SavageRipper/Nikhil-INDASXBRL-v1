// UI shell. Talks only to the Session controller; renders every statement and table from the
// authority model (no table-specific code).
import { Authority } from './authority.js';
import { Session } from './session.js';
import { Filing, dimKey, factKey } from './model.js';
import { dimensionallyValid, factInTable } from './dimensions.js';
import { reportingYear, addDays } from './periods.js';
import { tableSlices } from './views.js';
import { openingConcepts } from './applicability.js';
import { Gate, htmlGuidelineIssues } from './gate.js';
import { RuleEngine } from './rules.js';
import { explainMcaErrors } from './mca-errors.js';
import { memberInfo, sortSlices, missingParents, totalsHints, allTotalsHints } from './member-hints.js';
import { carryForwardPlan, carryForward } from './carry-forward.js';
import { listFootnotes, addFootnote, updateFootnoteText, linkFootnote, unlinkFootnote, removeFootnote } from './footnotes.js';
import { toDisplay } from './scaling.js';
import { buildExample } from './example.js';
// replaced by build.mjs with a content hash of the bundle; shown in the header and written into every generated XML
globalThis.MCA_BUILD_ID = '__BUILD_ID__';
const BUILD_ID = globalThis.MCA_BUILD_ID;
import { toMca, fromMca, plainText } from './richtext.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STORE_KEY = 'mca-indas-xbrl.project.v1';
const VALIDATOR = 'MCA XBRL Validation Tool (Ind AS)';

const A = new Authority(JSON.parse(document.getElementById('mca-authority').textContent));
let S = null;
const state = { colOrder: 'taxonomy', totals: [], view: { kind: 'setup' }, gate: null, xml: null, pending: {}, issueFilter: 'ERROR', toastTimer: null, example: false, calcOverride: {}, lastTab: null };
const GENERAL_LABEL = 'Disclosure of General Information about Company';
const PROFILE = A.meta.profile; // statement ELR codes of this taxonomy (compiled from the role URIs)
const CF_CODES = PROFILE.cashFlowMethods; // { 'Direct Method': '310000', 'Indirect Method': '320000' }
const FTA = A.qnameOfLocal('WhetherCompanyHasAdoptedIndAsFirstTime');
const SCOPE_NAME = { CY: 'current year', PY: 'previous year', PYO: 'opening balance sheet of the previous year' };
// First-time adoption (Yes) adds the opening balance sheet of the previous year (instant at the day before the
// previous-year start) as a third column of the balance sheet: generic rule GR-16 / Filing Manual Annexure II #21.
const ftaOn = () => !!FTA && !S.filing.meta.firstFinancialYear && S.filing.value(FTA, 'CY', []) === 'true';
const scopesForElr = (uri) => (ftaOn() && A.elr(uri)?.code === PROFILE.balanceSheet ? ['CY', 'PY', 'PYO'] : ['CY', 'PY']);
const pyoDate = () => (S.filing.meta.periods.py.start ? addDays(S.filing.meta.periods.py.start, -1) : '?');
// country / currency fields (rules with a country or currency format check): suggestions from the workbook code sheets
const FORMAT_FIELDS = { country: new Set(), currency: new Set() };
for (const r of A.rules.rules) if (r.status === 'EXECUTABLE' && r.ast?.assert?.op === 'format' && FORMAT_FIELDS[r.ast.assert.format]) FORMAT_FIELDS[r.ast.assert.format].add(r.ast.concept);
const cfNote = (v) => { const on = CF_CODES[v], off = Object.values(CF_CODES).find((c) => c !== on); return `[${on}] enabled · [${off}] disabled`; };


// ------------------------------------------------------------------ mandatory marking (UI only; reads the compiled rules)
// The taxonomy itself declares no element mandatory (XBRL has no such attribute); "mandatory" comes from the MCA business
// rules (Business Rules Ind AS V1.2): unconditional mandatory fields, conditional ones ("mandatory if …"), and the
// mandatory line items of tables (sheet "Mandatory Line Items", "all details of at least one …").
const REQ = (() => {
  const byConcept = new Map(); // concept -> [{ id, text, conditional }]
  const tableItems = new Map(); // tableId -> Map(concept -> [{ id, text, kind: 'row' | 'one' | 'oneOf', soft }])
  const ids = new Set();
  const addC = (q, r, conditional) => { (byConcept.get(q) || byConcept.set(q, []).get(q)).push({ id: r.id, text: r.text, conditional }); };
  const addT = (t, q, x) => { const m = tableItems.get(t) || tableItems.set(t, new Map()).get(t); (m.get(q) || m.set(q, []).get(q)).push(x); };
  const enteredTargets = (p, out = []) => { if (!p || typeof p !== 'object') return out; if (p.op === 'entered' && p.e?.fact) out.push(p.e.fact); for (const v of Object.values(p)) if (v && typeof v === 'object') enteredTargets(v, out); return out; };
  const targets = new Map(); // eachFactOf rule id -> required concepts
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || !r.ast) continue;
    const a = r.ast;
    if (a.type === 'mandatory') { addC(a.concept, r, !!a.when); ids.add(r.id); }
    else if (a.type === 'eachFactOf') { const ts = [...new Set(enteredTargets(a.assert))]; if (ts.length) { targets.set(r.id, ts); for (const q of ts) addC(q, r, true); ids.add(r.id); } }
    else if (a.type === 'lineItemsMandatory') for (const t of a.tables) {
      const soft = new Set(a.softConcepts || []);
      for (const q of a.concepts) addT(t, q, { id: r.id, text: r.text, kind: 'row', soft: soft.has(q) });
      for (const g of a.atLeastOne || []) for (const q of g) addT(t, q, { id: r.id, text: `${r.text} — at least one of ${g.length} elements`, kind: 'oneOf' });
    } else if (a.type === 'tableOneComplete') for (const t of a.tables) for (const q of A.table(t)?.lineItems || []) if (!(a.except || []).includes(q)) addT(t, q, { id: r.id, text: r.text, kind: 'one' });
  }
  return { byConcept, tableItems, ids, targets, live: null, liveKey: '' };
})();
// which concepts are mandatory right now, per year (the engine decides conditions and applicability exactly as validation)
function reqLive() {
  const key = `${S.filing.revision}|${JSON.stringify(S.filing.meta)}`;
  if (REQ.live && REQ.liveKey === key) return REQ.live;
  const live = new Map(); // `${concept}|${scope}` -> [{ id, text, conditional }]
  try {
    const res = new RuleEngine(A).run(S.filing, { today: new Date().toISOString().slice(0, 10), only: REQ.ids }).results;
    for (const x of res) {
      if (!['PASS', 'FAIL', 'WARN'].includes(x.status) || !x.scope) continue;
      const r = A.rules.rules.find((y) => y.id === x.ruleId);
      const qs = r.ast.type === 'mandatory' ? [r.ast.concept] : REQ.targets.get(r.id) || [];
      for (const q of qs) { const k = `${q}|${x.scope}`; const l = live.get(k) || live.set(k, []).get(k); if (!l.some((y) => y.id === r.id)) l.push({ id: r.id, text: r.text, conditional: r.ast.type !== 'mandatory' || !!r.ast.when }); }
    }
  } catch { /* marking is advisory: never block the UI */ }
  REQ.live = live; REQ.liveKey = key;
  return live;
}
const reqFor = (q, scope) => reqLive().get(`${q}|${scope}`) || null;
const SCOPE_SHORT = { CY: 'current year', PY: 'previous year', PYO: 'opening balance sheet' };
// badge next to a statement row label
function reqBadge(q, scopes) {
  const on = scopes.filter((sc) => reqFor(q, sc));
  if (on.length) {
    const rules = [...new Map(on.flatMap((sc) => reqFor(q, sc)).map((r) => [r.id, r])).values()];
    const tip = `Mandatory for the ${on.map((sc) => SCOPE_SHORT[sc]).join(', ')} (MCA business rules):\n` + rules.map((r) => `${r.id}: ${r.text}`).join('\n');
    return `<span class="mand" data-req-badge="${esc(q)}" title="${esc(tip)}">Mandatory${on.length < scopes.length ? ' · ' + on.join(', ') : ''}</span>`;
  }
  const cond = (REQ.byConcept.get(q) || []).filter((r) => r.conditional);
  if (cond.length) return `<span class="mand cond" data-req-badge="${esc(q)}" title="${esc('Mandatory when its condition is met (not met now):\n' + cond.map((r) => `${r.id}: ${r.text}`).join('\n'))}">Conditional</span>`;
  return '';
}
// badge next to a table line item
function reqTableBadge(tableId, q, scope) {
  const xs = REQ.tableItems.get(tableId)?.get(q) || [];
  const live = reqFor(q, scope);
  if (!xs.length && !live) return '';
  const row = xs.find((x) => x.kind === 'row' && !x.soft), one = xs.find((x) => x.kind === 'one'), of = xs.find((x) => x.kind === 'oneOf'), soft = xs.find((x) => x.soft);
  const label = row ? 'Mandatory · every row' : one ? 'Mandatory · one complete row' : of ? 'One of these is mandatory' : soft ? 'Mandatory (warning only)' : 'Mandatory';
  const tip = [...xs.map((x) => `${x.id}: ${x.text}${x.soft ? ' (accepted in an MCA-validated instance: warning only)' : ''}`), ...(live || []).map((r) => `${r.id}: ${r.text}`)].join('\n');
  return `<span class="mand${soft && !row && !one && !of ? ' cond' : ''}" title="${esc(tip)}">${label}</span>`;
}
const reqCellTable = (tableId, q, dims) => dims.length > 0 && (REQ.tableItems.get(tableId)?.get(q) || []).some((x) => x.kind === 'row' && !x.soft);
const reqTag = (local) => { const q = A.qnameOfLocal(local); const rs = (REQ.byConcept.get(q) || []).filter((r) => !r.conditional); return rs.length ? `<span class="mand" title="${esc(rs.map((r) => `${r.id}: ${r.text}`).join('\n'))}">Mandatory</span>` : ''; };
const REQ_LEGEND = '<p class="note req-legend"><span class="mand">Mandatory</span> required by the MCA business rules (empty mandatory cells are outlined) · <span class="mand cond">Conditional</span> required when its condition is met — hover a tag for the rule. The taxonomy itself marks no element mandatory.</p>';
// after an in-place edit: conditions may have changed (e.g. "mandatory if X is entered")
function refreshRequired() {
  for (const el of document.querySelectorAll('#main [data-c][data-s]')) {
    const { c, s, t, slice } = el.dataset;
    if (el.disabled) continue;
    const need = t != null && slice != null ? reqCellTable(t, c, state.slices[Number(slice)] || []) : !!reqFor(c, s);
    el.classList.toggle('req', need);
    if ('placeholder' in el && el.tagName === 'INPUT') el.placeholder = need ? 'required' : '';
    if (el.type === 'date') { if (need && !el.value) el.dataset.empty = '1'; else delete el.dataset.empty; }
  }
  for (const b of document.querySelectorAll('#main [data-req-badge]')) {
    const tr = b.closest('tr'); const scopes = [...new Set([...tr.querySelectorAll('[data-s]')].map((x) => x.dataset.s))];
    const html = reqBadge(b.dataset.reqBadge, scopes.length ? scopes : ['CY', 'PY']);
    if (html) b.outerHTML = html;
  }
}

// ------------------------------------------------------------------ boot
function boot() {
  let restored = false;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { S = new Session(A, Filing.fromJSON(A, JSON.parse(raw))); restored = true; }
  } catch { S = null; }
  if (!S) { S = new Session(A); buildExample(S); state.example = true; }
  document.body.insertAdjacentHTML('beforeend', `<datalist id="dl-country">${(A.rules.countries || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist><datalist id="dl-currency">${(A.rules.currencies || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`);
  document.body.insertAdjacentHTML('beforeend', '<div class="modal" id="modal" hidden><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title"></h2><button type="button" class="x" data-modal="cancel" aria-label="Close">×</button></header><div class="mbody" id="modal-body"></div><footer id="modal-foot"></footer></div></div>');
  wire();
  render();
  if (restored) toast('Restored your last project from this browser.');
}

let saveTimer = null;
function changed() {
  state.gate = null; state.xml = null;
  clearTimeout(saveTimer);
  state.saved = 'pending';
  saveTimer = setTimeout(saveLocal, 400);
  renderBar(); updateNav();
}
// autosave to this browser (unchanged behaviour); the bar shows when it last succeeded
function saveLocal() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.filing.toJSON())); state.saved = new Date(); } catch { state.saved = 'failed'; /* storage unavailable: project file save still works */ }
  const el = $('#bar-save'); if (el) el.outerHTML = saveChip();
  return state.saved instanceof Date;
}
function saveChip() {
  const v = state.saved;
  if (v === 'pending') return '<span class="chip" id="bar-save" title="Changes are saved in this browser automatically">Saving…</span>';
  if (v === 'failed') return '<span class="chip warn" id="bar-save" title="This browser does not allow local storage here. Use Save project to keep a file.">Not saved in browser</span>';
  if (v instanceof Date) return `<span class="chip ok" id="bar-save" title="Saved in this browser automatically. Use Save project to download a project file.">Saved ${v.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  return '';
}

// in-place nav refresh: rebuilding the nav while an input blurs would swallow the user's click
function updateNav() {
  for (const a of document.querySelectorAll('#nav a[data-elr]')) {
    const uri = a.dataset.elr;
    a.classList.toggle('na', !S.elrStatus(uri, 'CY').applicable);
    const d = a.querySelector('.dot'); if (d) d.className = 'dot ' + elrDot(uri);
  }
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', bad ? 'alert' : 'status'); t.hidden = false;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

// In the hosted (claude.ai) viewer files go through the viewer's downloads capability (the viewer confirms each
// save); opened from disk or GitHub Pages, a normal browser download is used.
const downloadsCap = typeof window !== 'undefined' && window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
async function download(name, text, mime) {
  const dl = await downloadsCap;
  if (dl) {
    try { await dl.save({ filename: name, data: text }); toast(`Saved ${name}.`); }
    catch (e) {
      if (e?.code === 'declined') return;
      toast(e?.code === 'rejected_extension' ? `This viewer cannot save ${name.split('.').pop()} files — use Copy XML, or open index.html from the repository to download.` : 'Download is unavailable here — use Copy instead.', true);
    }
    return;
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch { toast('Download is blocked here — use Copy instead.', true); }
}

// ------------------------------------------------------------------ chrome
function render() { renderBar(); renderNav(); renderMain(); }

function renderBar() {
  const m = S.filing.meta;
  const g = state.gate;
  const where = g?.scope?.kind === 'tab' ? `Tab [${g.scope.code}]` : 'Internal gate';
  const gateChip = !g ? '<span class="chip">Internal gate · not run</span>' : g.ok ? `<span class="chip ok">${where} · pass</span>` : `<span class="chip bad">${where} · ${g.summary.errors} errors</span>`;
  const sm = document.querySelector('.brand small'); if (sm && !sm.dataset.build) { sm.dataset.build = BUILD_ID; sm.textContent = `MCA · IND AS TAXONOMY 2017 · BUILD ${BUILD_ID}`; sm.title = 'Tool build. After an update, press Ctrl+F5 (Cmd+Shift+R) if this does not change. Every generated XML names its build in its first comment.'; }
  $('#bar-who').innerHTML = `<b>${esc(m.name || 'Untitled filing')}${state.example ? ' <span class="chip warn">example data</span>' : ''}</b><span>${esc(m.cin || 'CIN not set')} · ${esc(m.reportType)} · FY ${esc(m.periods.cy.start || '?')} → ${esc(m.periods.cy.end || '?')}</span>`;
  $('#bar-status').innerHTML = `${saveChip()}${gateChip}<span class="chip" title="Official validation happens only in the ${VALIDATOR}, outside this app">MCA validation tool · not run</span>`;
}

function elrDot(uri) {
  const has = S.filing.all().some((f) => A.conceptElrs(f.concept).includes(uri));
  const err = state.gate && state.gate.issues.some((i) => i.severity === 'ERROR' && i.factKey && A.conceptElrs(S.filing.facts.get(i.factKey)?.concept || '').includes(uri));
  return err ? 'err' : has ? 'has' : '';
}

function renderNav() {
  const v = state.view;
  const groups = ['Statements', 'Notes', 'Disclosures'];
  const tool = (kind, label, extra = '') => `<a href="#" data-go="${kind}" class="${v.kind === kind ? 'on' : ''}" ${v.kind === kind ? 'aria-current="page"' : ''}><span>${label}</span>${extra}</a>`;
  let h = `<div class="tools"><h3>Filing</h3>${tool('setup', GENERAL_LABEL)}${tool('validate', 'Validation', state.gate ? `<span class="chip ${state.gate.ok ? 'ok' : 'bad'}">${state.gate.ok ? 'pass' : state.gate.summary.errors}</span>` : '')}${tool('mismatch', 'Mismatches', state.gate ? `<span class="chip ${mismatchCount() ? 'warn' : 'ok'}">${mismatchCount()}</span>` : '')}${tool('xml', 'Generate XML')}${tool('import', 'Import report', S.filing.importReport ? '<span class="chip info">1</span>' : '')}${tool('coverage', 'Rule coverage')}${tool('footnotes', 'Footnotes', footnoteCount() ? `<span class="chip info">${footnoteCount()}</span>` : '')}${tool('mcaerrors', 'MCA error help')}</div>`;
  for (const g of groups) {
    h += `<h3>${g}</h3>`;
    for (const e of A.elrs.filter((x) => x.group === g)) {
      const st = S.elrStatus(e.uri, 'CY');
      const on = (v.kind === 'elr' && v.elr === e.uri) || (v.kind === 'table' && A.table(v.tableId)?.presentationElr === e.uri);
      h += `<a href="#" data-elr="${esc(e.uri)}" class="${on ? 'on' : ''} ${st.applicable ? '' : 'na'}" ${on ? 'aria-current="page"' : ''} title="${esc(st.applicable ? e.definition : st.reasons.join('\n'))}"><span class="code">${esc(e.code)}</span><span>${esc(e.title)}</span><span class="dot ${elrDot(e.uri)}"></span></a>`;
    }
  }
  $('#nav').innerHTML = h;
}

function renderMain({ keepScroll = false } = {}) {
  const v = state.view;
  const el = $('#main');
  const top = el.scrollTop;
  if (v.kind === 'setup') el.innerHTML = viewSetup();
  else if (v.kind === 'elr') el.innerHTML = viewElr(v.elr);
  else if (v.kind === 'table') el.innerHTML = viewTable(v.tableId, v.scope);
  else if (v.kind === 'validate') el.innerHTML = viewValidate();
  else if (v.kind === 'xml') el.innerHTML = viewXml();
  else if (v.kind === 'import') el.innerHTML = viewImport();
  else if (v.kind === 'import-confirm') el.innerHTML = viewImportConfirm();
  else if (v.kind === 'coverage') el.innerHTML = viewCoverage();
  else if (v.kind === 'mcaerrors') el.innerHTML = viewMcaErrors();
  else if (v.kind === 'mismatch') el.innerHTML = viewMismatch();
  else if (v.kind === 'footnotes') el.innerHTML = viewFootnotes();
  el.scrollTop = keepScroll ? top : 0;
  labelCells();
  markIssues();
  refreshTotals();
}

// Accessible names for grid cells: "<row label> — <column heading>" (read from the rendered table; display only)
function labelCells() {
  for (const td of document.querySelectorAll('#main table.g td.val')) {
    const ctl = td.querySelector('.cellin, .tb-btn');
    if (!ctl || ctl.hasAttribute('aria-label')) continue;
    const tr = td.parentElement;
    const lbl = tr.querySelector('td.lbl')?.firstChild?.textContent?.trim() || '';
    const th = td.closest('table').tHead?.rows[0]?.cells[td.cellIndex];
    let col = '';
    if (th) col = th.classList.contains('slicehead') ? [...th.querySelectorAll('.m, input')].map((x) => x.value ?? x.textContent).join(' / ') : th.textContent.trim();
    if (!col) col = ctl.dataset.s === 'PY' ? 'previous year' : ctl.dataset.s === 'CY' ? 'current year' : '';
    ctl.setAttribute('aria-label', [lbl, col].filter(Boolean).join(' — '));
  }
}

// ------------------------------------------------------------------ validation marks on cells
// Issues carry a structured location (gate.locate): the cell id is the fact key (concept#period#dimensions),
// the same id every rendered cell carries in data-cell. Several issues on one cell aggregate.
function issueIndex() {
  const m = new Map();
  for (const i of state.gate?.issues || []) {
    const id = i.location?.cellId;
    if (!id || i.severity === 'INFO') continue;
    (m.get(id) || m.set(id, []).get(id)).push(i);
  }
  return m;
}
function markIssues() {
  const idx = issueIndex();
  for (const el of document.querySelectorAll('#main [data-cell]')) {
    const list = idx.get(el.dataset.cell) || [];
    const err = list.some((i) => i.severity === 'ERROR');
    el.classList.toggle('cell-err', err);
    el.classList.toggle('cell-warn', !err && list.length > 0);
    if (err) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    if (list.length) { el.dataset.issues = list.length; el.title = list.map((i) => `${i.severity}: ${i.message}`).join('\n'); }
    else delete el.dataset.issues;
  }
}
function navigateTo(loc) {
  if (!loc) { toast('This message is not tied to a single cell.'); return; }
  if (loc.kind === 'general') { go({ kind: 'setup' }); const f = loc.field && document.getElementById(loc.field); if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); flash(f); } return; }
  const target = loc.tableId && loc.kind === 'cell' ? { kind: 'table', tableId: loc.tableId, scope: loc.scope } : loc.elrUri ? { kind: 'elr', elr: loc.elrUri } : null;
  if (target && !guardLeave(target, () => navigateTo(loc))) return;
  if (target) { state.leaveOk = true; go(target); }
  else { toast('No filing tab holds this element.', true); return; }
  const el = document.querySelector(`#main [data-cell="${CSS.escape(loc.cellId)}"]`);
  if (!el) { toast('The cell is not shown on this tab (row not entered yet).', true); return; }
  el.scrollIntoView({ block: 'center' });
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  flash(el);
}
// navigate to an element named in an MCA message: its first entered cell, else its tab
function goConcept(q) {
  const f = S.filing.factsOf(q).find((x) => !x.nil) || S.filing.factsOf(q)[0];
  const g = new Gate(A);
  const loc = f ? g.locate(S.filing, { factKey: f.key }) : g.locate(S.filing, { concept: q, scope: 'CY' });
  if (loc) return navigateTo(loc);
  const elr = A.conceptElrs(q)[0];
  if (elr) return go({ kind: 'elr', elr });
  toast('No filing tab holds this element.', true);
}
// ---- parent/child (total/part) guidance on dimensional tables (member-hints.js; display only)
const shortLabel = (q) => A.label(q).replace(/ \[Member\]$/, '');
function memberTitle(mi) {
  const parts = [];
  if (mi.isDefault) parts.push('Default member: the total of this axis (reported without the axis).');
  if (mi.children.length) parts.push(`Total of: ${mi.children.slice(0, 8).map(shortLabel).join(', ')}${mi.children.length > 8 ? ` (+${mi.children.length - 8} more)` : ''}.`);
  if (mi.path.length) parts.push(`Part of: ${mi.path.map(shortLabel).join(' › ')}.`);
  return parts.join(' ');
}
function axisHelp(tax, member) {
  if (!tax || tax.typed) return '';
  const m = member || A.dimensionDefault(tax.axis);
  if (!m) return '';
  const mi = memberInfo(A, tax, m);
  const name = shortLabel(m);
  if (!member) return `${name} (default) is the total of this axis.`;
  const req = requiredParentOf(state.view.tableId, tax.axis, m);
  let t = mi.isTotal ? `${name} is a TOTAL of ${mi.children.length} member(s): ${mi.children.slice(0, 5).map(shortLabel).join(', ')}${mi.children.length > 5 ? ', …' : ''}. Its value should equal the sum of the parts you report.` : `${name} is a part.`;
  if (mi.path.length) t += ` It is included in ${mi.path.map(shortLabel).join(' › ')}.`;
  if (req) t += ` FM-14 (Filing Manual Annexure II #14): when it has values, the ${shortLabel(req)} column is required too.`;
  return t;
}
function colName(dims, tableId = state.view.tableId) {
  return A.table(tableId).axes.map((ax) => { const d = dims.find((x) => x.axis === ax.axis); return d ? (d.member ? shortLabel(d.member) : d.typed) : A.dimensionDefault(ax.axis) ? shortLabel(A.dimensionDefault(ax.axis)) : '—'; }).join(' / ');
}
const fmtAmt = (q, v) => (A.dataType(q) === 'monetary' ? toDisplay(v, S.filing.meta.level) : String(v));
// the line under each total cell: equals its parts ✓, or the parts total and the difference
function refreshTotals() {
  const v = state.view;
  const slots = document.querySelectorAll('#main .sum-hint[data-sumfor]');
  if (v.kind !== 'table' || !slots.length) { state.totals = []; return; }
  let hints = [];
  try { hints = totalsHints(S, v.tableId, v.scope, state.slices || [], { includeMatches: true }); } catch { hints = []; }
  state.totals = hints;
  const by = new Map(hints.map((h) => [h.cellId, h]));
  for (const el of slots) {
    const h = by.get(el.dataset.sumfor);
    const input = el.parentElement.querySelector('.cellin');
    input?.classList.toggle('sum-off', !!h && !h.ok);
    if (!h) { el.innerHTML = ''; continue; }
    const parts = h.children.map((c) => shortLabel(c.member)).join(' + ');
    if (h.ok) { el.innerHTML = `<span class="ok" title="${esc(`Equals the sum of: ${parts}`)}">= parts ✓</span>`; continue; }
    el.innerHTML = `<span title="${esc(`Sum of: ${parts}${h.missingChildren.length ? ` — not in the table: ${h.missingChildren.slice(0, 6).map(shortLabel).join(', ')}` : ''}. Tool guidance, not an MCA rule.`)}">Parts ${esc(fmtAmt(h.concept, h.childrenSum))} · differs by ${esc(fmtAmt(h.concept, h.difference))}</span> <button type="button" class="btn small" data-act="use-sum" data-sumcell="${esc(h.cellId)}" title="Enter the sum of the part columns in this total cell">Use parts total</button>`;
  }
}
function requiredParentOf(tableId, axis, member) {
  const dims = [{ axis, member }];
  return missingParents(A, tableId, [dims])[0]?.parents[0]?.member || null;
}

// Keyboard movement in the grids: Enter / Shift+Enter (and ↑/↓ in text cells) move to the same column of the
// next / previous row that has an editable cell. The value is committed by the normal change event on leaving.
function gridKeys(ev) {
  const el = ev.target;
  if (ev.altKey || ev.ctrlKey || ev.metaKey || !el.closest?.('#main table.g td.val')) return false;
  const isBtn = el.classList.contains('tb-btn');
  const isText = el.matches('input.cellin:not([type="date"])');
  if (!el.matches('.cellin, .tb-btn')) return false;
  let dir = 0;
  if (ev.key === 'Enter' && !isBtn) dir = ev.shiftKey ? -1 : 1;
  else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && (isText || isBtn) && !ev.shiftKey) dir = ev.key === 'ArrowDown' ? 1 : -1;
  if (!dir) return false;
  const td = el.closest('td');
  const rows = [...td.closest('tbody').rows];
  for (let r = rows.indexOf(td.parentElement) + dir; r >= 0 && r < rows.length; r += dir) {
    const next = rows[r].cells[td.cellIndex]?.querySelector('.cellin:not([disabled]):not([readonly]), .tb-btn:not([disabled])');
    if (!next || !next.closest('td.val')) continue;
    ev.preventDefault();
    const id = next.dataset.cell;
    next.focus();
    if (next.select && next.tagName === 'INPUT') next.select();
    // a Yes/No or list answer re-renders the sheet on change: focus the same cell again in the new rendering
    setTimeout(() => { if (!document.contains(next) && id) document.querySelector(`#main [data-cell="${CSS.escape(id)}"]`)?.focus(); }, 0);
    return true;
  }
  if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); el.focus(); } // last row: commit in place
  return true;
}
// Modal keyboard: Tab stays inside the dialog; Ctrl+Enter saves a text block
function modalKeys(ev) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && modalState?.kind === 'textblock') { ev.preventDefault(); modalAction('save'); return; }
  if (ev.key !== 'Tab') return;
  const f = [...document.querySelectorAll('#modal .dlg button:not([disabled]), #modal .dlg select, #modal .dlg [contenteditable="true"], #modal .dlg input, #modal .dlg a[href]')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
  else if (!ev.shiftKey && i === f.length - 1) { ev.preventDefault(); f[0].focus(); }
}
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

function go(view) {
  if (!guardLeave(view, () => go(view))) return false;
  state.leaveOk = false;
  state.view = view; $('#nav').classList.remove('open'); renderNav(); renderMain();
  return true;
}
// Leaving a dimensional table whose total columns differ from the sum of their part columns: ask first
// (tool guidance — values are already saved; "Continue anyway" always proceeds).
function guardLeave(next, retry) {
  const v = state.view;
  if (state.leaveOk || v.kind !== 'table' || !$('#modal').hidden) return true;
  if (next && next.kind === 'table' && next.tableId === v.tableId && next.scope === v.scope) return true;
  let hints = [];
  try { hints = totalsHints(S, v.tableId, v.scope, slicesFor(v.tableId, v.scope)); } catch { return true; }
  if (!hints.length) return true;
  const items = hints.slice(0, 8).map((h) => `<li>${esc(A.label(h.concept))} — <b>${esc(colName(h.parentDims))}</b>: ${esc(fmtAmt(h.concept, h.parentValue))} vs parts ${esc(fmtAmt(h.concept, h.childrenSum))}</li>`).join('');
  confirmDialog('Totals do not match', `${hints.length} total cell(s) on this table differ from the sum of their part columns:<ul class="hint-list">${items}</ul>${hints.length > 8 ? `<p>… and ${hints.length - 8} more (see Validation → Totals hints).</p>` : ''}<p class="note">Tool guidance, not an MCA rule. Your values are already saved; nothing is changed.</p>`,
    () => { state.leaveOk = true; retry(); }, null, { cancel: 'Stay and fix', ok: 'Continue anyway' });
  return false;
}

// ------------------------------------------------------------------ cells
// cell = { id: fact key of the cell, calculated: bool, locked: bool }
function inputFor(concept, fact, attrs, disabled, title, cell = {}) {
  const t = A.dataType(concept);
  const val = fact ? S.displayOf(fact) : '';
  if (cell.id) attrs += ` data-cell="${esc(cell.id)}"`;
  const ro = cell.locked && !disabled;
  // auto: a closing balance derived as opening + change (formula linkbase roll-forward) — typing replaces it
  const auto = !cell.calculated && !disabled && fact && fact.origin === 'calculated';
  const req = !!cell.required && !disabled;
  const cls = `cellin${A.isNumeric(concept) ? ' num' : ''}${cell.calculated ? ' calc' : ''}${cell.calculated && !cell.locked ? ' calc-open' : ''}${auto ? ' calc auto' : ''}${req ? ' req' : ''}`;
  const tip = title || (ro ? 'Calculated from its child elements (taxonomy calculation) — use the tab option to edit calculated cells' : auto ? 'Auto-calculated: opening balance + changes during the period (taxonomy formula linkbase). Type a value to override it.' : '');
  const common = `class="${cls}" ${attrs} ${disabled ? 'disabled' : ''} ${ro ? 'readonly aria-readonly="true"' : ''} ${req ? 'aria-required="true"' : ''} title="${esc(tip)}"`;
  if (t === 'boolean') return `<select ${common}><option value=""></option><option value="true" ${val === 'true' ? 'selected' : ''}>Yes (true)</option><option value="false" ${val === 'false' ? 'selected' : ''}>No (false)</option></select>`;
  if (t === 'enum') return `<select ${common}><option value=""></option>${A.enumerations(concept).map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (t === 'date') return `<input type="date" ${common} value="${esc(val)}"${req && !val ? ' data-empty="1"' : ''}>`;
  if (t === 'textBlock') return textBlockButton(concept, fact, attrs, disabled, title, req);
  const list = FORMAT_FIELDS.country.has(concept) ? 'list="dl-country" autocomplete="off"' : FORMAT_FIELDS.currency.has(concept) ? 'list="dl-currency" autocomplete="off"' : '';
  return `<input type="text" ${A.isNumeric(concept) ? 'inputmode="decimal"' : ''} ${list} ${common} value="${esc(val)}"${req ? ' placeholder="required"' : ''}>`;
}
// Rich-text editor for narrative (text block) facts: content is stored as MCA-compliant markup (richtext.js)
// Text block cell: a compact button; the editor opens in a modal (openTextBlock). The stored value is the same
// MCA-compliant markup as before (richtext.js).
function textBlockButton(concept, fact, attrs, disabled, title, req = false) {
  const text = fact && !fact.nil ? plainText(fact.value) : '';
  const preview = text ? esc(text.length > 70 ? text.slice(0, 70) + '…' : text) : '<span class="muted">empty</span>';
  return `<div class="tbcell"><button type="button" class="btn small tb-btn${text ? ' has' : ''}${req ? ' req' : ''}" data-textblock ${attrs} ${disabled ? 'disabled' : ''} title="${esc(title || 'Edit text block')}">Text Block</button><span class="tb-prev">${preview}</span></div>`;
}
const RTE_BUTTONS = [['bold', 'B', 'Bold'], ['italic', 'I', 'Italic'], ['underline', 'U', 'Underline'], ['insertOrderedList', '1.', 'Numbered list'], ['insertUnorderedList', '•', 'Bulleted list'], ['indent', '⇥', 'Indent'], ['outdent', '⇤', 'Outdent'], ['removeFormat', 'Tx', 'Clear formatting'], ['tableBorders', '▦', 'Table borders on/off (table at the cursor)']];
// MCA conversion options for the current filing (richtext.js toMca)
const rteOpts = (extra = {}) => ({ emphasis: S.filing.meta.textEmphasis === 'none' ? 'none' : 'highlight', ...extra });
// toggle class="bordered" on every cell of the table at the cursor
function toggleTableBorders(body) {
  const sel = window.getSelection();
  const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
  const table = node?.closest?.('table');
  if (!table || !body.contains(table)) { toast('Place the cursor inside a table first.', true); return; }
  const cells = [...table.querySelectorAll('td, th')];
  const on = !cells.every((c) => c.classList.contains('bordered'));
  for (const c of cells) { c.classList.toggle('bordered', on); c.classList.toggle('unbordered', !on); }
  toast(on ? 'Table borders on (class="bordered").' : 'Table borders off (class="unbordered").');
}

const typeTag = (q) => {
  const t = A.dataType(q);
  if (t === 'monetary') return S.filing.meta.level === 'Actual' ? 'INR' : `INR ${S.filing.meta.level.toLowerCase()}`;
  return { shares: 'shares', perShare: 'INR/share', percent: '0–1 (pure)', decimal: 'number', pure: 'pure', date: 'date', boolean: 'yes/no', enum: 'list', textBlock: 'text block', string: 'text', token: 'text' }[t] || t;
};

// ------------------------------------------------------------------ views
// Disclosure of General Information about Company: the company/filer facts the filing needs, mapped to their
// taxonomy concepts (meta fields are mirrored into the general-information ELR facts by Session.setMeta), the
// cash-flow method (TypeOfCashFlowStatement), first-time adoption of Ind AS, and every other element of that ELR.
const META_MIRRORED = ['NameOfCompany', 'CorporateIdentityNumber', 'NatureOfReportStandaloneConsolidated', 'LevelOfRoundingUsedInFinancialStatements', 'DateOfStartOfReportingPeriod', 'DateOfEndOfReportingPeriod', 'TypeOfCashFlowStatement'];
function viewSetup() {
  const m = S.filing.meta;
  const levels = A.enumerations(A.qnameOfLocal('LevelOfRoundingUsedInFinancialStatements'));
  const qName = A.qnameOfLocal('NameOfCompany');
  const companyName = S.getValue(qName, 'CY')?.value ?? m.name;
  const qCf = A.qnameOfLocal('TypeOfCashFlowStatement');
  const cf = S.getValue(qCf, 'CY')?.value || '';
  const gi = A.elrByCode(PROFILE.generalInformation);
  const fta = FTA ? S.filing.value(FTA, 'CY', []) : null;
  const ftaSt = FTA ? S.conceptStatus(FTA, 'CY') : { applicable: false, reasons: [] };
  const cfOpt = (v, label) => `<label class="choice inline${cf === v ? ' on' : ''}"><input type="radio" name="cashflow" id="cf-${v.startsWith('Direct') ? 'direct' : 'indirect'}" value="${esc(v)}" ${cf === v ? 'checked' : ''}><span><b>${label}</b><span class="note">${cfNote(v)}</span></span></label>`;
  const ftaOpt = (v, label, note) => `<label class="choice inline${fta === v ? ' on' : ''}"><input type="radio" name="fta" id="fta-${v === 'true' ? 'yes' : 'no'}" value="${v}" ${fta === v ? 'checked' : ''} ${ftaSt.applicable ? '' : 'disabled'}><span><b>${label}</b><span class="note">${note}</span></span></label>`;
  return `<div class="sheet"><header><h1 id="general-title">${GENERAL_LABEL}</h1><span class="note">[${esc(gi.code)}] · ${esc(A.meta.taxonomyVersion)} · schemaRef ${esc(A.meta.schemaRef)}</span></header>
  ${state.example ? '<div class="banner warn">This is an <b>example filing</b> (a small services company, FY 2017-18 with 2016-17 comparatives) so you can see how the sheets work: totals, cash flow and equity roll-forwards are auto-calculated from the leaf values. Use <b>New filing</b> to start your own, or <b>Import XML</b> to load an existing instance (or roll last year\'s filing forward).</div>' : ''}
  <form class="form" id="setup" autocomplete="off">
    <h2 class="wide">Company identity</h2>
    <label class="wide">Name of company ${reqTag('NameOfCompany')}<span class="el">in-ca:NameOfCompany</span><input id="f-name" name="name" value="${esc(companyName)}"></label>
    <label>Corporate identity number (CIN) ${reqTag('CorporateIdentityNumber')}<span class="el">in-ca:CorporateIdentityNumber · entity identifier</span><input id="f-cin" name="cin" value="${esc(m.cin)}" maxlength="21" placeholder="U72200KA2010PTC123456" style="font-family:var(--f-data)"></label>
    <label>Nature of report ${reqTag('NatureOfReportStandaloneConsolidated')}<span class="el">NatureOfReportStandaloneConsolidated</span><select id="f-rt" name="reportType">${['Standalone', 'Consolidated'].map((x) => `<option ${x === m.reportType ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <h2 class="wide">Reporting period</h2>
    <label>Date of start of reporting period ${reqTag('DateOfStartOfReportingPeriod')}<span class="el">DateOfStartOfReportingPeriod</span><input id="f-cys" type="date" name="cy.start" value="${esc(m.periods.cy.start)}"></label>
    <label>Date of end of reporting period ${reqTag('DateOfEndOfReportingPeriod')}<span class="el">DateOfEndOfReportingPeriod</span><input id="f-cye" type="date" name="cy.end" value="${esc(m.periods.cy.end)}"></label>
    <label>Previous year — start<input id="f-pys" type="date" name="py.start" value="${esc(m.periods.py.start)}" ${m.firstFinancialYear ? 'disabled' : ''}></label>
    <label>Previous year — end<input id="f-pye" type="date" name="py.end" value="${esc(m.periods.py.end)}" ${m.firstFinancialYear ? 'disabled' : ''}></label>
    <label class="chk wide"><input id="f-first" type="checkbox" name="firstFinancialYear" ${m.firstFinancialYear ? 'checked' : ''}> First financial year of the company (no previous-year figures)</label>
    <h2 class="wide">Presentation of the financial statements</h2>
    <label>Level of rounding used in financial statements ${reqTag('LevelOfRoundingUsedInFinancialStatements')}<span class="el">LevelOfRoundingUsedInFinancialStatements</span><select id="f-lvl" name="level">${levels.map((x) => `<option ${x === m.level ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Decimal places as presented<select id="f-dp" name="displayPlaces">${[0, 1, 2, 3].map((x) => `<option ${x === Number(m.displayPlaces) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <div class="wide"><button class="btn primary" type="submit">Apply</button></div>
  </form>
  <h2>Cash flow statement method ${reqTag('TypeOfCashFlowStatement')}<span class="el">in-ca:TypeOfCashFlowStatement</span></h2>
  <div class="choices row" id="cashflow">${cfOpt('Direct Method', 'Direct method')}${cfOpt('Indirect Method', 'Indirect method')}</div>
  ${cf ? '' : '<p class="note">Not selected: both cash-flow statements stay open until a method is chosen.</p>'}
  ${FTA ? `<h2>First-time adoption of Ind AS ${reqTag('WhetherCompanyHasAdoptedIndAsFirstTime')}<span class="el">${esc(FTA)}</span></h2>
  <div class="choices row" id="fta">${ftaOpt('true', 'Yes — first Ind AS financial statements', `Adds the opening balance sheet of the previous year (${esc(pyoDate())}) as a third column of [${esc(PROFILE.balanceSheet)}] (GR-16 / Filing Manual Annexure II #21) and requires the Ind AS transition reconciliations`)}${ftaOpt('false', 'No', 'Two columns: current and previous year')}</div>
  ${ftaSt.applicable ? '' : `<p class="note">${esc(ftaSt.reasons.join('; '))}</p>`}` : ''}
  <h2>Other general information</h2>
  <p class="note">All other elements of [${esc(gi.code)}] ${esc(gi.title)}. Elements set above are shown read-only here.</p>
  ${elrGrid(gi.uri, { readonly: new Set(META_MIRRORED.map((l) => A.qnameOfLocal(l))) })}
  <h2>How values are stored</h2>
  <p class="note">Monetary values are typed in the chosen scale (for example <b>Lakhs</b>) and stored as exact rupee amounts. The XML always carries the unscaled amount with a <code>decimals</code> attribute that matches the presented accuracy (Lakhs with 2 places → <code>decimals="-3"</code>). Shares, per-share amounts and percentages are never scaled; percentages are entered as fractions (60% → 0.6).</p>
  <h2>Authority</h2>
  <p class="note">${Object.keys(A.concepts).length.toLocaleString('en-IN')} concepts · ${A.elrs.length} ELRs · ${A.tables.length} tables · ${A.meta.relationshipStats.notAll} notAll · ${A.meta.relationshipStats.dimensionDefault} defaults · ${A.meta.relationshipStats.calculationArcs} calculation arcs · ${A.meta.formulaAssertions} formula assertions · authority ${esc(A.meta.authorityHash.slice(0, 12))}</p></div>`;
}

function tabTools(tabKey, elrUri) {
  return `<span class="tabtools"><label class="chk small"><input type="checkbox" data-calc-override="${esc(tabKey)}" ${state.calcOverride[tabKey] ? 'checked' : ''}> Allow editing of calculated cells</label>
    <button class="btn small" data-act="validate-tab" data-tab="${esc(elrUri)}">Validate current tab</button><button class="btn small" data-act="validate">Validate entire filing</button></span>`;
}

function elrGrid(uri, { readonly = null } = {}) {
  const view = S.elrView(uri);
  const scopes = scopesForElr(uri); // + PYO (opening balance sheet of the previous year) on the balance sheet under FTA
  const span = scopes.length + 2;
  let rows = '';
  for (const r of view.rows) {
    const pad = `padding-left:${8 + r.depth * 14}px`;
    if (r.kind === 'header') { rows += `<tr class="hdr"><td class="lbl" style="${pad}" colspan="${span}">${esc(r.label)}</td></tr>`; continue; }
    if (r.kind === 'table') {
      const tst = ['CY', 'PY'].map((s) => [s, S.tableStatus(r.tableId, s)]);
      const t = A.table(r.tableId);
      const cnt = (s) => tableSlices(A, S.filing, r.tableId, s, reportingYear).length;
      rows += `<tr><td colspan="${span}" style="${pad}"><div class="tcard"><div class="t"><b>${esc(r.label)}</b><span>${esc(t.hypercube)} · ${t.axes.length ? t.axes.map((a) => esc(A.label(a.axis)) + (a.typed ? ' (typed)' : '')).join(' × ') : 'no axes (totals)'} · ${t.lineItems.length} line items</span>
        ${tst.some(([, x]) => !x.applicable) ? `<div class="reasons">${tst.filter(([, x]) => !x.applicable).map(([s, x]) => `${s}: ${esc(x.reasons.join('; '))}`).join('<br>')}</div>` : ''}</div>
        <div class="scopes">${tst.map(([s, x]) => `<button class="btn small ${x.applicable ? (x.mandatory ? 'primary' : '') : ''}" data-open-table="${esc(r.tableId)}" data-scope="${s}" data-cell="table:${esc(r.tableId)}:${s}" ${x.applicable ? '' : 'disabled'} title="${esc(x.reasons.join('\n'))}">${s === 'CY' ? 'Current' : 'Previous'}${t.axes.length ? ` · ${cnt(s)} rows` : ''}${x.mandatory ? ' · required' : ''}</button>`).join('')}</div></div></td></tr>`;
      continue;
    }
    const cells = scopes.map((s) => {
      // the opening balance sheet holds balances only (instant elements, not their opening-label rows)
      if (s === 'PYO' && (A.concept(r.concept).periodType !== 'instant' || r.preferredLabel === 'periodStartLabel')) return '<td class="val"><span class="muted" title="The opening balance sheet of the previous year holds balances (instant elements) only">—</span></td>';
      // one applicability decision for this tab's cell (cash-flow method, PY exclusions, Yes/No dependencies)
      const cs = S.cellStatus(uri, r.concept, s);
      const dis = !cs.applicable || (s !== 'CY' && S.filing.meta.firstFinancialYear) || (readonly && readonly.has(r.concept));
      const fact = cs.applicable ? S.getValue(r.concept, s, [], r.preferredLabel) : null; // never show a value in a non-applicable cell
      const p = S.periodForCell(r.concept, s, r.preferredLabel);
      const calc = !dis && A.isNumeric(r.concept) && S.calculatedCell(r.concept, s, [], uri);
      const reasons = !cs.applicable ? cs.reasons.join('\n') : readonly && readonly.has(r.concept) ? 'Set in the company information form above' : '';
      return `<td class="val">${inputFor(r.concept, fact, `data-c="${esc(r.concept)}" data-s="${s}" data-pl="${esc(r.preferredLabel || '')}" data-tab="${esc(uri)}"`, dis, reasons, { id: p ? factKey(r.concept, p, []) : null, calculated: !!calc, locked: !!calc && !state.calcOverride[uri], required: !!reqFor(r.concept, s) })}</td>`;
    }).join('');
    rows += `<tr><td class="lbl" style="${pad}">${esc(r.label)} ${reqBadge(r.concept, scopes.filter((sc) => sc !== 'PYO' || (A.concept(r.concept).periodType === 'instant' && r.preferredLabel !== 'periodStartLabel')))}<span class="el">${esc(r.concept)}</span></td><td class="typ">${esc(typeTag(r.concept))}${r.preferredLabel === 'periodStartLabel' ? ' · opening' : ''}</td>${cells}</tr>`;
  }
  const P = S.filing.meta.periods;
  const head = { CY: `Current ${esc(P.cy.end)}`, PY: `Previous ${esc(P.py.end)}`, PYO: `<span title="Opening balance sheet of the previous year (first-time adoption of Ind AS)">Opening ${esc(pyoDate())}</span>` };
  return `${REQ_LEGEND}<div class="grid-wrap"><table class="g${scopes.length > 2 ? ' g3' : ''}"><thead><tr><th>Element</th><th>Type</th>${scopes.map((s) => `<th>${head[s]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function viewElr(uri) {
  const e = A.elr(uri);
  state.lastTab = uri;
  const st = Object.fromEntries(['CY', 'PY'].map((s) => [s, S.elrStatus(uri, s)]));
  const off = !st.CY.applicable;
  return `<div class="sheet${off ? ' tab-off' : ''}"><header><h1><span class="code">[${esc(e.code)}]</span>${esc(e.title)}</h1>
    ${['CY', 'PY'].map((s) => st[s].applicable ? '' : `<span class="chip warn" title="${esc(st[s].reasons.join('\n'))}">${s} not applicable</span>`).join('')}
    ${off ? '' : tabTools(uri, uri)}</header>
    ${off ? `<div class="banner warn">This statement is not part of this filing: ${esc(st.CY.reasons.join('; '))}. Its cells are unavailable and generate no facts.</div>` : ''}
    ${!off && scopesForElr(uri).includes('PYO') ? `<div class="banner info">First-time adoption of Ind AS: enter the <b>opening balance sheet of the previous year</b> (balances as at ${esc(pyoDate())}) in the third column — generic rule GR-16 / Filing Manual Annexure II #21. Totals are auto-calculated in every column.</div>` : ''}
    ${elrGrid(uri)}</div>`;
}

function slicesFor(tableId, scope) {
  const existing = tableSlices(A, S.filing, tableId, scope, reportingYear);
  const pend = (state.pending[tableId + scope] || []).filter((p) => !existing.some((e) => dimKey(e) === dimKey(p)));
  return [...existing, ...pend];
}

function viewTable(tableId, scope) {
  const st = S.tableStatus(tableId, scope);
  let opened;
  try { opened = S.openTable(tableId, scope); } catch (e) {
    return `<div class="sheet"><div class="banner bad"><b>This table is not available for ${scope === 'CY' ? 'the current' : 'the previous'} year.</b><br>${esc((e.reasons || [e.message]).join('; '))}</div><button class="btn" data-elr="${esc(A.table(tableId).presentationElr)}">Back to note</button></div>`;
  }
  const v = opened.view;
  state.lastTab = v.presentationElr;
  const P = S.filing.meta.periods;
  const other = scope === 'CY' ? 'PY' : 'CY';
  const otherOk = S.tableStatus(tableId, other).applicable;
  let carry = null;
  if (scope === 'CY') { try { const cf = carryForwardPlan(S, tableId); if (cf.available && (cf.newColumns.length || cf.values)) carry = cf; } catch { carry = null; } }
  const carryBtn = carry ? `<button class="btn small" data-act="carry-forward" data-t="${esc(tableId)}" title="Adds the previous-year columns this table does not have yet and copies their values into empty cells. Nothing you entered is overwritten.">Copy from previous year (${carry.newColumns.length} column(s), ${carry.values} value(s))</button>` : '';
  const head = `<header><h1><span class="code">[${esc(v.code)}]</span>${esc(v.title)}</h1>
    <span class="chip info">${scope === 'CY' ? `Current · ${esc(P.cy.end)}` : `Previous · ${esc(P.py.end)}`}</span>
    ${st.mandatory ? '<span class="chip warn">required</span>' : ''}
    <button class="btn small" data-open-table="${esc(tableId)}" data-scope="${other}" ${otherOk ? '' : 'disabled'}>Switch to ${other === 'CY' ? 'current' : 'previous'} year</button>
    <button class="btn small" data-elr="${esc(v.presentationElr)}">Back to note</button>${carryBtn}${tabTools(tableId, v.presentationElr)}</header>
    <p class="note">${esc(v.hypercube)} · ${v.closed ? 'closed' : 'open'} hypercube · ELR ${esc(A.json.roles[v.elr]?.definition || v.elr)}${v.notAll.length ? ` · ${v.notAll.length} notAll exclusions applied` : ''}</p>`;
  if (!v.axes.length) {
    const rows = v.lineItems.filter((l) => !l.abstract).map((l) => {
      const cs = S.cellStatus(v.presentationElr, l.concept, scope);
      const fact = cs.applicable ? S.getValue(l.concept, scope, [], l.preferredLabel) : null;
      const p = S.periodForCell(l.concept, scope, l.preferredLabel);
      const calc = cs.applicable && A.isNumeric(l.concept) && S.calculatedCell(l.concept, scope, [], v.presentationElr);
      return `<tr><td class="lbl">${esc(l.label)} ${reqBadge(l.concept, [scope])}<span class="el">${esc(l.concept)}</span></td><td class="typ">${esc(typeTag(l.concept))}</td><td class="val">${inputFor(l.concept, fact, `data-c="${esc(l.concept)}" data-s="${scope}" data-pl="${esc(l.preferredLabel || '')}" data-tab="${esc(v.presentationElr)}" data-tabkey="${esc(tableId)}"`, !cs.applicable, cs.reasons.join('\n'), { id: p ? factKey(l.concept, p, []) : null, calculated: !!calc, locked: !!calc && !state.calcOverride[tableId], required: !!reqFor(l.concept, scope) })}</td></tr>`;
    }).join('');
    return `<div class="sheet">${head}<p class="note">This table has no axes: its line items are reported without dimensions.</p>${REQ_LEGEND}<div class="grid-wrap"><table class="g"><tbody>${rows}</tbody></table></div></div>`;
  }
  // add-row form
  const pickers = v.axes.map((ax, i) => {
    if (ax.typed) return `<label>${esc(ax.label)} <span class="el">typed · ${esc(ax.typedDomain)}</span><input id="ax-${i}" data-axis="${esc(ax.axis)}" value="${esc(S.suggestTypedValue(tableId, scope, ax.axis))}"></label>`;
    const tax = A.table(tableId).axes.find((a) => a.axis === ax.axis);
    const opts = ax.members.filter((m) => m.usable && !m.isDefault).map((m) => {
      const mi = memberInfo(A, tax, m.member);
      return `<option value="${esc(m.member)}" title="${esc(memberTitle(mi))}">${'  '.repeat(Math.max(0, m.depth))}${esc(m.label)}${mi.isTotal ? ' — total' : ''}</option>`;
    }).join('');
    return `<label>${esc(ax.label)}<select id="ax-${i}" data-axis="${esc(ax.axis)}" data-axhelp="${i}">${ax.default ? `<option value="" title="${esc(memberTitle(memberInfo(A, tax, ax.default)))}">(default: ${esc(A.label(ax.default))} — total)</option>` : ''}${opts}</select><span class="axhelp" id="axhelp-${i}" aria-live="polite">${esc(axisHelp(tax, ax.default || ''))}</span></label>`;
  }).join('');
  const raw = slicesFor(tableId, scope);
  const slices = state.colOrder === 'entered' ? raw : sortSlices(A, tableId, raw);
  state.slices = slices;
  const needs = missingParents(A, tableId, slices);
  const taxAxes = A.table(tableId).axes;
  const sliceHead = slices.map((dims, si) => `<th class="slicehead">${v.axes.map((ax) => {
    const d = dims.find((x) => x.axis === ax.axis);
    if (ax.typed) return `<input data-rename="${si}" data-axis="${esc(ax.axis)}" value="${esc(d?.typed ?? '')}" title="Typed member — edit to rename">`;
    const mem = d ? d.member : ax.default;
    const mi = mem ? memberInfo(A, taxAxes.find((a) => a.axis === ax.axis), mem) : null;
    const badge = !mi ? '' : mi.isTotal ? `<span class="mb total" title="${esc(memberTitle(mi))}">TOTAL</span>` : mi.parent ? `<span class="mb part" title="${esc(memberTitle(mi))}">part of ${esc(shortLabel(mi.parent))}</span>` : '';
    return `<span class="m">${esc(d ? A.label(d.member) : ax.default ? A.label(ax.default) + ' (default)' : '—')}${badge}</span>`;
  }).join('')}${needs.filter((n) => n.slice === si).map((n) => `<span class="needs-parent" title="Filing Manual Annexure II #14 (FM-14): the parent member must be reported when a child member has a value">Needs ${esc(n.parents.map((p) => shortLabel(p.member)).join(' › '))} column (FM-14) <button type="button" class="btn small" data-act="add-parents" data-slice="${si}" data-axis="${esc(n.axis)}">Add</button></span>`).join('')}${dims.length ? `<button class="btn small danger" data-remove-slice="${si}" title="Remove this row and its values">Remove</button>` : '<span class="chip info" title="Every axis at its default member: the table total, reported without dimensions (shared with the statements)">total</span>'}</th>`).join('');
  const body = v.lineItems.map((l) => {
    const pad = `padding-left:${8 + l.depth * 12}px`;
    if (l.abstract) return `<tr class="hdr"><td class="lbl" style="${pad}" colspan="${slices.length + 2}">${esc(l.label)}</td></tr>`;
    return `<tr><td class="lbl" style="${pad}">${esc(l.label)} ${reqTableBadge(tableId, l.concept, scope)}<span class="el">${esc(l.concept)}</span></td><td class="typ">${esc(typeTag(l.concept))}</td>${slices.map((dims, si) => {
      const dv = dimensionallyValid(A, l.concept, dims);
      const cs = S.conceptStatus(l.concept, scope);
      const ok = dv.valid && cs.applicable;
      const fact = ok ? S.getValue(l.concept, scope, dims, l.preferredLabel) : null;
      const p = S.periodForCell(l.concept, scope, l.preferredLabel);
      const calc = ok && A.isNumeric(l.concept) && S.calculatedCell(l.concept, scope, dims, v.presentationElr);
      const sumSlot = ok && (A.dataType(l.concept) === 'monetary' || A.dataType(l.concept) === 'shares') && p ? `<div class="sum-hint" data-sumfor="${esc(factKey(l.concept, p, normDimsUI(dims)))}"></div>` : '';
      return `<td class="val">${inputFor(l.concept, fact, `data-c="${esc(l.concept)}" data-s="${scope}" data-slice="${si}" data-t="${esc(tableId)}" data-pl="${esc(l.preferredLabel || '')}" data-tabkey="${esc(tableId)}"`, !ok, !dv.valid ? 'Not valid for this member combination: ' + dv.reason : cs.reasons.join('\n'), { id: p ? factKey(l.concept, p, normDimsUI(dims)) : null, calculated: !!calc, locked: !!calc && !state.calcOverride[tableId], required: ok && reqCellTable(tableId, l.concept, dims) })}${sumSlot}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<div class="sheet">${head}
    <form class="axes" id="addslice" data-t="${esc(tableId)}" data-s="${scope}">${pickers}<div class="go"><button class="btn primary" type="submit">Add row</button></div></form>
    ${slices.length ? `<div class="colbar"><label>Column order <select id="colorder"><option value="taxonomy" ${state.colOrder === 'entered' ? '' : 'selected'}>Taxonomy (each total before its parts)</option><option value="entered" ${state.colOrder === 'entered' ? 'selected' : ''}>As entered</option></select></label><span class="note"><span class="mb total">TOTAL</span> = total of the members below it in the taxonomy · <span class="mb part">part of …</span> = included in that total. You enter totals yourself; the line under a total compares it with its part columns (tool guidance, not an MCA rule).</span></div>` : ''}
    ${REQ_LEGEND}${slices.length ? `<div class="grid-wrap"><table class="g"><thead><tr><th>Line item</th><th>Type</th>${sliceHead}</tr></thead><tbody>${body}</tbody></table></div>` : '<p class="note">No rows yet. Choose the axis members above and add a row; then fill its line items.</p>'}</div>`;
}

function viewValidate() {
  const g = state.gate;
  if (!g) return `<div class="sheet"><header><h1>Validation</h1></header><p class="note">Runs the internal gate: XBRL structure, contexts, units, decimals, dimensions and hypercubes, calculations, and every executable MCA business rule. It does not replace the official ${VALIDATOR}.</p><button class="btn primary" data-act="validate">Run validation</button></div>`;
  const f = state.issueFilter;
  const list = g.issues.filter((i) => f === 'ALL' || i.severity === f);
  state.issueList = list;
  const tabMode = g.scope?.kind === 'tab';
  const locText = (l) => !l ? '' : l.kind === 'general' ? GENERAL_LABEL : `[${esc(l.tabId || '?')}]${l.tableId ? ' ' + esc(A.label(A.table(l.tableId).hypercube)) : ''} · ${esc(l.scope || '')}${l.conceptQName ? ' · ' + esc(A.label(l.conceptQName)) : ''}`;
  const calc = g.calculations || [];
  const cc = (s) => calc.filter((c) => c.status === s).length;
  return `<div class="sheet"><header><h1>Validation${tabMode ? ` <span class="code">· current tab [${esc(g.scope.code)}]</span>` : ''}</h1><button class="btn" data-act="validate">Validate entire filing</button>${state.lastTab ? `<button class="btn" data-act="validate-tab" data-tab="${esc(state.lastTab)}">Validate current tab [${esc(A.elr(state.lastTab)?.code)}]</button>` : ''}</header>
    ${tabMode ? `<div class="banner info">Scope: only tab [${esc(g.scope.code)}] ${esc(A.elr(g.scope.elrUri)?.title || '')} — its facts and the ${g.scope.rulesRun} business rules that involve its elements, run by the same rule engine as the full validation. Checks marked <span class="chip warn">cross-tab</span> also read elements of other tabs. XML generation always validates the entire filing.</div>` : ''}
    <div class="banner ${g.ok ? 'info' : 'bad'}">${g.ok ? `Internal gate passed — XML can be generated. Official status remains <b>not validated</b> until the instance passes the ${VALIDATOR}.` : `Internal gate blocked: ${g.summary.errors} error(s) must be fixed before XML can be generated.`}</div>
    <div class="tiles"><div class="tile ${g.summary.errors ? 'bad' : 'ok'}"><b>${g.summary.errors}</b><span>errors</span></div><div class="tile ${g.summary.warnings ? 'warn' : ''}"><b>${g.summary.warnings}</b><span>warnings</span></div><div class="tile"><b>${g.summary.info}</b><span>manual review</span></div><div class="tile"><b>${g.summary.facts}</b><span>facts to generate</span></div><div class="tile ${g.summary.excluded ? 'warn' : ''}"><b>${g.summary.excluded}</b><span>excluded (not applicable)</span></div><div class="tile"><b>${cc('PASS')}/${cc('PASS') + cc('FAIL')}</b><span>calculations consistent</span></div></div>
    <div class="filters">${['ERROR', 'WARNING', 'INFO', 'ALL'].map((x) => `<button class="btn small ${x === f ? 'on' : ''}" data-filter="${x}">${x.toLowerCase()} (${x === 'ALL' ? g.issues.length : g.issues.filter((i) => i.severity === x).length})</button>`).join('')}</div>
    <ul class="issues">${list.slice(0, 600).map((i, n) => `<li class="${i.location ? 'nav-issue' : ''}" ${i.location ? `data-issue="${n}" tabindex="0" role="link" title="Go to the cell"` : ''}><span class="chip ${i.severity === 'ERROR' ? 'bad' : i.severity === 'WARNING' ? 'warn' : 'info'}">${i.severity}</span><span class="msg">${esc(i.message)}${i.crossTab ? ' <span class="chip warn">cross-tab</span>' : ''}${i.location ? ` <span class="reasons">→ ${locText(i.location)}</span>` : i.scope ? ` <span class="reasons">· ${i.scope}</span>` : ''}</span></li>`).join('') || '<li><span></span><span class="msg">Nothing in this category.</span></li>'}</ul>
    ${list.length > 600 ? `<p class="note">Showing 600 of ${list.length}.</p>` : ''}
    ${totalsSection(tabMode ? g.scope.elrUri : null)}</div>`;
}
// Totals hints (member-hints.js): separate from the gate's errors/warnings and not part of its result
function totalsSection(tabElr = null) {
  let hints = [];
  try { hints = allTotalsHints(S); } catch { hints = []; }
  if (tabElr) hints = hints.filter((h) => { const t = A.table(h.tableId); return t.presentationElr === tabElr || t.elr === tabElr; });
  state.hintList = hints;
  return `<h2>Totals hints${tabElr ? ' (this tab)' : ''} <span class="chip info">tool guidance, not an MCA rule</span></h2>
    <p class="note">Total columns whose value differs from the sum of their part columns, on the axes that the MCA business rules add up (e.g. classes of property, plant and equipment, classification of borrowings). They do not block XML generation.</p>
    <ul class="issues">${hints.slice(0, 300).map((h, n) => `<li class="nav-issue" data-hint="${n}" tabindex="0" role="link" title="Go to the total cell"><span class="chip warn">TOTAL</span><span class="msg">${esc(A.label(h.concept))} — ${esc(colName(h.parentDims, h.tableId))}: ${esc(fmtAmt(h.concept, h.parentValue))}, parts ${esc(fmtAmt(h.concept, h.childrenSum))} (differs by ${esc(fmtAmt(h.concept, h.difference))}) <span class="reasons">→ [${esc(A.table(h.tableId).code || A.elr(A.table(h.tableId).presentationElr)?.code || '')}] ${esc(A.label(A.table(h.tableId).hypercube))} · ${esc(h.scope)}</span></span></li>`).join('') || '<li><span></span><span class="msg">No differences: every total column equals the sum of its part columns.</span></li>'}</ul>`;
}

// Mismatch panel: every difference between an auto-calculated value and what is reported — calculation-linkbase
// inconsistencies (GR-1), formula-linkbase roll-forwards (FX-*) and the log of manual overrides of calculated cells,
// each with jump-to-cell. Computed from the last full validation (run here if needed).
function mismatchItems() {
  const g = state.gate;
  if (!g || g.scope?.kind === 'tab') return null;
  const items = [];
  for (const i of g.issues) if ((i.ruleId === 'GR-1' || i.ruleId?.startsWith('FX-')) && i.severity !== 'INFO') items.push({ kind: i.ruleId === 'GR-1' ? 'calculation' : 'roll-forward', severity: i.severity, message: i.message, location: i.location });
  const gate = new Gate(A);
  const calcByKey = new Map((g.calculations || []).map((c) => [c.factKey, c]));
  for (const f of S.filing.all().filter((x) => x.origin === 'override')) {
    const c = calcByKey.get(f.key);
    const diff = c && c.computed != null ? `entered ${f.value}, children give ${c.computed}` : `entered ${f.value}`;
    items.push({ kind: 'override', severity: c && c.status === 'FAIL' ? 'WARNING' : 'INFO', message: `Manual override of a calculated cell: ${A.label(f.concept)}${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''} — ${diff}`, location: gate.locate(S.filing, { factKey: f.key }) });
  }
  return items;
}
function mismatchCount() { const m = mismatchItems(); return m ? m.filter((x) => x.kind !== 'override' || x.severity !== 'INFO').length : 0; }
function viewMismatch() {
  if (!state.gate || state.gate.scope?.kind === 'tab') state.gate = S.validate();
  const items = mismatchItems();
  state.issueList = items;
  const n = (k) => items.filter((x) => x.kind === k).length;
  const locText = (l) => !l ? '' : `[${esc(l.tabId || '?')}]${l.tableId ? ' ' + esc(A.label(A.table(l.tableId).hypercube)) : ''} · ${esc(l.scope || '')}`;
  return `<div class="sheet"><header><h1>Mismatches</h1><button class="btn" data-act="mismatch-refresh">Recheck</button></header>
    <p class="note">Differences between auto-calculated values and reported values: taxonomy calculations (parent = Σ children, GR-1), formula-linkbase roll-forwards (closing = opening + changes, FX-*), and every manual override of a calculated cell. Nothing here is invented: only the taxonomy's calculation and formula links are used.</p>
    <div class="tiles"><div class="tile ${n('calculation') ? 'bad' : 'ok'}"><b>${n('calculation')}</b><span>calculation differences</span></div><div class="tile ${n('roll-forward') ? 'bad' : 'ok'}"><b>${n('roll-forward')}</b><span>roll-forward differences</span></div><div class="tile ${n('override') ? 'warn' : ''}"><b>${n('override')}</b><span>manual overrides (log)</span></div></div>
    <ul class="issues">${items.map((i, k) => `<li class="${i.location ? 'nav-issue' : ''}" ${i.location ? `data-issue="${k}" tabindex="0" role="link" title="Go to the cell"` : ''}><span class="chip ${i.severity === 'ERROR' ? 'bad' : i.severity === 'WARNING' ? 'warn' : 'info'}">${esc(i.kind)}</span><span class="msg">${esc(i.message)}${i.location ? ` <span class="reasons">→ ${locText(i.location)}</span>` : ''}</span></li>`).join('') || '<li><span class="chip ok">ok</span><span class="msg">No mismatches: every calculated total and roll-forward agrees with the reported values.</span></li>'}</ul></div>`;
}

function viewXml() {
  const g = state.gate;
  return `<div class="sheet"><header><h1>Generate XML</h1><button class="btn primary" data-act="generate">Validate and generate</button>
    ${state.xml ? '<button class="btn" data-act="download-xml">Download .xml</button><button class="btn" data-act="copy-xml">Copy XML</button>' : ''}</header>
    <p class="note">Tool build <b>${esc(BUILD_ID)}</b> — written into the generated XML as <code>&lt;!-- Generated by Ind AS XBRL Studio build … --&gt;</code>. If an XML shows a different build, your browser used a cached page: press Ctrl+F5 and generate again.</p>
    <p class="note">Generation always runs the internal gate first and is blocked on any error. Status after a successful run: <b>internally validated</b>. Mark nothing as filed or certified until the file passes the official ${VALIDATOR} and pre-scrutiny.</p>
    ${g && !g.ok ? `<div class="banner bad">Blocked by ${g.summary.errors} error(s). <button class="btn small" data-go="validate">Open validation</button></div>` : ''}
    ${state.xml ? `<pre class="xml" id="xmltext">${esc(state.xml)}</pre>` : ''}</div>`;
}

const nf = (n) => Number(n).toLocaleString('en-IN');
function viewImportConfirm() {
  const p = state.pendingImport;
  if (!p) return viewImport();
  const b = p.preview.byYear, per = p.preview.periods;
  const opt = (val, title, desc) => `<label class="choice${p.mode === val ? ' on' : ''}"><input type="radio" name="yearMode" id="ym-${val}" value="${val}" ${p.mode === val ? 'checked' : ''}><span><b>${title}</b><span class="note">${desc}</span></span></label>`;
  return `<div class="sheet"><header><h1>Import XML</h1><span class="note">${esc(p.name)}</span></header>
    <p class="note">Periods found from the instance dates: current ${esc(per.cy.start)} → ${esc(per.cy.end)}, previous ${esc(per.py.start || '—')} → ${esc(per.py.end || '—')} (${esc(per.method)}).</p>
    <div class="tiles"><div class="tile"><b>${nf(b.current)}</b><span>current-year facts</span></div><div class="tile"><b>${nf(b.previous)}</b><span>previous-year facts</span></div><div class="tile"><b>${nf(b.previousOpening)}</b><span>previous-year opening balances</span></div>${p.preview.unresolved ? `<div class="tile bad"><b>${nf(p.preview.unresolved)}</b><span>unresolved</span></div>` : ''}</div>
    ${(() => {
      const cf = p.preview.cashFlow;
      if (!cf || (!cf.directFacts && !cf.indirectFacts && !cf.declared)) return '';
      if (cf.needsChoice) return `<h2>Cash flow statement method</h2><div class="banner warn">The XML does not report <code>TypeOfCashFlowStatement</code> and contains facts of both statements (${cf.directFacts} direct-only, ${cf.indirectFacts} indirect-only). Choose the method: only that statement will receive data.</div>
        <div class="choices row">${['Direct Method', 'Indirect Method'].map((m) => `<label class="choice inline${p.cashFlowMethod === m ? ' on' : ''}"><input type="radio" name="cfImport" id="cfi-${m.startsWith('Direct') ? 'direct' : 'indirect'}" value="${m}" ${p.cashFlowMethod === m ? 'checked' : ''}><span><b>${m}</b></span></label>`).join('')}</div>`;
      return `<p class="note">Cash flow statement: <b>${esc(cf.declared || cf.detected)}</b> (${cf.declared ? 'reported in the XML' : 'detected from the reported facts'}) — only [${CF_CODES[cf.declared || cf.detected] || '?'}] receives data.</p>`;
    })()}
    ${p.preview.notApplicable ? `<p class="note">${nf(p.preview.notApplicable)} fact(s) in the XML belong to cells that are not applicable to this filing (for example a previous-year column excluded by GR-12, or a field that depends on a "No" answer). They are listed in the import report and are not imported as filing data.</p>` : ''}
    <h2>Import historical data</h2>
    <form id="import-confirm" class="choices">
      ${opt('both', 'Both years', 'Import the current-year and previous-year data from this XML into the current-year and previous-year columns.')}
      ${opt('current', 'Current year only', 'Import only the current reporting-year data, including its opening balances: ' + nf(b.cyOpeningAtPyEnd || 0) + ' fact(s) at ' + esc(per.py.end || 'the previous year end') + ' of items reported with opening and closing balances (share capital, reserves, fixed assets, cash, ...). MCA generic rule GR-7: the current-year opening balance and the previous-year closing balance are one common element, so these values also show as the previous-year closing of those items. All other previous-year data is not imported and the previous-year comparative column stays empty.')}
      ${p.preview.rollForward ? opt('rollforward', 'Roll forward to the next year', `This XML is <b>last year's filing</b>. It becomes the previous year of a new filing for ${esc(p.preview.rollForward.newCurrent.start)} → ${esc(p.preview.rollForward.newCurrent.end)}: its current-year figures fill the previous-year column, its previous-year closing balances become the previous-year opening balances (so roll-forwards such as share capital, equity and cash continue), and company identity is carried into the new current year. Every other current-year cell starts empty. Nothing is shifted: the source dates already are the new previous year.`) : ''}
      <div class="go"><button class="btn primary" type="submit" id="import-commit" ${p.mode && (!p.preview.cashFlow?.needsChoice || p.cashFlowMethod) ? '' : 'disabled'}>Import</button><button class="btn" type="button" data-act="cancel-import">Cancel</button></div>
    </form></div>`;
}

function viewImport() {
  const r = S.filing.importReport;
  if (!r) return '<div class="sheet"><header><h1>Import report</h1></header><p class="note">No instance imported yet. Use <b>Import XML</b> in the top bar.</p></div>';
  const sec = (t, arr, fmt) => `<h2>${t} (${arr.length})</h2>${arr.length ? `<ul class="issues">${arr.slice(0, 300).map((x) => `<li><span class="chip">·</span><span class="msg">${fmt(x)}</span></li>`).join('')}</ul>` : '<p class="note">None.</p>'}`;
  return `<div class="sheet"><header><h1>Import report</h1><span class="note">${esc(r.fileName)}</span></header>
    <div class="banner info">Import mode: <b>${{ current: 'Current year only', rollforward: 'Roll forward to the next year', both: 'Both years' }[r.yearMode] || 'Both years'}</b>${r.rollForward ? `<br>New filing: current year ${esc(r.rollForward.newCurrent.start)} → ${esc(r.rollForward.newCurrent.end)}; previous year ${esc(r.rollForward.newPrevious.start)} → ${esc(r.rollForward.newPrevious.end)} (= source current year). Carried identity elements: ${nf(r.rollForward.carriedIdentity.length)}. Source previous-year durations not used: ${nf(r.rollForward.skippedPreviousDurations)}; source previous-year opening balances not used: ${nf(r.rollForward.skippedPreviousOpening)}.` : ''}${r.cashFlow?.applied ? `<br>Cash flow statement: ${esc(r.cashFlow.applied)}${r.cashFlow.source ? ' (' + esc(r.cashFlow.source) + ')' : ''}` : ''}${r.notApplicable?.length ? `<br>Not applicable, not imported: ${nf(r.notApplicable.length)} facts (${nf(r.byYear?.notApplicablePrevious ?? 0)} previous year)` : ''}<br>Current year imported: ${nf(r.byYear?.current ?? 0)} facts<br>${r.yearMode === 'current' ? `Previous year: not imported (Current year only selected) — ${nf((r.byYear?.skippedPrevious ?? 0) + (r.byYear?.skippedPreviousOpening ?? 0))} previous-year facts skipped<br>Current-year opening balances imported (GR-7, = previous-year closing): ${nf(r.byYear?.carriedOpening ?? 0)} facts` : `Previous year imported: ${nf((r.byYear?.previous ?? 0) + (r.byYear?.previousOpening ?? 0))} facts`}</div>
    <div class="tiles"><div class="tile"><b>${r.counts.sourceFacts}</b><span>source facts</span></div><div class="tile ok"><b>${r.counts.imported}</b><span>mapped</span></div><div class="tile ${r.counts.unresolved ? 'bad' : ''}"><b>${r.counts.unresolved}</b><span>unresolved</span></div><div class="tile"><b>${r.contexts.length}</b><span>source contexts</span></div><div class="tile"><b>${r.counts.footnotes}</b><span>footnotes</span></div></div>
    <p class="note">Periods detected from ${esc(r.periodDetection?.method)}: current ${esc(r.periodDetection?.cy.start)} → ${esc(r.periodDetection?.cy.end)}, previous ${esc(r.periodDetection?.py.start || '—')} → ${esc(r.periodDetection?.py.end || '—')}. schemaRef ${r.schemaRefMatches ? 'matches the prescribed URL' : 'differs: ' + esc(r.schemaRef)}.</p>
    ${sec('Errors', r.errors, esc)}${sec('Warnings', r.warnings, esc)}
    ${sec('Unresolved facts', r.unresolvedFacts, (u) => `${esc(u.element)} · context ${esc(u.contextRef)} · value “${esc(String(u.value).slice(0, 80))}” — ${esc(u.reason)}`)}
    ${sec('Not applicable — not imported as filing data', r.notApplicable || [], (x) => `${esc(x.concept)}${x.dims?.length ? ' [' + esc(dimKey(x.dims)) + ']' : ''} · ${esc(x.scope)} · value “${esc(String(x.value ?? '').slice(0, 60))}” — ${esc(x.reasons.join('; '))}`)}
    ${sec('Inconsistent duplicates', r.conflicts, (c) => `${esc(c.concept)} in ${esc(c.contextRef)}: kept ${esc(c.kept)}, dropped ${esc(c.dropped)}`)}
    ${sec('Context map (source → internal)', r.contexts, (c) => `${esc(c.sourceContextId)} → ${esc(c.internalContextKey)}${c.issues.length ? ' — ' + esc(c.issues.join('; ')) : ''}`)}</div>`;
}

// MCA Validator error help: paste the validator's error list; each message is explained (mca-errors.js) and linked
// to the element in this filing. Identical messages are grouped.
function viewMcaErrors() {
  const items = state.mcaErrors?.items || [];
  const groups = new Map();
  for (const x of items) { const k = `${x.code}|${x.title}|${x.cause}|${x.raw.replace(/'[^']*'/g, "''").slice(0, 90)}`; (groups.get(k) || groups.set(k, []).get(k)).push(x); }
  const go2 = (x) => (x.concept ? `<button type="button" class="btn small" data-goconcept="${esc(x.concept)}" title="${esc(x.concept)}">${esc(x.label || x.concept)}</button>` : x.element ? `<code>${esc(x.element)}</code>` : '');
  const one = (g) => {
    const x = g[0];
    const details = x.details.length ? `<ul class="mx-details">${x.details.map((d) => `<li><b>${esc(d.title)}</b> — ${esc(d.meaning)} <span class="muted">${esc(d.cause)}</span></li>`).join('')}</ul>` : '';
    return `<div class="mx"><div class="mx-h"><span class="chip ${x.code === 'unknown' ? 'warn' : 'bad'}">${esc(x.code)}</span> <b>${esc(x.title)}</b>${g.length > 1 ? ` <span class="chip info">${g.length}×</span>` : ''}</div>
      <p>${esc(x.meaning)}${g.length > 1 ? ' (and the same for the other elements below)' : ''}</p>${details}
      <p><b>Likely cause:</b> ${esc(x.cause)}</p><p><b>Fix:</b> ${esc(x.fix)}</p>
      ${g.some((y) => y.concept || y.element) ? `<div class="mx-els">${g.map(go2).join(' ')}</div>` : ''}
      <details><summary>Original message${g.length > 1 ? 's' : ''}</summary><pre class="mx-raw">${g.map((y) => esc((y.n ? y.n + ') ' : '') + y.raw)).join('\n')}</pre></details></div>`;
  };
  return `<div class="sheet"><header><h1>MCA Validator error help</h1></header>
    <p class="note">Paste the error list from the MCA XBRL Validator (or its error file). Each message is explained in plain language with the likely cause and the fix in this tool; element names link to the cell. This is an aid for reading the messages — it does not validate the instance. Tool build <b>${esc(BUILD_ID)}</b>.</p>
    <textarea id="mx-text" rows="8" spellcheck="false" placeholder="1) cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:PANOfShareholder'.">${esc(state.mcaErrors?.text || '')}</textarea>
    <p><button type="button" class="btn primary" data-act="explainErrors" id="mx-run">Explain</button></p>
    ${items.length ? `<p class="note">${items.length} message(s) in ${groups.size} group(s).</p>${[...groups.values()].map(one).join('')}` : ''}
    <details class="mx-guide"><summary>How to read MCA Validator messages yourself</summary>
      <ol>
        <li><b>The code says what kind of rule failed.</b> <code>cvc-…</code> codes are standard W3C XML Schema checks (the validator uses Xerces): <code>3.2.2</code> attribute not allowed, <code>2.4.a</code> element in the wrong place, <code>2.4.b</code> element incomplete, <code>pattern/enumeration/length-valid</code> wrong value format, <code>datatype-valid</code> wrong data type, <code>type.3.1.3</code> names the element whose value failed, <code>elt.1</code> schema/namespace not found. Messages without a cvc code come from MCA business rules or the HTML/PDF checks.</li>
        <li><b>The quoted names say where.</b> <code>ind-as:…</code>/<code>in-ca:…</code> are taxonomy elements (use the buttons above or search the label in this tool). Plain tag names (<code>td</code>, <code>colgroup</code>) are HTML inside a text block — the message starts with <i>"the contained HTML has the following errors"</i>.</li>
        <li><b>Find it in the XML.</b> Open the generated XML in a text editor and search for the element name; text blocks show their HTML escaped (<code>&amp;lt;td colspan=…</code>).</li>
        <li><b>Check the build.</b> The first comment of every generated XML names the tool build. If it differs from the build in the header, the page was cached: press Ctrl+F5 (Cmd+Shift+R), re-open the project and generate again.</li>
        <li><b>Compare with the internal gate.</b> Validation in this tool reports HTML that the MCA schema rejects (colgroup, col, caption, colspan, rowspan, style) as errors before XML is generated. If the MCA Validator reports something the internal gate did not, it is a gap — keep the error file and the XML for the fix.</li>
        <li><b>Text block HTML.</b> MCA-validated instances use only these tags: div, span, p, br, table, tbody, tr, td (th/thead/tfoot are in the Filing Manual), and only the <code>class</code> attribute. Pasted Word/Excel tables are rebuilt automatically; to repair an older one, open the text block and click Save Text.</li>
        <li><b>Check the PDF.</b> Convert the instance to PDF in the MCA tool and look at every text block: wide tables are cut on the right (keep columns few and cells short), <code>highlightedText</code> classes render as shaded text, <code>bordered</code> draws cell borders.</li>
      </ol>
    </details></div>`;
}

function viewCoverage() {
  const rules = A.rules.rules;
  const by = {};
  for (const r of rules) by[r.status] = (by[r.status] || 0) + 1;
  const runtime = state.gate?.ruleStatus || {};
  const c = A.rules.corpus;
  return `<div class="sheet"><header><h1>Business-rule coverage</h1></header>
    <div class="tiles">${['EXECUTABLE', 'REVIEW_ONLY_EXTERNAL_DATA', 'UNIMPLEMENTED', 'NOT_APPLICABLE'].map((s) => `<div class="tile ${s === 'UNIMPLEMENTED' && by[s] ? 'bad' : ''}"><b>${by[s] || 0}</b><span>${s.toLowerCase().replace(/_/g, ' ')}</span></div>`).join('')}</div>
    ${c.specificRulesSheetTruncated ? `<div class="banner warn"><b>Rule corpus incomplete.</b> ${esc(c.note)}<br><span class="reasons">No specific rules supplied for ${c.elrsWithoutSuppliedSpecificRules.length} ELRs, from ${esc(c.elrsWithoutSuppliedSpecificRules[0] || '')}.</span></div>` : ''}
    <div class="grid-wrap"><table class="g"><thead><tr><th>Rule</th><th>Status</th><th>Run</th><th>Element</th><th>MCA source text</th><th>Implementation</th></tr></thead><tbody>
    ${rules.map((r) => `<tr><td class="typ">${esc(r.id)}</td><td><span class="chip ${r.status === 'EXECUTABLE' ? 'ok' : r.status === 'UNIMPLEMENTED' && !r.approvedLimitation ? 'bad' : r.status !== 'NOT_APPLICABLE' ? 'warn' : ''}">${esc(r.approvedLimitation ? 'APPROVED LIMITATION / NOT EXECUTED' : r.status)}</span></td><td class="typ">${esc(runtime[r.id] || '—')}</td><td class="typ">${esc(r.element || '')}</td><td>${esc(r.text)}${r.reason ? `<div class="reasons">${esc(r.reason)}</div>` : ''}</td><td class="typ">${esc(r.implementation || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// Footnotes (XBRL footnoteLink). A footnote is written to the XML only when at least one cell it is linked to has a
// value, so an unlinked footnote is flagged here instead of silently disappearing from the instance.
function footnoteCount() { try { return listFootnotes(S.filing).length; } catch { return 0; } }
function factLabel(f) {
  const p = f.period || {};
  const when = p.type === 'instant' ? p.date : p.end;
  const dims = (f.dims || []).map((d) => (d.typed != null ? String(d.typed) : shortLabel(d.member || d.axis))).join(', ');
  return `${A.label(f.concept)} · ${when || ''}${dims ? ' · ' + dims : ''}`;
}
function viewFootnotes() {
  const notes = listFootnotes(S.filing);
  const cells = [...S.filing.facts.values()]
    .filter((f) => !f.nil && f.value !== null && f.value !== '' && f.value !== undefined)
    .sort((a, b) => factLabel(a).localeCompare(factLabel(b)));
  const opts = cells.map((f) => {
    const shown = String(S.displayOf(f)).replace(/\s+/g, ' ').slice(0, 40);
    return `<option value="${esc(f.key)}">${esc(factLabel(f))} = ${esc(shown)}</option>`;
  }).join('');
  const cards = notes.map((n, i) => {
    const linked = n.factKeys.map((k) => {
      const f = S.filing.facts.get(k);
      return `<li>${f ? esc(factLabel(f)) : esc(k)} <button type="button" class="btn small" data-act="fn-unlink" data-id="${esc(n.id)}" data-key="${esc(k)}">Unlink</button></li>`;
    }).join('');
    return `<section class="fn" aria-label="Footnote ${i + 1}">
      <label>Footnote ${i + 1} <span class="el">${esc(n.id)}</span><textarea id="fn-text-${esc(n.id)}" rows="3">${esc(n.text)}</textarea></label>
      <div class="fn-row"><button type="button" class="btn small" data-act="fn-save" data-id="${esc(n.id)}">Save text</button>
      <button type="button" class="btn small" data-act="fn-link" data-id="${esc(n.id)}">Link selected cell</button>
      <button type="button" class="btn small danger" data-act="fn-remove" data-id="${esc(n.id)}">Remove footnote</button></div>
      ${linked ? `<ul class="fn-cells">${linked}</ul>` : '<p class="banner warn">Not linked to any cell: this footnote is not written to the XML until a cell is linked.</p>'}
    </section>`;
  }).join('');
  return `<div class="sheet"><header><h1>Footnotes</h1></header>
    <p class="note">A footnote explains one or more cells. Write the text, then choose a cell from the list and link it. Footnotes are written to the XML with the cells they are linked to.</p>
    <div class="fn-add"><label>New footnote<textarea id="fn-new" rows="3"></textarea></label><button type="button" class="btn primary" data-act="fn-add">Add footnote</button></div>
    <label class="fn-pick">Cell to link <select id="fn-cell"><option value="">— choose a cell with a value —</option>${opts}</select></label>
    ${cards || '<p class="note">No footnotes yet.</p>'}
  </div>`;
}

// ------------------------------------------------------------------ events
function wire() {
  document.addEventListener('click', (ev) => {
    const hi = ev.target.closest('[data-hint]');
    if (hi) { const h = state.hintList?.[Number(hi.dataset.hint)]; if (h) navigateTo({ kind: 'cell', tableId: h.tableId, scope: h.scope, cellId: h.cellId }); return; }
    const ti = ev.target.closest('[data-issue]');
    if (ti) { navigateTo(state.issueList?.[Number(ti.dataset.issue)]?.location); return; }
    const tb = ev.target.closest('[data-textblock]');
    if (tb) { if (!tb.disabled) openTextBlock(tb); return; }
    const md = ev.target.closest('[data-modal]');
    if (md) { modalAction(md.dataset.modal); return; }
    const t = ev.target.closest('[data-elr],[data-go],[data-goconcept],[data-open-table],[data-act],[data-filter],[data-remove-slice]');
    if (!t) return;
    if (t.tagName === 'A') ev.preventDefault();
    if (t.dataset.elr) return go({ kind: 'elr', elr: t.dataset.elr });
    if (t.dataset.go) return go({ kind: t.dataset.go });
    if (t.dataset.goconcept) return goConcept(t.dataset.goconcept);
    if (t.dataset.openTable) return go({ kind: 'table', tableId: t.dataset.openTable, scope: t.dataset.scope });
    if (t.dataset.filter) { state.issueFilter = t.dataset.filter; return renderMain(); }
    if (t.dataset.removeSlice != null) {
      const v = state.view; const dims = state.slices[Number(t.dataset.removeSlice)];
      const remove = () => {
        S.removeSlice(v.tableId, v.scope, dims);
        state.pending[v.tableId + v.scope] = (state.pending[v.tableId + v.scope] || []).filter((p) => dimKey(p) !== dimKey(dims));
        changed(); renderMain({ keepScroll: true }); toast('Row removed.');
      };
      const n = S.filing.all().filter((f) => dimKey(f.dims) === dimKey(dims) && reportingYear(S.filing.meta.periods, f.period) === v.scope).length;
      if (!n) return remove();
      return confirmDialog('Remove row?', `This row holds <b>${n}</b> entered value(s). Removing the row deletes them from the filing.`, remove);
    }
    const act = t.dataset.act;
    if (act) actions[act]?.(t);
  });
  // rich-text toolbar: keep the editor selection while clicking a button
  document.addEventListener('mousedown', (ev) => { if (ev.target.closest('[data-rte]')) ev.preventDefault(); });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-rte]');
    if (!b || b.disabled) return;
    const body = b.closest('.rte').querySelector('.rte-body');
    if (document.activeElement !== body) body.focus();
    if (b.dataset.rte === 'tableBorders') return toggleTableBorders(body);
    try { document.execCommand('styleWithCSS', false, false); document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ }
    document.execCommand(b.dataset.rte, false, null);
  });
  document.addEventListener('focusin', (ev) => {
    if (!ev.target.matches?.('.rte-body')) return;
    ev.target.dataset.orig = ev.target.innerHTML;
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#modal').hidden) modalAction('cancel');
    if (!$('#modal').hidden) { modalKeys(ev); return; }
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      toast(saveLocal() ? `Saved in this browser at ${state.saved.toLocaleTimeString()}. Use “Save project” to download a project file.` : 'This browser does not allow saving here — use “Save project” to download a project file.', !(state.saved instanceof Date));
      return;
    }
    if (gridKeys(ev)) return;
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[data-hint]')) { ev.preventDefault(); ev.target.click(); return; }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[data-issue]')) { ev.preventDefault(); navigateTo(state.issueList?.[Number(ev.target.dataset.issue)]?.location); }
  });
  document.addEventListener('paste', (ev) => {
    const el = ev.target.closest?.('.rte-body');
    if (!el) return;
    ev.preventDefault();
    const cd = ev.clipboardData;
    const html = cd.getData('text/html');
    // pasted tables (Word/Excel) are rebuilt for the MCA HTML schema; cells get class="bordered" unless the source
    // already carries an MCA border class (switch off with the ▦ button)
    const clean = html ? fromMca(toMca(html, rteOpts({ borders: true }))) : fromMca(cd.getData('text/plain'));
    document.execCommand('insertHTML', false, clean);
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches('.cellin')) return cellChange(el);
    if (el.matches('[data-calc-override]')) { state.calcOverride[el.dataset.calcOverride] = el.checked; renderMain({ keepScroll: true }); toast(el.checked ? 'Calculated cells on this tab are editable (manual values are kept and checked by the calculation rule).' : 'Calculated cells on this tab are read-only again; values are kept.'); return; }
    if (el.name === 'cashflow') return setCashFlow(el.value);
    if (el.id === 'colorder') { state.colOrder = el.value; renderMain({ keepScroll: true }); return; }
    if (el.matches('select[data-axhelp]')) { const h = $('#axhelp-' + el.dataset.axhelp); const tax = A.table(state.view.tableId).axes.find((a) => a.axis === el.dataset.axis); if (h) h.textContent = axisHelp(tax, el.value); return; }
    if (el.id === 'tb-emphasis') { S.filing.meta.textEmphasis = el.value; changed(); toast(el.value === 'none' ? 'Bold/italic/underline will be saved as plain text.' : 'Bold/italic/underline will be saved as highlightedText1/2/3.'); return; }
    if (el.name === 'fta') return setFta(el);
    if (el.matches('[data-rename]')) {
      const v = state.view; const dims = state.slices[Number(el.dataset.rename)];
      try {
        const exists = S.filing.all().some((f) => dimKey(f.dims) === dimKey(dims));
        if (exists) S.renameTypedMember(v.tableId, v.scope, dims, el.dataset.axis, el.value.trim());
        else { const p = state.pending[v.tableId + v.scope]; const i = p.findIndex((x) => dimKey(x) === dimKey(dims)); p[i] = dims.map((d) => (d.axis === el.dataset.axis ? { axis: d.axis, typed: el.value.trim() } : d)); }
        changed(); renderMain(); toast('Typed member renamed.');
      } catch (e) { toast(e.message, true); el.value = dims.find((d) => d.axis === el.dataset.axis)?.typed || ''; }
    }
    if (el.name === 'yearMode' && state.pendingImport) { state.pendingImport.mode = el.value; renderMain(); return; }
    if (el.name === 'cfImport' && state.pendingImport) { state.pendingImport.cashFlowMethod = el.value; renderMain(); return; }
    if (el.id === 'f-first') { $('#f-pys').disabled = el.checked; $('#f-pye').disabled = el.checked; }
  });
  document.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (ev.target.id === 'setup') return applySetup(ev.target);
    if (ev.target.id === 'addslice') return addSlice(ev.target);
    if (ev.target.id === 'import-confirm') return commitImport();
  });
  $('#file-xml').addEventListener('change', (ev) => readFile(ev, (text, name) => {
    // nothing is committed until the user chooses how previous-year data is populated
    try { state.pendingImport = { text, name, preview: S.previewXml(text, { fileName: name }), mode: null }; go({ kind: 'import-confirm' }); }
    catch (e) { toast('Import failed: ' + e.message, true); }
  }));
  $('#file-json').addEventListener('change', (ev) => readFile(ev, (text) => {
    try { S = new Session(A, Filing.fromJSON(A, JSON.parse(text))); state.example = false; state.pending = {}; changed(); state.leaveOk = true; go({ kind: 'setup' }); toast('Project opened.'); }
    catch (e) { toast('Could not open project: ' + e.message, true); }
  }));
  $('#navtoggle').addEventListener('click', () => $('#nav').classList.toggle('open'));
}

function readFile(ev, cb) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => cb(String(r.result), f.name);
  r.readAsText(f);
  ev.target.value = '';
}

function commitImport() {
  const p = state.pendingImport;
  if (!p?.mode) { toast('Choose how the XML is imported first (Both years, Current year only or Roll forward).', true); return; }
  if (p.preview.cashFlow?.needsChoice && !p.cashFlowMethod) { toast('Choose the cash flow statement method first.', true); return; }
  try {
    const r = S.importXml(p.text, { fileName: p.name, yearMode: p.mode, cashFlowMethod: p.cashFlowMethod || null });
    state.pendingImport = null; state.example = false; state.pending = {};
    changed(); go({ kind: 'import' });
    toast(r.yearMode === 'current' ? `Current year imported: ${nf(r.byYear.current)} facts + ${nf(r.byYear.carriedOpening)} opening balances. Previous year not imported.`
      : r.yearMode === 'rollforward' ? `Rolled forward: new year ${r.rollForward.newCurrent.start} → ${r.rollForward.newCurrent.end}; ${nf(r.byYear.previous + r.byYear.previousOpening)} previous-year facts.`
      : `Imported ${nf(r.counts.imported)} of ${nf(r.counts.sourceFacts)} facts.`);
  } catch (e) { toast('Import failed: ' + e.message, true); }
}

const actions = {
  'validate-tab'(btn) {
    const tab = btn?.dataset.tab || state.lastTab;
    if (!tab) return;
    state.gate = S.validateTab(tab); state.issueFilter = state.gate.summary.errors ? 'ERROR' : 'ALL';
    state.view = { kind: 'validate' }; renderBar(); renderNav(); renderMain();
  },
  'mismatch-refresh'() { state.gate = S.validate(); renderBar(); renderNav(); renderMain(); },
  'cancel-import'() { state.pendingImport = null; go({ kind: 'setup' }); toast('Import cancelled — nothing was changed.'); },
  validate() { if (!guardLeave({ kind: 'validate' }, () => actions.validate())) return; state.leaveOk = false; state.gate = S.validate(); state.issueFilter = state.gate.summary.errors ? 'ERROR' : 'ALL'; state.view = { kind: 'validate' }; renderBar(); renderNav(); renderMain(); },
  'add-parents'(el) {
    const v = state.view;
    const n = missingParents(A, v.tableId, state.slices).find((x) => x.slice === Number(el.dataset.slice) && x.axis === el.dataset.axis);
    if (!n) return;
    const list = (state.pending[v.tableId + v.scope] ||= []);
    for (const p of n.parents) { const nd = S.validateSlice(v.tableId, p.dims); if (!slicesFor(v.tableId, v.scope).some((d) => dimKey(d) === dimKey(nd))) list.push(nd); }
    renderMain({ keepScroll: true });
    toast(`Added column(s): ${n.parents.map((p) => shortLabel(p.member)).join(', ')}. Enter their totals.`);
  },
  'carry-forward'(el) {
    const tableId = el.dataset.t;
    const plan = carryForwardPlan(S, tableId);
    if (!plan.available) return toast(plan.reason || 'Nothing to copy into this table.', true);
    if (!plan.newColumns.length && !plan.values) return toast('The previous year has nothing new to copy into this table.');
    confirmDialog('Copy from previous year?',
      `This adds <b>${plan.newColumns.length}</b> column(s) and copies <b>${plan.values}</b> value(s) from the previous year. Values you have already entered are never overwritten, calculated cells are left to the calculation, and every copied value goes through the same checks as typing.`,
      () => {
        const res = carryForward(S, tableId, { values: true });
        const list = (state.pending[tableId + 'CY'] ||= []);
        const present = new Set(slicesFor(tableId, 'CY').map(dimKey));
        for (const d of res.columns) if (!present.has(dimKey(d))) { list.push(d); present.add(dimKey(d)); }
        changed(); renderMain({ keepScroll: true });
        toast(`Copied ${res.copied} value(s)${res.skipped ? ` — ${res.skipped} skipped (not applicable or calculated here)` : ''}.`);
      }, null, { ok: 'Copy' });
  },
  'fn-add'() {
    try { addFootnote(S.filing, $('#fn-new')?.value || '', []); changed(); renderMain({ keepScroll: true }); toast('Footnote added. Choose a cell and link it to the footnote.'); }
    catch (e) { toast(e.message, true); }
  },
  'fn-save'(el) {
    const id = el.dataset.id;
    try { updateFootnoteText(S.filing, id, $(`#fn-text-${id}`)?.value || ''); changed(); renderMain({ keepScroll: true }); toast('Footnote saved.'); }
    catch (e) { toast(e.message, true); }
  },
  'fn-link'(el) {
    const key = $('#fn-cell')?.value;
    if (!key) return toast('Choose a cell in the list first.', true);
    try { linkFootnote(S.filing, el.dataset.id, key); changed(); renderMain({ keepScroll: true }); toast('Cell linked to the footnote.'); }
    catch (e) { toast(e.message, true); }
  },
  'fn-unlink'(el) { unlinkFootnote(S.filing, el.dataset.id, el.dataset.key); changed(); renderMain({ keepScroll: true }); },
  'fn-remove'(el) {
    const id = el.dataset.id;
    confirmDialog('Remove footnote?', 'The footnote text and its links to cells are removed from the filing.', () => {
      removeFootnote(S.filing, id); changed(); renderMain({ keepScroll: true }); toast('Footnote removed.');
    });
  },
  'use-sum'(el) {
    const id = el.dataset.sumcell;
    const h = state.totals.find((x) => x.cellId === id);
    const input = document.querySelector(`#main .cellin[data-cell="${CSS.escape(id)}"]`);
    if (!h || !input) return;
    if (input.disabled || input.readOnly) { toast('This cell is read-only (calculated). Use the tab option to edit calculated cells first.', true); return; }
    input.value = fmtAmt(h.concept, h.childrenSum);
    if (cellChange(input) !== false) { refreshTotals(); toast(`Total set to ${input.value} — the sum of ${h.children.length} part column(s).`); }
  },
  explainErrors() {
    const text = $('#mx-text')?.value || '';
    state.mcaErrors = { text, items: explainMcaErrors(text, A) };
    renderMain({ keepScroll: true });
    if (!state.mcaErrors.items.length) toast('No validator messages found in the text.', true);
  },
  generate() {
    if (!guardLeave({ kind: 'xml' }, () => actions.generate())) return;
    state.leaveOk = false;
    try { const { xml, gate } = S.exportXml(); state.gate = gate; state.xml = xml; toast('XML generated — internal gate passed.'); }
    catch (e) { state.gate = e.result || null; state.xml = null; toast(e.message, true); }
    renderBar(); renderNav(); renderMain();
  },
  'download-xml'() { if (state.xml) download(`${(S.filing.meta.cin || 'instance')}_${S.filing.meta.reportType}_${S.filing.meta.periods.cy.end}.xml`, state.xml, 'application/xml'); },
  async 'copy-xml'() {
    try { await navigator.clipboard.writeText(state.xml); toast('XML copied.'); }
    catch { const r = document.createRange(); r.selectNodeContents($('#xmltext')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl/Cmd+C to copy the selected XML.'); }
  },
  'import-xml'() { $('#file-xml').click(); },
  'open-project'() { $('#file-json').click(); },
  'save-project'() { download(`${(S.filing.meta.name || 'filing').replace(/[^\w.-]+/g, '_')}.mca-indas.json`, JSON.stringify(S.filing.toJSON(), null, 1), 'application/json'); },
  'new-filing'() {
    confirmDialog('Start a new filing?', 'The current filing in this browser will be replaced by an empty one. Use <b>Save project</b> first if you want to keep a copy.', () => {
      S = new Session(A); state.example = false; state.pending = {}; changed(); state.leaveOk = true; go({ kind: 'setup' }); toast('New filing started.');
    });
  },
};

function applySetup(form) {
  const v = (n) => form.elements[n].value;
  const first = form.elements.firstFinancialYear.checked;
  try {
    S.setMeta({ name: v('name'), cin: v('cin').trim().toUpperCase(), reportType: v('reportType'), level: v('level'), displayPlaces: Number(v('displayPlaces')), firstFinancialYear: first,
      periods: { cy: { start: v('cy.start'), end: v('cy.end') }, py: first ? { start: '', end: '' } : { start: v('py.start'), end: v('py.end') } } });
    const qName = A.qnameOfLocal('NameOfCompany');
    if (v('name').trim() && S.conceptStatus(qName, 'CY').applicable) S.setValue(qName, 'CY', v('name').trim());
    S._views.clear(); changed(); renderNav(); renderMain({ keepScroll: true }); toast('Company information applied.');
  } catch (e) { toast(e.message, true); }
}

function addSlice(form) {
  const v = state.view;
  const dims = [];
  for (const el of form.querySelectorAll('[data-axis]')) {
    const val = el.value.trim();
    if (!val) continue;
    dims.push(el.tagName === 'SELECT' ? { axis: el.dataset.axis, member: val } : { axis: el.dataset.axis, typed: val });
  }
  try {
    const nd = S.validateSlice(v.tableId, dims);
    if (slicesFor(v.tableId, v.scope).some((d) => dimKey(d) === dimKey(nd))) { toast('That row already exists.', true); return; }
    (state.pending[v.tableId + v.scope] ||= []).push(nd);
    renderMain({ keepScroll: true });
    // show the new column where it sits (taxonomy order) and say whether it needs its parent column (FM-14)
    const idx = state.slices.findIndex((d) => dimKey(d) === dimKey(nd));
    const th = document.querySelectorAll('#main th.slicehead')[idx];
    if (th) { th.scrollIntoView({ block: 'nearest', inline: 'center' }); flash(th); }
    const need = missingParents(A, v.tableId, state.slices).find((x) => x.slice === idx);
    toast(need ? `Column added. It needs the ${need.parents.map((p) => shortLabel(p.member)).join(' › ')} column too (FM-14) — use “Add” in its heading.` : 'Column added.');
  } catch (e) { toast(e.message, true); }
}

function normDimsUI(dims) { return [...dims].map((d) => (d.typed != null ? { axis: d.axis, typed: String(d.typed) } : { axis: d.axis, member: d.member })).sort((a, b) => a.axis.localeCompare(b.axis)); }

// ------------------------------------------------------------------ modal: text block editor + confirmations
let modalState = null;
function openModal(title, body, foot, st) {
  modalState = st;
  st.opener = document.activeElement;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-foot').innerHTML = foot;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true; $('#modal-body').innerHTML = ''; const st = modalState; modalState = null; st?.after?.();
  if (st?.opener && document.contains(st.opener) && st.kind !== 'textblock') { try { st.opener.focus({ preventScroll: true }); } catch { /* not focusable */ } }
}
function openTextBlock(btn) {
  const { c, s, pl, t, slice } = btn.dataset;
  const dims = t != null && slice != null ? state.slices[Number(slice)] : [];
  const fact = t != null && slice != null ? S.getValue(c, s, dims, pl || null) : S.getValue(c, s, [], pl || null);
  const html = fact && !fact.nil ? fromMca(fact.value) : '';
  const issuesPanel = textBlockIssues(btn.dataset.cell, fact);
  const bar = RTE_BUTTONS.map(([cmd, label, name]) => `<button type="button" class="rte-btn rte-${cmd}" data-rte="${cmd}" title="${name}" aria-label="${name}">${label}</button>`).join('');
  openModal(`Edit Text Block — ${A.label(c)} (${SCOPE_NAME[s] || s})`,
    `<p class="note">${esc(c)}</p>${issuesPanel}<div class="rte"><div class="rte-bar" role="toolbar" aria-label="Formatting">${bar}</div><div class="rte-body" id="tb-editor" role="textbox" aria-multiline="true" contenteditable="true" spellcheck="true">${html}</div></div>
     <div class="rte-opts"><label>Bold / italic / underline in the MCA PDF: <select id="tb-emphasis"><option value="highlight" ${S.filing.meta.textEmphasis === 'none' ? '' : 'selected'}>MCA highlight classes (highlightedText1/2/3 — rendered as shaded text)</option><option value="none" ${S.filing.meta.textEmphasis === 'none' ? 'selected' : ''}>Plain text (no emphasis)</option></select></label></div>
     <p class="note">Saved in the MCA HTML subset: lists → noteText1/2, indentation → noteText3, tables rebuilt without colgroup/colspan/rowspan (merged cells become empty cells), ▦ = cell borders (class "bordered"). The setting applies to the whole filing.</p>`,
    '<button type="button" class="btn" data-modal="cancel" id="tb-cancel">Cancel</button><button type="button" class="btn primary" data-modal="save" id="tb-save">Save Text</button>',
    { kind: 'textblock', dataset: { ...btn.dataset } });
  setTimeout(() => { const ed = $('#tb-editor'); if (!ed) return; ed.focus(); try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ } }, 0);
}
// Validation status of one text block, shown at the top of its editor. Reads the last validation result
// (issueIndex) and the gate's own HTML check of the stored value; nothing is re-implemented here.
function textBlockIssues(cellId, fact) {
  const list = (cellId && issueIndex().get(cellId)) || [];
  const stored = fact && !fact.nil ? htmlGuidelineIssues(fact.value, { detail: true }) : { errors: [], warnings: [] };
  const html = stored.errors.filter((e) => !e.startsWith('entity'));
  const items = [
    ...list.map((i) => `<li><span class="chip ${i.severity === 'ERROR' ? 'bad' : 'warn'}">${esc(i.severity)}</span> ${esc(i.message)}</li>`),
    ...(html.length && !list.some((i) => i.code === 'html') ? [`<li><span class="chip bad">HTML</span> The saved content contains HTML the MCA Validator rejects (${esc(html.join('; '))}). <b>Save Text</b> rebuilds it in the MCA subset.</li>`] : []),
  ];
  if (items.length) return `<div class="tb-issues ${list.some((i) => i.severity === 'ERROR') || html.length ? 'bad' : 'warn'}" role="alert"><b>${items.length} issue(s) for this text block</b><ul>${items.join('')}</ul></div>`;
  return `<div class="tb-issues ${state.gate ? 'ok' : ''}">${state.gate ? 'No validation issues for this text block in the last validation.' : 'Not validated yet — run <b>Validate</b> to check this text block.'}</div>`;
}
function modalAction(a) {
  const st = modalState;
  if (!st) return closeModal();
  if (a === 'save' && st.kind === 'textblock') {
    const ed = $('#tb-editor');
    const mca = toMca(ed.innerHTML, rteOpts());
    const value = plainText(mca) ? mca : '';
    const ok = cellChange({ dataset: st.dataset, value, classList: { add() {}, remove() {} }, set title(_) {} });
    if (ok === false) return; // error toast shown; keep the editor open
    closeModal();
    renderMain({ keepScroll: true });
    toast(value ? 'Text block saved. Run Validate to re-check it.' : 'Text block cleared.');
    const back = document.querySelector(`#main [data-textblock][data-c="${CSS.escape(st.dataset.c)}"][data-s="${st.dataset.s}"]${st.dataset.slice != null ? `[data-slice="${st.dataset.slice}"]` : ''}`);
    if (back) { back.focus(); flash(back); }
    return;
  }
  if (a === 'continue' && st.kind === 'confirm') { const go2 = st.onContinue; closeModal(); go2(); return; }
  if (a === 'cancel' && st.kind === 'confirm') { const c2 = st.onCancel; closeModal(); c2?.(); return; }
  closeModal(); // cancel: nothing is changed
}
function confirmDialog(title, message, onContinue, onCancel, labels = {}) {
  openModal(title, `<div>${message}</div>`, `<button type="button" class="btn" data-modal="cancel" id="dlg-cancel">${esc(labels.cancel || 'Cancel')}</button><button type="button" class="btn primary" data-modal="continue" id="dlg-continue">${esc(labels.ok || 'Continue')}</button>`, { kind: 'confirm', onContinue, onCancel });
  $('#dlg-cancel')?.focus();
}

// Yes/No dependencies (compiled from the MCA conditional rules): how many entered values an answer would
// make non-applicable. Values are never deleted — they stay in the project and are excluded from filing.
function dependentValues(parent, scope, newValue) {
  let n = 0;
  for (const d of S.dependencies().filter((x) => x.parentConcept === parent)) {
    if ((newValue === 'true') === d.condition) continue;
    for (const c of d.childConcepts) {
      // still required through another question answered with its condition → not affected
      const other = (S.app.depsByChild.get(c) || []).some((o) => o.parentConcept !== parent && S.filing.value(o.parentConcept, scope, []) === String(o.condition));
      if (!other) n += S.filing.factsOf(c).filter((f) => reportingYear(S.filing.meta.periods, f.period) === scope && !f.nil).length;
    }
    for (const id of d.tables) n += S.filing.all().filter((f) => f.dims.length && !f.nil && reportingYear(S.filing.meta.periods, f.period) === scope && inTable(f, A.table(id))).length;
  }
  return n;
}

const inTable = (f, t) => factInTable(A, f, t);

function setCashFlow(value) {
  const q = A.qnameOfLocal('TypeOfCashFlowStatement');
  try {
    S.setValue(q, 'CY', value);
    changed(); renderNav(); renderMain({ keepScroll: true });
    toast(`${value}: ${cfNote(value)}.`);
  } catch (e) { toast(e.message, true); }
}

// First-time adoption answer: the same Yes/No dependency confirmation as any boolean cell (values never deleted)
function setFta(el) {
  const apply = () => {
    try {
      S.setValue(FTA, 'CY', el.value);
      changed(); renderNav(); renderMain({ keepScroll: true });
      toast(el.value === 'true' ? `First-time adoption: [${PROFILE.balanceSheet}] now has the opening balance sheet column (${pyoDate()}).` : 'First-time adoption: No — two-column balance sheet.');
    } catch (e) { toast(e.message, true); renderMain({ keepScroll: true }); }
  };
  const n = dependentValues(FTA, 'CY', el.value) + (el.value === 'true' ? 0 : S.filing.inScope('PYO').filter((f) => !f.nil && !openingConcepts(A).has(f.concept)).length);
  if (n > 0) { confirmDialog('Change answer?', `Changing this answer to "${el.value === 'true' ? 'Yes' : 'No'}" will make <b>${n}</b> entered value(s) non-applicable. Existing values will be retained but excluded from filing/validation.`, apply, () => renderMain({ keepScroll: true })); return; }
  apply();
}

// refresh calculated cells in place after an edit (no re-render: the next click must not be swallowed)
function refreshCalculated() {
  for (const el of document.querySelectorAll('#main .cellin.calc')) {
    const { c, s, pl, t, slice } = el.dataset;
    const f = t != null && slice != null ? S.getValue(c, s, state.slices[Number(slice)], pl || null) : S.getValue(c, s, [], pl || null);
    const v = f ? S.displayOf(f) : '';
    if (el.value !== v) { el.value = v; flash(el); }
  }
}

function cellChange(el) {
  const { c, s, pl, t, slice, tab, tabkey } = el.dataset;
  const key = tabkey || tab;
  const opts = { preferredLabel: pl || null, recalc: true, override: !!state.calcOverride[key] };
  const apply = () => {
    try {
      if (t != null && slice != null) S.setTableValue(t, s, state.slices[Number(slice)], c, el.value, { ...opts, lockCalculated: true });
      else S.setValue(c, s, el.value, { ...opts, tab: tab || null });
      el.classList.remove('bad'); el.classList.add('saved'); el.title = '';
      const f = t != null ? S.getValue(c, s, state.slices[Number(slice)], pl || null) : S.getValue(c, s, [], pl || null);
      if (f && A.dataType(c) === 'monetary' && 'value' in el && el.tagName) el.value = S.displayOf(f);
      changed();
      // answers that change applicability (Yes/No dependencies, cash-flow method, conditional tables) re-render
      const t2 = A.dataType(c);
      if (t2 === 'boolean' || t2 === 'enum') { renderNav(); renderMain({ keepScroll: true }); }
      else { refreshCalculated(); refreshRequired(); refreshTotals(); }
      return true;
    } catch (e) {
      el.classList.add('bad'); el.title = e.message + (e.reasons ? '\n' + e.reasons.join('\n') : '');
      toast(e.message, true);
      return false;
    }
  };
  if (A.dataType(c) === 'boolean' && t == null) {
    const n = dependentValues(c, s, el.value);
    if (n > 0) {
      const prev = S.getValue(c, s, [], pl || null);
      confirmDialog('Change answer?', `Changing this answer to "${el.value === 'true' ? 'Yes' : 'No'}" will make <b>${n}</b> entered value(s) non-applicable. Existing values will be retained but excluded from filing/validation.`,
        apply, () => { el.value = prev ? prev.value : ''; });
      return true;
    }
  }
  return apply();
}

boot();
