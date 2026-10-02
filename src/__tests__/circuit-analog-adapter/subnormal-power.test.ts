import { describe, expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("AC power at subnormal scales", () => {
  it.each([0, 30, 45, 60, 90, 135, 225])("keeps real power invariant at %i° source phase", (phaseDegrees) => {
    const document: CircuitDocument = {
      title: "微小交流電力",
      parts: [
        part("source", "ac-source", { voltageVolts: 2e-162, frequencyHz: 1, phaseDegrees }),
        part("load", "resistor", { resistanceOhms: 1 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.source.powerWatts).toBe(Number.MIN_VALUE);
    expect(result.parts.load.powerWatts).toBe(Number.MIN_VALUE);
  });
});
