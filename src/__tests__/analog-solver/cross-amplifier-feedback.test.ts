import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  type CircuitSpec,
  createCircuitFromSpecs,
} from "../helpers/circuit-fixture.js";

// Independent diode equation and amplifier/load KCL, with no solver helpers.
function operatingPoint(gain: number) {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const sense = (low + high) / 2;
    const second = sense + 0.025_85 * Math.log1p(sense / 1e-9);
    const residual = gain * (1 - sense) - (1 + 1 / gain) * second
      - (20 / gain) * sense / 1000;
    if (residual > 0) {
      low = sense;
    } else {
      high = sense;
    }
  }
  const sense = (low + high) / 2;
  const expectedSecond = sense + 0.025_85 * Math.log1p(sense / 1e-9);
  const expectedFirst = (1 + 1 / gain) * expectedSecond
    + (20 / gain) * sense / 1000;
  return { sense, expectedFirst, expectedSecond, current: sense / 1000 };
}

describe("cross-amplifier nonlinear feedback", () => {
  it.each([false, true])(
    "preserves linear feedback with an unloaded diode leaf and observer, reversed=%s",
    (reverse) => {
      const gain = 1e308;
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["bias", "battery", ["bias", "0"], { voltageVolts: 2 }],
        ["first", "op-amp", ["bias", "sense", "out"], { openLoopGain: gain }],
        ["feedback", "resistor", ["out", "sense"], { resistanceOhms: 10_000 }],
        ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
        ["leaf", "diode", ["sense", "leaf"]],
        ["observer", "op-amp", ["out", "leaf", "observer-out"], { openLoopGain: gain }],
        ["observer-load", "resistor", ["observer-out", "0"], { resistanceOhms: 1000 }],
      ];
      const document = createCircuitFromSpecs(
        reverse ? specs.reverse() : specs,
        "Linear feedback with a nonlinear observer leaf",
      );
      const result = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(result.status, result.message).toBe("valid");
      expect(Math.abs(result.parts.first.voltage.real - 15 * 11_000 / 11_020)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.load.current.real / (15 / 11_020) - 1)).toBeLessThan(1e-10);
      expect(result.parts.leaf.current.real).toBe(0);
      expect(result.parts.leaf.voltage.real).toBe(0);
    },
  );

  it.each([
    { gain: 1000, reverse: false },
    { gain: 1000, reverse: true },
    { gain: 1e308, reverse: false },
    { gain: 1e308, reverse: true },
  ])(
    "preserves a nonlinear observer leaf when its output returns to the sense input, gain=$gain, reversed=$reverse",
    ({ gain, reverse }) => {
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["bias", "battery", ["bias", "0"], { voltageVolts: 2 }],
        ["first", "op-amp", ["bias", "sense", "out"], { openLoopGain: gain }],
        ["feedback", "resistor", ["out", "sense"], { resistanceOhms: 10_000 }],
        ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
        ["leaf", "diode", ["leaf", "sense"]],
        ["observer", "op-amp", ["out", "leaf", "observer-out"], { openLoopGain: gain }],
        ["observer-return", "resistor", ["observer-out", "sense"], { resistanceOhms: 10_000 }],
      ];
      const document = createCircuitFromSpecs(
        reverse ? specs.reverse() : specs,
        "Linear feedback with an observer return",
      );
      // KCL with the observer's internal drive saturated at 15 V and both
      // amplifiers' 20-ohm output resistances gives this linear solution.
      const expectedSense = gain === 1e308 ? 2 : (2 * gain + 15) / (gain + 12.02);
      const expectedCurrent = expectedSense / 1000;
      const expectedObserver = (15_000 + 2 * expectedSense) / 1002;
      const expectedOutput = 12 * expectedSense - expectedObserver;
      const result = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(result.status, result.message).toBe("valid");
      expect(Math.abs(result.parts.first.voltage.real - expectedOutput)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.observer.voltage.real - expectedObserver)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.load.current.real / expectedCurrent - 1)).toBeLessThan(1e-10);
      expect(result.parts.leaf.current.real).toBe(0);
      expect(result.parts.leaf.voltage.real).toBe(0);
    },
  );

  it.each([
    { gain: 1000, reverse: false },
    { gain: 1000, reverse: true },
    { gain: 100_000, reverse: false },
    { gain: 100_000, reverse: true },
  ])(
    "solves feedback through a follower and diode, gain=$gain, reversed=$reverse",
    ({ gain, reverse }) => {
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["bias", "battery", ["bias", "0"], { voltageVolts: 1 }],
        ["first", "op-amp", ["bias", "sense", "first-out"], { openLoopGain: gain }],
        ["follower", "op-amp", ["first-out", "second-out", "second-out"], { openLoopGain: gain }],
        ["diode", "diode", ["second-out", "sense"], { saturationCurrentAmps: 1e-12 }],
        ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
      ];
      const document = createCircuitFromSpecs(
        reverse ? specs.reverse() : specs,
        "Feedback through an amplifier follower",
      );
      const expected = operatingPoint(gain);
      const result = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(result.status, result.message).toBe("valid");
      expect(Math.abs(result.parts.load.voltage.real - expected.sense)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.first.voltage.real - expected.expectedFirst)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.follower.voltage.real - expected.expectedSecond)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.load.current.real / expected.current - 1)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts.diode.current.real / expected.current - 1)).toBeLessThan(1e-10);
    },
  );
});
