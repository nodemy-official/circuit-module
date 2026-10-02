import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { addRational, assertCorrectRounding, divideRational, multiplyRational, negateRational, rationalFromNumber } from "../helpers/numeric-oracle.js";

const thermalVoltage = 0.025_85;
const kinds = ["npn-transistor", "pnp-transistor"] as const;
const exactNumber = (value: number) => rationalFromNumber(value)!;

function biasedDevice(kind: typeof kinds[number], beta: number, saturation: number, bias = 1, amplitude = 0) {
  const sign = kind === "npn-transistor" ? 1 : -1;
  return createCircuitFromSpecs([
    ["bias", "ac-source", ["base", "0"], { voltageVolts: amplitude, offsetVolts: sign * bias, phaseDegrees: sign === 1 ? 0 : 180 }],
    ["device", kind, ["base", "base", "0"], { currentGain: beta, saturationCurrentAmps: saturation }],
    ["ground", "ground", ["0"]],
  ], "Low gain BJT junction coefficients");
}

describe("BJT base coefficients with gain below one", () => {
  it.each(kinds)("scales the forward transport current after its exponential boundary for %s", (kind) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    for (const beta of [0.6, 0.75, 0.9]) {
      for (const saturation of [Number.MIN_VALUE, 3 * Number.MIN_VALUE]) {
        const document = biasedDevice(kind, beta, saturation);
        const analog = analyzeAnalogCircuit(document);
        const scalar = analyzeCircuit(document, {}, { mode: "dc" });
        expect(analog.status, analog.message).toBe("valid");
        expect(scalar.status, scalar.message).toBe("closed");
        // Vbc=0, so Ic=Is*expm1(Vbe/Vt), Ib=Ic/beta and Ie=-Ic-Ib.
        const collector = exactNumber(sign * (saturation * Math.expm1(1 / thermalVoltage)));
        const base = divideRational(collector, exactNumber(beta));
        const emitter = negateRational(addRational(collector, base));
        for (const [terminal, expected] of [["a", collector], ["b", base], ["c", emitter]] as const) {
          assertCorrectRounding(analog.parts.device.terminalCurrents[terminal]!.real, expected, `analog ${terminal}`);
          assertCorrectRounding(scalar.parts.device.terminalCurrents![terminal]!, expected, `scalar ${terminal}`);
        }
      }
    }
  });

  it.each(kinds)("preserves the base current at every constant transient sample for %s", (kind) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    const document = biasedDevice(kind, 0.75, Number.MIN_VALUE);
    const expected = divideRational(
      multiplyRational(exactNumber(sign * Number.MIN_VALUE), exactNumber(Math.expm1(1 / thermalVoltage))),
      exactNumber(0.75),
    );
    for (const startFromOperatingPoint of [false, true]) {
      const result = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001, startFromOperatingPoint });
      expect(result.status, result.message).toBe("valid");
      for (const sample of result.samples) {
        assertCorrectRounding(sample.parts.device!.terminalCurrents!.b!, expected, "transient base current");
      }
    }
  });

  it.each(kinds)("preserves the normal forward base derivative in AC for %s", (kind) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    const beta = 0.75;
    const amplitude = 0.001;
    const result = analyzeAnalogCircuit(biasedDevice(kind, beta, Number.MIN_VALUE, 1, amplitude), { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    // The junction slope is evaluated at its binary64 exponential boundary;
    // beta division and the subsequent excitation product remain rational.
    const slope = (Number.MIN_VALUE * Math.exp(1 / thermalVoltage)) / thermalVoltage;
    const expected = multiplyRational(divideRational(exactNumber(slope), exactNumber(beta)), exactNumber(sign * amplitude));
    assertCorrectRounding(result.parts.device.terminalCurrents.b!.real, expected, "normal base derivative");
  });

  it.each(kinds)("does not amplify subnormal transport-derivative rounding in AC for %s", (kind) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    for (const beta of [0.6, 0.75, Number.MIN_VALUE]) {
      const result = analyzeAnalogCircuit(biasedDevice(kind, beta, Number.MIN_VALUE, 0, 1), { mode: "ac" });
      expect(result.status, result.message).toBe("valid");
      const expected = divideRational(exactNumber(sign * Number.MIN_VALUE), multiplyRational(exactNumber(beta), exactNumber(thermalVoltage)));
      assertCorrectRounding(result.parts.device.terminalCurrents.b!.real, expected, "subnormal base derivative");
    }
  });

  it.each(kinds)("retains the amplified base derivative when reverse-biased transport underflows for %s", (kind) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    const amplitude = 0.001;
    const document = createCircuitFromSpecs([
      ["base", "ac-source", ["base", "0"], { voltageVolts: amplitude, offsetVolts: -sign, phaseDegrees: sign === 1 ? 0 : 180 }],
      ["collector", "ac-source", ["collector", "0"], { voltageVolts: 0, offsetVolts: sign }],
      ["device", kind, ["collector", "base", "0"], { currentGain: Number.MIN_VALUE, saturationCurrentAmps: Number.MIN_VALUE }],
      ["ground", "ground", ["0"]],
    ], "Reverse-biased base conductance survives transport underflow");
    const dc = analyzeAnalogCircuit(document);
    const ac = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(dc.status, dc.message).toBe("valid");
    expect(ac.status, ac.message).toBe("valid");
    expect(dc.parts.device.terminalCurrents.b!.real).toBe(-sign);
    const expected = divideRational(
      multiplyRational(exactNumber(sign * amplitude), exactNumber(Math.exp(-1 / thermalVoltage))),
      exactNumber(thermalVoltage),
    );
    assertCorrectRounding(ac.parts.device.terminalCurrents.b!.real, expected, "amplified reverse base derivative");
  });
});
