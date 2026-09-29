import { expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { simulateTransient } from "../transient-solver.js";

it("solves initial capacitor currents across a non-parallel capacitor network", () => {
  const document: CircuitDocument = {
    title: "Capacitor triangle initial current",
    parts: [
      { id: "source", kind: "battery", label: "source", x: 0, y: 0, voltageVolts: 1 },
      { id: "resistor", kind: "resistor", label: "resistor", x: 0, y: 0, resistanceOhms: 1 },
      { id: "c-ab", kind: "capacitor", label: "C AB", x: 0, y: 0, capacitanceFarads: 1 },
      { id: "c-bg", kind: "capacitor", label: "C BG", x: 0, y: 0, capacitanceFarads: 1 },
      { id: "c-ag", kind: "capacitor", label: "C AG", x: 0, y: 0, capacitanceFarads: 1 },
      { id: "ground", kind: "ground", label: "ground", x: 0, y: 0 },
    ],
    wires: [
      { id: "source-resistor", from: { partId: "source", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "resistor-a", from: { partId: "resistor", terminal: "b" }, to: { partId: "c-ab", terminal: "a" } },
      { id: "c-ab-b", from: { partId: "c-ab", terminal: "b" }, to: { partId: "c-bg", terminal: "a" } },
      { id: "c-bg-ground", from: { partId: "c-bg", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "c-ag-a", from: { partId: "resistor", terminal: "b" }, to: { partId: "c-ag", terminal: "a" } },
      { id: "c-ag-ground", from: { partId: "c-ag", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "source-ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    ],
  };

  const options = { durationSeconds: 0.1, timeStepSeconds: 0.1 };
  const result = simulateTransient(document, options);
  const permutedWithReversedBranch = {
    ...document,
    parts: [...document.parts].reverse(),
    wires: [...document.wires].reverse().map((wire) => {
      if (wire.id === "resistor-a") {
        return { ...wire, to: { ...wire.to, terminal: "b" as const } };
      }
      if (wire.id === "c-ab-b") {
        return { ...wire, from: { ...wire.from, terminal: "a" as const } };
      }
      return { ...wire, from: wire.to, to: wire.from };
    }),
  };
  const permuted = simulateTransient(permutedWithReversedBranch, options);
  const initial = result.samples[0]?.parts;
  const permutedInitial = permuted.samples[0]?.parts;

  expect(result.status, result.message).toBe("valid");
  expect(permuted.status, permuted.message).toBe("valid");
  expect(initial?.["c-ab"]?.currentAmps).toBeCloseTo(1 / 3, 12);
  expect(initial?.["c-bg"]?.currentAmps).toBeCloseTo(1 / 3, 12);
  expect(initial?.["c-ag"]?.currentAmps).toBeCloseTo(2 / 3, 12);
  expect(permutedInitial?.["c-ab"]?.currentAmps).toBeCloseTo(-1 / 3, 12);
  expect(permutedInitial?.["c-bg"]?.currentAmps).toBeCloseTo(1 / 3, 12);
  expect(permutedInitial?.["c-ag"]?.currentAmps).toBeCloseTo(2 / 3, 12);
});

it("uses a KVL-consistent nonzero initial voltage around a capacitor loop", () => {
  const document: CircuitDocument = {
    title: "Precharged capacitor triangle",
    parts: [
      { id: "source", kind: "battery", label: "source", x: 0, y: 0, voltageVolts: 1 },
      { id: "resistor", kind: "resistor", label: "resistor", x: 0, y: 0, resistanceOhms: 1 },
      { id: "c-ab", kind: "capacitor", label: "C AB", x: 0, y: 0, capacitanceFarads: 1, initialVoltageVolts: 1 },
      { id: "c-bg", kind: "capacitor", label: "C BG", x: 0, y: 0, capacitanceFarads: 1, initialVoltageVolts: 2 },
      { id: "c-ag", kind: "capacitor", label: "C AG", x: 0, y: 0, capacitanceFarads: 1, initialVoltageVolts: 3 },
      { id: "ground", kind: "ground", label: "ground", x: 0, y: 0 },
    ],
    wires: [
      { id: "source-resistor", from: { partId: "source", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "resistor-a", from: { partId: "resistor", terminal: "b" }, to: { partId: "c-ab", terminal: "a" } },
      { id: "c-ab-b", from: { partId: "c-ab", terminal: "b" }, to: { partId: "c-bg", terminal: "a" } },
      { id: "c-bg-ground", from: { partId: "c-bg", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "c-ag-a", from: { partId: "resistor", terminal: "b" }, to: { partId: "c-ag", terminal: "a" } },
      { id: "c-ag-ground", from: { partId: "c-ag", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "source-ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
  const initial = result.samples[0]?.parts;

  expect(result.status, result.message).toBe("valid");
  expect(initial?.["c-ab"]?.currentAmps).toBeCloseTo(-2 / 3, 12);
  expect(initial?.["c-bg"]?.currentAmps).toBeCloseTo(-2 / 3, 12);
  expect(initial?.["c-ag"]?.currentAmps).toBeCloseTo(-4 / 3, 12);
});

it("reports the derivative current of a capacitor directly across an AC source at t=0", () => {
  const rmsVoltage = 2;
  const frequencyHz = 3;
  const capacitanceFarads = 0.5;
  const document: CircuitDocument = {
    title: "Direct AC source capacitor initial current",
    parts: [
      { id: "source", kind: "ac-source", label: "source", x: 0, y: 0, voltageVolts: rmsVoltage, frequencyHz, phaseDegrees: 90 },
      { id: "capacitor", kind: "capacitor", label: "capacitor", x: 0, y: 0, capacitanceFarads, initialVoltageVolts: 0 },
    ],
    wires: [
      { id: "positive", from: { partId: "source", terminal: "a" }, to: { partId: "capacitor", terminal: "a" } },
      { id: "negative", from: { partId: "source", terminal: "b" }, to: { partId: "capacitor", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
  const actualCurrent = result.samples[0]?.parts.capacitor?.currentAmps ?? Number.NaN;
  const expectedCurrent = capacitanceFarads * -Math.SQRT2 * rmsVoltage * 2 * Math.PI * frequencyHz;

  expect(result.status, result.message).toBe("valid");
  expect(actualCurrent / expectedCurrent).toBeCloseTo(1, 12);
});

it.each([0, 45, 90, 135, 180, 225, 270, 315] as const)(
  "uses the signed AC slope in the initial capacitor loop at phase %i degrees",
  (phaseDegrees) => {
    const rmsVoltage = 2;
    const frequencyHz = 3;
    const capacitanceFarads = 0.5;
    const offsetVolts = 0.25;
    const angle = phaseDegrees * Math.PI / 180;
    const phaseSlope = [0, 90, 180, 270].includes(phaseDegrees)
      ? [0, 1, 0, -1][phaseDegrees / 90] ?? Number.NaN
      : Math.sin(angle);
    const sourcePart = { id: "source", kind: "ac-source" as const, label: "source", x: 0, y: 0, voltageVolts: rmsVoltage, frequencyHz, phaseDegrees, offsetVolts };
    const initialSource = simulateTransient({ title: "AC source sample", parts: [sourcePart], wires: [] }, {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
    });
    const initialSourceVoltage = initialSource.samples[0]?.parts.source?.voltageVolts ?? Number.NaN;
    const document: CircuitDocument = {
      title: "AC derivative quadrant audit",
      parts: [
        sourcePart,
        { id: "capacitor", kind: "capacitor", label: "capacitor", x: 0, y: 0, capacitanceFarads, initialVoltageVolts: initialSourceVoltage },
      ],
      wires: [
        { id: "positive", from: { partId: "source", terminal: "a" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "negative", from: { partId: "source", terminal: "b" }, to: { partId: "capacitor", terminal: "b" } },
      ],
    };

    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
    const actualCurrent = result.samples[0]?.parts.capacitor?.currentAmps ?? Number.NaN;
    const expectedCurrent = -capacitanceFarads * Math.SQRT2 * rmsVoltage * 2 * Math.PI * frequencyHz * phaseSlope;

    expect(initialSource.status, initialSource.message).toBe("valid");
    expect(result.status, result.message).toBe("valid");
    if (expectedCurrent === 0) {
      expect(actualCurrent).toBe(0);
    } else {
      expect(actualCurrent / expectedCurrent).toBeCloseTo(1, 12);
    }
  },
);

it("keeps parallel identical ideal AC sources order-independent in a capacitor loop", () => {
  const rmsVoltage = 1;
  const frequencyHz = 2;
  const capacitanceFarads = 0.25;
  const sourceProperties = { voltageVolts: rmsVoltage, frequencyHz, phaseDegrees: 90 };
  const source1 = { id: "source-1", kind: "ac-source" as const, label: "source 1", x: 0, y: 0, ...sourceProperties };
  const source2 = { id: "source-2", kind: "ac-source" as const, label: "source 2", x: 0, y: 0, ...sourceProperties };
  const capacitor = { id: "capacitor", kind: "capacitor" as const, label: "capacitor", x: 0, y: 0, capacitanceFarads, initialVoltageVolts: 0 };
  const wires = [
    { id: "positive-1", from: { partId: "source-1", terminal: "a" as const }, to: { partId: "capacitor", terminal: "a" as const } },
    { id: "positive-2", from: { partId: "source-2", terminal: "a" as const }, to: { partId: "capacitor", terminal: "a" as const } },
    { id: "negative-1", from: { partId: "source-1", terminal: "b" as const }, to: { partId: "capacitor", terminal: "b" as const } },
    { id: "negative-2", from: { partId: "source-2", terminal: "b" as const }, to: { partId: "capacitor", terminal: "b" as const } },
  ];
  const options = { durationSeconds: 0.01, timeStepSeconds: 0.01 };
  const firstOrder = simulateTransient({ title: "Parallel AC sources", parts: [source1, source2, capacitor], wires }, options);
  const reversedOrder = simulateTransient({ title: "Parallel AC sources", parts: [source2, source1, capacitor], wires }, options);
  const firstCurrent = firstOrder.samples[0]?.parts.capacitor?.currentAmps ?? Number.NaN;
  const reversedCurrent = reversedOrder.samples[0]?.parts.capacitor?.currentAmps ?? Number.NaN;
  const expectedCurrent = -capacitanceFarads * Math.SQRT2 * rmsVoltage * 2 * Math.PI * frequencyHz;

  expect(firstOrder.status, firstOrder.message).toBe("valid");
  expect(reversedOrder.status, reversedOrder.message).toBe("valid");
  expect(firstCurrent / expectedCurrent).toBeCloseTo(1, 12);
  expect(reversedCurrent / expectedCurrent).toBeCloseTo(1, 12);
});

it("shares initial current between parallel capacitors whose exact total exceeds Number.MAX_VALUE", () => {
  const document: CircuitDocument = {
    title: "Overflowing parallel capacitance sum",
    parts: [
      { id: "source", kind: "battery", label: "source", x: 0, y: 0, voltageVolts: 1 },
      { id: "resistor", kind: "resistor", label: "resistor", x: 0, y: 0, resistanceOhms: 1 },
      { id: "capacitor-1", kind: "capacitor", label: "capacitor 1", x: 0, y: 0, capacitanceFarads: Number.MAX_VALUE },
      { id: "capacitor-2", kind: "capacitor", label: "capacitor 2", x: 0, y: 0, capacitanceFarads: Number.MAX_VALUE },
      { id: "ground", kind: "ground", label: "ground", x: 0, y: 0 },
    ],
    wires: [
      { id: "source-r", from: { partId: "source", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "r-c1", from: { partId: "resistor", terminal: "b" }, to: { partId: "capacitor-1", terminal: "a" } },
      { id: "c1-c2", from: { partId: "capacitor-1", terminal: "a" }, to: { partId: "capacitor-2", terminal: "a" } },
      { id: "c1-ground", from: { partId: "capacitor-1", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "c2-ground", from: { partId: "capacitor-2", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "source-ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
  const initial = result.samples[0]?.parts;

  expect(result.status, result.message).toBe("valid");
  expect(initial?.["capacitor-1"]?.currentAmps).toBeCloseTo(0.5, 12);
  expect(initial?.["capacitor-2"]?.currentAmps).toBeCloseTo(0.5, 12);
});
