// Independent fact-level comparison of two XBRL instances (source vs regenerated), using only an XML parser — not the
// app's importer: every fact is reduced to (concept, period, explicit/typed dimensions, unit measures, decimals,
// value) with contexts and units resolved by id. Numeric values compare numerically; text compares after XML decoding.
import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const XBRLI = 'http://www.xbrl.org/2003/instance', XBRLDI = 'http://xbrl.org/2006/xbrldi';
const kids = (n) => Array.from(n.childNodes || []).filter((x) => x.nodeType === 1);
const txt = (n) => (n.textContent || '').trim();
function qn(node, prefixed) {
  const [p, l] = prefixed.includes(':') ? prefixed.split(':') : ['', prefixed];
  return `{${node.lookupNamespaceURI(p || null)}}${l}`;
}
export function facts(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  const ctx = new Map(), unit = new Map(), out = new Map();
  for (const c of kids(root).filter((x) => x.namespaceURI === XBRLI && x.localName === 'context')) {
    const per = kids(c).find((x) => x.localName === 'period');
    const pp = kids(per);
    const p = pp[0].localName === 'instant' ? `I:${txt(pp[0])}` : pp[0].localName === 'forever' ? 'F' : `D:${txt(pp.find((x) => x.localName === 'startDate'))}/${txt(pp.find((x) => x.localName === 'endDate'))}`;
    const scen = kids(c).find((x) => x.localName === 'scenario');
    const dims = scen ? kids(scen).map((d) => d.namespaceURI === XBRLDI && d.localName === 'explicitMember' ? `${qn(d, d.getAttribute('dimension'))}=${qn(d, txt(d))}` : `${qn(d, d.getAttribute('dimension'))}~${txt(kids(d)[0] || d)}`).sort() : [];
    ctx.set(c.getAttribute('id'), `${p}#${dims.join('&')}`);
  }
  for (const u of kids(root).filter((x) => x.namespaceURI === XBRLI && x.localName === 'unit')) {
    const div = kids(u).find((x) => x.localName === 'divide');
    const m = (n) => kids(n).filter((x) => x.localName === 'measure').map((x) => qn(x, txt(x))).sort().join('*');
    unit.set(u.getAttribute('id'), div ? `${m(kids(div)[0])}/${m(kids(div)[1])}` : m(u));
  }
  for (const f of kids(root)) {
    if (!f.hasAttribute('contextRef')) continue;
    const concept = `{${f.namespaceURI}}${f.localName}`;
    const nil = f.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') === 'true';
    const u = f.hasAttribute('unitRef') ? unit.get(f.getAttribute('unitRef')) : '';
    const dec = f.hasAttribute('decimals') ? f.getAttribute('decimals') : '';
    let v = nil ? '(nil)' : f.textContent;
    if (u && !nil) v = String(Number(v.trim()));
    const key = `${concept}|${ctx.get(f.getAttribute('contextRef'))}`;
    if (out.has(key)) throw new Error(`duplicate fact ${key}`);
    out.set(key, { u, dec, v });
  }
  return out;
}
export function diff(a, b) {
  const onlyA = [], onlyB = [], changed = [];
  for (const [k, x] of a) { const y = b.get(k); if (!y) onlyA.push(k); else if (x.u !== y.u || x.dec !== y.dec || x.v !== y.v) changed.push({ k, a: x, b: y }); }
  for (const k of b.keys()) if (!a.has(k)) onlyB.push(k);
  return { onlyA, onlyB, changed, a: a.size, b: b.size };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const d = diff(facts(readFileSync(process.argv[2], 'utf8')), facts(readFileSync(process.argv[3], 'utf8')));
  console.log(JSON.stringify({ a: d.a, b: d.b, onlyA: d.onlyA.length, onlyB: d.onlyB.length, changed: d.changed.length }));
  for (const k of d.onlyA) console.log('  only in first :', k);
  for (const k of d.onlyB) console.log('  only in second:', k);
  for (const c of d.changed.slice(0, 20)) console.log('  changed:', c.k, JSON.stringify(c.a).slice(0, 200), '→', JSON.stringify(c.b).slice(0, 200));
}
