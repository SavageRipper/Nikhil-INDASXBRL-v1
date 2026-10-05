// Dimension engine + hypercube engine (XBRL Dimensions 1.0 semantics as used by MCA).
//
// Explicit/typed dimension checks:  axis exists, kind matches, member belongs to the axis
// domain and is usable, default member never reported (Filing Manual #30), no duplicate axis,
// typed member non-empty.
// Hypercube validity (Filing Manual #34/#35): a fact is dimensionally valid if
//   - its concept has no hypercubes and the context has no dimensions, or
//   - in at least one base set (ELR) every positive ("all") hypercube is satisfied and no
//     negative ("notAll") hypercube is satisfied.
// A hypercube is satisfied when every one of its dimensions is either present in the context with
// a usable domain member (explicit) / a value (typed), or absent and defaulted; when the arc is
// closed the context may not carry dimensions outside the hypercube.

export function checkDimensionSyntax(A, dims) {
  const errors = [];
  const seen = new Set();
  for (const d of dims) {
    const c = A.concept(d.axis);
    if (!c || (c.kind !== 'explicitAxis' && c.kind !== 'typedAxis')) { errors.push({ code: 'dim.unknownAxis', msg: `Unknown axis ${d.axis}` }); continue; }
    if (seen.has(d.axis)) errors.push({ code: 'dim.duplicateAxis', msg: `Axis ${d.axis} used more than once` });
    seen.add(d.axis);
    if (c.kind === 'typedAxis') {
      if (d.member) errors.push({ code: 'dim.typedAsExplicit', msg: `Typed axis ${d.axis} given an explicit member` });
      else if (d.typed == null || String(d.typed).trim() === '') errors.push({ code: 'dim.emptyTyped', msg: `Empty typed member for ${d.axis}` });
      continue;
    }
    if (d.typed != null) { errors.push({ code: 'dim.explicitAsTyped', msg: `Explicit axis ${d.axis} given a typed value` }); continue; }
    const m = A.concept(d.member);
    if (!m || m.kind !== 'member') { errors.push({ code: 'dim.unknownMember', msg: `Unknown member ${d.member}` }); continue; }
    const info = A.axisInfo(d.axis);
    const mi = info?.members.get(d.member);
    if (!mi) errors.push({ code: 'dim.memberNotInDomain', msg: `${d.member} is not a member of ${d.axis}` });
    else if (!mi.usable) errors.push({ code: 'dim.memberNotUsable', msg: `${d.member} is not usable on ${d.axis}` });
    if (A.dimensionDefault(d.axis) === d.member) errors.push({ code: 'dim.defaultReported', msg: `Default member ${d.member} of ${d.axis} must not appear in the instance` });
  }
  return errors;
}

function hcSatisfied(A, hc, dims, closed) {
  const byAxis = new Map(dims.map((d) => [d.axis, d]));
  const hcAxes = new Set(hc.axes.map((a) => a.axis));
  for (const ax of hc.axes) {
    const d = byAxis.get(ax.axis);
    if (!d) {
      // the default applies only if it belongs to this hypercube's domain for the dimension
      const def = !ax.typed && A.dimensionDefault(ax.axis);
      if (def && ax.members.some((m) => m.member === def)) continue;
      return { ok: false, why: `missing ${ax.axis}` };
    }
    if (ax.typed) {
      if (d.typed == null || String(d.typed).trim() === '') return { ok: false, why: `typed ${ax.axis} empty` };
      continue;
    }
    const m = ax.members.find((x) => x.member === d.member);
    if (!m || !m.usable) return { ok: false, why: `${d.member} not valid on ${ax.axis}` };
  }
  if (closed) for (const d of dims) if (!hcAxes.has(d.axis)) return { ok: false, why: `extra axis ${d.axis} on closed hypercube` };
  return { ok: true };
}

export function dimensionallyValid(A, concept, dims) {
  const baseSets = A.conceptHypercubes(concept);
  if (!baseSets.length) {
    return dims.length ? { valid: false, reason: `${concept} has no hypercube; context must not have dimensions (Filing Manual #35)` } : { valid: true, baseSet: null };
  }
  const reasons = [];
  for (const bs of baseSets) {
    const pos = bs.hypercubes.filter((h) => h.type === 'all');
    const negs = bs.hypercubes.filter((h) => h.type === 'notAll');
    if (!pos.length) { reasons.push(`${bs.elr}: no positive hypercube`); continue; }
    let ok = true;
    for (const h of pos) {
      const def = A.hypercube(h.hypercube, h.hcElr);
      const r = hcSatisfied(A, def, dims, h.closed);
      if (!r.ok) { ok = false; reasons.push(`${h.hypercube}: ${r.why}`); break; }
    }
    if (!ok) continue;
    let excluded = false;
    for (const h of negs) {
      const def = A.hypercube(h.hypercube, h.hcElr);
      if (hcSatisfied(A, def, dims, h.closed).ok) { excluded = true; reasons.push(`excluded by notAll ${h.hypercube}`); break; }
    }
    if (excluded) continue;
    return { valid: true, baseSet: bs.elr };
  }
  return { valid: false, reason: reasons.join('; ') || 'no base set accepts this context' };
}

// Is a concept reportable without dimensions (i.e. in the default context)?
export function nondimAllowed(A, concept) { return dimensionallyValid(A, concept, []).valid; }

// Does a dimensional fact belong to table t? Its concept is a line item of t and every axis of its context is an axis
// of t; a line item shared with another table whose axes are exactly the fact's axes belongs to that other table
// (TypeOfShare [EquityShares1Member] is a share-capital row of [400100], not a shareholder row of [400100a]).
export function factInTable(A, f, t) {
  if (!f.dims.length || !t.lineItems.includes(f.concept)) return false;
  if (!f.dims.every((d) => t.axes.some((x) => x.axis === d.axis))) return false;
  if (t.axes.length === f.dims.length) return true;
  return !A.tablesForConcept(f.concept).some((o) => o.id !== t.id && o.axes.length === f.dims.length && f.dims.every((d) => o.axes.some((x) => x.axis === d.axis)));
}

// Which table(s) does a dimensional fact belong to?
// A line item shared by several tables (e.g. TypeOfShare in the share-class table and in the
// shareholder table) belongs to the table whose axes match the context exactly, when one exists.
export function tablesForFact(A, fact) {
  if (!fact.dims.length) return [];
  const cands = A.tablesForConcept(fact.concept).filter((t) => {
    const axes = new Set(t.axes.map((a) => a.axis));
    return fact.dims.every((d) => axes.has(d.axis));
  });
  const exact = cands.filter((t) => t.axes.length === fact.dims.length);
  return exact.length ? exact : cands;
}

// GR-4 / Filing Manual #16 and §1.3.2(6): numbered members must be sequential (1..n, no gaps).
export function sequentialGaps(values) {
  const groups = new Map();
  for (const v of values) {
    // only names of the form <Prefix><n> (RelatedParty1, EquityShares2Member); bare codes such as an
    // ITC/NIC product code are identifiers, not sequence numbers
    const m = /^(.*?[A-Za-z_])(\d+)(Member)?$/.exec(v);
    if (!m) continue;
    const k = m[1] + '|' + (m[3] || '');
    (groups.get(k) || groups.set(k, new Set()).get(k)).add(Number(m[2]));
  }
  const gaps = [];
  for (const [k, nums] of groups) {
    const max = Math.max(...nums);
    for (let i = 1; i <= max; i++) if (!nums.has(i)) gaps.push({ prefix: k.split('|')[0], suffix: k.split('|')[1], missing: i, max });
  }
  return gaps;
}

// next sequential typed member value for an axis, e.g. RelatedParty3 after RelatedParty1..2
export function nextTypedMember(existing, prefix) {
  let max = 0;
  for (const v of existing) { const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`).exec(v); if (m) max = Math.max(max, Number(m[1])); }
  return `${prefix}${max + 1}`;
}
