// Footnotes (XBRL 2.1 §4.11 footnoteLink, fact-footnote arcs) — editing helpers over Filing.footnotes.
// The generator already writes footnotes (generator.js); this module only adds/edits/links/unlinks them.
const touch = (filing) => { filing.revision++; };

export function listFootnotes(filing) {
  return [...filing.footnotes.values()].map((f) => ({ id: f.id, text: f.text, lang: f.lang || 'en', factKeys: [...f.factKeys].filter((k) => filing.facts.has(k)) }));
}
export function footnotesOf(filing, factKey) {
  return [...filing.footnotes.values()].filter((f) => f.factKeys.has(factKey));
}
export function addFootnote(filing, text, factKeys = []) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('Footnote text is empty');
  for (const k of factKeys) { const f = filing.facts.get(k); if (!f || (f.value === '' && !f.nil)) throw new Error('A footnote can only be attached to a cell that has a value'); }
  return filing.addFootnote(t, factKeys, 'en');
}
export function updateFootnoteText(filing, id, text) {
  const fn = filing.footnotes.get(id); if (!fn) throw new Error('No such footnote');
  const t = String(text ?? '').trim(); if (!t) throw new Error('Footnote text is empty');
  fn.text = t; touch(filing);
}
export function linkFootnote(filing, id, factKey) {
  const fn = filing.footnotes.get(id); if (!fn) throw new Error('No such footnote');
  if (!filing.facts.has(factKey)) throw new Error('A footnote can only be attached to a cell that has a value');
  fn.factKeys.add(factKey); touch(filing);
}
export function unlinkFootnote(filing, id, factKey) {
  const fn = filing.footnotes.get(id); if (!fn) return;
  fn.factKeys.delete(factKey); touch(filing);
}
export function removeFootnote(filing, id) { if (filing.footnotes.delete(id)) touch(filing); }
