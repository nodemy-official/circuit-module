import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { exactComplexValue } from "../../exact-numeric-state.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

it.each((["nmos", "pmos"] as const).flatMap((kind) =>
  [0, 0.01, 1e-10].flatMap((lambda) => [2 ** -1000, 1 / 32, 2 ** 900].flatMap((beta) =>
    [false, true].flatMap((reverse) => (["dc", "ac", "transient"] as const).map((mode) => ({ kind, lambda, beta, reverse, mode }))),
  )),
))("reaches the exact unloaded $kind zero-current root (lambda=$lambda, beta=$beta, reverse=$reverse, mode=$mode)", ({ kind, lambda, beta, reverse, mode }) => {
  const pmos = kind === "pmos";
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["supply", "battery", ["v", "0"], { voltageVolts: 4 }],
    ["device", kind, ["out", pmos ? "0" : "v", pmos ? "v" : "0"], {
      thresholdVolts: 1, transconductanceAmpsPerVoltSquared: beta, channelLengthModulation: lambda,
    }],
    ["tie", "ac-source", ["meter", "out"], { voltageVolts: 0, offsetVolts: 0.25, frequencyHz: 1 }],
    ["meter", "voltmeter", ["meter", "0"]],
    ["extra-supply", "battery", ["extra", "0"], { voltageVolts: 1 }],
    ["extra-r", "resistor", ["extra", "junction"], { resistanceOhms: 1000 }],
    ["extra-d", "diode", ["junction", "0"]],
  ];
  const parts = specs.map((spec): CircuitSpec => spec[0] === "device" && reverse
    ? [spec[0], spec[1], [spec[2][2]!, spec[2][1]!, spec[2][0]!], spec[3]] : spec);
  const document = createCircuitFromSpecs(reverse ? parts.toReversed() : parts, "Unloaded MOS and an independent junction");
  if (mode === "transient") {
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples.map((sample) => sample.timeSeconds)).toEqual([0, 0.125]);
    for (const sample of transient.samples) {
      expect(sample.parts.device!.currentAmps).toBe(0);
      expect(sample.parts.device!.voltageVolts).toBe(0);
      expect(sample.parts.meter!.voltageVolts).toBe((pmos ? 4 : 0) + 0.25);
    }
    return;
  }
  const result = analyzeAnalogCircuit(document, mode === "ac" ? { mode: "ac", frequencyHz: 1 } : undefined);
  expect(result.status, result.message).toBe("valid");
  expect(result.parts.device!.voltage.real).toBe(0);
  expect(result.parts.device!.current.real).toBe(0);
  expect(result.parts.meter!.voltage.real).toBe(mode === "dc" ? (pmos ? 4 : 0) + 0.25 : 0);
  if (mode === "ac") {
    expect(result.parts.device!.voltage.imaginary).toBe(0);
    expect(result.parts.device!.current.imaginary).toBe(0);
    expect(result.parts.meter!.voltage.imaginary).toBe(0);
  }
});

it.each(["nmos", "pmos"] as const)("preserves the nonzero $kind voltage needed for a minimum subnormal load", (kind) => {
  const pmos = kind === "pmos";
  const document = createCircuitFromSpecs([
    ["ground", "ground", ["0"]],
    ["supply", "battery", ["v", "0"], { voltageVolts: 1 }],
    ["load", "current-source", pmos ? ["out", "0"] : ["0", "out"], { currentAmps: Number.MIN_VALUE }],
    ["device", kind, ["out", pmos ? "0" : "v", pmos ? "v" : "0"], {
      thresholdVolts: 0, transconductanceAmpsPerVoltSquared: 2 ** 900, channelLengthModulation: 0,
    }],
  ], "A finite load requiring an unrepresentable MOS voltage");
  const result = analyzeAnalogCircuit(document);
  expect(result.status, result.message).toBe("valid");
  expect(result.parts.device!.current.real).toBe((pmos ? -1 : 1) * Number.MIN_VALUE);
  expect(Math.abs(result.parts.device!.voltage.real)).toBe(0);
  expect(exactComplexValue(result.parts.device!.voltage)!.real.numerator).not.toBe(0n);
});
