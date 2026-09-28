import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitTerminal } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { circuitNodes, circuitPotential } from "./circuit-visualization.js";

function highResistanceCircuit(potentiometer: boolean): CircuitDocument {
  const lastTerminal = potentiometer ? "c" : "b";
  return {
    title: "大きな共通電位に重なる微小な直流電圧",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 9 },
      { id: "small", kind: potentiometer ? "potentiometer" : "resistor", label: "微小電圧", x: 0, y: 0, resistanceOhms: 1, wiperPosition: 0.25 },
      { id: "next", kind: "resistor", label: "次の抵抗", x: 0, y: 0, resistanceOhms: 2 },
      { id: "large", kind: "resistor", label: "大きな抵抗", x: 0, y: 0, resistanceOhms: 1e20 },
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "supply", from: { partId: "source", terminal: "a" }, to: { partId: "small", terminal: "a" } },
      { id: "middle", from: { partId: "small", terminal: lastTerminal }, to: { partId: "next", terminal: "a" } },
      { id: "load", from: { partId: "next", terminal: "b" }, to: { partId: "large", terminal: "a" } },
      { id: "return", from: { partId: "large", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      { id: "ground", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

describe("DC potential display precision", () => {
  it.each([false, true])("preserves signed small branch and path voltages (potentiometer=%s)", (potentiometer) => {
    const document = highResistanceCircuit(potentiometer);
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("closed");
    const nodes = circuitNodes(document, analysis);
    const context = { document, analysis, nodes };
    const node = (id: string, terminal: CircuitTerminal) => nodes.find((candidate) =>
      candidate.endpoints.some((endpoint) => endpoint.partId === id && endpoint.terminal === terminal));
    const start = node("small", "a");
    const middle = node("small", potentiometer ? "c" : "b");
    const end = node("next", "b");
    expect(start?.voltageVolts).toBe(middle?.voltageVolts);
    const expected = 9e-20 * (potentiometer ? 0.25 : 1);
    expect(circuitPotential(start, middle, false, context)!.volts / expected).toBeCloseTo(1, 12);
    expect(circuitPotential(middle, start, false, context)!.volts / expected).toBeCloseTo(-1, 12);
    expect(circuitPotential(start, end, false, context)!.volts / (expected + 18e-20)).toBeCloseTo(1, 12);
    expect(circuitPotential(end, start, false, context)!.volts / (expected + 18e-20)).toBeCloseTo(-1, 12);
  });
});
