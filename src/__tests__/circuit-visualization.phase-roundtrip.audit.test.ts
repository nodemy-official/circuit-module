import { describe, expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential } from "../circuit-visualization.js";
import { simulateTransient } from "../transient-solver.js";

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
  it("retains the legacy DC solver's branch values before summing a microvoltage path", () => {
    const document: CircuitDocument = {
      title: "Legacy DC branch precision",
      parts: [
        { id: "v", kind: "battery", label: "V", x: 0, y: 0, voltageVolts: 3, internalResistanceOhms: 0.1 },
        ...["first", "second", "load"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: id === "load" ? 2.2 : Number.MIN_VALUE })),
      ],
      wires: [
        { id: "vf", from: { partId: "v", terminal: "a" }, to: { partId: "first", terminal: "a" } },
        { id: "fs", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "a" } },
        { id: "sl", from: { partId: "second", terminal: "b" }, to: { partId: "load", terminal: "a" } },
        { id: "lv", from: { partId: "load", terminal: "b" }, to: { partId: "v", terminal: "b" } },
      ],
    };
    const original = analyzeCircuit(document);
    expect(original.status, original.message).toBe("closed");
    // Independent I=3/(.1+2.2+4u+2m). The completed part-voltage
    // path is 2m*I, about 2.609m, and rounds to 3m. Each drop rounds
    // to m. Wires retain their legacy resistance in the current calculation.
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const nodes = circuitNodes(document, analysis);
      const node = (id: string, terminal: "a" | "b") => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === id && endpoint.terminal === terminal));
      const context = { document, analysis, nodes };
      expect(circuitPotential(node("first", "a"), node("second", "b"), false, context)!.volts).toBe(3 * Number.MIN_VALUE);
    }
  });

  it.each([[6, 10], [1, 2]] as const)("rounds the completed microvoltage path once (%s-V source, %s-ohm load)", (voltageVolts, loadResistance) => {
    for (const mode of ["dc", "ac"] as const) {
      const document: CircuitDocument = {
        title: "Completed subnormal voltage path",
        parts: [
          { id: "v", kind: mode === "dc" ? "battery" : "ac-source", label: "V", x: 0, y: 0, voltageVolts, internalResistanceOhms: 0, frequencyHz: 50, phaseDegrees: 0 },
          ...["first", "second", "load"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: id === "load" ? loadResistance : Number.MIN_VALUE })),
          { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
        ],
        wires: [
          { id: "vf", from: { partId: "v", terminal: "a" }, to: { partId: "first", terminal: "a" } },
          { id: "fs", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "a" } },
          { id: "sl", from: { partId: "second", terminal: "b" }, to: { partId: "load", terminal: "a" } },
          { id: "lv", from: { partId: "load", terminal: "b" }, to: { partId: "v", terminal: "b" } },
          { id: "g", from: { partId: "g", terminal: "a" }, to: { partId: "v", terminal: "b" } },
        ],
      };
      const result = analyzeCircuit(document, {}, { mode });
      expect(result.status, result.message).toBe("closed");
      const analyses = [result];
      if (mode === "dc") {
        const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
        expect(transient.status, transient.message).toBe("valid");
        analyses.push(...transient.samples.map((_, sampleIndex) => analysisAtTransientFrame(document, { analysis: transient, sampleIndex })!));
      }
      for (const original of analyses) {
        for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
          const nodes = circuitNodes(document, analysis);
          const node = (id: string, terminal: "a" | "b") => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === id && endpoint.terminal === terminal));
          const start = node("first", "a");
          const end = node("second", "b");
          const context = { document, analysis, nodes };
          // Independent divider: 2*m*V/(R+2*m) rounds to m for both
          // 12*m/(10+2*m) and 2*m/(2+2*m). Individual drops round
          // to m or 0 respectively, so their rounded sum is incorrect.
          expect(circuitPotential(start, end, mode === "ac", context)!.volts).toBe(Number.MIN_VALUE);
          expect(circuitPotential(end, start, mode === "ac", context)!.volts).toBe(mode === "ac" ? Number.MIN_VALUE : -Number.MIN_VALUE);
          if (mode === "ac") { expect(circuitPotential(start, end, true, context)!.phaseDegrees).toBe(0); }
          if (voltageVolts === 6) {
            const retained = analysis.parts.first!.exactVoltage!.real;
            const originalNumerator = retained.numerator;
            retained.numerator = (2n * BigInt(originalNumerator)).toString();
            expect(circuitPotential(start, end, mode === "ac", context)!.volts).toBe(2 * Number.MIN_VALUE);
            retained.numerator = originalNumerator;
            expect(circuitPotential(start, end, mode === "ac", context)!.volts).toBe(Number.MIN_VALUE);
          }
        }
      }
    }
  });

  it("sums subnormal terminal currents before display rounding", () => {
    const document: CircuitDocument = {
      title: "Subnormal KCL",
      parts: [
        { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: 3 * Number.MIN_VALUE, frequencyHz: 50, phaseDegrees: 0 },
        ...["r1", "r2"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: 2 })),
      ],
      wires: [
        { id: "v1", from: { partId: "v", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
        { id: "v2", from: { partId: "v", terminal: "a" }, to: { partId: "r2", terminal: "a" } },
        { id: "1v", from: { partId: "r1", terminal: "b" }, to: { partId: "v", terminal: "b" } },
        { id: "2v", from: { partId: "r2", terminal: "b" }, to: { partId: "v", terminal: "b" } },
      ],
    };
    const original = analyzeCircuit(document, {}, { mode: "ac" });
    expect(original.status, original.message).toBe("closed");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      // Independent KCL: -3m + 3m/2 + 3m/2 = 0. Rounding each
      // current first instead gives -3m+2m+2m=m.
      for (const node of circuitNodes(document, analysis)) { expect(node.currentResidualAmps).toBe(0); }
    }
  });

  it.each([[Number.MIN_VALUE, 30], [2 * Number.MIN_VALUE, 45]] as const)(
    "preserves a %s-V branch and its %s-degree phase after cloning and path addition", (resistanceOhms, phaseDegrees) => {
      const document: CircuitDocument = {
        title: "Subnormal local AC voltage",
        parts: [
          { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50, phaseDegrees },
          ...["first", "second", "load"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: id === "load" ? 1 : resistanceOhms })),
          { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
        ],
        wires: [
          { id: "vf", from: { partId: "v", terminal: "a" }, to: { partId: "first", terminal: "a" } },
          { id: "fs", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "a" } },
          { id: "sl", from: { partId: "second", terminal: "b" }, to: { partId: "load", terminal: "a" } },
          { id: "lv", from: { partId: "load", terminal: "b" }, to: { partId: "v", terminal: "b" } },
          { id: "g", from: { partId: "g", terminal: "a" }, to: { partId: "v", terminal: "b" } },
        ],
      };
      const original = analyzeCircuit(document, {}, { mode: "ac" });
      expect(original.status, original.message).toBe("closed");
      // Independent series divider: each branch is Rs/(1+2Rs),
      // and the two-branch path is 2Rs/(1+2Rs), rounding to Rs and 2Rs.
      for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
        const nodes = circuitNodes(document, analysis);
        const node = (partId: string, terminal: "a" | "b") => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === partId && endpoint.terminal === terminal));
        const context = { document, analysis, nodes };
        const first = node("first", "a");
        const middle = node("first", "b");
        const end = node("second", "b");
        for (const [reference, expected] of [[middle, resistanceOhms], [end, 2 * resistanceOhms]] as const) {
          const forward = circuitPotential(first, reference, true, context)!;
          const reverse = circuitPotential(reference, first, true, context)!;
          expect(forward.volts).toBe(expected);
          expect(reverse.volts).toBe(expected);
          expect(forward.phaseDegrees).toBeCloseTo(phaseDegrees, 12);
          expect(reverse.phaseDegrees).toBeCloseTo(phaseDegrees - 180, 12);
        }
      }
    },
  );

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
