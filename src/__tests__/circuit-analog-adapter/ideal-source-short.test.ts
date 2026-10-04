import { describe, expect, it } from "vitest";

import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const analyzers = [
  { name: "analyzeCircuit", analyze: analyzeCircuit },
  { name: "analyzeExtendedCircuit", analyze: analyzeExtendedCircuit },
];

function circuit(paths: readonly CircuitSpec[]) {
  return createCircuitFromSpecs([
    ["supply", "battery", ["positive", "negative"], { voltageVolts: 1, internalResistanceOhms: 1 }],
    ...paths,
    ["ground", "ground", ["negative"]],
  ], "Ideal source return");
}

describe.each(analyzers)("$name ideal voltage return diagnostics", ({ analyze }) => {
  it.each([0, 5])("recognizes an AC source with zero DC offset as a short (RMS=%s)", (voltageVolts) => {
    const result = analyze(circuit([
      ["return", "ac-source", ["positive", "negative"], { voltageVolts, offsetVolts: 0 }],
    ]), {}, { mode: "dc" });
    expect(result.status).toBe("short");
    expect(result.parts.supply!.voltageVolts).toBe(0);
    expect(result.parts.supply!.currentAmps).toBe(-1);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "error", partId: "supply" }));
  });

  it("recognizes opposing ideal sources as a zero-voltage return", () => {
    const result = analyze(circuit([
      ["first", "battery", ["positive", "middle"], { voltageVolts: 5, internalResistanceOhms: 0 }],
      ["second", "battery", ["negative", "middle"], { voltageVolts: 5, internalResistanceOhms: 0 }],
    ]), {}, { mode: "dc" });
    expect(result.status).toBe("short");
    expect(result.parts.supply!.voltageVolts).toBe(0);
    expect(result.parts.supply!.currentAmps).toBe(-1);
    expect(result.parts.first!.powerWatts + result.parts.second!.powerWatts).toBe(0);
  });

  it.each([Number.MIN_VALUE, 0.5, 2])("keeps a nonzero ideal return voltage distinct from a short (%s V)", (offsetVolts) => {
    const result = analyze(circuit([
      ["return", "ac-source", ["positive", "negative"], { voltageVolts: 0, offsetVolts }],
    ]), {}, { mode: "dc" });
    expect(result.status).toBe("closed");
    expect(result.parts.supply!.voltageVolts).toBe(offsetVolts);
    expect(result.parts.supply!.currentAmps).toBe(offsetVolts - 1);
    expect(result.issues.some(({ severity }) => severity === "error")).toBe(false);
  });

  it("keeps a finite resistance in the return path", () => {
    const result = analyze(circuit([
      ["return", "ac-source", ["positive", "middle"], { voltageVolts: 0, offsetVolts: 0 }],
      ["resistance", "resistor", ["middle", "negative"], { resistanceOhms: 1 }],
    ]), {}, { mode: "dc" });
    expect(result.status).toBe("closed");
    expect(result.parts.supply!.voltageVolts).toBe(0.5);
    expect(result.parts.supply!.currentAmps).toBe(-0.5);
  });
});
