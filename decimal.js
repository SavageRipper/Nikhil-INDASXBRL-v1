// Exact decimal arithmetic on BigInt. All canonical numeric fact values pass through here;
// binary floating point is never used for fact values.
// A Dec is { n: BigInt, s: number } meaning n × 10^-s, normalised (no trailing zeros, s >= 0).

const TEN = 10n;
const pow10 = (k) => TEN ** BigInt(k);

export function isDecimalString(str) {
  return typeof str === 'string' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(str.trim());
}

export function parse(str) {
  if (typeof str === 'bigint') return norm({ n: str, s: 0 });
  if (typeof str === 'number') {
    if (!Number.isFinite(str)) throw new Error(`Not a finite number: ${str}`);
    str = String(str);
  }
  const t = String(str).trim().replace(/,/g, '');
  if (!isDecimalString(t)) throw new Error(`Invalid decimal: "${str}"`);
  let [mant, exp] = t.toLowerCase().split('e');
  let sign = 1n;
  if (mant[0] === '-') { sign = -1n; mant = mant.slice(1); } else if (mant[0] === '+') mant = mant.slice(1);
  const [ip, fp = ''] = mant.split('.');
  let n = BigInt((ip || '0') + fp) * sign;
  let s = fp.length;
  const e = exp ? Number(exp) : 0;
  if (e > 0) { if (e >= s) { n *= pow10(e - s); s = 0; } else s -= e; } else if (e < 0) s += -e;
  return norm({ n, s });
}

function norm(d) {
  let { n, s } = d;
  while (s > 0 && n % TEN === 0n) { n /= TEN; s--; }
  if (n === 0n) s = 0;
  return { n, s };
}
function align(a, b) {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}
const D = (x) => (x && typeof x === 'object' && 'n' in x ? x : parse(x));

export const add = (a, b) => { const [x, y, s] = align(D(a), D(b)); return norm({ n: x + y, s }); };
export const sub = (a, b) => { const [x, y, s] = align(D(a), D(b)); return norm({ n: x - y, s }); };
export const mul = (a, b) => { a = D(a); b = D(b); return norm({ n: a.n * b.n, s: a.s + b.s }); };
export const neg = (a) => { a = D(a); return { n: -a.n, s: a.s }; };
export const cmp = (a, b) => { const [x, y] = align(D(a), D(b)); return x < y ? -1 : x > y ? 1 : 0; };
export const eq = (a, b) => cmp(a, b) === 0;
export const isZero = (a) => D(a).n === 0n;
export const sign = (a) => { const n = D(a).n; return n < 0n ? -1 : n > 0n ? 1 : 0; };
export const sum = (list) => list.reduce((acc, v) => add(acc, v), { n: 0n, s: 0 });

// multiply by 10^k (k may be negative) — exact
export function shift(a, k) {
  a = D(a);
  if (k >= 0) return a.s >= k ? norm({ n: a.n, s: a.s - k }) : norm({ n: a.n * pow10(k - a.s), s: 0 });
  return norm({ n: a.n, s: a.s - k });
}

export function fractionDigits(a) { return D(a).s; }

// Smallest `decimals` value at which `a` is exactly representable (e.g. 1234500 -> -2, 1.25 -> 2, 0 -> +Infinity).
export function requiredDecimals(a) {
  a = D(a);
  if (a.n === 0n) return Infinity;
  if (a.s > 0) return a.s;
  let n = a.n < 0n ? -a.n : a.n, tz = 0;
  while (n % TEN === 0n) { n /= TEN; tz++; }
  return -tz;
}

// Round half away from zero to `decimals` places (decimals may be negative, e.g. -3 → thousands).
export function round(a, decimals) {
  a = D(a);
  if (decimals === 'INF' || decimals === Infinity || decimals == null) return a;
  const dec = Number(decimals);
  if (a.s <= dec) return a;
  const drop = a.s - dec; // number of digits to drop (>0)
  const f = pow10(drop);
  const neg = a.n < 0n;
  const abs = neg ? -a.n : a.n;
  let q = abs / f;
  const r = abs % f;
  if (r * 2n >= f) q += 1n;
  const n = neg ? -q : q;
  return dec >= 0 ? norm({ n, s: dec }) : norm({ n: n * pow10(-dec), s: 0 });
}

export function toString(a) {
  a = D(a);
  const neg = a.n < 0n;
  let digits = (neg ? -a.n : a.n).toString();
  if (a.s > 0) {
    digits = digits.padStart(a.s + 1, '0');
    digits = digits.slice(0, digits.length - a.s) + '.' + digits.slice(digits.length - a.s);
  }
  return (neg ? '-' : '') + digits;
}

// Fixed number of fraction digits for display (pads zeros; rounds if needed).
export function toFixed(a, places) {
  const r = round(D(a), places);
  const str = toString(r);
  if (places <= 0) return str;
  const [i, f = ''] = str.split('.');
  return i + '.' + f.padEnd(places, '0');
}

// Division by a positive integer (averages), exact to 12 additional fraction digits, then rounded half away from zero.
export function div(a, k) {
  a = D(a);
  const K = BigInt(k);
  if (K <= 0n) throw new Error('div by non-positive integer');
  const extra = 13;
  const q = (a.n * pow10(extra)) / K;
  return round(norm({ n: q, s: a.s + extra }), a.s + 12);
}

export const ZERO = { n: 0n, s: 0 };
