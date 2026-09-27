import { expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeAnalogCircuit, type ComplexValue } from "./analog-solver.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { circuitNodes, circuitPotential } from "./circuit-visualization.js";

const makePart = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
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

const sourceVoltage: ComplexValue = {
  real: 17 * Math.cos((37 * Math.PI) / 180),
  imaginary: 17 * Math.sin((37 * Math.PI) / 180),
};
const magnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);
const phaseDegrees = (value: ComplexValue) => Math.atan2(value.imaginary, value.real) * 180 / Math.PI;
const scale = (value: ComplexValue, factor: number): ComplexValue => ({
  real: value.real * factor,
  imaginary: value.imaginary * factor,
});
const subtract = (first: ComplexValue, second: ComplexValue): ComplexValue => ({
  real: first.real - second.real,
  imaginary: first.imaginary - second.imaginary,
});

function potentiometerCircuit(position: number, includeLoadAndMeter = false): CircuitDocument {
  return {
    title: "交流ポテンショメーターの分圧",
    parts: [
      makePart("source", "ac-source", { voltageVolts: 17, phaseDegrees: 37, frequencyHz: 400 }),
      makePart("pot", "potentiometer", { resistanceOhms: 1200, wiperPosition: position }),
      ...(includeLoadAndMeter ? [
        makePart("load", "resistor", { resistanceOhms: 3300 }),
        makePart("meter", "voltmeter"),
      ] : []),
    ],
    wires: [
      wire("source-a", "source", "a", "pot", "a"),
      wire("source-b", "source", "b", "pot", "b"),
      ...(includeLoadAndMeter ? [
        wire("load-c", "load", "a", "pot", "c"),
        wire("load-b", "load", "b", "pot", "b"),
        wire("meter-c", "meter", "a", "pot", "c"),
        wire("meter-b", "meter", "b", "pot", "b"),
      ] : []),
    ],
  };
}

function potDrops(reading: ReturnType<typeof analyzeAnalogCircuit>["parts"][string]) {
  const terminalVoltages = reading.terminalVoltages;
  const terminalA = terminalVoltages.a!;
  const terminalB = terminalVoltages.b!;
  const wiperC = terminalVoltages.c!;
  return {
    ab: subtract(terminalA, terminalB),
    ac: subtract(terminalA, wiperC),
    cb: subtract(wiperC, terminalB),
  };
}

function nodeAt(nodes: ReturnType<typeof circuitNodes>, partId: string, terminal: CircuitTerminal) {
  const node = nodes.find((candidate) => candidate.endpoints.some((endpoint) =>
    endpoint.partId === partId && endpoint.terminal === terminal));
  if (!node) { throw new Error(`Missing node ${partId}:${terminal}`); }
  return node;
}

it.each([0, 0.2, 1])("AC potentiometer follows the divider equation at wiper position %s", (position) => {
  const document = potentiometerCircuit(position);
  const core = analyzeAnalogCircuit(document, { mode: "ac" });
  expect(core.status, core.message).toBe("valid");
  const { ab, ac, cb } = potDrops(core.parts.pot);
  const expectedAc = scale(sourceVoltage, position);
  const expectedCb = scale(sourceVoltage, 1 - position);
  expect(core.parts.source.voltage.real).toBeCloseTo(sourceVoltage.real, 8);
  expect(core.parts.source.voltage.imaginary).toBeCloseTo(sourceVoltage.imaginary, 8);
  expect(ab.real).toBeCloseTo(sourceVoltage.real, 8);
  expect(ab.imaginary).toBeCloseTo(sourceVoltage.imaginary, 8);
  expect(ac.real).toBeCloseTo(expectedAc.real, 8);
  expect(ac.imaginary).toBeCloseTo(expectedAc.imaginary, 8);
  expect(cb.real).toBeCloseTo(expectedCb.real, 8);
  expect(cb.imaginary).toBeCloseTo(expectedCb.imaginary, 8);
  expect(core.parts.pot.voltage.real).toBeCloseTo(sourceVoltage.real, 8);
  expect(core.parts.pot.voltage.imaginary).toBeCloseTo(sourceVoltage.imaginary, 8);

  const analysis = analyzeCircuit(document, {}, { mode: "ac" });
  expect(analysis.status, analysis.message).toBe("closed");
  expect(analysis.parts.pot.voltageVolts).toBeCloseTo(17, 8);
  expect(analysis.parts.pot.voltagePhaseDegrees).toBeCloseTo(37, 8);
  const nodes = circuitNodes(document, analysis);
  const context = { document, analysis, nodes };
  const potentialAb = circuitPotential(nodeAt(nodes, "pot", "a"), nodeAt(nodes, "pot", "b"), true, context);
  const potentialAc = circuitPotential(nodeAt(nodes, "pot", "a"), nodeAt(nodes, "pot", "c"), true, context);
  const potentialCb = circuitPotential(nodeAt(nodes, "pot", "c"), nodeAt(nodes, "pot", "b"), true, context);
  expect(potentialAb?.volts).toBeCloseTo(magnitude(sourceVoltage), 8);
  expect(potentialAb?.phaseDegrees).toBeCloseTo(phaseDegrees(sourceVoltage), 8);
  expect(potentialAc?.volts).toBeCloseTo(magnitude(expectedAc), 8);
  expect(potentialAc?.phaseDegrees).toBeCloseTo(phaseDegrees(expectedAc), 8);
  expect(potentialCb?.volts).toBeCloseTo(magnitude(expectedCb), 8);
  expect(potentialCb?.phaseDegrees).toBeCloseTo(phaseDegrees(expectedCb), 8);
});

it("keeps the loaded C-B divider phasor on the potentiometer and parallel voltmeter", () => {
  const position = 0.2;
  const totalResistance = 1200;
  const loadResistance = 3300;
  const resistanceAc = totalResistance * position;
  const resistanceCb = totalResistance * (1 - position);
  const parallelCb = (resistanceCb * loadResistance) / (resistanceCb + loadResistance);
  const totalSeries = resistanceAc + parallelCb;
  const expectedAc = scale(sourceVoltage, resistanceAc / totalSeries);
  const expectedCb = scale(sourceVoltage, parallelCb / totalSeries);
  const document = potentiometerCircuit(position, true);

  const core = analyzeAnalogCircuit(document, { mode: "ac" });
  expect(core.status, core.message).toBe("valid");
  const { ab, ac, cb } = potDrops(core.parts.pot);
  expect(core.parts.source.voltage.real).toBeCloseTo(sourceVoltage.real, 8);
  expect(core.parts.source.voltage.imaginary).toBeCloseTo(sourceVoltage.imaginary, 8);
  expect(ab.real).toBeCloseTo(sourceVoltage.real, 8);
  expect(ab.imaginary).toBeCloseTo(sourceVoltage.imaginary, 8);
  expect(ac.real).toBeCloseTo(expectedAc.real, 8);
  expect(ac.imaginary).toBeCloseTo(expectedAc.imaginary, 8);
  expect(cb.real).toBeCloseTo(expectedCb.real, 8);
  expect(cb.imaginary).toBeCloseTo(expectedCb.imaginary, 8);
  expect(core.parts.pot.voltage.real).toBeCloseTo(sourceVoltage.real, 8);
  expect(core.parts.pot.voltage.imaginary).toBeCloseTo(sourceVoltage.imaginary, 8);
  expect(core.parts.meter.voltage.real).toBeCloseTo(expectedCb.real, 8);
  expect(core.parts.meter.voltage.imaginary).toBeCloseTo(expectedCb.imaginary, 8);
  expect(core.parts.meter.current).toEqual({ real: 0, imaginary: 0 });

  const analysis = analyzeCircuit(document, {}, { mode: "ac" });
  expect(analysis.status, analysis.message).toBe("closed");
  expect(analysis.parts.pot.voltageVolts).toBeCloseTo(17, 8);
  expect(analysis.parts.pot.voltagePhaseDegrees).toBeCloseTo(37, 8);
  expect(analysis.parts.meter.voltageVolts).toBeCloseTo(magnitude(expectedCb), 8);
  expect(analysis.parts.meter.voltagePhaseDegrees).toBeCloseTo(phaseDegrees(expectedCb), 8);
  const nodes = circuitNodes(document, analysis);
  const context = { document, analysis, nodes };
  const potentialAb = circuitPotential(nodeAt(nodes, "pot", "a"), nodeAt(nodes, "pot", "b"), true, context);
  const potentialAc = circuitPotential(nodeAt(nodes, "pot", "a"), nodeAt(nodes, "pot", "c"), true, context);
  const potentialCb = circuitPotential(nodeAt(nodes, "pot", "c"), nodeAt(nodes, "pot", "b"), true, context);
  expect(potentialAb?.volts).toBeCloseTo(magnitude(sourceVoltage), 8);
  expect(potentialAb?.phaseDegrees).toBeCloseTo(phaseDegrees(sourceVoltage), 8);
  expect(potentialAc?.volts).toBeCloseTo(magnitude(expectedAc), 8);
  expect(potentialAc?.phaseDegrees).toBeCloseTo(phaseDegrees(expectedAc), 8);
  expect(potentialCb?.volts).toBeCloseTo(magnitude(expectedCb), 8);
  expect(potentialCb?.phaseDegrees).toBeCloseTo(phaseDegrees(expectedCb), 8);
});
