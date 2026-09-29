import { describe, expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { circuitNodes, circuitPotential } from "../circuit-visualization.js";

function sourceCircuit(phaseDegrees: number): CircuitDocument {
  return {
    title: "交流電位差の位相を表示まで保持する",
    parts: [
      { id: "source", kind: "ac-source", x: 0, y: 0, voltageVolts: 1e308, frequencyHz: 50, phaseDegrees },
      { id: "load", kind: "resistor", x: 0, y: 0, resistanceOhms: 1e308 },
      { id: "ground", kind: "ground", x: 0, y: 0 },
    ],
    wires: [
      { id: "positive", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "negative", from: { partId: "source", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      { id: "ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    ],
  };
}

describe("AC potential phase round trips", () => {
  it.each([Number.MIN_VALUE, -Number.MIN_VALUE])(
    "preserves the represented %s degree phase in direct and terminal potential displays",
    (phaseDegrees) => {
      const document = sourceCircuit(phaseDegrees);
      const analysis = analyzeCircuit(document, {}, { mode: "ac" });
      const nodes = circuitNodes(document, analysis);
      const positive = nodes.find((node) => node.endpoints.some((endpoint) =>
        endpoint.partId === "source" && endpoint.terminal === "a"));
      const negative = nodes.find((node) => node.endpoints.some((endpoint) =>
        endpoint.partId === "source" && endpoint.terminal === "b"));

      expect(analysis.status, analysis.message).toBe("closed");
      expect(analysis.parts.source.voltagePhaseDegrees).toBe(phaseDegrees);
      expect(circuitPotential(positive, negative, true, { document, analysis, nodes })?.phaseDegrees)
        .toBe(phaseDegrees);
      expect(circuitPotential(positive, negative, true)?.phaseDegrees).toBe(phaseDegrees);
    },
  );

  it("reverses the branch without rounding away its small quadrature component", () => {
    const phaseDegrees = 90.000_000_000_000_01;
    const document = sourceCircuit(phaseDegrees);
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    const nodes = circuitNodes(document, analysis);
    const positive = nodes.find((node) => node.endpoints.some((endpoint) =>
      endpoint.partId === "source" && endpoint.terminal === "a"));
    const negative = nodes.find((node) => node.endpoints.some((endpoint) =>
      endpoint.partId === "source" && endpoint.terminal === "b"));

    expect(analysis.status, analysis.message).toBe("closed");
    expect(circuitPotential(negative, positive, true, { document, analysis, nodes })?.phaseDegrees)
      .toBe(phaseDegrees - 180);
  });

  it.each([Number.MIN_VALUE, -Number.MIN_VALUE])(
    "retains the %s degree phase after summing a multi-branch voltage path",
    (phaseDegrees) => {
      const document: CircuitDocument = {
        title: "極小位相の直列交流電源",
        parts: [
          { id: "first", kind: "ac-source", x: 0, y: 0, voltageVolts: 1e307, frequencyHz: 50, phaseDegrees },
          { id: "second", kind: "ac-source", x: 0, y: 0, voltageVolts: 1e307, frequencyHz: 50, phaseDegrees },
          { id: "ground", kind: "ground", x: 0, y: 0 },
        ],
        wires: [
          { id: "series", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "a" } },
          { id: "ground", from: { partId: "second", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
        ],
      };
      const analysis = analyzeCircuit(document, {}, { mode: "ac" });
      const nodes = circuitNodes(document, analysis);
      const positive = nodes.find((node) => node.endpoints.some((endpoint) =>
        endpoint.partId === "first" && endpoint.terminal === "a"));
      const negative = nodes.find((node) => node.endpoints.some((endpoint) =>
        endpoint.partId === "second" && endpoint.terminal === "b"));

      expect(analysis.status, analysis.message).toBe("open");
      const potential = circuitPotential(positive, negative, true, { document, analysis, nodes });
      expect(potential?.volts).toBe(2e307);
      expect(potential?.phaseDegrees).toBe(phaseDegrees);
    },
  );
});
