import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitTerminal } from "./circuit-model.js";
import { simulateTransient } from "./transient-solver.js";

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) {
  return { id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } };
}

function floatingDrain(
  kind: "nmos" | "pmos",
  gateVoltage: number,
  gateRmsVoltage = 0,
  gateFrequencyHz = 1000,
): CircuitDocument {
  return {
    title: "MOSFET transient channel-state audit",
    parts: [
      part("mos", kind),
      part("gate", "ac-source", {
        voltageVolts: gateRmsVoltage,
        frequencyHz: gateFrequencyHz,
        offsetVolts: gateVoltage,
      }),
      part("meter", "voltmeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("gate-input", "gate", "a", "mos", "b"),
      wire("gate-ground", "gate", "b", "ground", "a"),
      wire("source-ground", "mos", "c", "ground", "a"),
      wire("drain-meter", "mos", "a", "meter", "a"),
      wire("meter-ground", "meter", "b", "ground", "a"),
    ],
  };
}

describe("MOSFET channel state in transient readings", () => {
  it.each([
    ["nmos", 0],
    ["pmos", 0],
  ] as const)("keeps a cut-off %s drain floating throughout the transient", (kind, gateVoltage) => {
    const result = simulateTransient(floatingDrain(kind, gateVoltage), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(sample.parts.mos.channelConducting).toBe(false);
      expect(sample.parts.meter.meterStatus).toBe("floating");
    }
  });

  it.each([
    ["nmos", 5],
    ["pmos", -5],
  ] as const)("marks an on %s conducting at zero drain voltage and current", (kind, gateVoltage) => {
    const result = simulateTransient(floatingDrain(kind, gateVoltage), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(sample.parts.mos.channelConducting).toBe(true);
      expect(sample.parts.mos.voltageVolts).toBe(0);
      expect(sample.parts.mos.currentAmps).toBe(0);
      expect(sample.parts.meter.meterStatus).toBe("connected");
    }
  });

  it("updates channel and meter connectivity as an AC gate waveform crosses threshold", () => {
    const result = simulateTransient(floatingDrain("nmos", 2, 3, 1), {
      durationSeconds: 1,
      timeStepSeconds: 0.125,
    });
    const expectedStates = [true, true, false, false, false, false, false, true, true];

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(expectedStates.length);
    for (const [index, sample] of result.samples.entries()) {
      const conducting = expectedStates[index];
      expect(sample.parts.mos?.channelConducting).toBe(conducting);
      expect(sample.parts.meter?.meterStatus).toBe(conducting ? "connected" : "floating");
      if (conducting) {
        expect(sample.parts.mos?.voltageVolts).toBe(0);
        expect(sample.parts.mos?.currentAmps).toBe(0);
      }
    }
  });
});
