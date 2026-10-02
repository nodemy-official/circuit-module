import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analysisAtTransientFrame } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { addRational, assertCorrectRounding, divideRational, multiplyRational, rationalFromNumber } from "../helpers/numeric-oracle.js";

const voltage = 2 ** -538;

function bulbCircuit(mode: "dc" | "ac", phaseDegrees = 0, grounded = true) {
  return createCircuitFromSpecs([
    ["source", mode === "dc" ? "battery" : "ac-source", ["supply", "return"], {
      voltageVolts: voltage, frequencyHz: 1, phaseDegrees,
    }],
    ["bulb", "bulb", ["supply", "return"], { resistanceOhms: 1, ratedPowerWatts: Number.MIN_VALUE }],
    ...(grounded ? [["ground", "ground", ["return"]] as const] : []),
  ], "Subnormal brightness");
}

describe("brightness before display rounding", () => {
  it.each([0, 30, 45, 90, 135])("preserves AC bulb brightness at %s degrees after power underflows", (phase) => {
    const document = bulbCircuit("ac", phase);
    const analog = analyzeAnalogCircuit(document, { mode: "ac" });
    const scalar = analyzeCircuit(document, {}, { mode: "ac" });
    expect(analog.status, analog.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    expect(analog.parts.bulb.power.real).toBe(0);
    expect(scalar.parts.bulb.powerWatts).toBe(0);
    expect(analog.parts.bulb.brightness).toBeCloseTo(0.25, 14);
    expect(scalar.parts.bulb.brightness).toBeCloseTo(0.25, 14);
  });

  it("preserves DC bulb brightness in both solvers", () => {
    const document = bulbCircuit("dc");
    const analog = analyzeAnalogCircuit(document);
    const scalar = analyzeCircuit(document);
    expect(analog.status, analog.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    expect(analog.parts.bulb.brightness).toBe(0.25);
    expect(scalar.parts.bulb.brightness).toBe(0.25);

    const legacy = analyzeCircuit(bulbCircuit("dc", 0, false));
    expect(legacy.status, legacy.message).toBe("closed");
    // Legacy solver adds 1 microohm for each of two wires and the battery.
    const resistance = addRational({ numerator: 1n, denominator: 1n }, multiplyRational(rationalFromNumber(1e-6)!, { numerator: 3n, denominator: 1n }));
    const exactVoltage = rationalFromNumber(voltage)!;
    const current = divideRational(exactVoltage, resistance);
    const brightness = divideRational(multiplyRational(current, current), rationalFromNumber(Number.MIN_VALUE)!);
    expect(legacy.parts.bulb.powerWatts).toBe(0);
    assertCorrectRounding(legacy.parts.bulb.brightness!, brightness, "legacy bulb brightness");
  });

  it("preserves brightness in serialized transient frames", () => {
    const document = bulbCircuit("dc");
    const original = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      for (const sampleIndex of [0, 1]) {
        const frame = analysisAtTransientFrame(document, { analysis, sampleIndex })!;
        expect(frame.parts.bulb.powerWatts).toBe(0);
        assertCorrectRounding(frame.parts.bulb.brightness!, { numerator: 1n, denominator: 4n }, "transient bulb brightness");
      }
    }
  });

  it.each([1, 2, 3, 4])("compares bulb overload before subnormal rounding at voltage scale %s", (scale) => {
    const document = bulbCircuit("dc", 0, false);
    document.parts[0]!.voltageVolts = scale * voltage;
    const result = analyzeCircuit(document);
    expect(result.status, result.message).toBe("closed");
    const warnings = result.issues.filter((issue) => issue.partId === "bulb" && issue.severity === "warning");
    // P/rated = scale²/[4*(1+3e-6)²]; this is above 1.5 exactly for scale=3,4.
    expect(warnings).toHaveLength(scale >= 3 ? 1 : 0);
    if (scale === 3) {
      expect(result.parts.bulb.powerWatts).toBe(2 * Number.MIN_VALUE);
      expect(result.parts.bulb.brightness).toBe(1);
    }
  });

  it("preserves DC and transient LED brightness when current underflows", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["supply", "return"], { voltageVolts: 0.02 }],
      ["led", "led", ["supply", "return"], { saturationCurrentAmps: Number.MIN_VALUE, ratedCurrentAmps: Number.MIN_VALUE }],
      ["ground", "ground", ["return"]],
    ], "Subnormal LED current");
    const expected = Math.expm1(0.02 / (2 * 0.025_85));
    const dc = analyzeCircuit(document);
    expect(dc.status, dc.message).toBe("closed");
    expect(dc.parts.led.currentAmps).toBe(0);
    expect(dc.parts.led.brightness).toBeCloseTo(expected, 14);
    const original = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const frame = analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })!;
      expect(frame.parts.led.currentAmps).toBe(0);
      expect(frame.parts.led.brightness).toBeCloseTo(expected, 14);
    }
  });
});
