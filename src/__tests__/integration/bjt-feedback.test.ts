import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec as Spec } from "../helpers/circuit-fixture.js";
import { simulateTransient } from "../../transient-solver.js";

const circuit = (specs: readonly Spec[]) =>
  createCircuitFromSpecs(specs, "Independent postfix analog review");

interface FeedbackCase {
  input: number;
  gain: number;
  load: number;
  beta: number;
  common: number;
  reversed: boolean;
}

const defaults: FeedbackCase = { input: 1, gain: 100_000, load: 1000, beta: 100, common: 0, reversed: false };

function feedbackSpecs(sign: number, scenario: FeedbackCase, useAc = false): Spec[] {
  const returnNode = scenario.common === 0 ? "0" : "return";
  const specs: Spec[] = [
    ["ground", "ground", ["0"]],
    ["supply", "battery", sign === 1 ? ["collector", returnNode] : [returnNode, "collector"], { voltageVolts: 5 }],
    ["input", useAc ? "ac-source" : "battery", useAc || sign === 1 ? ["input", returnNode] : [returnNode, "input"], useAc
      ? { voltageVolts: 1e-4, offsetVolts: sign * scenario.input, frequencyHz: 1000, phaseDegrees: 0 }
      : { voltageVolts: scenario.input }],
    ["op", "op-amp", ["input", "emitter", "base"], { openLoopGain: scenario.gain }],
    ["q", sign === 1 ? "npn-transistor" : "pnp-transistor", ["collector", "base", "emitter"], { currentGain: scenario.beta }],
    ["load", "resistor", ["emitter", returnNode], { resistanceOhms: scenario.load }],
  ];
  if (scenario.common !== 0) {
    specs.push(["common", "battery", scenario.common > 0 ? [returnNode, "0"] : ["0", returnNode], { voltageVolts: Math.abs(scenario.common) }]);
  }
  return scenario.reversed ? specs.reverse() : specs;
}

// Independently eliminate Ebers-Moll emitter KCL. Binary64 log/exp are used
// only at the device approximation boundary, without importing solver math.
function feedbackOracle(sign: number, scenario: FeedbackCase, input = scenario.input, previousEmitter = 0, capacitorConductance = 0) {
  const atEmitter = (emitter: number) => {
    const ratio = Math.exp((emitter - 5) / 0.025_85);
    const demand = emitter / scenario.load + capacitorConductance * (emitter - previousEmitter);
    const exponential = (demand / 1e-14 + 1 / scenario.beta)
      / (1 + 1 / scenario.beta - ratio);
    const base = emitter + 0.025_85 * Math.log(exponential);
    const forward = 1e-14 * (exponential - 1);
    const reverse = 1e-14 * (exponential * ratio - 1);
    const baseCurrent = forward / scenario.beta + reverse;
    const target = Math.max(-15, Math.min(15, sign * scenario.gain * (input - emitter)));
    return { emitter, base, baseCurrent, forward, reverse, target,
      residual: scenario.common + sign * (base + 20 * baseCurrent) - target };
  };
  let low = capacitorConductance * previousEmitter / (1 / scenario.load + capacitorConductance);
  let high = 4.999;
  if (!(sign * atEmitter(low).residual < 0 && sign * atEmitter(high).residual > 0)) {
    throw new Error("Independent emitter equation does not bracket a root");
  }
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (sign * atEmitter(middle).residual > 0) { high = middle; }
    else { low = middle; }
  }
  const point = atEmitter((low + high) / 2);
  if (!(Math.abs(point.residual) < 1e-7)) { throw new Error(`Independent root residual: ${point.residual}`); }
  return point;
}

function relative(actual: number, expected: number) {
  return Math.abs((actual - expected) / expected);
}

const scenarios = [
  ...[0.001, 0.01, 0.1, 0.5, 1, 2, 4].map((input) => ({ ...defaults, input })),
  ...[10, 100, 1000, 1e7].map((gain) => ({ ...defaults, gain })),
  ...[1, 10, 100, 1e6].map((load) => ({ ...defaults, load })),
  ...[1, 10, 1000, 1e5].map((beta) => ({ ...defaults, beta })),
  ...[-3, -1, 1, 3].map((common) => ({ ...defaults, common })),
  { ...defaults, reversed: true },
];

describe("BJT feedback across DC, AC and transient analysis", () => {
  for (const sign of [1, -1]) {
    it.each(scenarios)(`DC sign=${sign}, input=$input gain=$gain load=$load beta=$beta common=$common reversed=$reversed`, (scenario) => {
      const expected = feedbackOracle(sign, scenario);
      const result = analyzeAnalogCircuit(circuit(feedbackSpecs(sign, scenario)), { mode: "dc" });
      expect(result.status, result.message).toBe("valid");
      expect(relative(result.parts.load!.voltage.real, sign * expected.emitter)).toBeLessThan(2e-9);
      expect(relative(result.parts.q!.terminalVoltages.b!.real, scenario.common + sign * expected.base)).toBeLessThan(2e-9);
      expect(relative(result.parts.q!.terminalCurrents.a!.real, sign * (expected.forward - 2 * expected.reverse))).toBeLessThan(2e-9);
      expect(relative(result.parts.q!.terminalCurrents.b!.real, sign * expected.baseCurrent)).toBeLessThan(2e-9);
      const emitterCurrent = result.parts.q!.terminalCurrents.c!.real;
      const loadCurrent = result.parts.load!.current.real;
      expect(Math.abs(emitterCurrent + loadCurrent) / Math.abs(loadCurrent)).toBeLessThan(2e-10);
      expect(Math.abs(result.parts.op!.terminalCurrents.c!.real + result.parts.q!.terminalCurrents.b!.real)
        / Math.abs(expected.baseCurrent)).toBeLessThan(2e-10);
    }, 180_000);
  }

  it.each([1, -1])("AC sign=%s agrees with the derivative of the independent scalar root", (sign) => {
    const dc = feedbackOracle(sign, defaults);
    const ratio = Math.exp((dc.emitter - 5) / 0.025_85);
    const denominator = 1 + 1 / defaults.beta - ratio;
    const exponential = dc.forward / 1e-14 + 1;
    const exponentialDerivative = (1 / (defaults.load * 1e-14) + exponential * ratio / 0.025_85) / denominator;
    const baseDerivative = 1 + 0.025_85 * exponentialDerivative / exponential;
    const baseCurrentDerivative = 1e-14 * (exponentialDerivative / defaults.beta
      + exponentialDerivative * ratio + exponential * ratio / 0.025_85);
    const emitterGain = defaults.gain / (defaults.gain + baseDerivative + 20 * baseCurrentDerivative);
    const result = analyzeAnalogCircuit(circuit(feedbackSpecs(sign, defaults, true)), { mode: "ac", frequencyHz: 1000 });
    expect(result.status, result.message).toBe("valid");
    expect(relative(result.parts.load!.voltage.real, emitterGain * 1e-4)).toBeLessThan(2e-9);
    expect(relative(result.parts.q!.terminalVoltages.b!.real, emitterGain * baseDerivative * 1e-4)).toBeLessThan(2e-9);
    expect(result.parts.load!.voltage.imaginary).toBe(0);
  }, 30_000);

  it.each([1, -1])("transient sign=%s retains a static feedback root in every sample", (sign) => {
    const expected = feedbackOracle(sign, defaults);
    const result = simulateTransient(circuit(feedbackSpecs(sign, defaults)), { durationSeconds: 0.002, timeStepSeconds: 0.001 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    for (const sample of result.samples) {
      expect(relative(sample.parts.load!.voltageVolts, sign * expected.emitter)).toBeLessThan(2e-9);
    }
  }, 120_000);

  it.each([1, -1])("stored-state transient sign=%s agrees with independent backward-Euler KCL", (sign) => {
    const specs = feedbackSpecs(sign, defaults, true);
    const inputSpec = specs.find(([id]) => id === "input")!;
    specs[specs.indexOf(inputSpec)] = ["input", "ac-source", ["input", "0"], {
      voltageVolts: 0.01, offsetVolts: sign, phaseDegrees: 90, frequencyHz: 1000,
    }];
    specs.push(["capacitor", "capacitor", ["emitter", "0"], { capacitanceFarads: 1e-6 }]);
    const result = simulateTransient(circuit(specs), {
      durationSeconds: 0.0002, timeStepSeconds: 0.0001, startFromOperatingPoint: true,
    });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    let expected = feedbackOracle(sign, defaults);
    for (const [index, sample] of result.samples.entries()) {
      if (index > 0) {
        const input = 1 - sign * Math.SQRT2 * 0.01 * Math.sin(2 * Math.PI * 1000 * sample.timeSeconds);
        expected = feedbackOracle(sign, defaults, input, expected.emitter, 1e-6 / 0.0001);
      }
      expect(relative(sample.parts.load!.voltageVolts, sign * expected.emitter)).toBeLessThan(2e-9);
      const reading = sample.parts.q!;
      const currentSum = reading.terminalCurrents!.c! + sample.parts.load!.currentAmps + sample.parts.capacitor!.currentAmps;
      expect(Math.abs(currentSum) / Math.abs(sample.parts.load!.currentAmps)).toBeLessThan(2e-9);
    }
  }, 30_000);
});
