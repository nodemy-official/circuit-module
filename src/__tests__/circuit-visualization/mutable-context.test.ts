import { expect, it } from "vitest";

import { analyzeCircuit } from "../../circuit-solver.js";
import { circuitNodes, circuitPotential, type CircuitPotentialContext } from "../../circuit-visualization.js";
import type { CircuitDocument } from "../../circuit-model.js";

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
