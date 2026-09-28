import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "./circuit-model.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
});
const wire = (id: string, from: string, a: CircuitTerminal, to: string, b: CircuitTerminal) => ({
  id, from: { partId: from, terminal: a }, to: { partId: to, terminal: b },
});

it("does not report a unique ammeter current around a compatible ideal source cycle", () => {
  const document: CircuitDocument = {
    title: "理想電源の電流分配",
    parts: [part("source", "ac-source"), part("meter", "ammeter"), part("load", "resistor", { resistanceOhms: 10 }), part("battery", "battery")],
    wires: [
      wire("w1", "source", "a", "load", "a"),
      wire("w2", "load", "b", "meter", "a"),
      wire("w3", "meter", "b", "source", "b"),
      wire("w4", "battery", "a", "meter", "a"),
      wire("w5", "battery", "b", "meter", "b"),
    ],
  };
  for (const parts of [document.parts, [...document.parts].reverse()]) {
    const result = analyzeAnalogCircuit({ ...document, parts }, { mode: "ac", frequencyHz: 1000 });
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.load.current.real).toBeCloseTo(0.5, 12);
    expect(result.parts.meter.meterStatus).toBe("floating");
  }
});

it.each([
  { mode: "dc" as const, wiperPosition: 0 },
  { mode: "dc" as const, wiperPosition: 1 },
  { mode: "ac" as const, wiperPosition: 0 },
  { mode: "ac" as const, wiperPosition: 1 },
])("detects an ammeter bypassing the zero-ohm potentiometer segment at $mode position $wiperPosition", ({ mode, wiperPosition }) => {
  const terminal = wiperPosition === 0 ? "a" : "b";
  const sourceKind = mode === "dc" ? "battery" : "ac-source";
  const document: CircuitDocument = {
    title: "可変抵抗の端点",
    parts: [part("source", sourceKind, { voltageVolts: 5, frequencyHz: 50 }), part("pot", "potentiometer", { resistanceOhms: 1000, wiperPosition }), part("meter", "ammeter")],
    wires: [
      wire("w1", "source", "a", "pot", "a"),
      wire("w2", "source", "b", "pot", "b"),
      wire("w3", "meter", "a", "pot", terminal),
      wire("w4", "meter", "b", "pot", "c"),
    ],
  };
  for (const parts of [document.parts, [...document.parts].reverse()]) {
    const result = analyzeAnalogCircuit({ ...document, parts }, mode === "dc" ? { mode } : { mode, frequencyHz: 50 });
    expect(result.status, result.message).toBe("valid");
    if (mode === "dc") { expect(result.parts.source.current.real).toBeCloseTo(-0.005, 12); }
    expect(result.parts.meter.meterStatus).toBe("floating");
  }
});

it("keeps an ammeter connected when a finite internal resistance removes the ideal bypass", () => {
  const document: CircuitDocument = {
    title: "有限内部抵抗を持つ電源の迂回路",
    parts: [
      part("source", "ac-source", { voltageVolts: 5, frequencyHz: 50 }),
      part("meter", "ammeter"),
      part("load", "resistor", { resistanceOhms: 10 }),
      part("battery", "battery", { voltageVolts: 5, internalResistanceOhms: 10 }),
    ],
    wires: [
      wire("w1", "source", "a", "load", "a"),
      wire("w2", "load", "b", "meter", "a"),
      wire("w3", "meter", "b", "source", "b"),
      wire("w4", "battery", "a", "meter", "a"),
      wire("w5", "battery", "b", "meter", "b"),
    ],
  };

  const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });

  expect(result.status, result.message).toBe("valid");
  expect(result.parts.load.current.real).toBeCloseTo(0.5, 12);
  expect(result.parts.meter.current.real).toBeCloseTo(0.5, 12);
  expect(result.parts.meter.meterStatus).toBe("connected");
});

it("marks the ammeter floating when opposed ideal batteries form a zero-volt DC bypass", () => {
  const document: CircuitDocument = {
    title: "正味0Vの逆向き理想電源による迂回路",
    parts: [
      part("source", "battery", { voltageVolts: 5 }),
      part("meter", "ammeter"),
      part("load", "resistor", { resistanceOhms: 10 }),
      part("positive-a", "battery", { voltageVolts: 5 }),
      part("positive-b", "battery", { voltageVolts: 5 }),
    ],
    wires: [
      wire("outer-source-load", "source", "a", "load", "a"),
      wire("outer-load-meter", "load", "b", "meter", "a"),
      wire("outer-meter-source", "meter", "b", "source", "b"),
      wire("bypass-a", "positive-a", "a", "meter", "a"),
      wire("bypass-midpoint", "positive-a", "b", "positive-b", "b"),
      wire("bypass-b", "positive-b", "a", "meter", "b"),
    ],
  };

  const result = analyzeAnalogCircuit(document, { mode: "dc" });

  expect(result.status, result.message).toBe("valid");
  expect(result.parts.load.current.real).toBeCloseTo(0.5, 12);
  expect(result.parts.meter.meterStatus).toBe("floating");
});
