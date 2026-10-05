# INDAS XBRL Tool v1

Local-first preparation, validation and XBRL instance generation for MCA Ind AS 2017 (standalone and consolidated).
Runs in the browser from `index.html`; no server, no upload of filing data.

## Included in v1
- Taxonomy-driven data entry for every table, with applicability, dimensions and typed members.
- Business-rule engine (executable rules, rule audit with PASS and FAIL witnesses) and an internal validation gate
  that blocks XML generation on any ERROR.
- Instance generation (Ind AS 2017 entry point), import of existing MCA instances, golden-instance regression.
- Footnotes (add, edit, link, unlink, remove) that are written to the XML with their linked cells.
- Copy from previous year for current-year dimensional tables, with an option to copy values.
- Totals and part guidance; missing-parent prompts.
- ML-52 (auditor's report) is complete when each clause is reported under one outcome member.
- Imported zero statements that the source instance reported are retained (e.g. OCI totals presented as 0).

## Known limitations (see APPROVED_LIMITATIONS.json and AUDIT_REPORT.md)
- SR-L1097-1 and SR-L1304-1 (revaluation flags for PPE and intangibles) remain blocking. A filing that holds no PPE or
  intangibles, such as the GE Power Boilers 2024-25 instance, cannot be generated until the release owner decides on
  an approved limitation, which needs an engine and compile change.
- ML-43-b is an approved limitation (not executed).
- SR-L6327-1 has no pass/fail witness yet.
- The release gate (`npm run release`) and the browser smoke test have not been run for this package.

## Before publishing
- Run `npm ci`, then `npm run release`, then `npm run build`. The index.html in this package was produced by a stand-in
  bundler and must be replaced by the esbuild build.
- golden-icom-analytics-2022-23.xml is built from a real company's financial statements. Keep the repository private, or
  remove the file, before enabling GitHub Pages on a public repository.
