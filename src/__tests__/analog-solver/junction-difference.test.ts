import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import type { CircuitDocument, CircuitPartKind } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

it.each(["npn-transistor", "pnp-transistor", "nmos", "pmos"] as const)(
  "completes the local junction difference before model evaluation for %s",
  (kind) => {
    const sign = kind === "pnp-transistor" || kind === "pmos" ? -1 : 1;
    const bjt = kind === "npn-transistor" || kind === "pnp-transistor";
    for (const grounded of [false, true]) {
      const document: CircuitDocument = {
        title: `Reverse ${kind} with large common voltage`,
        parts: [
          { id: "common", kind: "ac-source", label: "Common", x: 0, y: 0, voltageVolts: 0, offsetVolts: -sign * 1e16, frequencyHz: 1000 },
          { id: "bias", kind: "ac-source", label: "Bias", x: 0, y: 0, voltageVolts: 0.001, offsetVolts: sign * (bjt ? 0.5 : 3), frequencyHz: 1000 },
          { id: "device", kind: kind as CircuitPartKind, label: "Device", x: 0, y: 0, saturationCurrentAmps: 1e-14, currentGain: 100,
            thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 0.02, channelLengthModulation: 0 },
          ...(grounded ? [{ id: "ground", kind: "ground" as const, label: "GND", x: 0, y: 0 }] : []),
        ],
        wires: [
          { id: "source", from: { partId: "common", terminal: "b" }, to: { partId: "device", terminal: "c" } },
          { id: "drain", from: { partId: "common", terminal: "a" }, to: { partId: "device", terminal: "a" } },
          { id: "bias-low", from: { partId: "common", terminal: "a" }, to: { partId: "bias", terminal: "b" } },
          { id: "bias-high", from: { partId: "bias", terminal: "a" }, to: { partId: "device", terminal: "b" } },
          ...(grounded ? [{ id: "ground", from: { partId: "common", terminal: "b" as const }, to: { partId: "ground", terminal: "a" as const } }] : []),
        ],
      };
      // Local Vbc or reverse-channel Vgd remains 0.5 or 3 V even though
      // base/gate and collector/drain potentials round to the same large value.
      const expectedDc = sign * (bjt ? -1e-14 - 2e-14 * Math.expm1(0.5 / 0.025_85) : -0.01);
      const expectedAc = bjt ? -2e-14 * Math.exp(0.5 / 0.025_85) / 0.025_85 * 0.001 : -0.000_02;
      const dc = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(dc.status, dc.message).toBe("valid");
      expect(dc.parts.device!.current.real / expectedDc).toBeCloseTo(1, 12);
      const ac = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(ac.status, ac.message).toBe("valid");
      expect(ac.parts.device!.current.real / expectedAc).toBeCloseTo(1, 12);
      document.parts[1]!.voltageVolts = 0;
      const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
      expect(transient.status, transient.message).toBe("valid");
      for (const sample of transient.samples) {
        expect(sample.parts.device!.currentAmps / expectedDc).toBeCloseTo(1, 12);
      }
    }
  },
);
