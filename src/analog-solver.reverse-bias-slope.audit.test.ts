import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function reverseBiasedDiode(
  kind: "diode" | "led",
  saturationCurrentAmps: number,
  emissionCoefficient: number,
  exponent: number,
  acAmplitude: number,
): CircuitDocument {
  const thermalVoltage = 0.025_85;
  const scale = emissionCoefficient * thermalVoltage;
  return {
    title: "Reverse-biased diode differential conductance",
    parts: [
      part("source", "ac-source", {
        voltageVolts: acAmplitude,
        frequencyHz: 1000,
        offsetVolts: exponent * scale,
      }),
      part("device", kind, { saturationCurrentAmps, emissionCoefficient }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-device-positive", "source", "a", "device", "a"),
      wire("source-device-return", "device", "b", "source", "b"),
      wire("reference", "source", "b", "ground", "a"),
    ],
  };
}

function reverseBiasedBjt(
  saturationCurrentAmps: number,
  currentGain: number,
  exponent: number,
  acAmplitude: number,
): CircuitDocument {
  const thermalVoltage = 0.025_85;
  return {
    title: "Reverse-biased BJT differential conductance",
    parts: [
      part("source", "ac-source", {
        voltageVolts: acAmplitude,
        frequencyHz: 1000,
        offsetVolts: exponent * thermalVoltage,
      }),
      part("device", "npn-transistor", { saturationCurrentAmps, currentGain }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-base", "source", "a", "device", "b"),
      wire("collector-reference", "device", "a", "ground", "a"),
      wire("emitter-reference", "device", "c", "ground", "a"),
      wire("source-reference", "source", "b", "ground", "a"),
    ],
  };
}

function conductanceFromLog(saturationCurrentAmps: number, exponent: number, scale: number) {
  return Math.exp(Math.log(saturationCurrentAmps) + exponent - Math.log(scale));
}

describe("reverse-biased nonlinear AC slope audit", () => {
  it.each([
    {
      label: "ordinary diode saturation current",
      kind: "diode" as const,
      saturationCurrent: 1e-12,
      emissionCoefficient: 1,
      exponent: -100,
      acAmplitude: 1e-10,
    },
    {
      label: "LED saturation current and ideality",
      kind: "led" as const,
      saturationCurrent: 1e-20,
      emissionCoefficient: 2,
      exponent: -100,
      acAmplitude: 1e-10,
    },
    {
      label: "finite Is times an exponent below exp underflow",
      kind: "diode" as const,
      saturationCurrent: 1e300,
      emissionCoefficient: 1,
      exponent: -800,
      acAmplitude: 1e-10,
    },
  ])("uses the Shockley differential conductance for $label", ({
    kind,
    saturationCurrent,
    emissionCoefficient,
    exponent,
    acAmplitude,
  }) => {
    const document: CircuitDocument = {
      ...reverseBiasedDiode(kind, saturationCurrent, emissionCoefficient, exponent, acAmplitude),
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    const scale = emissionCoefficient * 0.025_85;
    const expectedConductance = conductanceFromLog(saturationCurrent, exponent, scale);

    expect(dc.status, dc.message).toBe("valid");
    expect(ac.status, ac.message).toBe("valid");
    expect(dc.parts.device.voltage.real / scale).toBeCloseTo(exponent, 10);
    expect(expectedConductance * acAmplitude).toBeGreaterThan(0);
    expect(ac.parts.device.current.real / (expectedConductance * acAmplitude)).toBeCloseTo(1, 8);
  });

  it("uses the Shockley derivative for reverse-biased BJT base current", () => {
    const saturationCurrent = 1e-14;
    const currentGain = 100;
    const exponent = -100;
    const acAmplitude = 1e-10;
    const document = reverseBiasedBjt(saturationCurrent, currentGain, exponent, acAmplitude);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    const thermalVoltage = 0.025_85;
    const junctionConductance = conductanceFromLog(saturationCurrent, exponent, thermalVoltage);
    const expectedBaseConductance = junctionConductance * (1 + 1 / currentGain);

    expect(dc.status, dc.message).toBe("valid");
    expect(ac.status, ac.message).toBe("valid");
    expect(dc.parts.device.terminalVoltages.b!.real / thermalVoltage).toBeCloseTo(exponent, 10);
    expect(ac.parts.device.terminalCurrents.b!.real /
      (expectedBaseConductance * acAmplitude)).toBeCloseTo(1, 8);
  });
});
