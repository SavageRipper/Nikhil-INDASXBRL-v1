// Ind AS V1.2 workbook clause families. Literal readings of the MCA sentences of "Specific rules for elements";
// every element / member / Yes-No question named in the text is resolved against the Ind AS 2017 DTS (by name, by
// label, or — for misspelt question labels — to the closest boolean element of the same ELR, recorded on the rule as
// `resolved`). Anything that needs data outside the instance is REVIEW_ONLY_EXTERNAL_DATA; text without an executable
// constraint is NOT_APPLICABLE. Unrecognised text returns null (→ UNIMPLEMENTED in the coverage ledger).

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Question phrases whose wording differs from the taxonomy label beyond spelling.
const PHRASE_ALIASES = {
  whetheristhisfirsttimeadoptionofindas: 'WhetherCompanyHasAdoptedIndAsFirstTime',
  whethercompanyhasreceivedanygovernmentgrantorgovernmentassistance: null, // resolved by label below when present
};

export function normalizeClause(s) {
  return s
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/''/g, '"')
    .replace(/\bselecetd\b/gi, 'selected')
    .replace(/\bin in \[/g, 'in [')
    .replace(/"\s*"/g, '"')
    .replace(/^Mandatory,\s*if\b/i, 'Mandatory if')
    .replace(/^(Mandatory table|Table should be mandatory|Table is mandatory) is ("?yes"?) is selected/i, '$1 if $2 is selected')
    .replace(/^(Mandatory table|Table should be mandatory|Table is mandatory) is\b/i, '$1 if')
    .replace(/\b(yes"?) is selected "/i, '$1 is selected in "')
    .replace(/"is tagged$/, '" is tagged')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEAD = /^(?:All line items should be mandatory|This element is a mandatory|This element is mandatory|Mandatory line item|Mandatory table|Table mandatory|Table should be mandatory|Table is mandatory|This table is mandatory(?: for current year)?|This is a mandatory field|This is mandatory field|This is mandatory|This field is mandatory|Should be mandatory|This shall be mandatory|It is mandatory|Mandatory)\s*,?\s*(?:only\s+)?(?:if|in case(?: of)?|when)\s+(.+)$/i;

export function makeIndAsResolver(R, A) {
  const booleans = Object.keys(A.concepts).filter((q) => A.concepts[q].type === 'xbrli:booleanItemType' && A.concepts[q].kind === 'item');
  const labelsOf = (q) => Object.values(A.concepts[q].labels || {}).map((l) => norm(l.replace(/\[[^\]]*\]/g, '')));
  const lev = (a, b) => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 12) return 99;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  };
  const elrUriOfCode = (code) => A.elrs.find((e) => e.code === code)?.uri || null;
  const inElr = (q, code) => {
    const uri = code && elrUriOfCode(code);
    return uri ? (A.conceptElrs[q] || []).includes(uri) : false;
  };
  // Yes/No question → boolean concept
  const bool = (phrase, row) => {
    const t = phrase.replace(/^['"\s]+|['"\s.]+$/g, '').replace(/\s*\?$/, '');
    const n = norm(t);
    if (n in PHRASE_ALIASES && PHRASE_ALIASES[n]) return { q: R.concept(PHRASE_ALIASES[n]), how: 'alias' };
    const direct = R.concept(t);
    if (direct && booleans.includes(direct)) return { q: direct, how: 'name/label' };
    const exact = booleans.filter((q) => labelsOf(q).includes(n));
    if (exact.length === 1) return { q: exact[0], how: 'label' };
    if (exact.length > 1) { const here = exact.filter((q) => inElr(q, row?.elr?.code)); if (here.length === 1) return { q: here[0], how: 'label (same ELR)' }; }
    // closest boolean label (spelling differences: "acounting", "arrangments", "liabilties", word order)
    let best = null;
    for (const q of booleans) for (const l of labelsOf(q)) {
      const d = lev(n, l);
      const same = inElr(q, row?.elr?.code);
      const score = d - (same ? 0.5 : 0);
      if (!best || score < best.score) best = { q, d, score, same };
    }
    if (best && best.d <= Math.max(3, Math.floor(n.length * 0.12)) && best.same) return { q: best.q, how: `closest label in the same ELR (edit distance ${best.d})` };
    // the question quoted without its trailing words ("… reversal of impairment loss" → "… during the year")
    const pre = booleans.filter((q) => inElr(q, row?.elr?.code) && labelsOf(q).some((l) => l.startsWith(n) && n.length >= 20));
    if (pre.length === 1) return { q: pre[0], how: 'label prefix in the same ELR' };
    return null;
  };
  const member = (phrase) => {
    const t = phrase.replace(/^['"\s]+|['"\s]+$/g, '');
    let q = R.concept(t);
    if (q && A.concepts[q].kind === 'member') return q;
    q = R.concept(t.replace(/\[member\]/i, '').trim());
    if (q && A.concepts[q].kind === 'member') return q;
    // label form "other provisions, others member" → label "Other provisions, others [Member]"
    const n = norm(t.replace(/\bmember\b/i, ''));
    const hits = Object.keys(A.concepts).filter((x) => A.concepts[x].kind === 'member' && labelsOf(x).includes(n));
    return hits.length === 1 ? hits[0] : null;
  };
  const memberAndDescendants = (m) => {
    const out = new Set([m]);
    for (const hc of Object.values(A.hypercubes)) for (const ax of hc.axes) if (!ax.typed && ax.members.some((x) => x.member === m)) {
      let grew = true;
      while (grew) { grew = false; for (const x of ax.members) if (x.parent && out.has(x.parent) && !out.has(x.member)) { out.add(x.member); grew = true; } }
    }
    return [...out];
  };
  // presentation order of an ELR (code) — used for "above element" / "above table" references
  const presOrder = (code) => {
    const uri = elrUriOfCode(code);
    const e = A.elrs.find((x) => x.uri === uri);
    const arcs = A.presentation[uri] || [];
    const kids = new Map();
    for (const a of arcs) (kids.get(a.from) || kids.set(a.from, []).get(a.from)).push(a);
    for (const v of kids.values()) v.sort((x, y) => x.order - y.order);
    const out = [];
    const walk = (q) => { out.push(q); for (const a of kids.get(q) || []) walk(a.to); };
    for (const r of e?.roots || []) walk(r);
    return out;
  };
  const booleanBefore = (code, q) => {
    const order = presOrder(code);
    const i = order.indexOf(q);
    for (let j = i - 1; j >= 0; j--) if (booleans.includes(order[j])) return order[j];
    return null;
  };
  // an element named only by its label inside the subject's presentation neighbourhood ("Others")
  const siblingByLabel = (subject, code, label) => {
    const uri = elrUriOfCode(code);
    const arcs = A.presentation[uri] || [];
    const parent = arcs.find((a) => a.to === subject)?.from;
    const desc = [];
    const stack = [parent];
    while (stack.length) { const c = stack.pop(); for (const a of arcs) if (a.from === c) { desc.push(a.to); stack.push(a.to); } }
    const n = norm(label);
    const hits = [...new Set(desc)].filter((q) => q !== subject && A.concepts[q].kind === 'item' && A.concepts[q].type === 'xbrli:monetaryItemType' && labelsOf(q).includes(n));
    return hits.length === 1 ? hits[0] : null;
  };
  return { bool, member, memberAndDescendants, booleanBefore, siblingByLabel, booleans };
}

// ---------------------------------------------------------------------------------------------------------------
export function formalizeIndAs(s0, subject, row, R, A, ok, X) {
  const s = normalizeClause(s0);
  const local = R.local(subject);
  const kind = A.concepts[subject].kind;
  const isTable = kind === 'hypercube';
  const isAxis = kind === 'explicitAxis' || kind === 'typedAxis';
  const nondim = (q) => !(A.conceptHypercubes[q] || []).length;
  const nd = (q) => ({ fact: q, ctx: 'nondim' });
  const self = { self: true };
  const code = row.elr?.code;
  let m;
  const tablesOfSubject = () => {
    if (isTable) return R.tablesByHc(local);
    if (isAxis) return A.tables.filter((t) => t.axes.some((a) => a.axis === subject)).map((t) => t.id);
    return [];
  };
  const resolved = [];
  const scopeCyOnly = /current year only|mandatory for current year/i.test(row.text);
  const scopeOf = () => (scopeCyOnly ? { periods: ['CY'] } : { periods: ['CY', 'PY'] });

  // ---------------- rule text on an abstract heading row (an abstract cannot carry a value)
  if (kind === 'abstract' && !/LineItems$/.test(local) && !HEAD.test(s)) {
    const item = R.concept(local.replace(/Abstract$/, ''));
    if (item && A.concepts[item].kind === 'item' && /^(?:Should be greater than or equal to zero|This is a mandatory field)$/i.test(s)) {
      return { __retarget: item, resolved: [`abstract heading ${local} → its element ${R.local(item)}`] };
    }
    return { status: 'NOT_APPLICABLE', reason: `Rule text on the abstract heading '${local}', which cannot carry a value${/mandatory/i.test(s) ? '; the heading\'s own elements carry their rules on the following rows' : ''}` };
  }

  // ---------------- informational / structural sentences
  if (/^There are \d+ tables in this ELR$/i.test(s)) return { status: 'NOT_APPLICABLE', reason: 'Informational sentence; the requirement is the next clause of the same cell (one of the tables of this ELR), which is executed' };
  if (/^If one is tagged then other one should not be mandatory, when table is created$/i.test(s)) return { status: 'NOT_APPLICABLE', reason: 'Continuation of the previous clause ("one of these two elements"), executed there as an at-least-one requirement per table row' };
  if (/^Mandatory for current year only as Comparative information is not required$/i.test(s)) return { status: 'NOT_APPLICABLE', reason: 'Qualifies the previous clause of the same cell, which is executed for the current year only' };
  if (/^If Yes is selected then 'Balance Sheet' for preceding previous year is mandatory$/i.test(s)) return { status: 'EXECUTABLE', implementation: 'data:executed by GR-16 (fta-opening-balance-sheet)', scope: { periods: ['CY'] } };
  if (/^(?:Name )?Should be based on ["']?\w+["']?,? if (?:provided|CIN is entered)$/i.test(s) || /^Name should be based on CIN, if CIN is entered$/i.test(s)) {
    return { status: 'REVIEW_ONLY_EXTERNAL_DATA', reason: 'Name must match the MCA21 master record of the CIN entered — master data is not part of the instance document', implementation: 'review:external-master-data' };
  }
  if (/company (?:not )?having (?:equity )?share capital|section 8 company/i.test(s)) {
    return { status: 'REVIEW_ONLY_EXTERNAL_DATA', reason: 'Requires the company class / share-capital status (Pvt / Public / Section 8) from MCA21 company master data, which is not part of the instance document', implementation: 'review:external-master-data' };
  }
  if (/^This value if "CarryingAmountMember" should be equal to "(\w+)" on the face of Balance Sheet$/i.test(s)) {
    return { status: 'EXECUTABLE', implementation: 'structural:dimension-default', reason: 'CarryingAmountMember is the dimension default of the carrying-amount axis, so the table value at CarryingAmountMember and the balance-sheet value are one XBRL fact (Filing Manual §1.1.3.1 #30/#31) — equal by construction', scope: { periods: ['CY', 'PY'] } };
  }

  // ---------------- value comparisons / sums (curated per sentence)
  if ((m = /^Should be less than or equal to "Value of shares subscribed - equity$/i.exec(s))) {
    return ok('curated:sharecapital-lte-subscribed', { type: 'assert', assert: { op: 'cmp', cmp: '<=', l: nd(subject), r: { sumAxis: { concept: R.concept('ValueOfSharesSubscribed'), axis: R.concept('ClassesOfEquityShareCapitalAxis'), level: 'firstLevel' } } } });
  }
  if ((m = /^Value of Other equity- \(Closing Balance\) on the dimensional member 'EquityAttributableToTheEquityHoldersOfTheParentMember' should be equal to value entered in 'Other equity' in balance sheet\. & In case of conolidated balance sheet Value of Other equity- \(Closing Balance\) on the dimensional member 'NonControllingInterestsMember' should be equal to value entered in 'NonControllingInterest' in balance sheet$/i.exec(s))) {
    const ax = R.concept('ComponentsOfEquityAxis');
    const at = (mem) => ({ sumAxis: { concept: subject, axis: ax, level: 'members', members: [R.concept(mem)] } });
    return ok('curated:soce-other-equity-eq-bs', { type: 'assert', assert: { op: 'and', args: [
      { op: 'cmp', cmp: '==', l: at('EquityAttributableToTheEquityHoldersOfTheParentMember'), r: nd(R.concept('OtherEquity')) },
      { op: 'or', args: [{ op: 'not', arg: { op: 'reportType', value: 'Consolidated' } }, { op: 'cmp', cmp: '==', l: at('NonControllingInterestsMember'), r: nd(R.concept('NonControllingInterest')) }] },
    ] } }, { periods: ['CY', 'PY'] });
  }
  const sumEq = (impl, target, sumSpec, extra = {}) => ok(`curated:${impl}`, { type: 'assert', assert: { op: 'cmp', cmp: '==', l: { sumAxis: sumSpec }, r: nd(target) }, ...extra });
  if ((m = /^Summation of various Borrowings members for (NonCurrent|Current) period should be equal to '(\w+)' in financial statements(?:\. To validate this.*)?$/i.exec(s))) {
    const member = R.concept(m[1].toLowerCase() === 'current' ? 'CurrentMember' : 'NoncurrentMember');
    return sumEq('borrowings-first-level', R.concept(m[2]), { concept: subject, axis: R.concept('ClassificationOfBorrowingsAxis'), level: 'firstLevel', fixed: { [R.concept('ClassificationBasedOnCurrentNoncurrentAxis')]: member } });
  }
  if (/^Summation of this element on all the members should be equal to the corresponding value in Balance Sheet$/i.test(s) && local === 'PropertyPlantAndEquipment') {
    return sumEq('ppe-classes-sum', subject, { concept: subject, axis: R.concept('ClassesOfPropertyPlantAndEquipmentAxis'), level: 'firstLevel' });
  }
  if ((m = /^Summation of carrying amount value entered in all dimensional members for each (?:investment property|other intangible assets) should be equal to '(\w+)' value entered in Balance sheet$/i.exec(s))) {
    const target = R.concept(m[1]);
    const t = A.tables.find((x) => x.lineItems.includes(subject) && x.axes.length);
    const typed = t?.axes.find((a) => a.typed);
    if (typed) return sumEq('typed-members-carrying-sum', target, { concept: subject, axis: typed.axis, level: 'all' });
    const classes = t?.axes.find((a) => /^ClassesOf/.test(R.local(a.axis)));
    if (classes) return sumEq('classes-carrying-sum', target, { concept: subject, axis: classes.axis, level: 'firstLevel' });
  }
  if (/^Summation of (?:carrying amount )?value in "BiologicalAssetsOtherThanBearerPlantsAtFairValue" and (?:carrying amount value in )?"BiologicalAssetsOtherThanBearerPlantsAtCost" entered in all dimensional members for each biological assets should be equal to 'BiologicalAssetsOtherThanBearerPlants' value entered in Balance sheet$/i.test(s)) {
    const part = (n) => { const q = R.concept(n); const t = A.tables.find((x) => x.lineItems.includes(q) && x.axes.some((a) => a.typed)); return { sumAxis: { concept: q, axis: t.axes.find((a) => a.typed).axis, level: 'all' } }; };
    return ok('curated:biological-assets-sum', { type: 'assert', assert: { op: 'cmp', cmp: '==', l: { sumOf: [part('BiologicalAssetsOtherThanBearerPlantsAtFairValue'), part('BiologicalAssetsOtherThanBearerPlantsAtCost')] }, r: nd(R.concept('BiologicalAssetsOtherThanBearerPlants')) } });
  }
  if ((m = /^Summation of TradeReceivables - SecuredConsideredGoodMember; UnsecuredConsideredGoodMember; DoubtfulMember on "(NonCurrent|Current)Member" should be equal to '(\w+)' in financial statements$/i.exec(s))) {
    const members = ['SecuredConsideredGoodMember', 'UnsecuredConsideredGoodMember', 'DoubtfulMember'].map((n) => R.concept(n));
    const cn = R.concept(m[1].toLowerCase() === 'current' ? 'CurrentMember' : 'NoncurrentMember');
    return sumEq('trade-receivables-security-sum', R.concept(m[2]), { concept: subject, axis: R.concept('ClassificationOfAssetsBasedOnSecurityAxis'), level: 'members', members, fixed: { [R.concept('ClassificationBasedOnCurrentNoncurrentAxis')]: cn } });
  }
  if ((m = /^Summation of all (Loans|Advances) - Non-current member and current member should be equal to '?(\w+)'? and '(\w+)' respectively in/i.exec(s))) {
    const axis = R.concept(m[1] === 'Loans' ? 'ClassificationOfLoansAxis' : 'ClassificationOfAdvancesAxis');
    const cn = R.concept('ClassificationBasedOnCurrentNoncurrentAxis');
    const targets = m[1] === 'Loans' ? ['LoansNoncurrent', 'LoansCurrent'] : ['NoncurrentAdvances', 'CurrentAdvances'];
    const spec = (mem) => ({ concept: subject, axis, level: 'firstLevel', fixed: { [cn]: R.concept(mem) } });
    resolved.push(`'${m[2]}' / '${m[3]}' → ${targets.join(' / ')}`);
    return { ...ok(`curated:${m[1].toLowerCase()}-current-noncurrent-sum`, { type: 'assert', assert: { op: 'and', args: [
      { op: 'cmp', cmp: '==', l: { sumAxis: spec('NoncurrentMember') }, r: nd(R.concept(targets[0])) },
      { op: 'cmp', cmp: '==', l: { sumAxis: spec('CurrentMember') }, r: nd(R.concept(targets[1])) },
    ] } }), resolved };
  }
  if (/^Summation of all Provisions - NoncurrentMember and CurrentMember should be equal to 'ProvisionsNoncurrent' and 'ProvisionsCurrent' respectively in financial statements$/i.test(s)) {
    const cn = R.concept('ClassificationBasedOnCurrentNoncurrentAxis');
    const one = (mem) => ({ sumAxis: { concept: subject, axis: cn, level: 'members', members: [R.concept(mem)] } });
    return ok('curated:provisions-current-noncurrent', { type: 'assert', assert: { op: 'and', args: [
      { op: 'cmp', cmp: '==', l: one('NoncurrentMember'), r: nd(R.concept('ProvisionsNoncurrent')) },
      { op: 'cmp', cmp: '==', l: one('CurrentMember'), r: nd(R.concept('ProvisionsCurrent')) },
    ] } });
  }
  if ((m = /^Summation of value entered in all dimensional members of (\w+) for "(\w+)" should be equal to "(\w+)" in ?\[ ?\d{6}[a-z]?\].*$/i.exec(s))) {
    const tdef = A.tables.find((x) => R.local(x.hypercube) === m[1]);
    const typed = tdef?.axes.find((a) => a.typed);
    if (typed && R.concept(m[2]) === subject && R.concept(m[3]) === subject) return sumEq('typed-members-eq-total', subject, { concept: subject, axis: typed.axis, level: 'all' });
  }

  // ---------------- enumerations / dates
  if ((m = /^Only '([^']+)' and '([^']+)' can be selected for the time being$/i.exec(s))) {
    return ok('pattern:enum-subset', { type: 'eachFact', concept: subject, assert: { op: 'or', args: [m[1], m[2]].map((v) => ({ op: 'cmp', cmp: '==', l: self, r: { const: v } })) } }, { periods: ['CY'] });
  }
  if (/^This table is mandatory for current year if transaction period from 8th November 2016 to 30th December 2016 is overlapping or falling within the reporting period mentioned in ELR "DateOfStartOfReportingPeriod" and "DateOfEndOfReportingPeriod"$/i.test(s)) {
    const when = { op: 'and', args: [
      { op: 'cmp', cmp: '<=', l: nd(R.concept('DateOfStartOfReportingPeriod')), r: { const: '2016-12-30', kind: 'date' } },
      { op: 'cmp', cmp: '>=', l: nd(R.concept('DateOfEndOfReportingPeriod')), r: { const: '2016-11-08', kind: 'date' } },
    ] };
    return ok('curated:snb-period-overlap', { type: 'tableRequired', tables: tablesOfSubject(), when }, { periods: ['CY'] });
  }

  // ---------------- one of two elements per table row
  if (/^One of these two elements should be mandatory i\.e\. If one is tagged then other one should not be mandatory, when table is created$/i.test(s) || /^One of these two elements should be mandatory i\.e$/i.test(s)) {
    const t = A.tables.find((x) => x.lineItems.includes(subject) && x.axes.length);
    const pair = row.siblings || [];
    if (t && pair.length === 2) return ok('pattern:one-of-two-per-row', { type: 'lineItemsMandatory', tables: [t.id], concepts: [], atLeastOne: [pair] });
  }
  if (/^One of the table should be entered if "yes" is selected in "(.+)"$/i.test(s)) {
    const b = X.bool(/"([^"]+)"$/.exec(s)[1], row);
    const tables = A.tables.filter((t) => (t.presentationCode || t.code).slice(0, 6) === code.slice(0, 6) && t.axes.length).map((t) => t.id);
    if (b && tables.length) return { ...ok('pattern:one-of-tables-if-yes', { type: 'tableRequired', tables, when: { op: 'cmp', cmp: '==', l: nd(b.q), r: { const: true } }, gate: false }, { periods: ['CY', 'PY'] }), resolved: [`question → ${b.q} (${b.how})`] };
  }

  // ---------------- conditional mandatory (heads + condition grammar)
  if (/^Mandatory table$/i.test(s) && (isTable || isAxis)) return ok('pattern:table-mandatory', { type: 'tableRequired', tables: tablesOfSubject(), when: null }, { periods: ['CY'] });
  const hm = HEAD.exec(s);
  if (!hm) return null;
  const c = parseCondition(hm[1].trim(), subject, row, R, A, X);
  if (!c) return null;
  if (c.resolved) resolved.push(...c.resolved);
  const withRes = (x) => (resolved.length ? { ...x, resolved } : x);
  if (A.concepts[subject].abstract && !isTable && !isAxis) return { status: 'NOT_APPLICABLE', reason: 'Abstract element: cannot carry a value; the same condition is executed on each of its line items (following rows)', resolved };
  if (isTable || isAxis) {
    const tables = tablesOfSubject();
    if (!tables.length) return null;
    const gate = /\bonly if\b/i.test(s);
    if (c.kind === 'pred') {
      if (c.nondim || c.concepts.every(nondim)) return withRes(ok('pattern:table-conditional', { type: 'tableRequired', tables, when: c.pred(nd), gate }, scopeOf()));
      if (c.concepts.length === 1) return withRes(ok('pattern:table-conditional', { type: 'tableRequired', tables, when: { op: 'anyFact', concept: c.concepts[0], pred: c.pred(() => self) }, gate }, scopeOf()));
    }
    if (c.kind === 'tables') return withRes(ok('pattern:table-if-table', { type: 'tableRequired', tables, when: { op: 'tableData', tables: c.tables }, gate }, scopeOf()));
    if (c.kind === 'tableAndNot') return withRes(ok('pattern:table-if-and-not-table', { type: 'tableRequired', tables, when: { op: 'and', args: [c.pred(nd), { op: 'not', arg: { op: 'tableData', tables: c.otherTables } }] }, gate }, scopeOf()));
    return null;
  }
  // element subject
  if (c.kind === 'member') return withRes(ok('pattern:mandatory-for-member', { type: 'memberMandatory', concept: subject, member: c.members[0], members: c.members }));
  if (c.kind === 'tables') return withRes(ok('pattern:mandatory-if-table', { type: 'mandatory', concept: subject, when: { op: 'tableData', tables: c.tables } }));
  if (c.kind === 'eachOf') return withRes(ok(`pattern:${c.impl}`, { type: 'eachFactOf', concept: c.concept, when: c.when, assert: { op: 'entered', e: { fact: subject } } }));
  if (c.kind === 'pred') {
    if (c.nondim || c.concepts.every(nondim)) return withRes(ok('pattern:mandatory-conditional', { type: 'mandatory', concept: subject, when: c.pred(nd) }));
    if (c.concepts.length === 1) return withRes(ok('pattern:mandatory-conditional', { type: 'eachFactOf', concept: c.concepts[0], when: c.pred(() => self), assert: { op: 'entered', e: { fact: subject } } }));
  }
  return null;
}

// Condition grammar. Returns
//   { kind: 'pred', concepts, nondim?, pred(ref) }   predicate over facts (ref(q) builds the operand)
//   { kind: 'member', members }                       a member (or its children) is used
//   { kind: 'tables', tables }                        a table has data
//   { kind: 'eachOf', concept, when, impl }           per fact of another element
function parseCondition(c0, subject, row, R, A, X) {
  const c = c0.replace(/\s+in (?:P&L|balance sheet|financial statements?|\[ ?\d{6}[a-z]?\].*)$/i, '').trim();
  let m;
  const yes = (q, v, how) => ({ kind: 'pred', concepts: [q], nondim: true, resolved: [`question → ${q} (${how})`], pred: (ref) => ({ op: 'cmp', cmp: '==', l: ref(q), r: { const: v } }) });
  const numCmp = (qs, cmp, how) => ({ kind: 'pred', concepts: qs, resolved: how ? [how] : undefined, pred: (ref) => (qs.length === 1 ? { op: 'cmp', cmp, l: ref(qs[0]), r: { const: 0 } } : { op: 'or', args: qs.map((q) => ({ op: 'cmp', cmp, l: ref(q), r: { const: 0 } })) }) });
  const anyQ = (t) => {
    const x = t.replace(/^['"\s]+|['"\s]+$/g, '');
    const q = R.concept(x);
    if (q && A.concepts[q].kind === 'item') return q;
    return null;
  };
  // Yes/No questions
  if ((m = /^["']?(yes|no)["']? is selected (?:in )?(?:the element |field |element )?["'](.+?)["']$/i.exec(c)) || (m = /^["']?(yes|no)["']? is selected in (\w+)$/i.exec(c))) {
    const b = X.bool(m[2], row); if (b) return yes(b.q, /^yes$/i.test(m[1]), b.how);
  }
  if ((m = /^["'](.+?)["'] is ["']?(yes|no)["']?$/i.exec(c)) || (m = /^(\w+)"* is ["']?(yes|no)["']?$/i.exec(c))) {
    const b = X.bool(m[1], row); if (b) return yes(b.q, /^yes$/i.test(m[2]), b.how);
  }
  if ((m = /^["']?yes["']? is selected in above element$/i.exec(c))) {
    const q = X.booleanBefore(row.elr.code, subject);
    if (q) return yes(q, true, 'the Yes/No element presented immediately above the table');
  }
  if ((m = /^["'](.+?)["'] and ["'](.+?)["'] both are ["']?yes["']?$/i.exec(c))) {
    const a = X.bool(m[1], row), b = X.bool(m[2], row);
    if (a && b) return { kind: 'pred', concepts: [a.q, b.q], nondim: true, resolved: [`questions → ${a.q} (${a.how}), ${b.q} (${b.how})`], pred: (ref) => ({ op: 'and', args: [a.q, b.q].map((q) => ({ op: 'cmp', cmp: '==', l: ref(q), r: { const: true } })) }) };
  }
  // numeric conditions
  if ((m = /^(?:amount entered in |value entered in |amount of |value in )?["']?([^'"]+?)["']? (?:or ["']([^'"]+)["'] )?is other than (?:0|zero)$/i.exec(c))) {
    let qs = [m[1], m[2]].filter(Boolean).map(anyQ);
    if (/^Others$/i.test(m[1].trim())) { const q = X.siblingByLabel(subject, row.elr.code, 'Others'); qs = q ? [q] : [null]; }
    if (qs.length && qs.every(Boolean)) return numCmp(qs, '!=', /^Others$/i.test(m[1].trim()) ? `"Others" → ${qs[0]} (the 'Others' amount under the same heading)` : null);
    // label phrases: "current financial assets" or "non current financial assets"
    const lab = [m[1], m[2]].filter(Boolean).map((x) => R.concept(x.replace(/\bnon current\b/i, 'non-current').replace(/liabilties/i, 'liabilities')) || R.concept('Total ' + x.replace(/\bnon current\b/i, 'non-current').replace(/liabilties/i, 'liabilities')));
    if (lab.length && lab.every((q) => q && A.concepts[q].kind === 'item')) return numCmp(lab, '!=', `labels → ${lab.join(', ')}`);
  }
  if ((m = /^value in ["'](\w+)["'] (?:in (?:balance sheet|financial statements?) )?is greater than zero$/i.exec(c0))) {
    const q = anyQ(m[1]); if (q) return numCmp([q], '>');
  }
  if ((m = /^amount of ["'](\w+)["'] in Balance Sheet is greater than zero AND ["'](\w+)["'] is not tagged$/i.exec(c0))) {
    const q = anyQ(m[1]); const other = R.tablesByHc(m[2]);
    if (q && other.length) return { kind: 'tableAndNot', concepts: [q], otherTables: other, pred: (ref) => ({ op: 'cmp', cmp: '>', l: ref(q), r: { const: 0 } }) };
  }
  if ((m = /^["'](\w+)["'] is more than ["'](\w+)["']$/i.exec(c))) {
    const a = anyQ(m[1]), b = anyQ(m[2]);
    if (a && b) return { kind: 'pred', concepts: [a, b], nondim: true, pred: (ref) => ({ op: 'cmp', cmp: '>', l: ref(a), r: ref(b) }) };
  }
  // presence of another element / table
  if ((m = /^(?:element |valid )?["']?(\w+)["']? (?:element )?(?:is )?(?:tagged|entered)$/i.exec(c)) || (m = /^(\w+) is entered in this table$/i.exec(c))) {
    const tb = R.tablesByHc(m[1]);
    if (tb.length) return { kind: 'tables', tables: tb };
    const q = anyQ(m[1]);
    if (q) return { kind: 'pred', concepts: [q], pred: (ref) => ({ op: 'entered', e: ref(q) }) };
  }
  if ((m = /^above (subsidiary|joint venture|associate) table is filled$/i.exec(c))) {
    const name = { subsidiary: 'DisclosureOfSignificantInvestmentsInSubsidiariesTable', 'joint venture': 'DisclosureOfJointVenturesTable', associate: 'DisclosureOfSignificantInvestmentsInAssociatesTable' }[m[1].toLowerCase()];
    const tb = A.tables.filter((t) => R.local(t.hypercube) === name && t.code.slice(0, 6) === row.elr.code.slice(0, 6)).map((t) => t.id);
    if (tb.length) return { kind: 'tables', tables: tb, resolved: [`"above ${m[1]} table" → ${tb.join(', ')}`] };
  }
  // members
  if ((m = /^(?:details in respect of |the member )?["'](.+?)["'](?: or its child members)? (?:are|is) (?:used|selected|entered)$/i.exec(c)) || (m = /^the member ["'](\w+)["']$/i.exec(c)) || (m = /^["'](\w+Member)["']$/i.exec(c))) {
    const mem = X.member(m[1]);
    if (mem) return { kind: 'member', members: /child members/i.test(c) ? X.memberAndDescendants(mem) : [mem] };
  }
  // enumerations
  if ((m = /^["'](.+?)["'] is selected in ["'](\w+)["']$/i.exec(c))) {
    const q = R.concept(m[2]) || R.concept(m[2].replace(/Secreterial/i, 'Secretarial'));
    const en = q && A.types[A.concepts[q].type]?.enumerations;
    const v = en && en.find((e) => e.toLowerCase() === m[1].toLowerCase());
    if (v) return { kind: 'pred', concepts: [q], nondim: true, resolved: q !== R.concept(m[2]) ? [`'${m[2]}' → ${q}`] : undefined, pred: (ref) => ({ op: 'cmp', cmp: '==', l: ref(q), r: { const: v } }) };
  }
  if ((m = /^"Mode of amount spent" is entered with any value except "Directly by company"$/i.exec(c))) {
    const q = R.concept('ModeOfAmountSpent');
    if (q) return { kind: 'eachOf', concept: q, impl: 'mandatory-if-enum-other', when: { op: 'cmp', cmp: '!=', l: { upper: { self: true } }, r: { const: 'DIRECTLY BY COMPANY' } } };
  }
  if ((m = /^(\w+) is (other than )?India$/i.exec(c))) {
    const q = R.concept(m[1]);
    if (q) return { kind: 'eachOf', concept: q, impl: m[2] ? 'mandatory-if-not-india' : 'mandatory-if-india', when: { op: 'cmp', cmp: m[2] ? '!=' : '==', l: { upper: { self: true } }, r: { const: 'INDIA' } } };
  }
  return null;
}
