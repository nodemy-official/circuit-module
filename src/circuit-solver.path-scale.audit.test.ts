import { expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...fields,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({ id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } });

it("preserves a representable residual voltage when source-path scale exceeds Number.MAX_VALUE", () => {
  const document: CircuitDocument = {
    title: "大きな逆向き電源の残差",
    parts: [
      part("first", "battery", { voltageVolts: 1e308 }),
      part("second", "battery", { voltageVolts: 9e307 }),
      part("load", "resistor", { resistanceOhms: 1e308 }),
    ],
    wires: [
      wire("source-junction", "first", "b", "second", "b"),
      wire("load-positive", "load", "a", "first", "a"),
      wire("load-negative", "load", "b", "second", "a"),
    ],
  };

  const result = analyzeCircuit(document);

  expect(result.status, result.message).toBe("closed");
  expect(result.parts.load.voltageVolts / 1e307).toBeCloseTo(1, 12);
  expect(result.parts.load.currentAmps).toBeCloseTo(0.1, 12);
  expect(result.parts.first.currentAmps).toBeCloseTo(-0.1, 12);
  expect(result.parts.second.currentAmps).toBeCloseTo(0.1, 12);
});
