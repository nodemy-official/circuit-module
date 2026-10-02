import { expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

it("reports and carries the backward-Euler capacitor voltage after large decay steps", () => {
  const initialVoltage = 3;
  const resistance = 1;
  const capacitance = 1e-20;
  const timeStep = 1;
  const document: CircuitDocument = {
    title: "Small residual voltage after a large RC decay",
    parts: [
      { id: "capacitor", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: capacitance, initialVoltageVolts: initialVoltage },
      { id: "resistor", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: resistance },
    ],
    wires: [
      { id: "parallel-a", from: { partId: "capacitor", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "parallel-b", from: { partId: "capacitor", terminal: "b" }, to: { partId: "resistor", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 2 * timeStep, timeStepSeconds: timeStep });
  const expectedStepFactor = resistance / (resistance + timeStep / capacitance);
  const expectedFirstVoltage = initialVoltage * expectedStepFactor;
  const expectedSecondVoltage = expectedFirstVoltage * expectedStepFactor;

  expect(result.status, result.message).toBe("valid");
  expect(result.samples[1]?.parts.capacitor?.currentAmps)
    .toBeCloseTo(-initialVoltage / (resistance + timeStep / capacitance), 12);
  expect(result.samples[1]?.parts.capacitor?.voltageVolts / expectedFirstVoltage).toBeCloseTo(1, 12);
  expect(result.samples[1]?.parts.capacitor?.voltageVolts).toBe(result.samples[1]?.parts.resistor?.voltageVolts);
  expect(result.samples[2]?.parts.capacitor?.voltageVolts / expectedSecondVoltage).toBeCloseTo(1, 12);
  expect(result.samples[2]?.parts.capacitor?.voltageVolts).toBe(result.samples[2]?.parts.resistor?.voltageVolts);
});

it("reports the small inductor voltage when its companion terms nearly cancel", () => {
  const timeStep = 1e-20;
  const document: CircuitDocument = {
    title: "Inductor voltage after a tiny current change",
    parts: [
      { id: "inductor", kind: "inductor", label: "L", x: 0, y: 0, inductanceHenries: 1, initialCurrentAmps: 3 },
      { id: "resistor", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    ],
    wires: [
      { id: "parallel-a", from: { partId: "inductor", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "parallel-b", from: { partId: "inductor", terminal: "b" }, to: { partId: "resistor", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: timeStep, timeStepSeconds: timeStep });
  const sample = result.samples[1];

  expect(result.status, result.message).toBe("valid");
  expect(sample?.parts.inductor?.currentAmps).toBe(3);
  expect(sample?.parts.inductor?.voltageVolts).toBe(-3);
  expect(sample?.parts.inductor?.voltageVolts).toBe(sample?.parts.resistor?.voltageVolts);
});

it("keeps a decayed capacitor voltage consistent with its parallel resistor and meter at 100 V common mode", () => {
  const initialVoltage = 3;
  const capacitance = 1e-20;
  const timeStep = 1;
  const document: CircuitDocument = {
    title: "Small RC decay above a 100 V common mode",
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

  const result = simulateTransient(document, { durationSeconds: 2 * timeStep, timeStepSeconds: timeStep });
  const firstExpected = initialVoltage / (1 + timeStep / capacitance);
  const secondExpected = firstExpected / (1 + timeStep / capacitance);

  expect(result.status, result.message).toBe("valid");
  expect(result.samples[1]?.parts.capacitor?.terminalVoltages?.a).toBe(100);
  expect(result.samples[1]?.parts.capacitor?.terminalVoltages?.b).toBe(100);
  for (const [index, expected] of [[1, firstExpected], [2, secondExpected]] as const) {
    const sample = result.samples[index];
    expect(sample?.parts.capacitor?.voltageVolts / expected).toBeCloseTo(1, 12);
    expect(sample?.parts.capacitor?.voltageVolts / (sample?.parts.resistor?.voltageVolts ?? Number.NaN))
      .toBeCloseTo(1, 12);
    expect(sample?.parts.capacitor?.voltageVolts / (sample?.parts.meter?.voltageVolts ?? Number.NaN))
      .toBeCloseTo(1, 12);
  }
});

it("retains branch voltage accuracy for a small capacitor voltage several ulps below a 100 V common mode", () => {
  const initialVoltage = 8e-14;
  const capacitance = 1e-20;
  const timeStep = 0.5e-20;
  const document: CircuitDocument = {
    title: "Small RC voltage near a high common mode",
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

  const result = simulateTransient(document, { durationSeconds: timeStep, timeStepSeconds: timeStep });
  const sample = result.samples[1];
  const expectedVoltage = initialVoltage / (1 + timeStep / capacitance);
  const voltageResolutionAtCommonMode = 100 * Number.EPSILON;

  expect(initialVoltage / voltageResolutionAtCommonMode).toBeGreaterThan(3);
  expect(result.status, result.message).toBe("valid");
  expect(sample?.parts.capacitor?.voltageVolts / expectedVoltage).toBeCloseTo(1, 1);
  expect(sample?.parts.capacitor?.voltageVolts / (sample?.parts.resistor?.voltageVolts ?? Number.NaN))
    .toBeCloseTo(1, 12);
  expect(sample?.parts.capacitor?.voltageVolts / (sample?.parts.meter?.voltageVolts ?? Number.NaN))
    .toBeCloseTo(1, 12);
});
