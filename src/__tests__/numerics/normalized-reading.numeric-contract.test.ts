import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { complex, complexAdd, complexDivide, complexMagnitude, complexMultiply, complexSubtract, withComplexMagnitudeNormalization } from "../../analog-math.js";
import { retainedComplex, restoredComplex, restoredReadingComplex, type CircuitExactComplex } from "../../circuit-reading.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

describe("transport of algebraic AC reading components", () => {
  it.each([1, 1e150, 1e308])("preserves a 1 V source on a %s V shared AC potential", (amplitude) => {
    const document = createCircuitFromSpecs([
      ["large", "ac-source", ["v", "g"], { voltageVolts: amplitude, frequencyHz: 50, phaseDegrees: 45 }],
      ["small", "ac-source", ["out", "v"], { voltageVolts: 1, frequencyHz: 50, phaseDegrees: 0 }],
      ["ground", "ground", ["g"]],
    ], "Independent ideal-source difference");
    const analog = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(analog.status).toBe("valid");
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    expect(analysis.status).toBe("open");
    for (const result of [analysis, JSON.parse(JSON.stringify(analysis)) as typeof analysis, structuredClone(analysis)]) {
      const reading = result.parts.small!;
      const restored = (terminal: "a" | "b") => restoredReadingComplex(reading.exactTerminalVoltages?.[terminal],
        reading.terminalVoltages![terminal]!, reading.terminalVoltagePhasesDegrees![terminal], true, result.precisionExpressions)!;
      // The independent oracle is the ideal source constraint Va - Vb = 1 V.
      const difference = complexSubtract(restored("a"), restored("b"));
      expect(difference).toEqual({ real: 1, imaginary: 0 });
      expect(complexMagnitude(difference)).toBe(1);
    }
  });

  it.each(["sum", "fraction"] as const)("retains exact cancellation in a transported %s", (kind) => {
    const shared = withComplexMagnitudeNormalization(complex(1e150, -1e150), { numerator: 2n, denominator: 1n });
    const offset = complex(1, -2);
    const divisor = complexAdd(withComplexMagnitudeNormalization(complex(2, 3), { numerator: 3n, denominator: 1n }), complex(1, -1));
    const sum = complexAdd(shared, offset);
    const original = kind === "sum" ? sum : complexDivide(sum, divisor);
    const metadata = retainedComplex(original)!;
    expect(metadata.normalizedFraction).toBeDefined();
    for (const value of [metadata, JSON.parse(JSON.stringify(metadata)) as typeof metadata, structuredClone(metadata)]) {
      const restored = restoredComplex(value)!;
      const numerator = kind === "sum" ? restored : complexMultiply(restored, divisor);
      // Independent algebraic identity: ((shared + offset) / divisor) * divisor - shared = offset.
      expect(complexSubtract(numerator, shared)).toEqual({ real: 1, imaginary: -2 });
    }
  });

  it.each([
    { numerator: [], denominator: [] },
    { numerator: [{ real: { numerator: "1", denominator: "1" }, imaginary: { numerator: "0", denominator: "1" }, magnitudeNormalizationSquared: { numerator: "-2", denominator: "1" } }], denominator: [] },
    { numerator: [null], denominator: [null] },
    { numerator: "invalid", denominator: [] },
  ])("rejects malformed optional algebraic metadata %#", (normalizedFraction) => {
    const value = { real: { numerator: "1", denominator: "1" }, imaginary: { numerator: "0", denominator: "1" }, normalizedFraction } as unknown as CircuitExactComplex;
    expect(restoredComplex(value)).toBeUndefined();
  });
});
