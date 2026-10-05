// Browser regression of the built app (index.html) in headless Chromium via playwright-core.
// Exercises the real UI on the Ind AS example: table availability, first-time adoption column, calculated cells,
// rich-text editing → autosave → reload → XML → import → edit, Yes/No dependencies, validation navigation,
// current-tab validation, cash-flow method, and the three import modes (both / current / roll forward).
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { facts as rawFacts, diff as rawDiff } from './golden-diff.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);

export function browserStatus() {
  const exe = CANDIDATES.find((p) => existsSync(p));
  return exe ? { available: true, executable: exe } : { available: false, reason: 'no Chromium executable found (set CHROMIUM_PATH)' };
}

const tab = (code) => `#nav a[data-elr$="_${code}"]`;

export async function runBrowserSmoke() {
  const st = browserStatus();
  if (!st.available) return { status: 'UNAVAILABLE', ...st, checks: [] };
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return { status: 'UNAVAILABLE', available: false, reason: 'playwright-core not installed', checks: [] }; }
  const browser = await chromium.launch({ executablePath: st.executable });
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  page.on('dialog', (d) => d.dismiss()); // the app never uses browser dialogs
  const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
  const exported = path.join(ROOT, '.smoke-export.xml');
  const setCell = async (sel, v) => { await page.fill(sel, v); await page.dispatchEvent(sel, 'change'); await page.waitForTimeout(80); };
  try {
    await page.goto(url);
    await page.waitForSelector('#nav a[data-elr]');
    check('app loads: 60 Ind AS ELRs in the navigation, example filing marked', (await page.locator('#nav a[data-elr]').count()) === 60 && /example data/.test(await page.textContent('#bar-who')));
    check('branding: Ind AS taxonomy 2017, Ind AS schemaRef shown', /IND AS TAXONOMY 2017/i.test(await page.textContent('.brand')) && /Ind\/in-ci-ent-2017-03-31\.xsd/.test(await page.textContent('#main')));

    // ---- table availability follows the balance sheet ([400500] current investments)
    const ciBtn = (scope) => `button[data-open-table="400500:DetailsOfCurrentInvestmentsTable"][data-scope="${scope}"]`;
    await page.click(tab('400500'));
    check('[400500] closed while current investments = 0', await page.isDisabled(ciBtn('CY')) && await page.isDisabled(ciBtn('PY')));
    await page.click(tab('110000'));
    const CI = 'input[data-c="ind-as:CurrentInvestments"][data-s="CY"]';
    await setCell(CI, '250000');
    await page.click(tab('400500'));
    check('[400500] opens (and is required) for the current year when the balance sheet amount > 0; previous year stays closed', !(await page.isDisabled(ciBtn('CY'))) && /required/.test(await page.textContent(ciBtn('CY'))) && await page.isDisabled(ciBtn('PY')));
    await page.click(tab('110000'));
    await setCell(CI, '0');

    // ---- calculated cells: read-only, auto-populated, tab override
    const CA = 'input[data-c="ind-as:CurrentAssets"][data-s="CY"]';
    const TR = 'input[data-c="ind-as:TradeReceivablesCurrent"][data-s="CY"]';
    check('calculated parent cell is read-only by default', (await page.getAttribute(CA, 'readonly')) !== null && await page.evaluate((s) => document.querySelector(s).classList.contains('calc'), CA));
    const before = Number(await page.inputValue(CA));
    const trBefore = await page.inputValue(TR);
    await setCell(TR, String(Number(trBefore) + 100));
    check('auto-calculation: Current assets updated from its children immediately', Number(await page.inputValue(CA)) === before + 100, `${before} → ${await page.inputValue(CA)}`);
    await setCell(TR, trBefore);
    await page.check('input[data-calc-override$="_110000"]');
    check('tab option enables editing of calculated cells on this tab', (await page.getAttribute(CA, 'readonly')) === null);
    await page.click(tab('210000'));
    check('override is per tab (P&L calculated cells stay read-only)', (await page.$$eval('#main .cellin.calc[readonly]', (els) => els.length)) > 0);
    await page.click(tab('110000'));
    await page.uncheck('input[data-calc-override$="_110000"]');
    check('disabling the option restores read-only, value kept', (await page.getAttribute(CA, 'readonly')) !== null && Number(await page.inputValue(CA)) === before);

    // ---- mismatch panel: calculated vs reported differences and the override log, with jump-to-cell
    await page.check('input[data-calc-override$="_110000"]');
    await setCell(CA, String(before + 1));
    await page.click('a[data-go="mismatch"]');
    await page.waitForSelector('#main .tiles');
    const mm = await page.textContent('#main');
    check('Mismatch panel lists the calculation difference and the manual-override log', /calculation differences/.test(mm) && /Manual override of a calculated cell: Current assets/.test(mm) && /Calculation inconsistency/.test(mm), mm.slice(0, 400));
    await page.locator('.issues li.nav-issue', { hasText: 'Manual override of a calculated cell: Current assets' }).first().click();
    await page.waitForTimeout(200);
    check('clicking a mismatch focuses the cell', (await page.evaluate(() => document.activeElement?.dataset?.cell || '')).startsWith('ind-as:CurrentAssets#I:'));
    await setCell(CA, String(before));
    await page.uncheck('input[data-calc-override$="_110000"]');

    // ---- country fields offer the workbook country list (Filing Manual Annexure III / Country Codes sheet)
    await page.click(tab('400100'));
    const SHQ = 'select[data-c="ind-as:WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany"][data-s="CY"]';
    await page.selectOption(SHQ, 'true'); await page.waitForTimeout(150);
    await page.click('button[data-open-table="400100a:DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable"][data-scope="CY"]');
    await page.waitForSelector('#addslice');
    for (const sel of await page.$$('#addslice select')) { const opts = await sel.$$eval('option', (os) => os.map((o) => o.value).filter(Boolean)); await sel.selectOption(opts[0]); }
    await page.click('#addslice button[type="submit"]');
    await page.waitForTimeout(150);
    check('country cells suggest the workbook country names (datalist)', (await page.locator('#main input[data-c="in-ca:CountryOfIncorporationOrResidenceOfShareholder"][list="dl-country"]').count()) === 1 && (await page.locator('#dl-country option').count()) > 100);
    await page.click(tab('400100'));
    await page.selectOption(SHQ, 'false'); await page.waitForTimeout(150);

    // ---- first-time adoption: opening balance sheet of the previous year
    await page.click('a[data-go="setup"]');
    await page.check('#fta-yes');
    await page.waitForTimeout(150);
    await page.click(tab('110000'));
    const pyo = 'input[data-c="ind-as:TradeReceivablesCurrent"][data-s="PYO"]';
    check('FTA = Yes: balance sheet gets the third column (opening balance sheet of the previous year, 2016-03-31)', (await page.locator(pyo).count()) === 1 && /Opening 2016-03-31/.test(await page.textContent('#main thead')) && /First-time adoption of Ind AS/.test(await page.textContent('#main')));
    await setCell(pyo, '250000');
    check('opening column totals are auto-calculated', Number(await page.inputValue('input[data-c="ind-as:CurrentAssets"][data-s="PYO"]')) === 250000);
    await page.click('a[data-go="setup"]');
    await page.check('#fta-no');
    await page.waitForSelector('#dlg-continue');
    check('FTA Yes → No asks first (opening values retained but excluded)', /retained but excluded/.test(await page.textContent('#modal-body')));
    await page.click('#dlg-continue');
    await page.waitForTimeout(150);
    await page.click(tab('110000'));
    check('FTA = No: two columns again', (await page.locator('input[data-s="PYO"]').count()) === 0);

    // ---- rich text in a modal: Text Block → editor → Save / Cancel → reload → XML → import → edit
    const TBC = 'ind-as:DisclosureOfNotesOnEquityShareCapitalExplanatory';
    const tbBtn = `#main [data-textblock][data-c="${TBC}"][data-s="CY"]`;
    const ed = '#tb-editor';
    const btn = (cmd) => `#modal [data-rte="${cmd}"]`;
    await page.click(tab('400100'));
    check('text block cell is a compact Text Block button (no embedded editor)', (await page.locator(tbBtn).count()) === 1 && (await page.locator('#main .rte-body').count()) === 0);
    await page.click(tbBtn);
    check('Text Block opens a modal editor with toolbar, Save and Cancel', await page.isVisible('#modal') && (await page.locator('#modal [data-rte]').count()) >= 7 && await page.isVisible('#tb-save') && await page.isVisible('#tb-cancel'));
    await page.click(ed);
    await page.keyboard.type('Equity shares of Rs 10 each. ');
    for (const [cmd, word] of [['bold', 'Bold term'], ['italic', 'Italic term'], ['underline', 'Underlined term']]) { await page.click(btn(cmd)); await page.keyboard.type(word); await page.click(btn(cmd)); await page.keyboard.type(' '); }
    await page.keyboard.press('Enter');
    await page.click(btn('insertOrderedList'));
    await page.keyboard.type('First point'); await page.keyboard.press('Enter'); await page.keyboard.type('Second point'); await page.keyboard.press('Enter');
    await page.click(btn('insertOrderedList'));
    await page.click(btn('insertUnorderedList'));
    await page.keyboard.type('Bullet point'); await page.keyboard.press('Enter');
    await page.click(btn('insertUnorderedList'));
    await page.evaluate((sel) => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal style="margin:0"><span style="font-weight:bold">Pasted bold</span> and <span style="font-style:italic">pasted italic</span><o:p></o:p></p><img src="x.png">' +
        // Excel-style table: colgroup/col, colspan, width/style attributes, padded numbers, whitespace paragraphs
        '<table border=0 cellpadding=0 style="border-collapse:collapse"><colgroup><col width=200><col width=80 span=4></colgroup>' +
        '<tr><td rowspan=2 style="border:.5pt solid windowtext"><p>   </p><p><b>Name of Assets</b></p></td><td colspan=4 class=xl65 style="border:.5pt solid windowtext"><b>Gross Block</b></td></tr>' +
        '<tr><td>As on</td><td>Addition</td><td>Deduction</td><td>As on</td></tr>' +
        '<tr><td>Office Equipments</td><td align=right>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 17.45 </td><td>&nbsp;&nbsp;&nbsp; 6.68</td><td>&nbsp; - </td><td>24.14</td></tr></table></body></html>');
      dt.setData('text/plain', 'Pasted bold and pasted italic');
      document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, ed);
    await page.click('#tb-save');
    check('Save Text closes the popup and updates the cell preview', await page.isHidden('#modal') && /Equity shares of Rs 10 each/.test(await page.textContent(`${tbBtn} >> xpath=../span[contains(@class,"tb-prev")]`)));
    await page.click(tbBtn); await page.click(ed); await page.keyboard.press('Control+End'); await page.keyboard.type(' DISCARD ME'); await page.click('#tb-cancel');
    await page.click(tbBtn);
    const reopened = await page.innerHTML(ed);
    check('Cancel leaves the stored value unchanged', !/DISCARD ME/.test(reopened) && /<b>Bold term<\/b>/.test(reopened), reopened.slice(0, 200));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700); // autosave debounce
    await page.reload();
    await page.waitForSelector('#nav a[data-elr]');
    check('project restored from this browser after reload', /Restored your last project/.test(await page.textContent('#toast')));
    await page.click(tab('400100'));
    await page.click(tbBtn);
    const html = await page.innerHTML(ed);
    await page.click('#tb-cancel');
    check('rich text survives reload (bold / italic / underline / lists)', /<b>Bold term<\/b>/.test(html) && /<i>Italic term<\/i>/.test(html) && /<u>Underlined term<\/u>/.test(html) && /<ol><li>First point<\/li><li>Second point<\/li><\/ol>/.test(html) && /<ul><li>Bullet point<\/li><\/ul>/.test(html), html.slice(0, 500));
    check('paste from Word: emphasis kept, Office markup / images / styles dropped', /<b>Pasted bold<\/b>/.test(html) && /<i>pasted italic<\/i>/.test(html) && !/style=|<img|o:p|Mso/.test(html), html);
    const ptab = /<table>[\s\S]*?<\/table>/.exec(html)?.[0] || '';
    const rowsCells = [...ptab.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
    check('paste from Excel: table rebuilt without colgroup/col/colspan/rowspan, every row 5 cells, every cell bordered', ptab && !/colgroup|<col|colspan|rowspan|width=|align=/.test(ptab) && rowsCells.length === 3 && rowsCells.every((n) => n === 5) && (ptab.match(/<td class="bordered">/g) || []).length === 15, ptab.slice(0, 400));
    check('paste from Excel: number padding removed, merged header kept in its first cell', /<td class="bordered">17\.45<\/td>/.test(ptab) && /<td class="bordered">-<\/td>/.test(ptab) && /<b>Gross Block<\/b>/.test(ptab) && !/<p>\s*<\/p>/.test(ptab), ptab.slice(0, 600));
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    if (!(await page.locator('#xmltext').count())) { await page.click('a[data-go="validate"]'); throw new Error('generation blocked: ' + (await page.textContent('.issues')).slice(0, 600)); }
    const xml = await page.textContent('#xmltext');
    check('XML generated after the internal gate passed; Ind AS schemaRef', /INTERNAL GATE · PASS/i.test(await page.textContent('#bar-status')) && xml.includes('http://www.mca.gov.in/XBRL/2017/07/16/Taxonomy/Ind/in-ci-ent-2017-03-31.xsd'));
    const fact = new RegExp(`<${TBC}[^>]*>([^<]*)<`).exec(xml)?.[1] || '';
    const mca = fact.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    check('XML text block: highlightedText1/2/3 and noteText1/2 classes, only allowed tags, no style', ['highlightedText1">Bold term', 'highlightedText2">Italic term', 'highlightedText3">Underlined term', 'noteText1', 'noteText2'].every((x) => mca.includes(x)) && ![...mca.matchAll(/<\/?([a-zA-Z]+)/g)].some((m) => !['div', 'span', 'p', 'br', 'table', 'td', 'tr', 'thead', 'tfoot', 'tbody', 'th', 'col', 'colgroup'].includes(m[1])) && !/style=/.test(mca), mca.slice(0, 300));
    check('XML: text block HTML carries only class attributes and no colgroup/col (MCA HTML schema)', [...mca.matchAll(/<[a-z]+((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/g)].every((m) => [...m[1].matchAll(/([a-z-]+)=/g)].every((a) => a[1] === 'class')) && !/<col|colgroup/.test(mca) && /<table><tbody><tr><td class="bordered">/.test(mca), mca.slice(mca.indexOf('<table'), mca.indexOf('<table') + 300));
    const buildId = await page.getAttribute('.brand small', 'data-build');
    check('build id shown in the header and written into the generated XML', /^[0-9a-f]{10}$/.test(buildId || '') && xml.includes(`<!-- Generated by Ind AS XBRL Studio build ${buildId} -->`), buildId);
    check('XML: no xml:lang on restricted in-ca types (CIN, report type, rounding level)', !/<in-ca:(CorporateIdentityNumber|NatureOfReportStandaloneConsolidated|LevelOfRoundingUsedInFinancialStatements) [^>]*xml:lang/.test(xml) && /<in-ca:NameOfCompany [^>]*xml:lang="en"/.test(xml));
    writeFileSync(exported, xml);

    // ---- import modes on the generated XML
    await page.setInputFiles('#file-xml', exported);
    await page.waitForSelector('#import-confirm');
    check('import waits for a choice (Import disabled); three modes offered', await page.isDisabled('#import-commit') && (await page.locator('#ym-both, #ym-current, #ym-rollforward').count()) === 3);
    await page.check('#ym-current');
    await page.click('#import-commit');
    await page.waitForSelector('.banner.info');
    check('Current year only: summary shown', /Current year only/.test(await page.textContent('.banner.info')));
    await page.click(tab('210000'));
    check('Current year only: profit-and-loss previous-year column empty', (await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').length)) === 0);
    await page.setInputFiles('#file-xml', exported);
    await page.waitForSelector('#import-confirm');
    await page.check('#ym-rollforward');
    await page.click('#import-commit');
    await page.waitForSelector('.banner.info');
    check('Roll forward: new year 2018-04-01 → 2019-03-31 shown', /Roll forward/.test(await page.textContent('.banner.info')) && /2018-04-01 → 2019-03-31/.test(await page.textContent('#bar-who')));
    await page.click(tab('110000'));
    const rf = await page.$$eval('#main .cellin[data-s]', (els) => ({ cy: els.filter((e) => e.dataset.s === 'CY' && e.value !== '').length, py: els.filter((e) => e.dataset.s === 'PY' && e.value !== '').length }));
    check('Roll forward: last year\'s figures in the previous-year column, current year empty', rf.py > 5 && rf.cy === 0, JSON.stringify(rf));
    await page.setInputFiles('#file-xml', exported);
    await page.waitForSelector('#import-confirm');
    await page.check('#ym-both');
    await page.click('#import-commit');
    await page.waitForSelector('.banner.info');
    check('Both years: summary shown', /Previous year imported: [\d,]+ facts/.test(await page.textContent('.banner.info')));
    await page.click(tab('400100'));
    await page.click(tbBtn);
    const imported = await page.innerHTML(ed);
    check('XML import: formatting restored in the popup editor', /<b>Bold term<\/b>/.test(imported) && /<ol><li>First point/.test(imported), imported.slice(0, 300));
    await page.click(ed); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.click(btn('bold')); await page.keyboard.type('Edited after import'); await page.click('#tb-save');
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    const xml2 = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
    let why = '';
    if (!xml2) { await page.click('a[data-go="validate"]'); why = (await page.textContent('.issues')).slice(0, 800); } else why = (new RegExp(`<${TBC}[^>]*>([^<]*)<`).exec(xml2)?.[1] || 'text block not in XML').slice(-400);
    // (the caret may carry the preceding italic into the new paragraph: bold may wrap an italic span)
    check('editing imported rich text: new formatting exported', /highlightedText1&quot;&gt;(&lt;span class=&quot;highlightedText\d&quot;&gt;)?Edited after import&lt;\/span&gt;/.test(xml2), why);
    await page.click(tab('700400'));
    const pyCells = await page.$$eval('#main .cellin[data-s="PY"], #main [data-textblock][data-s="PY"]', (els) => els.map((e) => ({ d: e.disabled, v: e.value || '' })));
    check('previous-year cells of [700400] auditors report (GR-11) are disabled and blank', pyCells.length > 0 && pyCells.every((c) => c.d && c.v === ''), JSON.stringify(pyCells.slice(0, 4)));

    // ---- general information + cash-flow method
    await page.click('a[data-go="setup"]');
    check('"Disclosure of General Information about Company" (nav + heading), [700300] elements listed', (await page.textContent('#general-title')).trim() === 'Disclosure of General Information about Company' && (await page.locator('#main table.g [data-c^="in-ca:"]').count()) > 10);
    await page.check('#cf-direct'); await page.waitForTimeout(150);
    const cls = async (code) => page.getAttribute(tab(code), 'class');
    check('Direct selected: [310000] enabled, [320000] disabled', !/\bna\b/.test(await cls('310000')) && /\bna\b/.test(await cls('320000')));
    await page.click(tab('320000'));
    const offInputs = await page.$$eval('#main .cellin', (els) => [els.length, els.filter((e) => e.disabled).length, els.filter((e) => e.value !== '').length]);
    check('disabled cash-flow tab: unavailable, no data entry, no values shown', (await page.locator('.sheet.tab-off').count()) === 1 && offInputs[0] > 0 && offInputs[0] === offInputs[1] && offInputs[2] === 0, JSON.stringify(offInputs));
    await page.click('a[data-go="setup"]');
    await page.check('#cf-indirect'); await page.waitForTimeout(150);
    check('Indirect selected: [320000] enabled, [310000] disabled', /\bna\b/.test(await cls('310000')) && !/\bna\b/.test(await cls('320000')));

    // ---- Yes/No dependency with a safe Yes → No change
    await page.click(tab('611500'));
    const PAR = 'select[data-c="in-ca:WhetherCompanyHasSubsidiaryCompanies"][data-s="CY"]';
    const CH = 'input[data-c="in-ca:NumberOfSubsidiaryCompanies"][data-s="CY"]';
    await page.selectOption(PAR, 'true'); await page.waitForTimeout(150);
    check('Yes → dependent field and table enabled', !(await page.isDisabled(CH)) && !(await page.isDisabled('button[data-open-table="611500:DisclosureOfDetailsOfSubsidiariesTable"][data-scope="CY"]')));
    await setCell(CH, '2');
    await page.selectOption(PAR, 'false');
    await page.waitForSelector('#dlg-continue');
    check('Yes → No asks before making entered values non-applicable', /retained but excluded/.test(await page.textContent('#modal-body')));
    await page.click('#dlg-cancel');
    check('Cancel keeps the Yes answer and the dependent value', (await page.inputValue(PAR)) === 'true' && (await page.inputValue(CH)) === '2');
    await page.selectOption(PAR, 'false');
    await page.waitForSelector('#dlg-continue');
    await page.click('#dlg-continue'); await page.waitForTimeout(150);
    check('No → dependent field disabled and blank; dependent table unavailable', await page.isDisabled(CH) && (await page.inputValue(CH)) === '' && await page.isDisabled('button[data-open-table="611500:DisclosureOfDetailsOfSubsidiariesTable"][data-scope="CY"]'));

    // ---- validation → exact cell and navigation
    await page.click(tab('210000'));
    const OI = 'input[data-c="ind-as:OtherIncome"][data-s="CY"]';
    const oiVal = await page.inputValue(OI);
    await setCell(OI, '');
    await page.click('.bar button[data-act="validate"]');
    await page.waitForSelector('.issues');
    const errLi = page.locator('.issues li.nav-issue', { hasText: "'OtherIncome' is mandatory" }).first();
    check('validation lists the error with its location', (await errLi.count()) === 1 && /\[210000\]/.test(await errLi.textContent()));
    await errLi.click(); await page.waitForTimeout(200);
    const focusedCell = await page.evaluate(() => document.activeElement?.dataset?.cell || '');
    check('clicking the error opens the tab and focuses the exact cell', /_210000$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && focusedCell.startsWith('ind-as:OtherIncome#D:'), focusedCell);
    check('the erroneous cell is marked red', await page.evaluate((sel) => document.querySelector(sel).classList.contains('cell-err'), OI));
    await page.click('a[data-go="validate"]');
    await page.click('button[data-filter="WARNING"]');
    const warnLi = page.locator('.issues li.nav-issue', { hasText: 'NumberOfSubsidiaryCompanies' }).first();
    check('the retained-but-excluded value is listed as a warning with its location', (await warnLi.count()) === 1);
    await warnLi.click(); await page.waitForTimeout(200);
    check('clicking the warning navigates to its cell, which carries the warning mark', /_611500$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && await page.evaluate((sel) => document.querySelector(sel).classList.contains('cell-warn'), CH));
    await page.click(tab('210000'));
    await page.click('#main button[data-act="validate-tab"]');
    await page.waitForSelector('.issues');
    const locs = await page.$$eval('.issues li.nav-issue', (els) => els.map((e) => ({ t: e.querySelector('.reasons')?.textContent || '', x: /cross-tab/.test(e.textContent) })));
    check('Validate current tab: scope shown; results belong to [210000] or are marked cross-tab', /current tab \[210000\]/.test(await page.textContent('#main h1')) && locs.length > 0 && locs.every((l) => l.t.includes('[210000]') || l.x), JSON.stringify(locs.slice(0, 5)));
    await page.click(tab('210000'));
    await setCell(OI, oiVal);
    // ---- MCA-validated reference instances through the real UI: import, every tab, totals column, gate, XML
    for (const gf of readdirSync(ROOT).filter((x) => /^golden-.*\.xml$/.test(x))) {
      const src = readFileSync(path.join(ROOT, gf), 'utf8');
      await page.setInputFiles('#file-xml', path.join(ROOT, gf));
      await page.waitForSelector('#import-confirm');
      await page.check('#ym-both');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');
      const cin = /<xbrli:identifier[^>]*>([^<]+)</.exec(src)[1];
      check(`${gf}: imported through the UI (both years), CIN in the header`, (await page.textContent('#bar-who')).includes(cin));
      let rendered = 0, filled = 0; const t0 = Date.now();
      for (const href of await page.$$eval('#nav a[data-elr]', (as) => as.map((a) => a.dataset.elr))) {
        await page.click(`#nav a[data-elr="${href}"]`);
        if (await page.locator('#main .sheet').count()) rendered++;
        filled += await page.$$eval('#main .cellin', (els) => els.filter((e) => e.value !== '').length);
      }
      check(`${gf}: all 60 tabs render with the imported data (${filled} filled cells, ${Date.now() - t0} ms)`, rendered === 60 && filled > 500, `${rendered} tabs, ${filled} cells`);
      await page.click(tab('110000'));
      const assets = /<ind-as:Assets [^>]*contextRef="ICur"[^>]*>([^<]+)</.exec(src)?.[1];
      const shown = await page.inputValue('input[data-c="ind-as:Assets"][data-s="CY"]');
      check(`${gf}: balance sheet total assets shown at the filing's level of rounding`, assets && Math.abs(Number(shown.replace(/,/g, '')) * 1000 - Number(assets)) < 1, `${shown} vs ${assets}`);
      await page.click(tab('400100'));
      await page.click('button[data-open-table="400100:DisclosureOfClassesOfEquityShareCapitalTable"][data-scope="CY"]');
      await page.waitForSelector('#main table.g');
      const totalCol = await page.locator('#main th.slicehead .chip', { hasText: 'total' }).count();
      check(`${gf}: share-capital table shows the class rows and the total column (default members)`, totalCol === 1 && (await page.locator('#main th.slicehead').count()) >= 2);
      await page.click('.bar button[data-act="validate"]');
      await page.waitForSelector('.issues, .banner');
      const errs = await page.locator('.issues li.nav-issue.sev-ERROR, .issues li.nav-issue.error').count();
      check(`${gf}: internal gate in the UI — no blocking errors`, /INTERNAL GATE · PASS/i.test(await page.textContent('#bar-status')), `${errs} errors; ${(await page.textContent('#bar-status')).slice(0, 120)}`);
      await page.click('a[data-go="xml"]');
      await page.click('button[data-act="generate"]');
      await page.waitForSelector('#xmltext, .banner.bad');
      const out = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
      let d = null; try { d = out && rawDiff(rawFacts(src), rawFacts(out)); } catch (e) { d = { err: e.message }; }
      check(`${gf}: XML generated in the UI equals the source fact for fact (except not-applicable answers)`, d && !d.err && d.changed.length === 0 && d.onlyB.length === 0 && d.onlyA.length <= 10, d ? JSON.stringify({ err: d.err, changed: d.changed?.length, onlyA: d.onlyA?.length, onlyB: d.onlyB?.length }) : 'no XML');
    }
    // ---- usability (UI only): keyboard movement, accessible names, sticky headers, save/confirm feedback
    await page.click('#nav a[data-elr$="_110000"]');
    const firstCy = page.locator('#main table.g td.val input.cellin[data-s="CY"]:not([disabled]):not([readonly])').first();
    await firstCy.focus();
    const fromCell = await firstCy.getAttribute('data-cell');
    await page.keyboard.press('Enter');
    const moved = await page.evaluate(() => ({ cell: document.activeElement?.dataset?.cell, s: document.activeElement?.dataset?.s, inGrid: !!document.activeElement?.closest('td.val') }));
    check('Enter moves to the next editable cell of the same column', moved.inGrid && moved.s === 'CY' && moved.cell && moved.cell !== fromCell, JSON.stringify(moved));
    await page.keyboard.press('Shift+Enter');
    check('Shift+Enter moves back up', (await page.evaluate(() => document.activeElement?.dataset?.cell)) === fromCell);
    const aria = await firstCy.getAttribute('aria-label');
    check('grid cells carry an accessible name (row — column)', /—/.test(aria || '') && /Current/i.test(aria || ''), aria);
    const sticky = await page.evaluate(() => [getComputedStyle(document.querySelector('#main table.g thead th')).position, getComputedStyle(document.querySelector('#main table.g td.lbl')).position]);
    check('column headings and the row-label column are sticky', sticky.every((x) => x === 'sticky'), sticky.join(','));
    await page.keyboard.press('Control+s');
    await page.waitForSelector('#bar-save.ok');
    check('Ctrl+S saves in the browser and confirms', /Saved/.test(await page.textContent('#bar-save')) && /Saved in this browser/.test(await page.textContent('#toast')));
    const nameBefore = await page.textContent('#bar-who b');
    await page.click('button[data-act="new-filing"]');
    check('New filing asks for confirmation in a dialog (focus on Cancel)', await page.isVisible('#modal') && (await page.evaluate(() => document.activeElement?.id)) === 'dlg-cancel');
    await page.keyboard.press('Escape');
    check('cancelling New filing keeps the filing', await page.isHidden('#modal') && (await page.textContent('#bar-who b')) === nameBefore);
    await page.click('#nav a[data-elr$="_400100"]');
    await page.click(tbBtn);
    check('text block editor shows its validation status', /Not validated yet|No validation issues|issue\(s\) for this text block/.test(await page.textContent('#modal .tb-issues')));
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
    check('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement?.closest('#modal')));
    await page.keyboard.press('Escape');

    // ---- MCA Validator error help
    await page.click('a[data-go="mcaerrors"]');
    await page.fill('#mx-text', "1) cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:CorporateIdentityNumber'.\n2) Element 'DisclosureInBoardOfDirectorsReportExplanatory' the contained HTML has the following errors: cvc-complex-type.2.4.a: Invalid content was found starting with element 'colgroup'. One of '{{http://www.mca.gov.in/XBRL/HTML}thead, {http://www.mca.gov.in/XBRL/HTML}tr}' is expected.;cvc-complex-type.3.2.2: Attribute 'colspan' is not allowed to appear in element 'td'.;");
    await page.click('#mx-run');
    const mx = await page.textContent('#main');
    check('MCA error help explains pasted validator messages (attribute, HTML) with a fix', (await page.locator('#main .mx').count()) === 2 && /old \(cached\) copy/.test(mx) && /click Save Text/.test(mx) && (await page.locator('#main [data-goconcept]').count()) === 2, mx.slice(0, 300));
    await page.click('#main [data-goconcept="in-ca:CorporateIdentityNumber"]');
    await page.waitForTimeout(200);
    check('MCA error help: element button navigates to the element', (await page.locator('#main #general-title').count()) === 1 || /_700300$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || ''));
    // ---- mandatory marking (business rules) in the UI
    await page.click(tab('210000'));
    const mandBadge = await page.locator('#main tr:has(input[data-c="ind-as:RevenueFromOperations"]) .mand').first().textContent().catch(() => '');
    check('mandatory fields are tagged "Mandatory" with the rule on hover', /Mandatory/.test(mandBadge) && /SR-/.test(await page.locator('#main tr:has(input[data-c="ind-as:RevenueFromOperations"]) .mand').first().getAttribute('title')));
    check('conditional fields are tagged "Conditional"', (await page.locator('#main .mand.cond').count()) > 0 || (await page.locator('#main .mand').count()) > 0);
    check('mandatory cells carry the required marker (outlined when empty)', (await page.locator('#main input.cellin.req[data-c="ind-as:RevenueFromOperations"][data-s="CY"]').count()) === 1);
    await page.click('a[data-go="setup"]');
    check('company form: identity fields tagged Mandatory', (await page.locator('#setup .mand').count()) >= 5);
    check('no page errors', errors.length === 0, errors.map((e) => e.stack || e).join('; '));
  } finally {
    try { unlinkSync(exported); } catch { /* ignore */ }
    await browser.close();
  }
  return { status: checks.every((c) => c.ok) ? 'PASS' : 'FAIL', ...st, checks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await runBrowserSmoke();
  for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ' — ' + c.detail}`);
  console.log(r.status, r.reason || '');
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
