// Build/test-side XML Schema + XBRL 2.1 + XBRL Dimensions validation of generated instances,
// using Arelle (open-source XBRL processor, https://arelle.org) running fully offline:
//   * XBRL specification schemas come from Arelle's bundled cache (xbrl.org is not contacted)
//   * the MCA Ind AS 2017 taxonomy comes from the local package (.taxonomy/)
//   * a temporary copy of the instance points its schemaRef at the local entry point;
//     the instance itself is never modified.
// This is NOT the official MCA XBRL Validation Tool (Ind AS) and does not run the MCA business rules.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureTaxonomy, ENTRY_POINT } from './taxonomy-source.mjs';

const PY = process.env.PYTHON || 'python3';

export function xsdValidatorStatus() {
  const r = spawnSync(PY, ['-c', 'import arelle, importlib.metadata as m; print(m.version("arelle-release"))'], { encoding: 'utf8' });
  if (r.status === 0) return { available: true, tool: 'Arelle', version: r.stdout.trim() };
  return { available: false, tool: 'Arelle', reason: 'python3 module "arelle" not installed (pip install -r requirements.txt)' };
}

// formulas: 'run' also executes the taxonomy formula linkbase (cross-period assertions) — an independent check of
// the FX-* rules; assertion results are returned separately (unsatisfied = formula failures).
export function validateInstanceXml(xml, { label = 'instance.xml', formulas = false } = {}) {
  const st = xsdValidatorStatus();
  if (!st.available) return { status: 'UNAVAILABLE', ...st, errors: [], warnings: [] };
  const entry = pathToFileURL(path.join(ensureTaxonomy(), ENTRY_POINT)).href;
  const local = xml.replace(/(<link:schemaRef\b[^>]*xlink:href=")[^"]+(")/, `$1${entry}$2`);
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-xsd-'));
  try {
    const file = path.join(dir, label.replace(/[^\w.-]/g, '_'));
    const log = path.join(dir, 'arelle.log');
    writeFileSync(file, local);
    spawnSync(PY, ['-m', 'arelle.CntlrCmdLine', '--file', file, '--validate', '--internetConnectivity', 'offline', '--logFile', log, '--logLevel', formulas ? 'info' : 'warning', ...(formulas ? ['--formula', 'run'] : [])], { encoding: 'utf8', maxBuffer: 64e6 });
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const msgs = lines.map((l) => { const m = /^\[([^\]]+)\]\s*(.*)$/.exec(l); return m ? { code: m[1], message: m[2] } : { code: 'log', message: l }; });
    // XML Schema, XBRL 2.1 (xbrl.*), Dimensions (xbrldte/xbrldie) and load errors are failures
    const isFormula = (m) => /^(formula|assertion|message|crossPeriod)/i.test(m.code) || /crossPeriod_/.test(m.code + ' ' + m.message);
    const errors = msgs.filter((m) => !isFormula(m) && (/^(xmlSchema|xbrl\.|xbrldte|xbrldie|arelle:|IOerror|xmlSchema:|xml)/i.test(m.code) || /error/i.test(m.code)));
    const formulaMsgs = msgs.filter(isFormula);
    const warnings = msgs.filter((m) => !errors.includes(m) && !formulaMsgs.includes(m) && !/^info$/i.test(m.code));
    return { status: errors.length ? 'FAIL' : 'PASS', ...st, errors, warnings, formulaMessages: formulaMsgs, log: formulas ? msgs : undefined };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const f = process.argv[2];
  if (!f) { console.log(JSON.stringify(xsdValidatorStatus())); process.exit(0); }
  const r = validateInstanceXml(readFileSync(f, 'utf8'), { label: path.basename(f) });
  console.log(`${r.status} (${r.tool} ${r.version || ''}) errors=${r.errors.length} warnings=${r.warnings.length}`);
  for (const e of r.errors.slice(0, 50)) console.log(`  [${e.code}] ${e.message}`);
  process.exit(r.status === 'FAIL' ? 1 : 0);
}

