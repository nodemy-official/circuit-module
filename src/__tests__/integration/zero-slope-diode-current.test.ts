import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analysisAtTransientFrame } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { addRational, assertCorrectRounding, divideRational, multiplyRational, rationalFromNumber } from "../helpers/numeric-oracle.js";

const voltage = 0.01;
const ideality = Number.MAX_VALUE;
const thermalVoltage = 0.025_85;
const exactVoltage = rationalFromNumber(voltage)!;
const exactScale = multiplyRational(rationalFromNumber(ideality)!, rationalFromNumber(thermalVoltage)!);
// expm1(x)=x at this subnormal exponent with relative error below 2^-1023.
// This independent rational oracle keeps the rating ratio before any rounding.
const expectedBrightness = divideRational(exactVoltage, exactScale);

function parallelLed() {
  return createCircuitFromSpecs([
    ["source", "battery", ["supply", "0"], { voltageVolts: voltage }],
    ["led", "led", ["supply", "0"], {
      saturationCurrentAmps: Number.MIN_VALUE,
      ratedCurrentAmps: Number.MIN_VALUE,
      emissionCoefficient: ideality,
    }],
    ["ground", "ground", ["0"]],
  ], "LED current retained with a zero displayed slope");
}

function seriesDiode(kind: "diode" | "led") {
  return createCircuitFromSpecs([
    ["source", "battery", ["supply", "0"], { voltageVolts: voltage }],
    ["device", kind, ["supply", "load"], { saturationCurrentAmps: 1e-300, emissionCoefficient: ideality }],
    ["load", "resistor", ["load", "0"], { resistanceOhms: Number.MAX_VALUE }],
    ["ground", "ground", ["0"]],
  ], "Finite load voltage from a current below the display range");
}

function seriesLoadVoltage() {
  const conductance = divideRational(rationalFromNumber(1e-300)!, exactScale);
  const resistanceConductance = multiplyRational(rationalFromNumber(Number.MAX_VALUE)!, conductance);
  return divideRational(
    multiplyRational(exactVoltage, resistanceConductance),
    addRational({ numerator: 1n, denominator: 1n }, resistanceConductance),
  );
}

describe("DC current with an underflowed diode slope", () => {
  it("retains a correctly rounded LED brightness when both current and slope display as zero", () => {
    const analysis = analyzeCircuit(parallelLed());
    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.led.currentAmps).toBe(0);
    expect(analysis.parts.led.brightness).toBeGreaterThan(0);
    assertCorrectRounding(analysis.parts.led.brightness!, expectedBrightness, "DC zero-slope LED brightness");
  });

  it("retains the LED brightness through original, JSON and cloned transient frames", () => {
    const document = parallelLed();
    const original = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      for (const sampleIndex of [0, 1]) {
        const frame = analysisAtTransientFrame(document, { analysis, sampleIndex })!;
        expect(frame.parts.led.currentAmps).toBe(0);
        expect(frame.parts.led.brightness).toBeGreaterThan(0);
        assertCorrectRounding(frame.parts.led.brightness!, expectedBrightness, "transient zero-slope LED brightness");
      }
    }
  });

  it.each(["diode", "led"] as const)("keeps the finite series load voltage for a zero-slope %s", (kind) => {
    const document = seriesDiode(kind);
    const expected = seriesLoadVoltage();
    const analog = analyzeAnalogCircuit(document);
    const scalar = analyzeCircuit(document);
    expect(analog.status, analog.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    expect(analog.parts.device.current.real).toBe(0);
    expect(analog.parts.load.current.real).toBe(0);
    expect(analog.parts.load.voltage.real).toBeGreaterThan(0);
    assertCorrectRounding(analog.parts.load.voltage.real, expected, "analog zero-slope load voltage");
    assertCorrectRounding(scalar.parts.load.voltageVolts, expected, "scalar zero-slope load voltage");
  });

  it("keeps the finite series load voltage in original, JSON and cloned transient frames", () => {
    const document = seriesDiode("led");
    const expected = seriesLoadVoltage();
    const original = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      for (const sampleIndex of [0, 1]) {
        const frame = analysisAtTransientFrame(document, { analysis, sampleIndex })!;
        expect(frame.parts.load.currentAmps).toBe(0);
        expect(frame.parts.load.voltageVolts).toBeGreaterThan(0);
        assertCorrectRounding(frame.parts.load.voltageVolts, expected, "transient zero-slope load voltage");
      }
    }
  });

  it("continues to use a zero small-signal AC slope around the retained DC current", () => {
    const document = parallelLed();
    document.parts[0] = { ...document.parts[0], kind: "ac-source", voltageVolts: voltage, offsetVolts: voltage, frequencyHz: 1000 };
    const analysis = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.parts.led.voltage.real).toBe(voltage);
    expect(analysis.parts.led.current).toEqual({ real: 0, imaginary: 0 });
    expect(analysis.parts.led.acReferenceTerminalGroups).toEqual([]);
    expect(analysis.parts.led.acCurrentResponseTerminalGroups).toEqual([]);
  });
});
