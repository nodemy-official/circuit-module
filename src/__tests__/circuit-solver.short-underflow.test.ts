import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";

function loop(voltageVolts: number, internalResistanceOhms: number, resistanceOhms: number): CircuitDocument {
  return { title: "scale-independent short detection", parts: [
    { id: "source", kind: "battery", label: "S", x: 0, y: 0, voltageVolts, internalResistanceOhms },
    { id: "load", kind: "resistor", label: "R", x: 10, y: 0, resistanceOhms },
  ], wires: [
    { id: "positive", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
    { id: "negative", from: { partId: "source", terminal: "b" }, to: { partId: "load", terminal: "b" } },
  ] };
}

describe("short detection before display rounding", () => {
  it.each([1, 1e-320, Number.MIN_VALUE])("classifies the same external network at %s V", (voltage) => {
    // Independent series-network oracle, in micro-ohms: load + two 1 µΩ wires.
    for (const { loadOhms, loadMicroOhms } of [
      { loadOhms: 0.1, loadMicroOhms: 100_000n },
      { loadOhms: 1e-6, loadMicroOhms: 1n },
    ]) {
      const expected = loadMicroOhms + 2n < 1000n ? "short" : "closed";
      for (const internalOhms of [1, 1e300]) {
        const result = analyzeCircuit(loop(voltage, internalOhms, loadOhms));
        expect(result.status, result.message).toBe(expected);
      }
    }
  });

  it("detects a short even when both displayed terminal voltage and current round to zero", () => {
    const result = analyzeCircuit(loop(Number.MIN_VALUE, 1e300, 1e-6));
    expect(result.parts.source.voltageVolts).toBe(0);
    expect(result.parts.source.currentAmps).toBe(0);
    expect(result.status).toBe("short");
  });
});
