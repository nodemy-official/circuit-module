/** Formats a finite value with significant digits without rounding a maximum to Infinity. */
export function formatCircuitNumber(value: number, significantDigits = 4): string {
  if (!Number.isFinite(value)) { return "—"; }
  if (value === 0) { return "0"; }
  const rounded = value.toPrecision(significantDigits);
  const numeric = Number(rounded);
  return Number.isFinite(numeric) ? numeric.toString() : rounded;
}
