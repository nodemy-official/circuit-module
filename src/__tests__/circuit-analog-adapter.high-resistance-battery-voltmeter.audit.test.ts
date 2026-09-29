import { expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPartId: string,
  fromTerminal: CircuitTerminal,
  toPartId: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPartId, terminal: fromTerminal },
  to: { partId: toPartId, terminal: toTerminal },
});

it("publishes matching high-resistance battery, load, and voltmeter drops", () => {
  const document: CircuitDocument = {
    title: "公開APIの高抵抗電池端子電圧",
    parts: [
      part("battery", "battery", { voltageVolts: 3, internalResistanceOhms: 1e20 }),
      part("load", "resistor", { resistanceOhms: 1 }),
      part("meter", "voltmeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("battery-load", "battery", "a", "load", "a"),
      wire("load-return", "load", "b", "battery", "b"),
      wire("meter-positive", "meter", "a", "battery", "a"),
      wire("meter-negative", "meter", "b", "battery", "b"),
      wire("ground-return", "ground", "a", "battery", "b"),
    ],
  };
  const expectedCurrent = 3 / (1e20 + 1);

  const result = analyzeCircuit(document, {}, { mode: "dc" });

  expect(result.status, result.message).toBe("closed");
  expect(result.parts.meter.meterStatus).toBe("connected");
  expect(result.parts.load.voltageVolts / expectedCurrent).toBeCloseTo(1, 9);
  expect(result.parts.battery.voltageVolts / expectedCurrent).toBeCloseTo(1, 9);
  expect(result.parts.meter.voltageVolts / expectedCurrent).toBeCloseTo(1, 9);
  expect(result.parts.battery.voltageVolts).toBe(result.parts.load.voltageVolts);
  expect(result.parts.meter.voltageVolts).toBe(result.parts.load.voltageVolts);
});
