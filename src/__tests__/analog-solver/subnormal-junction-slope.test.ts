import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalFromNumber,
  subtractRational,
  type Rational,
} from "../helpers/numeric-oracle.js";

const thermalVoltage = 0.025_85;
const amplitude = 0.001;
const gain = 1e308;
const saturation = 1e-320;
const exactNumber = (value: number) => rationalFromNumber(value)!;

// Independent 450-decimal-digit fixed-point Taylor series. Exponent inputs
// are exact binary64 rationals; no production exponential/derivative helpers
// or prematurely rounded subnormal products enter the closed-form oracle.
function exponentialOracle(exponent: Rational) {
  const precision = 10n ** 450n;
  const magnitude = exponent.numerator < 0n ? -exponent.numerator : exponent.numerator;
  let term = precision;
  let sum = term;
  for (let index = 1n; term !== 0n; index += 1n) {
    term = term * magnitude / (exponent.denominator * index);
    sum += term;
  }
  return exponent.numerator < 0n ? rational(precision, sum) : rational(sum, precision);
}

function assertRelative(actual: number, expected: Rational) {
  if (!Number.isFinite(actual) || expected.numerator === 0n) {
    throw new Error(`Invalid relative comparison for ${actual}`);
  }
  const error = divideRational(subtractRational(exactNumber(actual), expected), expected);
  const magnitude = rational(error.numerator < 0n ? -error.numerator : error.numerator, error.denominator);
  if (compareRational(magnitude, exactNumber(1e-10)) !== -1) {
    throw new Error(`Relative error exceeds 1e-10 for ${actual}`);
  }
}

function amplifierSpecs(input: string): CircuitSpec[] {
  return [
    ["amplifier", "op-amp", [input, "0", "output"], { openLoopGain: gain }],
    ["load", "resistor", ["output", "0"], { resistanceOhms: 20 }],
  ];
}

describe("subnormal junction derivatives before AC amplification", () => {
  it.each(["npn-transistor", "pnp-transistor"] as const)("retains the open-base closed-form response for %s", (kind) => {
    const beta = 1e-308;
    const sign = kind === "npn-transistor" ? 1 : -1;
    const collectorBias = 0.1;
    const reverseFactor = exponentialOracle(divideRational(exactNumber(-collectorBias), exactNumber(thermalVoltage)));
    // Ib=0 gives dVb/dVc = beta*exp(-Vc/Vt)/(1+beta*exp(-Vc/Vt)).
    // Is cancels; neither the transport slope nor its binary64 rounding is
    // reused as the expectation. The loaded amplifier multiplies by gain/2.
    const scaledReverse = multiplyRational(exactNumber(beta), reverseFactor);
    const response = divideRational(scaledReverse, addRational(rational(1n), scaledReverse));
    const expectedBase = multiplyRational(exactNumber(amplitude), response);
    const expectedOutput = multiplyRational(expectedBase, divideRational(exactNumber(gain), rational(2n)));
    for (const amplified of [false, true]) {
      const document = createCircuitFromSpecs([
        ["source", "ac-source", ["collector", "0"], { voltageVolts: amplitude, offsetVolts: sign * collectorBias, frequencyHz: 1000 }],
        ["device", kind, ["collector", "base", "0"], { currentGain: beta, saturationCurrentAmps: saturation }],
        ...(amplified ? amplifierSpecs("base") : []),
        ["ground", "ground", ["0"]],
      ], "Open base with a subnormal reverse junction derivative");
      const result = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(result.status, result.message).toBe("valid");
      assertRelative(result.parts.device.terminalVoltages.b!.real, expectedBase);
      expect(result.parts.device.terminalVoltages.b!.imaginary).toBe(0);
      if (amplified) {
        assertRelative(result.parts.amplifier.terminalVoltages.c!.real, expectedOutput);
        assertRelative(result.parts.load.current.real, divideRational(expectedOutput, rational(20n)));
      }
    }
  });

  it.each([-0.1, 0, 0.1])("amplifies the diode response without rounding its subnormal slope at bias %s", (bias) => {
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["input", "0"], { voltageVolts: amplitude, offsetVolts: bias, frequencyHz: 1000 }],
      ["diode", "diode", ["input", "sense"], { saturationCurrentAmps: saturation, emissionCoefficient: 1 }],
      ["sense-load", "resistor", ["sense", "0"], { resistanceOhms: 1 }],
      ...amplifierSpecs("sense"),
      ["ground", "ground", ["0"]],
    ], "Amplified diode small-signal response");
    // The 1-ohm DC drop is below 1e-318 V, so replacing the junction bias
    // with the source bias changes this derivative by less than 1e-316
    // relatively, far below the exponential model's binary64 accuracy.
    const exponential = exponentialOracle(divideRational(exactNumber(bias), exactNumber(thermalVoltage)));
    const slope = divideRational(multiplyRational(exactNumber(saturation), exponential), exactNumber(thermalVoltage));
    const response = divideRational(slope, addRational(rational(1n), slope));
    const expectedOutput = multiplyRational(
      multiplyRational(exactNumber(amplitude), response),
      divideRational(exactNumber(gain), rational(2n)),
    );
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    assertRelative(result.parts.amplifier.terminalVoltages.c!.real, expectedOutput);
    assertRelative(result.parts.load.current.real, divideRational(expectedOutput, rational(20n)));
    expect(result.parts.amplifier.terminalVoltages.c!.imaginary).toBe(0);
  });

  it.each([
    { name: "deep reverse combined logarithm", exponent: -750, ideality: 1e-300, saturationCurrent: 1e-200, excitation: 1e100 },
    { name: "capped continuation with a nonzero subnormal slope", exponent: 90, ideality: 1e33, saturationCurrent: Number.MIN_VALUE, excitation: 1e308 },
    { name: "capped continuation with a binary64-zero slope", exponent: 90, ideality: 1e100, saturationCurrent: Number.MIN_VALUE, excitation: 1e308 },
  ])("preserves the $name boundary", ({ exponent, ideality, saturationCurrent, excitation }) => {
    const bias = exponent * ideality * thermalVoltage;
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["input", "0"], { voltageVolts: excitation, offsetVolts: bias, frequencyHz: 1000 }],
      ["diode", "diode", ["input", "0"], { saturationCurrentAmps: saturationCurrent, emissionCoefficient: ideality }],
      ["ground", "ground", ["0"]],
    ], "Diode exponential derivative boundaries");
    const scale = multiplyRational(exactNumber(ideality), exactNumber(thermalVoltage));
    const exponential = exponentialOracle(exponent > 80 ? rational(80n) : divideRational(exactNumber(bias), scale));
    const slope = divideRational(multiplyRational(exactNumber(saturationCurrent), exponential), scale);
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    if (compareRational(slope, divideRational(exactNumber(Number.MIN_VALUE), rational(2n))) < 0) {
      // The explicit binary64-zero derivative policy remains an AC open,
      // even though exact multiplication by this excitation would survive.
      expect(result.parts.diode.current.real).toBe(0);
      expect(result.parts.diode.acReferenceTerminalGroups).toEqual([]);
    } else {
      assertRelative(result.parts.diode.current.real, multiplyRational(slope, exactNumber(excitation)));
    }
  });
});
