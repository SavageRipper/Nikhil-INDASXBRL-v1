// Authority compiler: MCA Ind AS source package -> canonical MCA authority model.
//   MCA_AUTHORITY.json
//   BUSINESS_RULE_COVERAGE.json
// Deterministic: identical inputs produce byte-identical outputs.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDTS, parseSchemas, parseLinkbases, ARC } from './dts.mjs';
import { buildDimensionalModel } from './tables.mjs';
import { compileBusinessRules } from './rule-formalizer.mjs';
import { ensureTaxonomy, TAXONOMY_DIR, ENTRY_POINT } from './taxonomy-source.mjs';
import { parseFormulaLinkbases } from './formula-source.mjs';

export const COMPILER_VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;          // flat repository: every source file sits at the repository root
const SRC = ROOT;
const OUT = ROOT;           // MCA_AUTHORITY.json + BUSINESS_RULE_COVERAGE.json (generated, git-ignored)

// Prescribed by the MCA XBRL Filing Manual for Ind AS Validation Tool V1.0 §1.1.3.1 (schemaRef table) for IND AS 2017.
const SCHEMA_REF = 'http://www.mca.gov.in/XBRL/2017/07/16/Taxonomy/Ind/in-ci-ent-2017-03-31.xsd';
const SCHEMA_REF_SOURCE = 'Filing Manual Ind AS V1.0 §1.1.3.1 (xlink:href table)';
const CIN_SCHEME = 'http://www.mca.gov.in/CIN'; // §1.1.3.1 #1
const CIN_SCHEME_SOURCE = 'Filing Manual Ind AS V1.0 §1.1.3.1 #1';
const RULES_FILE = 'Business_Rules_IndAS_Taxonomy_V1.2.xlsx';
const FILING_MANUAL = 'Filing_Manual_IndAS_V1.0.pdf';
const TAXONOMY_ZIP_NAME = 'Taxonomy_for_IND-AS_V1.2_31-03-2017.zip';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function roleCodeFactory(roles) {
  return (uri) => {
    const d = roles[uri]?.definition || '';
    const m = /^\[([0-9]{6}[a-z]?)\]/.exec(d);
    return m ? m[1] : uri.split('/').slice(-2).join('/');
  };
}

export function compile() {
  const entry = path.join(ensureTaxonomy(), ENTRY_POINT);
  const dts = loadDTS(entry);
  const schema = parseSchemas(dts);
  const lb = parseLinkbases(dts, schema);
  const roleCode = roleCodeFactory(schema.roles);

  // ---- concepts (+ labels, references) ----
  const concepts = {};
  for (const [qn, c] of Object.entries(schema.concepts).sort(([a], [b]) => a.localeCompare(b))) {
    const kind = classify(c);
    const out = { ...c, kind, labels: lb.labels[qn] || {} };
    delete out.id;
    if (lb.references[qn]) out.references = lb.references[qn];
    concepts[qn] = out;
  }

  // ---- relationships per ELR ----
  const byKind = (k) => lb.arcs.filter((a) => a.kind === k);
  const group = (arcs, pick) => {
    const g = {};
    for (const a of arcs) (g[a.elr] ||= []).push(pick(a));
    for (const v of Object.values(g)) v.sort((x, y) => (x.from === y.from ? x.order - y.order : x.from.localeCompare(y.from)) || x.to.localeCompare(y.to));
    return sortObj(g);
  };
  const presentation = group(byKind('presentationArc'), (a) => strip({ from: a.from, to: a.to, order: a.order, preferredLabel: a.preferredLabel }));
  const calculation = group(byKind('calculationArc'), (a) => ({ from: a.from, to: a.to, weight: a.weight, order: a.order }));
  const defArcs = byKind('definitionArc');
  const definition = group(defArcs, (a) => strip({ arcrole: a.arcrole.split('/').pop(), from: a.from, to: a.to, order: a.order, targetRole: a.targetRole, closed: a.closed, contextElement: a.contextElement, usable: a.usable }));

  // ---- ELRs (presentation roles are the user-facing statements/notes) ----
  const elrs = Object.keys(presentation).map((uri) => {
    const arcs = presentation[uri];
    const tos = new Set(arcs.map((a) => a.to));
    const roots = [...new Set(arcs.map((a) => a.from))].filter((f) => !tos.has(f));
    const r = schema.roles[uri];
    const code = roleCode(uri);
    const title = (r?.definition || '').replace(/^\[[^\]]+\]\s*/, '');
    // grouping from the ELR title (Ind AS: "Notes - …", "Disclosure(s) - …", statements otherwise)
    const group = /^Notes\b/i.test(title) ? 'Notes' : /^Disclosures?\b/i.test(title) ? 'Disclosures' : 'Statements';
    return { uri, code, title, definition: r?.definition || '', roots, group };
  }).sort((a, b) => a.code.localeCompare(b.code));

  // concept -> presentation ELRs (used for ELR-scoped applicability)
  const conceptElrs = {};
  for (const [uri, arcs] of Object.entries(presentation)) for (const a of arcs) for (const q of [a.from, a.to]) {
    const s = (conceptElrs[q] ||= []);
    if (!s.includes(uri)) s.push(uri);
  }
  for (const v of Object.values(conceptElrs)) v.sort();

  // ---- dimensional model ----
  const dim = buildDimensionalModel({ defArcs, concepts: schema.concepts, roleCode });
  // map each table to the presentation ELR in which its hypercube is presented
  for (const t of dim.tables) {
    const pres = (conceptElrs[t.hypercube] || []);
    // the same hypercube is presented in several ELRs (e.g. DisclosureOfDetailsOfSubsidiariesTable in [611500] and in
    // the consolidated-only [613400]): the table's own ELR (same code as its definition ELR) wins
    const own = pres.find((u) => elrs.find((e) => e.uri === u)?.code.slice(0, 6) === t.code.slice(0, 6));
    t.presentationElr = own || pres[0] || elrs.find((e) => e.code === t.code.replace(/[a-z]$/, ''))?.uri || null;
    t.presentationCode = elrs.find((e) => e.uri === t.presentationElr)?.code || null;
  }
  dim.tables.sort((a, b) => a.id.localeCompare(b.id));

  // ---- formula linkbase (cross-period value assertions: opening + change = closing) ----
  const formulas = parseFormulaLinkbases(dts, schema);

  // ---- ELR profile: statements the runtime needs by role (derived from the role URIs, never hard-coded codes)
  const profile = buildProfile(elrs);

  // ---- business rules ----
  // Prefer the original workbook (complete); fall back to the text export (may be truncated).
  const rulesName = RULES_FILE;
  if (!existsSync(path.join(SRC, rulesName))) throw new Error(`Business-rule workbook ${rulesName} not found`);
  const rulesFile = path.join(SRC, rulesName);
  const partial = { concepts, elrs, types: schema.types, tables: dim.tables, defaults: dim.defaults, presentation, calculation, conceptElrs, hypercubes: dim.hypercubes, conceptHypercubes: dim.conceptHypercubes, formulas, profile };
  const br = compileBusinessRules(rulesFile, partial);

  // ---- provenance ----
  const sources = [...dts.files.values()].map((f) => ({ file: '.taxonomy/IndAS/' + f.rel, kind: f.kind, sha256: f.sha256, bytes: f.bytes })).sort((a, b) => a.file.localeCompare(b.file));
  for (const extra of [rulesName, FILING_MANUAL, TAXONOMY_ZIP_NAME]) {
    sources.push({ file: extra, kind: 'authority-document', sha256: sha(path.join(SRC, extra)) });
  }
  // evidence from MCA-validated reference instances (golden-DIVERGENCES.json)
  const divPath = path.join(SRC, 'golden-DIVERGENCES.json');
  const divergences = existsSync(divPath) ? JSON.parse(readFileSync(divPath, 'utf8')) : { schemaRefs: [], rules: [] };
  if (existsSync(divPath)) sources.push({ file: 'golden-DIVERGENCES.json', kind: 'reference-evidence', sha256: sha(divPath) });
  for (const d of divergences.rules) {
    const r = br.model.rules.find((x) => x.id === d.ruleId);
    if (!r) throw new Error(`DIVERGENCES.json references unknown rule ${d.ruleId}`);
    r.severity = 'WARNING';
    r.divergence = d.evidence;
    const c = br.coverage.rules.find((x) => x.ruleId === d.ruleId);
    c.severity = 'WARNING'; c.divergence = d.evidence;
  }
  // element-level calibration against MCA-validated instances (GOLDEN_CALIBRATION.json): the named element of a
  // mandatory-line-items rule is reported as a warning (the rest of the rule stays blocking)
  const calPath = path.join(SRC, 'GOLDEN_CALIBRATION.json');
  if (existsSync(calPath)) {
    sources.push({ file: 'GOLDEN_CALIBRATION.json', kind: 'reference-evidence', sha256: sha(calPath) });
    for (const e of JSON.parse(readFileSync(calPath, 'utf8')).entries || []) {
      const r = br.model.rules.find((x) => x.id === e.rule);
      const q = r && (r.ast?.concepts || []).find((c) => c.split(':')[1] === e.concept);
      if (!q || r.ast.type !== 'lineItemsMandatory') throw new Error(`GOLDEN_CALIBRATION.json: ${e.rule} has no mandatory line item ${e.concept}`);
      (r.ast.softConcepts ||= []).push(q);
      (r.calibration ||= []).push({ concept: q, severity: e.severity, evidence: e.evidence });
      const c = br.coverage.rules.find((x) => x.ruleId === e.rule);
      if (c) (c.calibration ||= []).push(`${e.concept}: ${e.severity} — ${e.evidence}`);
    }
  }
  // release-owner approvals of known limitations (APPROVED_LIMITATIONS.json): an approved UNIMPLEMENTED rule stays
  // UNIMPLEMENTED and is shown as "APPROVED LIMITATION / NOT EXECUTED" — never executed, never PASS
  const limPath = path.join(SRC, 'APPROVED_LIMITATIONS.json');
  const limitations = existsSync(limPath) ? JSON.parse(readFileSync(limPath, 'utf8')).limitations || [] : [];
  if (existsSync(limPath)) sources.push({ file: 'APPROVED_LIMITATIONS.json', kind: 'release-owner-approvals', sha256: sha(limPath) });
  for (const l of limitations.filter((x) => x.kind === 'rule' && x.approved === true)) {
    const r = br.model.rules.find((x) => x.id === l.id);
    if (!r || r.status !== 'UNIMPLEMENTED') throw new Error(`APPROVED_LIMITATIONS.json approves ${l.id}, which is not an UNIMPLEMENTED rule`);
    r.approvedLimitation = { approvedBy: l.approvedBy || null, description: l.description };
    br.coverage.rules.find((x) => x.ruleId === l.id).approvedLimitation = 'APPROVED LIMITATION / NOT EXECUTED';
  }
  const authorityHash = createHash('sha256').update(JSON.stringify(sources)).digest('hex');

  const authority = {
    meta: {
      name: 'MCA Ind AS Taxonomy 2017 authority model',
      taxonomyVersion: 'Ind AS Taxonomy 2017-03-31 V1.2 (in-ci-ent, Commercial and Industrial companies)',
      taxonomyShort: 'Ind AS 2017',
      entryPoint: ENTRY_POINT,
      schemaRef: SCHEMA_REF,
      schemaRefSource: SCHEMA_REF_SOURCE,
      acceptedSchemaRefs: [{ href: SCHEMA_REF, source: SCHEMA_REF_SOURCE }, ...divergences.schemaRefs.map((x) => ({ href: x.href, source: x.evidence }))],
      cinScheme: CIN_SCHEME,
      cinSchemeSource: CIN_SCHEME_SOURCE,
      profile,
      compilerVersion: COMPILER_VERSION,
      authorityHash,
      sources,
      externalSchemas: dts.external,
      relationshipStats: {
        rawArcs: lb.rawCount, prohibitedGroups: lb.prohibitedCount,
        presentationArcs: byKind('presentationArc').length,
        calculationArcs: byKind('calculationArc').length,
        definitionArcs: defArcs.length,
        all: defArcs.filter((a) => a.arcrole === ARC.all).length,
        notAll: defArcs.filter((a) => a.arcrole === ARC.notAll).length,
        dimensionDefault: defArcs.filter((a) => a.arcrole === ARC.dimDefault).length,
        hypercubeDimension: defArcs.filter((a) => a.arcrole === ARC.hcDim).length,
      },
      formulaAssertions: formulas.assertions.length,
    },
    namespaces: sortObj(schema.namespaces),
    types: sortObj(schema.types),
    roles: sortObj(Object.fromEntries(Object.entries(schema.roles).map(([u, r]) => [u, { ...r, code: roleCode(u) }]))),
    concepts,
    elrs,
    conceptElrs: sortObj(conceptElrs),
    presentation,
    calculation,
    definition,
    dimensionDefaults: sortObj(dim.defaults),
    hypercubes: sortObj(dim.hypercubes),
    conceptHypercubes: sortObj(dim.conceptHypercubes),
    tables: dim.tables,
    formulas,
    businessRules: br.model,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'MCA_AUTHORITY.json'), JSON.stringify(authority));
  writeFileSync(path.join(OUT, 'BUSINESS_RULE_COVERAGE.json'), JSON.stringify(br.coverage, null, 1));
  return { authority, coverage: br.coverage };
}

function classify(c) {
  const sg = c.substitutionGroup || '';
  if (sg === 'xbrldt:hypercubeItem') return 'hypercube';
  if (sg === 'xbrldt:dimensionItem') return c.typedDomainRef ? 'typedAxis' : 'explicitAxis';
  if (!c.type) return 'typedDomain';
  if (c.type === 'nonnum:domainItemType') return 'member';
  if (c.abstract) return 'abstract';
  return 'item';
}
function strip(o) { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null) delete o[k]; return o; }
function sortObj(o) { return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))); }

// Statements the runtime addresses by role. Each is found by the extended-link id at the start of its role URI
// (…/BalanceSheet_110000, …/CashFlowStatementDirect_310000, …/DisclosureOfGeneralInformationAboutCompany_700300),
// the same ids as the 'Applicable ELR' sheet of the MCA business-rule workbook.
function buildProfile(elrs) {
  const find = (id) => {
    const e = elrs.find((x) => new RegExp(`/${id}_\\d{6}$`).test(x.uri));
    if (!e) throw new Error(`ELR ${id} not found in the taxonomy`);
    return e.code;
  };
  return {
    balanceSheet: find('BalanceSheet'),
    profitAndLoss: find('StatementOfProfitAndLoss'),
    cashFlowDirect: find('CashFlowStatementDirect'),
    cashFlowIndirect: find('CashFlowStatementIndirect'),
    changesInEquity: find('StatementOfChangesInEquity'),
    generalInformation: find('DisclosureOfGeneralInformationAboutCompany'),
    cashFlowMethods: { 'Direct Method': find('CashFlowStatementDirect'), 'Indirect Method': find('CashFlowStatementIndirect') },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const t0 = Date.now();
  const { authority, coverage } = compile();
  const s = authority.meta.relationshipStats;
  console.log(`concepts=${Object.keys(authority.concepts).length} elrs=${authority.elrs.length} tables=${authority.tables.length} all=${s.all} notAll=${s.notAll} defaults=${s.dimensionDefault} calcArcs=${s.calculationArcs} formulaAssertions=${authority.formulas.assertions.length}`);
  console.log('rule coverage:', JSON.stringify(coverage.summary));
  const c = coverage.corpus;
  console.log(`rule source: ${c.sourceFile} (${c.sourceForm})`);
  for (const sh of c.sheets) console.log(`  sheet "${sh.name}": ${sh.rows} rows${sh.truncated ? '  ** TRUNCATED **' : ''}`);
  console.log(`specific-rule rows=${c.specificRuleRows} generic rules=${c.genericRuleCount} mandatory-line-item rows=${c.mandatoryLineItemRows}`);
  console.log(`first ELR=${c.firstElrInSpecificRules} last ELR=${c.lastElrInSpecificRules}`);
  console.log(`specificRulesSheetTruncated=${c.specificRulesSheetTruncated}`);
  console.log(`done in ${Date.now() - t0}ms`);
}
