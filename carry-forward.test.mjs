// "Copy from previous year" (carry-forward.js) on the compiled Ind AS authority. No XML parser needed, so this file
// runs in the unit suite without the DOM-based helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Authority } from './authority.js';
import { Session } from './session.js';
import { carryForwardPlan, carryForward } from './carry-forward.js';

const A = new Authority(JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url))));
const q = (local) => { const r = A.qnameOfLocal(local); assert.ok(r, 'no concept ' + local); return r; };
const T = '401100f:ClassificationOfInventoriesTable'; // one axis, numeric and text line items
const RAW = [{ axis: q('ClassificationOfInventoriesAxis'), member: q('RawMaterialsMember') }];
const FIN = [{ axis: q('ClassificationOfInventoriesAxis'), member: q('FinishedGoodsMember') }];

function session() {
  const s = new Session(A);
  s.setMeta({ name: 'Test Co', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0,
    periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } } });
  return s;
}

test('copies missing previous-year values and columns, never overwrites current-year values', () => {
  const s = session();
  s.setTableValue(T, 'PY', RAW, q('Inventories'), '100');
  s.setTableValue(T, 'PY', RAW, q('GoodsInTransit'), '5');
  s.setTableValue(T, 'PY', FIN, q('Inventories'), '200');
  s.setTableValue(T, 'CY', FIN, q('Inventories'), '999'); // already entered this year

  const plan = carryForwardPlan(s, T);
  assert.equal(plan.available, true);
  assert.equal(plan.newColumns.length, 1, 'only the raw-materials column is missing in the current year');
  assert.equal(plan.values, 2, 'the two raw-materials values; the finished-goods value is already entered');

  const res = carryForward(s, T, { values: true });
  assert.equal(res.copied, 2);
  assert.equal(res.skipped, 0);
  assert.equal(s.filing.value(q('Inventories'), 'CY', RAW), '100');
  assert.equal(s.filing.value(q('GoodsInTransit'), 'CY', RAW), '5');
  assert.equal(s.filing.value(q('Inventories'), 'CY', FIN), '999', 'existing current-year value kept');
  assert.equal(s.filing.value(q('Inventories'), 'PY', RAW), '100', 'previous year untouched');
});

test('a second run has nothing left to copy', () => {
  const s = session();
  s.setTableValue(T, 'PY', RAW, q('Inventories'), '100');
  carryForward(s, T, { values: true });
  const plan = carryForwardPlan(s, T);
  assert.equal(plan.newColumns.length, 0);
  assert.equal(plan.values, 0);
  assert.deepEqual(carryForward(s, T, { values: true }), { columns: [], copied: 0, skipped: 0 });
});

test('no previous-year figures: nothing to copy, with a reason', () => {
  const s = session();
  const plan = carryForwardPlan(s, T);
  assert.equal(plan.available, false);
  assert.match(plan.reason, /previous-year table/);
  assert.deepEqual(carryForward(s, T, { values: true }), { columns: [], copied: 0, skipped: 0 });
});
