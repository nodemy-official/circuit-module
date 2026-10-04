import type { CircuitDocument, CircuitPart } from "./circuit-model.js";
import type { CircuitExactComplex, CircuitExactNormalizedTerm, CircuitExactRational } from "./circuit-reading.js";
import { addExactRational, exactRationalToNumber, multiplyExactRational, numberToExactRational, subtractExactRational, type ExactRational } from "./exact-linear-algebra.js";
import { matchingExactExpressions, type ExactExpressionNode } from "./exact-expression.js";
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
}

export interface TransientPartEnergy {
  readonly kind: CircuitPart["kind"];
  readonly coefficient?: number;
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
  if (part.kind === "capacitor") { return part.capacitanceFarads ?? 1e-6; }
  if (part.kind === "inductor") { return part.inductanceHenries ?? 0.01; }
}

function snapshotComplex(value: CircuitExactComplex | undefined): CircuitExactComplex | undefined {
  if (!value) { return; }
  return { real: { ...value.real }, imaginary: { ...value.imaginary },
    ...(value.projection ? { projection: { ...value.projection } } : {}),
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

export function createTransientEnergyCollector(document: CircuitDocument) {
  const targets = document.parts.filter((part) => ["capacitor", "inductor", "resistor", "bulb"].includes(part.kind));
  const entries = Object.create(null) as Record<string, { kind: CircuitPart["kind"]; coefficient?: number; samples: TransientEnergySample[] }>;
  const states = new Map<string, EnergyState>();
  for (const part of targets) { entries[part.id] = { kind: part.kind, coefficient: coefficient(part), samples: [] }; }
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
          entry.samples.push({ ...basis, storedJoules: finiteProjection(energy) });
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
        entry.samples.push({ ...basis, dissipatedJoules: projected });
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

function matchingComplex(first: CircuitExactComplex | undefined, second: CircuitExactComplex | undefined): boolean {
  if (!first || !second) { return first === second; }
  return matchingRational(first.real, second.real) && matchingRational(first.imaginary, second.imaginary) &&
    matchingRational(first.magnitudeNormalizationSquared, second.magnitudeNormalizationSquared) &&
    matchingNormalizedFraction(first.normalizedFraction, second.normalizedFraction) &&
    first.projection?.real === second.projection?.real && first.projection?.magnitude === second.projection?.magnitude &&
    first.projection?.phaseDegrees === second.projection?.phaseDegrees;
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

function matchingSample(energy: TransientEnergySample | undefined, sample: TransientSample, reading: TransientPartReading | undefined): boolean {
  return Boolean(energy && reading && energy.timeSeconds === sample.timeSeconds && energy.voltageVolts === reading.voltageVolts &&
    energy.currentAmps === reading.currentAmps && energy.powerWatts === reading.powerWatts &&
    matchingComplex(energy.exactVoltage, reading.exactVoltage) && matchingComplex(energy.exactCurrent, reading.exactTerminalCurrents?.a) &&
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
        matchingSample(energy.samples[index], sample, sample.parts[part.id]);
    }) ? energy.samples : undefined;
  } catch {
    // Optional derived metadata never prevents the exact-reading fallback.
  }
}
