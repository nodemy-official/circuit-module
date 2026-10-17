import { expect, it } from "vitest";

import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { circuitNodes, circuitPotential, type CircuitPotentialContext } from "../../circuit-visualization.js";
import type { CircuitDocument } from "../../circuit-model.js";
import type { CircuitExactComplex, CircuitExactNormalizedTerm } from "../../circuit-reading.js";
import type { ExactExpressionNode } from "../../exact-expression.js";

const document: CircuitDocument = {
  title: "Mutable potential context",
  parts: [
    { id: "source", kind: "battery", x: 0, y: 0, voltageVolts: 10 },
    { id: "r1", kind: "resistor", x: 0, y: 0, resistanceOhms: 1 },
    { id: "r2", kind: "resistor", x: 0, y: 0, resistanceOhms: 1 },
    { id: "r3", kind: "resistor", x: 0, y: 0, resistanceOhms: 1 },
    { id: "ground", kind: "ground", x: 0, y: 0 },
  ],
  wires: [
    { id: "w0", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
    { id: "w2", from: { partId: "r1", terminal: "b" }, to: { partId: "r2", terminal: "a" } },
    { id: "w3", from: { partId: "r2", terminal: "b" }, to: { partId: "r3", terminal: "a" } },
    { id: "w4", from: { partId: "r3", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
  ],
};

function nodeAt(nodes: ReturnType<typeof circuitNodes>, partId: string, terminal: "a" | "b") {
  return nodes.find((node) => node.endpoints.some((endpoint) =>
    endpoint.partId === partId && endpoint.terminal === terminal,
  ));
}

it.each((["invalid", "short", "empty"] as const).flatMap((status) =>
  [false, true].map((ac) => ({ status, ac })),
))("discards old explicit nodes when a reused context becomes $status (AC: $ac)", ({ status, ac }) => {
  const sourceDocument: CircuitDocument = {
    title: "Updated analysis status",
    parts: [{ id: "source", kind: ac ? "ac-source" : "battery", x: 0, y: 0, voltageVolts: 5, frequencyHz: 50 }],
    wires: [],
  };
  const analysis = analyzeCircuit(sourceDocument);
  const nodes = circuitNodes(sourceDocument, analysis);
  const from = nodeAt(nodes, "source", "a");
  const reference = nodeAt(nodes, "source", "b");
  const context: CircuitPotentialContext = { document: sourceDocument, analysis, nodes };
  expect(circuitPotential(from, reference, ac, context)?.volts).toBe(5);

  analysis.status = status;

  expect(circuitNodes(sourceDocument, analysis)).toEqual([]);
  expect(circuitPotential(from, reference, ac, context)).toBeNull();
  // A caller may also retain node arguments while allowing the context to
  // build its own graph. That fallback must obey the current analysis status.
  Reflect.deleteProperty(context, "nodes");
  expect(circuitPotential(from, reference, ac, context)).toBeNull();
  for (const validStatus of ["open", "idle", "closed"] satisfies CircuitAnalysis["status"][]) {
    analysis.status = validStatus;
    expect(circuitPotential(from, reference, ac, context)?.volts).toBe(5);
  }
});

it("rebuilds cached precise paths when a reused context receives a new analysis", () => {
  const firstAnalysis = analyzeCircuit(document);
  const firstNodes = circuitNodes(document, firstAnalysis);
  const context: CircuitPotentialContext = { document, analysis: firstAnalysis, nodes: firstNodes };
  const firstPotential = circuitPotential(
    nodeAt(firstNodes, "r2", "a"),
    nodeAt(firstNodes, "ground", "a"),
    false,
    context,
  );

  const nextDocument: CircuitDocument = {
    ...document,
    parts: document.parts.map((part) => part.id === "r3" ? { ...part, resistanceOhms: 2 } : part),
  };
  const nextAnalysis = analyzeCircuit(nextDocument);
  const nextNodes = circuitNodes(nextDocument, nextAnalysis);
  context.document = nextDocument;
  context.analysis = nextAnalysis;
  context.nodes = nextNodes;

  const updatedPotential = circuitPotential(
    nodeAt(nextNodes, "r2", "a"),
    nodeAt(nextNodes, "ground", "a"),
    false,
    context,
  );

  expect(firstPotential?.volts).toBeCloseTo(20 / 3, 12);
  expect(updatedPotential?.volts).toBeCloseTo(7.5, 12);
});

it("invalidates precise paths when a terminal phasor changes in place", () => {
  const acDocument: CircuitDocument = {
    ...document,
    parts: document.parts.map((part) => part.id === "source"
      ? { ...part, kind: "ac-source", frequencyHz: 1000, phaseDegrees: 0 }
      : part),
  };
  const analysis = analyzeCircuit(acDocument, {}, { mode: "ac" });
  const nodes = circuitNodes(acDocument, analysis);
  const context: CircuitPotentialContext = { document: acDocument, analysis, nodes };
  const from = nodeAt(nodes, "r2", "a");
  const reference = nodeAt(nodes, "ground", "a");
  const initial = circuitPotential(from, reference, true, context);

  analysis.parts.r3!.voltagePhaseDegrees = 90;
  const updated = circuitPotential(from, reference, true, context);
  const expectedMagnitude = Math.hypot(analysis.parts.r2!.voltageVolts, analysis.parts.r3!.voltageVolts);

  expect(initial?.volts).toBeCloseTo(analysis.parts.r2!.voltageVolts + analysis.parts.r3!.voltageVolts, 12);
  expect(updated?.volts).toBeCloseTo(expectedMagnitude, 12);
  expect(updated?.phaseDegrees).toBeCloseTo(45, 10);
});

function cancellationContext(exactVoltage: CircuitExactComplex, precisionExpressions?: readonly ExactExpressionNode[]) {
  const cancellationDocument: CircuitDocument = {
    title: "Exact potential cancellation",
    parts: [
      { id: "positive", kind: "battery", label: "正方向電池", x: 0, y: 0, voltageVolts: 1e20 },
      { id: "negative", kind: "battery", label: "逆方向電池", x: 0, y: 0, voltageVolts: 1e20 },
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "series", from: { partId: "positive", terminal: "b" }, to: { partId: "negative", terminal: "b" } },
      { id: "reference", from: { partId: "negative", terminal: "a" }, to: { partId: "ground", terminal: "a" } },
    ],
  };
  const analysis = analyzeCircuit(cancellationDocument);
  analysis.parts.positive!.exactVoltage = exactVoltage;
  analysis.precisionExpressions = precisionExpressions;
  const nodes = circuitNodes(cancellationDocument, analysis);
  const context: CircuitPotentialContext = { document: cancellationDocument, analysis, nodes };
  const from = nodeAt(nodes, "positive", "a");
  const reference = nodeAt(nodes, "ground", "a");
  return { analysis, potential: () => circuitPotential(from, reference, false, context)?.volts };
}

const rational = (numerator: string) => ({ numerator, denominator: "1" });

it.each([false, true])("invalidates precise paths when a transported expression literal changes in place (shallow frozen table: %s)", (frozen) => {
  const literal = { operation: "literal" as const, numerator: "100000000000000000001", denominator: "1" };
  const table = frozen ? Object.freeze([literal]) : [literal];
  const { analysis, potential } = cancellationContext({ real: { expression: 0, sign: 1 }, imaginary: rational("0") }, table);
  expect(analysis.status, analysis.message).toBe("open");
  expect(potential()).toBe(1);
  literal.numerator = "100000000000000000002";
  expect(potential()).toBe(2);
});

it("invalidates precise paths when transported expression arguments change in place", () => {
  const sum = { operation: "sum" as const, arguments: [0, 1] };
  const expressions: ExactExpressionNode[] = [
    { operation: "literal", ...rational("100000000000000000000") },
    { operation: "literal", ...rational("1") },
    { operation: "literal", ...rational("2") },
    sum,
  ];
  const { analysis, potential } = cancellationContext({ real: { expression: 3, sign: 1 }, imaginary: rational("0") }, expressions);
  expect(analysis.status, analysis.message).toBe("open");
  expect(potential()).toBe(1);
  sum.arguments[1] = 2;
  expect(potential()).toBe(2);
});

it("invalidates precise paths when normalized fraction coefficients change in place", () => {
  const term: CircuitExactNormalizedTerm = {
    real: rational("100000000000000000001"), imaginary: rational("0"), magnitudeNormalizationSquared: rational("1"),
  };
  const { analysis, potential } = cancellationContext({
    real: rational("100000000000000000000"), imaginary: rational("0"),
    normalizedFraction: {
      numerator: [term],
      denominator: [{ real: rational("1"), imaginary: rational("0"), magnitudeNormalizationSquared: rational("1") }],
    },
  });
  expect(analysis.status, analysis.message).toBe("open");
  expect(potential()).toBe(1);
  term.real = rational("100000000000000000002");
  expect(potential()).toBe(2);
  if (!("numerator" in term.real)) { throw new Error("Expected a literal rational"); }
  term.real.numerator = "100000000000000000003";
  expect(potential()).toBe(3);
});

it("drops cached paths when optional normalized terms become unreadable", () => {
  const numerator = [{
    real: rational("100000000000000000001"), imaginary: rational("0"), magnitudeNormalizationSquared: rational("1"),
  }];
  const denominator = [{ real: rational("1"), imaginary: rational("0"), magnitudeNormalizationSquared: rational("1") }];
  const fraction = { numerator, denominator };
  const { analysis, potential } = cancellationContext({
    real: rational("100000000000000000000"), imaginary: rational("0"), normalizedFraction: fraction,
  });
  expect(analysis.status, analysis.message).toBe("open");
  expect(potential()).toBe(1);
  Object.defineProperty(fraction, "numerator", { configurable: true, get() { throw new Error("unavailable metadata"); } });
  expect(potential()).toBe(0);
  Object.defineProperty(fraction, "numerator", { configurable: true, value: numerator });
  expect(potential()).toBe(1);
});
