import { describe, expect, it } from "vitest";
import { createCircuitExample } from "./circuit-examples.js";
import { createExampleCircuit } from "./circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "./circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential, defaultReferenceNode, formatCircuitQuantity } from "./circuit-visualization.js";
import { simulateTransient, type TransientAnalysis } from "./transient-solver.js";
import type { CircuitDocument, CircuitPart, CircuitTerminal } from "./circuit-model.js";
import { terminalsOf } from "./circuit-model.js";

function nodeAt(nodes: ReturnType<typeof circuitNodes>, partId: string, terminal: string) {
  const node = nodes.find((item) => item.endpoints.some((endpoint) => endpoint.partId === partId && endpoint.terminal === terminal));
  if (!node) { throw new Error(`Missing node ${partId}:${terminal}`); }
  return node;
}

function switchCircuit(initiallyClosed: boolean): CircuitDocument {
  return {
    title: "独立したスイッチ",
    parts: [{ id: "switch", kind: "switch", label: "スイッチ", x: 0, y: 0, initiallyClosed }],
    wires: [],
  };
}

function makeAnalysis(document: CircuitDocument, overrides: Record<string, Partial<CircuitPartReading>> = {}): CircuitAnalysis {
  const parts: Record<string, CircuitPartReading> = Object.fromEntries(document.parts.map((part) => {
    const terminalVoltages = Object.fromEntries(terminalsOf(part.kind).map((terminal) => [terminal, 0])) as Partial<Record<CircuitTerminal, number>>;
    const terminalCurrents = Object.fromEntries(terminalsOf(part.kind).map((terminal) => [terminal, 0])) as Partial<Record<CircuitTerminal, number>>;
    return [part.id, {
      voltageVolts: 0,
      currentAmps: 0,
      powerWatts: 0,
      terminalVoltages,
      terminalCurrents,
      ...overrides[part.id],
    }];
  }));
  return {
    status: "closed",
    currentAmps: null,
    message: "test analysis",
    bulbPowerWatts: {},
    parts,
    wireCurrents: {},
    issues: [],
    mode: "dc",
  };
}

describe("learning quantities", () => {
  it("merges connected wires and measures legacy DC potentials from the selected reference", () => {
    const document = createExampleCircuit();
    const analysis = analyzeCircuit(document);
    const nodes = circuitNodes(document, analysis);
    const reference = defaultReferenceNode(document, nodes);
    expect(nodeAt(nodes, "part-1", "b")).toBe(nodeAt(nodes, "part-2", "a"));
    expect(circuitPotential(nodeAt(nodes, "part-1", "a"), reference, false)?.volts).toBeCloseTo(9, 5);
    expect(circuitPotential(nodeAt(nodes, "part-2", "a"), nodeAt(nodes, "part-2", "b"), false)?.volts).toBeCloseTo(analysis.parts["part-2"].voltageVolts, 5);
  });

  it("shows branch-current conservation without assigning currents to ideal wire loops", () => {
    const document: CircuitDocument = {
      title: "並列回路", parts: [
        { id: "s", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 10 },
        { id: "r1", kind: "resistor", label: "R1", x: 10, y: 0, resistanceOhms: 1000 },
        { id: "r2", kind: "resistor", label: "R2", x: 10, y: 10, resistanceOhms: 2000 },
        { id: "g", kind: "ground", label: "GND", x: 0, y: 10 },
      ], wires: [
        { id: "w1", from: { partId: "s", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
        { id: "w2", from: { partId: "r1", terminal: "a" }, to: { partId: "r2", terminal: "a" } },
        { id: "w3", from: { partId: "r2", terminal: "a" }, to: { partId: "s", terminal: "a" } },
        { id: "w4", from: { partId: "s", terminal: "b" }, to: { partId: "r1", terminal: "b" } },
        { id: "w5", from: { partId: "s", terminal: "b" }, to: { partId: "r2", terminal: "b" } },
        { id: "w6", from: { partId: "s", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      ],
    };
    const analysis = analyzeCircuit(document);
    const supplyNode = nodeAt(circuitNodes(document, analysis), "s", "a");
    expect(analysis.wireCurrents).toEqual({});
    expect(supplyNode.currents.map((entry) => entry.amps)).toEqual(expect.arrayContaining([expect.closeTo(-0.015, 8), expect.closeTo(0.01, 8), expect.closeTo(0.005, 8)]));
    expect(supplyNode.currentResidualAmps).toBeLessThan(1e-8);
  });

  it("subtracts AC phasors and sums currents with their phases", () => {
    const document = createCircuitExample("ac");
    const analysis = analyzeCircuit(document);
    const nodes = circuitNodes(document, analysis);
    const first = nodeAt(nodes, "resistor", "a");
    const second = nodeAt(nodes, "resistor", "b");
    const difference = circuitPotential(first, second, true);
    expect(difference?.volts).toBeCloseTo(analysis.parts.resistor.voltageVolts, 8);
    expect(difference?.phaseDegrees).toBeCloseTo(analysis.parts.resistor.voltagePhaseDegrees ?? 0, 8);
    expect(difference?.volts).not.toBeCloseTo((first.voltageVolts ?? 0) - (second.voltageVolts ?? 0), 2);
    for (const node of nodes) { expect(node.currentResidualAmps).toBeLessThan(1e-8); }
  });

  it("uses the exact branch reading for a millivolt difference above a large AC common mode", () => {
    const document: CircuitDocument = {
      title: "大きい共通電位上の微小交流電圧",
      parts: [
        { id: "current", kind: "current-source", label: "交流では無効な電流源", x: 0, y: 0, currentAmps: 0.01 },
        { id: "big", kind: "ac-source", label: "大きい交流電源", x: 0, y: 0, voltageVolts: 1e12, frequencyHz: 1000 },
        { id: "small", kind: "ac-source", label: "微小交流電源", x: 0, y: 0, voltageVolts: 1e-3, frequencyHz: 1000 },
        { id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: 1e12 },
        { id: "meter", kind: "voltmeter", label: "電圧計", x: 0, y: 0 },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "big", terminal: "a" }, to: { partId: "small", terminal: "b" } },
        { id: "w2", from: { partId: "small", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w3", from: { partId: "load", terminal: "b" }, to: { partId: "big", terminal: "b" } },
        { id: "w4", from: { partId: "meter", terminal: "a" }, to: { partId: "small", terminal: "a" } },
        { id: "w5", from: { partId: "meter", terminal: "b" }, to: { partId: "small", terminal: "b" } },
        { id: "w6", from: { partId: "ground", terminal: "a" }, to: { partId: "big", terminal: "b" } },
        { id: "w7", from: { partId: "current", terminal: "a" }, to: { partId: "small", terminal: "a" } },
        { id: "w8", from: { partId: "current", terminal: "b" }, to: { partId: "small", terminal: "b" } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    const nodes = circuitNodes(document, analysis);
    const positive = nodeAt(nodes, "small", "a");
    const negative = nodeAt(nodes, "small", "b");
    const roundedDifference = circuitPotential(positive, negative, true);
    const exactDifference = circuitPotential(positive, negative, true, { document, analysis });
    const reversed = circuitPotential(negative, positive, true, { document, analysis });

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.small.voltageVolts).toBeCloseTo(1e-3, 12);
    expect(roundedDifference?.volts).toBeLessThan(analysis.parts.small.voltageVolts);
    expect(Math.abs((roundedDifference?.volts ?? 0) - analysis.parts.small.voltageVolts)).toBeGreaterThan(1e-5);
    expect(exactDifference?.volts).toBeCloseTo(analysis.parts.small.voltageVolts, 12);
    expect(exactDifference?.phaseDegrees).toBeCloseTo(analysis.parts.small.voltagePhaseDegrees ?? 0, 10);
    expect(reversed?.volts).toBeCloseTo(analysis.parts.small.voltageVolts, 12);
    expect(Math.abs(reversed?.phaseDegrees ?? 0)).toBeCloseTo(180, 10);
  });

  it("sums precise branch voltages between arbitrary AC nodes across large common mode", () => {
    const document: CircuitDocument = {
      title: "大きい共通電位上の直列微小電圧",
      parts: [
        { id: "high", kind: "ac-source", label: "高電位源", x: 0, y: 0, voltageVolts: 1e12, frequencyHz: 1000 },
        { id: "r1", kind: "resistor", label: "R1", x: 0, y: 0, resistanceOhms: 1e-3 },
        { id: "r2", kind: "resistor", label: "R2", x: 0, y: 0, resistanceOhms: 1e-3 },
        { id: "r3", kind: "resistor", label: "R3", x: 0, y: 0, resistanceOhms: 1e-3 },
        { id: "small", kind: "ac-source", label: "微小電圧源", x: 0, y: 0, voltageVolts: 3e-3, frequencyHz: 1000 },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "ground", terminal: "a" }, to: { partId: "high", terminal: "b" } },
        { id: "w2", from: { partId: "high", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
        { id: "w3", from: { partId: "high", terminal: "a" }, to: { partId: "small", terminal: "a" } },
        { id: "w4", from: { partId: "r1", terminal: "b" }, to: { partId: "r2", terminal: "a" } },
        { id: "w5", from: { partId: "r2", terminal: "b" }, to: { partId: "r3", terminal: "a" } },
        { id: "w6", from: { partId: "r3", terminal: "b" }, to: { partId: "small", terminal: "b" } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    const nodes = circuitNodes(document, analysis);
    const first = nodeAt(nodes, "r1", "a");
    const last = nodeAt(nodes, "r2", "b");
    const rounded = circuitPotential(first, last, true);
    const context = { document, analysis, nodes };
    const measured = circuitPotential(first, last, true, context);
    const reversed = circuitPotential(last, first, true, context);
    const expectedReal = [analysis.parts.r1, analysis.parts.r2].reduce((sum, part) => sum + part.voltageVolts * Math.cos((part.voltagePhaseDegrees ?? 0) * Math.PI / 180), 0);
    const expectedImaginary = [analysis.parts.r1, analysis.parts.r2].reduce((sum, part) => sum + part.voltageVolts * Math.sin((part.voltagePhaseDegrees ?? 0) * Math.PI / 180), 0);
    const branchSum = Math.hypot(expectedReal, expectedImaginary);

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.small.voltageVolts).toBeCloseTo(0.003, 12);
    expect(analysis.parts.r1.voltageVolts).toBeCloseTo(0.001, 12);
    expect(analysis.parts.r2.voltageVolts).toBeCloseTo(0.001, 12);
    expect(analysis.parts.r1.currentAmps).toBeCloseTo(1, 10);
    expect(analysis.parts.r2.currentAmps).toBeCloseTo(1, 10);
    expect(analysis.parts.r1.currentAmps).toBeCloseTo(analysis.parts.r2.currentAmps, 8);
    expect(analysis.parts.r1.powerWatts + analysis.parts.r2.powerWatts).toBeCloseTo(0.002, 12);
    expect(analysis.parts.high.powerWatts + analysis.parts.small.powerWatts).toBeCloseTo(0.003, 12);
    expect(Math.max(...nodes.map((node) => node.currentResidualAmps ?? Number.POSITIVE_INFINITY))).toBeLessThan(1e-8);
    expect(branchSum).toBeCloseTo(0.002, 12);
    expect(rounded?.volts).toBeCloseTo(0.001_953_125, 12);
    expect(measured?.volts).toBeCloseTo(branchSum, 12);
    expect(measured?.phaseDegrees).toBeCloseTo(analysis.parts.r1.voltagePhaseDegrees ?? 0, 10);
    expect(reversed?.volts).toBeCloseTo(branchSum, 12);
    expect(Math.abs(reversed?.phaseDegrees ?? 0)).toBeCloseTo(180, 10);
  });

  it("keeps nonlinear AC branch voltage and arbitrary path readings above a large common mode", () => {
    const document: CircuitDocument = {
      title: "大共通電位上のダイオード微小信号",
      parts: [
        { id: "high", kind: "ac-source", label: "高電位源", x: 0, y: 0, voltageVolts: 1e12, frequencyHz: 1000 },
        { id: "small", kind: "ac-source", label: "微小電圧源", x: 0, y: 0, voltageVolts: 1e-3, frequencyHz: 1000 },
        { id: "bias", kind: "battery", label: "直流バイアス", x: 0, y: 0, voltageVolts: 5 },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 0, y: 0, resistanceOhms: 1000 },
        { id: "diode", kind: "diode", label: "ダイオード", x: 0, y: 0, saturationCurrentAmps: 1e-12 },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "ground", from: { partId: "high", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
        { id: "high-small", from: { partId: "high", terminal: "a" }, to: { partId: "small", terminal: "a" } },
        { id: "small-resistor", from: { partId: "small", terminal: "b" }, to: { partId: "resistor", terminal: "a" } },
        { id: "resistor-diode", from: { partId: "resistor", terminal: "b" }, to: { partId: "diode", terminal: "b" } },
        { id: "diode-bias", from: { partId: "diode", terminal: "a" }, to: { partId: "bias", terminal: "a" } },
        { id: "bias-return", from: { partId: "bias", terminal: "b" }, to: { partId: "high", terminal: "a" } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    const nodes = circuitNodes(document, analysis);
    const context = { document, analysis, nodes };
    const diodeVoltage = circuitPotential(
      nodeAt(nodes, "diode", "a"),
      nodeAt(nodes, "diode", "b"),
      true,
      context,
    );
    const pathVoltage = circuitPotential(
      nodeAt(nodes, "small", "b"),
      nodeAt(nodes, "bias", "a"),
      true,
      context,
    );

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.diode.currentAmps).toBeGreaterThan(0);
    expect(diodeVoltage?.volts).toBeCloseTo(analysis.parts.diode.voltageVolts, 10);
    expect(diodeVoltage?.volts).toBeGreaterThan(0);
    expect(pathVoltage?.volts).toBeCloseTo(1e-3, 10);
    expect(Math.abs(pathVoltage?.phaseDegrees ?? 0)).toBeCloseTo(180, 8);
  });

  it("measures potentiometer wiper segments precisely above a large AC common mode", () => {
    const document: CircuitDocument = {
      title: "大きい共通電位上のポテンショメーター摺動端子",
      parts: [
        { id: "high", kind: "ac-source", label: "高電位源", x: 0, y: 0, voltageVolts: 1e16, frequencyHz: 60 },
        { id: "left", kind: "resistor", label: "左抵抗", x: 0, y: 0, resistanceOhms: 1e16 },
        { id: "small", kind: "ac-source", label: "微小交流電源", x: 0, y: 0, voltageVolts: 2e-3, phaseDegrees: -47, frequencyHz: 60 },
        { id: "pot", kind: "potentiometer", label: "ポテンショメーター", x: 0, y: 0, resistanceOhms: 1e-3, wiperPosition: 0.5 },
        { id: "tail", kind: "resistor", label: "摺動端子の測定点", x: 0, y: 0, resistanceOhms: 1e6 },
        { id: "right", kind: "resistor", label: "右抵抗", x: 0, y: 0, resistanceOhms: 1e16 },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "high", terminal: "a" }, to: { partId: "left", terminal: "a" } },
        { id: "w2", from: { partId: "left", terminal: "b" }, to: { partId: "small", terminal: "a" } },
        { id: "w3", from: { partId: "left", terminal: "b" }, to: { partId: "pot", terminal: "a" } },
        { id: "w4", from: { partId: "small", terminal: "b" }, to: { partId: "right", terminal: "a" } },
        { id: "w5", from: { partId: "pot", terminal: "b" }, to: { partId: "right", terminal: "a" } },
        { id: "w8", from: { partId: "pot", terminal: "c" }, to: { partId: "tail", terminal: "a" } },
        { id: "w6", from: { partId: "high", terminal: "b" }, to: { partId: "right", terminal: "b" } },
        { id: "w7", from: { partId: "ground", terminal: "a" }, to: { partId: "high", terminal: "b" } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    const nodes = circuitNodes(document, analysis);
    const context = { document, analysis, nodes };
    const a = nodeAt(nodes, "pot", "a");
    const b = nodeAt(nodes, "pot", "b");
    const wiper = nodeAt(nodes, "pot", "c");
    const tailEnd = nodeAt(nodes, "tail", "b");
    const aToWiper = circuitPotential(a, wiper, true, context);
    const bToWiper = circuitPotential(b, wiper, true, context);
    const wiperToA = circuitPotential(wiper, a, true, context);
    const wiperToB = circuitPotential(wiper, b, true, context);
    const aToTail = circuitPotential(a, tailEnd, true, context);

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.pot.voltageVolts).toBeCloseTo(2e-3, 10);
    expect(a.referenceGroup).toBe(wiper.referenceGroup);
    expect(b.referenceGroup).toBe(wiper.referenceGroup);
    expect(aToWiper?.volts).toBeCloseTo(1e-3, 10);
    expect(aToWiper?.phaseDegrees).toBeCloseTo(-47, 8);
    expect(bToWiper?.volts).toBeCloseTo(1e-3, 10);
    expect(Math.abs(bToWiper?.phaseDegrees ?? 0)).toBeCloseTo(133, 8);
    expect(wiperToA?.volts).toBeCloseTo(1e-3, 10);
    expect(Math.abs(wiperToA?.phaseDegrees ?? 0)).toBeCloseTo(133, 8);
    expect(wiperToB?.volts).toBeCloseTo(1e-3, 10);
    expect(wiperToB?.phaseDegrees).toBeCloseTo(-47, 8);
    expect(aToTail?.volts).toBeCloseTo(1e-3, 10);
    expect(aToTail?.phaseDegrees).toBeCloseTo(-47, 8);
  });

  it("does not compare independently floating legacy islands", () => {
    const original = createExampleCircuit();
    const document: CircuitDocument = { ...original, parts: [...original.parts, { id: "floating", kind: "resistor", label: "孤立", x: 30, y: 5, resistanceOhms: 1000 }] };
    const nodes = circuitNodes(document, analyzeCircuit(document));
    expect(circuitPotential(nodeAt(nodes, "floating", "a"), defaultReferenceNode(document, nodes), false)).toBeNull();
  });

  it("does not imply a KCL violation at a simplified op-amp's omitted supply return", () => {
    const document = createCircuitExample("opamp");
    const nodes = circuitNodes(document, analyzeCircuit(document));
    const ground = nodeAt(nodes, "g1", "a");
    expect(ground.currentResidualAmps).toBeUndefined();
    expect(ground.currentBalanceNote).toContain("省略された電源端子");
    expect(nodeAt(nodes, "load", "a").currentResidualAmps).toBeLessThan(1e-8);
  });

  it("synchronizes RC terminal potentials, current conservation, and source power at each sampled instant", () => {
    const document = createCircuitExample("charging");
    const transient = simulateTransient(document, { durationSeconds: 0.005, timeStepSeconds: 0.000_05 });
    expect(transient.status).toBe("valid");
    const initial = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });
    const later = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 20 });
    if (!initial || !later) { throw new Error("Missing sampled analysis"); }
    expect(initial.parts.load.voltageVolts).toBeCloseTo(0, 8);
    expect(initial.parts.resistor.currentAmps).toBeCloseTo(0.005, 8);
    expect(later.parts.load.voltageVolts).toBeGreaterThan(3);
    expect(later.parts.resistor.currentAmps).toBeLessThan(0.002);
    expect(initial.parts.source.powerWatts).toBeCloseTo(0.025, 8);
    expect(later.timeSeconds).toBeCloseTo(0.001, 8);
    const nodes = circuitNodes(document, later);
    expect(circuitPotential(nodeAt(nodes, "load", "a"), defaultReferenceNode(document, nodes), false)?.volts).toBeCloseTo(later.parts.load.voltageVolts, 8);
    expect(nodeAt(nodes, "load", "a").currentResidualAmps).toBeLessThan(1e-8);
    expect(analysisAtTransientFrame(document, { analysis: transient, sampleIndex: -1 })).toBeNull();
  });

  it("preserves transient readings when a component ID is a prototype property name", () => {
    const sourceId = "__proto__";
    const example = createCircuitExample("charging");
    const document: CircuitDocument = {
      ...example,
      parts: example.parts.map((part) => part.id === "source" ? { ...part, id: sourceId } : part),
      wires: example.wires.map((wire) => ({
        ...wire,
        from: wire.from.partId === "source" ? { ...wire.from, partId: sourceId } : wire.from,
        to: wire.to.partId === "source" ? { ...wire.to, partId: sourceId } : wire.to,
      })),
    };
    const transient = simulateTransient(document, { durationSeconds: 0.0001, timeStepSeconds: 0.0001 });
    expect(transient.status).toBe("valid");
    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });
    expect(frame).not.toBeNull();
    expect(Object.hasOwn(frame?.parts ?? {}, sourceId)).toBe(true);
    expect(Object.keys(frame?.parts ?? {})).toContain(sourceId);
    expect(Math.abs(frame?.parts[sourceId]?.currentAmps ?? Number.NaN)).toBeCloseTo(0.005, 8);
  });

  it("does not treat inherited sample properties as component readings", () => {
    const sourceId = "__proto__";
    const document: CircuitDocument = {
      title: "欠けた過渡読み値",
      parts: [{ id: sourceId, kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 5 }],
      wires: [],
    };
    const transient: TransientAnalysis = {
      status: "valid",
      message: "test transient",
      issues: [],
      samples: [{ timeSeconds: 0, parts: {} }],
    };
    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });
    expect(frame).not.toBeNull();
    expect(Object.hasOwn(frame?.parts ?? {}, sourceId)).toBe(false);
    expect(Object.keys(frame?.parts ?? {})).not.toContain(sourceId);
  });

  it("does not report one source current for a transient circuit with an op-amp", () => {
    const document: CircuitDocument = {
      title: "オペアンプを含む回路",
      parts: [
        { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 10 },
        { id: "series", kind: "resistor", label: "負荷", x: 1, y: 0, resistanceOhms: 1000 },
        { id: "amp", kind: "op-amp", label: "オペアンプ", x: 2, y: 0 },
        { id: "amp-load", kind: "resistor", label: "出力負荷", x: 3, y: 0, resistanceOhms: 1000 },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 1 },
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "series", terminal: "a" } },
        { id: "w2", from: { partId: "series", terminal: "b" }, to: { partId: "source", terminal: "b" } },
        { id: "w3", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
        { id: "w4", from: { partId: "amp", terminal: "a" }, to: { partId: "ground", terminal: "a" } },
        { id: "w5", from: { partId: "amp", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
        { id: "w6", from: { partId: "amp", terminal: "c" }, to: { partId: "amp-load", terminal: "a" } },
        { id: "w7", from: { partId: "amp-load", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.0001, timeStepSeconds: 0.0001 });
    expect(transient.status).toBe("valid");
    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });
    expect(Math.abs(frame?.parts.source?.currentAmps ?? Number.NaN)).toBeCloseTo(0.01, 8);
    expect(frame?.currentAmps).toBeNull();
  });

  it("keeps the phase of small but nonzero AC potentials", () => {
    const document: CircuitDocument = {
      title: "微小な交流電位差",
      parts: [{ id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0 }],
      wires: [],
    };
    const analysis = makeAnalysis(document, {
      source: {
        terminalVoltages: { a: 1e-15, b: 0 },
        terminalVoltagePhasesDegrees: { a: 37, b: 0 },
      },
    });
    analysis.mode = "ac";
    const nodes = circuitNodes(document, analysis);
    const difference = circuitPotential(nodeAt(nodes, "source", "a"), nodeAt(nodes, "source", "b"), true);
    expect(difference?.volts).toBeGreaterThan(0);
    expect(difference?.volts).toBeCloseTo(1e-15, 20);
    expect(difference?.phaseDegrees).toBeCloseTo(37, 8);
    expect(formatCircuitQuantity(difference?.volts, "V")).not.toBe("0 V");
  });

  it("uses the solved switch override instead of the stored part state", () => {
    const document = switchCircuit(true);
    const analysis = analyzeCircuit(document, { switch: false }, { mode: "ac" });
    expect(analysis.status).not.toBe("invalid");
    expect(analysis.parts.switch.switchClosed).toBe(false);
    const nodes = circuitNodes(document, analysis);
    expect(nodeAt(nodes, "switch", "a").referenceGroup).not.toBe(nodeAt(nodes, "switch", "b").referenceGroup);
  });

  it.each([
    { kind: "capacitor" as const, frequencyHz: 1e-308, values: { capacitanceFarads: 1e-308 } },
    { kind: "inductor" as const, frequencyHz: 1e308, values: { inductanceHenries: 1e308 } },
  ])("keeps zero-admittance AC $kind branches open in status, meter, and potential references", ({
    kind,
    frequencyHz,
    values,
  }) => {
    const document: CircuitDocument = {
      title: "範囲外リアクタンスで分離する交流回路",
      parts: [
        { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 5, frequencyHz },
        { id: "loop-reactive", kind, label: "開放リアクタンス", x: 1, y: 0, ...values },
        { id: "load", kind: "resistor", label: "抵抗", x: 2, y: 0, resistanceOhms: 100 },
        { id: "floating-reactive", kind, label: "浮いたリアクタンス", x: 3, y: 0, ...values },
        { id: "meter", kind: "voltmeter", label: "電圧計", x: 4, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "loop-reactive", terminal: "a" } },
        { id: "w2", from: { partId: "loop-reactive", terminal: "b" }, to: { partId: "load", terminal: "a" } },
        { id: "w3", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
        { id: "w4", from: { partId: "floating-reactive", terminal: "a" }, to: { partId: "meter", terminal: "a" } },
        { id: "w5", from: { partId: "floating-reactive", terminal: "b" }, to: { partId: "meter", terminal: "b" } },
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const nodes = circuitNodes(document, analysis);
    const idleAnalysis = analyzeCircuit({
      ...document,
      parts: document.parts.map((part) => part.id === "source" ? { ...part, voltageVolts: 0 } : part),
    }, {}, { mode: "ac", frequencyHz });
    const sourceFrequency = kind === "capacitor" ? 1e308 : 1e-308;
    const mismatchedDocument = {
      ...document,
      parts: document.parts.map((part) => part.id === "source" ? { ...part, frequencyHz: sourceFrequency } : part),
    };
    const mismatchedFrequencyAnalysis = analyzeCircuit(mismatchedDocument, {}, { mode: "ac", frequencyHz });
    const mismatchedFrequencyNodes = circuitNodes(mismatchedDocument, mismatchedFrequencyAnalysis);

    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts.meter.meterStatus).toBe("floating");
    expect(nodeAt(nodes, "floating-reactive", "a").referenceGroup)
      .not.toBe(nodeAt(nodes, "floating-reactive", "b").referenceGroup);
    expect(circuitPotential(
      nodeAt(nodes, "floating-reactive", "a"),
      nodeAt(nodes, "floating-reactive", "b"),
      true,
    )).toBeNull();
    expect(idleAnalysis.status, idleAnalysis.message).toBe("idle");
    expect(mismatchedFrequencyAnalysis.status, mismatchedFrequencyAnalysis.message).toBe("idle");
    expect(mismatchedFrequencyAnalysis.parts.meter.meterStatus).toBe("floating");
    expect(nodeAt(mismatchedFrequencyNodes, "floating-reactive", "a").referenceGroup)
      .not.toBe(nodeAt(mismatchedFrequencyNodes, "floating-reactive", "b").referenceGroup);
  });

  it.each([
    { kind: "capacitor" as const, values: { capacitanceFarads: 1e-309 }, expectedCurrentAmps: 0.314 },
    { kind: "inductor" as const, values: { inductanceHenries: 1e308 }, expectedCurrentAmps: 0.318 },
  ])("retains a representable Norton path through an out-of-range $kind reactance", ({
    kind,
    values,
    expectedCurrentAmps,
  }) => {
    const frequencyHz = 0.5;
    const document: CircuitDocument = {
      title: "Nortonアドミタンスで閉じる交流回路",
      parts: [
        { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 1e308, frequencyHz },
        { id: "load", kind: "resistor", label: "抵抗", x: 1, y: 0, resistanceOhms: 1 },
        { id: "reactive", kind, label: "リアクタンス", x: 2, y: 0, ...values },
        { id: "meter", kind: "voltmeter", label: "電圧計", x: 3, y: 0 },
        { id: "ground", kind: "ground", label: "GND", x: 4, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "reactive", terminal: "a" } },
        { id: "w3", from: { partId: "reactive", terminal: "b" }, to: { partId: "source", terminal: "b" } },
        { id: "w4", from: { partId: "meter", terminal: "a" }, to: { partId: "reactive", terminal: "a" } },
        { id: "w5", from: { partId: "meter", terminal: "b" }, to: { partId: "reactive", terminal: "b" } },
        { id: "w6", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" } },
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const nodes = circuitNodes(document, analysis);

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.source.currentAmps).toBeCloseTo(expectedCurrentAmps, 2);
    expect(analysis.parts.meter.meterStatus).toBe("connected");
    expect(nodeAt(nodes, "reactive", "a").referenceGroup)
      .toBe(nodeAt(nodes, "reactive", "b").referenceGroup);
  });

  it("uses the transient switch override when grouping sampled potentials", () => {
    const document = switchCircuit(false);
    const transient = simulateTransient(document, {
      durationSeconds: 0.0001,
      timeStepSeconds: 0.0001,
      switchStates: { switch: true },
    });
    expect(transient.status).toBe("valid");
    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });
    expect(frame?.parts.switch?.switchClosed).toBe(true);
    const nodes = circuitNodes(document, frame!);
    expect(nodeAt(nodes, "switch", "a").referenceGroup).toBe(nodeAt(nodes, "switch", "b").referenceGroup);
  });

  it("uses the solver's first node as the implicit reference for an op-amp without GND", () => {
    const document: CircuitDocument = {
      title: "GNDなしのオペアンプ",
      parts: [
        { id: "anchor", kind: "resistor", label: "基準抵抗", x: 0, y: 0, resistanceOhms: 1000 },
        { id: "amp", kind: "op-amp", label: "オペアンプ", x: 1, y: 0 },
      ],
      wires: [],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "dc" });
    expect(analysis.status).not.toBe("invalid");
    const nodes = circuitNodes(document, analysis);
    expect(nodeAt(nodes, "amp", "c").referenceGroup).toBe(nodeAt(nodes, "anchor", "a").referenceGroup);
    expect(nodeAt(nodes, "amp", "b").referenceGroup).not.toBe(nodeAt(nodes, "amp", "c").referenceGroup);
  });

  it.each([
    {
      name: "current-source terminals",
      part: { id: "current", kind: "current-source", label: "電流源", x: 1, y: 0, currentAmps: 0.01 } as CircuitPart,
      terminals: ["a", "b"] as const,
    },
    {
      name: "MOSFET gate and channel",
      part: { id: "mos", kind: "nmos", label: "MOSFET", x: 1, y: 0 } as CircuitPart,
      terminals: ["a", "b"] as const,
    },
    {
      name: "op-amp input and output",
      part: { id: "amp", kind: "op-amp", label: "オペアンプ", x: 1, y: 0 } as CircuitPart,
      terminals: ["b", "c"] as const,
    },
  ])("keeps $name in separate potential reference groups", ({ part, terminals }) => {
    const document: CircuitDocument = {
      title: "独立した電位基準",
      parts: [{ id: "ground", kind: "ground", label: "GND", x: 0, y: 0 }, part],
      wires: [],
    };
    const nodes = circuitNodes(document, makeAnalysis(document));
    const first = nodeAt(nodes, part.id, terminals[0]);
    const second = nodeAt(nodes, part.id, terminals[1]);
    expect(first.referenceGroup).not.toBe(second.referenceGroup);
    expect(circuitPotential(first, second, false)).toBeNull();
  });
});
