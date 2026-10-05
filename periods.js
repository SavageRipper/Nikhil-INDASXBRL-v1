// Period engine: CURRENT / PRIOR separation based on actual reporting dates.
// Scopes:  CY  = current year (duration CY, instant at CY end)
//          PY  = previous year (duration PY, instant at PY end — also the CY opening balance)
//          PYO = instant at the day before PY start (PY opening balance)

export function isoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function validatePeriods(p) {
  const errs = [];
  for (const k of ['cy', 'py']) {
    if (!p?.[k]) { errs.push(`${k.toUpperCase()} period missing`); continue; }
    if (!isoDate(p[k].start) || !isoDate(p[k].end)) errs.push(`${k.toUpperCase()} dates must be yyyy-mm-dd`);
    else if (p[k].start > p[k].end) errs.push(`${k.toUpperCase()} start after end`);
  }
  if (!errs.length && p.py.end >= p.cy.start) errs.push('Previous-year period must end before the current-year period starts');
  return errs;
}

export function periodFor(periods, periodType, scope) {
  const { cy, py } = periods;
  if (periodType === 'duration') {
    if (scope === 'CY') return { type: 'duration', start: cy.start, end: cy.end };
    if (scope === 'PY') return { type: 'duration', start: py.start, end: py.end };
    return null;
  }
  if (scope === 'CY') return { type: 'instant', date: cy.end };
  if (scope === 'PY') return { type: 'instant', date: py.end };
  if (scope === 'PYO') return { type: 'instant', date: addDays(py.start, -1) };
  return null;
}

// Opening-balance column mapping for concepts presented with a periodStart label.
export function openingPeriodFor(periods, scope) {
  return periodFor(periods, 'instant', scope === 'CY' ? 'PY' : 'PYO');
}

export function scopeOf(periods, period) {
  if (!period) return null;
  const { cy, py } = periods;
  if (period.type === 'duration') {
    if (period.start === cy.start && period.end === cy.end) return 'CY';
    if (period.start === py.start && period.end === py.end) return 'PY';
    return 'OTHER';
  }
  if (period.date === cy.end) return 'CY';
  if (period.date === py.end) return 'PY';
  if (period.date === addDays(py.start, -1)) return 'PYO';
  return 'OTHER';
}

// Which reporting scope (CY/PY) a period belongs to for applicability purposes.
export function reportingYear(periods, period) {
  const s = scopeOf(periods, period);
  return s === 'PYO' ? 'PY' : s;
}

export function periodKey(p) {
  return p.type === 'instant' ? `I:${p.date}` : `D:${p.start}:${p.end}`;
}

export function periodsOverlap(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'instant') return a.date === b.date;
  return a.start <= b.end && b.start <= a.end && !(a.start === b.start && a.end === b.end);
}
