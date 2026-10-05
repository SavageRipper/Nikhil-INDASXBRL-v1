import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { Authority } from './authority.js';
import { Session } from './session.js';

let _A = null;
export function authority() {
  if (!_A) _A = new Authority(JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url))));
  return _A;
}
export const XMLParser = DOMParser;
export const q = (local) => { const r = authority().qnameOfLocal(local); if (!r) throw new Error('no concept ' + local); return r; };
export const CIN = 'U72200KA2010PTC123456';

// A minimal valid standalone filing (FY 2017-18 with comparative 2016-17)
export function newSession(meta = {}) {
  const s = new Session(authority());
  s.setMeta({ name: 'Test Co', cin: CIN, reportType: 'Standalone', level: 'Actual', displayPlaces: 0,
    periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } }, ...meta });
  return s;
}
export function importSession(xml) {
  const s = new Session(authority());
  const report = s.importXml(xml, { DOMParserImpl: DOMParser });
  return { s, report };
}
