import { expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { simulateTransient } from "../transient-solver.js";

it("preserves an exact sub-ULP cycle offset when the rounded turn count lands on a source zero crossing", () => {
  const voltageVolts = 5;
  const frequencyHz = 524_288.000_000_000_1;
  const timeSeconds = 0.999_999_999_999_999_8;
  const exactCycleOffset = -(2 ** -85);
  const document: CircuitDocument = {
    title: "AC source at a rounded cycle boundary",
    parts: [
      { id: "source", kind: "ac-source", label: "AC", x: 0, y: 0, voltageVolts, frequencyHz, phaseDegrees: 90 },
      { id: "load", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1000 },
    ],
    wires: [
      { id: "source-load", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "load-source", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: timeSeconds, timeStepSeconds: timeSeconds });
  const sampledVoltage = result.samples.at(-1)?.parts.source?.voltageVolts ?? Number.NaN;
  const expectedVoltage = -Math.SQRT2 * voltageVolts * Math.sin(2 * Math.PI * exactCycleOffset);

  expect(frequencyHz * timeSeconds).toBe(2 ** 19);
  expect(result.status, result.message).toBe("valid");
  expect(expectedVoltage).toBeGreaterThan(0);
  expect(sampledVoltage / expectedVoltage).toBeCloseTo(1, 10);
});

it("preserves a sub-ULP cycle offset beside a rounded quarter-cycle", () => {
  const voltageVolts = 5;
  const frequencyHz = 1 + 2 ** -52;
  const timeSeconds = 0.25 * (1 - 2 ** -52);
  const exactCycleOffset = -(2 ** -106);
  const document: CircuitDocument = {
    title: "AC source immediately before a quarter-cycle",
    parts: [
      { id: "source", kind: "ac-source", label: "AC", x: 0, y: 0, voltageVolts, frequencyHz, phaseDegrees: 0 },
      { id: "load", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1000 },
    ],
    wires: [
      { id: "source-load", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "load-source", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: timeSeconds, timeStepSeconds: timeSeconds });
  const sampledVoltage = result.samples.at(-1)?.parts.source?.voltageVolts ?? Number.NaN;
  const expectedVoltage = Math.SQRT2 * voltageVolts * Math.sin(-2 * Math.PI * exactCycleOffset);

  expect(frequencyHz * timeSeconds).toBe(0.25);
  expect(result.status, result.message).toBe("valid");
  expect(expectedVoltage).toBeGreaterThan(0);
  expect(sampledVoltage / expectedVoltage).toBeCloseTo(1, 10);
});

it("keeps a subnormal-time contribution beside a canceled non-quadrantal AC level", () => {
  const voltageVolts = 1e308;
  const frequencyHz = Number.MIN_VALUE;
  const timeSeconds = 1e15;
  const document: CircuitDocument = {
    title: "Subnormal AC phase shift beside a canceled common level",
    parts: [
      {
        id: "source",
        kind: "ac-source",
        label: "AC",
        x: 0,
        y: 0,
        voltageVolts,
        frequencyHz,
        phaseDegrees: 45,
        offsetVolts: -voltageVolts,
      },
      { id: "load", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    ],
    wires: [
      { id: "source-load", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "load-source", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: timeSeconds, timeStepSeconds: timeSeconds });
  const sampledVoltage = result.samples.at(-1)?.parts.source?.voltageVolts ?? Number.NaN;
  const expectedVoltage = -(((voltageVolts * frequencyHz) * timeSeconds) * 2 * Math.PI);

  expect(frequencyHz * timeSeconds).toBeLessThan(2 ** -1022);
  expect(result.status, result.message).toBe("valid");
  expect(result.samples[0]?.parts.source?.voltageVolts).toBe(0);
  expect(expectedVoltage).toBeCloseTo(-3.104_306_006_731_913_5, 12);
  expect(sampledVoltage / expectedVoltage).toBeCloseTo(1, 10);
});

it("preserves the quarter-cycle residue when it cancels a non-quadrantal source phase", () => {
  const voltageVolts = 5;
  const frequencyHz = 1 + 2 ** -52;
  const timeSeconds = 0.125 * (1 - 2 ** -52);
  const exactCycleOffset = -(2 ** -107);
  const document: CircuitDocument = {
    title: "AC phase and time offsets meet just before a zero crossing",
    parts: [
      { id: "source", kind: "ac-source", label: "AC", x: 0, y: 0, voltageVolts, frequencyHz, phaseDegrees: 45 },
      { id: "load", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1000 },
    ],
    wires: [
      { id: "source-load", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "load-source", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: timeSeconds, timeStepSeconds: timeSeconds });
  const sampledVoltage = result.samples.at(-1)?.parts.source?.voltageVolts ?? Number.NaN;
  const expectedVoltage = Math.SQRT2 * voltageVolts * Math.sin(-2 * Math.PI * exactCycleOffset);

  expect(frequencyHz * timeSeconds).toBe(0.125);
  expect(result.status, result.message).toBe("valid");
  expect(expectedVoltage).toBeGreaterThan(0);
  expect(sampledVoltage / expectedVoltage).toBeCloseTo(1, 10);
});

it("keeps a normal tiny time contribution beside a canceled non-quadrantal AC level", () => {
  const voltageVolts = 1e308;
  const frequencyHz = 1;
  const timeSeconds = 1e-300;
  const document: CircuitDocument = {
    title: "Normal tiny AC phase shift beside a canceled common level",
    parts: [
      {
        id: "source",
        kind: "ac-source",
        label: "AC",
        x: 0,
        y: 0,
        voltageVolts,
        frequencyHz,
        phaseDegrees: 45,
        offsetVolts: -voltageVolts,
      },
      { id: "load", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    ],
    wires: [
      { id: "source-load", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "load-source", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: timeSeconds, timeStepSeconds: timeSeconds });
  const sampledVoltage = result.samples.at(-1)?.parts.source?.voltageVolts ?? Number.NaN;
  const expectedVoltage = -(((voltageVolts * frequencyHz) * timeSeconds) * 2 * Math.PI);

  expect(frequencyHz * timeSeconds).toBeGreaterThanOrEqual(2 ** -1022);
  expect(result.status, result.message).toBe("valid");
  expect(result.samples[0]?.parts.source?.voltageVolts).toBe(0);
  expect(expectedVoltage).toBeCloseTo(-628_318_530.717_958_6, 5);
  expect(sampledVoltage / expectedVoltage).toBeCloseTo(1, 10);
});
