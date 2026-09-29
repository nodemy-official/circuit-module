import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

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

function biasedDevice(
  kind: "npn-transistor" | "pnp-transistor" | "nmos" | "pmos",
  commonMode: number,
): CircuitDocument {
  const polarity = kind === "pnp-transistor" || kind === "pmos" ? -1 : 1;
  const isBjt = kind === "npn-transistor" || kind === "pnp-transistor";
  return {
    title: "Nonlinear AC common-mode invariance",
    parts: [
      part("ground", "ground"),
      part("common", "ac-source", { voltageVolts: commonMode, frequencyHz: 1000, phaseDegrees: 37 }),
      part("bias-a", "ac-source", {
        voltageVolts: 0.01,
        offsetVolts: polarity * (isBjt ? 0.8 : 3),
        frequencyHz: 1000,
        phaseDegrees: 37,
      }),
      part("bias-b", "ac-source", {
        voltageVolts: 0.001,
        offsetVolts: polarity * (isBjt ? 0.7 : 2),
        frequencyHz: 1000,
        phaseDegrees: 37,
      }),
      part("device", kind, isBjt
        ? { saturationCurrentAmps: 1e-14, currentGain: 100 }
        : { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 0.003, channelLengthModulation: 0.017 }),
    ],
    wires: [
      wire("common-ground", "common", "b", "ground", "a"),
      wire("common-device", "common", "a", "device", "c"),
      wire("bias-a-return", "bias-a", "b", "common", "a"),
      wire("bias-b-return", "bias-b", "b", "common", "a"),
      wire("bias-a-device", "bias-a", "a", "device", "a"),
      wire("bias-b-device", "bias-b", "a", "device", "b"),
    ],
  };
}

describe("nonlinear AC common-mode invariance", () => {
  it.each(["npn-transistor", "pnp-transistor", "nmos", "pmos"] as const)(
    "preserves %s terminal currents under a 1e16 V shared phasor",
    (kind) => {
      const baseline = analyzeAnalogCircuit(biasedDevice(kind, 0), { mode: "ac", frequencyHz: 1000 });
      const shifted = analyzeAnalogCircuit(biasedDevice(kind, 1e16), { mode: "ac", frequencyHz: 1000 });
      expect(baseline.status, baseline.message).toBe("valid");
      expect(shifted.status, shifted.message).toBe("valid");
      expect(shifted.parts.device.current).toEqual(baseline.parts.device.current);
      expect(shifted.parts.device.voltage).toEqual(baseline.parts.device.voltage);
      expect(shifted.parts.device.terminalCurrents).toEqual(baseline.parts.device.terminalCurrents);
      expect(shifted.parts.device.power).toEqual(baseline.parts.device.power);
    },
  );
});
