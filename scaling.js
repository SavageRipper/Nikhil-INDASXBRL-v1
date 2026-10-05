// Scaling/unit engine — display value vs canonical value.
// The XML always carries the canonical (unscaled) value; scale only affects display/entry
// and the derived `decimals` (Filing Manual §1.3.1 #19–21: no scale factor in fact content).
import * as Dec from './decimal.js';

// Powers of ten for the enumeration values of in-ca-types:LevelOfRounding (Ind AS 2017 adds Hundreds).
export const SCALE_POWERS = { Actual: 0, Hundreds: 2, Thousands: 3, Lakhs: 5, Millions: 6, Crores: 7, Billions: 9 };

export function scalePower(level) {
  if (!(level in SCALE_POWERS)) throw new Error(`Unknown level of rounding: ${level}`);
  return SCALE_POWERS[level];
}

// display string (in the chosen scale) -> canonical decimal string
export function toCanonical(display, level) {
  return Dec.toString(Dec.shift(Dec.parse(display), scalePower(level)));
}

// canonical decimal string -> display string (exact; no rounding)
export function toDisplay(canonical, level) {
  return Dec.toString(Dec.shift(Dec.parse(canonical), -scalePower(level)));
}

// decimals attribute for a monetary value entered with `displayPlaces` fraction digits in `level`.
// e.g. Lakhs with 2 places => accuracy 10^3 => decimals = -3; Actual with 2 places => 2.
// GR-8: monetary values allow at most 2 decimal places, so decimals is capped at 2.
export function monetaryDecimals(level, displayPlaces) {
  return Math.min(2, Number(displayPlaces) - scalePower(level));
}

// Deterministic decimals for user-entered non-monetary numerics: the number of fraction
// digits actually entered (an exact value has no rounding beyond its last digit).
export function enteredDecimals(canonical) {
  return Dec.fractionDigits(Dec.parse(canonical));
}

// Only applies to monetary concepts; shares, per-share, percentages and pure values are never scaled.
export function isScaledType(dataType) { return dataType === 'monetary'; }
