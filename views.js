// UI/table engine model: builds statement and table view-models purely from the authority.
// No table-specific code — every table is rendered from ELR → hypercube → axes → members → line items.
import { factInTable, nondimAllowed, dimensionallyValid } from './dimensions.js';

export function buildElrView(A, elrUri) {
  const elr = A.elr(elrUri);
  const tables = A.tablesInElr(elrUri);
  // several tables may share a primary item (e.g. a dimensional table and its "/total" table):
  // place them together, dimensional ones first
  const tableByPrimary = new Map();
  for (const t of [...tables].sort((a, b) => (b.axes.length > 0) - (a.axes.length > 0) || a.id.localeCompare(b.id))) (tableByPrimary.get(t.primaryItem) || tableByPrimary.set(t.primaryItem, []).get(t.primaryItem)).push(t);
  const rows = [];
  const placed = new Set();
  const skip = new Set();
  for (const t of tables) { skip.add(t.hypercube); for (const n of t.lineItemNodes) skip.add(n); }
  const visit = (q, depth, preferredLabel) => {
    const c = A.concept(q);
    if (!c || skip.has(q)) return;
    const ts = tableByPrimary.get(q) || [];
    if (c.kind === 'abstract') rows.push({ kind: 'header', concept: q, depth, label: A.label(q) });
    else if (c.kind === 'item') {
      if (nondimAllowed(A, q)) rows.push({ kind: 'item', concept: q, depth, label: A.label(q, preferredLabel || 'label'), preferredLabel: preferredLabel || null, periodType: c.periodType, dataType: A.dataType(q) });
    } else return; // axes, members, typed domains are not statement rows
    for (const t of ts) if (!placed.has(t.id)) { rows.push({ kind: 'table', tableId: t.id, depth: depth + 1, label: A.label(t.hypercube) + (t.axes.length ? '' : ' — totals') }); placed.add(t.id); }
    for (const arc of A.presentationChildren(elrUri, q)) {
      if (ts.some((t) => t.lineItems.includes(arc.to) || t.lineItemNodes.includes(arc.to))) continue;
      visit(arc.to, depth + 1, arc.preferredLabel);
    }
  };
  for (const r of elr.roots) visit(r, 0, null);
  for (const t of tables) if (!placed.has(t.id)) rows.push({ kind: 'table', tableId: t.id, depth: 0, label: A.label(t.hypercube) + (t.axes.length ? '' : ' — totals') });
  return { elr, rows, tables: tables.map((t) => t.id) };
}

// Ordered members of an axis for a table: presentation order where the axis is presented in
// the table's ELR, otherwise definition order.
function orderedMembers(A, table, axisDef) {
  const byMember = new Map(axisDef.members.map((m) => [m.member, m]));
  const out = [];
  const seen = new Set();
  const pres = table.presentationElr;
  const walk = (q, depth) => {
    for (const arc of A.presentationChildren(pres, q)) {
      const m = byMember.get(arc.to);
      if (m && !seen.has(arc.to)) { seen.add(arc.to); out.push({ ...m, depth }); }
      walk(arc.to, depth + 1);
    }
  };
  if (pres) walk(axisDef.axis, 0);
  for (const m of axisDef.members) if (!seen.has(m.member)) out.push(m);
  return out;
}

export function buildTableView(A, tableId) {
  const t = A.table(tableId);
  if (!t) throw new Error(`Unknown table ${tableId}`);
  const axes = t.axes.map((ax) => ({
    axis: ax.axis,
    label: A.label(ax.axis),
    typed: ax.typed,
    typedDomain: ax.typedDomain || null,
    default: ax.typed ? null : A.dimensionDefault(ax.axis),
    members: ax.typed ? [] : orderedMembers(A, t, ax).map((m) => ({ member: m.member, label: A.label(m.member), depth: m.depth, usable: m.usable, isDefault: A.dimensionDefault(ax.axis) === m.member })),
  }));
  // line items in presentation order under the table's line-item node(s), else definition order
  const items = [];
  const seen = new Set();
  const pres = t.presentationElr;
  const lineSet = new Set(t.lineItemTree.map((n) => n.concept));
  const walk = (q, depth, preferredLabel) => {
    for (const arc of A.presentationChildren(pres, q)) {
      if (!lineSet.has(arc.to) || seen.has(arc.to)) continue;
      seen.add(arc.to);
      const c = A.concept(arc.to);
      items.push({ concept: arc.to, depth, abstract: c.abstract, label: A.label(arc.to, arc.preferredLabel || 'label'), preferredLabel: arc.preferredLabel || null, periodType: c.periodType, dataType: c.abstract ? null : A.dataType(arc.to), enumerations: A.enumerations(arc.to) });
      walk(arc.to, depth + 1, arc.preferredLabel);
    }
  };
  if (pres) { walk(t.primaryItem, 0, null); for (const n of t.lineItemNodes) walk(n, 1, null); }
  for (const n of t.lineItemTree) if (!seen.has(n.concept)) {
    const c = A.concept(n.concept);
    items.push({ concept: n.concept, depth: n.depth, abstract: c.abstract, label: A.label(n.concept), preferredLabel: null, periodType: c.periodType, dataType: c.abstract ? null : A.dataType(n.concept), enumerations: A.enumerations(n.concept) });
  }
  return {
    id: t.id, elr: t.elr, code: t.code, presentationElr: t.presentationElr, hypercube: t.hypercube, primaryItem: t.primaryItem,
    title: A.label(t.hypercube), closed: t.closed, axes, lineItems: items,
    notAll: t.notAll.map((n) => ({ hypercube: n.hypercube, appliesTo: n.appliesTo })),
  };
}

// Distinct dimension combinations ("slices") reported in a table for a scope.
export function tableSlices(A, filing, tableId, scopeYear, reportingYear) {
  const t = A.table(tableId);
  const items = new Set(t.lineItems);
  const axes = new Set(t.axes.map((a) => a.axis));
  const map = new Map();
  for (const f of filing.all()) {
    if (!items.has(f.concept) || !f.dims.length || !f.dims.every((d) => axes.has(d.axis)) || !factInTable(A, f, t)) continue;
    if (reportingYear(filing.meta.periods, f.period) !== scopeYear) continue;
    const k = f.dims.map((d) => `${d.axis}=${d.member ?? d.typed}`).join('|');
    if (!map.has(k)) map.set(k, f.dims);
  }
  // the default slice (every axis at its default member = the table total, reported without dimensions): shown
  // as the last column when a line item has such a fact, so totals of classes (share capital, PPE, intangible
  // assets, changes in equity …) are visible and editable. The MCA-validated ICOM 2022-23 instance has 238 of them.
  if (defaultSliceAllowed(A, t)) {
    const has = filing.all().some((f) => !f.dims.length && items.has(f.concept) && reportingYear(filing.meta.periods, f.period) === scopeYear && dimensionallyValid(A, f.concept, []).valid);
    if (has) map.set('', []);
  }
  return [...map.values()];
}

// a table can show a default slice when every axis is explicit and has a default member
export function defaultSliceAllowed(A, t) {
  return t.axes.length > 0 && t.axes.every((a) => !a.typed && A.dimensionDefault(a.axis));
}
