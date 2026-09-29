import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import { exactProductSumRatio } from "../analog-math.js";
import { analyzeCircuit } from "../circuit-solver.js";
import {
  divideExactRational,
  exactRationalToNumber,
  multiplyExactRational,
  numberToExactRational,
} from "../exact-linear-algebra.js";

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

describe("AC Norton branch admittance below binary64 range", () => {
  it("keeps the capacitor current when its admittance rounds to zero", () => {
    const frequencyHz = Number.MIN_VALUE;
    const capacitanceFarads = 0.01;
    const sourceVoltage = 1e308;
    const document: CircuitDocument = {
      title: "subnormal-frequency capacitor current",
      parts: [
        part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
        part("capacitor", "capacitor", { capacitanceFarads }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-capacitor", "source", "a", "capacitor", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
        wire("capacitor-ground", "capacitor", "b", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const scalarResult = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const admittance = exactProductSumRatio([{ factors: [2, Math.PI, frequencyHz, capacitanceFarads] }], 1);
    const voltage = numberToExactRational(sourceVoltage);
    const expectedCurrent = admittance && voltage
      ? exactRationalToNumber(multiplyExactRational(admittance, voltage))
      : Number.NaN;

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.capacitor.voltage.real).toBe(sourceVoltage);
    expect(expectedCurrent).toBeGreaterThan(0);
    expect(result.parts.capacitor.current.imaginary).toBe(expectedCurrent);
    expect(scalarResult.status, scalarResult.message).toBe("closed");
    expect(scalarResult.parts.capacitor.currentAmps).toBe(expectedCurrent);
    expect(scalarResult.parts.capacitor.currentPhaseDegrees).toBe(90);
  });

  it("keeps a finite current when the finite reactance itself rounds to zero", () => {
    const frequencyHz = Number.MIN_VALUE;
    const inductanceHenries = 0.01;
    const sourceVoltage = Number.MIN_VALUE;
    const document: CircuitDocument = {
      title: "subnormal-frequency inductor current",
      parts: [
        part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
        part("inductor", "inductor", { inductanceHenries }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-inductor", "source", "a", "inductor", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
        wire("inductor-ground", "inductor", "b", "ground", "a"),
      ],
    };
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const scalarResult = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const reactance = exactProductSumRatio([{ factors: [2, Math.PI, frequencyHz, inductanceHenries] }], 1);
    const voltage = numberToExactRational(sourceVoltage);
    const expectedCurrent = reactance && voltage
      ? exactRationalToNumber(divideExactRational(voltage, reactance) ?? { numerator: 0n, denominator: 1n })
      : Number.NaN;

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.inductor.voltage.real).toBe(sourceVoltage);
    expect(expectedCurrent).toBeGreaterThan(0);
    expect(result.parts.inductor.current.imaginary).toBeCloseTo(-expectedCurrent, 12);
    expect(scalarResult.status, scalarResult.message).toBe("closed");
    expect(scalarResult.parts.inductor.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(scalarResult.parts.inductor.currentPhaseDegrees).toBeCloseTo(-90, 10);
  });
});
