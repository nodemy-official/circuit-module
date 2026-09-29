import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeAnalogCircuit, polarFromComplex } from "../analog-solver.js";
import { analyzeCircuit } from "../circuit-solver.js";

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

function sourceCircuit(voltageVolts: number, phaseDegrees: number, resistanceOhms = 100): CircuitDocument {
  return {
    title: "AC source phase boundary audit",
    parts: [
      part("source", "ac-source", { voltageVolts, phaseDegrees, frequencyHz: 50 }),
      part("load", "resistor", { resistanceOhms }),
    ],
    wires: [
      wire("source-to-load", "source", "a", "load", "a"),
      wire("load-to-source", "load", "b", "source", "b"),
    ],
  };
}

describe("AC source phase floating-point boundaries", () => {
  it.each([Number.MAX_VALUE, -Number.MAX_VALUE, 1e308, -1e308, 1e100, -1e100, 2 ** 53])(
    "reduces the exact represented huge degree value before taking its phasor (%s°)",
    (phaseDegrees) => {
      // BigInt(number) preserves the exact integer represented by these large
      // finite doubles, giving an independent exact modulo-360 reference.
      const phaseModulo360 = Number(((BigInt(phaseDegrees) % 360n) + 360n) % 360n);
      const radians = phaseModulo360 * Math.PI / 180;
      const magnitude = 5;
      const result = analyzeAnalogCircuit(sourceCircuit(magnitude, phaseDegrees), {
        mode: "ac",
        frequencyHz: 50,
      });

      expect(result.status, result.message).toBe("valid");
      expect(result.parts.source.voltage.real).toBeCloseTo(magnitude * Math.cos(radians), 12);
      expect(result.parts.source.voltage.imaginary).toBeCloseTo(magnitude * Math.sin(radians), 12);
    },
  );

  it.each([
    { phaseDegrees: 0, real: 1, imaginary: 0 },
    { phaseDegrees: 45, real: 1, imaginary: 1 },
    { phaseDegrees: 135, real: -1, imaginary: 1 },
    { phaseDegrees: 225, real: -1, imaginary: -1 },
    { phaseDegrees: 315, real: 1, imaginary: -1 },
  ])("preserves subnormal source components at $phaseDegrees°", ({ phaseDegrees, real, imaginary }) => {
    const result = analyzeAnalogCircuit(sourceCircuit(Number.MIN_VALUE, phaseDegrees), {
      mode: "ac",
      frequencyHz: 50,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.source.voltage.real).toBe(real * Number.MIN_VALUE);
    expect(result.parts.source.voltage.imaginary).toBe(imaginary * Number.MIN_VALUE);
  });

  it("keeps a representable subnormal phase in scalar AC readings", () => {
    const phaseDegrees = Number.MIN_VALUE;
    const document = sourceCircuit(1e308, phaseDegrees, 1e308);
    const result = analyzeCircuit(document, {}, {
      mode: "ac",
      frequencyHz: 50,
    });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.source.voltagePhaseDegrees).toBe(phaseDegrees);
    expect(result.parts.load.voltagePhaseDegrees).toBe(phaseDegrees);
  });

  it("keeps a representable subnormal phase in polarFromComplex", () => {
    const phaseDegrees = Number.MIN_VALUE;
    const document = sourceCircuit(1e308, phaseDegrees, 1e308);
    const analogResult = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });
    expect(analogResult.status, analogResult.message).toBe("valid");
    expect(polarFromComplex(analogResult.parts.source!.voltage).phaseDegrees).toBe(phaseDegrees);
  });
});
