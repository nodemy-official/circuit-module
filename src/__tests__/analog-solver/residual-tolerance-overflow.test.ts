import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

describe("analog solver relative residual tolerance overflow audit", () => {
  it("converges for a finite extreme source voltage across a maximum-value resistor", () => {
    const sourceVoltage = Math.SQRT2 * 1e308;
    const document: CircuitDocument = {
      title: "有限な巨大電圧と最大抵抗",
      parts: [
        part("source", "ac-source", { voltageVolts: 1e308, frequencyHz: 1000 }),
        part("load", "resistor", { resistanceOhms: Number.MAX_VALUE }),
      ],
      wires: [
        {
          id: "positive",
          from: { partId: "source", terminal: "a" },
          to: { partId: "load", terminal: "a" },
        },
        {
          id: "return",
          from: { partId: "source", terminal: "b" },
          to: { partId: "load", terminal: "b" },
        },
      ],
    };

    const result = analyzeAnalogCircuit(document, {
      mode: "dc",
      voltageOverrides: { source: sourceVoltage },
    });

    expect(result.status, result.message).toBe("valid");
    const expectedCurrent = sourceVoltage / Number.MAX_VALUE;
    const expectedPower = sourceVoltage * expectedCurrent;
    expect(result.parts.load.current.real / expectedCurrent).toBeCloseTo(1, 12);
    expect(result.parts.load.voltage.real / sourceVoltage).toBeCloseTo(1, 12);
    expect(result.parts.load.power.real / expectedPower).toBeCloseTo(1, 12);
  });
});
