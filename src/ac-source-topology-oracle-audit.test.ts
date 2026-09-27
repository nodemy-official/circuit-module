import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

const phasor = (magnitude: number, phaseDegrees: number) => {
  const angle = phaseDegrees * Math.PI / 180;
  return { real: magnitude * Math.cos(angle), imaginary: magnitude * Math.sin(angle) };
};

function parallelSourcesDocument(secondPhaseDegrees: number, reversed = false): CircuitDocument {
  const source2PositiveTerminal: CircuitTerminal = reversed ? "b" : "a";
  const source2NegativeTerminal: CircuitTerminal = reversed ? "a" : "b";
  return {
    title: "並列交流源の独立オラクル検査",
    parts: [
      part("source-1", "ac-source", { voltageVolts: 8, phaseDegrees: 37, frequencyHz: 50 }),
      part("source-2", "ac-source", { voltageVolts: 8, phaseDegrees: secondPhaseDegrees, frequencyHz: 50 }),
      part("load", "resistor", { resistanceOhms: 16 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("positive-sources", "source-1", "a", "source-2", source2PositiveTerminal),
      wire("negative-sources", "source-1", "b", "source-2", source2NegativeTerminal),
      wire("load-positive", "source-1", "a", "load", "a"),
      wire("load-negative", "source-1", "b", "load", "b"),
      wire("ground", "source-1", "b", "ground", "a"),
    ],
  };
}

describe("AC ideal-source topology against a phasor oracle", () => {
  it.each([
    { name: "same orientation", phase: 37, reversed: false },
    { name: "reversed orientation with matching polarity", phase: -143, reversed: true },
    { name: "phase wrapped by 360 degrees", phase: 397, reversed: false },
  ])("solves compatible parallel sources with $name", ({ phase, reversed }) => {
    const document = parallelSourcesDocument(phase, reversed);
    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const expectedVoltage = phasor(8, 37);
    const expectedCurrent = { real: expectedVoltage.real / 16, imaginary: expectedVoltage.imaginary / 16 };

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.load.voltageVolts).toBeCloseTo(8, 10);
    expect(result.parts.load.voltagePhaseDegrees).toBeCloseTo(37, 9);
    expect(result.parts.load.currentAmps).toBeCloseTo(0.5, 10);
    expect(result.parts.load.currentPhaseDegrees).toBeCloseTo(37, 9);
    expect(result.parts["source-1"].voltageVolts).toBeCloseTo(8, 10);
    expect(result.parts["source-2"].voltageVolts).toBeCloseTo(8, 10);
    expect(result.parts["source-1"].currentAmps).toBeCloseTo(0.5, 10);
    expect(result.parts["source-2"].currentAmps).toBe(0);

    const totalDeliveredCurrent = [result.parts["source-1"], result.parts["source-2"]]
      .reduce((sum, source) => {
        const reading = source!;
        return {
          real: sum.real - reading.currentAmps * Math.cos(reading.currentPhaseDegrees * Math.PI / 180),
          imaginary: sum.imaginary - reading.currentAmps * Math.sin(reading.currentPhaseDegrees * Math.PI / 180),
        };
      }, { real: 0, imaginary: 0 });
    expect(totalDeliveredCurrent.real).toBeCloseTo(expectedCurrent.real, 9);
    expect(totalDeliveredCurrent.imaginary).toBeCloseTo(expectedCurrent.imaginary, 9);
  });

  it("rejects incompatible ideal sources connected in parallel", () => {
    const document = parallelSourcesDocument(90);
    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  it("keeps the physical load phasor when GND moves between nodes", () => {
    const document = parallelSourcesDocument(37);
    const original = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const moved = analyzeCircuit({
      ...document,
      wires: document.wires.map((connection) => connection.id === "ground"
        ? wire("ground", "load", "a", "ground", "a")
        : connection),
    }, {}, { mode: "ac", frequencyHz: 50 });

    expect(original.status, original.message).toBe("closed");
    expect(moved.status, moved.message).toBe("closed");
    expect(moved.parts.load.voltageVolts).toBeCloseTo(original.parts.load.voltageVolts, 10);
    expect(moved.parts.load.voltagePhaseDegrees).toBeCloseTo(original.parts.load.voltagePhaseDegrees, 9);
  });
});
