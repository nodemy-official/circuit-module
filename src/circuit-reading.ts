import { complexMagnitude, complexMagnitudeNormalization, complexNormalizedFraction, complexFromNormalizedFraction, complexPhaseDegrees, complexSubtract, withComplexMagnitudeNormalization, type ComplexValue, type NormalizedTerm } from "./analog-math.js";
import type { CircuitTerminal } from "./circuit-model.js";
import { complexFromExact, exactComplexValue } from "./exact-numeric-state.js";
import { addExactRational, subtractExactRational, multiplyExactRational, divideExactRational, sumExactRationals, numberToExactRational, deferExactRationalReduction, type ExactRational } from "./exact-linear-algebra.js";
import { capturedExactExpressionSign, capturedExactReference, restoreExactExpression, type ExactExpressionNode, type ExactExpressionReference } from "./exact-expression.js";

export type CircuitExactRational = { numerator: string; denominator: string } | ExactExpressionReference;

export interface CircuitExactNormalizedTerm {
  real: CircuitExactRational;
  imaginary: CircuitExactRational;
  magnitudeNormalizationSquared: CircuitExactRational;
}

/** JSON-safe exact components, retained before scalar and polar display rounding. */
export interface CircuitExactComplex {
  real: CircuitExactRational;
  imaginary: CircuitExactRational;
  magnitudeNormalizationSquared?: CircuitExactRational;
  /** Algebraic terms, retained so cancellation remains exact after transport. */
  normalizedFraction?: { numerator: readonly CircuitExactNormalizedTerm[]; denominator: readonly CircuitExactNormalizedTerm[] };
  /** Original scalar projections, used to detect later scalar-only edits. */
  projection?: { real: number; magnitude: number; phaseDegrees: number };
}

const serializedRationals = new WeakMap<ExactRational, CircuitExactComplex["real"]>();

function serializedRational(value: ExactRational) {
  const reference = capturedExactReference(value);
  if (reference) { return reference; }
  const cached = serializedRationals.get(value);
  if (cached) { return { ...cached }; }
  // Hex conversion is linear in the bit length; decimal conversion made
  // long exact transient histories much slower to sample.
  const numerator = value.numerator < 0n ? `-0x${(-value.numerator).toString(16)}` : `0x${value.numerator.toString(16)}`;
  const result = { numerator, denominator: `0x${value.denominator.toString(16)}` };
  serializedRationals.set(value, result);
  return { ...result };
}

export interface CircuitReadingPrecision {
  exactVoltage?: CircuitExactComplex;
  exactTerminalVoltages?: Partial<Record<CircuitTerminal, CircuitExactComplex>>;
  exactTerminalCurrents?: Partial<Record<CircuitTerminal, CircuitExactComplex>>;
}

export function retainedComplex(value: ComplexValue): CircuitExactComplex | undefined {
  const exact = exactComplexValue(value);
  if (!exact) { return; }
  const normalization = complexMagnitudeNormalization(value);
  const fraction = complexNormalizedFraction(value);
  const normalized = normalization.numerator !== normalization.denominator;
  const represented = (component: ExactRational, projection: number) => {
    const projected = numberToExactRational(projection);
    return projected && component.numerator * projected.denominator === projected.numerator * component.denominator;
  };
  // Rectangular components with a nonzero phase generally cannot be rebuilt
  // from a rounded RMS/angle pair. On axes, retain non-binary rational values
  // too: individually rounded voltages and currents must not be summed.
  if (!fraction && !normalized && (exact.real.numerator === 0n || exact.imaginary.numerator === 0n) &&
    represented(exact.real, value.real) && represented(exact.imaginary, value.imaginary)) { return; }
  const onRealAxis = exact.imaginary.numerator === 0n;
  const onImaginaryAxis = exact.real.numerator === 0n;
  const phaseDegrees = onRealAxis ? exact.real.numerator < 0n ? 180 : 0
    : onImaginaryAxis ? exact.imaginary.numerator < 0n ? -90 : 90 : complexPhaseDegrees(value);
  return { real: serializedRational(exact.real), imaginary: serializedRational(exact.imaginary),
    ...(normalized ? { magnitudeNormalizationSquared: serializedRational(normalization) } : {}),
    ...(fraction ? { normalizedFraction: { numerator: fraction.numerator.map(serializedNormalizedTerm),
      denominator: fraction.denominator.map(serializedNormalizedTerm) } } : {}),
    projection: { real: value.real, magnitude: normalized ? complexMagnitude(value) : onRealAxis ? Math.abs(value.real)
      : onImaginaryAxis ? Math.abs(value.imaginary) : complexMagnitude(value), phaseDegrees } };
}

function serializedNormalizedTerm(term: NormalizedTerm): CircuitExactNormalizedTerm {
  return { real: serializedRational(term.coefficient.real), imaginary: serializedRational(term.coefficient.imaginary),
    magnitudeNormalizationSquared: serializedRational(term.squared) };
}

const LARGE_REPLAY_VALUE = 2n ** 4096n;

function replayOperand(value: ExactRational): ExactRational {
  return value.denominator >= LARGE_REPLAY_VALUE || value.numerator >= LARGE_REPLAY_VALUE || value.numerator <= -LARGE_REPLAY_VALUE
    ? deferExactRationalReduction(value) : value;
}

const expressionOperations = {
  // Keep fixed coefficients canonical, as in the solver. Marking every
  // coefficient deferred prevents cross-cancellation during long replay.
  literal: (value: ExactRational) => value.denominator < 2n ** 4096n && value.numerator < 2n ** 4096n && value.numerator > -(2n ** 4096n)
    ? addExactRational(value, numberToExactRational(0)!) : deferExactRationalReduction(value),
  // Growing histories retain their exact values without repeatedly reducing
  // enormous numerators. Small fixed coefficients still cross-cancel normally.
  add: (left: ExactRational, right: ExactRational) => addExactRational(replayOperand(left), replayOperand(right)),
  subtract: (left: ExactRational, right: ExactRational) => subtractExactRational(replayOperand(left), replayOperand(right)),
  multiply: (left: ExactRational, right: ExactRational) => multiplyExactRational(replayOperand(left), replayOperand(right)),
  divide: (left: ExactRational, right: ExactRational) => divideExactRational(replayOperand(left), replayOperand(right)),
  sum: (values: readonly ExactRational[]) => sumExactRationals(values.map(replayOperand)),
};

function restoredRational(component: unknown, expressions: readonly ExactExpressionNode[] | undefined) {
  if (typeof component === "object" && component !== null && "expression" in component && typeof component.expression === "number") {
    return restoreExactExpression(expressions, component.expression, expressionOperations);
  }
      if (typeof component !== "object" || component === null || !("numerator" in component) || !("denominator" in component) ||
        typeof component.numerator !== "string" || typeof component.denominator !== "string" ||
        !/^-?(?:\d+|0x[\da-f]+)$/i.test(component.numerator) || !/^(?:\d+|0x[\da-f]+)$/i.test(component.denominator)) { return; }
      const denominator = BigInt(component.denominator);
      const numerator = component.numerator.startsWith("-") ? -BigInt(component.numerator.slice(1)) : BigInt(component.numerator);
      return denominator > 0n ? replayOperand({ numerator, denominator }) : undefined;
}

function restoredNormalizedTerms(value: unknown, expressions: readonly ExactExpressionNode[] | undefined): NormalizedTerm[] | undefined {
  if (!Array.isArray(value)) { return; }
  const result: NormalizedTerm[] = [];
  for (const term of value) {
    if (typeof term !== "object" || term === null) { return; }
    const real = restoredRational(term.real, expressions);
    const imaginary = restoredRational(term.imaginary, expressions);
    const squared = restoredRational(term.magnitudeNormalizationSquared, expressions);
    if (!real || !imaginary || !squared || squared.numerator <= 0n) { return; }
    result.push({ coefficient: { real, imaginary }, squared });
  }
  return result;
}

/** Ignore malformed optional metadata and let scalar-reading fallbacks apply. */
export function restoredComplex(value: CircuitExactComplex | undefined, expressions?: readonly ExactExpressionNode[]): ComplexValue | undefined {
  if (!value) { return; }
  try {
    const real = restoredRational(value.real, expressions);
    const imaginary = restoredRational(value.imaginary, expressions);
    if (!real || !imaginary) { return; }
    let result = complexFromExact({ real, imaginary });
    if (value.magnitudeNormalizationSquared) {
      const normalization = restoredRational(value.magnitudeNormalizationSquared, expressions);
      if (!normalization || normalization.numerator <= 0n) { return; }
      result = withComplexMagnitudeNormalization(result, normalization);
    }
    if (value.normalizedFraction) {
      const numerator = restoredNormalizedTerms(value.normalizedFraction.numerator, expressions);
      const denominator = restoredNormalizedTerms(value.normalizedFraction.denominator, expressions);
      if (!numerator || !denominator || denominator.length === 0) { return; }
      result = complexFromNormalizedFraction({ numerator, denominator }, complexMagnitudeNormalization(result));
    }
    return Number.isFinite(result.real) && Number.isFinite(result.imaginary) ? result : undefined;
  } catch {
    // Malformed optional metadata uses the scalar-reading fallback.
  }
}

export function restoredReadingComplex(value: CircuitExactComplex | undefined, scalar: number, degrees: number | undefined, ac: boolean, expressions?: readonly ExactExpressionNode[]) {
  const projection = value?.projection;
  if (projection && (scalar !== (ac ? projection.magnitude : projection.real) ||
    (ac && degrees !== projection.phaseDegrees))) { return; }
  return restoredComplex(value, expressions);
}

/** A nonzero expression retains its sign even if every displayed value underflows. */
export function retainedComplexIsNonzero(value: CircuitExactComplex | undefined, expressions?: readonly ExactExpressionNode[]) {
  if (!value) { return false; }
  return [value.real, value.imaginary].some((component) => {
    if (typeof component !== "object" || component === null) { return false; }
    if ("expression" in component) {
      const known = capturedExactExpressionSign(expressions, component.expression);
      if (known !== undefined) { return known !== 0; }
    }
    try {
      const restored = restoredRational(component, expressions);
      return restored !== undefined && restored.numerator !== 0n;
    } catch { return false; }
  });
}

export function readingPrecision(reading: {
  voltage: ComplexValue;
  terminalVoltages: Partial<Record<CircuitTerminal, ComplexValue>>;
  terminalCurrents: Partial<Record<CircuitTerminal, ComplexValue>>;
}): CircuitReadingPrecision {
  const retainedTerminals = (values: Partial<Record<CircuitTerminal, ComplexValue>>) => {
    const result: Partial<Record<CircuitTerminal, CircuitExactComplex>> = {};
    for (const terminal of ["a", "b", "c"] as const) {
      const value = values[terminal];
      const exact = value && retainedComplex(value);
      if (exact) { result[terminal] = exact; }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const exactVoltage = retainedComplex(reading.voltage);
  const exactTerminalVoltages = retainedTerminals(reading.terminalVoltages);
  const exactTerminalCurrents = retainedTerminals(reading.terminalCurrents);
  return { ...(exactVoltage ? { exactVoltage } : {}),
    ...(exactTerminalVoltages ? { exactTerminalVoltages } : {}),
    ...(exactTerminalCurrents ? { exactTerminalCurrents } : {}) };
}

export interface CircuitTerminalVoltageDifference {
  fromTerminal: CircuitTerminal;
  toTerminal: CircuitTerminal;
  /** Signed in DC; RMS magnitude in AC. Computed before terminal potentials are rounded. */
  voltageVolts: number;
  voltagePhaseDegrees?: number;
  exactVoltage?: CircuitExactComplex;
}

/** Preserve local differences for three-terminal readings, including loaded potentiometers. */
export function terminalVoltageDifferences(values: Partial<Record<CircuitTerminal, ComplexValue>>, ac: boolean, retainedDifferences?: readonly { fromTerminal: CircuitTerminal; toTerminal: CircuitTerminal; voltage: ComplexValue }[]) {
  if (!values.a || !values.b || !values.c) { return; }
  const differences: CircuitTerminalVoltageDifference[] = [];
  for (const [fromTerminal, toTerminal] of [["a", "b"], ["a", "c"], ["b", "c"]] as const) {
    const value = retainedDifferences?.find((difference) => difference.fromTerminal === fromTerminal && difference.toTerminal === toTerminal)?.voltage
      ?? complexSubtract(values[fromTerminal]!, values[toTerminal]!);
    const voltageVolts = ac ? complexMagnitude(value) : value.real;
    if (!Number.isFinite(voltageVolts)) { continue; }
    const exactVoltage = retainedComplex(value);
    differences.push({ fromTerminal, toTerminal, voltageVolts,
      ...(exactVoltage ? { exactVoltage } : {}),
      ...(ac ? { voltagePhaseDegrees: complexPhaseDegrees(value) } : {}) });
  }
  return differences;
}
