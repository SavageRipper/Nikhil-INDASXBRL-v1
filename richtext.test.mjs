// Suite: rich-text narrative fields — entry, save/reload, XML export/import, formatting preservation,
// MCA HTML-guideline compliance, and lossless handling of the MCA-validated golden text blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { q, authority, importSession } from './helpers.mjs';
import { baseSession, exampleSession, T, exportUnchecked } from './fixtures.mjs';
import { toMca, fromMca, plainText, formatting } from './richtext.js';
import { htmlGuidelineIssues } from './gate.js';
import { Filing } from './model.js';
import { Session } from './session.js';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';

const A = authority();
const today = '2018-09-30';
// what a browser contenteditable produces after using every toolbar button
const EDITOR = '<p>Directors\' report for FY 2017-18: <b>bold</b>, <i>italic</i>, <u>underline</u>, <b><i><u>all three</u></i></b>.</p>'
  + '<ol><li>First item</li><li>Second item<ul><li>nested bullet</li></ul></li></ol>'
  + '<ul><li>Bullet A</li><li>Bullet B &amp; C &lt;tag&gt;</li></ul>'
  + '<blockquote><p>Indented paragraph</p><blockquote><p>Indented twice</p></blockquote></blockquote>'
  + '<p>Line one<br>Line two&nbsp;with non-breaking space</p><h3>Sub-heading</h3>'
  + '<table><tbody><tr><td class="bordered">Particulars</td><td class="bordered">2017</td></tr><tr><td class="bordered">Revenue</td><td class="bordered">1,000</td></tr></tbody></table>';
const TB = 'DetailsOfSignificantAndMaterialOrdersPassedByRegulatorsOrCourtsOrTribunalsImpactingGoingConcernStatusAndCompanysOperationsInFutureExplanatory';

test('MCA serialisation follows the Filing Manual HTML guidelines and keeps every formatting feature', () => {
  const mca = toMca(EDITOR);
  assert.deepEqual(htmlGuidelineIssues(mca), []);
  assert.ok(!/<(b|i|u|ol|ul|li|blockquote|h\d)\b|style=/.test(mca), 'no disallowed tags or style attributes');
  assert.deepEqual(formatting(mca), formatting(EDITOR));
  assert.equal(plainText(fromMca(mca)).replace(/\s+/g, ''), plainText(EDITOR).replace(/\s+/g, ''), 'no text lost');
  assert.equal(toMca(fromMca(mca)), mca, 'stable: editor → MCA → editor → MCA');
  const f = formatting(EDITOR);
  for (const k of ['b', 'i', 'u', 'ol', 'ul', 'li', 'indent', 'h', 'br', 'table']) assert.ok(f[k] > 0, k);
});

test('rich text: entered → saved → reloaded → exported to XML → imported → edited again, formatting preserved', () => {
  const s = baseSession();
  const c = q(TB);
  s.setValue(c, 'CY', toMca(EDITOR));
  // save / reload project
  const s2 = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(s.filing.toJSON()))));
  const v2 = s2.getValue(c, 'CY').value;
  assert.equal(v2, toMca(EDITOR));
  // export
  const { xml, gate } = s2.exportXml({ today });
  assert.ok(gate.ok, gate.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).join('\n'));
  assert.ok(xml.includes('&lt;span class=&quot;highlightedText1&quot;&gt;bold&lt;/span&gt;'), 'markup escaped inside the fact (same escaping as the MCA-validated instance)');
  assert.ok(!/<span class="highlightedText1">/.test(xml), 'never raw markup inside the XML');
  if (xsdValidatorStatus().available) assert.equal(validateInstanceXml(xml).status, 'PASS');
  // import
  const { s: s3 } = importSession(xml);
  const v3 = s3.getValue(c, 'CY').value;
  assert.equal(v3, v2, 'identical fact content after import');
  assert.deepEqual(formatting(fromMca(v3)), formatting(EDITOR), 'editor shows the same formatting');
  // edit again in the editor and re-export
  const edited = fromMca(v3).replace('First item', 'First <b>edited</b> item');
  s3.setValue(c, 'CY', toMca(edited));
  const { s: s4 } = importSession(s3.exportXml({ today }).xml);
  assert.equal(formatting(fromMca(s4.getValue(c, 'CY').value)).b, formatting(EDITOR).b + 1);
});

test('rich text inside a dimensional table cell (typed axis) survives the round trip', () => {
  const s = exampleSession();
  const CI = T('DetailsOfCurrentInvestmentsTable');
  const tbConcept = q('DetailsOfCurrentInvestmentMadeInPartnershipFirmsExplanatory');
  assert.ok(A.table(CI).lineItems.includes(tbConcept), 'text block is a line item of the typed table');
  s.setValue(q('CurrentInvestments'), 'CY', '1000', { recalc: true });
  const dims = [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }];
  s.setTableValue(CI, 'CY', dims, tbConcept, toMca('<p><b>Terms</b>: arm\'s length</p><ul><li>one</li></ul>'));
  const { s: s2 } = importSession(exportUnchecked(s, today));
  const f = formatting(fromMca(s2.getValue(tbConcept, 'CY', dims).value));
  assert.equal(f.li, 1);
  assert.equal(f.b, 1);
});

test('pasted Word/HTML is cleaned to the MCA subset without losing text or emphasis', () => {
  const word = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal style="margin:0"><span style="font-weight:bold;mso-bidi-font-weight:normal">Bold run</span> and <span style="font-style:italic">italic</span><o:p></o:p></p><ul style="margin-top:0"><li class=MsoListParagraph>Point &#8226; one</li></ul><img src="x.png"><script>alert(1)</script></body></html>';
  const mca = toMca(word);
  assert.deepEqual(htmlGuidelineIssues(mca), []);
  assert.equal(formatting(mca).b, 1);
  assert.equal(formatting(mca).i, 1);
  assert.equal(formatting(mca).li, 1);
  assert.ok(!/img|script|alert/.test(mca));
  assert.match(plainText(mca), /Bold run and italic/);
});

test('plain-text and imported MCA content load into the editor unchanged in text', () => {
  assert.equal(plainText(fromMca('Line 1\nLine 2\n\nPara 2')), 'Line 1\nLine 2\nPara 2');
  for (const f of readdirSync('.').filter((x) => /^golden-.*\.xml$/.test(x))) {
    const { s } = importSession(readFileSync(f, 'utf8'));
    const blocks = s.filing.all().filter((x) => A.dataType(x.concept) === 'textBlock' && !x.nil);
    assert.ok(blocks.length > 0);
    for (const b of blocks) {
      const out = toMca(fromMca(b.value));
      // characters identical; whitespace may differ only where loose text next to a nested block (ICOM 2022-23:
      // "Bitmap <table>…" inside a cell) becomes its own paragraph
      assert.equal(plainText(out).replace(/\s+/g, ''), plainText(b.value).replace(/\s+/g, ''), `${b.concept}: text preserved`);
      assert.deepEqual(htmlGuidelineIssues(out), [], `${b.concept}: guideline-compliant after editing`);
      assert.equal(toMca(fromMca(out)), out, `${b.concept}: stable`);
    }
    console.log(`# ${f}: ${blocks.length} text blocks round-tripped through the editor`);
  }
});

// ---------------------------------------------------------------- deterministic mapping + unsupported markup
// Filing Manual HTML guidelines (Filing_Manual_IndAS_V1.0.pdf, "HTML contents follow the below guidelines"):
// lower-case tags; predefined classes header1-5, bordered, unbordered, tableHeader, tableRow, tableRowLabel,
// tableRowValue, normalText, noteText1-4, numericValue, nonNumericValue, highlightedText1-4; no style attribute;
// only <div> <span> <p> <br> <table> <td> <tr> <thead> <tfoot> <tbody> <th> <col> <colgroup>; "HTML formatting tags
// like <b>, <i> etc. are not allowed"; no processing instructions; entities only &nbsp; &amp; &lt; &gt;.
const ALLOWED = new Set(['div', 'span', 'p', 'br', 'table', 'td', 'tr', 'thead', 'tfoot', 'tbody', 'th', 'col', 'colgroup']);
const ALLOWED_ATTRS = new Set(['class', 'colspan', 'rowspan']);
const CLASSES = new Set(['header1', 'header2', 'header3', 'header4', 'header5', 'bordered', 'unbordered', 'tableHeader', 'tableRow', 'tableRowLabel', 'tableRowValue', 'normalText', 'noteText1', 'noteText2', 'noteText3', 'noteText4', 'numericValue', 'nonNumericValue', 'highlightedText1', 'highlightedText2', 'highlightedText3', 'highlightedText4']);
function assertMcaConformant(out, label) {
  for (const m of out.matchAll(/<\s*(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, , name, rest] = m;
    assert.equal(name, name.toLowerCase(), `${label}: lower-case tag ${name}`);
    assert.ok(ALLOWED.has(name), `${label}: unsupported tag <${name}> in ${out}`);
    for (const a of rest.matchAll(/([^\s=\/]+)\s*=\s*"([^"]*)"/g)) {
      assert.ok(ALLOWED_ATTRS.has(a[1]), `${label}: unsupported attribute ${a[1]}`);
      if (a[1] === 'class') for (const c of a[2].split(/\s+/)) assert.ok(CLASSES.has(c), `${label}: class ${c}`);
    }
    assert.ok(!/\s(style|on\w+|id|href|src)\s*=/i.test(rest), `${label}: forbidden attribute`);
  }
  for (const e of out.match(/&[A-Za-z0-9#]+;/g) || []) assert.ok(['&nbsp;', '&amp;', '&lt;', '&gt;'].includes(e), `${label}: entity ${e}`);
  assert.ok(!/<\?|<!--|<!\[CDATA\[/.test(out), `${label}: no PI/comment/CDATA`);
  assert.deepEqual(htmlGuidelineIssues(out), [], `${label}: gate guideline check`);
}

test('rich text → MCA markup is deterministic: bold/italic/underline/lists/indent/headings map to fixed Filing Manual classes', () => {
  const cases = [
    ['<b>x</b>', '<p><span class="highlightedText1">x</span></p>'],
    ['<strong>x</strong>', '<p><span class="highlightedText1">x</span></p>'],
    ['<i>x</i>', '<p><span class="highlightedText2">x</span></p>'],
    ['<em>x</em>', '<p><span class="highlightedText2">x</span></p>'],
    ['<u>x</u>', '<p><span class="highlightedText3">x</span></p>'],
    ['<b><i><u>x</u></i></b>', '<p><span class="highlightedText1"><span class="highlightedText2"><span class="highlightedText3">x</span></span></span></p>'],
    ['<ol><li>a</li><li>b</li></ol>', '<div class="noteText1"><p>1.&nbsp;a</p><p>2.&nbsp;b</p></div>'],
    ['<ul><li>a</li><li>b</li></ul>', '<div class="noteText2"><p>•&nbsp;a</p><p>•&nbsp;b</p></div>'],
    ['<blockquote><p>x</p></blockquote>', '<div class="noteText3"><p>x</p></div>'],
    ['<blockquote><blockquote><p>x</p></blockquote></blockquote>', '<div class="noteText3"><div class="noteText3"><p>x</p></div></div>'],
    ['<h2>T</h2>', '<p class="header2">T</p>'],
    ['<p>a<br>b</p>', '<p>a<br/>b</p>'],
    ['a\nb', '<p>a<br/>b</p>'],
  ];
  for (const [inp, exp] of cases) {
    assert.equal(toMca(inp), exp, inp);
    assert.equal(toMca(inp), toMca(inp), `${inp}: same output every time`);
    assert.equal(toMca(fromMca(exp)), exp, `${inp}: MCA → editor → MCA is a fixed point`);
    assertMcaConformant(exp, inp);
  }
});

test('unsupported HTML/markup never reaches the XBRL fact (regression: rejects <b>, <i>, <ul>, <ol>, style, scripts, entities, ...)', () => {
  const hostile = [
    '<b>bold</b><i>it</i><u>u</u><strong>s</strong><em>e</em>',
    '<ol><li>one</li></ol><ul><li>two</li></ul>',
    '<font color="red" face="Arial">font</font><center>c</center><big>b</big><small>s</small>',
    '<a href="http://x">link</a><img src="x.png" alt="i"><script>alert(1)</script><style>p{color:red}</style>',
    '<iframe src="x"></iframe><object data="x"></object><embed src="x"><svg><circle/></svg><math><mi>x</mi></math>',
    '<p style="color:red" onclick="steal()" id="x" class="evil header1">styled</p>',
    '<span style="font-weight:bold;font-style:italic;text-decoration:underline">word-style run</span>',
    '<TABLE BORDER=1><TR><TD STYLE="x">Upper</TD></TR></TABLE>',
    '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>',
    '<sup>2</sup><sub>3</sub><s>strike</s><strike>x</strike><del>d</del><ins>i</ins><code>c</code><pre>p</pre><kbd>k</kbd><mark>m</mark><q>q</q><abbr title="t">a</abbr>',
    '<h1>H1</h1><h6>H6</h6><hr><dl><dt>t</dt><dd>d</dd></dl><section>s</section><article>a</article>',
    '<?xml version="1.0"?><!-- comment --><![CDATA[<b>cdata</b>]]><!DOCTYPE html>',
    '&copy; &rsquo; &ldquo;q&rdquo; &hellip; &#169; &#x20B9; &unknown; &quot; &apos;',
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>.MsoNormal{}</style></head><body><p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.<span style="font:7.0pt">&nbsp;&nbsp;</span></span>Word list item<o:p></o:p></p><w:sdt><p class=MsoNormal><b><span lang=EN-IN>Bold</span></b></p></w:sdt></body></html>',
    '<input type="text" value="x"><button>b</button><form action="x"><select><option>o</option></select></form><textarea>t</textarea>',
  ];
  for (const h of hostile) {
    const out = toMca(h);
    assertMcaConformant(out, h.slice(0, 40));
    assert.equal(toMca(out), out, `${h.slice(0, 40)}: idempotent`);
    assert.ok(!/alert|steal|\.png|http:\/\/x/.test(out), 'active content and URLs dropped');
  }
  // emphasis expressed through Word inline styles is kept as the class mapping, never as style=
  assert.equal(formatting(toMca(hostile[6])).b + formatting(toMca(hostile[6])).i + formatting(toMca(hostile[6])).u, 3);
  // named entities pasted from Word become characters, never disallowed entities
  assert.match(plainText(toMca(hostile[12])), /© ’ “q” … © ₹/);
  // the internal gate blocks a text block carrying unsupported markup injected below the editor
  const s = baseSession();
  const c = q(TB);
  for (const bad of ['<b>raw bold</b>', '<ul><li>raw list</li></ul>', '<p style="color:red">styled</p>', '<P>upper</P>']) {
    s.filing.setFact({ concept: c, period: s.filing.period(c, 'CY'), value: bad });
    const g = s.validate({ today });
    assert.ok(g.issues.some((i) => i.code === 'html' && i.severity === 'ERROR'), `gate rejects ${bad}`);
    assert.equal(g.ok, false);
  }
});
