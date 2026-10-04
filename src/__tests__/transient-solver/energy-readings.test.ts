import { expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import type { ExactExpressionNode } from "../../exact-expression.js";
import { createTransientEnergyCollector, matchingTransientEnergy } from "../../transient-energy.js";
import { simulateTransient } from "../../transient-solver.js";
import { assertCorrectRounding, rational } from "../helpers/numeric-oracle.js";

function rc(): CircuitDocument {
  return {
    title: "厳密なRCエネルギー",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 1 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1 },
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "r", terminal: "b" }, to: { partId: "c", terminal: "a" } },
      { id: "c", from: { partId: "c", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      { id: "g", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

it("retains maximum-length energy readouts with independently rounded RC energies after cloning", () => {
  const document = rc();
  const steps = 2000;
  const original = simulateTransient(document, { durationSeconds: steps / 1024, timeStepSeconds: 1 / 1024 });
  expect(original.status, original.message).toBe("valid");
  const json = JSON.stringify(original);
  // Includes an independent expression-table snapshot to detect mutable metadata.
  // Both the sampled values and their linear-size validation evidence stay compact.
  expect(json.length).toBeLessThan(12_000_000);
  for (const result of [original, JSON.parse(json) as typeof original, structuredClone(original)]) {
    const resistor = matchingTransientEnergy(document.parts[1]!, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions);
    const capacitor = matchingTransientEnergy(document.parts[2]!, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions);
    expect(resistor).toHaveLength(steps + 1);
    expect(capacitor).toHaveLength(steps + 1);
    for (const index of [0, 1, 1000, 2000]) {
      // I_n=(1024/1025)^n; V_C,n=1-I_n. Sum the geometric
      // trapezoid series with integer arithmetic, independent of production.
      const a = 1024n ** BigInt(index);
      const b = 1025n ** BigInt(index);
      const dissipated = rational((1024n ** 2n + 1025n ** 2n) * (b * b - a * a), 2048n * (1025n ** 2n - 1024n ** 2n) * b * b);
      const stored = rational((b - a) ** 2n, 2n * b * b);
      assertCorrectRounding(resistor![index]!.dissipatedJoules!, dissipated, `resistor at ${index}`);
      assertCorrectRounding(capacitor![index]!.storedJoules!, stored, `capacitor at ${index}`);
    }
  }
});

it.each(["time", "power", "voltage", "current", "exact", "projection", "coefficient", "missing", "negative"])("invalidates derived energy after %s edits", (field) => {
  const document = rc();
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
  const part = document.parts[2]!;
  expect(matchingTransientEnergy(part, result.samples, result.energyReadings)).toBeDefined();
  const sample = result.samples[1]!;
  const reading = sample.parts.c!;
  switch (field) {
    case "time": sample.timeSeconds = 0.25; break;
    case "power": reading.powerWatts = 7; break;
    case "voltage": reading.voltageVolts = 7; break;
    case "current": reading.currentAmps = 7; break;
    case "exact": reading.exactVoltage!.real = { numerator: "0x1", denominator: "0x2" }; break;
    case "projection": reading.exactVoltage!.projection!.real = 7; break;
    case "coefficient": part.capacitanceFarads = 7; break;
    case "missing": result.energyReadings = { c: { kind: "capacitor", coefficient: 1, samples: result.energyReadings!.c!.samples.map((entry) => ({ ...entry, storedJoules: undefined })) } }; break;
    case "negative": result.energyReadings = { c: { kind: "capacitor", coefficient: 1, samples: result.energyReadings!.c!.samples.map((entry) => ({ ...entry, storedJoules: -1 })) } }; break;
    default: throw new Error("Unknown energy edit");
  }
  expect(matchingTransientEnergy(part, result.samples, result.energyReadings)).toBeUndefined();
});

it("keeps a separate expression-table snapshot and invalidates derived energies after its source changes", () => {
  const document = rc();
  const original = simulateTransient(document, { durationSeconds: 1 / 16, timeStepSeconds: 1 / 1024 });
  for (const result of [JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    const part = document.parts[2]!;
    expect(matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions)).toBeDefined();
    const component = result.samples.at(-1)!.parts.c!.exactVoltage!.real;
    expect("expression" in component).toBe(true);
    if (!("expression" in component)) { throw new Error("Expected compact history"); }
    expect(result.energyPrecisionExpressions).not.toBe(result.precisionExpressions);
    result.precisionExpressions = result.precisionExpressions!.map((node, index) => index === component.expression
      ? { operation: "literal", numerator: "1", denominator: "3" } : node);
    expect(matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions)).toBeUndefined();
  }
});

it.each(["voltage", "current"])("invalidates derived energy after algebraic %s metadata is added", (field) => {
  const document = rc();
  const original = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    const part = document.parts[2]!;
    expect(matchingTransientEnergy(part, result.samples, result.energyReadings)).toBeDefined();
    const reading = result.samples[1]!.parts.c!;
    const value = field === "voltage" ? reading.exactVoltage! : reading.exactTerminalCurrents!.a!;
    // Replacing the algebraic representation changes the restored reading to
    // 1 even though its rounded scalar and rational-component fields stay put.
    const one = { numerator: "1", denominator: "1" };
    const zero = { numerator: "0", denominator: "1" };
    const term = { real: one, imaginary: zero, magnitudeNormalizationSquared: one };
    value.normalizedFraction = { numerator: [term], denominator: [term] };
    expect(matchingTransientEnergy(part, result.samples, result.energyReadings)).toBeUndefined();
  }
});

it("snapshots algebraic energy inputs deeply and detects later term edits", () => {
  const document = rc();
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
  const sample = result.samples[1]!;
  const reading = sample.parts.c!;
  const one = { numerator: "1", denominator: "1" };
  const zero = { numerator: "0", denominator: "1" };
  const term = { real: { numerator: "1", denominator: "3" }, imaginary: zero, magnitudeNormalizationSquared: one };
  reading.exactVoltage!.normalizedFraction = {
    numerator: [term], denominator: [{ real: one, imaginary: zero, magnitudeNormalizationSquared: one }],
  };
  const collector = createTransientEnergyCollector(document);
  collector.append(sample, new Map([["c", { numerator: 1n, denominator: 3n }]]), new Map(), new Map());
  const part = document.parts[2]!;
  expect(matchingTransientEnergy(part, [sample], collector.readings)).toBeDefined();
  expect(collector.readings.c!.samples[0]!.storedJoules).toBe(1 / 18);
  term.real.numerator = "2";
  expect(collector.readings.c!.samples[0]!.exactVoltage!.normalizedFraction!.numerator[0]!.real)
    .toEqual({ numerator: "1", denominator: "3" });
  expect(matchingTransientEnergy(part, [sample], collector.readings)).toBeUndefined();
});

it("requires the expression table for algebraic energy inputs", () => {
  const document = rc();
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
  const sample = result.samples[1]!;
  const one = { numerator: "1", denominator: "1" };
  const zero = { numerator: "0", denominator: "1" };
  sample.parts.c!.exactVoltage!.normalizedFraction = {
    numerator: [{ real: { expression: 0, sign: 1 }, imaginary: zero, magnitudeNormalizationSquared: one }],
    denominator: [{ real: one, imaginary: zero, magnitudeNormalizationSquared: one }],
  };
  const collector = createTransientEnergyCollector(document);
  collector.append(sample, new Map([["c", { numerator: 1n, denominator: 3n }]]), new Map(), new Map());
  const part = document.parts[2]!;
  const expressions: ExactExpressionNode[] = [{ operation: "literal", numerator: "1", denominator: "3" }];
  expect(matchingTransientEnergy(part, [sample], collector.readings, expressions, structuredClone(expressions))).toBeDefined();
  expect(matchingTransientEnergy(part, [sample], collector.readings)).toBeUndefined();
});

it.each(["numerator", "denominator", "iterator"] as const)("compares indexed algebraic data after a %s change", (side) => {
  const document = rc();
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
  const sample = result.samples[1]!;
  const one = { numerator: "1", denominator: "1" };
  const zero = { numerator: "0", denominator: "1" };
  const fraction = {
    numerator: [{ real: { numerator: "1", denominator: "3" }, imaginary: zero, magnitudeNormalizationSquared: one }],
    denominator: [{ real: one, imaginary: zero, magnitudeNormalizationSquared: one }],
  };
  sample.parts.c!.exactVoltage!.normalizedFraction = fraction;
  const collector = createTransientEnergyCollector(document);
  collector.append(sample, new Map([["c", { numerator: 1n, denominator: 3n }]]), new Map(), new Map());
  const part = document.parts[2]!;
  expect(matchingTransientEnergy(part, [sample], collector.readings)).toBeDefined();
  if (side === "iterator") {
    Reflect.set(fraction.numerator, Symbol.iterator, function* () {
      yield { ...fraction.numerator[0]!, real: { numerator: "2", denominator: "1" } };
    });
  } else { Reflect.set(fraction, side, { 0: fraction[side][0], length: 1 }); }
  if (side === "iterator") { expect(matchingTransientEnergy(part, [sample], collector.readings)).toBeDefined(); }
  else { expect(matchingTransientEnergy(part, [sample], collector.readings)).toBeUndefined(); }
});

it.each(["table", "arguments"])("invalidates computed energy when expression %s becomes an array-like object", (field) => {
  const document = rc();
  const result = simulateTransient(document, { durationSeconds: 1 / 16, timeStepSeconds: 1 / 1024 });
  const part = document.parts[2]!;
  expect(matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions)).toBeDefined();
  const table = structuredClone(result.precisionExpressions!);
  if (field === "table") {
    Reflect.set(result, "precisionExpressions", { ...table, length: table.length });
  } else {
    const node = table.find((candidate) => candidate.operation !== "literal")!;
    if (node.operation === "literal") { throw new Error("Expected operation"); }
    Reflect.set(node, "arguments", { ...node.arguments, length: node.arguments.length });
    result.precisionExpressions = table;
  }
  expect(matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions)).toBeUndefined();
});
