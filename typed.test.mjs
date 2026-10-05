// Suites: typed dimensions (first class): related parties RelatedParty1..3 round trip (create → edit → save → reload →
// export → import → rename → export), sequential members (GR-3 / FM-16 explicit; typed are free identifiers), escaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, importSession } from './helpers.mjs';
import { exampleSession, T, runRule, TODAY } from './fixtures.mjs';
import { Filing } from './model.js';
import { Session } from './session.js';
import { sequentialGaps, nextTypedMember } from './dimensions.js';
import { generateInstance } from './generator.js';

const A = authority();
const RP = T('DisclosureOfTransactionsBetweenRelatedPartiesTable', '610800:');
const AX = q('RelatedPartyAxis');
const CAT = q('CategoriesOfRelatedPartiesAxis');
const row = (i, cat = 'OtherRelatedPartiesMember') => [{ axis: CAT, member: q(cat) }, { axis: AX, typed: `RelatedParty${i}` }];

function withRelatedParties() {
  const s = exampleSession();
  for (const sc of ['CY', 'PY']) s.setValue(q('WhetherThereAreAnyRelatedPartyTransactionsDuringYear'), sc, 'true');
  for (const [i, name] of [[1, 'Alpha Traders LLP'], [2, 'Beta Services Pvt Ltd'], [3, 'Director A']]) {
    for (const scope of ['CY', 'PY']) {
      const dims = row(i);
      s.setTableValue(RP, scope, dims, q('NameOfRelatedParty'), name);
      s.setTableValue(RP, scope, dims, q('DescriptionOfNatureOfRelatedPartyRelationship'), 'Entity with common director');
      s.setTableValue(RP, scope, dims, q('CountryOfIncorporationOrResidenceOfRelatedParty'), 'INDIA');
      s.setTableValue(RP, scope, dims, q('PermanentAccountNumberOfRelatedParty'), `AAACR000${i}A`);
      s.setTableValue(RP, scope, dims, q('DescriptionOfNatureOfTransactionsWithRelatedParty'), 'Purchase of services');
      s.setTableValue(RP, scope, dims, q('ServicesReceivedRelatedPartyTransactions'), String(1000 * i + (scope === 'PY' ? 1 : 0)));
      s.setTableValue(RP, scope, dims, q('ExpenseRecognisedDuringPeriodForBadAndDoubtfulDebtsForRelatedPartyTransaction'), '0');
    }
  }
  return s;
}

test('typed axis renders as typed (never an explicit dropdown) with its typed domain; next member suggested', () => {
  const s = exampleSession();
  s.setValue(q('WhetherThereAreAnyRelatedPartyTransactionsDuringYear'), 'CY', 'true');
  const { view } = s.openTable(RP, 'CY');
  const ax = view.axes.find((a) => a.axis === AX);
  assert.equal(ax.typed, true);
  assert.equal(ax.members.length, 0);
  assert.equal(ax.typedDomain, q('RelatedPartyDomain'));
  assert.equal(s.suggestTypedValue(RP, 'CY', AX), 'RelatedParty1');
  assert.equal(nextTypedMember(['Director1', 'Director2'], 'Director'), 'Director3');
});

test('RelatedParty1..3: create → edit → save → reload → export → import → rename → edit; typed values survive', () => {
  const s = withRelatedParties();
  assert.equal(s.suggestTypedValue(RP, 'CY', AX), 'RelatedParty4');
  s.setTableValue(RP, 'CY', row(2), q('NameOfRelatedParty'), 'Beta Services Private Limited');
  const s2 = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(s.filing.toJSON()))));
  assert.equal(s2.getValue(q('NameOfRelatedParty'), 'CY', row(2)).value, 'Beta Services Private Limited');
  const g = s2.validate({ today: TODAY });
  assert.equal(g.summary.errors, 0, g.issues.filter((i) => i.severity === 'ERROR').slice(0, 5).map((i) => i.message).join('\n'));
  const { xml } = s2.exportXml({ today: TODAY });
  for (const i of [1, 2, 3]) assert.match(xml, new RegExp(`<xbrldi:typedMember dimension="ind-as:RelatedPartyAxis"><ind-as:RelatedPartyDomain>RelatedParty${i}</ind-as:RelatedPartyDomain></xbrldi:typedMember>`));
  const { s: s3, report } = importSession(xml);
  assert.equal(report.unresolvedFacts.length, 0);
  for (const i of [1, 2, 3]) for (const scope of ['CY', 'PY']) assert.ok(s3.getValue(q('NameOfRelatedParty'), scope, row(i)), `RelatedParty${i} ${scope}`);
  s3.renameTypedMember(RP, 'CY', row(3), AX, 'RelatedParty3 ');
  s3.renameTypedMember(RP, 'CY', [{ axis: CAT, member: q('OtherRelatedPartiesMember') }, { axis: AX, typed: 'RelatedParty3 ' }], AX, 'RelatedParty3');
  s3.setTableValue(RP, 'CY', row(3), q('ServicesReceivedRelatedPartyTransactions'), '999');
  const { s: s4 } = importSession(s3.exportXml({ today: TODAY }).xml);
  assert.equal(s4.getValue(q('ServicesReceivedRelatedPartyTransactions'), 'CY', row(3)).value, '999');
  assert.equal(s4.getValue(q('NameOfRelatedParty'), 'PY', row(1)).value, 'Alpha Traders LLP');
  assert.throws(() => s3.renameTypedMember(RP, 'CY', row(1), AX, 'RelatedParty2'), /already exists/);
});

test('sequential members: explicit numbered members (GR-3, FM-16) must not skip; typed members are free identifiers', () => {
  assert.deepEqual(sequentialGaps(['RelatedParty1', 'RelatedParty2', 'RelatedParty3']), []);
  assert.deepEqual(sequentialGaps(['EquityShares1Member', 'EquityShares3Member']).map((g) => [g.prefix, g.missing, g.suffix]), [['EquityShares', 2, 'Member']]);
  assert.deepEqual(sequentialGaps(['9983', '99831313']), [], 'product codes are identifiers');
  const s = withRelatedParties();
  for (const f of s.filing.all().filter((x) => x.dims.some((d) => d.typed === 'RelatedParty2'))) s.filing.removeFact(f.key);
  assert.ok(!runRule(s, 'GR-3').fail, 'typed RelatedParty1, RelatedParty3 is accepted (MCA-validated instances use free identifiers)');
});

test('typed member values are XML-escaped and preserved exactly', () => {
  const s = withRelatedParties();
  s.setTableValue(RP, 'CY', [{ axis: CAT, member: q('OtherRelatedPartiesMember') }, { axis: AX, typed: 'R&D <Party> 4' }], q('NameOfRelatedParty'), 'A & B');
  const f = s.filing.all().find((x) => x.dims.some((d) => d.typed === 'R&D <Party> 4'));
  const yes = s.filing.all().filter((x) => x.concept === q('WhetherThereAreAnyRelatedPartyTransactionsDuringYear')); // the table exists for a Yes answer
  const { xml } = generateInstance(A, s.filing, [f, ...yes]);
  assert.match(xml, /<ind-as:RelatedPartyDomain>R&amp;D &lt;Party&gt; 4<\/ind-as:RelatedPartyDomain>/);
  const { s: s2 } = importSession(xml);
  assert.ok(s2.filing.all().some((x) => x.dims.some((d) => d.typed === 'R&D <Party> 4')));
});
