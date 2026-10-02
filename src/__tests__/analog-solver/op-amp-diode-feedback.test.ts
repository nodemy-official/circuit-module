import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const gain = 1e7;
const resistance = 1000;
const inputMagnitude = 1;
const cases = (["diode", "led"] as const).flatMap((kind) =>
  [1, -1].flatMap((sign) => [false, true].map((reordered) => ({ kind, sign, reordered }))),
);

function feedbackDocument(kind: "diode" | "led", sign: number, amplitude = 0, isolatedBjt = false, reordered = false) {
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["input", "ac-source", ["input", "0"], {
      offsetVolts: sign * inputMagnitude,
      voltageVolts: amplitude,
      phaseDegrees: 0,
    }],
    ["op", "op-amp", ["input", "feedback", "control"], {
      openLoopGain: gain,
      positiveRailVolts: 15,
      negativeRailVolts: -15,
    }],
    ["load", "resistor", ["feedback", "0"], { resistanceOhms: resistance }],
    ["device", kind, sign === 1 ? ["control", "feedback"] : ["feedback", "control"]],
  ];
  if (isolatedBjt) {
    specs.push(["isolated", "npn-transistor", ["isolated-c", "isolated-b", "isolated-e"]]);
  }
  return createCircuitFromSpecs(reordered ? specs.reverse() : specs, "High-gain op-amp feedback through a junction");
}

function feedbackOracle(kind: "diode" | "led") {
  const saturation = kind === "diode" ? 1e-12 : 1e-20;
  const thermalScale = kind === "diode" ? 0.025_85 : 2 * 0.025_85;
  const atError = (error: number) => {
    const output = inputMagnitude - error;
    const current = output / resistance;
    const drop = thermalScale * Math.log1p(current / saturation);
    const drive = output + drop + 20 * current;
    return { output, current, drop, drive, residual: gain * error - drive };
  };
  // KCL gives I=Vout/R; Shockley gives Vd=nVt*log1p(I/Is).
  // The amplifier's internal drive is Vout+Vd+20*I=G*(Vin-Vout).
  // Solve the input error directly, avoiding cancellation in G*(Vin-Vout).
  let low = 0;
  let high = inputMagnitude;
  if (!(atError(low).residual < 0 && atError(high).residual > 0)) {
    throw new Error("The independent feedback equation has no bracketed root");
  }
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (atError(middle).residual > 0) { high = middle; }
    else { low = middle; }
  }
  const solution = atError((low + high) / 2);
  if (!(Math.abs(solution.residual) < 2e-14 && solution.drive < 15)) {
    throw new Error("The independent feedback root must be accurate and inside the output rail");
  }
  const driveDerivative = 1 + thermalScale / (solution.output + resistance * saturation) + 20 / resistance;
  return { ...solution, outputGain: gain / (gain + driveDerivative) };
}

function relativeError(actual: number, expected: number) {
  return Math.abs((actual - expected) / expected);
}

describe("high-gain op-amp feedback without a BJT", () => {
  it.each(cases)("solves the unique DC root through $kind with sign $sign (reordered=$reordered)", ({ kind, sign, reordered }) => {
    const expected = feedbackOracle(kind);
    const analysis = analyzeAnalogCircuit(feedbackDocument(kind, sign, 0, false, reordered));
    expect(analysis.status, analysis.message).toBe("valid");
    expect(relativeError(analysis.parts.load!.voltage.real, sign * expected.output)).toBeLessThan(2e-10);
    expect(relativeError(analysis.parts.device!.voltage.real, expected.drop)).toBeLessThan(2e-10);
    expect(relativeError(analysis.parts.device!.current.real, expected.current)).toBeLessThan(2e-10);
    expect(relativeError(analysis.parts.op!.current.real, -sign * expected.current)).toBeLessThan(2e-10);
    expect(Math.abs(analysis.parts.op!.current.real + analysis.parts.load!.current.real)).toBeLessThan(1e-13);
  }, 30_000);

  it.each(cases)("preserves the independently differentiated AC gain through $kind with sign $sign (reordered=$reordered)", ({ kind, sign, reordered }) => {
    const expected = feedbackOracle(kind);
    const amplitude = 1e-4;
    const analysis = analyzeAnalogCircuit(feedbackDocument(kind, sign, amplitude, false, reordered), { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("valid");
    const voltage = amplitude * expected.outputGain;
    expect(relativeError(analysis.parts.load!.voltage.real, voltage)).toBeLessThan(2e-10);
    expect(relativeError(analysis.parts.device!.current.real, sign * voltage / resistance)).toBeLessThan(2e-10);
    expect(relativeError(analysis.parts.op!.current.real, -voltage / resistance)).toBeLessThan(2e-10);
    expect(analysis.parts.load!.voltage.imaginary).toBe(0);
  }, 30_000);

  it.each(cases)("retains the static $kind feedback root in transient samples with sign $sign (reordered=$reordered)", ({ kind, sign, reordered }) => {
    const expected = feedbackOracle(kind);
    const analysis = simulateTransient(feedbackDocument(kind, sign, 0, false, reordered), {
      durationSeconds: 0.001,
      timeStepSeconds: 0.001,
    });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.samples).toHaveLength(2);
    for (const sample of analysis.samples) {
      expect(relativeError(sample.parts.load!.voltageVolts, sign * expected.output)).toBeLessThan(2e-10);
      expect(relativeError(sample.parts.device!.currentAmps, expected.current)).toBeLessThan(2e-10);
      expect(relativeError(sample.parts.op!.currentAmps, -sign * expected.current)).toBeLessThan(2e-10);
    }
  }, 30_000);

  it("does not require an unrelated floating BJT to resolve diode feedback", () => {
    const expected = feedbackOracle("diode");
    for (const isolatedBjt of [false, true]) {
      const analysis = analyzeAnalogCircuit(feedbackDocument("diode", 1, 0, isolatedBjt));
      expect(analysis.status, analysis.message).toBe("valid");
      expect(relativeError(analysis.parts.load!.voltage.real, expected.output)).toBeLessThan(2e-10);
    }
  }, 30_000);
});
