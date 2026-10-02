import { expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { analysisAtTransientFrame } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";

it("preserves recovered capacitor, resistor, and voltmeter values in a public transient frame", () => {
  const initialVoltage = 3;
  const capacitance = 1e-20;
  const timeStep = 1;
  const document: CircuitDocument = {
    title: "共通電位上で放電するRCの過渡フレーム",
    parts: [
      { id: "source", kind: "battery", label: "V", x: 0, y: 0, voltageVolts: 100 },
      { id: "capacitor", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: capacitance, initialVoltageVolts: initialVoltage },
      { id: "resistor", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
      { id: "meter", kind: "voltmeter", label: "M", x: 0, y: 0 },
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "source-capacitor", from: { partId: "source", terminal: "a" }, to: { partId: "capacitor", terminal: "a" } },
      { id: "source-ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "capacitor-resistor-a", from: { partId: "capacitor", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "capacitor-resistor-b", from: { partId: "capacitor", terminal: "b" }, to: { partId: "resistor", terminal: "b" } },
      { id: "meter-a", from: { partId: "meter", terminal: "a" }, to: { partId: "capacitor", terminal: "a" } },
      { id: "meter-b", from: { partId: "meter", terminal: "b" }, to: { partId: "capacitor", terminal: "b" } },
    ],
  };
  const transient = simulateTransient(document, { durationSeconds: timeStep, timeStepSeconds: timeStep });
  const expectedVoltage = initialVoltage / (1 + timeStep / capacitance);

  expect(transient.status, transient.message).toBe("valid");

  const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 1 });

  expect(frame?.parts.capacitor.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
  expect(frame?.parts.resistor.voltageVolts).toBe(frame?.parts.capacitor.voltageVolts);
  expect(frame?.parts.meter.voltageVolts).toBe(frame?.parts.capacitor.voltageVolts);
  expect(frame?.parts.meter.meterStatus).toBe("connected");
});
