// Assurance (v1.1, from C&I v12–v14): the tool must never leave the user with an error he cannot resolve himself (see
// assurance.mjs). Runs on the MCA-validated instances golden-*.xml at the repository root (kept out of the published
// repository): every count must stay at or below its ceiling in ASSURANCE_BASELINE.json (no regression); the "target"
// tests require 0 (reached in v1.2 with the v12 rules of handoff section B).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority } from './helpers.mjs';
import { rekey, mistakes, lockedCells, ruleLocations } from './assurance.mjs';
import { Session } from './session.js';

const A = authority();
const DIR = new URL('./', import.meta.url);
const goldens = readdirSync(DIR).filter((f) => /^golden-.*\.xml$/.test(f)).sort();
const CEIL = JSON.parse(readFileSync(new URL('ASSURANCE_BASELINE.json', DIR), 'utf8')).instances;
const xmlOf = (g) => readFileSync(new URL(g, DIR), 'utf8');
const atMost = (got, ceil, what) => assert.ok(got <= ceil, `${what}: ${got} > ceiling ${ceil} (regression)`);

test('every element named by an executable MCA rule locates to a cell or table, both years (empty filing and every MCA instance)', () => {
  const sessions = [new Session(A)];
  for (const g of goldens) { const s = new Session(A); s.importXml(xmlOf(g), { DOMParserImpl: DOMParser }); sessions.push(s); }
  const r = ruleLocations(A, sessions);
  assert.ok(r.checked > 4000, String(r.checked));
  assert.deepEqual(r.missing, []);
});

if (!goldens.length) test('assurance on MCA-validated instances', (t) => t.skip('no golden-<name>.xml at the repository root'));

for (const g of goldens) {
  const ceil = CEIL[g];
  if (!ceil) { test(`${g}: assurance ceilings`, (t) => t.skip('no ceilings recorded in ASSURANCE_BASELINE.json for this instance — record them first')); continue; }
  const runs = {};
  for (const [order, seed] of [['rank', 1], ['reverse', 1], ['random', 3]]) {
    test(`${g}: re-key through the screen (${order} order) — no regression`, () => {
      const r = (runs[order] = rekey(A, xmlOf(g), { order, seed, DOMParserImpl: DOMParser }));
      const c = ceil.rekey[order];
      atMost(r.differing.length, c.differing, 'values differing'); atMost(r.extra.length, c.extra, 'extra values');
      atMost(r.noCell.length, c.noCell, 'facts without a screen cell'); atMost(r.errors.length, c.errors, 'validation errors');
      if (c.notTypable != null) atMost(r.notTypable.length, c.notTypable, 'kept zeros that cannot be typed');
    });
  }
  test(`${g}: re-key target — identical values, every fact has a cell, no error`, () => {
    const r = runs.rank || rekey(A, xmlOf(g), { order: 'rank', seed: 1, DOMParserImpl: DOMParser });
    assert.equal(r.differing.length + r.extra.length + r.noCell.length + r.errors.length, 0);
  });
  let mres = null;
  test(`${g}: ${ceil.mistakes.n} mistakes through the screen — no regression in unreachable errors or failed undos`, () => {
    const r = (mres = mistakes(A, xmlOf(g), { n: ceil.mistakes.n, seed: ceil.mistakes.seed, DOMParserImpl: DOMParser }));
    assert.ok(r.made >= Math.floor(ceil.mistakes.made * 0.9), `mistakes made ${r.made}`);
    atMost(r.unreachable.length, ceil.mistakes.unreachable, 'errors without a reachable, editable location');
    atMost(r.notRestored.length, ceil.mistakes.notRestored, 'undos that did not restore the filing');
    atMost(r.restoreRefused.length, ceil.mistakes.restoreRefused, 'undos refused');
  });
  test(`${g}: mistakes target — every error reachable, every undo exact`, () => {
    const r = mres || mistakes(A, xmlOf(g), { n: ceil.mistakes.n, seed: ceil.mistakes.seed, DOMParserImpl: DOMParser });
    assert.deepEqual([...r.unreachable, ...r.notRestored, ...r.restoreRefused], []);
  });
  test(`${g}: 60 mistakes in a filing prepared for the next year (v1.3) — every error reachable, every undo exact`, () => {
    const r = mistakes(A, xmlOf(g), { n: 60, seed: 29, DOMParserImpl: DOMParser, yearMode: 'next' });
    assert.ok(r.made >= 30, `mistakes made ${r.made}`);
    assert.deepEqual([...r.unreachable, ...r.notRestored, ...r.restoreRefused], []);
  });
  let lres = null;
  test(`${g}: read-only (calculated) cells — no regression`, () => {
    const r = (lres = lockedCells(A, xmlOf(g), { DOMParserImpl: DOMParser }));
    assert.ok(r.locked > 100, String(r.locked));
    atMost(r.wrong.length, ceil.lockedCells.wrong, 'locked cells showing a value other than their calculation');
    atMost(r.empty.length, ceil.lockedCells.lockedEmpty, 'locked and empty cells');
  });
  test(`${g}: read-only cells target — each shows its calculation; none locked and empty`, () => {
    const r = lres || lockedCells(A, xmlOf(g), { DOMParserImpl: DOMParser });
    assert.deepEqual([...r.wrong, ...r.empty], []);
  });
}
