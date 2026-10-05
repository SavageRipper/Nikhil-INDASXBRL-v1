// UI helper: parent/child (total/part) guidance for dimensional table columns. Display only — like
// mandatory-marks.js it reads the taxonomy, the compiled rules and the entered values and changes nothing in the
// filing, the rules, validation or XML generation. Totals hints are TOOL GUIDANCE, not MCA rules:
//
//   memberInfo      where a member sits in its axis (path to the total, number of children)
//   sortSlices      columns in taxonomy order (each total before its parts); typed members keep their order
//   missingParents  parent columns FM-14 (Filing Manual Annexure II #14) requires — the decision is the rule engine's
//                   own (rules.js fm14RequiredParent); like the rule, a parent reported in any column of the table
//                   (any combination of the other axes) satisfies it
//   totalsHints     a total column whose value differs from the sum of its part columns, only on axes that the MCA
//                   business rules themselves add up (sumAxis expressions in the compiled rules, e.g. SR-L878
//                   ClassificationOfBorrowingsAxis, SR-L1048-3 ClassesOfPropertyPlantAndEquipmentAxis), only for amounts and
//                   share counts, compared like XBRL Calculations 1.1 (rounded to the lowest decimals).
//                   Axes split by arithmetic other than a sum (gross − accumulated depreciation) are not hinted;
//                   their MCA rules (SR-L1023 …) run in validation.
import * as Dec from './decimal.js';
import { dimKey, factKey } from './model.js';
import { dimensionallyValid } from './dimensions.js';
import { fm14RequiredParent } from './rules.js';
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';

const ADDITIVE = new WeakMap();
/** axes the compiled MCA business rules add up (sumAxis), with the rules that do it */
export function additiveAxes(A) {
  if (ADDITIVE.has(A)) return ADDITIVE.get(A);
  const m = new Map();
  const walk = (x, id) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, id)); return; }
    if (x.sumAxis && typeof x.sumAxis.axis === 'string') (m.get(x.sumAxis.axis) || m.set(x.sumAxis.axis, new Set()).get(x.sumAxis.axis)).add(id);
    for (const v of Object.values(x)) walk(v, id);
  };
  for (const r of A.rules.rules) if (r.status === 'EXECUTABLE') walk(r.ast, r.id);
  const out = new Map([...m].map(([k, v]) => [k, [...v]]));
  ADDITIVE.set(A, out);
  return out;
}
const SUMMABLE = new Set(['monetary', 'shares']);

const axisDefault = (A, ax) => A.dimensionDefault(ax.axis) || (ax.members || []).find((m) => m.depth === 0)?.member || null;
const memberOf = (A, ax, dims) => dims.find((d) => d.axis === ax.axis)?.member || axisDefault(A, ax);
const withMember = (A, ax, dims, member) => {
  const rest = dims.filter((d) => d.axis !== ax.axis);
  return member === axisDefault(A, ax) ? rest : [...rest, { axis: ax.axis, member }];
};

/** @returns {{ path: string[], parent: string|null, children: string[], isTotal: boolean, isDefault: boolean }} */
export function memberInfo(A, ax, member) {
  const members = ax.members || [];
  const byM = new Map(members.map((m) => [m.member, m]));
  const path = [];
  for (let p = byM.get(member)?.parent; p; p = byM.get(p)?.parent) path.push(p);
  const children = members.filter((m) => m.parent === member).map((m) => m.member);
  const isDefault = member === axisDefault(A, ax);
  return { path, parent: byM.get(member)?.parent || null, children, isTotal: children.length > 0, isDefault };
}

/** columns in taxonomy order: per axis (table order) the member's position in the axis tree; stable otherwise */
export function sortSlices(A, tableId, slices) {
  const t = A.table(tableId);
  const pos = t.axes.map((ax) => new Map((ax.members || []).map((m, i) => [m.member, i])));
  const key = (dims) => t.axes.map((ax, i) => {
    if (ax.typed) return -1;
    return pos[i].get(memberOf(A, ax, dims)) ?? 1e6;
  });
  return slices.map((dims, i) => ({ dims, i, k: key(dims) }))
    .sort((a, b) => { for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j]; return a.i - b.i; })
    .map((x) => x.dims);
}

/** parent columns required by FM-14 that are not in the table yet (whole chain up to the first one present) */
export function missingParents(A, tableId, slices) {
  const t = A.table(tableId);
  const tnames = [t.hypercube.split(':')[1]];
  // FM-14 is satisfied by the parent member on that axis in any column (validated ICOM 2022-23 reports parent
  // classes without the category axis)
  const onAxis = new Map();
  for (const dims of slices) for (const d of dims) if (d.member) (onAxis.get(d.axis) || onAxis.set(d.axis, new Set()).get(d.axis)).add(d.member);
  const out = [];
  slices.forEach((dims, si) => {
    for (const d of dims) {
      if (!d.member) continue;
      const ax = t.axes.find((a) => a.axis === d.axis);
      if (!ax) continue;
      const chain = [];
      let cur = dims, m = d.member;
      for (let p = fm14RequiredParent(A, d.axis, m, tnames); p; p = fm14RequiredParent(A, d.axis, m, tnames)) {
        const pd = withMember(A, ax, cur, p);
        if (!t.lineItems.some((q) => dimensionallyValid(A, q, pd).valid)) break;
        if (onAxis.get(d.axis)?.has(p)) break;
        chain.push({ member: p, dims: pd });
        cur = pd; m = p;
      }
      if (chain.length) out.push({ slice: si, axis: d.axis, child: d.member, parents: chain });
    }
  });
  return out;
}

/**
 * Total columns whose value differs from the sum of their part columns (tool guidance).
 * @param S session (read APIs only: A, filing, tableView, periodForCell)
 * @returns {Array<{ ok: boolean, tableId, scope, concept, preferredLabel, axis, parentMember, parentDims, children: {member, dims, value}[], missingChildren: string[], parentValue: string, childrenSum: string, difference: string, decimals: number|null, cellId: string, rules: string[] }>}
 */
export function totalsHints(S, tableId, scope, slices, { includeMatches = false } = {}) {
  const A = S.A, filing = S.filing;
  const t = A.table(tableId);
  const add = additiveAxes(A);
  const axes = t.axes.filter((ax) => !ax.typed && add.has(ax.axis));
  if (!axes.length || !slices.length) return [];
  const have = new Map(slices.map((d) => [dimKey(d), d]));
  const rows = (S.tableView(tableId).lineItems || []).filter((l) => !l.abstract && SUMMABLE.has(A.dataType(l.concept)));
  const out = [];
  for (const P of slices) {
    for (const ax of axes) {
      const pm = memberOf(A, ax, P);
      const kids = ax.members.filter((m) => m.parent === pm).map((m) => m.member);
      const kidCols = kids.map((k) => ({ member: k, dims: withMember(A, ax, P, k) })).filter((k) => have.has(dimKey(k.dims)));
      if (!kidCols.length) continue;
      for (const l of rows) {
        const per = S.periodForCell(l.concept, scope, l.preferredLabel);
        if (!per) continue;
        const pf = filing.get(l.concept, per, P);
        if (!pf || pf.nil) continue;
        const kf = kidCols.map((k) => ({ ...k, fact: filing.get(l.concept, per, k.dims) })).filter((k) => k.fact && !k.fact.nil);
        if (!kf.length) continue;
        const decs = [pf, ...kf.map((k) => k.fact)].map((f) => (f.decimals == null || f.decimals === 'INF' ? null : Number(f.decimals))).filter((x) => x != null);
        const d = decs.length ? Math.min(...decs) : null;
        const sum = Dec.sum(kf.map((k) => Dec.parse(k.fact.value)));
        const pv = Dec.parse(pf.value);
        const a = d == null ? pv : Dec.round(pv, d), b = d == null ? sum : Dec.round(sum, d);
        const ok = Dec.eq(a, b);
        if (ok && !includeMatches) continue;
        out.push({ ok,
          tableId, scope, concept: l.concept, preferredLabel: l.preferredLabel || null, axis: ax.axis, parentMember: pm, parentDims: P,
          children: kf.map((k) => ({ member: k.member, dims: k.dims, value: k.fact.value })),
          missingChildren: kids.filter((k) => !kf.some((x) => x.member === k)),
          parentValue: pf.value, childrenSum: Dec.toString(sum), difference: Dec.toString(Dec.sub(pv, sum)), decimals: d,
          cellId: factKey(l.concept, per, P), rules: add.get(ax.axis),
        });
      }
    }
  }
  return out;
}

/** totals hints of every applicable table, both years */
export function allTotalsHints(S) {
  const A = S.A;
  const add = additiveAxes(A);
  const out = [];
  for (const t of A.tables) {
    if (!t.axes.some((ax) => !ax.typed && add.has(ax.axis))) continue;
    for (const scope of ['CY', 'PY']) {
      if (!S.tableStatus(t.id, scope).applicable) continue;
      const slices = tableSlices(A, S.filing, t.id, scope, reportingYear);
      if (slices.length) out.push(...totalsHints(S, t.id, scope, slices));
    }
  }
  return out;
}
