// Footnote editing helpers (footnotes.js) over Filing.footnotes. Runs without the XML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Authority } from './authority.js';
import { Session } from './session.js';
import { Filing } from './model.js';
import { listFootnotes, footnotesOf, addFootnote, updateFootnoteText, linkFootnote, unlinkFootnote, removeFootnote } from './footnotes.js';

const A = new Authority(JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url))));
const q = (local) => { const r = A.qnameOfLocal(local); assert.ok(r, 'no concept ' + local); return r; };
const T = '401100f:ClassificationOfInventoriesTable';
const RAW = [{ axis: q('ClassificationOfInventoriesAxis'), member: q('RawMaterialsMember') }];

function filingWithValue() {
  const s = new Session(A);
  s.setMeta({ name: 'Test Co', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0,
    periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } } });
  s.setTableValue(T, 'CY', RAW, q('Inventories'), '100');
  const concept = q('Inventories');
  const fact = s.filing.get(concept, s.filing.period(concept, 'CY'), RAW);
  assert.ok(fact, 'value stored');
  return { s, filing: s.filing, key: fact.key };
}

test('a footnote needs text and can only be attached to a cell with a value', () => {
  const { filing, key } = filingWithValue();
  assert.throws(() => addFootnote(filing, '   ', []), /empty/);
  assert.throws(() => addFootnote(filing, 'Note', ['no-such-cell']), /only be attached to a cell that has a value/);
  const id = addFootnote(filing, 'Includes goods in transit', [key]);
  assert.deepEqual(listFootnotes(filing).map((f) => [f.id, f.text, f.factKeys]), [[id, 'Includes goods in transit', [key]]]);
});

test('link, unlink, edit and remove', () => {
  const { filing, key } = filingWithValue();
  const id = addFootnote(filing, 'First', []);
  assert.deepEqual(listFootnotes(filing)[0].factKeys, [], 'unlinked footnote is kept');
  linkFootnote(filing, id, key);
  assert.equal(footnotesOf(filing, key).length, 1);
  unlinkFootnote(filing, id, key);
  assert.equal(footnotesOf(filing, key).length, 0);
  linkFootnote(filing, id, key);
  updateFootnoteText(filing, id, '  Edited text  ');
  assert.equal(listFootnotes(filing)[0].text, 'Edited text');
  assert.throws(() => updateFootnoteText(filing, id, ''), /empty/);
  removeFootnote(filing, id);
  assert.equal(listFootnotes(filing).length, 0);
});

test('a footnote whose cell has been removed is listed without that cell', () => {
  const { filing, key } = filingWithValue();
  const id = addFootnote(filing, 'Stale link', [key]);
  filing.removeFact(key);
  assert.deepEqual(listFootnotes(filing).find((f) => f.id === id).factKeys, []);
});

test('footnotes and their links survive a project save and reload', () => {
  const { filing, key } = filingWithValue();
  const id = addFootnote(filing, 'Persisted', [key]);
  const reloaded = Filing.fromJSON(A, JSON.parse(JSON.stringify(filing.toJSON())));
  assert.deepEqual(listFootnotes(reloaded).map((f) => [f.id, f.text, f.factKeys]), [[id, 'Persisted', [key]]]);
});

test('after deleting a footnote, a new one never reuses an existing footnote id', () => {
  const { filing } = filingWithValue();
  const a = addFootnote(filing, 'one', []);
  const b = addFootnote(filing, 'two', []);
  removeFootnote(filing, a);
  const c = addFootnote(filing, 'three', []);
  assert.notEqual(c, b);
  assert.deepEqual(listFootnotes(filing).map((f) => f.id).sort(), [b, c].sort());
  assert.equal(listFootnotes(filing).find((f) => f.id === b).text, 'two');
});
