import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

it.each([1e12, -1e12])("preserves feedback KCL when both inputs carry a %s V common bias", (commonVolts) => {
  for (const offsetVolts of [0.125, -0.125]) {
    const document = amplifier(offsetVolts);
    document.parts = document.parts.map((part) => part.id === "amp" ? { ...part, openLoopGain: 1e8 }
      : part.id === "load" ? { ...part, resistanceOhms: 1000 } : part);
    document.parts.push(...["common", "shift"].map((id) => ({
      id, kind: "ac-source" as const, label: id, x: 0, y: 0, voltageVolts: 0, offsetVolts: commonVolts, frequencyHz: 1,
    })));
    document.wires = document.wires.filter(({ id }) => id !== "input-ground" && id !== "minus-ground");
    document.wires.push(
      { id: "common-ground", from: { partId: "common", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "common-input", from: { partId: "common", terminal: "a" }, to: { partId: "input", terminal: "b" } },
      { id: "shift-output", from: { partId: "shift", terminal: "b" }, to: { partId: "amp", terminal: "c" } },
      { id: "shift-feedback", from: { partId: "shift", terminal: "a" }, to: { partId: "amp", terminal: "b" } },
    );
    for (const mode of ["dc", "ac"] as const) {
      const result = analyzeAnalogCircuit(document, { mode });
      expect(result.status, result.message).toBe("valid");
      const expected = (mode === "dc" ? offsetVolts : 0.125) / (1 + 1.02e-8) / 1000;
      const component = mode === "dc" ? "real" : "imaginary";
      expect(result.parts.load!.current[component] / expected).toBeCloseTo(1, 14);
      expect(result.parts.amp!.current[component]).toBe(-result.parts.load!.current[component]);
      expect(analyzeCircuit(document, {}, { mode }).status).toBe("closed");
    }
    const transient = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(sample.parts.load!.currentAmps / (offsetVolts / (1 + 1.02e-8) / 1000)).toBeCloseTo(1, 14);
      expect(sample.parts.amp!.currentAmps).toBe(-sample.parts.load!.currentAmps);
    }
  }
});

it.each([1e8, 1e20])("solves high-gain feedback without a saturated initial bias at gain %s", (gain) => {
  for (const resistanceOhms of [1000, 1e18]) {
    for (const offsetVolts of [0.125, -0.125, 3, -3]) {
      const document = amplifier(offsetVolts);
      document.parts = document.parts.map((part) => part.id === "amp" ? { ...part, openLoopGain: gain }
        : part.id === "load" ? { ...part, resistanceOhms } : part);
      document.wires = document.wires.filter((wire) => !(wire.from.partId === "amp" && wire.from.terminal === "b") &&
        !(wire.to.partId === "amp" && wire.to.terminal === "b"));
      document.wires.push({ id: "feedback", from: { partId: "amp", terminal: "c" }, to: { partId: "amp", terminal: "b" } });
      for (const mode of ["dc", "ac"] as const) {
        const result = analyzeAnalogCircuit(document, { mode });
        expect(result.status, result.message).toBe("valid");
        // Vout=G*(Vin-Vout)-20*I, I=Vout/R.
        const expected = (mode === "dc" ? offsetVolts : 0.125) / (1 + 1 / gain + 20 / (gain * resistanceOhms)) / resistanceOhms;
        const component = mode === "dc" ? "real" : "imaginary";
        expect(result.parts.load!.current[component] / expected).toBeCloseTo(1, 14);
        expect(result.parts.amp!.current[component]).toBe(-result.parts.load!.current[component]);
      }
    }
  }
});

function amplifier(offsetVolts: number): CircuitDocument {
  return {
    title: "Op-amp finite output current below voltage ULP",
    parts: [
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      { id: "input", kind: "ac-source", label: "Input", x: 0, y: 0, voltageVolts: 0.125, offsetVolts, frequencyHz: 1, phaseDegrees: 90 },
      { id: "amp", kind: "op-amp", label: "Amplifier", x: 0, y: 0, openLoopGain: 8, positiveRailVolts: 15, negativeRailVolts: -15 },
      { id: "load", kind: "resistor", label: "Load", x: 0, y: 0, resistanceOhms: 1e18 },
    ],
    wires: [
      { id: "input-ground", from: { partId: "input", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "input-plus", from: { partId: "input", terminal: "a" }, to: { partId: "amp", terminal: "a" } },
      { id: "minus-ground", from: { partId: "amp", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "output-load", from: { partId: "amp", terminal: "c" }, to: { partId: "load", terminal: "a" } },
      { id: "load-ground", from: { partId: "load", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    ],
  };
}

it.each([0.125, -0.125, 3, -3])("keeps DC output current and power in KCL at input %s V", (offsetVolts) => {
  const document = amplifier(offsetVolts);
  const target = Math.max(-15, Math.min(15, 8 * offsetVolts));
  const expectedLoadCurrent = target / (1e18 + 20);
  const analog = analyzeAnalogCircuit(document, { mode: "dc" });
  expect(analog.status, analog.message).toBe("valid");
  expect(analog.parts.amp!.current.real / -expectedLoadCurrent).toBeCloseTo(1, 14);
  expect(analog.parts.amp!.terminalCurrents.c!.real).toBe(-analog.parts.load!.current.real);
  expect(analog.parts.amp!.power.real).toBe(-analog.parts.load!.power.real);
  const publicResult = analyzeCircuit(document, {}, { mode: "dc" });
  expect(publicResult.status, publicResult.message).toBe("closed");
  expect(publicResult.parts.amp!.currentAmps / -expectedLoadCurrent).toBeCloseTo(1, 14);
  const transient = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  expect(transient.status, transient.message).toBe("valid");
  for (const sample of transient.samples) {
    expect(sample.parts.amp!.currentAmps / -expectedLoadCurrent).toBeCloseTo(1, 14);
    expect(sample.parts.amp!.terminalCurrents!.c).toBe(-sample.parts.load!.currentAmps);
    expect(sample.parts.amp!.powerWatts).toBe(-sample.parts.load!.powerWatts);
  }
});

it.each([0.125, -0.125])("keeps AC output current around the exact DC state at input %s V", (offsetVolts) => {
  const result = analyzeAnalogCircuit(amplifier(offsetVolts), { mode: "ac" });
  expect(result.status, result.message).toBe("valid");
  const expectedCurrent = -1 / (1e18 + 20);
  expect(result.parts.amp!.current.imaginary / expectedCurrent).toBeCloseTo(1, 14);
  expect(result.parts.amp!.current.imaginary).toBe(-result.parts.load!.current.imaginary);
});
