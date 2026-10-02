import { expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function part(id: string, kind: CircuitPartKind, properties: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(id: string, fromPart: string, fromTerminal: "a" | "b", toPart: string, toTerminal: "a" | "b"): CircuitWire {
  return { id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } };
}

it.each([
  ["large finite capacitance", 1e308, 1e-308],
  ["maximum finite capacitance", Number.MAX_VALUE, 1e-310],
] as const)("preserves a representable initial current in an extremely small parallel capacitor (%s)", (
  _label,
  largeCapacitance,
  smallCapacitance,
) => {
  const document: CircuitDocument = {
    title: "Extreme parallel capacitor current split",
    parts: [
      part("source", "battery", { voltageVolts: 1 }),
      part("resistor", "resistor", { resistanceOhms: 1e-308 }),
      part("large-capacitor", "capacitor", { capacitanceFarads: largeCapacitance }),
      part("small-capacitor", "capacitor", { capacitanceFarads: smallCapacitance }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-resistor", "source", "a", "resistor", "a"),
      wire("resistor-large-capacitor", "resistor", "b", "large-capacitor", "a"),
      wire("large-small-a", "large-capacitor", "a", "small-capacitor", "a"),
      wire("large-capacitor-ground", "large-capacitor", "b", "ground", "a"),
      wire("small-capacitor-ground", "small-capacitor", "b", "ground", "a"),
      wire("source-ground", "source", "b", "ground", "a"),
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 1e-10, timeStepSeconds: 1e-10 });
  const initial = result.samples[0]?.parts;
  const smallCurrent = initial?.["small-capacitor"]?.currentAmps;
  const expectedSmallCurrent = (smallCapacitance / 1e-308) / largeCapacitance;

  expect(result.status, result.message).toBe("valid");
  expect(initial?.["large-capacitor"]?.currentAmps).toBeCloseTo(1e308, 12);
  expect(smallCurrent).toBeGreaterThan(0);
  expect(smallCurrent! / expectedSmallCurrent).toBeCloseTo(1, 12);
});
