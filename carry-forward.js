// "Copy from previous year": adds the previous-year columns (axis-member combinations) of a dimensional table to the
// current-year table and, optionally, copies their values. Existing current-year values are never overwritten;
// calculated cells are left to the calculation; every copy goes through Session.setTableValue (same checks as typing).
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';
import { dimKey } from './model.js';

export function carryForwardPlan(S, tableId) {
  const out = { available: false, reason: '', columns: [], newColumns: [], values: 0 };
  const cy = S.tableStatus(tableId, 'CY'), py = S.tableStatus(tableId, 'PY');
  if (!cy.applicable) { out.reason = 'The current-year table is not applicable.'; return out; }
  if (!py.applicable) { out.reason = 'The previous-year table is not applicable.'; return out; }
  const pyCols = tableSlices(S.A, S.filing, tableId, 'PY', reportingYear);
  if (!pyCols.length) { out.reason = 'The previous-year table has no columns.'; return out; }
  const have = new Set(tableSlices(S.A, S.filing, tableId, 'CY', reportingYear).map(dimKey));
  out.available = true; out.columns = pyCols; out.newColumns = pyCols.filter((d) => !have.has(dimKey(d)));
  out.values = valueCandidates(S, tableId, pyCols).length;
  return out;
}

function valueCandidates(S, tableId, cols) {
  const v = S.tableView(tableId);
  const rows = (v.lineItems || []).filter((l) => !l.abstract && !/periodStartLabel/.test(l.preferredLabel || ''));
  const out = [];
  for (const dims of cols) for (const l of rows) {
    const pyVal = S.getValue(l.concept, 'PY', dims);
    if (pyVal === null || pyVal === undefined) continue;
    if (S.getValue(l.concept, 'CY', dims) !== null) continue;
    try { if (S.calculatedCell(l.concept, 'CY', dims, v.presentationElr)) continue; } catch { /* not calculated */ }
    const pf = S.filing.get(l.concept, S.filing.period(l.concept, 'PY'), dims);
    if (!pf || pf.nil) continue;
    out.push({ dims, concept: l.concept, preferredLabel: l.preferredLabel || null, fact: pf });
  }
  return out;
}

export function carryForward(S, tableId, { values = false } = {}) {
  const plan = carryForwardPlan(S, tableId);
  const res = { columns: [], copied: 0, skipped: 0 };
  if (!plan.available) return res;
  res.columns = plan.newColumns.map((d) => S.validateSlice(tableId, d));
  if (values) for (const c of valueCandidates(S, tableId, plan.columns)) {
    try { S.setTableValue(tableId, 'CY', c.dims, c.concept, S.displayOf(c.fact), { preferredLabel: c.preferredLabel, recalc: true, lockCalculated: true }); res.copied++; }
    catch { res.skipped++; }
  }
  return res;
}
