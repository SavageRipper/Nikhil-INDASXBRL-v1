// Derives the dimensional model (hypercubes, axes, domains, members, defaults,
// tables, line items, base sets) from the effective definition relationships.
// Nothing here is table-specific: every structure is discovered from arcs.
import { ARC } from './dts.mjs';

export function indexArcs(arcs) {
  const idx = new Map(); // `${arcrole}|${elr}|${from}` -> arcs sorted by order
  for (const a of arcs) {
    const k = `${a.arcrole}|${a.elr}|${a.from}`;
    (idx.get(k) || idx.set(k, []).get(k)).push(a);
  }
  for (const v of idx.values()) v.sort((x, y) => x.order - y.order);
  return (arcrole, elr, from) => idx.get(`${arcrole}|${elr}|${from}`) || [];
}

// Walk a domain-member network with XDT consecutive-relationship semantics
// (targetRole switches the ELR used for the next hop).
function walkDomain(rel, root, elr, visit, depth = 0, seen = new Set()) {
  for (const arc of rel(ARC.domMem, elr, root)) {
    const key = `${elr}|${arc.from}|${arc.to}`;
    if (seen.has(key)) continue; // cycle / duplicate-edge guard
    seen.add(key);
    visit(arc, depth + 1);
    walkDomain(rel, arc.to, arc.targetRole || elr, visit, depth + 1, seen);
  }
}

export function buildDimensionalModel({ defArcs, concepts, roleCode }) {
  const rel = indexArcs(defArcs);
  const defaults = {};
  for (const a of defArcs) if (a.arcrole === ARC.dimDefault) defaults[a.from] = a.to;

  // hypercube definition in a given ELR (targetRole of the has-hypercube arc)
  const hcCache = new Map();
  function hypercube(hc, hcElr) {
    const key = hc + '|' + hcElr;
    if (hcCache.has(key)) return hcCache.get(key);
    const axes = [];
    for (const hd of rel(ARC.hcDim, hcElr, hc)) {
      const axis = hd.to;
      const c = concepts[axis];
      const dimElr = hd.targetRole || hcElr;
      if (c.typedDomain) {
        axes.push({ axis, typed: true, typedDomain: c.typedDomain, order: hd.order });
        continue;
      }
      const members = []; // {member, parent, depth, usable, order}
      const domains = [];
      for (const dd of rel(ARC.dimDom, dimElr, axis)) {
        const domElr = dd.targetRole || dimElr;
        const domUsable = dd.usable !== false;
        domains.push(dd.to);
        members.push({ member: dd.to, parent: null, depth: 0, usable: domUsable, order: dd.order });
        walkDomain(rel, dd.to, domElr, (arc, depth) => {
          members.push({ member: arc.to, parent: arc.from, depth, usable: arc.usable !== false, order: arc.order });
        });
      }
      axes.push({ axis, typed: false, domains, members, default: defaults[axis] || null, order: hd.order });
    }
    const out = { hypercube: hc, elr: hcElr, axes };
    hcCache.set(key, out);
    return out;
  }

  // has-hypercube arcs
  const hasHc = defArcs.filter((a) => a.arcrole === ARC.all || a.arcrole === ARC.notAll);
  // base sets: per ELR, the hypercubes attached to each primary item
  const baseSets = {}; // elr -> { primary -> [ {type, hypercube, hcElr, closed, contextElement} ] }
  for (const a of hasHc) {
    ((baseSets[a.elr] ||= {})[a.from] ||= []).push({
      type: a.arcrole === ARC.all ? 'all' : 'notAll',
      hypercube: a.to,
      hcElr: a.targetRole || a.elr,
      closed: a.closed === true,
      contextElement: a.contextElement || 'scenario',
      order: a.order,
    });
  }

  // For each concept: list of base sets (ELR) with inherited hypercubes.
  // Inheritance: hypercubes declared on a primary item apply to all of its
  // domain-member descendants in the same ELR (following targetRole hops).
  const conceptHypercubes = {}; // qname -> [{elr, hypercubes:[{type,hypercube,hcElr,closed,contextElement}]}]
  for (const [elr, prims] of Object.entries(baseSets)) {
    const acc = {}; // concept -> list
    const add = (q, list) => { (acc[q] ||= []).push(...list); };
    for (const [primary, hcs] of Object.entries(prims)) {
      add(primary, hcs);
      walkDomain(rel, primary, elr, (arc) => add(arc.to, hcs));
    }
    for (const [q, list] of Object.entries(acc)) {
      // de-duplicate identical hypercube refs
      const seen = new Set();
      const uniq = list.filter((h) => { const k = h.type + h.hypercube + h.hcElr; if (seen.has(k)) return false; seen.add(k); return true; });
      (conceptHypercubes[q] ||= []).push({ elr, hypercubes: uniq });
    }
  }

  // Tables: one per positive (all) has-hypercube arc.
  const tables = [];
  for (const a of hasHc.filter((x) => x.arcrole === ARC.all)) {
    const hc = hypercube(a.to, a.targetRole || a.elr);
    // line items: domain-member descendants of the primary item in the base ELR
    const tree = [];
    walkDomain(rel, a.from, a.elr, (arc, depth) => tree.push({ concept: arc.to, parent: arc.from, depth, order: arc.order }));
    const lineItems = tree.filter((n) => !concepts[n.concept].abstract).map((n) => n.concept);
    const lineItemNodes = tree.filter((n) => concepts[n.concept].abstract && /LineItems$/.test(concepts[n.concept].name)).map((n) => n.concept);
    // negative hypercubes that apply to line items in this base set
    const notAll = [];
    for (const [prim, hcs] of Object.entries(baseSets[a.elr] || {})) {
      if (prim !== a.from && !tree.some((n) => n.concept === prim)) continue;
      for (const h of hcs) if (h.type === 'notAll') {
        const nh = hypercube(h.hypercube, h.hcElr);
        const affected = [prim];
        walkDomain(rel, prim, a.elr, (arc) => affected.push(arc.to));
        notAll.push({ hypercube: h.hypercube, elr: h.hcElr, primary: prim, appliesTo: affected.filter((q) => !concepts[q].abstract), axes: nh.axes.map((x) => ({ axis: x.axis, members: x.typed ? null : x.members.map((m) => m.member) })) });
      }
    }
    tables.push({
      id: `${roleCode(a.elr)}:${concepts[a.to].name}`,
      elr: a.elr,
      code: roleCode(a.elr),
      hypercube: a.to,
      primaryItem: a.from,
      closed: a.closed === true,
      contextElement: a.contextElement || 'scenario',
      axes: hc.axes,
      lineItemNodes,
      lineItemTree: tree,
      lineItems,
      notAll,
    });
  }
  // catalogue of every hypercube referenced by any base set
  const hypercubes = {};
  for (const prims of Object.values(baseSets)) for (const hcs of Object.values(prims)) for (const h of hcs) {
    const d = hypercube(h.hypercube, h.hcElr);
    hypercubes[`${h.hypercube}@${h.hcElr}`] = d;
  }
  return { defaults, baseSets, conceptHypercubes, tables, hypercubes };
}
