// Taxonomy engine: read-only accessor over the compiled MCA authority model.
// The runtime never parses taxonomy files; everything comes from MCA_AUTHORITY.json.

const NUMERIC_BASES = new Set([
  'xbrli:monetaryItemType', 'xbrli:sharesItemType', 'xbrli:decimalItemType', 'xbrli:pureItemType',
  'num:percentItemType', 'num:perShareItemType', 'xbrli:integerItemType', 'xbrli:nonNegativeIntegerItemType',
  'xbrli:positiveIntegerItemType', 'xbrli:floatItemType', 'xbrli:doubleItemType',
]);

const LANG_TYPES = new Set(['xbrli:stringItemType', 'nonnum:textBlockItemType']);

export class Authority {
  constructor(json) {
    this.json = json;
    this.meta = json.meta;
    this.concepts = json.concepts;
    this.types = json.types;
    this.namespaces = json.namespaces;
    this.elrs = json.elrs;
    this.tables = json.tables;
    this.rules = json.businessRules;
    this.defaults = json.dimensionDefaults;
    this._tableById = new Map(json.tables.map((t) => [t.id, t]));
    this._elrByUri = new Map(json.elrs.map((e) => [e.uri, e]));
    this._elrByCode = new Map(json.elrs.map((e) => [e.code, e]));
    this._tablesByConcept = new Map();
    for (const t of json.tables) for (const q of t.lineItems) {
      (this._tablesByConcept.get(q) || this._tablesByConcept.set(q, []).get(q)).push(t);
    }
    this._axisInfo = null;
    this._presChildren = new Map();
    for (const [elr, arcs] of Object.entries(json.presentation)) {
      const m = new Map();
      for (const a of arcs) (m.get(a.from) || m.set(a.from, []).get(a.from)).push(a);
      for (const v of m.values()) v.sort((x, y) => x.order - y.order);
      this._presChildren.set(elr, m);
    }
    this._byLocal = new Map();
    for (const q of Object.keys(json.concepts)) this._byLocal.set(json.concepts[q].name, q);
  }

  // ---------- concepts
  concept(q) { return this.concepts[q] || null; }
  has(q) { return !!this.concepts[q]; }
  qnameOfLocal(local) { return this._byLocal.get(local) || null; }
  label(q, role = 'label') {
    const c = this.concepts[q];
    if (!c) return q;
    const L = c.labels || {};
    return L[role] || L.label || L.terseLabel || c.name;
  }
  baseType(q) {
    let t = this.concepts[q]?.type;
    const seen = new Set();
    while (t && this.types[t] && !seen.has(t)) { seen.add(t); t = this.types[t].base; }
    return t;
  }
  typeFacets(q) { const t = this.concepts[q]?.type; return (t && this.types[t]) || null; }
  enumerations(q) {
    let t = this.concepts[q]?.type;
    while (t && this.types[t]) { if (this.types[t].enumerations) return this.types[t].enumerations; t = this.types[t].base; }
    return null;
  }
  isNumeric(q) { return NUMERIC_BASES.has(this.baseType(q)); }
  isMonetary(q) { return this.baseType(q) === 'xbrli:monetaryItemType'; }
  dataType(q) {
    const b = this.baseType(q);
    const map = {
      'xbrli:monetaryItemType': 'monetary', 'xbrli:sharesItemType': 'shares', 'num:perShareItemType': 'perShare',
      'num:percentItemType': 'percent', 'xbrli:decimalItemType': 'decimal', 'xbrli:pureItemType': 'pure',
      'xbrli:dateItemType': 'date', 'xbrli:booleanItemType': 'boolean', 'nonnum:textBlockItemType': 'textBlock',
      'xbrli:tokenItemType': 'token', 'xbrli:stringItemType': 'string',
    };
    if (this.enumerations(q)) return 'enum';
    return map[b] || (this.isNumeric(q) ? 'decimal' : 'string');
  }
  // xml:lang is permitted only on the XBRL base text types, whose schema keeps the attribute wildcard. The
  // taxonomy's own types (in-ca-types:PANNumber, CINNumber, enumerations, …) are restrictions without a wildcard,
  // so xml:lang on them is invalid (MCA XBRL Validator: cvc-complex-type.3.2.2). The MCA-validated ICOM instance
  // carries xml:lang on no fact at all.
  langAllowed(q) { return LANG_TYPES.has(this.concepts[q]?.type); }
  isReportable(q) { const c = this.concepts[q]; return !!c && c.kind === 'item' && c.substitutionGroup === 'xbrli:item'; }

  // ---------- ELRs / presentation
  elr(uri) { return this._elrByUri.get(uri) || null; }
  elrByCode(code) { return this._elrByCode.get(code) || null; }
  presentationChildren(elr, from) { return this._presChildren.get(elr)?.get(from) || []; }
  conceptElrs(q) { return this.json.conceptElrs[q] || []; }

  // ---------- tables / dimensions
  table(id) { return this._tableById.get(id) || null; }
  tablesForConcept(q) { return this._tablesByConcept.get(q) || []; }
  tablesInElr(uri) { return this.tables.filter((t) => t.presentationElr === uri); }
  conceptHypercubes(q) { return this.json.conceptHypercubes[q] || []; }
  hypercube(hc, elr) { return this.json.hypercubes[`${hc}@${elr}`] || null; }
  dimensionDefault(axis) { return this.defaults[axis] || null; }
  isTypedAxis(axis) { return this.concepts[axis]?.kind === 'typedAxis'; }
  typedDomain(axis) { return this.concepts[axis]?.typedDomain || null; }

  // Union of every domain-member network declared for an axis across all hypercubes.
  axisInfo(axis) {
    if (!this._axisInfo) {
      this._axisInfo = new Map();
      for (const hc of Object.values(this.json.hypercubes)) for (const ax of hc.axes) {
        let info = this._axisInfo.get(ax.axis);
        if (!info) { info = { axis: ax.axis, typed: ax.typed, typedDomain: ax.typedDomain || null, members: new Map(), parents: new Map() }; this._axisInfo.set(ax.axis, info); }
        for (const m of ax.members || []) {
          const prev = info.members.get(m.member);
          info.members.set(m.member, { member: m.member, usable: (prev?.usable || false) || m.usable, depth: m.depth });
          if (m.parent && !info.parents.has(m.member)) info.parents.set(m.member, m.parent);
        }
      }
    }
    return this._axisInfo.get(axis) || null;
  }
  memberParent(axis, member) { return this.axisInfo(axis)?.parents.get(member) || null; }
  memberChildren(axisDef, member) { return (axisDef.members || []).filter((m) => m.parent === member).map((m) => m.member); }
}
