import { expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { simulateTransient } from "../transient-solver.js";

it("preserves the initial ammeter current of a tiny parallel capacitor", () => {
  const document: CircuitDocument = {
    title: "Parallel capacitor initial ammeter precision",
    parts: [
      { id: "source", kind: "battery", label: "source", x: 0, y: 0, voltageVolts: 1 },
      { id: "resistor", kind: "resistor", label: "resistor", x: 0, y: 0, resistanceOhms: 1 },
      { id: "ammeter", kind: "ammeter", label: "ammeter", x: 0, y: 0 },
      { id: "tiny-capacitor", kind: "capacitor", label: "tiny capacitor", x: 0, y: 0, capacitanceFarads: 1e-20 },
      { id: "large-capacitor", kind: "capacitor", label: "large capacitor", x: 0, y: 0, capacitanceFarads: 1 },
      { id: "ground", kind: "ground", label: "ground", x: 0, y: 0 },
    ],
    wires: [
      { id: "source-r", from: { partId: "source", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
      { id: "r-meter", from: { partId: "resistor", terminal: "b" }, to: { partId: "ammeter", terminal: "a" } },
      { id: "meter-tiny-c", from: { partId: "ammeter", terminal: "b" }, to: { partId: "tiny-capacitor", terminal: "a" } },
      { id: "resistor-large-capacitor", from: { partId: "resistor", terminal: "b" }, to: { partId: "large-capacitor", terminal: "a" } },
      { id: "tiny-ground", from: { partId: "tiny-capacitor", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "large-ground", from: { partId: "large-capacitor", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "source-ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
  const initial = result.samples[0]?.parts;
  const expectedTinyBranchCurrent = 1e-20 / (1 + 1e-20);

  expect(result.status, result.message).toBe("valid");
  expect((initial?.["tiny-capacitor"]?.currentAmps ?? Number.NaN) / expectedTinyBranchCurrent).toBeCloseTo(1, 12);
  expect((initial?.ammeter?.currentAmps ?? Number.NaN) / expectedTinyBranchCurrent).toBeCloseTo(1, 12);
});
