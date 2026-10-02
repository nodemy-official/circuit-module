import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "../../circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], fields: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...fields,
});

const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

it.each([
  { mode: "dc" as const, totalResistance: Number.MIN_VALUE },
  { mode: "dc" as const, totalResistance: 3 * Number.MIN_VALUE },
  { mode: "ac" as const, totalResistance: Number.MIN_VALUE },
  { mode: "ac" as const, totalResistance: 3 * Number.MIN_VALUE },
])("preserves total resistance in $mode when splitting $totalResistance ohms", ({ mode, totalResistance }) => {
  const voltage = totalResistance;
  const document: CircuitDocument = {
    title: "Subnormal potentiometer segments",
    parts: [
      mode === "dc"
        ? part("source", "battery", { voltageVolts: voltage })
        : part("source", "ac-source", { voltageVolts: voltage, frequencyHz: 1000 }),
      part("pot", "potentiometer", { resistanceOhms: voltage, wiperPosition: 0.5 }),
    ],
    wires: [
      wire("positive", "source", "a", "pot", "a"),
      wire("negative", "source", "b", "pot", "b"),
    ],
  };

  const analysis = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.source.current.real).toBe(-1);
  expect(analysis.parts.pot.current.real).toBe(1);
  expect(analysis.parts.pot.voltage.real).toBe(voltage);
  expect(analysis.parts.pot.power.real).toBe(voltage);
});

it("keeps complementary potentiometer positions symmetric", () => {
  const analyzeAt = (wiperPosition: number) => {
    const document: CircuitDocument = {
      title: "Complementary potentiometer positions",
      parts: [
        part("source", "battery", { voltageVolts: 10 }),
        part("pot", "potentiometer", { resistanceOhms: 1000, wiperPosition }),
        part("ground", "ground"),
      ],
      wires: [
        wire("positive", "source", "a", "pot", "a"),
        wire("negative", "source", "b", "pot", "b"),
        wire("reference", "source", "b", "ground", "a"),
      ],
    };
    return analyzeAnalogCircuit(document, { mode: "dc" });
  };

  const first = analyzeAt(0.25);
  const mirrored = analyzeAt(0.75);

  expect(first.status, first.message).toBe("valid");
  expect(mirrored.status, mirrored.message).toBe("valid");
  expect(first.parts.pot.terminalVoltages.c?.real).toBeCloseTo(7.5, 12);
  expect(mirrored.parts.pot.terminalVoltages.c?.real).toBeCloseTo(2.5, 12);
  expect(first.parts.pot.current.real).toBeCloseTo(mirrored.parts.pot.current.real, 12);
  expect(first.parts.pot.power.real).toBeCloseTo(mirrored.parts.pot.power.real, 12);
});
