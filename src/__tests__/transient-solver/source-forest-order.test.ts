import { expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import { nextDown, nextUp } from "../helpers/numeric-oracle.js";

const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

function sourceLoop(phase: number, amplitude: number, order: number[], initialVoltage: number | undefined, grounded: boolean, ids = ["first", "second", "total"]) {
  const sources: CircuitSpec[] = [
    [ids[0]!, "ac-source", ["v", "m"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: phase - 60 }],
    [ids[1]!, "ac-source", ["m", "0"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: phase + 60 }],
    [ids[2]!, "ac-source", ["v", "0"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: phase }],
  ];
  const specs = order.map((index) => sources[index]!);
  if (initialVoltage !== undefined) {
    specs.push(["cap", "capacitor", ["v", "0"], { capacitanceFarads: 1 / amplitude, initialVoltageVolts: initialVoltage }]);
  }
  if (grounded) { specs.push(["ground", "ground", ["0"]]); }
  return createCircuitFromSpecs(specs, "Equivalent ideal AC source constraints in different orders");
}

it.each([0, 45, 90, 135, 180, 225, 270, 315].flatMap((phase) =>
  [2 ** -1000, 1, 2 ** 400].map((amplitude) => ({ phase, amplitude })),
))("accepts the exact axis/diagonal initial voltage in every source order (phase=$phase, amplitude=$amplitude)", ({ phase, amplitude }) => {
  // cos(x-60deg)+cos(x+60deg)=cos(x). The direct source has
  // sqrt(2)*cos(phase) = +/-sqrt(2), +/-1, or exactly zero.
  const normalizedVoltage = [Math.SQRT2, 1, 0, -1, -Math.SQRT2, -1, 0, 1][phase / 45]!;
  const normalizedSine = [0, 1, Math.SQRT2, 1, 0, -1, -Math.SQRT2, -1][phase / 45]!;
  const initialVoltage = amplitude * normalizedVoltage;
  for (const order of permutations) {
    for (const grounded of [false, true]) {
      const document = sourceLoop(phase, amplitude, order, initialVoltage, grounded);
      const result = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples[0]!.parts.cap!.voltageVolts).toBe(initialVoltage);
      expect(result.samples[0]!.parts.total!.voltageVolts).toBe(initialVoltage);
      const expectedCurrent = -2 * Math.PI * normalizedSine;
      const current = result.samples[0]!.parts.cap!.currentAmps;
      if (expectedCurrent === 0) { expect(current).toBe(0); }
      else { expect(Math.abs(current / expectedCurrent - 1)).toBeLessThan(2e-14); }
    }
  }
});

it.each([17, 37, 73, 200, 330])("keeps the waveform basis and initial condition independent of source IDs at %s degrees", (phase) => {
  const options = { durationSeconds: 0.25, timeStepSeconds: 0.125 };
  const baseline = simulateTransient(sourceLoop(phase, 1, permutations[0]!, undefined, true), options);
  expect(baseline.status, baseline.message).toBe("valid");
  const initialVoltage = baseline.samples[0]!.parts.total!.voltageVolts;
  if (phase === 37) { expect(initialVoltage).toBe(1.129_441_169_701_635_8); }
  for (const ids of [["a", "b", "z"], ["z", "y", "a"], ["__proto__", "constructor", "toString"]]) {
    for (const order of permutations) {
      const result = simulateTransient(sourceLoop(phase, 1, order, initialVoltage, true, ids), options);
      expect(result.status, result.message).toBe("valid");
      expect(result.samples.map((sample) => sample.parts.cap!.voltageVolts))
        .toEqual(baseline.samples.map((sample) => sample.parts.total!.voltageVolts));
      for (const voltage of [nextDown(initialVoltage), nextUp(initialVoltage)]) {
        expect(simulateTransient(sourceLoop(phase, 1, order, voltage, true, ids), options).status).toBe("invalid");
      }
    }
  }
});

it.each([17, 37, 73])("preserves a general-phase source basis and capacitor history in all orders at %s degrees", (phase) => {
  const options = { durationSeconds: 0.25, timeStepSeconds: 0.125 };
  const sourceOnly = simulateTransient(sourceLoop(phase, 1, permutations[0]!, undefined, true), options);
  expect(sourceOnly.status, sourceOnly.message).toBe("valid");
  const initialVoltage = sourceOnly.samples[0]!.parts.total!.voltageVolts;
  let reference: number[] | undefined;
  for (const order of permutations) {
    for (const grounded of [false, true]) {
      const result = simulateTransient(sourceLoop(phase, 1, order, initialVoltage, grounded), options);
      expect(result.status, result.message).toBe("valid");
      const voltages = result.samples.map((sample) => sample.parts.cap!.voltageVolts);
      reference ??= voltages;
      expect(voltages).toEqual(reference);
      for (const sample of result.samples) {
        const analytic = Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + phase * Math.PI / 180);
        expect(Math.abs(sample.parts.cap!.voltageVolts - analytic)).toBeLessThan(2e-14);
      }
    }
  }
});

it.each(permutations)("rejects an adjacent initial voltage in source order %j", (...order) => {
  for (const voltage of [nextDown(1), nextUp(1)]) {
    const result = simulateTransient(sourceLoop(45, 1, order, voltage, true), { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  }
});
