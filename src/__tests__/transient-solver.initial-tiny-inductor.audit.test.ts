import { expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { simulateTransient } from "../transient-solver.js";

it("accepts a minimum positive inductor when its finite backward-Euler companion has unit resistance", () => {
  const document: CircuitDocument = {
    title: "Minimum inductor with minimum step",
    parts: [
      { id: "source-1", kind: "battery", label: "source 1", x: 0, y: 0, voltageVolts: 1 },
      { id: "resistor-1", kind: "resistor", label: "resistor 1", x: 0, y: 0, resistanceOhms: 1 },
      { id: "source-2", kind: "battery", label: "source 2", x: 0, y: 0, voltageVolts: 1 },
      { id: "resistor-2", kind: "resistor", label: "resistor 2", x: 0, y: 0, resistanceOhms: 1 },
      { id: "inductor", kind: "inductor", label: "inductor", x: 0, y: 0, inductanceHenries: Number.MIN_VALUE, initialCurrentAmps: 0 },
    ],
    wires: [
      { id: "s1-r1", from: { partId: "source-1", terminal: "a" }, to: { partId: "resistor-1", terminal: "a" } },
      { id: "r1-s1", from: { partId: "resistor-1", terminal: "b" }, to: { partId: "source-1", terminal: "b" } },
      { id: "s2-r2", from: { partId: "source-2", terminal: "a" }, to: { partId: "resistor-2", terminal: "a" } },
      { id: "r2-s2", from: { partId: "resistor-2", terminal: "b" }, to: { partId: "source-2", terminal: "b" } },
      { id: "s1-l", from: { partId: "source-1", terminal: "a" }, to: { partId: "inductor", terminal: "a" } },
      { id: "l-s2", from: { partId: "inductor", terminal: "b" }, to: { partId: "source-2", terminal: "a" } },
    ],
  };

  const result = simulateTransient(document, {
    durationSeconds: Number.MIN_VALUE,
    timeStepSeconds: Number.MIN_VALUE,
  });

  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(2);
  expect(result.samples[0]?.parts.inductor?.currentAmps).toBe(0);
  expect(result.samples[1]?.parts.inductor?.currentAmps).toBe(0);
});
