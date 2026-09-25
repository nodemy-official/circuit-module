import { describe, expect, it } from "vitest";
import { createCircuitExample } from "./circuit-examples.js";
import { createExampleCircuit, type CircuitDocument } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential, defaultReferenceNode } from "./circuit-visualization.js";
import { simulateTransient } from "./transient-solver.js";

function nodeAt(nodes: ReturnType<typeof circuitNodes>, partId: string, terminal: string) {
  const node = nodes.find((item) => item.endpoints.some((endpoint) => endpoint.partId === partId && endpoint.terminal === terminal));
  if (!node) { throw new Error(`Missing node ${partId}:${terminal}`); }
  return node;
}

describe("learning quantities", () => {
  it("merges connected wires and measures legacy DC potentials from the selected reference", () => {
    const document = createExampleCircuit();
    const analysis = analyzeCircuit(document);
    const nodes = circuitNodes(document, analysis);
    const reference = defaultReferenceNode(document, nodes);
    expect(nodeAt(nodes, "part-1", "b")).toBe(nodeAt(nodes, "part-2", "a"));
    expect(circuitPotential(nodeAt(nodes, "part-1", "a"), reference, false)?.volts).toBeCloseTo(9, 5);
    expect(circuitPotential(nodeAt(nodes, "part-2", "a"), nodeAt(nodes, "part-2", "b"), false)?.volts).toBeCloseTo(analysis.parts["part-2"].voltageVolts, 5);
  });

  it("shows branch-current conservation without assigning currents to ideal wire loops", () => {
    const document: CircuitDocument = {
      title: "並列回路", parts: [
        { id: "s", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 10 },
        { id: "r1", kind: "resistor", label: "R1", x: 10, y: 0, resistanceOhms: 1000 },
        { id: "r2", kind: "resistor", label: "R2", x: 10, y: 10, resistanceOhms: 2000 },
        { id: "g", kind: "ground", label: "GND", x: 0, y: 10 },
      ], wires: [
        { id: "w1", from: { partId: "s", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
        { id: "w2", from: { partId: "r1", terminal: "a" }, to: { partId: "r2", terminal: "a" } },
        { id: "w3", from: { partId: "r2", terminal: "a" }, to: { partId: "s", terminal: "a" } },
        { id: "w4", from: { partId: "s", terminal: "b" }, to: { partId: "r1", terminal: "b" } },
        { id: "w5", from: { partId: "s", terminal: "b" }, to: { partId: "r2", terminal: "b" } },
        { id: "w6", from: { partId: "s", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      ],
    };
    const analysis = analyzeCircuit(document);
    const supplyNode = nodeAt(circuitNodes(document, analysis), "s", "a");
    expect(analysis.wireCurrents).toEqual({});
    expect(supplyNode.currents.map((entry) => entry.amps)).toEqual(expect.arrayContaining([expect.closeTo(-0.015, 8), expect.closeTo(0.01, 8), expect.closeTo(0.005, 8)]));
    expect(supplyNode.currentResidualAmps).toBeLessThan(1e-8);
  });

  it("subtracts AC phasors and sums currents with their phases", () => {
    const document = createCircuitExample("ac");
    const analysis = analyzeCircuit(document);
    const nodes = circuitNodes(document, analysis);
    const first = nodeAt(nodes, "resistor", "a");
    const second = nodeAt(nodes, "resistor", "b");
    const difference = circuitPotential(first, second, true);
    expect(difference?.volts).toBeCloseTo(analysis.parts.resistor.voltageVolts, 8);
    expect(difference?.phaseDegrees).toBeCloseTo(analysis.parts.resistor.voltagePhaseDegrees ?? 0, 8);
    expect(difference?.volts).not.toBeCloseTo((first.voltageVolts ?? 0) - (second.voltageVolts ?? 0), 2);
    for (const node of nodes) { expect(node.currentResidualAmps).toBeLessThan(1e-8); }
  });

  it("does not compare independently floating legacy islands", () => {
    const original = createExampleCircuit();
    const document: CircuitDocument = { ...original, parts: [...original.parts, { id: "floating", kind: "resistor", label: "孤立", x: 30, y: 5, resistanceOhms: 1000 }] };
    const nodes = circuitNodes(document, analyzeCircuit(document));
    expect(circuitPotential(nodeAt(nodes, "floating", "a"), defaultReferenceNode(document, nodes), false)).toBeNull();
  });

  it("does not imply a KCL violation at a simplified op-amp's omitted supply return", () => {
    const document = createCircuitExample("opamp");
    const nodes = circuitNodes(document, analyzeCircuit(document));
    const ground = nodeAt(nodes, "g1", "a");
    expect(ground.currentResidualAmps).toBeUndefined();
    expect(ground.currentBalanceNote).toContain("省略された電源端子");
    expect(nodeAt(nodes, "load", "a").currentResidualAmps).toBeLessThan(1e-8);
  });

  it("synchronizes RC terminal potentials, current conservation, and source power at each sampled instant", () => {
    const document = createCircuitExample("charging");
    const transient = simulateTransient(document, { durationSeconds: 0.005, timeStepSeconds: 0.000_05 });
    expect(transient.status).toBe("valid");
    const initial = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });
    const later = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 20 });
    if (!initial || !later) { throw new Error("Missing sampled analysis"); }
    expect(initial.parts.load.voltageVolts).toBeCloseTo(0, 8);
    expect(initial.parts.resistor.currentAmps).toBeCloseTo(0.005, 8);
    expect(later.parts.load.voltageVolts).toBeGreaterThan(3);
    expect(later.parts.resistor.currentAmps).toBeLessThan(0.002);
    expect(initial.parts.source.powerWatts).toBeCloseTo(0.025, 8);
    expect(later.timeSeconds).toBeCloseTo(0.001, 8);
    const nodes = circuitNodes(document, later);
    expect(circuitPotential(nodeAt(nodes, "load", "a"), defaultReferenceNode(document, nodes), false)?.volts).toBeCloseTo(later.parts.load.voltageVolts, 8);
    expect(nodeAt(nodes, "load", "a").currentResidualAmps).toBeLessThan(1e-8);
    expect(analysisAtTransientFrame(document, { analysis: transient, sampleIndex: -1 })).toBeNull();
  });
});
