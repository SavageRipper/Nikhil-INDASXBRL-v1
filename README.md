# INDAS XBRL Tool v1

Local-first, browser-based preparation, validation and generation of MCA **Ind AS 2017** XBRL instance documents
(AOC-4 XBRL, commercial and industrial companies, **standalone and consolidated**). Taxonomy, dimensions, calculations,
formula linkbase and business rules are compiled from the MCA authority files in this repository; nothing is hard-coded.

**Open the app:** `index.html` (GitHub Pages serves it at the site root; it also opens from disk, offline). It is the built
app — rebuild with `npm run build` after changing any source file and commit the new `index.html`.

Flat repository: every file sits at the root (no folders to create when uploading).

## Authority inputs

| Input | File |
|---|---|
| Taxonomy Ind AS V1.2 (entry point `in-ci-ent-2017-03-31.xsd`: ind-as + in-ca) | `Taxonomy_for_IND-AS_V1.2_31-03-2017.zip` (kept zipped; unpacked to `.taxonomy/` by `npm run compile`) |
| Business rules Ind AS V1.2 (all 10 sheets) | `Business_Rules_IndAS_Taxonomy_V1.2.xlsx` |
| Filing Manual Ind AS V1.0 | `Filing_Manual_IndAS_V1.0.pdf` |
| MCA-validated reference instances | `golden-icom-analytics-2022-23.xml` (standalone, FY 2022-23); more as `golden-<name>.xml` (+ optional `golden-<name>.pdf`) |
| Calibration against validated instances | `GOLDEN_CALIBRATION.json` (element-level warnings, with evidence) |

schemaRef `http://www.mca.gov.in/XBRL/2017/07/16/Taxonomy/Ind/in-ci-ent-2017-03-31.xsd`, identifier scheme
`http://www.mca.gov.in/CIN` (Filing Manual §1.1.3.1).

## Run

```
npm ci
pip install -r requirements.txt   # Arelle — offline XML Schema / XBRL 2.1 / Dimensions / Formula validator (tests, release gate)
npm run release                   # compile → tests → rule audit → build → release gate
```

| Stage | Command | What it does |
|---|---|---|
| authority compile | `npm run compile` | DTS from the entry point (5,647 concepts, 60 ELRs, 175 tables, 71 notAll, 70 defaults, 98 typed axes, 1,269 calculation arcs, 36 formula assertions) + the rule workbook → `MCA_AUTHORITY.json`, `BUSINESS_RULE_COVERAGE.json` |
| unit tests | `npm run test:unit` | taxonomy counts against the raw files, dimensions, typed members, rule corpus, rule engine, hand tests for every rule family, the rule-by-rule audit, calculations, roll-forwards, scaling/decimals/units, applicability, rich text, import modes, workbench, copy from previous year, footnotes, column guidance |
| gate tests | `npm run test:gate` | importer / generator / internal gate, Filing Manual technical specifications |
| Arelle | `npm run test:xsd` | generated instances (example, consolidated, first year, first-time adoption) validated offline by Arelle incl. the formula linkbase; Arelle's formula results cross-checked against the FX-* rules |
| golden | `npm run test:golden` | every `golden-*.xml`: import → 0 gate errors → regenerate → independent fact-level diff (`golden-diff.mjs`) → every fact reachable in the UI → edit round trip (+ PDF cross-check when supplied) |
| rule audit | `npm run audit` | `RULE_AUDIT.json`: for every executable rule a compliant filing (PASS) and a one-mutation violating filing (FAIL), each checked by running only that rule through the production engine |
| build | `npm run build` | `index.html` (= `indas-xbrl.html`): the single-file app with the compiled authority embedded |
| release gate | `node release-gate.mjs` | all of the above + build integrity + headless-browser UI regression → `RELEASE_REPORT.json` |

## What the app does

* **Statements and notes** for all 60 ELRs; tables show their rows and a *total* column (every axis at its default member), rendered from the taxonomy (presentation, tables, axes, members, typed axes,
  notAll exclusions, defaults). Current / previous year; **first-time adoption** adds the opening balance sheet of the
  previous year (third balance-sheet column, GR-16 / Annexure II #21).
* **Mandatory marking:** fields the MCA business rules require are tagged *Mandatory* (live: conditions such as "mandatory if Yes" or "mandatory for consolidated" are evaluated as you type), conditional ones *Conditional*; table line items show *Mandatory · every row* / *one complete row* / *one of these*; empty mandatory cells are outlined; hover a tag for the rule text. The taxonomy itself declares no element mandatory.
* **Auto-calculation:** totals from the calculation linkbase (read-only, per-tab override, cascading), roll-forwards
  from the formula linkbase (closing = opening + changes: PPE, intangibles, goodwill, investment property, share capital,
  other equity, cash, provisions, …), opening of the current year = closing of the previous year (one fact).
  **Mismatches** panel: every calculated-vs-reported difference and every manual override, with jump-to-cell.
* **Validation:** internal gate (Filing Manual technical specifications, contexts, units, decimals, dimensions,
  calculations) + every executable MCA rule (specific, generic GR-1…GR-16, mandatory line items, formula FX-*,
  Annexure II FM-9/14/15/16). Results carry their location (tab, table, year, cell); click to jump. Validate the
  current tab or the whole filing; XML generation always validates the whole filing and is blocked on any error.
* **Applicability** (one decision for UI, import, validation and XML): standalone / consolidated ELRs (GR-10, GR-12,
  GR-13), previous-year exclusions (GR-11), cash-flow method (direct [310000] / indirect [320000]), Yes/No dependencies
  from the MCA conditional rules (Yes → No asks first; values kept but excluded), conditional tables.
* **Usability (display only — no filing semantics):** column headings and the row-label column stay in view (the grid
  scrolls in its own box); alternate-row shading and row highlight on hover/focus; **Enter / Shift+Enter** (and ↑/↓ in
  text cells and on Text Block buttons) move to the same column of the next/previous editable row; **Ctrl+S** saves in
  the browser now (the bar shows *Saved hh:mm*); dialogs: **Esc** cancels, **Tab** stays inside, **Ctrl+Enter** saves a
  text block, confirmations start on Cancel and focus returns afterwards; grid cells have accessible names (row —
  column), `aria-required` on mandatory cells and `aria-invalid` on cells with errors; "Skip to the sheet" link;
  *New filing* and removing a table row that holds values ask first; a Text Block button shows ⚠ and its issue count
  after validation, and the editor lists that text block's issues (last validation + the gate's HTML check).
* **Copy from previous year** (current-year dimensional tables, toolbar button): adds the previous-year columns the table
  does not have yet and copies their values into empty cells. Nothing entered is overwritten, calculated cells are left
  to the calculation, and every copy goes through the same checks as typing. The confirmation states the counts first.
* **Footnotes** (Filing › Footnotes): write the text, choose a cell from the list and link it. Footnotes are written to
  the XML with their linked cells only; an unlinked footnote is flagged here instead of silently disappearing.
* **Column guidance** (tool guidance, not MCA rules): total columns sit before their parts, TOTAL / *part of …* badges,
  *Needs … column (FM-14)* prompts, and a warning under a total that differs from its parts on the axes the MCA business
  rules add up.
* **Import:** preview first, then *Both years*, *Current year only* (with current-year opening balances) or
  *Roll forward* (last year's filing becomes the previous year of the next filing). Cash-flow method from the XML or
  chosen. Non-applicable facts go to the import report, not into the filing.
* **Rich text:** Text Block popup editor; stored in the Filing Manual HTML subset (highlightedText / noteText classes).
  Pasted Word/Excel tables are rebuilt for the MCA Validator's HTML schema: no colgroup/col/caption, no
  colspan/rowspan (merged cells become empty cells, every row the same number of cells), `tbody` around rows, only the
  `class` attribute, number padding (&nbsp; right-alignment that widens columns until the MCA PDF cuts them) and
  empty paragraphs removed; pasted cells get `class="bordered"`, ▦ toggles borders for the table at the cursor; a
  filing-wide option saves bold/italic/underline as plain text instead of highlightedText (shaded in the MCA PDF).
  The gate blocks schema-rejected HTML and XML-illegal control characters (e.g. a Word line break) before generation.
* **xml:lang** (Filing Manual #28) only on `xbrli:stringItemType` / `nonnum:textBlockItemType`: the in-ca restricted
  types (PAN, CIN, DIN, SRN, ITC codes, drop-down lists) forbid the attribute (#29 schema validity; MCA Validator
  `cvc-complex-type.3.2.2`).
* **Build id** in the header and in the first comment of every generated XML (`<!-- Generated by Ind AS XBRL Studio
  build … -->`): a different id in an XML means a cached page — press Ctrl+F5 and generate again.
* **MCA error help** tab: paste the MCA Validator's error list; each message is explained (meaning, likely cause, fix in
  this tool), identical messages grouped, element names link to the cell; includes a guide to reading validator messages.
* **Entry scale:** Actual, Hundreds, Thousands, Lakhs, Millions, Crores, Billions; the XML carries rupees with matching
  `decimals` (non-significant digits always 0).
* Autosave in the browser, project file save/open, example filing (clearly marked), rule coverage viewer.

## Status semantics

* **Internal gate** (in app): pass / errors. Generation is blocked on any error.
* **Official MCA validation:** always shown as *not run*. Only the MCA XBRL Validation Tool (Ind AS) can change that.
* Arelle (tests) is not the MCA tool and does not run MCA business rules.

## Rule coverage and audit

1,541 ledger entries (one status per clause): EXECUTABLE 1,462 · REVIEW_ONLY_EXTERNAL_DATA 60 (MCA21 master data,
ICAI/ICSI databases, the other instance document — never auto-passed) · NOT_APPLICABLE 18 · UNIMPLEMENTED 1 (`ML-43-b`).
Rule-by-rule audit: 1,114 rules VERIFIED (engine accepted a compliant filing and rejected a violating one), 35 covered by
named hand tests (`rule-families.test.mjs`), 313 data rows consumed by generic rules. See `AUDIT_REPORT.md`.

## Known limitations

1. **`ML-43-b` UNIMPLEMENTED** — Mandatory Line Items row 46 ([610800] related parties): "In
   OutstandingBalancesForRelatedPartyTransactionsAbstract- Element for amount shall be mandatory for various transactions"
   does not identify the required elements. **Approved by the release owner (2026-10-03)** as a known limitation: shown
   as **APPROVED LIMITATION / NOT EXECUTED** (warning), never as a pass. The rest of that row (`ML-43`) is executed.
   Revisit if MCA clarifies the clause.
2. **Golden regression** runs on `golden-icom-analytics-2022-23.xml` (MCA-validated): 0 gate errors, regenerated XML
   identical fact for fact, Arelle PASS incl. formulas. Two V1.2 mandatory line items the validated instance omits are
   warnings (`GOLDEN_CALIBRATION.json`). ⚠ **Golden files contain real company financials (ICOM Analytics Limited) —
   keep the repository private or remove the file before making it public.**
3. Annexure II #14/#15 for non-numeric elements are warnings; FX-* (formula linkbase) are blocking errors as listed in
   the Filing Manual (#19, missing item = 0).
4. Rules needing data outside the instance are review-only. Official MCA validation: **NOT RUN**. GitHub Pages smoke test
   of the deployed site: **NOT RUN** (`browser-smoke.mjs` runs the same checks on the built `index.html`).
5. **Last-stage UI (copy from previous year, footnotes view, column guidance)** is unit-tested and its markup was
   render-checked outside the browser, but it has **not** yet been exercised in the headless browser or built into
   `index.html` in the environment that produced this package. Run `npm run release` before relying on it, and add
   browser checks for these three features to `browser-smoke.mjs`.

## Build note

`npm run build` bundles the app with esbuild into `index.html` (GitHub Pages entry point), `indas-xbrl.html` and
`artifact.html`, and writes `BUILD_INFO.json`. The `index.html` shipped in the last package was produced by an
ES-module stand-in bundler because esbuild was not available in that environment; rebuild with `npm run build` before
any release.

## Files

| Role | Files |
|---|---|
| Authority compiler | `compile.mjs`, `taxonomy-source.mjs`, `dts.mjs`, `tables.mjs`, `formula-source.mjs`, `rules-source.mjs`, `rule-formalizer.mjs`, `rule-indas.mjs` |
| Runtime engines | `member-hints.js`, `carry-forward.js`, `footnotes.js`, `authority.js`, `dimensions.js`, `calculation.js`, `rules.js`, `expr.js`, `applicability.js`, `model.js`, `periods.js`, `scaling.js`, `units.js`, `decimal.js`, `importer.js`, `generator.js` (only XML writer), `gate.js`, `views.js`, `session.js` |
| UI | `app.js`, `richtext.js`, `mca-errors.js`, `example.js`, `shell.html`, `styles.css`, built `index.html` / `indas-xbrl.html` |
| Build / release / audit | `build.mjs`, `release-gate.mjs`, `rule-audit.mjs`, `audit.mjs`, `xsd-validate.mjs`, `browser-smoke.mjs`, `golden-diff.mjs`, `requirements.txt`, `APPROVED_LIMITATIONS.json`, `GOLDEN_CALIBRATION.json`, `AUDIT_REPORT.md` |
| Tests | `*.test.mjs`, `helpers.mjs`, `fixtures.mjs` |

Generated (git-ignored): `.taxonomy/`, `node_modules/`, `MCA_AUTHORITY.json`, `BUSINESS_RULE_COVERAGE.json`,
`RULE_AUDIT.json`, `RELEASE_REPORT.json`, `BUILD_INFO.json`, `artifact.html`.
