import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

const thermalVoltage = 0.025_85;

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

function forwardActiveBjtDocument(kind: "npn-transistor" | "pnp-transistor", ac = false): CircuitDocument {
  const pnp = kind === "pnp-transistor";
  const baseSource = ac
    ? part("base-source", "ac-source", {
        voltageVolts: 1e-4,
        frequencyHz: 1000,
        offsetVolts: 1,
        phaseDegrees: 0,
      })
    : part("base-source", "battery", { voltageVolts: 1 });

  return {
    title: `High gain ${kind} operating point`,
    parts: [
      part("device", kind, { currentGain: 1e16, saturationCurrentAmps: 1e-17 }),
      baseSource,
      part("base-resistor", "resistor", { resistanceOhms: 10_000 }),
      part("collector-source", "battery", { voltageVolts: 100 }),
      part("collector-resistor", "resistor", { resistanceOhms: 1 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("base-source-ground", "base-source", pnp ? "a" : "b", "ground", "a"),
      wire("base-source-resistor", "base-source", pnp ? "b" : "a", "base-resistor", "a"),
      wire("base-resistor-device", "base-resistor", "b", "device", "b"),
      wire("collector-source-ground", "collector-source", pnp ? "a" : "b", "ground", "a"),
      wire("collector-source-resistor", "collector-source", pnp ? "b" : "a", "collector-resistor", "a"),
      wire("collector-resistor-device", "collector-resistor", "b", "device", "a"),
      wire("device-emitter-ground", "device", "c", "ground", "a"),
    ],
  };
}

function relativeError(actual: number, expected: number) {
  return Math.abs(actual / expected - 1);
}

describe("BJT high-gain current preservation", () => {
  it.each(["npn-transistor", "pnp-transistor"] as const)(
    "preserves the finite forward base current for %s",
    (kind) => {
      const sign = kind === "pnp-transistor" ? -1 : 1;
      const result = analyzeAnalogCircuit(forwardActiveBjtDocument(kind), { mode: "dc" });
      expect(result.status, result.message).toBe("valid");

      const device = result.parts.device;
      const baseVoltage = device.terminalVoltages.b?.real ?? Number.NaN;
      const collectorVoltage = device.terminalVoltages.a?.real ?? Number.NaN;
      const emitterVoltage = device.terminalVoltages.c?.real ?? Number.NaN;
      const vbe = sign * (baseVoltage - emitterVoltage);
      const vbc = sign * (baseVoltage - collectorVoltage);
      const saturation = 1e-17;
      const transportForward = saturation * Math.expm1(vbe / thermalVoltage);
      const transportReverse = saturation * Math.expm1(vbc / thermalVoltage);
      const expectedBaseCurrent = sign * (transportForward / 1e16 + transportReverse);
      const actualBaseCurrent = device.terminalCurrents.b?.real ?? Number.NaN;

      expect(expectedBaseCurrent * sign).toBeGreaterThan(0);
      expect(relativeError(actualBaseCurrent, expectedBaseCurrent)).toBeLessThan(1e-8);
    },
  );

  it.each(["npn-transistor", "pnp-transistor"] as const)(
    "preserves the high-gain base differential conductance in AC for %s",
    (kind) => {
      const sign = kind === "pnp-transistor" ? -1 : 1;
      const document = forwardActiveBjtDocument(kind, true);
      const dc = analyzeAnalogCircuit(document, { mode: "dc" });
      const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
      expect(dc.status, dc.message).toBe("valid");
      expect(ac.status, ac.message).toBe("valid");

      const dcDevice = dc.parts.device;
      const vbe = sign * (
        (dcDevice.terminalVoltages.b?.real ?? Number.NaN) -
        (dcDevice.terminalVoltages.c?.real ?? Number.NaN)
      );
      const forwardSlope = (1e-17 * Math.exp(vbe / thermalVoltage)) / thermalVoltage;
      const acDevice = ac.parts.device;
      const vbeAc = sign * (
        (acDevice.terminalVoltages.b?.real ?? Number.NaN) -
        (acDevice.terminalVoltages.c?.real ?? Number.NaN)
      );
      const expectedBaseCurrent = sign * (forwardSlope / 1e16) * vbeAc;
      const actualBaseCurrent = acDevice.terminalCurrents.b?.real ?? Number.NaN;

      expect(expectedBaseCurrent * sign).toBeGreaterThan(0);
      expect(relativeError(actualBaseCurrent, expectedBaseCurrent)).toBeLessThan(1e-7);
    },
  );

  it("retains a representable base current when transport current underflows", () => {
    const document: CircuitDocument = {
      title: "Underflowing BJT transport current",
      parts: [
        part("device", "npn-transistor", { currentGain: 1e-300, saturationCurrentAmps: 1e-300 }),
        part("bias", "battery", { voltageVolts: 1e-30 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("base-bias", "bias", "a", "device", "b"),
        wire("bias-ground", "bias", "b", "ground", "a"),
        wire("collector-ground", "device", "a", "ground", "a"),
        wire("emitter-ground", "device", "c", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    const expectedBaseCurrent = Math.expm1(1e-30 / thermalVoltage);
    const actualBaseCurrent = result.parts.device.terminalCurrents.b?.real ?? Number.NaN;
    expect(expectedBaseCurrent).toBeGreaterThan(0);
    expect(relativeError(actualBaseCurrent, expectedBaseCurrent)).toBeLessThan(1e-8);
  });

  it("retains a representable base current when both transport and base saturation are subnormal", () => {
    const beta = 0.01;
    const saturation = 1e-320;
    const biasVoltage = 1e-5;
    const document: CircuitDocument = {
      title: "Subnormal BJT base current",
      parts: [
        part("device", "npn-transistor", { currentGain: beta, saturationCurrentAmps: saturation }),
        part("bias", "battery", { voltageVolts: biasVoltage }),
        part("ground", "ground"),
      ],
      wires: [
        wire("base-bias", "bias", "a", "device", "b"),
        wire("bias-ground", "bias", "b", "ground", "a"),
        wire("collector-ground", "device", "a", "ground", "a"),
        wire("emitter-ground", "device", "c", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    const vbe = result.parts.device.terminalVoltages.b?.real ?? Number.NaN;
    const vbc = result.parts.device.terminalVoltages.b?.real ?? Number.NaN;
    const expectedBaseCurrent = (saturation / beta) * Math.expm1(vbe / thermalVoltage) +
      saturation * Math.expm1(vbc / thermalVoltage);
    const actualBaseCurrent = result.parts.device.terminalCurrents.b?.real ?? Number.NaN;
    expect(expectedBaseCurrent).toBeGreaterThan(0);
    expect(relativeError(actualBaseCurrent, expectedBaseCurrent)).toBeLessThan(0.02);
  });

  it("keeps zero current finite when an extreme-beta transistor is shorted at zero bias", () => {
    const document: CircuitDocument = {
      title: "Shorted zero-bias BJT",
      parts: [
        part("device", "npn-transistor", {
          currentGain: Number.MIN_VALUE,
          saturationCurrentAmps: 1,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("collector-ground", "device", "a", "ground", "a"),
        wire("base-ground", "device", "b", "ground", "a"),
        wire("emitter-ground", "device", "c", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.device.terminalVoltages).toEqual({
      a: { real: 0, imaginary: 0 },
      b: { real: 0, imaginary: 0 },
      c: { real: 0, imaginary: 0 },
    });
    expect(result.parts.device.terminalCurrents).toEqual({
      a: { real: 0, imaginary: 0 },
      b: { real: 0, imaginary: 0 },
      c: { real: 0, imaginary: 0 },
    });
  });
});
