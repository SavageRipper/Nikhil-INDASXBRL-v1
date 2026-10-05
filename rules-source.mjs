// Reads the MCA business-rule workbook into row records that keep exact source text and location.
// Two source forms are accepted:
//   * the original workbook (.xls / .xlsx) — read directly, every row of every sheet, no export limit
//   * a tab-separated text export ("## Sheet: <name>" blocks) — may carry "... (truncated at N rows)"
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';

export function readWorkbook(file) {
  return /\.xlsx?$/i.test(file) ? readWorkbookBinary(file) : readWorkbookText(file);
}

export function readWorkbookBinary(file) {
  const wb = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: false });
  const sheets = wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, blankrows: true, defval: '' });
    const out = [];
    rows.forEach((cells, i) => {
      const c = cells.map((x) => String(x ?? '').replace(/\r?\n/g, ' '));
      if (c.every((x) => x.trim() === '')) return;
      out.push({ line: i + 1, cells: c }); // line = worksheet row number
    });
    return { name: name.trim(), startLine: 1, rows: out, truncated: false };
  });
  return { file, form: 'workbook', sheets };
}

export function readWorkbookText(file) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const sheets = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = /^## Sheet: (.*)$/.exec(line);
    if (m) { cur = { name: m[1].trim(), startLine: i + 1, rows: [], truncated: false }; sheets.push(cur); return; }
    if (!cur) return;
    if (/^\.\.\. \(truncated at \d+ rows\)/.test(line)) { cur.truncated = true; cur.truncationNote = line.trim(); return; }
    if (line.trim() === '') return;
    cur.rows.push({ line: i + 1, cells: line.split('\t') });
  });
  return { file, form: 'text-export', sheets };
}

// "Specific rules for elements" (Ind AS V1.2 layout): per ELR a "LinkRole <uri>" row, a "Definition [nnnnnn] Title"
// row and a header row (prefix, name, label, order, a, Business Rule, -, Status, Applicable for First Time Adoption),
// then one row per element. The rule text is in the Business Rule column (one row continues into the next column);
// "No Rules Defined" in Status marks elements without a rule.
export function specificRules(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Specific rules for elements');
  const out = [];
  let elr = null, linkRole = null;
  for (const r of sheet.rows) {
    const c = r.cells.map((x) => (x || '').trim());
    if (c[0] === 'LinkRole') { linkRole = c[1]; continue; }
    if (c[0] === 'Definition') {
      const h = /^\[(\d{6}[a-z]?)\]\s*(.*)$/.exec(c[1]);
      elr = h ? { code: h[1], title: h[2].trim(), uri: linkRole } : { code: null, title: c[1], uri: linkRole };
      continue;
    }
    if (c[0] === 'prefix' && c[1] === 'name') continue;
    if (!c[1] || !/^[a-z-]+$/.test(c[0])) continue;
    const text = [c[5], c[6]].filter(Boolean).join(' ').trim();
    if (!text || /^No Rules? Defined$/i.test(text)) continue;
    out.push({ sheet: sheet.name, line: r.line, elr, prefix: c[0], element: c[1], label: c[2], text, ruleStatus: c[7] || null, firstTimeAdoption: /^y/i.test(c[8] || '') });
  }
  return { rows: out, truncated: sheet.truncated, truncationNote: sheet.truncationNote, lastElr: elr };
}

export function genericRules(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Generic rules');
  return sheet.rows.filter((r) => /^\d+$/.test(r.cells[0].trim())).map((r) => ({ sheet: sheet.name, line: r.line, no: Number(r.cells[0]), text: r.cells[1].trim(), note: (r.cells[2] || '').trim() || null }));
}

// No "Changes to Business Rules" sheet in the Ind AS V1.2 workbook (kept for a later workbook version).
export function changeRules(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Changes to Business Rules');
  if (!sheet) return [];
  return sheet.rows.filter((r) => /^\d+$/.test(r.cells[0])).map((r) => ({
    sheet: sheet.name, line: r.line, no: Number(r.cells[0]), dateSerial: r.cells[1], tab: r.cells[2], element: (r.cells[3] || '').trim(), text: (r.cells[4] || '').trim(),
  }));
}

// "Mandatory Line Items": S. No. | Table Name | Mandatory elements. Some rows carry no serial number; every row with a
// table name and a text is a rule row, numbered in sheet order (ML-1 … ML-n).
export function mandatoryLineItemSheets(wb) {
  return wb.sheets.filter((s) => /^Mandatory line.items$/i.test(s.name)).map((s) => {
    let seen = false, n = 0;
    const rows = [];
    for (const r of s.rows) {
      const c = r.cells.map((x) => (x || '').trim());
      if (/^S\.?\s*No\.?$/i.test(c[0]) && /Table/i.test(c[1])) { seen = true; continue; }
      if (!seen || !c[1] || !c[2]) continue;
      rows.push({ line: r.line, no: ++n, serial: c[0] || null, table: c[1], text: c[2] });
    }
    return { sheet: s.name, intro: s.rows[0]?.cells[0]?.trim() || '', rows };
  });
}

// Exempt parent member sheet: S.No. | Table | Axis | Exempted parent member(s) (several members per cell allowed).
// Exempt child member sheet: (no) | Table | Axis | Parent member | Exempted child member (one per row; blank cells
// continue the previous table / axis / parent).
const splitMembers = (v) => (v || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /Member$/.test(x));
export function exemptMemberSheets(wb, kind) {
  const re = kind === 'parent' ? /^Exempt parent member.?.?Dimension$/i : /^Exempt Child member.?.?Dimension$/i;
  return wb.sheets.filter((s) => re.test(s.name.replace(/\s+/g, ' '))).map((s) => {
    let table = null, axis = null, parent = null;
    const rows = [];
    for (const r of s.rows) {
      const c = r.cells.map((x) => (x || '').trim());
      if (/^Name of Table$/i.test(c[1])) continue;
      if (c[1]) { table = c[1]; parent = null; }
      if (c[2]) { axis = c[2]; parent = null; }
      if (kind === 'parent') {
        for (const m of splitMembers(c[3])) rows.push({ line: r.line, table, axis, member: m });
      } else {
        if (c[3]) parent = c[3];
        for (const m of splitMembers(c[4])) rows.push({ line: r.line, table, axis, parent, member: m });
      }
    }
    return { sheet: s.name, truncated: s.truncated, rows };
  });
}

export function parentChildExemptSheets(wb) {
  return wb.sheets.filter((s) => /^Parent.child exempt.calculation$/i.test(s.name.replace(/\s+/g, ' '))).map((s) => ({
    sheet: s.name,
    rows: s.rows.filter((r) => r.cells[0] && !/^Abstract's name$/i.test(r.cells[0].trim())).map((r) => ({ line: r.line, abstract: r.cells[0].trim(), text: (r.cells[1] || '').trim() })),
  }));
}

export function countryNames(wb) {
  const names = new Set();
  for (const s of wb.sheets.filter((x) => /^Country Codes?$/i.test(x.name))) {
    for (const r of s.rows) for (const c of r.cells) {
      const v = c.trim();
      if (v && !/^Country Name$/i.test(v)) names.add(v);
    }
  }
  return [...names].sort();
}

// "Currency Code" sheet: ISO 4217 codes in two columns.
export function currencyCodes(wb) {
  const codes = new Set();
  for (const s of wb.sheets.filter((x) => /^Currency Codes?$/i.test(x.name))) {
    for (const r of s.rows) for (const c of r.cells) { const v = c.trim(); if (/^[A-Z]{3}$/.test(v)) codes.add(v); }
  }
  return [...codes].sort();
}

// "formulas Linkbase" sheet: groups of (change, opening, closing) element rows — the list of opening/closing formula
// elements referred to by generic rule 6 and Filing Manual Annexure II #19.
export function openingClosingFormulaList(wb) {
  const s = wb.sheets.find((x) => /^formulas? Linkbase$/i.test(x.name.trim()));
  if (!s) return [];
  const out = [];
  for (const r of s.rows) {
    const c = r.cells.map((x) => (x || '').trim());
    if (/^(ind-as|in-ca)$/.test(c[0]) && c[1]) out.push({ line: r.line, prefix: c[0], name: c[1], label: c[2] });
  }
  return out;
}

export function applicableElrs(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Applicable ELR');
  return sheet.rows.filter((r) => /^\d+$/.test(r.cells[0].trim())).map((r) => {
    const m = /^\[(\d{6}[a-zA-Z]?)\]/.exec(r.cells[2].trim());
    return { line: r.line, id: r.cells[1].trim(), name: r.cells[2].trim(), code: m ? m[1] : null, applicableTo: (r.cells[3] || '').trim() };
  });
}
