// DTS loader: discovers the Discoverable Taxonomy Set from the MCA entry point
// and parses schemas + linkbases into neutral, provenance-tagged records.
// Only local files are loaded; remote XBRL spec schemas (xbrl.org) are recorded
// as external references, never fetched.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

export const NS = {
  xsd: 'http://www.w3.org/2001/XMLSchema',
  link: 'http://www.xbrl.org/2003/linkbase',
  xlink: 'http://www.w3.org/1999/xlink',
  xbrli: 'http://www.xbrl.org/2003/instance',
  xbrldt: 'http://xbrl.org/2005/xbrldt',
};

const ARC = {
  all: 'http://xbrl.org/int/dim/arcrole/all',
  notAll: 'http://xbrl.org/int/dim/arcrole/notAll',
  hcDim: 'http://xbrl.org/int/dim/arcrole/hypercube-dimension',
  dimDom: 'http://xbrl.org/int/dim/arcrole/dimension-domain',
  domMem: 'http://xbrl.org/int/dim/arcrole/domain-member',
  dimDefault: 'http://xbrl.org/int/dim/arcrole/dimension-default',
  parentChild: 'http://www.xbrl.org/2003/arcrole/parent-child',
  summation: 'http://www.xbrl.org/2003/arcrole/summation-item',
  conceptLabel: 'http://www.xbrl.org/2003/arcrole/concept-label',
  conceptRef: 'http://www.xbrl.org/2003/arcrole/concept-reference',
};
export { ARC };

const isRemote = (href) => /^https?:/i.test(href);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function elementsNS(node, ns, local) {
  const out = [];
  const list = node.getElementsByTagNameNS(ns, local);
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}
const xa = (el, local) => el.getAttributeNS(NS.xlink, local) || el.getAttribute('xlink:' + local) || '';

export function loadDTS(entryFile) {
  const root = path.dirname(entryFile);
  const files = new Map(); // abs path -> {rel, kind, sha256, bytes}
  const external = new Set();
  const schemas = []; // {file, doc}
  const linkbases = []; // {file, doc}
  const queue = [{ file: path.resolve(entryFile), kind: 'schema' }];
  const parser = new DOMParser({ onError: (lvl, msg) => { if (lvl !== 'warning') throw new Error(msg); } });

  while (queue.length) {
    const { file, kind } = queue.shift();
    if (files.has(file)) continue;
    if (!existsSync(file)) throw new Error(`DTS file missing: ${file}`);
    const buf = readFileSync(file);
    const doc = parser.parseFromString(buf.toString('utf8').replace(/^﻿/, ''), 'text/xml');
    files.set(file, { rel: path.relative(root, file).split(path.sep).join('/'), kind, sha256: sha256(buf), bytes: buf.length });
    const base = path.dirname(file);
    const enqueue = (href, k) => {
      if (!href) return;
      const target = href.split('#')[0];
      if (!target) return;
      if (isRemote(target)) { external.add(target); return; }
      queue.push({ file: path.resolve(base, target), kind: k });
    };
    if (kind === 'schema') {
      schemas.push({ file, doc });
      for (const tag of ['import', 'include']) for (const el of elementsNS(doc, NS.xsd, tag)) enqueue(el.getAttribute('schemaLocation'), 'schema');
      for (const el of elementsNS(doc, NS.link, 'linkbaseRef')) enqueue(xa(el, 'href'), 'linkbase');
    } else {
      linkbases.push({ file, doc });
      for (const el of elementsNS(doc, NS.link, 'loc')) enqueue(xa(el, 'href'), 'schema');
      for (const el of elementsNS(doc, NS.link, 'roleRef')) enqueue(xa(el, 'href'), 'schema');
    }
  }
  return { root, files, external: [...external].sort(), schemas, linkbases };
}

// ---------------- schemas ----------------
export function parseSchemas(dts) {
  const concepts = {}; // qname -> concept
  const byId = {}; // `${absFile}#${id}` -> qname
  const types = {}; // qname of type -> {base, enumerations, pattern, length, minLength, maxLength}
  const roles = {}; // roleURI -> {id, definition, usedOn}
  const namespaces = {}; // prefix -> ns
  for (const { file, doc } of dts.schemas) {
    const schema = doc.documentElement;
    const tns = schema.getAttribute('targetNamespace');
    // derive the taxonomy prefix from xmlns declarations matching targetNamespace
    let prefix = null;
    for (let i = 0; i < schema.attributes.length; i++) {
      const a = schema.attributes[i];
      if (a.name.startsWith('xmlns:') && a.value === tns) prefix = a.name.slice(6);
    }
    if (prefix) namespaces[prefix] = tns;
    const rel = dts.files.get(file).rel;
    // types (complexType simpleContent restrictions)
    for (const ct of elementsNS(doc, NS.xsd, 'complexType')) {
      const name = ct.getAttribute('name');
      if (!name || !prefix) continue;
      const restr = elementsNS(ct, NS.xsd, 'restriction')[0];
      if (!restr) continue;
      const t = { base: restr.getAttribute('base'), source: rel };
      const enums = elementsNS(restr, NS.xsd, 'enumeration').map((e) => e.getAttribute('value'));
      if (enums.length) t.enumerations = enums;
      for (const facet of ['pattern', 'length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits', 'minInclusive', 'maxInclusive']) {
        const f = elementsNS(restr, NS.xsd, facet)[0];
        if (f) t[facet] = f.getAttribute('value');
      }
      types[`${prefix}:${name}`] = t;
    }
    // concepts: top-level xsd:element children
    for (let n = schema.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1 || n.localName !== 'element' || n.namespaceURI !== NS.xsd) continue;
      const name = n.getAttribute('name');
      const id = n.getAttribute('id');
      const qn = `${prefix}:${name}`;
      const c = {
        qname: qn,
        name,
        prefix,
        namespace: tns,
        id,
        type: n.getAttribute('type') || null,
        substitutionGroup: n.getAttribute('substitutionGroup') || null,
        periodType: n.getAttributeNS(NS.xbrli, 'periodType') || n.getAttribute('xbrli:periodType') || null,
        balance: n.getAttributeNS(NS.xbrli, 'balance') || n.getAttribute('xbrli:balance') || null,
        abstract: n.getAttribute('abstract') === 'true',
        nillable: n.getAttribute('nillable') === 'true',
        source: rel,
      };
      const tdr = n.getAttributeNS(NS.xbrldt, 'typedDomainRef') || n.getAttribute('xbrldt:typedDomainRef');
      if (tdr) c.typedDomainRef = tdr;
      concepts[qn] = c;
      if (id) byId[`${file}#${id}`] = qn;
    }
    // roles
    for (const rt of elementsNS(doc, NS.link, 'roleType')) {
      const def = elementsNS(rt, NS.link, 'definition')[0];
      roles[rt.getAttribute('roleURI')] = {
        id: rt.getAttribute('id'),
        definition: def ? def.textContent.trim() : '',
        usedOn: elementsNS(rt, NS.link, 'usedOn').map((u) => u.textContent.trim()),
        source: rel,
      };
    }
  }
  // resolve typedDomainRef -> concept qname
  for (const c of Object.values(concepts)) {
    if (!c.typedDomainRef) continue;
    const schemaFile = dts.schemas.find((s) => dts.files.get(s.file).rel === c.source).file;
    const [f, frag] = c.typedDomainRef.split('#');
    const target = f ? path.resolve(path.dirname(schemaFile), f) : schemaFile;
    const qn = byId[`${target}#${frag}`];
    if (!qn) throw new Error(`Unresolved typedDomainRef ${c.typedDomainRef} on ${c.qname}`);
    c.typedDomain = qn;
  }
  return { concepts, byId, types, roles, namespaces };
}

// ---------------- linkbases ----------------
// Returns the effective relationship set after XBRL 2.1 prohibition/override
// (equivalent relationships resolved by priority; prohibited winners removed).
export function parseLinkbases(dts, schemaInfo) {
  const raw = []; // arcs
  const labels = {}; // qname -> {roleShort: text}
  const references = {}; // qname -> [ {part:value} ]
  for (const { file, doc } of dts.linkbases) {
    const rel = dts.files.get(file).rel;
    const base = path.dirname(file);
    const ext = [];
    for (const local of ['presentationLink', 'calculationLink', 'definitionLink', 'labelLink', 'referenceLink']) ext.push(...elementsNS(doc, NS.link, local));
    for (const link of ext) {
      const elr = xa(link, 'role');
      const locs = {}; // label -> [qname]
      const resources = {}; // label -> [element]
      for (let n = link.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 1) continue;
        const type = xa(n, 'type');
        const lab = xa(n, 'label');
        if (type === 'locator') {
          const href = xa(n, 'href');
          const [f, frag] = href.split('#');
          const qn = schemaInfo.byId[`${path.resolve(base, f)}#${frag}`];
          if (!qn) throw new Error(`Unresolved locator ${href} in ${rel}`);
          (locs[lab] ||= []).push(qn);
        } else if (type === 'resource') {
          (resources[lab] ||= []).push(n);
        }
      }
      for (let n = link.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 1 || xa(n, 'type') !== 'arc') continue;
        const arcrole = xa(n, 'arcrole');
        const from = locs[xa(n, 'from')] || [];
        const toLab = xa(n, 'to');
        if (arcrole === ARC.conceptLabel) {
          for (const qn of from) for (const r of resources[toLab] || []) {
            const lang = r.getAttribute('xml:lang') || r.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang');
            if (lang && lang !== 'en') continue;
            const role = xa(r, 'role').split('/').pop();
            (labels[qn] ||= {})[role] = r.textContent.trim();
          }
          continue;
        }
        if (arcrole === ARC.conceptRef) {
          for (const qn of from) for (const r of resources[toLab] || []) {
            const parts = {};
            for (let p = r.firstChild; p; p = p.nextSibling) if (p.nodeType === 1) parts[p.localName] = p.textContent.trim();
            (references[qn] ||= []).push(parts);
          }
          continue;
        }
        const to = locs[toLab] || [];
        const attr = (name) => n.getAttribute(name);
        for (const f of from) for (const t of to) {
          const arc = {
            arcrole, elr, from: f, to: t,
            order: attr('order') !== '' && attr('order') != null ? Number(attr('order')) : 1,
            priority: Number(attr('priority') || 0),
            use: attr('use') || 'optional',
            source: rel,
          };
          if (n.localName === 'calculationArc') arc.weight = Number(attr('weight'));
          if (n.localName === 'presentationArc' && attr('preferredLabel')) arc.preferredLabel = attr('preferredLabel').split('/').pop();
          if (n.localName === 'definitionArc') {
            const g = (k) => n.getAttributeNS(NS.xbrldt, k) || n.getAttribute('xbrldt:' + k) || null;
            const tr = g('targetRole'); if (tr) arc.targetRole = tr;
            const cl = g('closed'); if (cl != null) arc.closed = cl === 'true';
            const ce = g('contextElement'); if (ce) arc.contextElement = ce;
            const us = g('usable'); if (us != null) arc.usable = us !== 'false';
          }
          arc.kind = n.localName;
          raw.push(arc);
        }
      }
    }
  }
  // prohibition / override
  const groups = new Map();
  for (const a of raw) {
    const k = [a.kind, a.arcrole, a.elr, a.from, a.to].join('|');
    (groups.get(k) || groups.set(k, []).get(k)).push(a);
  }
  const effective = [];
  let prohibitedCount = 0;
  for (const arr of groups.values()) {
    const maxP = Math.max(...arr.map((a) => a.priority));
    const top = arr.filter((a) => a.priority === maxP);
    if (top.some((a) => a.use === 'prohibited')) { prohibitedCount++; continue; }
    effective.push(top[0]);
  }
  return { arcs: effective, rawCount: raw.length, prohibitedCount, labels, references };
}
