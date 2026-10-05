# Feature and compliance audit — Nikhil-IndASXBRL-v1

Scope: every feature of the agreed list (A–G, carried over from the C&I tool and extended for Ind AS), the MCA Ind AS 2017
taxonomy V1.2, the business-rule workbook V1.2 (all 10 sheets) and the Filing Manual Ind AS V1.0.
Evidence is executable: test files (`node --test …`), the rule-by-rule audit (`npm run audit` → `RULE_AUDIT.json`), Arelle
validation (`npm run test:xsd`) and the headless-browser regression on the built `index.html` (`node browser-smoke.mjs`).
Status values: **VERIFIED** (automated evidence passes), **PARTIAL** (works, with a stated limit), **PENDING** (needs input
from you). Nothing is marked verified without a passing check.

Last full run (clean copy, `npm run release`, 2026-10-04, build 32361aeaa8): 173 tests — 173 pass, 0 fail, 0 skipped;
Arelle (incl. formula linkbase): validated ICOM instance, its regenerated instance and the example all PASS; browser 75/75
checks; rule audit 1,114 VERIFIED + 35 hand-tested, 0 without evidence. Compiled taxonomy/rule authority unchanged
(sha256 25bdfa32…). **Release gate: PASSED.** `ML-43-b` approved by the release owner on 2026-10-03 (APPROVED
LIMITATION / NOT EXECUTED).

## A. Architecture

| # | Feature | Status | Evidence |
|---|---|---|---|
| A1 | Taxonomy compiler from the entry point (concepts, types, labels, presentation, calculation, definition, tables, all/notAll, defaults, typed axes, formula linkbase); source fingerprints | VERIFIED | `taxonomy.test.mjs`: counts equal the raw DTS files (5,647 concepts; 175 all-arcs = 175 tables; 71 notAll; 70 defaults; 1,269 calculation arcs; 287 hypercube-dimension arcs; 36 value assertions); provenance hashes; deterministic recompile |
| A2 | Rule compiler reads the original workbook, all sheets, no truncation | VERIFIED | `rules-source.test.mjs`: 10 sheets, 812 specific rows, 16 generic, 108 ML, Applicable ELR = the 60 ELRs, formula sheet ⇔ taxonomy assertions |
| A3 | One status per clause; nothing silently passes | VERIFIED | 1,541 entries: EXECUTABLE 1,462 · REVIEW_ONLY 60 · NOT_APPLICABLE 18 · UNIMPLEMENTED 1; every non-executable entry carries a reason; engine test: no PASS without evaluation |
| A4 | One engine per concern; the session controller checks applicability and dimensions on every edit | VERIFIED | `dimensions.test.mjs` (controller rejects invalid writes), `applicability.test.mjs` (closed tables cannot be opened or written) |
| A5 | Single offline HTML app, also `index.html` | VERIFIED | `build.mjs`; release gate: embedded authority = compiled authority; `indas-xbrl.html` identical to `index.html` |
| A6 | Flat repository; taxonomy kept zipped; generated files git-ignored | VERIFIED | `.gitignore`; `taxonomy-source.mjs` unpacks to `.taxonomy/` |
| A7 | Release gate blocks on unresolved rules unless approved | VERIFIED | `release-gate.mjs`; `rules.test.mjs`: ML-43-b approval path shows APPROVED LIMITATION / NOT EXECUTED, never PASS |
| A8 | Honest status ("MCA validation tool · not run") | VERIFIED | browser check "XML generated after the internal gate passed"; status chip text |

## B. Data entry UI

| # | Feature | Status | Evidence |
|---|---|---|---|
| B1 | Navigation of all statements/notes with status dots; phone "Sheets" button; dark mode | VERIFIED | browser: 60 ELRs listed; CSS media queries |
| B2 | Statement grids (current / previous; third column under first-time adoption) | VERIFIED | browser: FTA column checks |
| B3 | Tables per year, axis members, add/remove rows; typed axes free text with suggestion | VERIFIED | `typed.test.mjs`; browser: shareholders table row added |
| B4 | Entry scale incl. **Hundreds**; rupees in XML, no precision/scale; decimals preserved | VERIFIED | `numeric.test.mjs` (8 scale round trips, imported decimals kept, non-significant digits 0) |
| B5 | Autosave, project save/open, new filing, marked example | VERIFIED | browser: restored after reload |
| B6 | Validate with filters; generate, copy, download | VERIFIED | browser: validation, generation |
| B7 | Rule coverage viewer | VERIFIED | app view `coverage` |
| B8 | Import report | VERIFIED | `import-years.test.mjs`, browser import checks |
| B9 | Mandatory marking in the UI (business rules; live conditions; table line items; empty mandatory cells outlined) | VERIFIED | browser: Mandatory tag + rule tooltip, required marker on cells, company form tags; decided by the same rule engine as validation |

## C. Fixes carried over from the C&I tool

| # | Fix | Status | Evidence |
|---|---|---|---|
| C1 | `index.html` always emitted, never ignored | VERIFIED | build + `.gitignore` |
| C2 | Golden regression on MCA-validated XMLs | VERIFIED | `golden-icom-analytics-2022-23.xml` — see "Golden regression" below |
| C3 | Default member only within the hypercube's domain | VERIFIED | `dimensions.js` hcSatisfied; dimension tests |
| C4 | "Members 1…n" checks taxonomy members only (typed = free identifiers) | VERIFIED | `typed.test.mjs` |
| C5 | Parent-member rule never demands the axis default | VERIFIED | `rule-families.test.mjs` FM-14/FM-15 |
| C6 | Calculation totals per statement; satisfied by any network that applies | VERIFIED | `calculation.test.mjs` (every arc exercised, PASS + FAIL) |
| C7 | A line item shared by two tables belongs to the table whose axes match exactly | VERIFIED | `rules.test.mjs` "shared line items" (now enforced in every table check, see D-6 below) |
| C8 | An element that cannot carry the trigger's dimensions is looked up without them | VERIFIED | `expr.js` entered-predicate; rule audit |
| C9 | Disallowed HTML entities are warnings | VERIFIED | gate `html.entity` WARNING |
| C10 | Imported decimals kept on edit | VERIFIED | `numeric.test.mjs` |
| C11 | Accepted schemaRef list; imported file keeps its own | VERIFIED | `MCA_AUTHORITY.json` meta.acceptedSchemaRefs; io tests |
| C12 | Contradicted rules become warnings, element by element | VERIFIED | `GOLDEN_CALIBRATION.json` (ML-44 date of birth, ML-45 turnover of highest product); `rule-families.test.mjs`: the calibrated element warns, any other missing element still blocks |
| C13 | "Mandatory if" ≠ "only if" | VERIFIED | `rule-indas.mjs` gate flag; applicability tests |
| C14 | Calculations 1.1 (round-to-nearest) | VERIFIED | `calculation.test.mjs` |
| C15 | CY/PY pairing not member by member | VERIFIED | `rule-families.test.mjs` GR-5 |
| C16 | Percentage totals allow per-value rounding | VERIFIED | `rule-families.test.mjs` SR-L663-1 |
| C17 | KMP transactions count as a related-party transaction | VERIFIED (mechanism) | rule-formalizer AT_LEAST_ONE_ALSO |
| C18 | Rich text: block tags, Word paste, deterministic | VERIFIED | `richtext.test.mjs`; browser rich-text checks |
| C19 | Offline Arelle validation | VERIFIED | `xsd.test.mjs` (incl. formula linkbase) |
| C20 | PASS and FAIL evidence for every rule | VERIFIED | `rule-audit.test.mjs` + `rule-families.test.mjs` |
| C21 | Browser tests on the built app; clean release run | VERIFIED | `browser-smoke.mjs` 59/59 (incl. the validated instance through the real UI); release run from a clean copy |
| C22 | Warning about real financials in golden files | VERIFIED | README |
| C23 | xml:lang only on the XBRL base text types (MCA Validator rejected it on PAN/CIN/DIN/list types in the C&I tool) | VERIFIED | `mca-html.test.mjs` (regenerated ICOM instance: none on restricted types), `io.test.mjs` #28/#29, browser check; ICOM (MCA-validated) has xml:lang on no fact |
| C24 | Previous-year figures in tabs without a previous year (GR-11) are not stored, shown, validated or generated | VERIFIED | `workbench.test.mjs` |
| C25 | Pasted Word/Excel tables rebuilt for the MCA HTML schema (no colgroup/col/caption/colspan/rowspan, tbody, class only), padding removed, borders, emphasis option | VERIFIED | `mca-html.test.mjs`, browser paste checks; ICOM text blocks pass unchanged |
| C26 | Gate blocks schema-rejected HTML and XML-illegal control characters, with the fix in the message | VERIFIED | `mca-html.test.mjs` |
| C27 | Build id in the header and in every generated XML (stale cached page detection) | VERIFIED | `mca-html.test.mjs`, browser check |
| C28 | MCA error help tab (validator messages explained, grouped, linked to cells) | VERIFIED | `mca-html.test.mjs`, browser check |
| C29 | Usability (UI only): sticky headings and label column, row shading/highlight, Enter/Shift+Enter/↑/↓ grid movement, Ctrl+S, dialog keyboard handling and focus, accessible cell names / aria-required / aria-invalid, skip link, confirmations for New filing and removing a filled row, text-block issue status | VERIFIED | 9 browser checks; unit, gate, Arelle and golden suites unchanged before and after; compiled authority unchanged |

## D. Import

| # | Feature | Status | Evidence |
|---|---|---|---|
| D1 | Preview, then Both years / Current year only (with current-year openings) | VERIFIED | `import-years.test.mjs` |
| D1b | **Roll forward** (last year's filing → previous year of the next filing) | VERIFIED | `import-years.test.mjs`, browser |
| D2 | Years detected from reporting-date facts | VERIFIED | `io.test.mjs` current/prior |
| D3 | Non-applicable facts go to the report | VERIFIED | `workbench.test.mjs` |
| D4 | Cash-flow method declared / detected / chosen | VERIFIED | `workbench.test.mjs` |
| D5 | Values under a "No" answer excluded and reported | VERIFIED | `workbench.test.mjs` |

## E. Workbench (8-point upgrade)

| # | Feature | Status | Evidence |
|---|---|---|---|
| E1 | Text Block popup editor, Filing Manual classes | VERIFIED | browser |
| E2 | One applicability decision for UI / import / validation / XML | VERIFIED | `applicability.test.mjs`, `workbench.test.mjs` |
| E3 | Cash-flow radios on the general-information page ([310000]/[320000]) | VERIFIED | browser |
| E4 | Validation locations, jump to the red cell | VERIFIED | `rules.test.mjs`, browser |
| E5 | Calculated cells: read-only, cascading, per-tab override kept, GR-1 still flags; imported totals kept until a child is edited | VERIFIED | `calculation.test.mjs`, `workbench.test.mjs`, browser |
| E6 | Validate current tab | VERIFIED | `workbench.test.mjs`, browser |
| E7 | Yes/No dependencies from executable rules; Yes → No asks; values kept but excluded; a field required by two questions is open when either is Yes | VERIFIED | `applicability.test.mjs`, browser |
| E8 | "Disclosure of General Information about Company" page ([700300]) incl. first-time adoption choice | VERIFIED | browser |

## F. Ind AS specific

| # | Feature | Status | Evidence |
|---|---|---|---|
| F1 | Ind AS 2017 DTS (ind-as + in-ca) | VERIFIED | `taxonomy.test.mjs` (the earlier estimate of 205 tables counted package files outside the DTS; the DTS has 175) |
| F2 | Formula linkbase: 36 assertions → 35 FX rules + auto-fill (1 binds an abstract element: recorded, not executable) | VERIFIED | `rules.test.mjs`, `xsd.test.mjs` (Arelle formula results = FX results) |
| F3 | Workbook V1.2, all 10 sheets | VERIFIED | `rules-source.test.mjs` |
| F4 | Country / currency fields with the workbook code lists | VERIFIED | browser datalist check; format rules in the audit |
| F5 | Exempt parent / child member and exempt-calculation sheets feed FM-14/FM-15 and GR-1 | VERIFIED | `rule-families.test.mjs` |
| F6 | Statement of changes in equity (components × movements) with roll-forward | VERIFIED | example + SR-L802-1 test |
| F7 | Other comprehensive income | VERIFIED | OR-dependency test (two OCI questions) |
| F8 | First-time adoption: opening balance sheet of the previous year, reconciliations [610900] | VERIFIED | `applicability.test.mjs`, `rules.test.mjs`, `rule-families.test.mjs` GR-16, Arelle FTA instance |
| F9 | Conditional tables per the workbook (e.g. [400500]) | VERIFIED | `applicability.test.mjs` |
| F10 | Standalone and consolidated | VERIFIED | consolidated filing gate-clean + Arelle PASS; GR-10/12/13 tests |

## G. Calculation and auto-fill

| # | Feature | Status | Evidence |
|---|---|---|---|
| G1 | Calculated totals across every statement and note | VERIFIED | `calculation.test.mjs` |
| G2 | Roll-forward auto-calculation from the formula linkbase | VERIFIED | `calculation.test.mjs`, `workbench.test.mjs` (PPE row) |
| G3 | Current-year opening = previous-year closing | VERIFIED | `rule-families.test.mjs` GR-6 |
| G4 | One value per element and context across tabs | VERIFIED | fact model keyed by concept + context |
| G5 | Dimension totals only where the taxonomy defines the calculation | VERIFIED | `workbench.test.mjs` (no leakage) |
| G6 | Import last year's XML into the previous year and openings | VERIFIED | roll forward (D1b) |
| G7 | Mismatch panel with jump-to-cell | VERIFIED | browser |
| G8 | Only taxonomy links used; overrides logged | VERIFIED | mismatch panel override log |

## Golden regression — MCA-validated ICOM Analytics Limited, FY 2022-23 (standalone)

Source: `golden-icom-analytics-2022-23.xml` (SAG Infotech output, MCA-validated; schemaRef = the 2017 Ind AS entry point
this tool uses). 3,207 facts, 575 contexts, 4 units, 986 dimension members, decimals −1 / 1 / INF.

| Check | Result |
|---|---|
| Arelle 2.46.0 offline: XML Schema, XBRL 2.1 incl. calculation, Dimensions, **formula linkbase** — source | PASS, 0 errors, 0 warnings, 0 unsatisfied assertions |
| Import: every fact, context, unit, typed/explicit member mapped | 3,207 / 3,207 (0 unknown, 0 unresolved, 0 conflicts); 4 answers under a "No" parent (all `false`) reported as not applicable |
| Internal gate on the validated instance | 0 errors (was 107 before calibration — see below); warnings only: 12 HTML entities (&amp;quot;/&amp;apos;, accepted by MCA), ML-43-b (approved), ML-44/ML-45 (calibrated) |
| Calculations | 579 networks PASS, 0 inconsistencies (Arelle agrees) |
| Regenerate → independent fact-level diff (XML parser only, not the importer) | 3,203 facts identical in value, unit, decimals and context incl. every text block; 0 changed, 0 added; the 4 not-applicable answers left out |
| Arelle on the regenerated instance (incl. formulas) | PASS |
| Every imported fact reachable in the UI | 3,203 / 3,203 (statement rows, table rows, table total columns, opening rows) |
| Edit round trip (scaled entry, totals no longer foot → gate blocks, restore → identical value and decimals) | PASS |
| Rich text: 25 text blocks through the popup editor | text identical, guideline-compliant, stable |
| Current-year-only import / roll forward into FY 2023-24 | PASS (143 opening facts carried; previous year = FY 2022-23 figures; current year empty except identity) |
| Real UI (headless Chromium): import, 60 tabs, totals column, validate, generate | PASS — generated XML equals the source fact for fact |

### What the validated instance showed (defects fixed)

12. **Table totals were invisible in the UI** — 238 facts (share capital, PPE, intangible assets, changes in equity,
    indebtedness totals: every axis at its default member) were kept and exported but had no cell → tables now show a
    *total* column (editable; removing it touches only the table's own line items).
13. **FM-14 / FM-15 / FM-16 too strict** — evaluated per full dimension combination; the validator works per element,
    axis and period ("for element 'E' … for axis (A) for period …"). The instance reports parent classes only without
    the category axis → now grouped per element / axis / period, one message per group. (58 + 18 + 16 false errors.)
14. **"Exempt Child Member Dimension" read the wrong way** — the sheet lists a parent and its exempted children; the
    engine looked the parent up as the exempted member → exempted children no longer count as required.
15. **Opening balances of the previous year too narrow** — only roll-forward balances were accepted at that date; the
    instance also reports their calculation components (deferred tax assets / liabilities under the opening
    DeferredTaxLiabilityAssets) → components accepted; GR-1 does not demand opening totals unless first-time adoption.
16. **Previous-year requirement for general-information elements** — DescriptionOfPresentationCurrency is a [700300]
    element (previous year excluded by GR-11) also presented in [613100]; required for the current year only now.
17. **"All details of at least one director"** demanded a middle name → middle names excluded.
18. **Editor added a `<p>` to every table cell** of imported HTML → single-paragraph cells written inline.
19. **GR-5 errors pointed at the entered year** → now at the missing cell (the other year).

### Calibrated, not changed (explicit V1.2 requirements the validated instance does not meet)

`GOLDEN_CALIBRATION.json`: ML-44 `DateOfBirthOfKeyManagerialPersonnelOrDirector` and ML-45
`TurnoverOfHighestContributingProductOrService` are missing on every row of the validated instance; they are reported as
warnings. Every other element of those rows still blocks.

## Filing Manual Ind AS V1.0

Technical specifications 1–35: covered by the gate and generator (`io.test.mjs` checks #1, #3–#8, #13, #14, #20, #24,
#26–#28, #30, #32, #35 on the generated example; Arelle covers #2/#29/#33/#34; CIN mismatch between identifier and
CorporateIdentityNumber is an error). HTML guidelines a–j: `richtext.test.mjs`.

Annexure II: #3/#4 types · #5 percentage rules · #6 GR-8 INR · #8 mandatory rules · #9 **FM-9** · #10 GR-5 ·
#12 ML-* · #13 SR-L6448-1 · #14 **FM-14** · #15 **FM-15** · #16 **FM-16** (per element, axis and period — calibrated on the
validated instance) · #17 table rules · #18 dimension validity ·
#19 FX-* (missing item = 0) · #20 GR-14 · #21 GR-16. (#1, #2, #7, #11: connectivity, PDF, tuples — none in Ind AS — and a
C&I example.)

## Defects found by this audit and fixed

1. Four row-level conditions (auditor / secretarial-auditor firm details) were compiled as non-dimensional facts and could
   never fire → now evaluated per row; a compiler check rejects any such condition.
2. Five "All line items are mandatory" rows compiled to an empty requirement → now list the table's line items; an empty
   requirement can no longer compile.
3. A member-driven requirement whose element sits outside the member's table never fired → engine fixed.
4. Yes/No dependencies: a field required by either of two questions was closed when one was No → OR semantics.
5. Four tables were attached to the wrong tab when a hypercube is presented in two ELRs (e.g. standalone subsidiaries
   table shown under the consolidated-only [613400]) → own ELR wins.
6. A line item shared by two tables made rows of one table count as rows of the other (e.g. a share-capital row satisfied
   the >5 % shareholders table) → one membership rule used by every table check, the UI and the dialogs.
7. Annexure II #14/#15/#16 and #9 were not executed (the workbook's exemption sheets presuppose them) → FM rules added.
8. GR-14 (Annexure II #20) could never fail on Ind AS tables (all axes have defaults) → implemented as the manual states.
9. FX rules evaluated contexts where the change element cannot exist → skipped there (as the formula processor does).
10. Derived totals could carry digits below their `decimals` after a change of rounding level (technical specification #13) →
    decimals of a total never coarser than its exact value.
11. Mandatory messages for the opening balance sheet showed the wrong date → fixed.

## Open items

1. `ML-43-b` — approved as a limitation by the release owner (2026-10-03); shown as APPROVED LIMITATION / NOT EXECUTED.
   Revisit if MCA clarifies the clause.
2. One validated instance (standalone). A consolidated MCA-validated instance would calibrate the consolidated-only
   paths the same way; its PDF would add the label-by-label cross-check (`golden.test.mjs` runs it when present).
3. FM-14/FM-15 on non-numeric elements stay warnings: the validated instance reports parent members for text items too,
   so it neither confirms nor refutes blocking.
4. Official MCA XBRL Validation Tool run — outside this environment.

## H. Last stage — UI completion (after the release run above)

The last full release run above predates these items. They were built and checked in a sandbox without npm, a browser
or the MCA-reference XML parser, so their status is capped at PARTIAL until `npm run release` has been run on a
complete checkout.

| # | Feature | Status | Evidence |
|---|---|---|---|
| H1 | Copy from previous year (current-year dimensional tables): plan (new columns, values), copies values without overwriting, columns registered in the table, idempotent, reason when unavailable | PARTIAL | `carry-forward.test.mjs` (3 tests, pass). Toolbar button and confirmation dialog: not exercised in a browser |
| H2 | Footnotes: add, edit text, link, unlink, remove; text required; cell must have a value; persists through project save and reload | PARTIAL | `footnotes.test.mjs` (5 tests, pass). Footnotes view: markup render-checked outside the browser (escaping, unlinked warning, cell picker). Not exercised in a browser; XML output of footnotes already covered by the generator tests |
| H3 | Column guidance: member position in its axis, total before parts, totals hints on axes the MCA rules add up (mismatches by default, matches on request) | PARTIAL | `member-hints.test.mjs` (4 tests, pass). FM-14 *missing parents* helper has no unit test yet; badges and prompts not exercised in a browser |

**Regression check (sandbox).** The unit suite was run with a temporary stand-in for `@xmldom/xmldom` that throws if XML
is parsed. Of 137 pre-existing tests, 106 passed; the 31 that failed need real XML parsing and fail identically on the
untouched original. Compared by test name, no pre-existing test changed outcome. The three new files add 11 passing tests.

**Not run in this stage:** `npm ci`, `npm run build` (so `index.html` is still the previous build), Arelle, the browser
smoke test, the golden regression and `node release-gate.mjs`.

**Open items for this stage**
1. Run `npm ci`, `pip install -r requirements.txt` and `npm run release`; resolve anything they report.
2. Add browser checks for H1–H3 to `browser-smoke.mjs` (copy button on a table with previous-year values; footnote
   added, linked, unlinked warning; total hint shown on a mismatch).
3. Unit test for the FM-14 missing-parent helper in `member-hints.js`.

## I. GE Power Boilers 2024-25 (MCA-accepted instance) — results

Method: the instance was imported through the same importer and gate the app uses (sandbox DOM shim in place of
xmldom; shim is not part of the deliverable). PDF text layer used for the statement presentation.

| # | Item | Result | Evidence |
|---|---|---|---|
| I1 | Import completeness | 874 of 874 source facts imported, 0 unresolved, 5 footnotes (previously 864 + 10 dropped) | import report, after fix |
| I2 | OCI totals missing after regeneration | FIXED. The instance reports OCI totals as 0 for both years; the company answers "No" to both OCI flags, yet the P&L face shows the OCI lines and totals as 0. The "applies only when Yes" dependency dropped the 10 zero facts. `Applicability.planFacts` now keeps a numeric zero that the imported instance reported, when the only reason to hide it is a Yes/No dependency. User-entered zeros are unaffected (entry is refused by the session), table conditions still apply. Tests: `ge-fixes.test.mjs` | `ge-fixes.test.mjs` (5 tests) |
| I3 | ML-52 (auditor's report, 2 errors per year) | FIXED. The table is partitioned by an outcome axis: each clause is reported under one member (favourable remark, not applicable, or qualification). The row-by-row check required every element under every member, which no filing with a not-applicable clause can satisfy. For this outcome axis only, an element counts as reported when it appears under any member; a genuinely missing element still fails. Per-row lists (e.g. shareholder details) keep the per-row check | `ge-fixes.test.mjs` (2 tests) |
| I4 | SR-L1097-1 and SR-L1304-1 (revaluation flags, PPE and intangibles, both years; 4 errors) | OPEN, NEEDS DECISION. The instance reports PPE and other intangibles as 0 and omits the PPE and intangibles notes entirely; the auditor's report states the company holds no PPE or intangibles. The rule text is unconditional ("This is a mandatory field"). Whether these flags are required when the asset is nil is not determinable from this evidence alone. Left blocking, per the compliance priority | gate output; XML has no revaluation or note facts |

**Gate status on the GE instance:** 4 blocking errors (was 6), all from I4.

**Not done in this stage**
- `npm run build` and `npm run release`: not possible in this environment (no npm registry access, no esbuild, no Arelle, no browser). `index.html` is still the previous build.
- Resolving I4 requires a decision (see the message accompanying this package). If approved, the change is a conditional applicability for the two revaluation elements, keyed on the PPE and intangibles notes being in use.

**Residual risk.** The ML-52 change and the zero-retention change touch shared rule logic. The offline unit suite shows no regression, but the 31 XML-dependent tests (rule families, rule audit, workbench, calculation golden paths) could not run here and must be run on a full checkout.

## J. Build and audit of this package

**index.html.** Rebuilt from the current source (build id 856fe2f206, authority hash e279ba8c90a6ca10, sha256 recorded in
BUILD_INFO.json). The page contains the footnote view, copy-from-previous-year, column guidance, the ML-52 outcome fix and
the source-zero retention. **It was not produced by esbuild** (no npm registry access here): an ES-module stand-in bundler
produced the same page contract (same shell, styles, embedded authority, placeholders, outputs). It is unminified
(app script 363 KB against 213 KB minified). Before any release, run `npm run build` on a full checkout; that replaces
index.html with the esbuild output.

**What was checked on index.html:** the bundle parses; the embedded authority equals MCA_AUTHORITY.json byte for byte;
BUILD_INFO.json hashes match the file; the startup code (boot) runs to completion against a stand-in DOM, as does the
previous esbuild build under the same harness. This is a startup check, not a browser test.

**Rule audit (`audit.mjs`).** Regenerated RULE_AUDIT.json: VERIFIED 1114, COVERED_BY_TEST 34, REVIEW_ONLY_EXTERNAL_DATA 60,
NOT_APPLICABLE 18, DATA 313, NOT_WITNESSED 1, UNIMPLEMENTED 1. No rule changed status. ML-52 remains VERIFIED with both
witnesses. Open, pre-existing: SR-L6327-1 (NOT_WITNESSED: no pass/fail witness built) and ML-43-b (UNIMPLEMENTED, listed in
APPROVED_LIMITATIONS.json).

**Offline unit suite.** 123 pass, 31 fail. The 31 need the XML parser (not installed here) and fail identically on the
original package. No previously passing test has changed outcome.

**Not run:** `npm test` (gate, XSD, golden), `npm run release`, browser smoke (`browser-smoke.mjs`), Arelle.

**Publishing caution.** The package contains golden-icom-analytics-2022-23.xml, a golden instance built from a real
company's financial statements. Publishing this repo with GitHub Pages from a public repository would make it visible.
Use a private repository, or remove that file from the published copy, before enabling Pages.

**Blocking GE errors (SR-L1097-1, SR-L1304-1)** remain open pending a decision (see section I). The GE instance is not a
golden file in this package.

## K. v1 release status

- **Version:** INDAS XBRL Tool v1 (package version 1.0.0; app title and README updated). Release notes: RELEASE_NOTES_v1.md.
- **Index.html:** rebuilt from the final source, build id 8fd6549434, stand-in bundler (not esbuild); startup verified.
- **Approvals:** SR-L1097-1 and SR-L1304-1 were requested as approved limitations. They are recorded in
  APPROVED_LIMITATIONS.json with approved=false. They are **not effective**: the compiler accepts approvals only for
  UNIMPLEMENTED rules (compile.mjs), so an approval for an executable rule would stop the release compile. Making them
  effective needs an engine and compile change, followed by a compile on a full checkout and the release owner's approval.
  Until then the GE Power Boilers 2024-25 instance cannot be generated.
- **Gate status:** not run in this environment. The release is not certified by this package.
- **Data:** golden-icom-analytics-2022-23.xml is real company data; keep the repository private or remove the file before
  enabling GitHub Pages on a public repository.

