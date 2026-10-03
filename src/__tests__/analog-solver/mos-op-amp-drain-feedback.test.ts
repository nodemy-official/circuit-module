import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

function circuit(gain: number, sign: 1 | -1, amplitude = 0) {
  return createCircuitFromSpecs([
    ["supply", "ac-source", ["vdd", "g"], { voltageVolts: amplitude, frequencyHz: 1000, phaseDegrees: sign === 1 ? 0 : 180, offsetVolts: sign * 5 }],
    ["ref", "ac-source", ["ref", "g"], { voltageVolts: 0, offsetVolts: sign * 3 }],
    ["amp", "op-amp", ["out", "ref", "gate"], { openLoopGain: gain, positiveRailVolts: sign === 1 ? 10 : 0, negativeRailVolts: sign === 1 ? 0 : -10 }],
    ["mos", sign === 1 ? "nmos" : "pmos", ["out", "gate", "g"]],
    ["load", "resistor", ["vdd", "out"], { resistanceOhms: 10 }],
    ["ground", "ground", ["g"]],
  ], "MOS drain voltage feedback");
}

/** Independent scalar root from MOS triode current, load KCL and Vgate=A*(Vdrain-3). */
function operatingPoint(gain: number) {
  const residual = (candidateGate: number) => {
    const candidateDrain = 3 + candidateGate / gain;
    const current = 0.02 * ((candidateGate - 2) * candidateDrain - candidateDrain ** 2 / 2) * (1 + 0.01 * candidateDrain);
    return current - (5 - candidateDrain) / 10;
  };
  let lower = 5;
  let upper = 10;
  if (residual(lower) >= 0 || residual(upper) <= 0) { throw new Error("The independent root must be bracketed."); }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (residual(middle) > 0) { upper = middle; }
    else { lower = middle; }
  }
  const gate = (lower + upper) / 2;
  const drain = 3 + gate / gain;
  return { gate, drain, current: (5 - drain) / 10 };
}

const close = (actual: number, expected: number) => {
  if (!Number.isFinite(actual) || Math.abs(actual / expected - 1) >= 1e-11) {
    throw new Error(`Expected ${expected}; received ${actual}.`);
  }
};

describe("high gain op-amp feedback around a MOS drain", () => {
  it.each([1e5, 1e6, 1e7])("matches the independent DC root at gain=%s in both polarities", (gain) => {
    const expected = operatingPoint(gain);
    for (const sign of [1, -1] as const) {
      const document = circuit(gain, sign);
      const result = analyzeAnalogCircuit(document);
      expect(result.status, result.message).toBe("valid");
      close(result.parts.mos.voltage.real, sign * expected.drain);
      close(result.parts.amp.voltage.real, sign * expected.gate);
      close(result.parts.mos.current.real, sign * expected.current);
      close(result.parts.load.current.real, sign * expected.current);
      expect(result.parts.amp.current.real).toBe(0);
    }
  });

  it.each([1, -1] as const)("preserves the operating point in AC and transient analysis with sign=%s", (sign) => {
    const gain = 1e7;
    const expected = operatingPoint(gain);
    const gm = 0.02 * expected.drain * (1 + 0.01 * expected.drain);
    const overdrive = expected.gate - 2;
    const gds = 0.02 * ((overdrive - expected.drain) * (1 + 0.01 * expected.drain) +
      0.01 * (overdrive * expected.drain - expected.drain ** 2 / 2));
    const response = 1 / (1 + 10 * gds + 10 * gm * gain);
    const ac = analyzeAnalogCircuit(circuit(gain, sign, 1), { mode: "ac" });
    expect(ac.status, ac.message).toBe("valid");
    close(ac.parts.mos.voltage.real, sign * response);
    close(ac.parts.amp.voltage.real, sign * gain * response);
    close(ac.parts.load.current.real, sign * (1 - response) / 10);

    const transient = simulateTransient(circuit(gain, sign), {
      durationSeconds: 1, timeStepSeconds: 1, startFromOperatingPoint: true,
    });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      close(sample.parts.mos.voltageVolts, sign * expected.drain);
      close(sample.parts.amp.voltageVolts, sign * expected.gate);
      close(sample.parts.mos.currentAmps, sign * expected.current);
    }
  });
});
