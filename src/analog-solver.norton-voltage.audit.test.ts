import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";

function part(id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...fields };
}

function circuit(kind: "capacitor" | "inductor", voltage: number, phaseDegrees: number): CircuitDocument {
  const frequencyHz = kind === "capacitor" ? 0.1 : 1e14;
  return {
    title: "Norton reactive voltage",
    parts: [
      part("source", "ac-source", { voltageVolts: voltage, frequencyHz, phaseDegrees }),
      part("load", kind, kind === "capacitor"
        ? { capacitanceFarads: Number.MIN_VALUE }
        : { inductanceHenries: 1e308 }),
      part("meter", "voltmeter"),
    ],
    wires: (["a", "b"] as const).flatMap((terminal) => ["load", "meter"].map((partId) => ({
      id: `${partId}-${terminal}`,
      from: { partId: "source", terminal },
      to: { partId, terminal },
    }))),
  };
}

describe.each(["capacitor", "inductor"] as const)("Norton %s voltage", (kind) => {
  it.each([0.1, 0.7, 1.4])("preserves %s V independently of rounded subnormal current", (voltage) => {
    for (const phase of [0, 37, 90, -145]) {
      const document = circuit(kind, voltage, phase);
      const analog = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(analog.status, analog.message).toBe("valid");
      const source = analog.parts.source!;
      const load = analog.parts.load!;
      expect(load.voltage.real).toBeCloseTo(source.voltage.real, 14);
      expect(load.voltage.imaginary).toBeCloseTo(source.voltage.imaginary, 14);
      expect(load.voltage).toEqual(analog.parts.meter!.voltage);
      expect(load.power.real).toBe(0);

      const analysis = analyzeCircuit(document, {}, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe("closed");
      expect(analysis.parts.load!.voltageVolts).toBeCloseTo(voltage, 14);
      expect(analysis.parts.load!.voltagePhaseDegrees).toBeCloseTo(phase, 12);
    }
  });
});
