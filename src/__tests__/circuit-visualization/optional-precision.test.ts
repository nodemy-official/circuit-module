import { expect, it } from "vitest";

import { restoredComplex, retainedComplexIsNonzero, type CircuitExactComplex } from "../../circuit-reading.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

function unreadablePrecision(field: "projection" | "real" | "imaginary" | "projected-real" | "magnitudeNormalizationSquared" | "normalizedFraction") {
  const precision: CircuitExactComplex = {
    real: { numerator: "1", denominator: "3" },
    imaginary: { numerator: "0", denominator: "1" },
  };
  const unavailable = { get() { throw new Error("Unavailable optional precision"); } };
  if (field === "projected-real") {
    precision.projection = { real: 0, magnitude: 0, phaseDegrees: 0 };
    Object.defineProperty(precision.projection, "real", unavailable);
  } else {
    Object.defineProperty(precision, field, unavailable);
  }
  return precision;
}

it.each(["projection", "projected-real"] as const)("falls back to scalar potential when the %s metadata cannot be read", (field) => {
  const document = createCircuitFromSpecs([
    ["source", "battery", ["v", "g"], { voltageVolts: 5 }],
    ["ground", "ground", ["g"]],
  ]);
  const analysis = analyzeCircuit(document);
  analysis.parts.source!.exactVoltage = unreadablePrecision(field);
  const nodes = circuitNodes(document, analysis);
  const from = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "source" && endpoint.terminal === "a"));
  const reference = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "ground"));
  expect(circuitPotential(from, reference, false, { document, analysis, nodes })?.volts).toBe(5);
});

it.each(["projection", "projected-real", "real", "imaginary", "magnitudeNormalizationSquared", "normalizedFraction"] as const)("keeps an unexcited frame idle when optional %s metadata cannot be read", (field) => {
  const document = createCircuitFromSpecs([
    ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
    ["r", "resistor", ["v", "g"], { resistanceOhms: 1 }],
  ]);
  const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  expect(analysis.status, analysis.message).toBe("valid");
  analysis.samples[1]!.parts.c!.exactVoltage = unreadablePrecision(field);
  expect(analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })?.status).toBe("idle");
});

const optionalFields = ["exactVoltage", "exactTerminalVoltages", "exactTerminalCurrents", "precisionExpressions", "terminal-voltage", "terminal-current"] as const;
const unavailable = { configurable: true, get() { throw new Error("Unavailable optional precision"); } };

it.each(optionalFields)("uses scalar nodes and potentials when the %s field cannot be read", (field) => {
  const document = createCircuitFromSpecs([
    ["source", "battery", ["v", "g"], { voltageVolts: 5 }],
    ["ground", "ground", ["g"]],
  ]);
  const analysis = analyzeCircuit(document);
  const reading = analysis.parts.source!;
  if (field === "precisionExpressions") {
    Object.defineProperty(analysis, field, unavailable);
  } else if (field === "terminal-current" || field === "terminal-voltage") {
    const terminals = {};
    Object.defineProperty(terminals, "a", unavailable);
    reading[field === "terminal-current" ? "exactTerminalCurrents" : "exactTerminalVoltages"] = terminals;
  } else {
    Object.defineProperty(reading, field, unavailable);
  }
  const nodes = circuitNodes(document, analysis);
  const from = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "source" && endpoint.terminal === "a"));
  const reference = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "ground"));
  expect(from?.voltageVolts).toBe(5);
  expect(from?.currentResidualAmps).toBe(0);
  expect(circuitPotential(from, reference, false, { document, analysis, nodes })?.volts).toBe(5);
});

it.each(["exactVoltage", "precisionExpressions"] as const)("drops a cached precise path while its %s field is unreadable", (field) => {
  const document = createCircuitFromSpecs([
    ["positive", "battery", ["v", "middle"], { voltageVolts: 1e20 }],
    ["negative", "battery", ["g", "middle"], { voltageVolts: 1e20 }],
    ["ground", "ground", ["g"]],
  ]);
  const analysis = analyzeCircuit(document);
  analysis.parts.positive!.exactVoltage = {
    real: { expression: 0, sign: 1 }, imaginary: { numerator: "0", denominator: "1" },
  };
  analysis.precisionExpressions = [{ operation: "literal", numerator: "100000000000000000001", denominator: "1" }];
  const nodes = circuitNodes(document, analysis);
  const from = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "positive" && endpoint.terminal === "a"));
  const reference = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "ground"));
  const context = { document, analysis, nodes };
  const potential = () => circuitPotential(from, reference, false, context)?.volts;
  expect(potential()).toBe(1);
  const owner = field === "exactVoltage" ? analysis.parts.positive! : analysis;
  const descriptor = Object.getOwnPropertyDescriptor(owner, field)!;
  Object.defineProperty(owner, field, unavailable);
  expect(potential()).toBe(0);
  Object.defineProperty(owner, field, descriptor);
  expect(potential()).toBe(1);
});

it.each(["exactVoltage", "projection", "expression-literal"] as const)("does not cache a scalar path after a temporary %s read failure", (field) => {
  const document = createCircuitFromSpecs([
    ["positive", "battery", ["v", "middle"], { voltageVolts: 1e20 }],
    ["negative", "battery", ["g", "middle"], { voltageVolts: 1e20 }],
    ["ground", "ground", ["g"]],
  ]);
  const analysis = analyzeCircuit(document);
  const exact: CircuitExactComplex = {
    real: { expression: 0, sign: 1 }, imaginary: { numerator: "0", denominator: "1" },
    projection: { real: 1e20, magnitude: 1e20, phaseDegrees: 0 },
  };
  const literal = { operation: "literal" as const, numerator: "100000000000000000001", denominator: "1" };
  analysis.parts.positive!.exactVoltage = exact;
  analysis.precisionExpressions = [literal];
  const nodes = circuitNodes(document, analysis);
  const from = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "positive" && endpoint.terminal === "a"));
  const reference = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "ground"));
  const context = { document, analysis, nodes };
  const owner = field === "exactVoltage" ? analysis.parts.positive! : field === "projection" ? exact : literal;
  const property = field === "expression-literal" ? "numerator" : field;
  const value = Reflect.get(owner, property);
  let reads = 0;
  Object.defineProperty(owner, property, {
    configurable: true,
    get() {
      reads += 1;
      // The context snapshot succeeds; only the graph's restoration fails.
      if (reads === 2) { throw new Error("Temporary precision failure"); }
      return value;
    },
  });
  expect(circuitPotential(from, reference, false, context)?.volts).toBe(0);
  expect(circuitPotential(from, reference, false, context)?.volts).toBe(1);
  expect(circuitPotential(from, reference, false, context)?.volts).toBe(1);
});

it.each(optionalFields.flatMap((field) => [false, true].map((enumerable) => ({ field, enumerable }))))(
  "keeps scalar transient readings with unreadable $field (enumerable: $enumerable)",
  ({ field, enumerable }) => {
    const document = createCircuitFromSpecs([
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
      ["r", "resistor", ["v", "g"], { resistanceOhms: 1 }],
    ]);
    const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
    const reading = analysis.samples[1]!.parts.c!;
    const descriptor = { ...unavailable, enumerable };
    if (field === "precisionExpressions") {
      Object.defineProperty(analysis, field, descriptor);
    } else if (field === "terminal-current" || field === "terminal-voltage") {
      const terminals = {};
      Object.defineProperty(terminals, "a", descriptor);
      reading[field === "terminal-current" ? "exactTerminalCurrents" : "exactTerminalVoltages"] = terminals;
    } else {
      Object.defineProperty(reading, field, descriptor);
    }
    const frame = analysisAtTransientFrame(document, { analysis, sampleIndex: 1 });
    expect(frame?.status).toBe("idle");
    expect(frame?.parts.c).toMatchObject({ voltageVolts: 0, currentAmps: 0, powerWatts: 0 });
    expect(circuitNodes(document, frame!)).toHaveLength(2);
  },
);

it("keeps transient bulb brightness when optional voltage and current fields cannot be read", () => {
  const document = createCircuitFromSpecs([
    ["source", "battery", ["v", "g"], { voltageVolts: 1 }],
    ["bulb", "bulb", ["v", "g"], { resistanceOhms: 1, ratedPowerWatts: 2 }],
  ]);
  const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  const reading = analysis.samples[1]!.parts.bulb!;
  Object.defineProperty(reading, "exactVoltage", { ...unavailable, enumerable: true });
  Object.defineProperty(reading, "exactTerminalCurrents", { ...unavailable, enumerable: true });
  expect(analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })?.parts.bulb?.brightness).toBe(0.5);
});

it("does not hide an unreadable ordinary transient voltage", () => {
  const document = createCircuitFromSpecs([["c", "capacitor", ["v", "g"], { initialVoltageVolts: 0 }]]);
  const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  Object.defineProperty(analysis.samples[1]!.parts.c!, "voltageVolts", unavailable);
  expect(() => analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })).toThrow("Unavailable optional precision");
});

const rational = (numerator: string, denominator = "1") => ({ numerator, denominator });
const tiny = rational("1", (2n ** 1200n).toString());
const term = (real: CircuitExactComplex["real"]) => ({ real, imaginary: rational("0"), magnitudeNormalizationSquared: rational("1") });

it.each([
  { name: "ordinary rational", precision: { real: tiny, imaginary: rational("0") }, active: true },
  { name: "negative ordinary rational", precision: { real: rational("-1", tiny.denominator), imaginary: rational("0") }, active: true },
  { name: "normalized rational", precision: { real: tiny, imaginary: rational("0"), magnitudeNormalizationSquared: rational("4") }, active: true },
  { name: "normalized fraction", precision: { real: tiny, imaginary: rational("0"), normalizedFraction: { numerator: [term(tiny)], denominator: [term(rational("1"))] } }, active: true },
  { name: "invalid imaginary denominator", precision: { real: tiny, imaginary: rational("0", "0") }, active: false },
  { name: "invalid normalization", precision: { real: tiny, imaginary: rational("0"), magnitudeNormalizationSquared: rational("1", "0") }, active: false },
  { name: "zero normalized denominator", precision: { real: tiny, imaginary: rational("0"), normalizedFraction: { numerator: [term(tiny)], denominator: [term(rational("0"))] } }, active: false },
  { name: "cancelled normalized numerator", precision: { real: tiny, imaginary: rational("0"), normalizedFraction: { numerator: [term(tiny), term(rational("-1", tiny.denominator))], denominator: [term(rational("1"))] } }, active: false },
])("uses validated $name metadata to distinguish an underflowed stored voltage from zero", ({ precision, active }) => {
  const document = createCircuitFromSpecs([
    ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
    ["r", "resistor", ["v", "g"], { resistanceOhms: 1 }],
  ]);
  const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  analysis.samples[1]!.parts.c!.exactVoltage = precision;
  expect(analysis.samples[1]!.parts.c!.voltageVolts).toBe(0);
  expect(analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })?.status).toBe(active ? "closed" : "idle");
});

it.each(["length", "constructor", "map"])("rejects the %s property as a captured expression index", (reference) => {
  const document = createCircuitFromSpecs([
    ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 1e-200 }],
    ["r", "resistor", ["v", "g"], { resistanceOhms: 2 }],
  ]);
  const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  expect(analysis.status).toBe("valid");
  expect(analysis.precisionExpressions!.length).toBeGreaterThan(0);
  const reading = analysis.samples[1]!.parts.c!;
  reading.voltageVolts = 0;
  reading.currentAmps = 0;
  reading.terminalCurrents = { a: 0, b: 0 };
  Reflect.deleteProperty(reading, "exactTerminalCurrents");
  const expression = { expression: 0, sign: 1 as const };
  Reflect.set(expression, "expression", reference);
  reading.exactVoltage = { real: expression, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading.exactVoltage, analysis.precisionExpressions)).toBeUndefined();
  expect(retainedComplexIsNonzero(reading.exactVoltage, analysis.precisionExpressions)).toBe(false);
  expect(analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })?.status).toBe("idle");
});
