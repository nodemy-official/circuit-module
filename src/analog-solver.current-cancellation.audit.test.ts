import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { simulateTransient } from "./transient-solver.js";

const smallCurrent = 1e-16;
const resistance = 1e12;

function part(id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...fields };
}

function currentCancellationCircuit(currents: number[], loadFirst = false): CircuitDocument {
  const sources = currents.map((currentAmps, index) =>
    part(`source-${index}`, "current-source", { currentAmps }),
  );
  const load = part("load", "resistor", { resistanceOhms: resistance });
  return {
    title: "Opposing sources with a small remaining current",
    parts: loadFirst ? [load, ...sources] : [...sources, load],
    wires: sources.flatMap((source) => (["a", "b"] as const).map((terminal) => ({
      id: `${source.id}-${terminal}`,
      from: { partId: source.id, terminal },
      to: { partId: load.id, terminal },
    }))),
  };
}

const sourceOrders = [
  [1, smallCurrent, -1],
  [1, -1, smallCurrent],
  [smallCurrent, 1, -1],
  [smallCurrent, -1, 1],
  [-1, 1, smallCurrent],
  [-1, smallCurrent, 1],
  [1e308, 1e308, smallCurrent, -1e308, -1e308],
];

describe("KCL cancellation across independent sources", () => {
  it.each(sourceOrders.map((currents) => ({ currents })))(
    "retains the small net current for $currents regardless of the reference node",
    ({ currents }) => {
      for (const loadFirst of [false, true]) {
        const document = currentCancellationCircuit(currents, loadFirst);
        const analog = analyzeAnalogCircuit(document);
        const adapted = analyzeCircuit(document);

        // The opposing source pairs cancel exactly; KCL gives I_R = -I_small.
        expect(analog.status, analog.message).toBe("valid");
        expect(analog.parts.load.current.real / -smallCurrent).toBeCloseTo(1, 12);
        expect(analog.parts.load.voltage.real / (-smallCurrent * resistance)).toBeCloseTo(1, 12);
        expect(adapted.status, adapted.message).toBe("closed");
        expect(adapted.parts.load.currentAmps / -smallCurrent).toBeCloseTo(1, 12);
      }
    },
  );

  it("preserves the same current balance in every transient sample", () => {
    const document = currentCancellationCircuit([1, smallCurrent, -1]);
    const transient = simulateTransient(document, { durationSeconds: 0.002, timeStepSeconds: 0.001 });

    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples).toHaveLength(3);
    for (const sample of transient.samples) {
      expect(sample.parts.load.currentAmps / -smallCurrent).toBeCloseTo(1, 12);
      expect(sample.parts.load.voltageVolts / (-smallCurrent * resistance)).toBeCloseTo(1, 12);
    }
  });
});
