// Suites: explicit dimensions, typed dimensions (syntax), hypercube validity, all / notAll / default (Filing Manual
// #30, #33–#35), and the controller as the authoritative layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, newSession } from './helpers.mjs';
import { checkDimensionSyntax, dimensionallyValid, nondimAllowed } from './dimensions.js';
import { DimensionError } from './session.js';
import { T } from './fixtures.mjs';

const A = authority();
const PPE = { classes: q('ClassesOfPropertyPlantAndEquipmentAxis'), sub: q('SubClassesOfPropertyPlantAndEquipmentAxis'), carry: q('CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis') };
const codes = (dims) => checkDimensionSyntax(A, dims).map((e) => e.code);

test('explicit: valid member accepted; foreign / default / duplicate / unknown rejected', () => {
  assert.deepEqual(checkDimensionSyntax(A, [{ axis: PPE.classes, member: q('LandMember') }]), []);
  assert.ok(codes([{ axis: PPE.classes, member: q('GoodwillMember') }]).includes('dim.memberNotInDomain'));
  assert.ok(codes([{ axis: PPE.classes, member: q('PropertyPlantAndEquipmentMember') }]).includes('dim.defaultReported'), 'Filing Manual #30');
  assert.ok(codes([{ axis: PPE.classes, member: q('LandMember') }, { axis: PPE.classes, member: q('BuildingsMember') }]).includes('dim.duplicateAxis'));
  assert.ok(codes([{ axis: 'ind-as:NoSuchAxis', member: q('LandMember') }]).includes('dim.unknownAxis'));
  // the Ind AS 2017 DTS declares no usable="false" member: the check exists but has nothing to reject
  let unusable = 0;
  for (const hc of Object.values(A.json.hypercubes)) for (const ax of hc.axes) for (const m of ax.members || []) if (!m.usable) unusable++;
  assert.equal(unusable, 0);
});

test('typed: typed axis needs a non-empty typed value, never an explicit member', () => {
  const ax = q('RelatedPartyAxis');
  assert.equal(A.concept(ax).kind, 'typedAxis');
  assert.deepEqual(checkDimensionSyntax(A, [{ axis: ax, typed: 'RelatedParty1' }]), []);
  assert.ok(codes([{ axis: ax, typed: '  ' }]).includes('dim.emptyTyped'));
  assert.ok(codes([{ axis: ax, member: q('LandMember') }]).includes('dim.typedAsExplicit'));
  assert.ok(codes([{ axis: PPE.classes, typed: 'x' }]).includes('dim.explicitAsTyped'));
});

test('hypercube: axes of the table accepted, foreign axis rejected, defaults fill absent axes; non-dimensional items carry no dimensions (#34, #35)', () => {
  const ok = dimensionallyValid(A, q('PropertyPlantAndEquipment'), [{ axis: PPE.classes, member: q('LandMember') }]);
  assert.equal(ok.valid, true, ok.reason);
  const full = dimensionallyValid(A, q('PropertyPlantAndEquipment'), [{ axis: PPE.classes, member: q('LandMember') }, { axis: PPE.sub, member: q('OwnedAssetsMember') }, { axis: PPE.carry, member: q('GrossCarryingAmountMember') }]);
  assert.equal(full.valid, true, full.reason);
  const foreign = dimensionallyValid(A, q('PropertyPlantAndEquipment'), [{ axis: PPE.classes, member: q('LandMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('BondsMember') }]);
  assert.equal(foreign.valid, false);
  assert.equal(dimensionallyValid(A, q('RevenueFromOperations'), [{ axis: PPE.classes, member: q('LandMember') }]).valid, false);
  assert.equal(nondimAllowed(A, q('RevenueFromOperations')), true);
  assert.equal(nondimAllowed(A, q('PropertyPlantAndEquipment')), true, 'balance-sheet item = default context of the PPE table');
  assert.equal(nondimAllowed(A, q('NameOfAuditFirm')), false, 'typed-axis table item has no default context');
});

test('notAll: NatureOfOtherPropertyPlantAndEquipmentOthers excluded on the member combinations of the not-all ELR', () => {
  const t = A.table(T('DisclosureOfPropertyPlantAndEquipmentTable'));
  const na = t.notAll.find((n) => n.primary === q('NatureOfOtherPropertyPlantAndEquipmentOthers'));
  assert.ok(na, 'notAll attached to NatureOfOtherPropertyPlantAndEquipmentOthers');
  const naClasses = na.axes.find((a) => a.axis === PPE.classes).members;
  const excluded = naClasses.find((m) => m !== A.dimensionDefault(PPE.classes));
  const allowed = t.axes.find((a) => a.axis === PPE.classes).members.map((m) => m.member).find((m) => !naClasses.includes(m) && m !== A.dimensionDefault(PPE.classes));
  assert.ok(allowed, 'some class member is outside the notAll domain');
  const bad = dimensionallyValid(A, q('NatureOfOtherPropertyPlantAndEquipmentOthers'), [{ axis: PPE.classes, member: excluded }]);
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /notAll/);
  const good = dimensionallyValid(A, q('NatureOfOtherPropertyPlantAndEquipmentOthers'), [{ axis: PPE.classes, member: allowed }]);
  assert.equal(good.valid, true, good.reason);
  assert.equal(A.meta.relationshipStats.notAll, 71);
});

test('controller rejects dimensionally invalid writes (authoritative layer, not the UI)', () => {
  const s = newSession();
  s.setValue(q('BorrowingsNoncurrent'), 'CY', '500');
  const id = T('ClassificationOfBorrowingsTable');
  assert.throws(() => s.setTableValue(id, 'CY', [{ axis: q('ClassificationOfBorrowingsAxis'), member: q('BorrowingsMember') }], q('Borrowings'), '1'), DimensionError, 'default member');
  assert.throws(() => s.setTableValue(id, 'CY', [{ axis: PPE.classes, member: q('LandMember') }], q('Borrowings'), '1'), DimensionError, 'foreign axis');
  // no member: on a table whose axes all have defaults this is the table total (every axis at its default member)
  assert.equal(s.setTableValue(id, 'CY', [], q('Borrowings'), '1').dims.length, 0, 'total column');
  s.filing.removeFact(s.filing.get(q('Borrowings'), s.filing.period(q('Borrowings'), 'CY'), []).key);
  // … on a table with a typed axis (no default) a row needs its member
  assert.throws(() => s.setTableValue(T('DetailsRegardingAuditorsTable'), 'CY', [], q('CategoryOfAuditor'), 'Individual'), DimensionError, 'no member on a typed axis');
  const f = s.setTableValue(id, 'CY', [{ axis: q('ClassificationBasedOnCurrentNoncurrentAxis'), member: q('NoncurrentMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansMember') }, { axis: q('SubclassificationOfBorrowingsAxis'), member: q('SecuredBorrowingsMember') }], q('Borrowings'), '500');
  assert.equal(f.dims.length, 3);
});
