import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitTerminal } from "../../circuit-model.js";
import type { CircuitExactRational } from "../../circuit-reading.js";
import type { ExactExpressionNode } from "../../exact-expression.js";
import { matchingTransientEnergy } from "../../transient-energy.js";
import { simulateTransient, type TransientAnalysis } from "../../transient-solver.js";
import {
  addRational as add,
  assertCorrectRounding,
  compareRational,
  divideRational as div,
  multiplyRational as mul,
  negateRational as neg,
  rational,
  rationalFromNumber,
  subtractRational as sub,
  type Rational,
} from "../helpers/numeric-oracle.js";

// This audit imports no production arithmetic or DC/AC solver as its oracle.
// The shared test helper uses independent BigInt fractions and binary64 midpoints.
const zero = rational(0n);
const one = rational(1n);
const half = rational(1n, 2n);
const f = (value: number) => rationalFromNumber(value)!;
const square = (value: Rational) => mul(value, value);

function part(id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, a: CircuitTerminal, to: string, b: CircuitTerminal) {
  return { id, from: { partId: from, terminal: a }, to: { partId: to, terminal: b } };
}

function parallel(parts: CircuitPart[]): CircuitDocument {
  const first = parts[0]!;
  return {
    title: "Independent parallel transient audit",
    parts,
    wires: parts.slice(1).flatMap((item, index) => [
      wire(`a${index}`, first.id, "a", item.id, "a"),
      wire(`b${index}`, first.id, "b", item.id, "b"),
    ]),
  };
}

function seriesRlc(voltage = 3, resistance = 2, inductance = 4, capacitance = 0.5,
  initialVoltage = -1, initialCurrent = 0.25): CircuitDocument {
  return {
    title: "Independent series RLC audit",
    parts: [
      voltage === 0 ? part("s", "ac-source", { voltageVolts: 0, frequencyHz: 1 }) : part("s", "battery", { voltageVolts: voltage }),
      part("r", "resistor", { resistanceOhms: resistance }),
      part("l", "inductor", { inductanceHenries: inductance, initialCurrentAmps: initialCurrent }),
      part("c", "capacitor", { capacitanceFarads: capacitance, initialVoltageVolts: initialVoltage }),
    ],
    wires: [wire("sr", "s", "a", "r", "a"), wire("rl", "r", "b", "l", "a"),
      wire("lc", "l", "b", "c", "a"), wire("cs", "c", "b", "s", "b")],
  };
}

function parseInteger(value: string): bigint {
  return value.startsWith("-") ? -BigInt(value.slice(1)) : BigInt(value);
}

// Decode the transport format independently, including deferred histories.
function retained(value: CircuitExactRational | undefined, analysis: TransientAnalysis): Rational {
  if (!value) { throw new Error("Missing exact reading"); }
  if (!("expression" in value)) {
    return rational(parseInteger(value.numerator), parseInteger(value.denominator));
  }
  const table = analysis.precisionExpressions;
  if (!table) { throw new Error("Missing exact expression table"); }
  const memo = new Map<number, Rational>();
  const evaluate = (index: number): Rational => {
    const cached = memo.get(index);
    if (cached) { return cached; }
    const node: ExactExpressionNode | undefined = table[index];
    if (!node) { throw new Error("Missing expression node"); }
    let result: Rational;
    if (node.operation === "literal") {
      result = rational(parseInteger(node.numerator), parseInteger(node.denominator));
    } else {
      const args = node.arguments.map(evaluate);
      switch (node.operation) {
        case "sum": result = args.reduce(add, zero); break;
        case "add": result = add(args[0]!, args[1]!); break;
        case "subtract": result = sub(args[0]!, args[1]!); break;
        case "multiply": result = mul(args[0]!, args[1]!); break;
        case "divide": result = div(args[0]!, args[1]!); break;
        default: throw new Error("Unknown expression operation");
      }
    }
    memo.set(index, result);
    return result;
  };
  return evaluate(value.expression);
}

function exactEqual(actual: Rational, expected: Rational) {
  if (compareRational(actual, expected) !== 0) {
    throw new Error(`Exact mismatch: ${actual.numerator}/${actual.denominator} versus ${expected.numerator}/${expected.denominator}`);
  }
}

function assertProjection(actual: number, expected: Rational, label: string) {
  // Public complex readouts canonicalize underflowed zeros. Check the complete
  // rounding interval, including the sign of every nonzero projected value.
  assertCorrectRounding(actual === 0 && expected.numerator < 0n ? -0 : actual, expected, label);
}

function assertPart(analysis: TransientAnalysis, index: number, id: string, voltage: Rational, current: Rational) {
  const reading = analysis.samples[index]!.parts[id]!;
  assertProjection(reading.voltageVolts, voltage, `${id} voltage at ${index}`);
  assertProjection(reading.currentAmps, current, `${id} current at ${index}`);
  const power = mul(voltage, current);
  assertProjection(reading.powerWatts, power, `${id} power at ${index}`);
  exactEqual(reading.exactVoltage ? retained(reading.exactVoltage.real, analysis) : f(reading.voltageVolts), voltage);
  exactEqual(reading.exactTerminalCurrents?.a ? retained(reading.exactTerminalCurrents.a.real, analysis) : f(reading.currentAmps), current);
}

describe("transient device equations and energy conservation", () => {
  it.each([1, -1])("matches exact RC recurrence, signed terminals and trapezoid energy (polarity %s)", (polarity) => {
    const capacitance = f(0.5);
    const resistance = f(2);
    const document = parallel([
      part("c", "capacitor", { capacitanceFarads: 0.5, initialVoltageVolts: polarity }),
      part("r", "resistor", { resistanceOhms: 2 }),
    ]);
    const result = simulateTransient(document, { durationSeconds: 0.875, timeStepSeconds: 0.25 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map((sample) => sample.timeSeconds)).toEqual([0, 0.25, 0.5, 0.75, 0.875]);
    let voltage = f(polarity);
    let previousPower = div(square(voltage), resistance);
    let energy = zero;
    for (const [index, sample] of result.samples.entries()) {
      if (index > 0) {
        const h = f(sample.timeSeconds - result.samples[index - 1]!.timeSeconds);
        voltage = div(mul(mul(resistance, capacitance), voltage), add(mul(resistance, capacitance), h));
        const power = div(square(voltage), resistance);
        energy = add(energy, mul(mul(half, add(previousPower, power)), h));
        previousPower = power;
      }
      const current = div(voltage, resistance);
      assertPart(result, index, "r", voltage, current);
      assertPart(result, index, "c", voltage, neg(current));
      expect(sample.parts.c!.terminalCurrents!.b).toBe(-sample.parts.c!.currentAmps);
      assertCorrectRounding(result.energyReadings!.c!.samples[index]!.storedJoules!, mul(mul(half, capacitance), square(voltage)), "RC stored energy");
      assertCorrectRounding(result.energyReadings!.r!.samples[index]!.dissipatedJoules!, energy, "RC trapezoid energy");
    }
  });

  it.each([1, -1])("matches exact RL recurrence and stored energy (polarity %s)", (polarity) => {
    const inductance = f(2);
    const resistance = f(4);
    const document = parallel([
      part("l", "inductor", { inductanceHenries: 2, initialCurrentAmps: polarity }),
      part("r", "resistor", { resistanceOhms: 4 }),
    ]);
    const result = simulateTransient(document, { durationSeconds: 0.875, timeStepSeconds: 0.25 });
    expect(result.status, result.message).toBe("valid");
    let current = f(polarity);
    for (const [index, sample] of result.samples.entries()) {
      if (index > 0) {
        const h = f(sample.timeSeconds - result.samples[index - 1]!.timeSeconds);
        current = div(mul(inductance, current), add(inductance, mul(resistance, h)));
      }
      const voltage = neg(mul(resistance, current));
      assertPart(result, index, "l", voltage, current);
      assertPart(result, index, "r", voltage, neg(current));
      assertCorrectRounding(result.energyReadings!.l!.samples[index]!.storedJoules!, mul(mul(half, inductance), square(current)), "RL stored energy");
    }
  });

  it.each([3, 0])("matches the exact RLC recurrence and discrete energy conservation (source %s V)", (sourceVoltage) => {
    const document = seriesRlc(sourceVoltage);
    const result = simulateTransient(document, { durationSeconds: 0.875, timeStepSeconds: 0.25 });
    expect(result.status, result.message).toBe("valid");
    const inductance = f(4);
    const capacitance = f(0.5);
    const resistance = f(2);
    let voltage = f(-1);
    let current = f(0.25);
    for (const [index, sample] of result.samples.entries()) {
      const previousVoltage = voltage;
      const previousCurrent = current;
      if (index > 0) {
        const h = f(sample.timeSeconds - result.samples[index - 1]!.timeSeconds);
        // Independent elimination of L*(In-In-1)/h + R*In + Vn = Vs,
        // C*(Vn-Vn-1)/h = In, without production MNA coefficients.
        current = div(add(mul(inductance, current), mul(h, sub(f(sourceVoltage), voltage))),
          add(add(inductance, mul(h, resistance)), div(square(h), capacitance)));
        voltage = add(voltage, div(mul(h, current), capacitance));
        const storedChange = add(mul(mul(half, capacitance), sub(square(voltage), square(previousVoltage))),
          mul(mul(half, inductance), sub(square(current), square(previousCurrent))));
        const numericalDissipation = add(mul(mul(half, capacitance), square(sub(voltage, previousVoltage))),
          mul(mul(half, inductance), square(sub(current, previousCurrent))));
        const input = mul(mul(h, f(sourceVoltage)), current);
        const resistanceLoss = mul(mul(h, resistance), square(current));
        exactEqual(add(add(storedChange, resistanceLoss), numericalDissipation), input);
      }
      assertPart(result, index, "c", voltage, current);
      assertPart(result, index, "r", mul(resistance, current), current);
      assertPart(result, index, "l", sub(sub(f(sourceVoltage), voltage), mul(resistance, current)), current);
      assertPart(result, index, "s", f(sourceVoltage), neg(current));
    }
  });

  it("allocates initial voltages of series inductors by L and rejects conflicting initial current", () => {
    const document: CircuitDocument = {
      title: "Series inductor initial derivative audit",
      parts: [part("s", "battery", { voltageVolts: 9 }), part("l1", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0.5 }),
        part("l2", "inductor", { inductanceHenries: 2, initialCurrentAmps: 0.5 })],
      wires: [wire("sl", "s", "a", "l1", "a"), wire("ll", "l1", "b", "l2", "a"), wire("ls", "l2", "b", "s", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    assertPart(result, 0, "l1", f(3), f(0.5));
    assertPart(result, 0, "l2", f(6), f(0.5));
    assertPart(result, 1, "l1", f(3), f(0.875));
    document.parts[2]!.initialCurrentAmps = 0.25;
    expect(simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 }).status).toBe("invalid");
  });

  it("preserves reversed parallel capacitor initial conditions and checks C-proportional currents", () => {
    const document: CircuitDocument = {
      title: "Reversed parallel capacitors",
      parts: [part("s", "battery", { voltageVolts: 3 }), part("r", "resistor", { resistanceOhms: 2 }),
        part("c1", "capacitor", { capacitanceFarads: 1, initialVoltageVolts: 1 }),
        part("c2", "capacitor", { capacitanceFarads: 2, initialVoltageVolts: -1 })],
      wires: [wire("sr", "s", "a", "r", "a"), wire("rc", "r", "b", "c1", "a"), wire("cs", "c1", "b", "s", "b"),
        wire("aa", "c1", "a", "c2", "b"), wire("bb", "c1", "b", "c2", "a")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.25 });
    expect(result.status, result.message).toBe("valid");
    assertPart(result, 0, "c1", one, rational(1n, 3n));
    assertPart(result, 0, "c2", neg(one), rational(-2n, 3n));
    document.parts[3]!.initialVoltageVolts = 1;
    expect(simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.25 }).status).toBe("invalid");
  });

  it("uses exact operating-point state in an AC-start RC and RL network", () => {
    const document: CircuitDocument = {
      title: "AC start from independent DC oracle",
      parts: [part("s", "ac-source", { voltageVolts: 1, offsetVolts: 3, frequencyHz: 1, phaseDegrees: 90 }),
        part("rc", "resistor", { resistanceOhms: 7 }), part("c", "capacitor", { capacitanceFarads: 1, initialVoltageVolts: 99 }),
        part("rl", "resistor", { resistanceOhms: 7 }), part("l", "inductor", { inductanceHenries: 1, initialCurrentAmps: 99 })],
      wires: [wire("src", "s", "a", "rc", "a"), wire("rcc", "rc", "b", "c", "a"), wire("cs", "c", "b", "s", "b"),
        wire("srl", "s", "a", "rl", "a"), wire("rll", "rl", "b", "l", "a"), wire("ls", "l", "b", "s", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.5, timeStepSeconds: 0.5, startFromOperatingPoint: true });
    expect(result.status, result.message).toBe("valid");
    assertPart(result, 0, "c", f(3), zero);
    assertPart(result, 0, "l", zero, rational(3n, 7n));
    assertPart(result, 1, "c", f(3), zero);
    assertPart(result, 1, "l", zero, rational(3n, 7n));
  });

  it("uses the duration for a single shortened interval and keeps an exact final time", () => {
    const result = simulateTransient(seriesRlc(), { durationSeconds: 0.125, timeStepSeconds: 1 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map((sample) => sample.timeSeconds)).toEqual([0, 0.125]);
    assertPart(result, 1, "c", rational(-125n, 137n), rational(48n, 137n));
  });

  it("retains hidden RC state and energies after JSON and structured cloning", () => {
    const capacitance = rational(1n, 2n ** 1000n);
    const document = parallel([
      part("c", "capacitor", { capacitanceFarads: 2 ** -1000, initialVoltageVolts: 1 }),
      part("r", "resistor", { resistanceOhms: 1 }),
    ]);
    const original = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.25 });
    expect(original.status, original.message).toBe("valid");
    for (const result of [original, JSON.parse(JSON.stringify(original)) as TransientAnalysis, structuredClone(original)]) {
      expect(result.precisionExpressions?.length).toBeGreaterThan(0);
      let voltage = one;
      for (let index = 0; index < result.samples.length; index += 1) {
        if (index > 0) { voltage = mul(voltage, div(capacitance, add(capacitance, f(0.25)))); }
        assertPart(result, index, "c", voltage, neg(voltage));
        assertCorrectRounding(result.energyReadings!.c!.samples[index]!.storedJoules!, mul(mul(half, capacitance), square(voltage)), "hidden stored energy");
      }
      expect(result.samples[2]!.parts.c!.voltageVolts).toBe(0);
      expect(retained(result.samples[2]!.parts.c!.exactVoltage!.real, result).numerator).toBeGreaterThan(0n);
      expect(matchingTransientEnergy(document.parts[0]!, result.samples, result.energyReadings,
        result.precisionExpressions, result.energyPrecisionExpressions)).toHaveLength(result.samples.length);
    }
  });

  it.each(["resistor", "bulb"] as const)("accumulates individually underflowed %s energy intervals exactly", (kind) => {
    const document = parallel([
      part("s", "battery", { voltageVolts: 2 ** -500 }), part("r", kind, { resistanceOhms: 1 }),
    ]);
    const result = simulateTransient(document, { durationSeconds: 2 ** -73, timeStepSeconds: 2 ** -80 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(129);
    for (const [index, sample] of result.samples.entries()) {
      const energy = result.energyReadings!.r!.samples[index]!.dissipatedJoules!;
      assertCorrectRounding(energy, mul(f(2 ** -1000), f(sample.timeSeconds)), `cumulative energy ${index}`);
    }
    expect(result.energyReadings!.r!.samples[1]!.dissipatedJoules).toBe(0);
    expect(result.energyReadings!.r!.samples[128]!.dissipatedJoules).toBe(2 * Number.MIN_VALUE);
  });

  it("invalidates cumulative energies when a sampled input is edited after saving", () => {
    const document = parallel([part("c", "capacitor", { capacitanceFarads: 1, initialVoltageVolts: 1 }),
      part("r", "resistor", { resistanceOhms: 1 })]);
    const original = simulateTransient(document, { durationSeconds: 0.5, timeStepSeconds: 0.25 });
    expect(original.status, original.message).toBe("valid");
    const result: TransientAnalysis = JSON.parse(JSON.stringify(original));
    expect(matchingTransientEnergy(document.parts[1]!, result.samples, result.energyReadings,
      result.precisionExpressions, result.energyPrecisionExpressions)).toBeDefined();
    result.samples[1]!.parts.r!.powerWatts = 2;
    expect(matchingTransientEnergy(document.parts[1]!, result.samples, result.energyReadings,
      result.precisionExpressions, result.energyPrecisionExpressions)).toBeUndefined();
  });

  it.each(["nmos", "pmos"] as const)("crosses the %s cutoff boundary with an independent implicit square-law oracle", (kind) => {
    const sign = kind === "nmos" ? 1 : -1;
    const document: CircuitDocument = {
      title: "MOS capacitor implicit-step oracle",
      parts: [part("s", "ac-source", { voltageVolts: 0, offsetVolts: 4 * sign, frequencyHz: 1 }),
        part("r", "resistor", { resistanceOhms: 2 }), part("c", "capacitor", { capacitanceFarads: 0.5 }),
        part("m", kind, { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0 })],
      wires: [wire("sr", "s", "a", "r", "a"), wire("rc", "r", "b", "c", "a"), wire("cs", "c", "b", "s", "b"),
        wire("md", "m", "a", "c", "a"), wire("mg", "m", "b", "c", "a"), wire("ms", "m", "c", "c", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.875, timeStepSeconds: 0.25 });
    expect(result.status, result.message).toBe("valid");
    let previousVoltage = 0;
    for (let index = 1; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const h = sample.timeSeconds - result.samples[index - 1]!.timeSeconds;
      const residual = (candidate: number) => (4 - candidate) / 2 - Math.max(candidate - 1, 0) ** 2 - 0.5 * (candidate - previousVoltage) / h;
      let lo = 0;
      let hi = 4;
      for (let iteration = 0; iteration < 90; iteration += 1) {
        const middle = (lo + hi) / 2;
        if (residual(middle) > 0) { lo = middle; } else { hi = middle; }
      }
      const voltage = (lo + hi) / 2;
      const channelCurrent = Math.max(voltage - 1, 0) ** 2;
      expect(sample.parts.c!.voltageVolts * sign).toBeCloseTo(voltage, 10);
      expect(sample.parts.m!.currentAmps * sign).toBeCloseTo(channelCurrent, 10);
      expect(sample.parts.c!.currentAmps * sign).toBeCloseTo(0.5 * (voltage - previousVoltage) / h, 10);
      expect(sample.parts.m!.channelConducting).toBe(voltage > 1);
      expect(Math.abs(sample.parts.r!.currentAmps - sample.parts.c!.currentAmps - sample.parts.m!.currentAmps)).toBeLessThan(1e-10);
      previousVoltage = voltage;
    }
    expect(result.samples[1]!.parts.m!.channelConducting).toBe(false);
    expect(result.samples.at(-1)!.parts.m!.channelConducting).toBe(true);
  });

  it.each(["npn-transistor", "pnp-transistor"] as const)("checks %s capacitor charging with independent nested Ebers-Moll equations", (kind) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    const saturation = 1e-14;
    const beta = 100;
    const document: CircuitDocument = {
      title: "BJT with base capacitor oracle",
      parts: [part("s", "ac-source", { voltageVolts: 0, offsetVolts: sign, frequencyHz: 1 }),
        part("sc", "ac-source", { voltageVolts: 0, offsetVolts: 5 * sign, frequencyHz: 1 }),
        part("rb", "resistor", { resistanceOhms: 10_000 }), part("rc", "resistor", { resistanceOhms: 1000 }),
        part("c", "capacitor", { capacitanceFarads: 1e-6 }), part("m", kind, { saturationCurrentAmps: saturation, currentGain: beta })],
      wires: [wire("sr", "s", "a", "rb", "a"), wire("rb", "rb", "b", "m", "b"), wire("base-c", "c", "a", "m", "b"),
        wire("scr", "sc", "a", "rc", "a"), wire("rc", "rc", "b", "m", "a"), wire("cg", "c", "b", "s", "b"),
        wire("eg", "m", "c", "s", "b"), wire("sg", "sc", "b", "s", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.035, timeStepSeconds: 0.01 });
    expect(result.status, result.message).toBe("valid");
    const forwardCurrent = (base: number) => saturation * Math.expm1(base / 0.025_85);
    const reverseCurrent = (base: number, collector: number) => saturation * Math.expm1((base - collector) / 0.025_85);
    const collectorAt = (base: number) => {
      let lo = 0;
      let hi = 5;
      for (let iteration = 0; iteration < 90; iteration += 1) {
        const middle = (lo + hi) / 2;
        const collectorCurrent = forwardCurrent(base) - 2 * reverseCurrent(base, middle);
        if ((5 - middle) / 1000 - collectorCurrent > 0) { lo = middle; } else { hi = middle; }
      }
      return (lo + hi) / 2;
    };
    let previousBase = 0;
    for (let index = 0; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const h = index === 0 ? 1 : sample.timeSeconds - result.samples[index - 1]!.timeSeconds;
      let lo = 0;
      let hi = index === 0 ? 0 : 1;
      for (let iteration = 0; iteration < 90; iteration += 1) {
        const middle = (lo + hi) / 2;
        const collector = collectorAt(middle);
        const baseCurrent = forwardCurrent(middle) / beta + reverseCurrent(middle, collector);
        const residual = (1 - middle) / 10_000 - baseCurrent - 1e-6 * (middle - previousBase) / h;
        if (residual > 0) { lo = middle; } else { hi = middle; }
      }
      const base = (lo + hi) / 2;
      const collector = collectorAt(base);
      const baseCurrent = forwardCurrent(base) / beta + reverseCurrent(base, collector);
      const collectorCurrent = forwardCurrent(base) - 2 * reverseCurrent(base, collector);
      const readings = sample.parts.m!;
      expect(sample.parts.c!.voltageVolts * sign).toBeCloseTo(base, 10);
      expect(readings.voltageVolts * sign).toBeCloseTo(collector, 10);
      expect(readings.terminalCurrents!.a! * sign).toBeCloseTo(collectorCurrent, 12);
      expect(readings.terminalCurrents!.b! * sign).toBeCloseTo(baseCurrent, 12);
      expect(readings.terminalCurrents!.c! * sign).toBeCloseTo(-collectorCurrent - baseCurrent, 12);
      expect(Math.abs(sample.parts.rb!.currentAmps - readings.terminalCurrents!.b! - sample.parts.c!.currentAmps)).toBeLessThan(1e-12);
      expect(readings.powerWatts).toBeCloseTo(collector * collectorCurrent + base * baseCurrent, 11);
      previousBase = base;
    }
  });

  it("follows an independent op-amp RC implicit equation across output rail clipping", () => {
    const document: CircuitDocument = {
      title: "Op-amp output capacitor oracle",
      parts: [part("s", "battery", { voltageVolts: 2 }), part("m", "op-amp", { openLoopGain: 10, positiveRailVolts: 15, negativeRailVolts: -15 }),
        part("r", "resistor", { resistanceOhms: 100 }), part("c", "capacitor", { capacitanceFarads: 0.5 }), part("g", "ground")],
      wires: [wire("sm", "s", "a", "m", "a"), wire("sg", "s", "b", "g", "a"), wire("fb", "m", "c", "m", "b"),
        wire("mr", "m", "c", "r", "a"), wire("mc", "m", "c", "c", "a"), wire("rg", "r", "b", "g", "a"), wire("cg", "c", "b", "g", "a")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.875, timeStepSeconds: 0.25 });
    expect(result.status, result.message).toBe("valid");
    let previousVoltage = 0;
    for (let index = 1; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const h = sample.timeSeconds - result.samples[index - 1]!.timeSeconds;
      const target = (candidate: number) => Math.max(-15, Math.min(15, 10 * (2 - candidate)));
      const residual = (candidate: number) => (target(candidate) - candidate) / 20 - candidate / 100 - 0.5 * (candidate - previousVoltage) / h;
      let lo = 0;
      let hi = 2;
      for (let iteration = 0; iteration < 90; iteration += 1) {
        const middle = (lo + hi) / 2;
        if (residual(middle) > 0) { lo = middle; } else { hi = middle; }
      }
      const voltage = (lo + hi) / 2;
      expect(sample.parts.c!.voltageVolts).toBeCloseTo(voltage, 12);
      expect(sample.parts.m!.currentAmps).toBeCloseTo((voltage - target(voltage)) / 20, 12);
      expect(sample.parts.c!.currentAmps).toBeCloseTo(0.5 * (voltage - previousVoltage) / h, 12);
      expect(Math.abs(sample.parts.m!.currentAmps + sample.parts.r!.currentAmps + sample.parts.c!.currentAmps)).toBeLessThan(1e-12);
      previousVoltage = voltage;
    }
  });

  it.each(["diode", "led"] as const)("solves implicit %s RC states with an independent Shockley bisection", (kind) => {
    const saturation = kind === "led" ? 1e-20 : 1e-12;
    const emission = kind === "led" ? 2 : 1;
    const document: CircuitDocument = {
      title: "Independent nonlinear capacitor audit",
      parts: [part("s", "ac-source", { voltageVolts: 2, frequencyHz: 2, phaseDegrees: 90, offsetVolts: 1 }),
        part("r", "resistor", { resistanceOhms: 100 }), part("c", "capacitor", { capacitanceFarads: 1 / 1024 }),
        part("d", kind, { saturationCurrentAmps: saturation, emissionCoefficient: emission })],
      wires: [wire("sr", "s", "a", "r", "a"), wire("rc", "r", "b", "c", "a"), wire("cs", "c", "b", "s", "b"),
        wire("da", "d", "a", "c", "a"), wire("db", "d", "b", "c", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.218_75, timeStepSeconds: 0.0625 });
    expect(result.status, result.message).toBe("valid");
    let previous = 0;
    for (let index = 1; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const h = sample.timeSeconds - result.samples[index - 1]!.timeSeconds;
      const source = 1 - 2 * Math.SQRT2 * Math.sin(4 * Math.PI * sample.timeSeconds);
      const residual = (candidate: number) => (source - candidate) / 100 - saturation * Math.expm1(candidate / (emission * 0.025_85)) - (candidate - previous) / (1024 * h);
      let lo = Math.min(previous, source) - 1;
      let hi = Math.max(previous, source) + 1;
      for (let iteration = 0; iteration < 90; iteration += 1) {
        const middle = (lo + hi) / 2;
        if (residual(middle) > 0) { lo = middle; } else { hi = middle; }
      }
      const v = (lo + hi) / 2;
      const expectedDiodeCurrent = saturation * Math.expm1(v / (emission * 0.025_85));
      expect(sample.parts.c!.voltageVolts).toBeCloseTo(v, 10);
      expect(sample.parts.c!.currentAmps).toBeCloseTo((v - previous) / (1024 * h), 12);
      if (expectedDiodeCurrent !== 0) {
        expect(sample.parts.d!.currentAmps / expectedDiodeCurrent).toBeCloseTo(1, 7);
      }
      expect(Math.abs(sample.parts.r!.currentAmps - sample.parts.c!.currentAmps - sample.parts.d!.currentAmps)).toBeLessThan(1e-12);
      previous = v;
    }
  });

  it.each([false, true])("rejects parallel AC sources whose initial voltage slopes conflict (reverse order %s)", (reverseOrder) => {
    const sources = [part("rising", "ac-source", { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 270 }),
      part("falling", "ac-source", { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 90 })];
    const document = parallel([...(reverseOrder ? sources.reverse() : sources), part("c", "capacitor", { capacitanceFarads: 1, initialVoltageVolts: 0 })]);
    // Both source voltages are exactly zero at all requested samples (0, 1/2, 1).
    // But at t=0 differentiated KVL requires both dV/dt=+sqrt(2)*2*pi and
    // dV/dt=-sqrt(2)*2*pi on the same two nodes. No initial state exists.
    const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
    expect(result.status, JSON.stringify({ message: result.message,
      currents: result.samples.map((sample) => sample.parts.c?.currentAmps) })).toBe("invalid");
  });
});
