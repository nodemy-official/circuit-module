import { describe, expect, it } from "vitest";
import { createCircuitExample } from "./circuit-examples.js";
import { createExampleCircuit } from "./circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "./circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential, defaultReferenceNode } from "./circuit-visualization.js";
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
  });

  it("uses the solved switch override instead of the stored part state", () => {
    const document = switchCircuit(true);
    const analysis = analyzeCircuit(document, { switch: false }, { mode: "ac" });
    expect(analysis.status).not.toBe("invalid");
    expect(analysis.parts.switch.switchClosed).toBe(false);
    const nodes = circuitNodes(document, analysis);
    expect(nodeAt(nodes, "switch", "a").referenceGroup).not.toBe(nodeAt(nodes, "switch", "b").referenceGroup);
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
