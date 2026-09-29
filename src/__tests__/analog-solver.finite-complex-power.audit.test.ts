import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (id: string, from: string, fromTerminal: "a" | "b", to: string, toTerminal: "a" | "b") => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("finite AC power after intermediate product overflow", () => {
  it.each([1, -1])("preserves finite power components in a series reactive load with sign %s", (reactiveSign) => {
    // V = (14 + j5) * 1e153 and Z = (171 + j140) / 221 imply
    // I = (14 - j5) * 1e153 and S = (171 + j140) * 1e306.
    // Conjugating V and Z gives the matching capacitive circuit.
    const frequencyHz = 1;
    const reactance = 140 / 221;
    const reactive = reactiveSign > 0
      ? part("reactive", "inductor", { inductanceHenries: reactance / (2 * Math.PI) })
      : part("reactive", "capacitor", { capacitanceFarads: 1 / (reactance * 2 * Math.PI) });
    const document: CircuitDocument = {
      title: "Finite active and reactive power near the numeric range limit",
      parts: [
        part("source", "ac-source", {
          voltageVolts: Math.hypot(1.4e154, 5e153),
          phaseDegrees: reactiveSign * Math.atan2(5, 14) * 180 / Math.PI,
          frequencyHz,
        }),
        part("resistor", "resistor", { resistanceOhms: 171 / 221 }),
        reactive,
      ],
      wires: [
        wire("s-r", "source", "a", "resistor", "a"),
        wire("r-x", "resistor", "b", "reactive", "a"),
        wire("x-s", "reactive", "b", "source", "b"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.parts.resistor!.current.real / 1.4e154).toBeCloseTo(1, 12);
    expect(analysis.parts.resistor!.current.imaginary / (-reactiveSign * 5e153)).toBeCloseTo(1, 12);
    expect(analysis.parts.resistor!.power.real / 1.71e308).toBeCloseTo(1, 12);
    expect(analysis.parts.reactive!.power.imaginary / (reactiveSign * 1.4e308)).toBeCloseTo(1, 12);
    expect(analysis.parts.source!.power.real / -1.71e308).toBeCloseTo(1, 12);
    expect(analysis.parts.source!.power.imaginary / (-reactiveSign * 1.4e308)).toBeCloseTo(1, 12);
  });
});
