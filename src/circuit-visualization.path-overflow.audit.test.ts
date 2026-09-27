import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitTerminal } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { circuitNodes, circuitPotential } from "./circuit-visualization.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...extra,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({ id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } });

describe("AC potential path accumulation beyond binary64 intermediate range", () => {
  it("keeps a finite 12 V path difference after large source drops cancel", () => {
    const sourceVoltages = [1e308, 1e308, -1e308, -1e308, 12];
    const document: CircuitDocument = {
      title: "中間和がオーバーフローする交流電位経路",
      parts: [
        ...sourceVoltages.map((voltage, index) => part(`source-${index}`, "ac-source", {
          voltageVolts: Math.abs(voltage),
          phaseDegrees: voltage < 0 ? 180 : 0,
          frequencyHz: 50,
        })),
        part("ground", "ground"),
      ],
      wires: [
        wire("ground", "source-0", "b", "ground", "a"),
        wire("chain-0", "source-0", "b", "source-1", "a"),
        wire("chain-1", "source-1", "b", "source-2", "a"),
        wire("chain-2", "source-2", "b", "source-3", "a"),
        wire("chain-3", "source-3", "b", "source-4", "a"),
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const nodes = circuitNodes(document, analysis);
    const positive = nodes.find((node) => node.endpoints.some((endpoint) =>
      endpoint.partId === "source-0" && endpoint.terminal === "a"));
    const negative = nodes.find((node) => node.endpoints.some((endpoint) =>
      endpoint.partId === "source-4" && endpoint.terminal === "b"));

    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts["source-0"].voltageVolts).toBe(1e308);
    expect(analysis.parts["source-4"].voltageVolts).toBe(12);
    const displayed = circuitPotential(positive, negative, true, { document, analysis, nodes });

    expect(displayed?.volts).toBe(12);
    expect(displayed?.phaseDegrees).toBe(0);
  });
});
