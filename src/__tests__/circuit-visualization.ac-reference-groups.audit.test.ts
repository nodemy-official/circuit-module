import { describe, expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { circuitNodes, circuitPotential } from "../circuit-visualization.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function nodeAt(nodes: ReturnType<typeof circuitNodes>, partId: string, terminal: CircuitTerminal) {
  const node = nodes.find((candidate) => candidate.endpoints.some((endpoint) =>
    endpoint.partId === partId && endpoint.terminal === terminal,
  ));
  if (!node) { throw new Error(`Missing node ${partId}:${terminal}`); }
  return node;
}

function zeroSlopeDiodeCircuit(): CircuitDocument {
  return {
    title: "Zero-slope diode between floating AC islands",
    parts: [
      part("diode", "diode", {
        saturationCurrentAmps: Number.MIN_VALUE,
        emissionCoefficient: Number.MAX_VALUE,
      }),
      part("left-load", "resistor", { resistanceOhms: 1000 }),
      part("right-load", "resistor", { resistanceOhms: 2000 }),
      part("meter", "voltmeter"),
    ],
    wires: [
      wire("left-diode", "diode", "a", "left-load", "a"),
      wire("right-diode", "diode", "b", "right-load", "a"),
      wire("meter-left", "meter", "a", "diode", "a"),
      wire("meter-right", "meter", "b", "diode", "b"),
    ],
  };
}

describe("public AC reference groups", () => {
  it.each(["diode", "led"] as const)("does not count a zero-slope %s as an AC source return path", (kind) => {
    const document: CircuitDocument = {
      title: `Open AC ${kind}`,
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 1000 }),
        part(kind, kind, {
          saturationCurrentAmps: Number.MIN_VALUE,
          emissionCoefficient: Number.MAX_VALUE,
        }),
      ],
      wires: [
        wire("source-a", "source", "a", kind, "a"),
        wire("source-b", "source", "b", kind, "b"),
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts[kind].currentAmps).toBe(0);
    expect(analysis.parts[kind].acReferenceTerminalGroups).toEqual([]);
  });

  it("does not count a zero-response BJT as an AC source return path", () => {
    const document: CircuitDocument = {
      title: "Open AC BJT with reverse-biased junctions",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 1000 }),
        part("base-bias", "battery", { voltageVolts: 1 }),
        part("emitter-bias", "battery", { voltageVolts: 2 }),
        part("q", "npn-transistor", { saturationCurrentAmps: Number.MIN_VALUE }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-collector", "source", "a", "q", "a"),
        wire("source-emitter", "source", "b", "q", "c"),
        wire("base-bias", "base-bias", "a", "q", "b"),
        wire("base-ground", "base-bias", "b", "ground", "a"),
        wire("emitter-bias", "emitter-bias", "a", "q", "c"),
        wire("emitter-ground", "emitter-bias", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts.q.acReferenceTerminalGroups).toEqual([]);
    expect(analysis.parts.q.acCurrentResponseTerminalGroups).toEqual([]);
  });

  it("does not treat a base-current-only BJT slope as collector-emitter current transport", () => {
    const thermalVoltage = 0.025_85;
    const reverseBiasedForwardSlope = Number.MIN_VALUE * Math.exp(-10) / thermalVoltage;
    const scaledBaseSlope = Math.exp(-10) / thermalVoltage;
    const document: CircuitDocument = {
      title: "Open collector-emitter AC path with base-only BJT response",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 1000 }),
        part("base-bias", "battery", { voltageVolts: 10 * thermalVoltage }),
        part("q", "npn-transistor", {
          currentGain: Number.MIN_VALUE,
          saturationCurrentAmps: Number.MIN_VALUE,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-collector", "source", "a", "q", "a"),
        wire("source-emitter", "source", "b", "q", "c"),
        wire("base-reference", "base-bias", "a", "ground", "a"),
        wire("base-voltage", "base-bias", "b", "q", "b"),
        wire("emitter-ground", "q", "c", "ground", "a"),
      ],
    };

    const bias = analyzeCircuit(document, {}, { mode: "dc" });
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(reverseBiasedForwardSlope).toBe(0);
    expect(scaledBaseSlope).toBeGreaterThan(0);
    expect(bias.parts.q.terminalVoltages!.b - bias.parts.q.terminalVoltages!.c)
      .toBeCloseTo(-10 * thermalVoltage, 14);
    expect(analysis.parts.q.acReferenceTerminalGroups).toContainEqual(["b", "c"]);
    expect(analysis.parts.q.acCurrentResponseTerminalGroups).toEqual([["b", "c"]]);
    expect(analysis.status, analysis.message).toBe("open");
  });

  it("retains BJT transport current when only the collector-base junction responds", () => {
    const document: CircuitDocument = {
      title: "Active AC BJT return path",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, offsetVolts: -2, frequencyHz: 1000 }),
        part("base-bias", "battery", { voltageVolts: 1 }),
        part("emitter-bias", "battery", { voltageVolts: 2 }),
        part("q", "npn-transistor", { saturationCurrentAmps: Number.MIN_VALUE }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-collector", "source", "a", "q", "a"),
        wire("source-emitter", "source", "b", "q", "c"),
        wire("base-bias", "base-bias", "a", "q", "b"),
        wire("base-ground", "base-bias", "b", "ground", "a"),
        wire("emitter-bias", "emitter-bias", "a", "q", "c"),
        wire("emitter-ground", "emitter-bias", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.q.acReferenceTerminalGroups).toContainEqual(["a", "b"]);
    expect(analysis.parts.q.acReferenceTerminalGroups).not.toContainEqual(["b", "c"]);
    expect(analysis.parts.q.acCurrentResponseTerminalGroups).toEqual([["a", "b", "c"]]);
  });

  it("keeps MOS gate-controlled current as a return path when drain-source voltage reference is open", () => {
    const document: CircuitDocument = {
      title: "Lambda-zero MOS small-signal current return path",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, offsetVolts: 2, frequencyHz: 1000 }),
        part("gate-bias", "battery", { voltageVolts: 1 }),
        part("mos", "nmos", {
          thresholdVolts: 0,
          transconductanceAmpsPerVoltSquared: 2,
          channelLengthModulation: 0,
        }),
        part("source-reference", "resistor", { resistanceOhms: 1000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-drain", "source", "a", "mos", "a"),
        wire("source-source", "source", "b", "mos", "c"),
        wire("gate-bias", "gate-bias", "a", "mos", "b"),
        wire("gate-ground", "gate-bias", "b", "ground", "a"),
        wire("source-reference", "mos", "c", "source-reference", "a"),
        wire("reference-ground", "source-reference", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.mos.channelConducting).toBe(true);
    expect(analysis.parts.mos.acReferenceTerminalGroups).toEqual([["b", "c"]]);
    expect(analysis.parts.mos.acReferenceTerminalGroups).not.toContainEqual(["a", "c"]);
  });

  it("keeps zero-slope nonlinear terminals on separate visualization references", () => {
    const document = zeroSlopeDiodeCircuit();

    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });
    const nodes = circuitNodes(document, analysis);
    const diodeA = nodeAt(nodes, "diode", "a");
    const diodeB = nodeAt(nodes, "diode", "b");

    expect(analysis.status, analysis.message).toBe("idle");
    expect(analysis.parts.diode.acReferenceTerminalGroups).toEqual([]);
    expect(diodeA.referenceGroup).not.toBe(diodeB.referenceGroup);
    expect(circuitPotential(diodeA, diodeB, true, { document, analysis, nodes })).toBeNull();
  });

  it("uses static AC topology only when small-signal metadata is undefined", () => {
    const document = zeroSlopeDiodeCircuit();
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("idle");
    expect(analysis.parts.diode.acReferenceTerminalGroups).toEqual([]);
    analysis.parts.diode.acReferenceTerminalGroups = [["a", "b"]];
    let nodes = circuitNodes(document, analysis);
    expect(nodeAt(nodes, "diode", "a").referenceGroup).toBe(nodeAt(nodes, "diode", "b").referenceGroup);

    analysis.parts.diode.acReferenceTerminalGroups = [];
    nodes = circuitNodes(document, analysis);
    expect(nodeAt(nodes, "diode", "a").referenceGroup).not.toBe(nodeAt(nodes, "diode", "b").referenceGroup);

    analysis.parts.diode.acReferenceTerminalGroups = undefined;
    nodes = circuitNodes(document, analysis);
    expect(nodeAt(nodes, "diode", "a").referenceGroup).toBe(nodeAt(nodes, "diode", "b").referenceGroup);
  });

  it("propagates connected small-signal groups through the public reading", () => {
    const document: CircuitDocument = {
      title: "Conducting AC diode",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 1000 }),
        part("diode", "diode"),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-diode", "source", "a", "diode", "a"),
        wire("diode-resistor", "diode", "b", "resistor", "a"),
        wire("resistor-ground", "resistor", "b", "ground", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
      ],
    };

    const analysis = analyzeCircuit(document, {}, { mode: "ac" });

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.diode.acReferenceTerminalGroups).toEqual([["a", "b"]]);
  });
});
