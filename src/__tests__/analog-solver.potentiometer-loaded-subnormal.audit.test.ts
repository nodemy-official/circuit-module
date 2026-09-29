import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

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
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

it.each(["dc", "ac"] as const)(
  "preserves loaded potentiometer currents in %s when a segment is below the subnormal range",
  (mode) => {
  const minimum = Number.MIN_VALUE;
  const document: CircuitDocument = {
    title: "Loaded subnormal potentiometer segment",
    parts: [
      part("source", mode === "dc" ? "battery" : "ac-source", {
        voltageVolts: minimum,
        ...(mode === "ac" ? { frequencyHz: 1000 } : {}),
      }),
      part("pot", "potentiometer", { resistanceOhms: minimum, wiperPosition: 0.5 }),
      part("load", "resistor", { resistanceOhms: minimum }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-positive", "source", "a", "pot", "a"),
      wire("source-negative", "source", "b", "pot", "b"),
      wire("ground", "source", "b", "ground", "a"),
      wire("load-wiper", "load", "a", "pot", "c"),
      wire("load-ground", "load", "b", "ground", "a"),
    ],
  };

  const analysis = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });

  expect(analysis.status, analysis.message).toBe("valid");
  // Exact ratios: R_ac = R_cb = min/2, (R_cb || R_load) = min/3,
  // so R_total = 5min/6, I_source = 6/5 A, and I_load = 2/5 A.
  expect(analysis.parts.source.current.real).toBeCloseTo(-1.2, 12);
  expect(analysis.parts.pot.current.real).toBeCloseTo(1.2, 12);
  expect(analysis.parts.pot.terminalCurrents.a?.real).toBeCloseTo(1.2, 12);
  expect(analysis.parts.pot.terminalCurrents.b?.real).toBeCloseTo(-0.8, 12);
  expect(analysis.parts.pot.terminalCurrents.c?.real).toBeCloseTo(-0.4, 12);
  expect(analysis.parts.pot.power.real).toBe(minimum);
  expect(analysis.parts.load.current.real).toBeCloseTo(0.4, 12);
  expect(analysis.parts.load.power.real).toBe(0);
  },
);

it.each([
  { mode: "dc" as const, position: 0, sourceCurrent: -2, loadCurrent: 1, wiperCurrent: -1 },
  { mode: "dc" as const, position: 1, sourceCurrent: -1, loadCurrent: 0, wiperCurrent: 0 },
  { mode: "ac" as const, position: 0, sourceCurrent: -2, loadCurrent: 1, wiperCurrent: -1 },
  { mode: "ac" as const, position: 1, sourceCurrent: -1, loadCurrent: 0, wiperCurrent: 0 },
])("keeps the wiper endpoint $position as a true short in $mode", ({ mode, position, sourceCurrent, loadCurrent, wiperCurrent }) => {
  const minimum = Number.MIN_VALUE;
  const document: CircuitDocument = {
    title: "Subnormal potentiometer endpoint",
    parts: [
      part("source", mode === "dc" ? "battery" : "ac-source", {
        voltageVolts: minimum,
        ...(mode === "ac" ? { frequencyHz: 1000 } : {}),
      }),
      part("pot", "potentiometer", { resistanceOhms: minimum, wiperPosition: position }),
      part("load", "resistor", { resistanceOhms: minimum }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-positive", "source", "a", "pot", "a"),
      wire("source-negative", "source", "b", "pot", "b"),
      wire("ground", "source", "b", "ground", "a"),
      wire("load-wiper", "load", "a", "pot", "c"),
      wire("load-ground", "load", "b", "ground", "a"),
    ],
  };

  const analysis = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.source.current.real).toBeCloseTo(sourceCurrent, 12);
  expect(analysis.parts.load.current.real).toBeCloseTo(loadCurrent, 12);
  expect(analysis.parts.pot.terminalCurrents.c?.real).toBeCloseTo(wiperCurrent, 12);
  expect(analysis.parts.pot.power.real).toBe(minimum);
});
