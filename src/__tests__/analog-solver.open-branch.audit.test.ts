import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeAnalogCircuit } from "../analog-solver.js";

const part = (
  id: string,
  kind: CircuitPartKind,
  extra: Partial<CircuitPart> = {},
): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function highResistanceLoopWithOpenBranch(): CircuitDocument {
  return {
    title: "High-resistance loop with an open branch",
    parts: [
      part("n0", "junction"),
      part("n1", "junction"),
      part("n2", "junction"),
      part("n3", "junction"),
      part("source", "battery", { voltageVolts: 9, internalResistanceOhms: 100 }),
      part("large", "resistor", { resistanceOhms: 100_000_000 }),
      part("open-branch", "resistor", { resistanceOhms: 1 }),
      part("small", "resistor", { resistanceOhms: 1 }),
      part("return", "resistor", { resistanceOhms: 100 }),
    ],
    wires: [
      wire("wire-source-positive", "source", "a", "n1", "a"),
      wire("wire-source-negative", "source", "b", "n0", "a"),
      wire("wire-large-a", "large", "a", "n2", "a"),
      wire("wire-large-b", "large", "b", "n3", "a"),
      wire("wire-open-branch", "open-branch", "b", "n3", "a"),
      wire("wire-small-a", "small", "a", "n2", "a"),
      wire("wire-small-b", "small", "b", "n1", "a"),
      wire("wire-return-a", "return", "a", "n3", "a"),
      wire("wire-return-b", "return", "b", "n0", "a"),
    ],
  };
}

describe("analog solver open-branch audit", () => {
  it("solves an ordinary high-resistance loop independently of an unconnected branch", () => {
    const result = analyzeAnalogCircuit(highResistanceLoopWithOpenBranch(), { mode: "dc" });
    const expectedCurrent = 9 / (100 + 1 + 100_000_000 + 100);

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.source.current.real / -expectedCurrent).toBeCloseTo(1, 12);
    expect(result.parts.small.current.real / -expectedCurrent).toBeCloseTo(1, 12);
    expect(result.parts.large.current.real / expectedCurrent).toBeCloseTo(1, 12);
    expect(result.parts.return.current.real / expectedCurrent).toBeCloseTo(1, 12);
    expect(result.parts["open-branch"].current.real).toBeCloseTo(0, 12);
  });
});
