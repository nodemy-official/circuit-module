import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";

function part(id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...fields };
}

function wire(
  id: string,
  fromPartId: string,
  fromTerminal: CircuitTerminal,
  toPartId: string,
  toTerminal: CircuitTerminal,
) {
  return {
    id,
    from: { partId: fromPartId, terminal: fromTerminal },
    to: { partId: toPartId, terminal: toTerminal },
  };
}

function relativeError(actual: number, expected: number) {
  return Math.abs(actual / expected - 1);
}

describe("diode exponential overflow audit", () => {
  it.each([
    {
      name: "finite raw exponent whose unscaled product overflows",
      voltage: 1e280,
      ideality: 1,
    },
    {
      name: "underflowing slope with a finite tangent current",
      voltage: 1e301,
      ideality: 1e300,
    },
    {
      name: "infinite raw exponent with finite current and power",
      voltage: 1,
      ideality: 2e-322,
    },
  ])("keeps the finite tangent current for $name", ({ voltage, ideality }) => {
    const saturationCurrent = Number.MIN_VALUE;
    const thermalVoltage = 0.025_85;
    const scale = ideality * thermalVoltage;
    const rawExponent = voltage / scale;
    const kneeCurrent = saturationCurrent * Math.exp(80);
    const tinyScaleSlope = (saturationCurrent / ideality / thermalVoltage) * Math.exp(80);
    const expectedCurrent = Number.isFinite(rawExponent)
      ? kneeCurrent * (1 + rawExponent - 80) - saturationCurrent
      : tinyScaleSlope * (voltage - scale * 79) - saturationCurrent;
    const document: CircuitDocument = {
      title: `Large forward bias at ideality ${ideality}`,
      parts: [
        part("source", "battery", { voltageVolts: voltage }),
        part("diode", "diode", {
          saturationCurrentAmps: saturationCurrent,
          emissionCoefficient: ideality,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "diode", "a"),
        wire("negative", "source", "b", "diode", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    const actualCurrent = analysis.parts.diode.terminalCurrents.a?.real ?? Number.NaN;
    const expectedPower = voltage * expectedCurrent;
    const actualSourceCurrent = analysis.parts.source.terminalCurrents.a?.real ?? Number.NaN;

    expect(Number.isFinite(expectedCurrent)).toBe(true);
    expect(Number.isFinite(expectedPower)).toBe(true);
    expect(actualCurrent / expectedCurrent).toBeCloseTo(1, 10);
    expect(actualSourceCurrent / -expectedCurrent).toBeCloseTo(1, 10);
    expect(analysis.parts.diode.power.real / expectedPower).toBeCloseTo(1, 10);
    expect(analysis.parts.source.power.real / -expectedPower).toBeCloseTo(1, 10);
  });

  it("keeps the finite diode slope when multiplying saturation by the exponential would overflow", () => {
    const ideality = 1e12;
    const saturationCurrent = Number.MAX_VALUE;
    const thermalVoltage = 0.025_85;
    const scale = ideality * thermalVoltage;
    const voltage = scale * 1e-15;
    const exponent = voltage / scale;
    const expectedCurrent = saturationCurrent * Math.expm1(exponent);
    const expectedSlope = (saturationCurrent / scale) * Math.exp(exponent);
    const document: CircuitDocument = {
      title: "Large ideality with a finite diode slope",
      parts: [
        part("source", "battery", { voltageVolts: voltage }),
        part("diode", "diode", {
          saturationCurrentAmps: saturationCurrent,
          emissionCoefficient: ideality,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "diode", "a"),
        wire("negative", "source", "b", "diode", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    const actualCurrent = analysis.parts.diode.terminalCurrents.a?.real ?? Number.NaN;

    expect(Number.isFinite(expectedSlope)).toBe(true);
    expect(Number.isFinite(voltage * expectedCurrent)).toBe(true);
    expect(actualCurrent / expectedCurrent).toBeCloseTo(1, 10);
    const actualSourceCurrent = analysis.parts.source.terminalCurrents.a?.real ?? Number.NaN;
    const expectedPower = voltage * expectedCurrent;
    expect(relativeError(actualSourceCurrent, -expectedCurrent)).toBeLessThan(1e-10);
    expect(relativeError(analysis.parts.diode.power.real, expectedPower)).toBeLessThan(1e-10);
    expect(relativeError(analysis.parts.source.power.real, -expectedPower)).toBeLessThan(1e-10);
  });

  it.each([
    { saturationCurrent: 1e-299, product: 0 },
    { saturationCurrent: 1e-280, product: 5e-324 },
  ])("retains reverse differential conductance with a subnormal exponential product at Is=$saturationCurrent", ({ saturationCurrent, product }) => {
    const scale = 1e-100;
    const ideality = scale / 0.025_85;
    const offsetVoltage = -100 * scale;
    const document: CircuitDocument = {
      title: "Reverse-biased diode with a subnormal exponential product",
      parts: [
        part("source", "ac-source", {
          voltageVolts: 1e-4,
          frequencyHz: 1000,
          offsetVolts: offsetVoltage,
          phaseDegrees: 0,
        }),
        part("diode", "diode", { saturationCurrentAmps: saturationCurrent, emissionCoefficient: ideality }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "diode", "a"),
        wire("negative", "source", "b", "diode", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(analysis.status, analysis.message).toBe("valid");
    const actualCurrent = analysis.parts.diode.current.real;
    const expectedConductance = (saturationCurrent / scale) * Math.exp(-100);
    const expectedCurrent = expectedConductance * analysis.parts.diode.voltage.real;

    expect(saturationCurrent * Math.exp(-100)).toBe(product);
    expect(expectedCurrent).toBeGreaterThan(0);
    expect(actualCurrent / expectedCurrent).toBeCloseTo(1, 8);
  });

  it("keeps a zero-bias diode finite when ideality times thermal voltage underflows", () => {
    const document: CircuitDocument = {
      title: "Zero-bias diode with underflowing voltage scale",
      parts: [
        part("source", "ac-source", { voltageVolts: 1e-4, frequencyHz: 1000, offsetVolts: 0 }),
        part("diode", "diode", {
          saturationCurrentAmps: Number.MIN_VALUE,
          emissionCoefficient: Number.MIN_VALUE,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "diode", "a"),
        wire("negative", "source", "b", "diode", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.parts.diode.terminalCurrents.a?.real).toBe(0);

    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    const expectedSlope = (Number.MIN_VALUE / Number.MIN_VALUE) / 0.025_85;
    expect(relativeError(ac.parts.diode.current.real, expectedSlope * ac.parts.diode.voltage.real)).toBeLessThan(1e-8);
  });

  it.each([
    { voltage: 1e-20, roundedExponent: 0 },
    { voltage: 2e-17, roundedExponent: Number.MIN_VALUE },
  ])("preserves finite current when the small exponent rounds to $roundedExponent", ({ voltage, roundedExponent }) => {
    const saturationCurrent = Number.MAX_VALUE;
    const ideality = Number.MAX_VALUE;
    const scale = ideality * 0.025_85;
    const expectedCurrent = (saturationCurrent / ideality / 0.025_85) * voltage;
    const document: CircuitDocument = {
      title: "Small exponent with a large saturation current",
      parts: [
        part("source", "battery", { voltageVolts: voltage }),
        part("diode", "diode", {
          saturationCurrentAmps: saturationCurrent,
          emissionCoefficient: ideality,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "diode", "a"),
        wire("negative", "source", "b", "diode", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(voltage / scale).toBe(roundedExponent);
    expect(expectedCurrent).toBeGreaterThan(0);
    expect(relativeError(analysis.parts.diode.terminalCurrents.a?.real ?? Number.NaN, expectedCurrent)).toBeLessThan(1e-8);
  });

  it("rejects a finite current whose true small-exponent slope exceeds binary64 range", () => {
    const voltage = Number.MIN_VALUE;
    const saturationCurrent = Number.MAX_VALUE;
    const ideality = 0.5 / 0.025_85;
    const scale = ideality * 0.025_85;
    const expectedCurrent = saturationCurrent * voltage / scale;
    const document: CircuitDocument = {
      title: "Subnormal exponent with a finite current and unbounded slope",
      parts: [
        part("source", "battery", { voltageVolts: voltage }),
        part("diode", "diode", {
          saturationCurrentAmps: saturationCurrent,
          emissionCoefficient: ideality,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "diode", "a"),
        wire("negative", "source", "b", "diode", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status).toBe("invalid");
    expect(voltage / scale).toBeGreaterThan(0);
    expect(voltage / scale).toBeLessThan(2 ** -1022);
    expect(Number.isFinite(expectedCurrent)).toBe(true);
    expect(Number.isFinite(saturationCurrent / scale)).toBe(false);
    expect(analysis.message).toContain("直流回路");
  });
});
