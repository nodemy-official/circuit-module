import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitPart, CircuitTerminal } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { circuitNodes, circuitPotential } from "../circuit-visualization.js";

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) {
  return { id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } };
}

function floatingDrain(kind: "nmos" | "pmos", gateVoltage = 0): CircuitDocument {
  return {
    title: "MOSFETの状態と電位基準",
    parts: [
      part("mos", kind),
      part("gate", "ac-source", { voltageVolts: 0, offsetVolts: gateVoltage }),
      part("meter", "voltmeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("gate-input", "gate", "a", "mos", "b"),
      wire("gate-ground", "gate", "b", "ground", "a"),
      wire("source-ground", "mos", "c", "ground", "a"),
      wire("drain-meter", "mos", "a", "meter", "a"),
      wire("meter-ground", "meter", "b", "ground", "a"),
    ],
  };
}

describe("MOS channel state across analysis and potential display", () => {
  it.each(["nmos", "pmos"] as const)("keeps an unreferenced %s drain floating in DC and AC", (kind) => {
    const document = floatingDrain(kind);
    for (const mode of ["dc", "ac"] as const) {
      const analysis = analyzeCircuit(document, {}, { mode });
      expect(analysis.status, analysis.message).toBe("idle");
      expect(analysis.parts.meter.meterStatus).toBe("floating");
      expect(analysis.parts.mos.channelConducting).toBe(false);
      const nodes = circuitNodes(document, analysis);
      const drain = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "mos" && endpoint.terminal === "a"));
      const source = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "mos" && endpoint.terminal === "c"));
      expect(circuitPotential(drain, source, mode === "ac", { document, analysis, nodes })).toBeNull();
    }
  });

  it.each(["nmos", "pmos"] as const)("uses the DC bias of an on %s even at zero drain current", (kind) => {
    const document = floatingDrain(kind, kind === "nmos" ? 5 : -5);
    for (const mode of ["dc", "ac"] as const) {
      const analysis = analyzeCircuit(document, {}, { mode });
      expect(analysis.status, analysis.message).not.toBe("invalid");
      expect(analysis.parts.mos.channelConducting).toBe(true);
      expect(analysis.parts.mos.currentAmps).toBeCloseTo(0, 12);
      expect(analysis.parts.meter.meterStatus).toBe("connected");
      const nodes = circuitNodes(document, analysis);
      const drain = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "mos" && endpoint.terminal === "a"));
      const source = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "mos" && endpoint.terminal === "c"));
      expect(circuitPotential(drain, source, mode === "ac", { document, analysis, nodes })?.volts).toBeCloseTo(0, 12);
    }
  });

  it.each([1e12, 1e20])("does not disturb an independent %s-ohm load with a floating cut-off drain", (resistanceOhms) => {
    const document = floatingDrain("nmos");
    document.parts.push(
      part("supply", "ac-source", { voltageVolts: 3, offsetVolts: 5 }),
      part("load", "resistor", { resistanceOhms }),
    );
    document.wires.push(
      wire("supply-load", "supply", "a", "load", "a"),
      wire("load-ground", "load", "b", "ground", "a"),
      wire("supply-ground", "supply", "b", "ground", "a"),
    );
    for (const mode of ["dc", "ac"] as const) {
      const analysis = analyzeCircuit(document, {}, { mode });
      expect(analysis.status, analysis.message).toBe("closed");
      const expectedCurrent = (mode === "dc" ? 5 : 3) / resistanceOhms;
      expect(analysis.parts.load.currentAmps / expectedCurrent).toBeCloseTo(1, 10);
      expect(analysis.parts.meter.meterStatus).toBe("floating");
    }
  });

  it.each(["dc", "ac"] as const)("does not invent a source return path through a cut-off channel in %s", (mode) => {
    const document = floatingDrain("nmos");
    document.parts.push(
      part("supply", "ac-source", { voltageVolts: 1, offsetVolts: 5 }),
      part("load", "resistor", { resistanceOhms: 1000 }),
    );
    document.wires.push(
      wire("supply-load", "supply", "a", "load", "a"),
      wire("load-drain", "load", "b", "mos", "a"),
      wire("supply-ground", "supply", "b", "ground", "a"),
    );
    const analysis = analyzeCircuit(document, {}, { mode });
    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts.mos.channelConducting).toBe(false);
    expect(analysis.parts.load.currentAmps).toBeCloseTo(0, 12);
    // The supply and resistor still establish a voltage reference for the drain.
    expect(analysis.parts.meter.meterStatus).toBe("connected");
    expect(analysis.parts.meter.voltageVolts).toBeCloseTo(mode === "dc" ? 5 : 1, 10);
  });
});
