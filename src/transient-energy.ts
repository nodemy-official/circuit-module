import type { CircuitDocument, CircuitPart } from "./circuit-model.js";
import { retainedComplex, restoredReadingComplex, type CircuitExactComplex, type CircuitExactNormalizedTerm, type CircuitExactRational } from "./circuit-reading.js";
import { appendExactComponentSnapshot } from "./circuit-reading-snapshot.js";
import type { ComplexValue } from "./analog-math.js";
import { complexFromExact } from "./exact-numeric-state.js";
import { addExactRational, exactRationalToNumber, multiplyExactRational, numberToExactRational, subtractExactRational, type ExactRational } from "./exact-linear-algebra.js";
import { exactExpressionsAreImmutable, matchingExactExpressions, type ExactExpressionNode } from "./exact-expression.js";
import { simulationNumericField } from "./simulation-input.js";
import type { TransientPartReading, TransientSample } from "./transient-solver.js";

export interface TransientEnergySample {
  readonly timeSeconds: number;
  readonly voltageVolts: number;
  readonly currentAmps: number;
  readonly powerWatts: number;
  readonly exactVoltage?: CircuitExactComplex;
  readonly exactCurrent?: CircuitExactComplex;
  readonly storedJoules?: number | null;
  readonly dissipatedJoules?: number | null;
  readonly exactStoredJoules?: CircuitExactRational;
  readonly exactDissipatedJoules?: CircuitExactRational;
}

export interface TransientPartEnergy {
  readonly kind: CircuitPart["kind"];
  readonly coefficient?: number;
  /** Real projections are already snapshotted by the sample's scalar readings. */
  readonly precisionSnapshot?: "real";
  readonly samples: readonly TransientEnergySample[];
}

/** Derived readouts with input snapshots, usable after JSON or structured cloning. */
export type TransientEnergyReadings = Readonly<Record<string, TransientPartEnergy>>;

interface EnergyState {
  previousTime: ExactRational;
  previousPower: ExactRational;
  accumulated: ExactRational;
  unavailable: boolean;
}

const HALF = numberToExactRational(0.5)!;
const ZERO = numberToExactRational(0)!;

function coefficient(part: CircuitPart) {
  if (part.kind !== "capacitor" && part.kind !== "inductor") { return; }
  // Invalid own values must invalidate derived metadata instead of matching
  // a cache created while the coefficient was omitted and used its default.
  return simulationNumericField(part, part.kind === "capacitor" ? "capacitanceFarads" : "inductanceHenries")
    ?? (part.kind === "capacitor" ? 1e-6 : 0.01);
}

function snapshotComplex(value: CircuitExactComplex | undefined): CircuitExactComplex | undefined {
  if (!value) { return; }
  return { real: { ...value.real }, imaginary: { ...value.imaginary },
    ...(value.magnitudeNormalizationSquared ? { magnitudeNormalizationSquared: { ...value.magnitudeNormalizationSquared } } : {}),
    ...(value.normalizedFraction ? { normalizedFraction: {
      numerator: Array.from({ length: value.normalizedFraction.numerator.length }, (_, index) =>
        snapshotNormalizedTerm(value.normalizedFraction!.numerator[index]!)),
      denominator: Array.from({ length: value.normalizedFraction.denominator.length }, (_, index) =>
        snapshotNormalizedTerm(value.normalizedFraction!.denominator[index]!)),
    } } : {}) };
}

function snapshotNormalizedTerm(term: CircuitExactNormalizedTerm): CircuitExactNormalizedTerm {
  return { real: { ...term.real }, imaginary: { ...term.imaginary },
    magnitudeNormalizationSquared: { ...term.magnitudeNormalizationSquared } };
}

function finiteProjection(value: ExactRational): number | null {
  const result = exactRationalToNumber(value);
  return Number.isFinite(result) ? result : null;
}

interface RetainedEnergy {
  value: ComplexValue;
  snapshot: unknown[];
  expressions?: readonly ExactExpressionNode[];
}

const retainedEnergies = new WeakMap<CircuitExactRational, RetainedEnergy>();
const immutableExpressionMatches = new WeakMap<readonly ExactExpressionNode[], WeakMap<readonly ExactExpressionNode[], boolean>>();

function matchingEnergyExpressions(first: readonly ExactExpressionNode[] | undefined, second: readonly ExactExpressionNode[] | undefined) {
  if (first === second) { return true; }
  if (!first || !second || !exactExpressionsAreImmutable(first) || !exactExpressionsAreImmutable(second)) { return matchingExactExpressions(first, second); }
  const matches = immutableExpressionMatches.get(first) ?? new WeakMap<readonly ExactExpressionNode[], boolean>();
  const cached = matches.get(second);
  if (cached !== undefined) { return cached; }
  const match = matchingExactExpressions(first, second);
  matches.set(second, match);
  immutableExpressionMatches.set(first, matches);
  return match;
}

/** Bind solver-owned retained energies to the expression table captured with them. */
export function registerTransientEnergyExpressions(readings: TransientEnergyReadings | undefined, expressions: readonly ExactExpressionNode[]) {
  if (!readings) { return; }
  for (const entry of Object.values(readings)) {
    for (const sample of entry.samples) {
      const metadata = sample.exactStoredJoules ?? sample.exactDissipatedJoules;
      const retained = metadata && retainedEnergies.get(metadata);
      if (retained) { retained.expressions = expressions; }
    }
  }
}

/** Reuse an unchanged solver value; transported or edited metadata is restored normally. */
export function restoredTransientEnergy(metadata: CircuitExactRational | undefined, scalar: number, expressions?: readonly ExactExpressionNode[]) {
  const retained = metadata && retainedEnergies.get(metadata);
  try {
    if (retained && retained.value.real === scalar && matchingEnergyExpressions(expressions, retained.expressions)) {
      const snapshot: unknown[] = [];
      appendExactComponentSnapshot(snapshot, metadata);
      if (snapshot.length === retained.snapshot.length && snapshot.every((value, index) => Object.is(value, retained.snapshot[index]))) { return retained.value; }
    }
  } catch { /* Malformed optional components use the ordinary restoration fallback. */ }
  return restoredReadingComplex(metadata && { real: metadata, imaginary: { numerator: "0", denominator: "1" } }, scalar, undefined, false, expressions);
}

function retainedEnergy(value: ExactRational, projection: number | null): CircuitExactRational | undefined {
  if (projection === null) { return; }
  const exact = complexFromExact({ real: value, imaginary: ZERO });
  const metadata = retainedComplex(exact)?.real ?? { numerator: `0x${value.numerator.toString(16)}`, denominator: `0x${value.denominator.toString(16)}` };
  const snapshot: unknown[] = [];
  appendExactComponentSnapshot(snapshot, metadata);
  retainedEnergies.set(metadata, { value: exact, snapshot });
  return metadata;
}

export function createTransientEnergyCollector(document: CircuitDocument) {
  const targets = document.parts.filter((part) => ["capacitor", "inductor", "resistor", "bulb"].includes(part.kind));
  const entries = Object.create(null) as Record<string, { kind: CircuitPart["kind"]; coefficient?: number; precisionSnapshot: "real"; samples: TransientEnergySample[] }>;
  const states = new Map<string, EnergyState>();
  for (const part of targets) { entries[part.id] = { kind: part.kind, coefficient: coefficient(part), precisionSnapshot: "real", samples: [] }; }
  return {
    readings: entries as TransientEnergyReadings,
    append(sample: TransientSample, capacitorVoltages: ReadonlyMap<string, ExactRational>, inductorCurrents: ReadonlyMap<string, ExactRational>, resistivePowers: ReadonlyMap<string, ExactRational>) {
      const time = numberToExactRational(sample.timeSeconds)!;
      for (const part of targets) {
        const reading = sample.parts[part.id]!;
        const entry = entries[part.id]!;
        const basis = { timeSeconds: sample.timeSeconds, voltageVolts: reading.voltageVolts,
          currentAmps: reading.currentAmps, powerWatts: reading.powerWatts,
          exactVoltage: snapshotComplex(reading.exactVoltage), exactCurrent: snapshotComplex(reading.exactTerminalCurrents?.a) };
        const stored = part.kind === "capacitor" ? capacitorVoltages.get(part.id) : inductorCurrents.get(part.id);
        if (stored && entry.coefficient !== undefined) {
          const energy = multiplyExactRational(multiplyExactRational(HALF, numberToExactRational(entry.coefficient)!), multiplyExactRational(stored, stored));
          const storedJoules = finiteProjection(energy);
          entry.samples.push({ ...basis, storedJoules, exactStoredJoules: retainedEnergy(energy, storedJoules) });
          continue;
        }
        const power = resistivePowers.get(part.id);
        if (!power) { continue; }
        const previous = states.get(part.id);
        const accumulated = previous ? addExactRational(previous.accumulated, multiplyExactRational(
          multiplyExactRational(addExactRational(previous.previousPower, power), HALF), subtractExactRational(time, previous.previousTime),
        )) : ZERO;
        const projected = previous?.unavailable ? null : finiteProjection(accumulated);
        states.set(part.id, { previousTime: time, previousPower: power, accumulated, unavailable: projected === null });
        entry.samples.push({ ...basis, dissipatedJoules: projected, exactDissipatedJoules: retainedEnergy(accumulated, projected) });
      }
    },
  };
}

function matchingRational(first: CircuitExactRational | undefined, second: CircuitExactRational | undefined): boolean {
  if (!first || !second) { return first === second; }
  if ("expression" in first || "expression" in second) {
    return "expression" in first && "expression" in second && first.expression === second.expression && first.sign === second.sign;
  }
  return first.numerator === second.numerator && first.denominator === second.denominator;
}

function matchingRealProjection(value: CircuitExactComplex["projection"], scalar: number, real: CircuitExactRational) {
  const negative = "expression" in real ? real.sign === -1 : real.numerator.startsWith("-");
  return value === undefined || typeof value === "object" && value !== null &&
    value.real === scalar && value.magnitude === Math.abs(scalar) &&
    (negative ? Math.abs(value.phaseDegrees) === 180 : value.phaseDegrees === 0);
}

function matchingComplex(first: CircuitExactComplex | undefined, second: CircuitExactComplex | undefined, scalar: number, compact: boolean): boolean {
  if (!first || !second) { return first === second; }
  return matchingRational(first.real, second.real) && matchingRational(first.imaginary, second.imaginary) &&
    matchingRational(first.magnitudeNormalizationSquared, second.magnitudeNormalizationSquared) &&
    matchingNormalizedFraction(first.normalizedFraction, second.normalizedFraction) &&
    (compact ? matchingRealProjection(second.projection, scalar, second.real)
      : first.projection?.real === second.projection?.real && first.projection?.magnitude === second.projection?.magnitude &&
        first.projection?.phaseDegrees === second.projection?.phaseDegrees);
}

function matchingNormalizedFraction(first: CircuitExactComplex["normalizedFraction"], second: CircuitExactComplex["normalizedFraction"]): boolean {
  if (!first || !second) { return first === second; }
  return (["numerator", "denominator"] as const).every((side) => Array.isArray(first[side]) && Array.isArray(second[side]) &&
    first[side].length === second[side].length &&
    Array.from({ length: first[side].length }, (_, index) => index).every((index) => {
      const left = first[side][index];
      const right = second[side][index];
      return Boolean(left && right && matchingRational(left.real, right.real) && matchingRational(left.imaginary, right.imaginary) &&
        matchingRational(left.magnitudeNormalizationSquared, right.magnitudeNormalizationSquared));
    }));
}

function hasExpressionReference(value: CircuitExactComplex | undefined): boolean {
  if (!value) { return false; }
  const terms = value.normalizedFraction
    ? (["numerator", "denominator"] as const).flatMap((side) => Array.from(
      { length: value.normalizedFraction![side].length }, (_, index) => value.normalizedFraction![side][index]!,
    ))
    : [];
  return [value.real, value.imaginary, value.magnitudeNormalizationSquared,
    ...terms.flatMap((term) => [term.real, term.imaginary, term.magnitudeNormalizationSquared])]
    .some((component) => component && "expression" in component);
}

function matchingSample(energy: TransientEnergySample | undefined, sample: TransientSample, reading: TransientPartReading | undefined, compact: boolean): boolean {
  return Boolean(energy && reading && energy.timeSeconds === sample.timeSeconds && energy.voltageVolts === reading.voltageVolts &&
    energy.currentAmps === reading.currentAmps && energy.powerWatts === reading.powerWatts &&
    matchingComplex(energy.exactVoltage, reading.exactVoltage, reading.voltageVolts, compact) &&
    matchingComplex(energy.exactCurrent, reading.exactTerminalCurrents?.a, reading.currentAmps, compact) &&
    (energy.storedJoules === undefined || energy.storedJoules === null || Number.isFinite(energy.storedJoules) && energy.storedJoules >= 0) &&
    (energy.dissipatedJoules === undefined || energy.dissipatedJoules === null || Number.isFinite(energy.dissipatedJoules) && energy.dissipatedJoules >= 0));
}

/** Scalar, precision or time edits invalidate all dependent cumulative readouts. */
export function matchingTransientEnergy(part: CircuitPart, samples: readonly TransientSample[], energies: TransientEnergyReadings | undefined, expressions?: readonly ExactExpressionNode[], expectedExpressions?: readonly ExactExpressionNode[]): readonly TransientEnergySample[] | undefined {
  try {
    if (!matchingExactExpressions(expressions, expectedExpressions)) { return; }
    const energy = energies && Object.hasOwn(energies, part.id) ? energies[part.id] : undefined;
    if (!energy || energy.kind !== part.kind || energy.coefficient !== coefficient(part) || !Array.isArray(energy.samples) || energy.samples.length !== samples.length) { return; }
    if (!expressions && Array.from({ length: energy.samples.length }, (_, index) => energy.samples[index]!).some((sample) =>
      hasExpressionReference(sample.exactVoltage) || hasExpressionReference(sample.exactCurrent))) { return; }
    const quantity = part.kind === "capacitor" || part.kind === "inductor" ? "storedJoules" : "dissipatedJoules";
    return Array.from({ length: samples.length }, (_, index) => index).every((index) => {
      const sample = samples[index];
      return sample && energy.samples[index]?.[quantity] !== undefined &&
        matchingSample(energy.samples[index], sample, sample.parts[part.id], energy.precisionSnapshot === "real");
    }) ? energy.samples : undefined;
  } catch {
    // Optional derived metadata never prevents the exact-reading fallback.
  }
}
