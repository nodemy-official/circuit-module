import { complex, type ComplexValue } from "./analog-math.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "./circuit-model.js";

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
  return Math.abs(first - second) <= scale * Number.EPSILON * 4;
}

function angularProduct(frequencyHz: number, value: number) {
  const intermediate = frequencyHz * value;
  const first = intermediate * (2 * Math.PI);
  // A subnormal intermediate can lose most of its significant bits before
  // multiplication by 2π. Scale first, then multiply the two physical values.
  if (
    Number.isFinite(intermediate) && Math.abs(intermediate) >= 2 ** -1022 &&
    Number.isFinite(first) && first !== 0
  ) {
    return first;
  }
  // Choose a multiplication order that avoids an overflowing or underflowing
  // intermediate when the final angular product is still representable.
  const alternatives = [
    (frequencyHz * (2 * Math.PI)) * value,
    (value * (2 * Math.PI)) * frequencyHz,
  ];
  return alternatives.find((candidate) => Number.isFinite(candidate) && candidate !== 0) ??
    (Number.isFinite(first) ? first : alternatives.find(Number.isFinite) ?? first);
}

function inverseAngularProduct(frequencyHz: number, value: number) {
  const angularValue = angularProduct(frequencyHz, value);
  const inverse = 1 / angularValue;
  if (Number.isFinite(inverse) && inverse !== 0) { return inverse; }

  // Avoid overflowing ωL before taking its reciprocal. These alternate orders
  // retain an in-range admittance even when the inductive reactance is too large.
  const alternatives = [
    ((1 / frequencyHz) / value) / (2 * Math.PI),
    ((1 / value) / frequencyHz) / (2 * Math.PI),
  ];
  return alternatives.find((candidate) => Number.isFinite(candidate) && candidate !== 0) ?? inverse;
}

export function acReactiveReactance(part: CircuitPart, frequencyHz: number) {
  const angularValue = angularProduct(
    frequencyHz,
    part.kind === "capacitor"
      ? (part.capacitanceFarads ?? defaultCapacitanceFarads)
      : (part.inductanceHenries ?? defaultInductanceHenries),
  );
  return part.kind === "capacitor"
    ? -1 / angularValue
    : angularValue;
}

export function acReactiveAdmittance(part: CircuitPart, frequencyHz: number): ComplexValue {
  if (part.kind === "capacitor") {
    return complex(0, angularProduct(frequencyHz, part.capacitanceFarads ?? defaultCapacitanceFarads));
  }
  return complex(0, -inverseAngularProduct(frequencyHz, part.inductanceHenries ?? defaultInductanceHenries));
}

/**
 * Matches the solver's AC branch model: a finite reactance is represented as
 * a voltage branch, while an out-of-range reactance is represented by its
 * Norton admittance only when that admittance is finite and nonzero.
 */
export function isAcReactiveConductive(part: CircuitPart, frequencyHz: number) {
  if (part.kind !== "capacitor" && part.kind !== "inductor") { return false; }
  if (Number.isFinite(acReactiveReactance(part, frequencyHz))) { return true; }
  const admittance = acReactiveAdmittance(part, frequencyHz);
  return Number.isFinite(admittance.real) && Number.isFinite(admittance.imaginary) &&
    (admittance.real !== 0 || admittance.imaginary !== 0);
}
