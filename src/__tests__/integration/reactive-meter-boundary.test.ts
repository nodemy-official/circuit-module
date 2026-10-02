import { expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../../circuit-model.js";
import { acReactiveReactance } from "../../ac-reactive.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { getMeterDisplay } from "../../ui/CircuitMeterReadout.js";

const part = (id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...fields,
});

const wire = (id: string, from: string, fromTerminal: "a" | "b", to: string, toTerminal: "a" | "b") => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function relativeError(actual: number, expected: number) {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

it.each([
  { kind: "capacitor" as const, reactanceToResistance: 1.5 },
  { kind: "capacitor" as const, reactanceToResistance: 2.5 },
  { kind: "inductor" as const, reactanceToResistance: 1.5 },
  { kind: "inductor" as const, reactanceToResistance: 2.5 },
])("compares the $kind RMS voltage and meter at X/R=$reactanceToResistance around Number.MAX_VALUE", ({ kind, reactanceToResistance: x }) => {
  const resistance = 1e308;
  const sourceVoltage = 1e308;
  const frequencyHz = 0.5;
  const omegaTimesRatio = 2 * Math.PI * frequencyHz * x;
  const reactiveValue = kind === "capacitor"
    ? (1 / resistance) / omegaTimesRatio
    : (resistance / (2 * Math.PI * frequencyHz)) * x;
  const document: CircuitDocument = {
    title: `${kind} reactance boundary`,
    parts: [
      part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
      part("resistor", "resistor", { resistanceOhms: resistance }),
      part(kind, kind, kind === "capacitor"
        ? { capacitanceFarads: reactiveValue }
        : { inductanceHenries: reactiveValue }),
      part("meter", "voltmeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-resistor", "source", "a", "resistor", "a"),
      wire("resistor-reactive", "resistor", "b", kind, "a"),
      wire("reactive-source", kind, "b", "source", "b"),
      wire("meter-positive", "meter", "a", kind, "a"),
      wire("meter-negative", "meter", "b", kind, "b"),
      wire("reference", "ground", "a", "source", "b"),
    ],
  };

  const reactivePart = document.parts.find((candidate) => candidate.kind === kind)!;
  expect(Number.isFinite(acReactiveReactance(reactivePart, frequencyHz))).toBe(x === 1.5);
  const result = analyzeCircuit(document, {}, { mode: "ac" });
  const denominator = 1 + x ** 2;
  const quadrature = kind === "capacitor" ? 1 : -1;
  const expectedResistorVoltage = sourceVoltage / Math.sqrt(denominator);
  const expectedReactiveVoltage = sourceVoltage * (x / Math.sqrt(denominator));
  const expectedPhase = Math.atan2(-quadrature, x) * 180 / Math.PI;

  expect(result.status, result.message).toBe("closed");
  expect(result.frequencyHz).toBe(frequencyHz);
  const resistorVoltage = result.parts.resistor.voltageVolts;
  const reactiveVoltage = result.parts[kind].voltageVolts;
  const meterVoltage = result.parts.meter.voltageVolts;
  expect(Number.isFinite(resistorVoltage)).toBe(true);
  expect(Number.isFinite(reactiveVoltage)).toBe(true);
  expect(Number.isFinite(meterVoltage)).toBe(true);
  expect(relativeError(resistorVoltage, expectedResistorVoltage), "resistor RMS voltage").toBeLessThan(2e-7);
  expect(relativeError(reactiveVoltage, expectedReactiveVoltage), `${kind} RMS voltage`).toBeLessThan(2e-7);
  expect(relativeError(meterVoltage, expectedReactiveVoltage), "voltmeter RMS voltage").toBeLessThan(2e-7);
  expect(result.parts.meter.meterStatus).toBe("connected");
  expect(result.parts[kind].voltagePhaseDegrees).toBeCloseTo(expectedPhase, 7);
  expect(result.parts.meter.voltagePhaseDegrees).toBeCloseTo(expectedPhase, 7);
  expect(getMeterDisplay("voltmeter", result.parts.meter, result.status)?.text).toContain("実効値");
});
