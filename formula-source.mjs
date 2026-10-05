// Formula linkbase reader (XBRL Formula 1.0, generic links). The Ind AS 2017 DTS ships one formula linkbase
// (ind-as/Formula/for_cro.xml, role "Cross period validations") with value assertions of the form
//   $beginningBalance + $change1 eq $endingBalance
// where beginningBalance / endingBalance bind the instant at the start / end of change1's duration
// (pf:instantDuration). Every assertion is read from the linkbase — nothing is listed by hand — and each one is
// classified: the cross-period form above is executable (rules.js, family "formula"); any other test expression is
// recorded as unsupported so the release gate sees it.
import path from 'node:path';

const NS = {
  gen: 'http://xbrl.org/2008/generic',
  va: 'http://xbrl.org/2008/assertion/value',
  variable: 'http://xbrl.org/2008/variable',
  cf: 'http://xbrl.org/2008/filter/concept',
  pf: 'http://xbrl.org/2008/filter/period',
  msg: 'http://xbrl.org/2010/message',
  link: 'http://www.xbrl.org/2003/linkbase',
  xlink: 'http://www.w3.org/1999/xlink',
};
const ARC = {
  variableSet: 'http://xbrl.org/arcrole/2008/variable-set',
  variableFilter: 'http://xbrl.org/arcrole/2008/variable-filter',
  message: 'http://xbrl.org/arcrole/2010/assertion-unsatisfied-message',
  severity: 'http://xbrl.org/arcrole/2016/assertion-unsatisfied-severity',
};
const xa = (el, local) => el.getAttributeNS(NS.xlink, local) || el.getAttribute('xlink:' + local) || '';
const list = (nl) => { const o = []; for (let i = 0; i < nl.length; i++) o.push(nl[i]); return o; };
const kids = (el) => { const o = []; for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) o.push(n); return o; };

export const CROSS_PERIOD_TEST = /^\$(\w+)\s*\+\s*\$(\w+)\s+eq\s+\$(\w+)$/;

export function parseFormulaLinkbases(dts, schema) {
  const assertions = [];
  const files = [];
  for (const { file, doc } of dts.linkbases) {
    const links = doc.getElementsByTagNameNS(NS.gen, 'link');
    if (!links.length) continue;
    const rel = dts.files.get(file).rel;
    files.push(rel);
    for (let li = 0; li < links.length; li++) {
      const link = links[li];
      const role = xa(link, 'role');
      const res = new Map(); // label -> element
      const locs = new Map(); // label -> href
      const arcs = [];
      for (const n of kids(link)) {
        const type = xa(n, 'type');
        if (type === 'resource') res.set(xa(n, 'label'), n);
        else if (type === 'locator') locs.set(xa(n, 'label'), xa(n, 'href'));
        else if (type === 'arc') arcs.push({ arcrole: xa(n, 'arcrole'), from: xa(n, 'from'), to: xa(n, 'to'), name: n.getAttribute('name'), order: Number(n.getAttribute('order') || 1), complement: n.getAttribute('complement') === 'true', cover: n.getAttribute('cover') !== 'false' });
      }
      const qnameOf = (prefixed, el) => {
        const [p, l] = prefixed.trim().split(':');
        const ns = el.lookupNamespaceURI(p);
        const pref = Object.entries(schema.namespaces).find(([, v]) => v === ns)?.[0];
        return pref ? `${pref}:${l}` : null;
      };
      for (const [label, el] of res) {
        if (el.namespaceURI !== NS.va || el.localName !== 'valueAssertion') continue;
        const id = el.getAttribute('id');
        const test = (el.getAttribute('test') || '').trim();
        const vars = {};
        const problems = [];
        for (const va of arcs.filter((a) => a.arcrole === ARC.variableSet && a.from === label)) {
          const v = res.get(va.to);
          if (!v || v.localName !== 'factVariable') { problems.push(`variable ${va.name} is not a fact variable`); continue; }
          if (v.getAttribute('fallbackValue')) vars[va.name] = { fallbackValue: v.getAttribute('fallbackValue') };
          const spec = vars[va.name] || (vars[va.name] = {});
          for (const fa of arcs.filter((a) => a.arcrole === ARC.variableFilter && a.from === va.to)) {
            const f = res.get(fa.to);
            if (!f) { problems.push(`filter ${fa.to} missing`); continue; }
            if (fa.complement) problems.push(`complemented filter on ${va.name}`);
            if (f.namespaceURI === NS.cf && f.localName === 'conceptName') {
              const qs = list(f.getElementsByTagNameNS(NS.cf, 'qname')).map((q) => qnameOf(q.textContent, q)).filter(Boolean);
              if (qs.length !== 1) problems.push(`conceptName filter on ${va.name} has ${qs.length} qnames`);
              spec.concept = qs[0];
            } else if (f.namespaceURI === NS.pf && f.localName === 'instantDuration') {
              spec.period = { boundary: f.getAttribute('boundary'), variable: f.getAttribute('variable') };
            } else problems.push(`unsupported filter ${f.localName}`);
          }
          if (!spec.concept) problems.push(`variable ${va.name} has no concept filter`);
          else if (!schema.concepts[spec.concept]) problems.push(`concept ${spec.concept} not in the DTS`);
        }
        const msgArc = arcs.find((a) => a.arcrole === ARC.message && a.from === label);
        const sevArc = arcs.find((a) => a.arcrole === ARC.severity && a.from === label);
        const severityHref = sevArc ? locs.get(sevArc.to) || '' : '';
        const m = CROSS_PERIOD_TEST.exec(test);
        let form = null;
        if (m) {
          const [, b, c, e] = m;
          const vb = vars[b], vc = vars[c], ve = vars[e];
          if (vb && vc && ve && vb.period?.boundary === 'start' && vb.period.variable === c && ve.period?.boundary === 'end' && ve.period.variable === c && !vc.period && vb.concept === ve.concept) {
            form = { kind: 'crossPeriod', balance: vb.concept, change: vc.concept };
          }
        }
        if (!form) problems.push(`test "${test}" is not the supported cross-period form`);
        assertions.push({
          id, file: rel, role, test, variables: vars,
          aspectModel: el.getAttribute('aspectModel'), implicitFiltering: el.getAttribute('implicitFiltering') === 'true',
          message: msgArc ? res.get(msgArc.to)?.textContent.trim() || null : null,
          severity: /#(\w+)$/.exec(severityHref)?.[1] || 'ERROR',
          form, problems,
        });
      }
    }
  }
  assertions.sort((a, b) => a.id.localeCompare(b.id));
  return { files: files.map((f) => path.basename(f)), assertions };
}
