import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitWire,
} from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";

function part(
  id: string,
  kind: CircuitPartKind,
  properties: Partial<CircuitPart> = {},
): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(
  id: string,
  fromPart: string,
  fromTerminal: "a" | "b",
  toPart: string,
  toTerminal: "a" | "b",
): CircuitWire {
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal },
    to: { partId: toPart, terminal: toTerminal },
  };
}

function asymmetricDivider(firstOhms: number, secondOhms: number): CircuitDocument {
  return {
    title: "非対称高抵抗分圧",
    parts: [
      part("source", "battery", { voltageVolts: 12 }),
      part("upper", "resistor", { resistanceOhms: firstOhms }),
      part("lower", "resistor", { resistanceOhms: secondOhms }),
    ],
    wires: [
      wire("source-upper", "source", "a", "upper", "a"),
      wire("upper-lower", "upper", "b", "lower", "a"),
      wire("lower-return", "lower", "b", "source", "b"),
    ],
  };
}

function balancedBridge(resistanceOhms: number): CircuitDocument {
  return {
    title: "高抵抗平衡ブリッジ",
    parts: [
      part("source", "battery", { voltageVolts: 12 }),
      part("top", "junction"),
      part("left", "junction"),
      part("right", "junction"),
      part("bottom", "junction"),
      part("left-upper", "resistor", { resistanceOhms }),
      part("left-lower", "resistor", { resistanceOhms }),
      part("right-upper", "resistor", { resistanceOhms }),
      part("right-lower", "resistor", { resistanceOhms }),
      part("bridge", "resistor", { resistanceOhms }),
    ],
    wires: [
      wire("source-top", "source", "a", "top", "a"),
      wire("top-left-upper", "top", "a", "left-upper", "a"),
      wire("top-right-upper", "top", "a", "right-upper", "a"),
      wire("left-upper-mid", "left-upper", "b", "left", "a"),
      wire("right-upper-mid", "right-upper", "b", "right", "a"),
      wire("left-mid-lower", "left", "a", "left-lower", "a"),
      wire("right-mid-lower", "right", "a", "right-lower", "a"),
      wire("left-bridge", "left", "a", "bridge", "a"),
      wire("bridge-right", "bridge", "b", "right", "a"),
      wire("left-lower-bottom", "left-lower", "b", "bottom", "a"),
      wire("right-lower-bottom", "right-lower", "b", "bottom", "a"),
      wire("bottom-source", "bottom", "a", "source", "b"),
    ],
  };
}

function asymmetricBridge(resistances: readonly [number, number, number, number, number]): CircuitDocument {
  const document = balancedBridge(1);
  const resistanceById: Record<string, number> = {
    "left-upper": resistances[0],
    "left-lower": resistances[1],
    "right-upper": resistances[2],
    "right-lower": resistances[3],
    bridge: resistances[4],
  };
  return {
    ...document,
    parts: document.parts.map((item) =>
      item.kind === "resistor" ? { ...item, resistanceOhms: resistanceById[item.id] } : item,
    ),
  };
}

function parallelSourcesWithLargeLoad(loadOhms: number): CircuitDocument {
  return {
    title: "並列電源と高抵抗負荷",
    parts: [
      part("source-a", "battery", { voltageVolts: 9 }),
      part("source-b", "battery", { voltageVolts: 9 }),
      part("load", "resistor", { resistanceOhms: loadOhms }),
      part("positive", "junction"),
      part("negative", "junction"),
    ],
    wires: [
      wire("source-a-positive", "source-a", "a", "positive", "a"),
      wire("source-b-positive", "source-b", "a", "positive", "a"),
      wire("positive-load", "positive", "a", "load", "a"),
      wire("source-a-negative", "source-a", "b", "negative", "a"),
      wire("source-b-negative", "source-b", "b", "negative", "a"),
      wire("load-negative", "load", "b", "negative", "a"),
    ],
  };
}

function relativeRatio(actual: number, expected: number) {
  return actual / expected;
}

describe("legacy DC solver physics", () => {
  it.each([1e6, 1e12, 1e20])("solves an asymmetric divider at %s ohms", (scale) => {
    const upperOhms = 2 * scale;
    const lowerOhms = 3 * scale;
    const result = analyzeCircuit(asymmetricDivider(upperOhms, lowerOhms));
    const expectedCurrent = 12 / (upperOhms + lowerOhms + 4e-6);
    const expectedLowerVoltage = expectedCurrent * lowerOhms;

    expect(result.status, result.message).toBe("closed");
    expect(relativeRatio(result.parts.upper.currentAmps, expectedCurrent)).toBeCloseTo(1, 9);
    expect(relativeRatio(result.parts.lower.currentAmps, expectedCurrent)).toBeCloseTo(1, 9);
    expect(relativeRatio(result.parts.upper.voltageVolts, expectedCurrent * upperOhms)).toBeCloseTo(1, 9);
    expect(relativeRatio(result.parts.lower.voltageVolts, expectedLowerVoltage)).toBeCloseTo(1, 9);
    expect(relativeRatio(result.parts.source.currentAmps, -expectedCurrent)).toBeCloseTo(1, 9);
    for (const current of Object.values(result.wireCurrents)) {
      expect(relativeRatio(current, expectedCurrent)).toBeCloseTo(1, 9);
    }
  });

  it("keeps a balanced high-resistance bridge at equal midpoint potentials", () => {
    const resistanceOhms = 1e16;
    const result = analyzeCircuit(balancedBridge(resistanceOhms));
    const expectedBranchCurrent = 12 / (2 * resistanceOhms + 7e-6);

    expect(result.status, result.message).toBe("closed");
    expect(relativeRatio(Math.abs(result.parts["left-upper"].currentAmps), expectedBranchCurrent))
      .toBeCloseTo(1, 9);
    expect(relativeRatio(Math.abs(result.parts["right-upper"].currentAmps), expectedBranchCurrent))
      .toBeCloseTo(1, 9);
    expect(relativeRatio(Math.abs(result.parts["left-lower"].currentAmps), expectedBranchCurrent))
      .toBeCloseTo(1, 9);
    expect(relativeRatio(Math.abs(result.parts["right-lower"].currentAmps), expectedBranchCurrent))
      .toBeCloseTo(1, 9);
    expect(result.parts.bridge.currentAmps).toBeCloseTo(0, 12);
  });

  it("resolves a small difference between large opposing battery voltages", () => {
    const strongerVoltage = 1e16;
    const weakerVoltage = strongerVoltage - 2;
    const document: CircuitDocument = {
      title: "大きな電圧の差分",
      parts: [
        part("strong", "battery", { voltageVolts: strongerVoltage }),
        part("weak", "battery", { voltageVolts: weakerVoltage }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "strong", "b", "weak", "b"),
        wire("w2", "weak", "a", "load", "a"),
        wire("w3", "load", "b", "strong", "a"),
      ],
    };

    const result = analyzeCircuit(document);
    const expectedCurrent = 2 / (10 + 5e-6);

    expect(result.status, result.message).toBe("closed");
    expect(Math.abs(result.parts.load.voltageVolts)).toBeCloseTo(expectedCurrent * 10, 8);
    expect(Math.abs(result.parts.load.currentAmps / expectedCurrent)).toBeCloseTo(1, 8);
    expect(Math.abs(result.parts.strong.currentAmps / expectedCurrent)).toBeCloseTo(1, 8);
    expect(Math.abs(result.parts.weak.currentAmps / expectedCurrent)).toBeCloseTo(1, 8);
    expect(result.parts.strong.currentAmps).toBeLessThan(0);
    expect(result.parts.weak.currentAmps).toBeGreaterThan(0);
    expect(Object.values(result.wireCurrents).every(Number.isFinite)).toBe(true);
  });

  it("does not erase a compensated nonzero source difference in short detection", () => {
    const strongerVoltage = 1e16;
    const weakerVoltage = strongerVoltage - 2;
    const document: CircuitDocument = {
      title: "大きな電圧の差分と短絡負荷",
      parts: [
        part("strong", "battery", { voltageVolts: strongerVoltage }),
        part("weak", "battery", { voltageVolts: weakerVoltage }),
        part("load", "resistor", { resistanceOhms: 0.000_75 }),
      ],
      wires: [
        wire("w1", "strong", "b", "weak", "b"),
        wire("w2", "weak", "a", "load", "a"),
        wire("w3", "load", "b", "strong", "a"),
      ],
    };

    expect(analyzeCircuit(document).status).toBe("short");
  });

  it("keeps finite readings for a large voltage and resistance with finite power", () => {
    const document: CircuitDocument = {
      title: "大きな有限値",
      parts: [
        part("source", "battery", { voltageVolts: 1e200 }),
        part("load", "resistor", { resistanceOhms: 1e100 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.load.currentAmps / 1e100).toBeCloseTo(1, 12);
    expect(result.parts.source.currentAmps / -1e100).toBeCloseTo(1, 12);
    expect(result.parts.load.powerWatts / 1e300).toBeCloseTo(1, 12);
    expect(result.parts.source.powerWatts / 1e300).toBeCloseTo(1, 12);
    expect(Object.values(result.wireCurrents).every(Number.isFinite)).toBe(true);
  });

  it("resolves tiny currents from equal parallel sources into a 1e20-ohm load", () => {
    const result = analyzeCircuit(parallelSourcesWithLargeLoad(1e20));
    const expectedLoadCurrent = 9 / 1e20;

    expect(result.status, result.message).toBe("closed");
    expect(result.currentAmps).toBeNull();
    expect(relativeRatio(result.parts.load.currentAmps, expectedLoadCurrent)).toBeCloseTo(1, 7);
    expect(relativeRatio(result.parts["source-a"].currentAmps, -expectedLoadCurrent / 2)).toBeCloseTo(1, 7);
    expect(relativeRatio(result.parts["source-b"].currentAmps, -expectedLoadCurrent / 2)).toBeCloseTo(1, 7);
    for (const wireId of ["source-a-positive", "source-a-negative", "source-b-positive", "source-b-negative"]) {
      expect(relativeRatio(Math.abs(result.wireCurrents[wireId] ?? Number.NaN), expectedLoadCurrent / 2))
        .toBeCloseTo(1, 7);
    }
    for (const wireId of ["positive-load", "load-negative"]) {
      expect(relativeRatio(result.wireCurrents[wireId] ?? Number.NaN, expectedLoadCurrent)).toBeCloseTo(1, 7);
    }
  });

  it("keeps readings invariant when parts and wires are reordered", () => {
    const original = asymmetricDivider(2e16, 3e16);
    const reordered: CircuitDocument = {
      ...original,
      parts: [...original.parts].reverse(),
      wires: [...original.wires].reverse(),
    };
    const first = analyzeCircuit(original);
    const second = analyzeCircuit(reordered);

    expect(first.status).toBe("closed");
    expect(second.status).toBe("closed");
    for (const partId of ["source", "upper", "lower"]) {
      expect(relativeRatio(second.parts[partId]!.currentAmps, first.parts[partId]!.currentAmps))
        .toBeCloseTo(1, 9);
      expect(relativeRatio(second.parts[partId]!.voltageVolts, first.parts[partId]!.voltageVolts))
        .toBeCloseTo(1, 9);
    }
    for (const wireId of ["source-upper", "upper-lower", "lower-return"]) {
      expect(relativeRatio(second.wireCurrents[wireId]!, first.wireCurrents[wireId]!)).toBeCloseTo(1, 9);
    }
  });

  it("solves a fully connected circuit at the 512-terminal limit", () => {
    const resistors = Array.from({ length: 255 }, (_, index) =>
      part(`r${index}`, "resistor", { resistanceOhms: 1 }),
    );
    const wires = [wire("source-first", "source", "a", "r0", "a")];
    for (let index = 0; index < resistors.length - 1; index += 1) {
      wires.push(wire(`series-${index}`, `r${index}`, "b", `r${index + 1}`, "a"));
    }
    wires.push(wire("last-return", "r254", "b", "source", "b"));
    const document: CircuitDocument = {
      title: "上限端子数の直列回路",
      parts: [part("source", "battery", { voltageVolts: 1 }), ...resistors],
      wires,
    };

    const result = analyzeCircuit(document);
    const expectedCurrent = 1 / (255 + 257e-6);

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.r0.currentAmps).toBeCloseTo(expectedCurrent, 10);
    expect(result.parts.r254.currentAmps).toBeCloseTo(expectedCurrent, 10);
    expect(Object.values(result.wireCurrents).every(Number.isFinite)).toBe(true);
  });

  it("keeps terminal KCL below 1e-9 for 100 deterministic asymmetric bridges", () => {
    let seed = 20_260_926;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    let maximumRelativeResidual = 0;

    for (let caseIndex = 0; caseIndex < 100; caseIndex += 1) {
      const resistances = Array.from({ length: 5 }, () => 10 ** (18 * random() - 2)) as [
        number,
        number,
        number,
        number,
        number,
      ];
      const document = asymmetricBridge(resistances);
      const result = analyzeCircuit(document);
      expect(result.status, `bridge ${caseIndex}: ${result.message}`).toBe("closed");

      const residuals = new Map<string, { current: number; scale: number }>();
      const add = (partId: string, terminal: string, value: number) => {
        const key = `${partId}:${terminal}`;
        const previous = residuals.get(key) ?? { current: 0, scale: 0 };
        residuals.set(key, { current: previous.current + value, scale: previous.scale + Math.abs(value) });
      };
      for (const item of document.parts) {
        const reading = result.parts[item.id];
        for (const terminal of circuitPartCatalog[item.kind].terminals) {
          add(item.id, terminal, reading?.terminalCurrents?.[terminal] ?? 0);
        }
      }
      for (const connection of document.wires) {
        const current = result.wireCurrents[connection.id] ?? Number.NaN;
        add(connection.from.partId, connection.from.terminal, current);
        add(connection.to.partId, connection.to.terminal, -current);
      }
      for (const { current, scale } of residuals.values()) {
        const relativeResidual = Math.abs(current) / (scale || 1);
        maximumRelativeResidual = Math.max(maximumRelativeResidual, relativeResidual);
      }
    }

    expect(maximumRelativeResidual).toBeLessThan(1e-9);
  });
});
