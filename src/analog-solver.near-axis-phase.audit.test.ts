import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeAnalogCircuit } from "./analog-solver.js";

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

describe("AC source phases near coordinate axes", () => {
  it.each([Number.MIN_VALUE, -Number.MIN_VALUE, 1e-320, -1e-320])(
    "retains the representable quadrature voltage for phase %s° when radians underflow",
    (phaseDegrees) => {
      const magnitude = 1e308;
      const document: CircuitDocument = {
        title: "極小位相角と巨大な電圧",
        parts: [
          part("source", "ac-source", { voltageVolts: magnitude, phaseDegrees, frequencyHz: 50 }),
          part("load", "resistor", { resistanceOhms: magnitude }),
        ],
        wires: [
          wire("out", "source", "a", "load", "a"),
          wire("return", "load", "b", "source", "b"),
        ],
      };

      const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });
      // sin(x) ≈ x here. Scale by voltage before converting to radians so the
      // reference itself does not underflow for subnormal degree values.
      const expectedImaginary = (magnitude * phaseDegrees) * (Math.PI / 180);

      expect(result.status, result.message).toBe("valid");
      expect(result.parts.source.voltage.real).toBe(magnitude);
      expect(result.parts.source.voltage.imaginary / expectedImaginary).toBeCloseTo(1, 14);
      expect(result.parts.load.voltage.real).toBe(magnitude);
      expect(result.parts.load.voltage.imaginary / expectedImaginary).toBeCloseTo(1, 14);
    },
  );

  it("rejects a parallel-source loop with a representable subnormal-phase mismatch", () => {
    const magnitude = 1e308;
    const document: CircuitDocument = {
      title: "極小位相差のある理想電圧源ループ",
      parts: [
        part("reference", "ac-source", { voltageVolts: magnitude, phaseDegrees: 0, frequencyHz: 50 }),
        part("offset", "ac-source", {
          voltageVolts: magnitude,
          phaseDegrees: Number.MIN_VALUE,
          frequencyHz: 50,
        }),
        part("load", "resistor", { resistanceOhms: magnitude }),
      ],
      wires: [
        wire("load-positive", "reference", "a", "load", "a"),
        wire("load-negative", "load", "b", "reference", "b"),
        wire("shared-positive", "reference", "a", "offset", "a"),
        wire("shared-negative", "reference", "b", "offset", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  it("keeps the small negative phase represented just below 360°", () => {
    const magnitude = 1e308;
    const phaseDegrees = 359.999_999_999_999_94;
    const phaseOffsetDegrees = phaseDegrees - 360;
    const document: CircuitDocument = {
      title: "360度直下の微小な負位相",
      parts: [
        part("source", "ac-source", { voltageVolts: magnitude, phaseDegrees, frequencyHz: 50 }),
        part("load", "resistor", { resistanceOhms: magnitude }),
      ],
      wires: [
        wire("out", "source", "a", "load", "a"),
        wire("return", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });
    // The residual angle is tiny, so sin(θ) ≈ θ; scaling first preserves it.
    const expectedImaginary = (magnitude * phaseOffsetDegrees) * (Math.PI / 180);

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.source.voltage.real).toBe(magnitude);
    expect(result.parts.source.voltage.imaginary / expectedImaginary).toBeCloseTo(1, 14);
    expect(result.parts.load.voltage.imaginary / expectedImaginary).toBeCloseTo(1, 14);
  });

  it.each([
    { phaseDegrees: 89.999_999_999_999_99, axisDegrees: 90, acrossAxis: "real" as const, orientation: -1, alongAxis: "imaginary" as const, alongSign: 1 },
    { phaseDegrees: 90.000_000_000_000_01, axisDegrees: 90, acrossAxis: "real" as const, orientation: -1, alongAxis: "imaginary" as const, alongSign: 1 },
    { phaseDegrees: 179.999_999_999_999_97, axisDegrees: 180, acrossAxis: "imaginary" as const, orientation: -1, alongAxis: "real" as const, alongSign: -1 },
    { phaseDegrees: 180.000_000_000_000_03, axisDegrees: 180, acrossAxis: "imaginary" as const, orientation: -1, alongAxis: "real" as const, alongSign: -1 },
    { phaseDegrees: 269.999_999_999_999_94, axisDegrees: 270, acrossAxis: "real" as const, orientation: 1, alongAxis: "imaginary" as const, alongSign: -1 },
    { phaseDegrees: 270.000_000_000_000_06, axisDegrees: 270, acrossAxis: "real" as const, orientation: 1, alongAxis: "imaginary" as const, alongSign: -1 },
  ])("matches the analytic phasor at the adjacent phase $phaseDegrees°", ({
    phaseDegrees,
    axisDegrees,
    acrossAxis,
    orientation,
    alongAxis,
    alongSign,
  }) => {
    const magnitude = 1e308;
    const document: CircuitDocument = {
      title: "直交位相軸の隣接浮動小数点位相",
      parts: [
        part("source", "ac-source", { voltageVolts: magnitude, phaseDegrees, frequencyHz: 50 }),
        part("load", "resistor", { resistanceOhms: magnitude }),
      ],
      wires: [
        wire("out", "source", "a", "load", "a"),
        wire("return", "load", "b", "source", "b"),
      ],
    };
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });
    const deltaDegrees = phaseDegrees - axisDegrees;
    const expectedAcrossAxis = orientation * (magnitude * deltaDegrees) * (Math.PI / 180);

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.source.voltage[acrossAxis] / expectedAcrossAxis).toBeCloseTo(1, 14);
    expect(result.parts.source.voltage[alongAxis]).toBe(alongSign * magnitude);
    expect(result.parts.load.voltage[acrossAxis] / expectedAcrossAxis).toBeCloseTo(1, 14);
    expect(result.parts.load.voltage[alongAxis]).toBe(alongSign * magnitude);
  });
});
