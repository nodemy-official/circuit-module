import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import { addRational, assertCorrectRounding, multiplyRational, negateRational, rational, rationalFromNumber } from "../helpers/numeric-oracle.js";

// Nearly flat MOS roots require many exact Newton steps on a busy CPU.
const weakSlopeTimeoutMs = 60_000;

it.each([12, 24, 26].flatMap((exponent) => ["n", "p"].flatMap((weak) =>
  [2 ** -1000, 1, 2 ** 900].flatMap((scale) => [0, 2 ** -100].flatMap((lambda) =>
    [false, true].flatMap((reverse) => [false, true].flatMap((reverseOrder) =>
      (["dc", "ac", "transient"] as const).map((mode) => ({ exponent, weak, scale, lambda, reverse, reverseOrder, mode })),
    )),
  )),
)))("resolves unequal CMOS currents beside a balanced flat island ($mode, exponent=$exponent, weak=$weak, scale=$scale, lambda=$lambda, reverse=$reverse, reverseOrder=$reverseOrder)", ({ exponent, weak, scale, lambda, reverse, reverseOrder, mode }) => {
  const delta = 2 ** -exponent;
  const beta = scale / 32;
  const weakBeta = beta * (1 - delta * delta);
  const output = weak === "n" ? 3 + delta : 1 - delta;
  const orientation = reverse ? -1 : 1;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["supply", "battery", ["v", "0"], { voltageVolts: 4 }],
    ["input", "ac-source", ["in", "0"], { voltageVolts: 0, offsetVolts: 2, frequencyHz: 1 }],
    ["n", "nmos", reverse ? ["0", "in", "out"] : ["out", "in", "0"], {
      thresholdVolts: 1, transconductanceAmpsPerVoltSquared: weak === "n" ? weakBeta : beta, channelLengthModulation: lambda,
    }],
    ["p", "pmos", reverse ? ["v", "in", "out"] : ["out", "in", "v"], {
      thresholdVolts: 1, transconductanceAmpsPerVoltSquared: weak === "p" ? weakBeta : beta, channelLengthModulation: lambda,
    }],
    ["tie", "ac-source", ["other-out", "out"], { voltageVolts: 0, offsetVolts: 0.25, frequencyHz: 1 }],
    ["meter", "voltmeter", ["other-out", "0"]],
    ["other-input", "ac-source", ["other-in", "0"], { voltageVolts: 0, offsetVolts: 2, frequencyHz: 1 }],
    ["other-n", "nmos", ["free", "other-in", "0"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: beta, channelLengthModulation: 0 }],
    ["other-p", "pmos", ["free", "other-in", "v"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: beta, channelLengthModulation: 0 }],
  ];
  // The weak channel saturates at beta*(1-delta^2)/2. The strong
  // channel must be triode: x-x^2/2=(1-delta^2)/2, hence x=1-delta.
  // The equal-beta island has a free saturation voltage and cannot
  // balance the primary output's mismatch or determine its voltage.
  // At lambda=2^-100, the root shift is bounded by 4*lambda/delta
  // (<=2^-72 V), far below the half-ulp of these dyadic roots. The gain
  // perturbation is likewise below a half-ulp of the driven AC output.
  const document = createCircuitFromSpecs(reverseOrder ? specs.toReversed() : specs, "Unequal flat CMOS and a balanced free island");
  if (mode === "transient") {
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(orientation * sample.parts.n!.voltageVolts).toBe(output);
      expect(sample.parts.meter!.voltageVolts).toBe(output + 0.25);
      expect(sample.parts.n!.currentAmps).toBe(-sample.parts.p!.currentAmps);
    }
    return;
  }
  if (mode === "ac") {
    const amplitude = delta / 1024;
    const acDocument = { ...document, parts: document.parts.map((part) => part.id === "input" ? { ...part, voltageVolts: amplitude } : part) };
    const ac = analyzeAnalogCircuit(acDocument, { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    // gm_total/gds = (2-delta-delta^2)/delta; drive=delta/1024.
    const d = rationalFromNumber(delta)!;
    const expected = negateRational(multiplyRational(addRational(rational(2n),
      negateRational(addRational(d, multiplyRational(d, d)))), rational(BigInt(orientation), 1024n)));
    assertCorrectRounding(ac.parts.n!.voltage.real, expected, "Asymmetric flat CMOS gain");
    expect(ac.parts.n!.voltage.imaginary).toBe(0);
    return;
  }
  const dc = analyzeAnalogCircuit(document);
  expect(dc.status, dc.message).toBe("valid");
  expect(orientation * dc.parts.n!.voltage.real).toBe(output);
  expect(dc.parts.meter!.voltage.real).toBe(output + 0.25);
  expect(dc.parts.n!.current.real).toBe(-dc.parts.p!.current.real);
  expect(dc.parts["other-n"]!.voltage.real).toBeGreaterThanOrEqual(1);
  expect(dc.parts["other-n"]!.voltage.real).toBeLessThanOrEqual(3);
}, weakSlopeTimeoutMs);
