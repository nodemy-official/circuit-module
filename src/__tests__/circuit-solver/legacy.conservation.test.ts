import { describe, expect, it } from "vitest";

import {
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitWire,
} from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";

// Independent physical oracles: scalar series/parallel reductions and KCL/KVL.
// No solver arithmetic helper or extended solver supplies expected values.
const wireOhms = 1e-6;

function part(
  id: string,
  kind: CircuitPartKind,
  values: Partial<CircuitPart> = {},
): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, to: string): CircuitWire {
  const [fromPart, fromTerminal] = from.split(":");
  const [toPart, toTerminal] = to.split(":");
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal as "a" | "b" },
    to: { partId: toPart, terminal: toTerminal as "a" | "b" },
  };
}

function relativeRatio(actual: number, expected: number) {
  return actual / expected;
}

function maximumRelativeKclResidual(document: CircuitDocument, analysis: CircuitAnalysis) {
  const balances = new Map<string, { residual: number; scale: number }>();
  function add(key: string, current: number) {
    const previous = balances.get(key) ?? { residual: 0, scale: 0 };
    previous.residual += current;
    previous.scale += Math.abs(current);
    balances.set(key, previous);
  }
  for (const item of document.parts) {
    for (const terminal of terminalsOf(item.kind)) {
      add(`${item.id}:${terminal}`, analysis.parts[item.id].terminalCurrents?.[terminal] ?? 0);
    }
  }
  for (const connection of document.wires) {
    const current = analysis.wireCurrents[connection.id];
    add(`${connection.from.partId}:${connection.from.terminal}`, current);
    add(`${connection.to.partId}:${connection.to.terminal}`, -current);
  }
  return Math.max(0, ...[...balances.values()].map(({ residual, scale }) =>
    scale === 0 ? Math.abs(residual) : Math.abs(residual) / scale));
}

function wireLoss(analysis: CircuitAnalysis) {
  return Object.values(analysis.wireCurrents)
    .reduce((sum, current) => sum + current ** 2 * wireOhms, 0);
}

function reversedOrder(document: CircuitDocument): CircuitDocument {
  return {
    ...document,
    parts: [...document.parts].reverse(),
    wires: [...document.wires].reverse(),
  };
}

function reversedWires(document: CircuitDocument): CircuitDocument {
  return {
    ...document,
    wires: document.wires.map((connection) => ({
      ...connection,
      from: connection.to,
      to: connection.from,
    })),
  };
}

function sevenKindsDocument(voltage = 12, resistanceScale = 1): CircuitDocument {
  return {
    title: "従来7種類・逆向き計器の直列回路",
    parts: [
      part("source", "battery", { voltageVolts: voltage, internalResistanceOhms: 0.2 }),
      part("switch", "switch", { initiallyClosed: true }),
      part("ammeter", "ammeter"),
      part("resistor", "resistor", { resistanceOhms: 2 * resistanceScale }),
      part("bulb", "bulb", { resistanceOhms: 3 * resistanceScale, ratedPowerWatts: 100 }),
      part("junction", "junction"),
      part("voltmeter", "voltmeter"),
    ],
    wires: [
      wire("w1", "source:a", "switch:b"),
      wire("w2", "switch:a", "ammeter:b"),
      wire("w3", "ammeter:a", "resistor:b"),
      wire("w4", "resistor:a", "bulb:a"),
      wire("w5", "bulb:b", "junction:a"),
      wire("w6", "junction:a", "source:b"),
      wire("v1", "voltmeter:a", "resistor:a"),
      wire("v2", "voltmeter:b", "resistor:b"),
    ],
  };
}

function partialSourceParallelLoad(dangling: boolean): CircuitDocument {
  const document: CircuitDocument = {
    title: "並列負荷と片端開放電池",
    parts: [
      part("source", "battery", { voltageVolts: 9, internalResistanceOhms: 0.1 }),
      part("r1", "resistor", { resistanceOhms: 0.0015 }),
      part("r2", "resistor", { resistanceOhms: 0.0015 }),
    ],
    wires: [
      wire("w1", "source:a", "r1:a"),
      wire("w2", "r1:b", "source:b"),
      wire("w3", "source:a", "r2:a"),
      wire("w4", "r2:b", "source:b"),
    ],
  };
  if (dangling) {
    document.parts.push(part("dangling", "battery", { voltageVolts: 9, internalResistanceOhms: 0.1 }));
    document.wires.push(wire("w5", "source:b", "dangling:a"));
  }
  return document;
}

function cancellationDocument(bleed: boolean): CircuitDocument {
  const document: CircuitDocument = {
    title: "端子電圧相殺を生む抵抗分割された電池網",
    parts: [
      part("s1", "battery", { voltageVolts: 1, internalResistanceOhms: 1 }),
      part("s2", "battery", { voltageVolts: 2, internalResistanceOhms: 1 }),
      part("r1", "resistor", { resistanceOhms: 0.5 }),
      part("r2", "resistor", { resistanceOhms: 0.5 }),
    ],
    wires: [
      wire("w1", "s1:b", "r1:a"),
      wire("w2", "r1:b", "s2:a"),
      wire("w3", "s2:b", "r2:a"),
      wire("w4", "r2:b", "s1:a"),
    ],
  };
  if (bleed) {
    document.parts.push(part("bleed", "resistor", { resistanceOhms: 1000 }));
    document.wires.push(wire("w5", "s1:a", "bleed:a"), wire("w6", "s1:b", "bleed:b"));
  }
  return document;
}

describe("legacy DC conservation and topology invariants", () => {
  it.each([1, 1e6, 1e16])("checks all seven kinds, SI units, reverse polarity and KVL at scale %s", (scale) => {
    const document = sevenKindsDocument(12, scale);
    const expectedCurrent = 12 / (5 * scale + 0.2 + 8 * wireOhms);
    for (const variant of [document, reversedOrder(document)]) {
      const analysis = analyzeCircuit(variant, {}, { mode: "dc" });
      expect(analysis.status, analysis.message).toBe("closed");
      expect(relativeRatio(analysis.currentAmps ?? Number.NaN, expectedCurrent)).toBeCloseTo(1, 12);
      for (const id of ["switch", "ammeter", "resistor"]) {
        expect(relativeRatio(analysis.parts[id].currentAmps, -expectedCurrent)).toBeCloseTo(1, 12);
      }
      for (const id of ["switch", "ammeter"]) {
        expect(relativeRatio(analysis.parts[id].powerWatts, expectedCurrent ** 2 * wireOhms)).toBeCloseTo(1, 12);
      }
      expect(relativeRatio(analysis.parts.bulb.currentAmps, expectedCurrent)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.source.currentAmps, -expectedCurrent)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.resistor.voltageVolts, -2 * scale * expectedCurrent)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.voltmeter.voltageVolts, -2 * scale * expectedCurrent)).toBeCloseTo(1, 12);
      expect(analysis.parts.voltmeter.currentAmps).toBe(0);
      expect(analysis.parts.voltmeter.meterStatus).toBe("connected");
      expect(analysis.parts.ammeter.meterStatus).toBe("connected");
      expect(relativeRatio(analysis.parts.bulb.powerWatts, 3 * scale * expectedCurrent ** 2)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.bulb.brightness ?? Number.NaN, Math.min(1, 3 * scale * expectedCurrent ** 2 / 100))).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.bulbPowerWatts.bulb, analysis.parts.bulb.powerWatts)).toBeCloseTo(1, 12);
      const passiveVoltage = analysis.parts.bulb.voltageVolts
        - analysis.parts.resistor.voltageVolts - analysis.parts.switch.voltageVolts
        - analysis.parts.ammeter.voltageVolts;
      const wiresVoltage = Object.values(analysis.wireCurrents).reduce((sum, current) => sum + current * wireOhms, 0);
      expect(relativeRatio(passiveVoltage + wiresVoltage + 0.2 * expectedCurrent, 12)).toBeCloseTo(1, 12);
      expect(maximumRelativeKclResidual(variant, analysis)).toBeLessThan(2e-14);
    }
    const reversed = analyzeCircuit(reversedWires(document));
    for (const id of ["w1", "w2", "w3", "w4", "w5", "w6"]) {
      expect(relativeRatio(reversed.wireCurrents[id], -expectedCurrent)).toBeCloseTo(1, 12);
    }
  });

  it("checks exact zero current and full voltage at an overridden open switch", () => {
    const document = sevenKindsDocument();
    const analysis = analyzeCircuit(document, { switch: false });
    expect(analysis.status).toBe("open");
    expect(analysis.currentAmps).toBe(0);
    expect(analysis.parts.switch.switchClosed).toBe(false);
    expect(analysis.parts.switch.voltageVolts).toBe(-12);
    for (const reading of Object.values(analysis.parts)) {
      expect(reading.currentAmps).toBe(0);
      expect(reading.powerWatts).toBe(0);
    }
    expect(analysis.parts.voltmeter.voltageVolts).toBe(0);
    expect(analysis.parts.voltmeter.meterStatus).toBe("connected");
    expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
  });

  it.each([0, 5e-7, 1e-6, 0.1])("checks the documented battery resistance floor (%s ohms)", (internalResistanceOhms) => {
    const document: CircuitDocument = {
      title: "内部抵抗近似のモデル境界",
      parts: [
        part("s", "battery", { voltageVolts: 9, internalResistanceOhms }),
        part("r", "resistor", { resistanceOhms: 2e-6 }),
      ],
      wires: [wire("w1", "s:a", "r:a"), wire("w2", "r:b", "s:b")],
    };
    const current = 9 / (Math.max(internalResistanceOhms, wireOhms) + 4e-6);
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("short");
    expect(relativeRatio(analysis.parts.r.currentAmps, current)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.r.powerWatts, current ** 2 * 2e-6)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.s.powerWatts, analysis.parts.r.powerWatts + wireLoss(analysis))).toBeCloseTo(1, 12);
    expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
  });

  it("checks KCL and power when a stronger battery charges a weaker battery", () => {
    const document: CircuitDocument = {
      title: "抵抗を挟んだ異なる電池の並列接続",
      parts: [
        part("strong", "battery", { voltageVolts: 12, internalResistanceOhms: 1 }),
        part("weak", "battery", { voltageVolts: 6, internalResistanceOhms: 2 }),
        part("r", "resistor", { resistanceOhms: 3 }),
      ],
      wires: [wire("w1", "strong:a", "r:a"), wire("w2", "r:b", "weak:a"), wire("w3", "weak:b", "strong:b")],
    };
    const current = 6 / (6 + 3e-6);
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("closed");
    expect(relativeRatio(analysis.parts.strong.currentAmps, -current)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.weak.currentAmps, current)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.strong.voltageVolts, 12 - current)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.weak.voltageVolts, 6 + 2 * current)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.weak.powerWatts, -(6 + 2 * current) * current)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.strong.powerWatts + analysis.parts.weak.powerWatts,
      analysis.parts.r.powerWatts + wireLoss(analysis))).toBeCloseTo(1, 12);
    expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
  });

  it("checks an external voltmeter-only return remains open and does not load the source", () => {
    const document: CircuitDocument = {
      title: "電圧計のみの帰還経路",
      parts: [part("s", "battery", { voltageVolts: 9 }), part("v", "voltmeter")],
      wires: [wire("w1", "s:a", "v:b"), wire("w2", "v:a", "s:b")],
    };
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("open");
    expect(analysis.parts.v.voltageVolts).toBe(-9);
    expect(analysis.parts.v.meterStatus).toBe("connected");
    expect(analysis.parts.v.currentAmps).toBe(0);
    expect(analysis.parts.s.currentAmps).toBe(0);
    expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
  });

  it("proves the weak-bleed cancellation case satisfies KCL, KVL and power", () => {
    const document = cancellationDocument(true);
    const analysis = analyzeCircuit(document);
    const returnOhms = 2 + 4e-6;
    const bleedOhms = 1000 + 2e-6;
    // (V-1)/1 + (V+2)/returnOhms + V/bleedOhms = 0.
    // Avoid subtracting nearly equal floating-point numbers in this oracle.
    const voltage = 4e-6 * bleedOhms / (returnOhms * bleedOhms + bleedOhms + returnOhms);
    expect(relativeRatio(analysis.parts.s1.voltageVolts, voltage)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.s1.currentAmps, voltage - 1)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.s2.currentAmps, -(voltage + 2) / returnOhms)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.bleed.currentAmps, voltage / bleedOhms)).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.s1.voltageVolts + analysis.parts.s2.voltageVolts,
      -analysis.parts.r1.voltageVolts - analysis.parts.r2.voltageVolts
      - Object.entries(analysis.wireCurrents).filter(([id]) => id !== "w5" && id !== "w6")
        .reduce((sum, [, current]) => sum + current * wireOhms, 0))).toBeCloseTo(1, 12);
    expect(relativeRatio(analysis.parts.s1.powerWatts + analysis.parts.s2.powerWatts,
      analysis.parts.r1.powerWatts + analysis.parts.r2.powerWatts + analysis.parts.bleed.powerWatts + wireLoss(analysis))).toBeCloseTo(1, 12);
    expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
  });
});

describe("legacy DC source topology and conductor loss regressions", () => {
  // These assert the physical expectations independently of the implementation.
  it.each(["original", "reordered", "wire-reversed"])(
    "does not hide a parallel-load short when an open-ended battery is attached (%s)", (order) => {
      const baseline = analyzeCircuit(partialSourceParallelLoad(false));
      const original = partialSourceParallelLoad(true);
      const document = order === "reordered" ? reversedOrder(original)
        : order === "wire-reversed" ? reversedWires(original) : original;
      const analysis = analyzeCircuit(document);
      const externalOhms = (0.0015 + 2e-6) / 2;
      expect(externalOhms).toBeLessThan(0.001);
      expect(baseline.status).toBe("short");
      expect(analysis.parts.dangling.currentAmps).toBe(0);
      expect(relativeRatio(analysis.parts.source.currentAmps, -9 / (0.1 + externalOhms))).toBeCloseTo(1, 12);
      for (const id of ["source", "r1", "r2"]) {
        expect(analysis.parts[id].currentAmps).toBe(baseline.parts[id].currentAmps);
        expect(analysis.parts[id].voltageVolts).toBe(baseline.parts[id].voltageVolts);
        expect(analysis.parts[id].powerWatts).toBe(baseline.parts[id].powerWatts);
      }
      expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
      expect(analysis.status, analysis.message).toBe("short");
    },
  );

  it.each([[0.001_995, "short"], [0.001_997, "closed"]] as const)(
    "preserves the series-source load threshold with an open-ended high-voltage battery (%s ohms)", (resistanceOhms, status) => {
      const baselineDocument = partialSourceParallelLoad(false);
      baselineDocument.parts.push(part("second", "battery", { voltageVolts: 9, internalResistanceOhms: 0.1 }));
      for (const item of baselineDocument.parts) {
        if (item.kind === "resistor") { item.resistanceOhms = resistanceOhms; }
      }
      for (const connection of baselineDocument.wires) {
        if (connection.to.partId === "source" && connection.to.terminal === "b") {
          connection.to.partId = "second";
        }
      }
      baselineDocument.wires.push(wire("series", "source:b", "second:a"));
      const baseline = analyzeCircuit(baselineDocument);
      // The parallel load and the wire between cells are all external:
      // Rexternal=(R+2uOhm)/2+1uOhm; internal cell resistances are omitted.
      const externalOhms = (resistanceOhms + 2 * wireOhms) / 2 + wireOhms;
      expect(externalOhms < 0.001).toBe(status === "short");
      expect(baseline.status).toBe(status);
      const document: CircuitDocument = {
        ...baselineDocument,
        parts: [...baselineDocument.parts, part("dangling", "battery", { voltageVolts: 1e6, internalResistanceOhms: 0.1 })],
        wires: [...baselineDocument.wires, wire("dangling-wire", "source:b", "dangling:a")],
      };
      for (const variant of [document, reversedOrder(document), reversedWires(document)]) {
        const analysis = analyzeCircuit(variant);
        expect(analysis.status, analysis.message).toBe(status);
        expect(analysis.parts.dangling.currentAmps).toBe(0);
        expect(relativeRatio(analysis.parts.source.currentAmps, -18 / (0.2 + externalOhms))).toBeCloseTo(1, 12);
        for (const id of ["source", "second", "r1", "r2"]) {
          expect(analysis.parts[id].currentAmps).toBe(baseline.parts[id].currentAmps);
          expect(analysis.parts[id].voltageVolts).toBe(baseline.parts[id].voltageVolts);
          expect(analysis.parts[id].powerWatts).toBe(baseline.parts[id].powerWatts);
        }
        expect(maximumRelativeKclResidual(variant, analysis)).toBeLessThan(2e-14);
      }
    },
  );

  it.each(["original", "reordered", "wire-reversed"])(
    "does not classify source-voltage cancellation behind one ohm as a short (%s)", (order) => {
      const baseline = analyzeCircuit(cancellationDocument(false));
      expect(baseline.status).toBe("closed");
      const original = cancellationDocument(true);
      const document = order === "reordered" ? reversedOrder(original)
        : order === "wire-reversed" ? reversedWires(original) : original;
      const analysis = analyzeCircuit(document);
      // With battery internal resistances omitted, the return resistance is
      // (1+4uOhm) || (1000+2uOhm), almost 1 ohm, far above 1 milliohm.
      const externalOhms = 1 / (1 / (1 + 4e-6) + 1 / (1000 + 2e-6));
      expect(externalOhms).toBeGreaterThan(0.99);
      expect(analysis.parts.s1.voltageVolts).toBeGreaterThan(0);
      expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
      expect(analysis.status, analysis.message).toBe("closed");
    },
  );

  it.each(["ammeter", "switch"] as const)(
    "reports the modeled Joule loss of a closed %s", (kind) => {
      const document: CircuitDocument = {
        title: "1マイクロオーム計器・導通部品の電力保存",
        parts: [
          part("s", "battery", { voltageVolts: 6, internalResistanceOhms: 1e-6 }),
          part("device", kind, { initiallyClosed: true }),
          part("r", "resistor", { resistanceOhms: 0.001 }),
        ],
        wires: [wire("w1", "s:a", "device:a"), wire("w2", "device:b", "r:a"), wire("w3", "r:b", "s:b")],
      };
      const analysis = analyzeCircuit(document);
      const current = 6 / 0.001_005;
      expect(analysis.status).toBe("closed");
      expect(relativeRatio(analysis.parts.device.currentAmps, current)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.device.voltageVolts, current * wireOhms)).toBeCloseTo(1, 12);
      expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
      expect(relativeRatio(analysis.parts.s.powerWatts,
        analysis.parts.r.powerWatts + current ** 2 * wireOhms + wireLoss(analysis))).toBeCloseTo(1, 12);
      // The omitted loss is about 35.64 W, despite a non-shorted network.
      expect(relativeRatio(analysis.parts.device.powerWatts, current ** 2 * wireOhms)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.s.powerWatts,
        analysis.parts.r.powerWatts + analysis.parts.device.powerWatts + wireLoss(analysis))).toBeCloseTo(1, 12);
    },
  );

  it.each(["ammeter", "switch"] as const)(
    "keeps %s Joule loss finite when a displayed current squared would overflow", (kind) => {
      const document: CircuitDocument = {
        title: "厳密な積を保持する導通部品の電力",
        parts: [
          part("s", "battery", { voltageVolts: 1e150, internalResistanceOhms: wireOhms }),
          part("device", kind, { initiallyClosed: true }),
          part("r", "resistor", { resistanceOhms: wireOhms }),
        ],
        wires: [wire("w1", "s:a", "device:b"), wire("w2", "device:a", "r:a"), wire("w3", "r:b", "s:b")],
      };
      const current = 1e150 / (6 * wireOhms);
      const loss = current * (current * wireOhms);
      expect(current ** 2).toBe(Number.POSITIVE_INFINITY);
      const analysis = analyzeCircuit(document);
      expect(analysis.status, analysis.message).toBe("short");
      expect(relativeRatio(analysis.parts.device.currentAmps, -current)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.device.powerWatts, loss)).toBeCloseTo(1, 12);
      expect(relativeRatio(analysis.parts.s.powerWatts, 5 * loss)).toBeCloseTo(1, 12);
      expect(maximumRelativeKclResidual(document, analysis)).toBeLessThan(2e-14);
    },
  );
});
