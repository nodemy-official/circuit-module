import { complex, exactProductSumRatio, type ComplexValue } from "./analog-math.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "./circuit-model.js";
import { divideExactRational } from "./exact-linear-algebra.js";
import { complexFromExact, exactComplexValue } from "./exact-numeric-state.js";

const defaultCapacitanceFarads = circuitPartCatalog.capacitor.defaults.capacitanceFarads ?? 1e-6;
const defaultInductanceHenries = circuitPartCatalog.inductor.defaults.inductanceHenries ?? 0.01;

export function acAnalysisFrequency(document: CircuitDocument, requested: number | undefined) {
  if (requested !== undefined) { return requested; }
  return document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
}

/** Treat only floating-point roundoff as the same frequency, not nearby tones. */
export function frequencyMatches(first: number, second: number) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) { return false; }
  if (first === second) { return true; }
  const scale = Math.max(Math.abs(first), Math.abs(second));
  const excess = exactProductSumRatio([
    { factors: [Math.max(first, second)] },
    { factors: [Math.min(first, second)], sign: -1 },
    { factors: [scale, Number.EPSILON, 4], sign: -1 },
  ], 1);
  return excess !== null && excess.numerator <= 0n;
}

function angularProduct(frequencyHz: number, value: number) {
  return exactProductSumRatio([{ factors: [2, Math.PI, frequencyHz, value] }], 1);
}

export function acReactiveImpedance(part: CircuitPart, frequencyHz: number): ComplexValue {
  const angularValue = angularProduct(
    frequencyHz,
    part.kind === "capacitor"
      ? (part.capacitanceFarads ?? defaultCapacitanceFarads)
      : (part.inductanceHenries ?? defaultInductanceHenries),
  );
  if (!angularValue) { return complex(0, Number.NaN); }
  const imaginary = part.kind === "capacitor"
    ? divideExactRational({ numerator: -1n, denominator: 1n }, angularValue)
    : angularValue;
  return imaginary
    ? complexFromExact({ real: { numerator: 0n, denominator: 1n }, imaginary })
    : complex(0, Number.NEGATIVE_INFINITY);
}

export function acReactiveReactance(part: CircuitPart, frequencyHz: number) {
  return acReactiveImpedance(part, frequencyHz).imaginary;
}

export function acReactiveAdmittance(part: CircuitPart, frequencyHz: number): ComplexValue {
  const angularValue = angularProduct(frequencyHz, part.kind === "capacitor"
    ? part.capacitanceFarads ?? defaultCapacitanceFarads
    : part.inductanceHenries ?? defaultInductanceHenries);
  if (!angularValue) { return complex(0, Number.NaN); }
  const imaginary = part.kind === "capacitor"
    ? angularValue
    : divideExactRational({ numerator: -1n, denominator: 1n }, angularValue);
  return imaginary
    ? complexFromExact({ real: { numerator: 0n, denominator: 1n }, imaginary })
    : complex(0, Number.NEGATIVE_INFINITY);
}

/**
 * Matches the solver's AC branch model: a finite reactance is represented as
 * a voltage branch. An out-of-range reactance is conductive through its
 * Norton admittance when the exact internal value is nonzero and its public
 * number projection is finite; that projection may underflow to zero.
 */
export function isAcReactiveConductive(part: CircuitPart, frequencyHz: number) {
  if (part.kind !== "capacitor" && part.kind !== "inductor") { return false; }
  if (Number.isFinite(acReactiveReactance(part, frequencyHz))) { return true; }
  const admittance = acReactiveAdmittance(part, frequencyHz);
  const exact = exactComplexValue(admittance);
  return Number.isFinite(admittance.real) && Number.isFinite(admittance.imaginary) &&
    exact !== null && (exact.real.numerator !== 0n || exact.imaginary.numerator !== 0n);
}
