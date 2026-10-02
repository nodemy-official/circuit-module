import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const controlMagnitude = 2 ** 1023;
const cases = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].map((reverse) => ({ kind, reverse })),
);

function cutoffDocument(kind: "nmos" | "pmos", reverse: boolean) {
  const sign = kind === "nmos" ? 1 : -1;
  return createCircuitFromSpecs([
    ["ground", "ground", ["0"]],
    ["gate", "ac-source", ["gate", "0"], {
      offsetVolts: -sign * controlMagnitude,
      voltageVolts: 0.001,
      phaseDegrees: 0,
    }],
    ["drain", "ac-source", ["drain", "0"], {
      offsetVolts: sign * (reverse ? -1 : 1),
      voltageVolts: 0,
    }],
    ["mos", kind, ["drain", "gate", "0"], { thresholdVolts: controlMagnitude }],
  ], "Finite MOS cutoff with an overflowing negative overdrive");
}

function conductingDocument(kind: "nmos" | "pmos", reverse: boolean) {
  const sign = kind === "nmos" ? 1 : -1;
  return createCircuitFromSpecs([
    ["ground", "ground", ["0"]],
    ["source", "ac-source", ["source", "0"], {
      offsetVolts: -sign * controlMagnitude,
      voltageVolts: 0,
    }],
    ["gate", "ac-source", ["gate", "0"], {
      offsetVolts: sign * controlMagnitude,
      voltageVolts: 2 ** 512,
      phaseDegrees: 0,
    }],
    ["drain", "ac-source", ["drain", "source"], {
      offsetVolts: sign * (reverse ? -1 : 1),
      voltageVolts: 0,
    }],
    ["mos", kind, ["drain", "gate", "source"], {
      thresholdVolts: 0,
      transconductanceAmpsPerVoltSquared: 2 ** -1023,
      channelLengthModulation: 0,
    }],
  ], "Finite MOS current with an overflowing positive overdrive");
}

describe("MOS control differences outside the binary64 range", () => {
  it.each(cases)("keeps $kind cutoff in either channel direction in DC (reverse=$reverse)", ({ kind, reverse }) => {
    const analysis = analyzeAnalogCircuit(cutoffDocument(kind, reverse));
    expect(analysis.status, analysis.message).toBe("valid");
    const reading = analysis.parts.mos!;
    // Vov is approximately -2^1024, so the square-law model is exactly off.
    // Every public terminal voltage and every current/power remains finite.
    expect(reading.current).toEqual({ real: 0, imaginary: 0 });
    expect(reading.power).toEqual({ real: 0, imaginary: 0 });
    expect(reading.channelConducting).toBe(false);
    expect(reading.voltage.real).toBe((kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1));
    for (const voltage of Object.values(reading.terminalVoltages)) {
      expect(Number.isFinite(voltage?.real)).toBe(true);
    }
  });

  it.each(cases)("keeps the $kind cutoff Jacobian zero in AC (reverse=$reverse)", ({ kind, reverse }) => {
    const analysis = analyzeAnalogCircuit(cutoffDocument(kind, reverse), { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("valid");
    const reading = analysis.parts.mos!;
    expect(reading.terminalVoltages.b).toEqual({ real: 0.001, imaginary: 0 });
    expect(reading.current).toEqual({ real: 0, imaginary: 0 });
    expect(reading.power).toEqual({ real: 0, imaginary: 0 });
    expect(reading.channelConducting).toBe(false);
    expect(reading.acReferenceTerminalGroups).toEqual([]);
    for (const current of Object.values(reading.terminalCurrents)) {
      expect(current).toEqual({ real: 0, imaginary: 0 });
    }
  });

  it.each(cases)("retains $kind cutoff through transient initialization and stepping (reverse=$reverse)", ({ kind, reverse }) => {
    const analysis = simulateTransient(cutoffDocument(kind, reverse), {
      durationSeconds: 0.001,
      timeStepSeconds: 0.001,
    });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.samples).toHaveLength(2);
    for (const sample of analysis.samples) {
      const reading = sample.parts.mos!;
      expect(reading.currentAmps).toBe(0);
      expect(reading.powerWatts).toBe(0);
      expect(reading.channelConducting).toBe(false);
    }
  });

  it.each(cases)("keeps the finite $kind triode current and power in DC (reverse=$reverse)", ({ kind, reverse }) => {
    const analysis = analyzeAnalogCircuit(conductingDocument(kind, reverse));
    expect(analysis.status, analysis.message).toBe("valid");
    const direction = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
    // beta=2^-1023, |Vds|=1 and Vov=2^1024 (+1 in reverse).
    // I=beta*(Vov*|Vds|-|Vds|^2/2) rounds to 2 A; P rounds to 2 W.
    const reading = analysis.parts.mos!;
    expect(reading.current).toEqual({ real: direction * 2, imaginary: 0 });
    expect(reading.power).toEqual({ real: 2, imaginary: 0 });
    expect(reading.voltage.real).toBe(direction);
    expect(reading.channelConducting).toBe(true);
    expect(analysis.parts.drain!.current.real).toBe(-direction * 2);
    expect(analysis.parts.drain!.power.real).toBe(-2);
    expect(analysis.parts.source!.current.real).toBe(0);
    expect(analysis.parts.gate!.current.real).toBe(0);
  });

  it.each(cases)("preserves the finite $kind small-signal derivative in AC (reverse=$reverse)", ({ kind, reverse }) => {
    const analysis = analyzeAnalogCircuit(conductingDocument(kind, reverse), { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("valid");
    // gm=beta*|Vds|=2^-1023 and Vac=2^512, hence |Iac|=2^-511.
    // Reversing the channel negates the gate response for either polarity.
    const expectedCurrent = (reverse ? -1 : 1) * 2 ** -511;
    expect(analysis.parts.mos!.current).toEqual({ real: expectedCurrent, imaginary: 0 });
    expect(analysis.parts.mos!.terminalCurrents.c).toEqual({ real: -expectedCurrent, imaginary: 0 });
    expect(analysis.parts.drain!.current).toEqual({ real: -expectedCurrent, imaginary: 0 });
    expect(analysis.parts.mos!.power).toEqual({ real: 0, imaginary: 0 });
    expect(analysis.parts.mos!.channelConducting).toBe(true);
  });

  it.each(cases)("retains the finite $kind current through transient initialization and stepping (reverse=$reverse)", ({ kind, reverse }) => {
    const analysis = simulateTransient(conductingDocument(kind, reverse), {
      durationSeconds: 0.001,
      timeStepSeconds: 0.001,
    });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.samples).toHaveLength(2);
    const direction = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
    for (const sample of analysis.samples) {
      // The varying 2^512 V gate signal is less than one current ULP here.
      const reading = sample.parts.mos!;
      expect(reading.currentAmps).toBe(direction * 2);
      expect(reading.powerWatts).toBe(2);
      expect(reading.channelConducting).toBe(true);
      expect(sample.parts.drain!.currentAmps).toBe(-direction * 2);
    }
  });
});
