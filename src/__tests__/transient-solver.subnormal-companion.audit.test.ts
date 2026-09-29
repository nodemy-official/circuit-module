import { expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { simulateTransient } from "../transient-solver.js";

function rlDecay(
  resistanceOhms: number,
  initialCurrentAmps = 1e308,
  inductanceHenries = Number.MIN_VALUE,
): CircuitDocument {
  return {
    title: "Subnormal inductor companion resistance",
    parts: [
      {
        id: "inductor",
        kind: "inductor",
        label: "L",
        x: 0,
        y: 0,
        inductanceHenries,
        initialCurrentAmps,
      },
      { id: "resistor", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms },
    ],
    wires: [
      {
        id: "parallel-a",
        from: { partId: "inductor", terminal: "a" },
        to: { partId: "resistor", terminal: "a" },
      },
      {
        id: "parallel-b",
        from: { partId: "inductor", terminal: "b" },
        to: { partId: "resistor", terminal: "b" },
      },
    ],
  };
}

function rcDecay(): CircuitDocument {
  return {
    title: "Subnormal capacitor history",
    parts: [
      {
        id: "capacitor",
        kind: "capacitor",
        label: "C",
        x: 0,
        y: 0,
        capacitanceFarads: 1,
        initialVoltageVolts: Number.MIN_VALUE,
      },
      { id: "resistor", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: Number.MIN_VALUE },
    ],
    wires: [
      {
        id: "parallel-a",
        from: { partId: "capacitor", terminal: "a" },
        to: { partId: "resistor", terminal: "a" },
      },
      {
        id: "parallel-b",
        from: { partId: "capacitor", terminal: "b" },
        to: { partId: "resistor", terminal: "b" },
      },
    ],
  };
}

function largeCapacitorDecay(): CircuitDocument {
  return {
    title: "Large finite capacitor history product",
    parts: [
      {
        id: "capacitor",
        kind: "capacitor",
        label: "C",
        x: 0,
        y: 0,
        capacitanceFarads: Number.MAX_VALUE,
        initialVoltageVolts: 1.1,
      },
      { id: "resistor", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: Number.MAX_VALUE },
    ],
    wires: [
      {
        id: "parallel-a",
        from: { partId: "capacitor", terminal: "a" },
        to: { partId: "resistor", terminal: "a" },
      },
      {
        id: "parallel-b",
        from: { partId: "capacitor", terminal: "b" },
        to: { partId: "resistor", terminal: "b" },
      },
    ],
  };
}

it.each([
  ["normal load", 1e-308, 3.293_770_972_274_976e292, -3.293_770_972_274_976e-16],
  ["minimum subnormal load", Number.MIN_VALUE, 4e307, -1.976_262_583_364_986_1e-16],
] as const)("preserves the backward-Euler history term with a subnormal companion and %s", (
  _label,
  resistanceOhms,
  expectedCurrent,
  expectedVoltage,
) => {
  const timeStepSeconds = 1.5;
  const result = simulateTransient(rlDecay(resistanceOhms), {
    durationSeconds: timeStepSeconds,
    timeStepSeconds,
  });
  const sample = result.samples[1];

  expect(result.status, result.message).toBe("valid");
  expect(sample?.parts.inductor?.currentAmps / expectedCurrent).toBeCloseTo(1, 12);
  expect(sample?.parts.inductor?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
  expect(sample?.parts.resistor?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
});

it("retains a subnormal inductor history product across multiple steps", () => {
  const result = simulateTransient(rlDecay(Number.MIN_VALUE, 1), {
    durationSeconds: 3,
    timeStepSeconds: 1.5,
  });

  expect(result.status, result.message).toBe("valid");
  expect(result.samples.map(({ parts }) => parts.inductor?.currentAmps)).toEqual([1, 0.4, 0.16]);
});

it("retains capacitor history below the smallest subnormal between steps", () => {
  const timeStepSeconds = 1e-308;
  const result = simulateTransient(rcDecay(), {
    durationSeconds: 2e-308,
    timeStepSeconds,
  });

  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(3);
  expect(result.samples[1]?.parts.capacitor?.voltageVolts).toBe(0);
  const expectedFirstCurrent = Number.MIN_VALUE / timeStepSeconds;
  const expectedSecondCurrent = expectedFirstCurrent * (Number.MIN_VALUE / timeStepSeconds);
  expect(Math.abs(result.samples[1]?.parts.capacitor?.currentAmps ?? 0) / expectedFirstCurrent).toBeCloseTo(1, 12);
  expect(Math.abs(result.samples[2]?.parts.capacitor?.currentAmps ?? 0) / expectedSecondCurrent).toBeCloseTo(1, 12);
});

it("evaluates a capacitor history product beyond Number.MAX_VALUE with exact row scaling", () => {
  const result = simulateTransient(largeCapacitorDecay(), {
    durationSeconds: 1.5,
    timeStepSeconds: 1.5,
  });

  expect(result.status, result.message).toBe("valid");
  const sample = result.samples[1];
  expect(sample?.parts.capacitor?.voltageVolts).toBeCloseTo(1.1, 14);
  const expectedCurrent = 1.1 / Number.MAX_VALUE;
  expect(Math.abs(sample?.parts.capacitor?.currentAmps ?? 0) / expectedCurrent).toBeCloseTo(1, 12);
});
