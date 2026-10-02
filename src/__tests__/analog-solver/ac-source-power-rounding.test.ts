import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { assertCorrectRounding, divideRational, multiplyRational, rational, rationalFromNumber } from "../helpers/numeric-oracle.js";

describe("AC voltage-branch power before magnitude normalization", () => {
  it.each([3, 5, 7])("rounds the battery internal loss once at amplitude factor %s", (factor) => {
    const amplitude = factor * 2 ** -537;
    const resistance = 12;
    const document = createCircuitFromSpecs([
      ["first", "ac-source", ["positive", "middle"], { voltageVolts: amplitude, frequencyHz: 100, phaseDegrees: 45 }],
      ["second", "ac-source", ["middle", "negative"], { voltageVolts: amplitude, frequencyHz: 100, phaseDegrees: -45 }],
      ["battery", "battery", ["positive", "negative"], { voltageVolts: 1, internalResistanceOhms: resistance }],
    ], "Subnormal internal resistance dissipation after phase cancellation");
    // The sum of equal +45/-45 degree phasors is sqrt(2)*A, hence P=2*A^2/R.
    // With factor=3 this is exactly 1.5*MIN_VALUE, whose tie rounds upward
    // to the even significand 2. No production power/normalization helper is used.
    const exactAmplitude = rationalFromNumber(amplitude)!;
    const expectedPower = divideRational(
      multiplyRational(rational(2n), multiplyRational(exactAmplitude, exactAmplitude)), rational(12n),
    );
    const analog = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 100 });
    expect(analog.status, analog.message).toBe("valid");
    assertCorrectRounding(analog.parts.battery!.power.real, expectedPower, "battery absorbed power");
    expect(analog.parts.battery!.power.imaginary).toBe(0);
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 100 });
    expect(scalar.status, scalar.message).toBe("closed");
    assertCorrectRounding(scalar.parts.battery!.powerWatts, expectedPower, "scalar battery power");
  });
});
