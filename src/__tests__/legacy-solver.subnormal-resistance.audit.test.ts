import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPartKind } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";

function part(id: string, kind: CircuitPartKind, values: Record<string, unknown> = {}) {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, to: string) {
  const [fromPart, fromTerminal] = from.split(":");
  const [toPart, toTerminal] = to.split(":");
  return {
    id,
    from: { partId: fromPart ?? "", terminal: fromTerminal as "a" | "b" },
    to: { partId: toPart ?? "", terminal: toTerminal as "a" | "b" },
  };
}

describe("legacy solver subnormal resistance audit", () => {
  it.each([Number.MIN_VALUE, 1e-320])(
    "keeps finite readings when an ultra-small load resistance of %s Ω is in series with modeled wires",
    (resistanceOhms) => {
      const document: CircuitDocument = {
        title: "極小抵抗の直列回路",
        parts: [
          part("source", "battery", { voltageVolts: 9 }),
          part("load", "resistor", { resistanceOhms }),
        ],
        wires: [wire("positive", "source:a", "load:a"), wire("return", "load:b", "source:b")],
      };

      const result = analyzeCircuit(document);

      expect(result.status, result.message).toBe("short");
      expect(result.currentAmps).toBeNull();
      expect(result.parts.load.currentAmps / 3_000_000).toBeCloseTo(1, 5);
      expect(result.parts.load.voltageVolts / resistanceOhms / 3_000_000).toBeCloseTo(1, 5);
      expect(Object.values(result.parts).every((reading) => [
        reading.voltageVolts,
        reading.currentAmps,
        reading.powerWatts,
        ...Object.values(reading.terminalVoltages ?? {}),
        ...Object.values(reading.terminalCurrents ?? {}),
      ].every(Number.isFinite))).toBe(true);
    },
  );

  it.each([
    { fastResistance: Number.MIN_VALUE, slowResistance: 2 * Number.MIN_VALUE },
    { fastResistance: 1e-320, slowResistance: 2e-320 },
  ])("preserves relative current sharing between subnormal parallel loads", ({ fastResistance, slowResistance }) => {
    const document: CircuitDocument = {
      title: "極小抵抗の並列回路",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("top", "junction"),
        part("bottom", "junction"),
        part("fast", "resistor", { resistanceOhms: fastResistance }),
        part("slow", "resistor", { resistanceOhms: slowResistance }),
      ],
      wires: [
        wire("source-top", "source:a", "top:a"),
        wire("top-fast", "top:a", "fast:a"),
        wire("top-slow", "top:a", "slow:a"),
        wire("fast-bottom", "fast:b", "bottom:a"),
        wire("slow-bottom", "slow:b", "bottom:a"),
        wire("bottom-source", "bottom:a", "source:b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status, result.message).toBe("short");
    expect(result.currentAmps).toBeNull();
    expect(result.parts.fast.currentAmps / result.parts.slow.currentAmps).toBeCloseTo(1, 5);
    expect((result.parts.fast.currentAmps + result.parts.slow.currentAmps) / 2_250_000)
      .toBeCloseTo(1, 5);
    expect(result.parts.slow.voltageVolts / result.parts.fast.voltageVolts)
      .toBeCloseTo(slowResistance / fastResistance, 4);
  });

  it("keeps a disconnected ordinary legacy circuit unchanged when another circuit needs row scaling", () => {
    const ordinaryParts = [
      part("normal-source", "battery", { voltageVolts: 12 }),
      part("normal-load", "resistor", { resistanceOhms: 6 }),
    ];
    const ordinaryWires = [
      wire("normal-positive", "normal-source:a", "normal-load:a"),
      wire("normal-return", "normal-load:b", "normal-source:b"),
    ];
    const baseline = analyzeCircuit({ title: "通常回路", parts: ordinaryParts, wires: ordinaryWires });
    const combined = analyzeCircuit({
      title: "独立した通常回路と極小抵抗回路",
      parts: [
        ...ordinaryParts,
        part("tiny-source", "battery", { voltageVolts: 9 }),
        part("tiny-load", "resistor", { resistanceOhms: Number.MIN_VALUE }),
      ],
      wires: [
        ...ordinaryWires,
        wire("tiny-positive", "tiny-source:a", "tiny-load:a"),
        wire("tiny-return", "tiny-load:b", "tiny-source:b"),
      ],
    });

    expect(baseline.parts["normal-load"].currentAmps).toBeCloseTo(2, 5);
    expect(combined.parts["normal-load"].currentAmps)
      .toBeCloseTo(baseline.parts["normal-load"].currentAmps, 12);
    expect(combined.parts["normal-load"].voltageVolts)
      .toBeCloseTo(baseline.parts["normal-load"].voltageVolts, 12);
  });
});
