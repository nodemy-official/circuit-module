import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { exactComplexValue } from "../../exact-numeric-state.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { addRational, compareRational, divideRational, multiplyRational, rational, rationalFromNumber, subtractRational, type Rational } from "../helpers/numeric-oracle.js";

function relativelyClose(actual: Rational, expected: Rational) {
  const error = divideRational(subtractRational(actual, expected), expected);
  const absolute = rational(error.numerator < 0n ? -error.numerator : error.numerator, error.denominator);
  return compareRational(absolute, rational(1n, 1_000_000_000_000n)) === -1;
}

describe("junction voltages below the binary64 range", () => {
  it.each((["diode", "led"] as const).flatMap((kind) =>
    [Number.MIN_VALUE, 1e-320, 1e-300].flatMap((ideality) => [1, -1].map((sign) => ({ kind, ideality, sign }))),
  ))("keeps the finite $kind current with ideality $ideality and polarity $sign", ({ kind, ideality, sign }) => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["source", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 1e-300 }],
      ["resistor", "resistor", ["supply", "junction"], { resistanceOhms: 1 }],
      ["junction", kind, ["junction", "0"], { saturationCurrentAmps: 1e-200, emissionCoefficient: ideality }],
    ], "Finite current through an unrepresentable junction voltage");
    // The monotonic equation is V + Is*expm1(V/(n*Vt)) = Vs.
    // |V| < n*Vt*|log1p(+/-Vs/Is)| < 3e-402, hence I differs from Vs/R
    // by less than 3e-102 relatively. V rounds to zero, but I does not.
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.junction!.voltage.real)).toBe(0);
    expect(Math.abs(dc.parts.junction!.current.real / (sign * 1e-300) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(dc.parts.resistor!.current.real / (sign * 1e-300) - 1)).toBeLessThan(1e-12);
    const acDocument = { ...document, parts: document.parts.map((part) => part.id === "source"
      ? { ...part, kind: "ac-source" as const, offsetVolts: 1e-300, voltageVolts: 1e-300, frequencyHz: 1000, phaseDegrees: 0 }
      : part) };
    const ac = analyzeAnalogCircuit(acDocument, { mode: "ac" });
    expect(ac.status, ac.message).toBe("valid");
    // g = Is*exp(V/(n*Vt))/(n*Vt) > 1e101 S, so 1/(R+1/g)
    // differs from 1/R by less than 1e-101 relatively.
    expect(Math.abs(ac.parts.junction!.current.real / (sign * 1e-300) - 1)).toBeLessThan(1e-12);
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.junction!.voltageVolts)).toBe(0);
      expect(Math.abs(sample.parts.junction!.currentAmps / (sign * 1e-300) - 1)).toBeLessThan(1e-12);
    }
  });

  it.each((["diode", "led"] as const).flatMap((kind) =>
    [Number.MIN_VALUE, 1e-320, 1e-300].flatMap((ideality) => [1e-200, 1e-100].map((current) => ({ kind, ideality, current }))),
  ))("balances a current-driven $kind at $current A with ideality $ideality", ({ kind, ideality, current }) => {
    const saturation = 1e-200;
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["source", "current-source", ["0", "junction"], { currentAmps: current }],
      ["junction", kind, ["junction", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: ideality }],
    ], "Subnormal junction voltage and tangent continuation");
    const number = (value: number) => rationalFromNumber(value)!;
    const scale = multiplyRational(number(ideality), number(0.025_85));
    // Invert Shockley at I=Is. Above the model's x=80 knee, invert the
    // affine continuation I=Is*(exp(80)*(x-79)-1) independently.
    const exponent = current === saturation ? number(Math.LN2)
      : addRational(rational(79n), divideRational(
        addRational(number(current), number(saturation)),
        multiplyRational(number(saturation), number(Math.exp(80))),
      ));
    const expectedVoltage = multiplyRational(scale, exponent);
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    const voltage = exactComplexValue(result.parts.junction!.voltage)!.real;
    expect(voltage.numerator).not.toBe(0n);
    expect(relativelyClose(voltage, expectedVoltage)).toBe(true);
    expect(Math.abs(result.parts.junction!.current.real / current - 1)).toBeLessThan(1e-12);
  });
});
