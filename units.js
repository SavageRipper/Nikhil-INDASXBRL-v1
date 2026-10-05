// Units for numeric concepts, as required by the Ind AS 2017 taxonomy item types.
// Filing Manual Ind AS §1.1.3.1 #7/#24, generic rule 8 (INR except the listed subsidiary elements).

export const UNIT_DEFS = {
  INR: { id: 'INR', measures: ['iso4217:INR'] },
  shares: { id: 'shares', measures: ['xbrli:shares'] },
  pure: { id: 'pure', measures: ['xbrli:pure'] },
  INRPerShare: { id: 'INRPerShare', numerator: ['iso4217:INR'], denominator: ['xbrli:shares'] },
};

export function currencyUnit(code) {
  if (code === 'INR') return UNIT_DEFS.INR;
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Invalid ISO 4217 code: ${code}`);
  return { id: code, measures: [`iso4217:${code}`] };
}

// default unit id for a concept (currency may be overridden for exempt subsidiary tables)
export function defaultUnitFor(dataType, currency = 'INR') {
  switch (dataType) {
    case 'monetary': return currency === 'INR' ? 'INR' : currency;
    case 'shares': return 'shares';
    case 'perShare': return 'INRPerShare';
    case 'percent': case 'pure': case 'decimal': return 'pure';
    default: return null;
  }
}

export function unitDef(id) {
  if (UNIT_DEFS[id]) return UNIT_DEFS[id];
  if (/^[A-Z]{3}$/.test(id)) return currencyUnit(id);
  if (/^[A-Z]{3}PerShare$/.test(id)) return { id, numerator: [`iso4217:${id.slice(0, 3)}`], denominator: ['xbrli:shares'] };
  return null;
}

// Is a unit definition consistent with the data type?
export function unitMatchesType(dataType, def) {
  if (!def) return false;
  const m = def.measures || [];
  switch (dataType) {
    case 'monetary': return m.length === 1 && m[0].startsWith('iso4217:') && !def.denominator;
    case 'shares': return m.length === 1 && m[0] === 'xbrli:shares';
    case 'perShare': return !!def.numerator && def.numerator[0].startsWith('iso4217:') && def.denominator?.[0] === 'xbrli:shares';
    case 'percent': case 'pure': return m.length === 1 && m[0] === 'xbrli:pure';
    case 'decimal': return !!def;
    default: return false;
  }
}

export function unitKey(def) {
  if (def.denominator) return `${def.numerator.join('*')}/${def.denominator.join('*')}`;
  return def.measures.join('*');
}
