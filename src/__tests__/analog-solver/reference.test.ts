import { describe, expect, it } from "vitest";

import { circuitPartCatalog, terminalsOf, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { circuitNodes, circuitPotential } from "../../circuit-visualization.js";

const createPart = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (id: string, fromPart: string, fromTerminal: "a" | "b", toPart: string, toTerminal: "a" | "b") => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

const polar = (magnitude: number, phaseDegrees: number) => ({
  real: magnitude * Math.cos(phaseDegrees * Math.PI / 180),
  imaginary: magnitude * Math.sin(phaseDegrees * Math.PI / 180),
});

const subtract = (first: { real: number; imaginary: number }, second: { real: number; imaginary: number }) => ({
  real: first.real - second.real,
  imaginary: first.imaginary - second.imaginary,
});

const multiply = (first: { real: number; imaginary: number }, second: { real: number; imaginary: number }) => ({
  real: first.real * second.real - first.imaginary * second.imaginary,
  imaginary: first.real * second.imaginary + first.imaginary * second.real,
});

function complexError(
  actual: { real: number; imaginary: number },
  expected: { real: number; imaginary: number },
) {
  return Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
}

function relativelyEqual(actual: number | undefined, expected: number | undefined) {
  const actualValue = actual ?? 0;
  const expectedValue = expected ?? 0;
  return Math.abs(actualValue - expectedValue) <=
    1e-12 + 1e-12 * Math.max(Math.abs(actualValue), Math.abs(expectedValue));
}

function highDropDocument(options: { groundAt?: "high" | "right" | "middle"; secondGround?: boolean; meter?: boolean } = {}): CircuitDocument {
  const parts = [
    createPart("high", "ac-source", { voltageVolts: 1e16, phaseDegrees: 31, frequencyHz: 60 }),
    createPart("left", "resistor", { resistanceOhms: 1e16 }),
    createPart("small", "ac-source", { voltageVolts: 2e-3, phaseDegrees: -47, frequencyHz: 60 }),
    createPart("load", "resistor", { resistanceOhms: 1e-3 }),
    createPart("right", "resistor", { resistanceOhms: 1e16 }),
    createPart("ground", "ground"),
    ...(options.secondGround ? [createPart("ground2", "ground")] : []),
    ...(options.meter ? [createPart("meter", "voltmeter")] : []),
  ];
  const wires = [
    wire("high-left", "high", "a", "left", "a"),
    wire("left-small", "left", "b", "small", "a"),
    wire("left-load", "left", "b", "load", "a"),
    wire("small-right", "small", "b", "right", "a"),
    wire("load-right", "load", "b", "right", "a"),
    wire("return", "high", "b", "right", "b"),
    wire(
      "ground-wire",
      "ground",
      "a",
      options.groundAt === "right" ? "right" : options.groundAt === "middle" ? "left" : "high",
      "b",
    ),
    ...(options.meter ? [
      wire("meter-load-a", "meter", "a", "load", "a"),
      wire("meter-load-b", "meter", "b", "load", "b"),
    ] : []),
  ];
  return { title: "抵抗降下の先にある微小電圧源", parts, wires };
}

function maximumNormalizedKclResidual(document: CircuitDocument, result: Extract<ReturnType<typeof analyzeAnalogCircuit>, { status: "valid" }>) {
  const parent = new Map<string, string>();
  const key = (partId: string, terminal: CircuitTerminal) => JSON.stringify([partId, terminal]);
  const find = (endpoint: string): string => {
    const previous = parent.get(endpoint);
    if (!previous) {
      parent.set(endpoint, endpoint);
      return endpoint;
    }
    if (previous === endpoint) { return endpoint; }
    const root = find(previous);
    parent.set(endpoint, root);
    return root;
  };
  const union = (first: string, second: string) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) { parent.set(firstRoot, secondRoot); }
  };
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) { find(key(part.id, terminal)); }
  }
  for (const connection of document.wires) {
    union(key(connection.from.partId, connection.from.terminal), key(connection.to.partId, connection.to.terminal));
  }
  const grounds = document.parts.filter((part) => part.kind === "ground");
  for (const ground of grounds.slice(1)) { union(key(grounds[0]!.id, "a"), key(ground.id, "a")); }
  const sums = new Map<string, { real: number; imaginary: number }>();
  const scales = new Map<string, number>();
  for (const part of document.parts) {
    const reading = result.parts[part.id];
    for (const terminal of terminalsOf(part.kind)) {
      const current = reading?.terminalCurrents[terminal] ?? { real: 0, imaginary: 0 };
      const net = find(key(part.id, terminal));
      const sum = sums.get(net) ?? { real: 0, imaginary: 0 };
      sums.set(net, { real: sum.real + current.real, imaginary: sum.imaginary + current.imaginary });
      scales.set(net, (scales.get(net) ?? 0) + Math.hypot(current.real, current.imaginary));
    }
  }
  return Math.max(...[...sums].map(([net, sum]) =>
    Math.hypot(sum.real, sum.imaginary) / Math.max(scales.get(net) ?? 0, 1),
  ));
}

describe("AC reference topology audit", () => {
  it("preserves millivolt load voltage after a large resistive common-mode drop", () => {
    const document = highDropDocument({ meter: true });
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") { return; }

    const expectedVoltage = polar(2e-3, -47);
    const expectedCurrent = polar(2, -47);
    expect(result.parts.small.voltage.real).toBeCloseTo(expectedVoltage.real, 11);
    expect(result.parts.small.voltage.imaginary).toBeCloseTo(expectedVoltage.imaginary, 11);
    expect(result.parts.load.voltage.real).toBeCloseTo(expectedVoltage.real, 11);
    expect(result.parts.load.voltage.imaginary).toBeCloseTo(expectedVoltage.imaginary, 11);
    expect(result.parts.load.current.real).toBeCloseTo(expectedCurrent.real, 8);
    expect(result.parts.load.current.imaginary).toBeCloseTo(expectedCurrent.imaginary, 8);
    expect(maximumNormalizedKclResidual(document, result)).toBeLessThan(1e-9);

    const expectedHighSource = polar(1e16, 31);
    const expectedOuterCurrent = {
      real: (expectedHighSource.real - expectedVoltage.real) / (2e16),
      imaginary: (expectedHighSource.imaginary - expectedVoltage.imaginary) / (2e16),
    };
    const expectedSmallCurrent = subtract(expectedOuterCurrent, expectedCurrent);
    const expectedSmallPower = multiply(expectedVoltage, {
      real: expectedSmallCurrent.real,
      imaginary: -expectedSmallCurrent.imaginary,
    });
    const expectedLoadPower = multiply(expectedVoltage, {
      real: expectedCurrent.real,
      imaginary: -expectedCurrent.imaginary,
    });
    expect(complexError(result.parts.left.current, expectedOuterCurrent)).toBeLessThan(1e-9);
    expect(complexError(result.parts.right.current, expectedOuterCurrent)).toBeLessThan(1e-9);
    expect(complexError(result.parts.small.current, expectedSmallCurrent)).toBeLessThan(1e-9);
    expect(complexError(result.parts.small.power, expectedSmallPower)).toBeLessThan(1e-12);
    expect(complexError(result.parts.load.power, expectedLoadPower)).toBeLessThan(1e-12);
    expect(relativelyEqual(result.parts.left.power.real, 1e16 * (
      expectedOuterCurrent.real ** 2 + expectedOuterCurrent.imaginary ** 2
    ))).toBe(true);
    expect(relativelyEqual(result.parts.right.power.real, 1e16 * (
      expectedOuterCurrent.real ** 2 + expectedOuterCurrent.imaginary ** 2
    ))).toBe(true);
    expect(relativelyEqual(result.parts.high.power.real, multiply(expectedHighSource, {
      real: -expectedOuterCurrent.real,
      imaginary: expectedOuterCurrent.imaginary,
    }).real)).toBe(true);

    // The absolute terminal voltages are too large to retain their 2 mV delta
    // as two separate IEEE-754 numbers; component and meter paths must retain it.
    expect(result.parts.small.terminalVoltages.a.real).toBe(result.parts.small.terminalVoltages.b.real);
    const publicResult = analyzeCircuit(document, {}, { mode: "ac" });
    expect(publicResult.status).toBe("closed");
    expect(publicResult.parts.meter.voltageVolts).toBeCloseTo(2e-3, 10);
    expect(publicResult.parts.meter.voltagePhaseDegrees).toBeCloseTo(-47, 8);
    const nodes = circuitNodes(document, publicResult);
    const positive = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "small" && endpoint.terminal === "a"));
    const negative = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "small" && endpoint.terminal === "b"));
    const measured = circuitPotential(positive, negative, true, { document, analysis: publicResult });
    expect(measured?.volts).toBeCloseTo(2e-3, 10);
    expect(measured?.phaseDegrees).toBeCloseTo(-47, 8);
  });

  it("keeps component, meter and potential differences invariant under GND placement, ordering and duplicate grounds", () => {
    const baselineDocument = highDropDocument({ meter: true });
    const baseline = analyzeCircuit(baselineDocument, {}, { mode: "ac" });
    const movedGroundDocument = highDropDocument({ groundAt: "middle", meter: true });
    const movedGround = analyzeCircuit(movedGroundDocument, {}, { mode: "ac" });
    const duplicateGroundDocument = highDropDocument({ secondGround: true, meter: true });
    const duplicateGround = analyzeCircuit(duplicateGroundDocument, {}, { mode: "ac" });
    const reorderedDocument: CircuitDocument = {
      ...duplicateGroundDocument,
      parts: [...duplicateGroundDocument.parts].reverse(),
      wires: [...duplicateGroundDocument.wires].reverse(),
    };
    const reordered = analyzeCircuit(reorderedDocument, {}, { mode: "ac" });

    for (const result of [baseline, movedGround, duplicateGround, reordered]) {
      expect(result.status).toBe("closed");
      expect(result.parts.small?.voltageVolts).toBeCloseTo(2e-3, 10);
      expect(result.parts.small?.voltagePhaseDegrees).toBeCloseTo(-47, 8);
      expect(result.parts.load?.voltageVolts).toBeCloseTo(2e-3, 10);
      expect(result.parts.load?.voltagePhaseDegrees).toBeCloseTo(-47, 8);
      expect(result.parts.load?.currentAmps).toBeCloseTo(2, 8);
      expect(result.parts.meter?.voltageVolts).toBeCloseTo(2e-3, 10);
      expect(result.parts.meter?.voltagePhaseDegrees).toBeCloseTo(-47, 8);
    }
    for (const id of Object.keys(baseline.parts)) {
      expect(relativelyEqual(movedGround.parts[id]?.voltageVolts, baseline.parts[id]?.voltageVolts)).toBe(true);
      expect(relativelyEqual(movedGround.parts[id]?.currentAmps, baseline.parts[id]?.currentAmps)).toBe(true);
      expect(movedGround.parts[id]?.voltagePhaseDegrees).toBeCloseTo(baseline.parts[id]?.voltagePhaseDegrees ?? 0, 8);
      expect(movedGround.parts[id]?.currentPhaseDegrees).toBeCloseTo(baseline.parts[id]?.currentPhaseDegrees ?? 0, 8);
      expect(relativelyEqual(duplicateGround.parts[id]?.voltageVolts, baseline.parts[id]?.voltageVolts)).toBe(true);
      expect(duplicateGround.parts[id]?.voltagePhaseDegrees).toBeCloseTo(baseline.parts[id]?.voltagePhaseDegrees ?? 0, 8);
      expect(duplicateGround.parts[id]?.currentPhaseDegrees).toBeCloseTo(baseline.parts[id]?.currentPhaseDegrees ?? 0, 8);
      expect(relativelyEqual(reordered.parts[id]?.voltageVolts, baseline.parts[id]?.voltageVolts)).toBe(true);
      expect(relativelyEqual(reordered.parts[id]?.currentAmps, baseline.parts[id]?.currentAmps)).toBe(true);
      expect(reordered.parts[id]?.voltagePhaseDegrees).toBeCloseTo(baseline.parts[id]?.voltagePhaseDegrees ?? 0, 8);
      expect(reordered.parts[id]?.currentPhaseDegrees).toBeCloseTo(baseline.parts[id]?.currentPhaseDegrees ?? 0, 8);
    }
    const measureSmallSource = (document: CircuitDocument, analysis: ReturnType<typeof analyzeCircuit>) => {
      const nodes = circuitNodes(document, analysis);
      const positive = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "small" && endpoint.terminal === "a"));
      const negative = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "small" && endpoint.terminal === "b"));
      return circuitPotential(positive, negative, true, { document, analysis })?.volts;
    };
    expect(measureSmallSource(baselineDocument, baseline)).toBeCloseTo(2e-3, 10);
    expect(measureSmallSource(movedGroundDocument, movedGround)).toBeCloseTo(2e-3, 10);
    expect(measureSmallSource(duplicateGroundDocument, duplicateGround)).toBeCloseTo(2e-3, 10);
    expect(measureSmallSource(reorderedDocument, reordered)).toBeCloseTo(2e-3, 10);
  });
});
