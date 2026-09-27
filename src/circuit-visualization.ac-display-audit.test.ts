import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { circuitNodes, circuitPotential } from "./circuit-visualization.js";

describe("AC potential display precision audit", () => {
  it("does not invent a residual when two opposite large source phasors cancel", () => {
    const document: CircuitDocument = {
      title: "相殺する大きな交流電源",
      parts: [
        { id: "first", kind: "ac-source", label: "1つ目", x: 0, y: 0, voltageVolts: 1e16, phaseDegrees: 0, frequencyHz: 50 },
        { id: "second", kind: "ac-source", label: "2つ目", x: 1, y: 0, voltageVolts: 1e16, phaseDegrees: 180, frequencyHz: 50 },
      ],
      wires: [
        { id: "middle", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "a" } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const nodes = circuitNodes(document, analysis);
    const first = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "first" && endpoint.terminal === "a"));
    const last = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "second" && endpoint.terminal === "b"));
    const displayed = circuitPotential(first, last, true, { document, analysis, nodes });

    expect(analysis.parts.first.voltageVolts).toBe(1e16);
    expect(analysis.parts.second.voltageVolts).toBe(1e16);
    expect(displayed?.volts).toBeLessThan(1e-9);
  });

  it("preserves the small residual between large phasors near a quadrantal phase", () => {
    const phase = -90 + 1e-14;
    const document: CircuitDocument = {
      title: "直交位相の近くで差し引く交流電源",
      parts: [
        { id: "first", kind: "ac-source", label: "1つ目", x: 0, y: 0, voltageVolts: 1e16, phaseDegrees: 90, frequencyHz: 50 },
        { id: "second", kind: "ac-source", label: "2つ目", x: 1, y: 0, voltageVolts: 1e16, phaseDegrees: phase, frequencyHz: 50 },
      ],
      wires: [
        { id: "middle", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "a" } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const nodes = circuitNodes(document, analysis);
    const first = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "first" && endpoint.terminal === "a"));
    const last = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "second" && endpoint.terminal === "b"));
    const displayed = circuitPotential(first, last, true, { document, analysis, nodes });
    const expected = 1e16 * Math.sin(((phase + 90) * Math.PI) / 180);

    expect(displayed?.volts).toBeCloseTo(expected, 10);
  });
});
