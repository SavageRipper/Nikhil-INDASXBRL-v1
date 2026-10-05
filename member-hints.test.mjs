// Table-column guidance (member-hints.js): where a member sits in its axis, column order, and total-versus-parts hints.
// Display guidance only; these tests do not touch validation or XML. No XML parser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Authority } from './authority.js';
import { Session } from './session.js';
import { memberInfo, sortSlices, totalsHints } from './member-hints.js';

const A = new Authority(JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url))));
const q = (local) => { const r = A.qnameOfLocal(local); assert.ok(r, 'no concept ' + local); return r; };
const local = (qn) => String(qn).split(':').pop();

// Table with an additive share-class axis: the default member (EquitySharesMember) is the total and
// EquityShares1Member … are its parts. The MCA rules add up ValueOfSharesAuthorised across these classes.
const T = '400100:DisclosureOfClassesOfEquityShareCapitalTable';
const AX = q('ClassesOfEquityShareCapitalAxis');
const part = (n) => [{ axis: AX, member: q(`EquityShares${n}Member`) }];

function sessionWithTotal(total) {
  const s = new Session(A);
  s.setMeta({ name: 'Test Co', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0,
    periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } } });
  s.setValue(q('EquityShareCapital'), 'CY', '1000'); // the table applies when balance-sheet share capital is entered
  s.setTableValue(T, 'CY', part(1), q('ValueOfSharesAuthorised'), '100');
  s.setTableValue(T, 'CY', part(2), q('ValueOfSharesAuthorised'), '50');
  if (total !== null) s.setTableValue(T, 'CY', [], q('ValueOfSharesAuthorised'), total);
  return s;
}

test('memberInfo: the default member is the total of its children; a child points to its total', () => {
  const tax = A.table(T).axes.find((a) => a.axis === AX);
  const total = memberInfo(A, tax, q('EquitySharesMember'));
  assert.equal(total.isTotal, true);
  assert.equal(total.isDefault, true);
  assert.ok(total.children.includes(q('EquityShares1Member')));
  const child = memberInfo(A, tax, q('EquityShares1Member'));
  assert.equal(child.isTotal, false);
  assert.equal(child.parent, q('EquitySharesMember'));
});

test('sortSlices: each total column comes before its parts, whatever order they were entered in', () => {
  const slices = [part(2), part(1), []];
  assert.deepEqual(sortSlices(A, T, slices).map((d) => d.map((x) => local(x.member))), [[], ['EquityShares1Member'], ['EquityShares2Member']]);
});

test('totalsHints: a total equal to the sum of its parts is reported only when matches are asked for', () => {
  const s = sessionWithTotal('150');
  const slices = s.openTable(T, 'CY').slices;
  assert.deepEqual(totalsHints(s, T, 'CY', slices), [], 'no warning for a total that adds up');
  const all = totalsHints(s, T, 'CY', slices, { includeMatches: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].ok, true);
  assert.equal(all[0].concept, q('ValueOfSharesAuthorised'));
});

test('totalsHints: a total that differs from the sum of its parts is flagged', () => {
  const s = sessionWithTotal('999');
  const slices = s.openTable(T, 'CY').slices;
  const hints = totalsHints(s, T, 'CY', slices);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].ok, false);
});
