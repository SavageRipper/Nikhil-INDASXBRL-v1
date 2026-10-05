// MCA HTML schema regression, carried over from the C&I tool's MCA Validator error file (BoD report text block):
//   cvc-complex-type.2.4.a … starting with element 'colgroup' … One of thead, tfoot, tbody, tr is expected
//   cvc-complex-type.3.2.2: Attribute 'colspan' is not allowed to appear in element 'td'
//   cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:PANOfShareholder'
// plus the PDF findings (pasted table without borders, columns truncated by &nbsp; number padding, highlighted
// whitespace rendered as shaded blocks) and XML-illegal control characters.
// Ind AS evidence: the MCA-validated ICOM 2022-23 instance uses only div/span/p/br/table/tbody/tr/td with class
// "bordered", and carries xml:lang on no fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { toMca, fromMca, plainText } from './richtext.js';
import { htmlGuidelineIssues } from './gate.js';
import { explainMcaErrors } from './mca-errors.js';
import { generateInstance } from './generator.js';
import { authority, newSession, importSession, q } from './helpers.mjs';

const A = authority();
const NB = (n) => '&nbsp;'.repeat(n);
const BOD = 'DisclosureInBoardOfDirectorsReportExplanatory';
const goldens = readdirSync(new URL('./', import.meta.url).pathname).filter((x) => /^golden-.*\.xml$/.test(x));
// Word/Excel clipboard table: colgroup/col, colspan + rowspan, style/width/align, &nbsp; right-alignment padding,
// whitespace-only paragraphs, bold headers, a ragged row
const EXCEL = `<table border=1 style="border-collapse:collapse;width:900pt"><colgroup><col width=180><col width=70 span=10></colgroup>
<tr><td><p>   </p><p><b>Property, Plant and Equipment</b></p></td><td></td><td></td><td align=right><p>   </p><p>(Rs in lacs)</p></td></tr>
<tr><td rowspan=2><p>   </p><p><b>Name of Assets</b></p></td><td colspan=2><b>Gross Block</b></td><td><b>Net Block</b></td></tr>
<tr><td><b>As on</b></td><td><b>Addition</b></td><td><b>${NB(1)}</b></td></tr>
<tr><td>Office Equipments</td><td style="text-align:right"><p>   </p><p>${NB(30)} 17.45 </p></td><td>${NB(20)} &nbsp;6.68 </td><td>${NB(1)}   </td></tr>
<tr><td>${NB(9)} - Current Tax</td><td>(1,234.50)</td></tr>
</table>`;

test('pasted Excel/Word table → MCA HTML schema: no colgroup/col/colspan/rowspan, only class, rectangular grid', () => {
  const out = toMca(EXCEL, { borders: true });
  assert.deepEqual(htmlGuidelineIssues(out, { detail: true }), { errors: [], warnings: [] });
  assert.ok(!/colgroup|<col|colspan|rowspan|style=|width=|align=|border=/.test(out), out);
  assert.match(out, /^<table><tbody><tr>/, 'loose rows wrapped in tbody (as in the validated ICOM instance)');
  const rows = [...out.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => (m[1].match(/<td /g) || []).length);
  assert.deepEqual(rows, [4, 4, 4, 4, 4], 'every row has the full number of cells');
  assert.equal((out.match(/<td class="bordered">/g) || []).length, 20, 'pasted cells bordered');
  // rowspan: the covered cell of the next row is an empty cell; colspan: content stays in the first cell
  assert.match(out, /<tr><td class="bordered">&nbsp;<\/td><td class="bordered"><span class="highlightedText1">As on<\/span>/);
  assert.match(out, /Gross Block<\/span><\/td><td class="bordered">&nbsp;<\/td><td class="bordered"><span class="highlightedText1">Net Block/);
  // padding before numbers and trailing spaces removed; whitespace-only paragraphs removed; text indentation kept
  assert.match(out, /<td class="bordered">17\.45<\/td><td class="bordered">6\.68<\/td>/);
  assert.match(out, />\(1,234\.50\)</);
  assert.match(out, />(&nbsp;){9} - Current Tax</);
  assert.ok(!/<p>\s*<\/p>/.test(out) && !/<p>(&nbsp;){2,}<\/p>/.test(out), 'no whitespace-only paragraphs');
  assert.ok(!/<span class="highlightedText\d">(&nbsp;|\s)*<\/span>/.test(out), 'no highlighted whitespace (shaded block in the MCA PDF)');
  // stable: editor round trip and repeated conversion give the same markup; no text lost
  assert.equal(toMca(fromMca(out)), out);
  assert.equal(toMca(out), out);
  for (const w of ['Property, Plant and Equipment', 'Gross Block', 'Office Equipments', '17.45', '6.68', 'Current Tax', '(Rs in lacs)']) assert.ok(plainText(out).includes(w), w);
});

test('existing MCA border classes are kept on paste; tables are not bordered unless pasted', () => {
  const t = '<table><tr><td class="unbordered">a</td><td class="bordered tableRowValue">1</td></tr></table>';
  assert.equal(toMca(t, { borders: true }), '<table><tbody><tr><td class="unbordered">a</td><td class="bordered tableRowValue">1</td></tr></tbody></table>');
  assert.equal(toMca('<table><tr><td>a</td></tr></table>'), '<table><tbody><tr><td>a</td></tr></tbody></table>');
  assert.equal(toMca('<table><caption>Title</caption><thead><tr><th colspan="2">H</th></tr></thead><tr><td>a</td><td>b</td></tr></table>'),
    '<p>Title</p><table><thead><tr><th>H</th><th>&nbsp;</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
});

test('emphasis option: plain text instead of highlightedText classes', () => {
  assert.equal(toMca('<p><b>Bold</b> <i>it</i> <u>u</u></p>'), '<p><span class="highlightedText1">Bold</span> <span class="highlightedText2">it</span> <span class="highlightedText3">u</span></p>');
  assert.equal(toMca('<p><b>Bold</b> <i>it</i> <u>u</u></p>', { emphasis: 'none' }), '<p>Bold it u</p>');
  assert.equal(toMca('<p><b>x</b></p>'), '<p><span class="highlightedText1">x</span></p>', 'option does not leak into the next call');
});

test('gate: constructs the MCA HTML schema rejects are blocking errors with the fix', () => {
  const bad = '<table><colgroup><col/></colgroup><tbody><tr><td colspan="4" class="bordered"><p>x</p></td><td rowspan="2">y</td></tr></tbody></table>';
  const h = htmlGuidelineIssues(bad);
  assert.ok(h.some((x) => /<colgroup> is rejected/.test(x)) && h.some((x) => /<col> is rejected/.test(x)));
  assert.ok(h.some((x) => /'colspan' on <td> is rejected/.test(x)) && h.some((x) => /'rowspan' on <td> is rejected/.test(x)));
  assert.ok(htmlGuidelineIssues('<table><p>x</p></table>').some((x) => /<p> inside <table> is not allowed/.test(x)));
  assert.deepEqual(htmlGuidelineIssues(toMca(fromMca(bad))), [], 'open + Save Text repairs it');
  const w = htmlGuidelineIssues('<p align="left">x</p>', { detail: true });
  assert.deepEqual(w.errors, []);
  assert.match(w.warnings[0], /'align' on <p> is not used in MCA-validated instances/);
  const S = newSession();
  const c = q(BOD);
  S.setValue(c, 'CY', bad);
  const issue = S.validate().issues.find((i) => i.code === 'html' && i.location?.cellId?.startsWith(c));
  assert.ok(issue && issue.severity === 'ERROR' && /click Save Text/.test(issue.message), issue?.message);
  S.setValue(c, 'CY', toMca(fromMca(bad)));
  assert.ok(!S.validate().issues.some((i) => i.code === 'html' && i.location?.cellId?.startsWith(c)));
});

test('MCA-validated text blocks pass the HTML check unchanged (no false errors)', () => {
  for (const g of goldens) {
    const { s } = importSession(readFileSync(new URL(g, import.meta.url), 'utf8'));
    let n = 0;
    for (const f of s.filing.all().filter((x) => A.dataType(x.concept) === 'textBlock' && !x.nil)) {
      assert.deepEqual(htmlGuidelineIssues(f.value, { detail: true }).errors.filter((e) => !e.startsWith('entity')), [], `${g} ${f.concept}`);
      n++;
    }
    assert.ok(n > 5, `${g}: text blocks checked`);
  }
});

test('xml:lang only on xbrli:stringItemType / nonnum:textBlockItemType (restricted in-ca types forbid it)', () => {
  for (const l of ['PermanentAccountNumberOfEntity', 'CorporateIdentityNumber', 'TypeOfCashFlowStatement', 'LevelOfRoundingUsedInFinancialStatements', 'NatureOfReportStandaloneConsolidated']) assert.equal(A.langAllowed(q(l)), false, l);
  assert.equal(A.langAllowed(q('NameOfCompany')), true);
  assert.equal(A.langAllowed(q(BOD)), true);
  for (const g of goldens) {
    const { s } = importSession(readFileSync(new URL(g, import.meta.url), 'utf8'));
    const { xml } = s.exportXml({ today: new Date().toISOString().slice(0, 10) });
    let allowed = 0;
    for (const m of xml.matchAll(/<((?:ind-as|in-ca):\w+) ([^>]*)>/g)) {
      const has = /xml:lang=/.test(m[2]);
      if (A.langAllowed(m[1])) { if (has) allowed++; } else assert.ok(!has, `${m[1]} (${A.concept(m[1]).type}) must not carry xml:lang`);
    }
    assert.ok(allowed > 0, 'Filing Manual #28: base text types still carry xml:lang="en"');
  }
});

test('characters XML does not allow never reach the instance (Word line break, control characters)', () => {
  assert.equal(fromMca('a\u000Bb'), '<p>a<br>b</p>', 'vertical tab = line break');
  assert.equal(toMca('<p>x\u0001y&#11;z￾</p>'), '<p>xy z</p>', 'controls removed; &#11; is a line break (whitespace in HTML)');
  const S = newSession();
  const c = q('NameOfCompany');
  S.setValue(c, 'CY', 'ABC\u0007 Limited');
  assert.equal(S.getValue(c, 'CY').value, 'ABC Limited', 'canonical value is XML-safe');
  S.filing.facts.get(S.getValue(c, 'CY').key).value = 'ABC\u0007 Limited'; // e.g. an old project file
  assert.ok(S.validate().issues.some((i) => i.code === 'value.xmlChar' && i.severity === 'ERROR'));
});

test('MCA error explainer: validator messages classified, grouped by cause and linked to Ind AS elements', () => {
  const lines = ['PermanentAccountNumberOfEntity', 'CorporateIdentityNumber', 'TypeOfCashFlowStatement'].map((e, i) => `${i + 1}) cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:${e}'.`);
  lines.push(`4) Element '${BOD}' the contained HTML has the following errors: cvc-complex-type.2.4.a: Invalid content was found starting with element 'colgroup'. One of '{{http://www.mca.gov.in/XBRL/HTML}thead, {http://www.mca.gov.in/XBRL/HTML}tfoot, {http://www.mca.gov.in/XBRL/HTML}tbody, {http://www.mca.gov.in/XBRL/HTML}tr}' is expected.;cvc-complex-type.3.2.2: Attribute 'colspan' is not allowed to appear in element 'td'.;`);
  lines.push('', 'NOTE: In case warning messages are displayed, these are in respect of non- compliance to HTML guidelines.');
  const r = explainMcaErrors(lines.join('\n'), A);
  assert.equal(r.length, 4);
  assert.ok(r.slice(0, 3).every((x) => x.code === 'cvc-complex-type.3.2.2' && /old \(cached\) copy/.test(x.cause) && /build/.test(x.fix) && A.concept(x.concept)));
  assert.equal(r[3].code, 'html');
  assert.equal(r[3].concept, q(BOD));
  assert.deepEqual(r[3].details.map((d) => d.code), ['cvc-complex-type.2.4.a', 'cvc-complex-type.3.2.2']);
  assert.match(r[3].details[0].meaning, /'colgroup' appears where the schema expects one of: thead, tfoot, tbody, tr/);
  const f = explainMcaErrors("1) cvc-pattern-valid: Value 'abcde1234f' is not facet-valid with respect to pattern '[A-Z][A-Z][A-Z][A-Z][A-Z][0-9][0-9][0-9][0-9][A-Z]' for type 'PANNumber'.\n2) cvc-type.3.1.3: The value 'abcde1234f' of element 'in-ca:PermanentAccountNumberOfEntity' is not valid.\n3) Something else entirely", A);
  assert.equal(f[0].concept, q('PermanentAccountNumberOfEntity'));
  assert.equal(f[2].code, 'unknown');
});

test('generated XML names the tool build in its first comment', () => {
  const S = newSession();
  S.setValue(q(BOD), 'CY', '<p>x</p>');
  const { xml } = generateInstance(S.A, S.filing);
  assert.match(xml.split('\n')[1], /^<!-- Generated by Ind AS XBRL Studio build [\w.-]+ -->$/);
});
