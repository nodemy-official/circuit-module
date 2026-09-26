import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  createExampleCircuit,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
} from "./circuit-model.js";
import { analyzeCircuit, MAX_CIRCUIT_ANALYSIS_TERMINALS } from "./circuit-solver.js";

const part = (
  id: string,
  kind: CircuitPartKind,
  extra: Partial<CircuitPart> = {},
): CircuitPart => ({ id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...extra });

const wire = (
  id: string,
  from: string,
  fromTerminal: "a" | "b",
  to: string,
  toTerminal: "a" | "b",
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

/** A battery feeding two resistors in parallel through junctions, with meters. */
function parallel(first: number, second: number): CircuitDocument {
  return {
    title: "並列",
    parts: [
      part("battery", "battery", { voltageVolts: 12 }),
      part("ammeter", "ammeter"),
      part("r1", "resistor", { resistanceOhms: first }),
      part("r2", "bulb", { resistanceOhms: second, ratedPowerWatts: 10 }),
      part("voltmeter", "voltmeter"),
      part("top", "junction"),
      part("bottom", "junction"),
    ],
    wires: [
      wire("w1", "battery", "a", "ammeter", "a"),
      wire("w2", "ammeter", "b", "top", "a"),
      wire("w3", "top", "a", "r1", "a"),
      wire("w4", "top", "a", "r2", "a"),
      wire("w5", "r1", "b", "bottom", "a"),
      wire("w6", "r2", "b", "bottom", "a"),
      wire("w7", "bottom", "a", "battery", "b"),
      wire("w8", "voltmeter", "a", "top", "a"),
      wire("w9", "voltmeter", "b", "bottom", "a"),
    ],
  };
}

describe("analyzeCircuit", () => {
  it("splits current between parallel branches by conductance", () => {
    const result = analyzeCircuit(parallel(6, 12));
    // 6 Ω ∥ 12 Ω = 4 Ω, so 12 V drives 3 A: 2 A through 6 Ω and 1 A through 12 Ω.
    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeCloseTo(3);
    expect(Math.abs(result.parts.r1.currentAmps)).toBeCloseTo(2);
    expect(Math.abs(result.parts.r2.currentAmps)).toBeCloseTo(1);
    expect(result.bulbPowerWatts.r2).toBeCloseTo(12);
  });

  it("reads the ammeter in series and the voltmeter across the branch", () => {
    const result = analyzeCircuit(parallel(6, 12));
    expect(Math.abs(result.parts.ammeter.currentAmps)).toBeCloseTo(3);
    expect(result.parts.voltmeter.voltageVolts).toBeCloseTo(12);
    expect(result.parts.voltmeter.currentAmps).toBe(0);
    expect(result.parts.ammeter.meterStatus).toBe("connected");
    expect(result.parts.voltmeter.meterStatus).toBe("connected");
  });

  it("reads zero through an open switch and removes legacy solver residual from a parallel voltmeter", () => {
    const document: CircuitDocument = {
      title: "開いたスイッチ",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("ammeter", "ammeter"),
        part("switch", "switch", { initiallyClosed: false }),
        part("load", "resistor", { resistanceOhms: 10 }),
        part("loadMeter", "voltmeter"),
        part("switchMeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "battery", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "switch", "a"),
        wire("w3", "switch", "b", "load", "a"),
        wire("w4", "load", "b", "battery", "b"),
        wire("w5", "loadMeter", "a", "load", "a"),
        wire("w6", "loadMeter", "b", "load", "b"),
        wire("w7", "switchMeter", "a", "switch", "a"),
        wire("w8", "switchMeter", "b", "switch", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.parts.ammeter.currentAmps).toBe(0);
    expect(result.parts.ammeter.meterStatus).toBe("connected");
    expect(result.parts.loadMeter.voltageVolts).toBe(0);
    expect(result.parts.loadMeter.meterStatus).toBe("connected");
    expect(result.parts.switchMeter.voltageVolts).toBeCloseTo(9);
    expect(result.parts.switchMeter.meterStatus).toBe("connected");
    expect(Math.abs(result.parts.battery.voltageVolts)).toBeCloseTo(9);
  });

  it("keeps meter polarity signed and marks missing or floating probes", () => {
    const reverseCurrent: CircuitDocument = {
      title: "逆向き電流計",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("ammeter", "ammeter"),
        part("load", "resistor", { resistanceOhms: 9 }),
      ],
      wires: [
        wire("w1", "battery", "a", "ammeter", "b"),
        wire("w2", "ammeter", "a", "load", "a"),
        wire("w3", "load", "b", "battery", "b"),
      ],
    };
    const floatingProbe: CircuitDocument = {
      title: "別回路をまたぐ電圧計",
      parts: [
        part("source1", "battery", { voltageVolts: 9 }),
        part("load1", "resistor", { resistanceOhms: 9 }),
        part("source2", "battery", { voltageVolts: 3 }),
        part("load2", "resistor", { resistanceOhms: 3 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source1", "a", "load1", "a"),
        wire("w2", "load1", "b", "source1", "b"),
        wire("w3", "source2", "a", "load2", "a"),
        wire("w4", "load2", "b", "source2", "b"),
        wire("w5", "voltmeter", "a", "source1", "a"),
        wire("w6", "voltmeter", "b", "source2", "a"),
      ],
    };
    const unconnectedProbe: CircuitDocument = {
      title: "未接続電圧計",
      parts: [part("voltmeter", "voltmeter")],
      wires: [],
    };

    expect(analyzeCircuit(reverseCurrent).parts.ammeter.currentAmps).toBeCloseTo(-1);
    expect(analyzeCircuit(reverseCurrent).parts.ammeter.meterStatus).toBe("connected");
    expect(analyzeCircuit(floatingProbe).parts.voltmeter.meterStatus).toBe("floating");
    expect(analyzeCircuit(unconnectedProbe).parts.voltmeter.meterStatus).toBe("unconnected");
  });

  it("reports RMS meter values and phases in AC analysis", () => {
    const document: CircuitDocument = {
      title: "交流の計測器",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 100, phaseDegrees: 30 }),
        part("ammeter", "ammeter"),
        part("load", "resistor", { resistanceOhms: 10 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "load", "a"),
        wire("w3", "load", "b", "source", "b"),
        wire("w4", "voltmeter", "a", "load", "a"),
        wire("w5", "voltmeter", "b", "load", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status).toBe("closed");
    expect(result.mode).toBe("ac");
    expect(result.parts.ammeter.currentAmps).toBeCloseTo(0.5, 8);
    expect(result.parts.ammeter.currentPhaseDegrees).toBeCloseTo(30, 8);
    expect(result.parts.ammeter.meterStatus).toBe("connected");
    expect(result.parts.voltmeter.voltageVolts).toBeCloseTo(5, 8);
    expect(result.parts.voltmeter.voltagePhaseDegrees).toBeCloseTo(30, 8);
    expect(result.parts.voltmeter.currentAmps).toBe(0);
    expect(result.parts.voltmeter.meterStatus).toBe("connected");
  });

  it("reports current through each wire in its direction", () => {
    const result = analyzeCircuit(parallel(6, 12));
    // Conventional current leaves the + terminal through w1 and returns through w7.
    expect(result.wireCurrents.w1).toBeCloseTo(3);
    expect(result.wireCurrents.w3).toBeCloseTo(2);
    expect(result.wireCurrents.w7).toBeCloseTo(3);
    expect(result.wireCurrents.w8).toBeCloseTo(0);
  });

  it("adds batteries in series", () => {
    const document: CircuitDocument = {
      title: "直列の電池",
      parts: [
        part("b1", "battery"),
        part("b2", "battery"),
        part("r", "resistor", { resistanceOhms: 9 }),
      ],
      wires: [
        wire("w1", "b1", "b", "b2", "a"),
        wire("w2", "b2", "b", "r", "a"),
        wire("w3", "r", "b", "b1", "a"),
      ],
    };
    const result = analyzeCircuit(document);
    expect(result.status).toBe("closed");
    // Two batteries: no single supply current, but the resistor carries 18 V / 9 Ω.
    expect(result.currentAmps).toBeNull();
    expect(Math.abs(result.parts.r.currentAmps)).toBeCloseTo(2);
    expect(result.parts.b1.currentAmps).toBeLessThan(0);
    expect(result.parts.b2.currentAmps).toBeLessThan(0);
    expect(result.parts.r.powerWatts).toBeCloseTo(36, 3);
    expect(result.parts.b1.powerWatts + result.parts.b2.powerWatts)
      .toBeCloseTo(result.parts.r.powerWatts + Object.values(result.wireCurrents)
        .reduce((loss, current) => loss + current ** 2 * 1e-6, 0), 7);
  });

  it.each([
    { resistance: 0.000_75, status: "short" },
    { resistance: 0.000_997_5, status: "closed" },
    { resistance: 0.0015, status: "closed" },
  ])("classifies a $resistance-ohm load across series cells as $status", ({ resistance, status }) => {
    const document: CircuitDocument = {
      title: "直列電池と閾値以上の負荷",
      parts: [
        part("b1", "battery"),
        part("b2", "battery"),
        part("load", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("w1", "b1", "b", "b2", "a"),
        wire("w2", "b2", "b", "load", "a"),
        wire("w3", "load", "b", "b1", "a"),
      ],
    };

    expect(analyzeCircuit(document).status).toBe(status);
  });

  it.each([
    { resistance: 0.0003, status: "short" },
    { resistance: 0.000_75, status: "closed" },
  ])("uses total external resistance for $resistance-ohm series segments", ({ resistance, status }) => {
    const document: CircuitDocument = {
      title: "直列電池と分割された負荷抵抗",
      parts: [
        part("b1", "battery"),
        part("b2", "battery"),
        part("r1", "resistor", { resistanceOhms: resistance }),
        part("r2", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("w1", "b1", "b", "r1", "a"),
        wire("w2", "r1", "b", "b2", "a"),
        wire("w3", "b2", "b", "r2", "a"),
        wire("w4", "r2", "b", "b1", "a"),
      ],
    };

    expect(analyzeCircuit(document).status).toBe(status);
  });

  it("keeps a resistor-separated battery loop closed when a dangling source is attached", () => {
    const document: CircuitDocument = {
      title: "直列電池の抵抗ループと開放分岐",
      parts: [
        part("b1", "battery", { voltageVolts: 9 }),
        part("b2", "battery", { voltageVolts: 9 }),
        part("b3", "battery", { voltageVolts: 9 }),
        part("r1", "resistor", { resistanceOhms: 0.000_75 }),
        part("r2", "resistor", { resistanceOhms: 0.000_75 }),
      ],
      wires: [
        wire("w1", "b1", "b", "r1", "a"),
        wire("w2", "r1", "b", "b2", "a"),
        wire("w3", "b2", "b", "r2", "a"),
        wire("w4", "r2", "b", "b1", "a"),
        wire("w5", "b3", "a", "b1", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe("closed");
    expect(result.parts.b3.currentAmps).toBeCloseTo(0);
  });

  it.each([
    { firstLoopResistance: 0.000_75, secondLoopResistance: 0.000_75, status: "closed" },
    { firstLoopResistance: 0.0003, secondLoopResistance: 0.0003, status: "short" },
    { firstLoopResistance: 0.0003, secondLoopResistance: 0.000_75, status: "short" },
  ])(
    "classifies figure-eight battery loops ($firstLoopResistance Ω, $secondLoopResistance Ω) as $status",
    ({ firstLoopResistance, secondLoopResistance, status }) => {
      const document: CircuitDocument = {
        title: "単一接点を共有する電池ループ",
        parts: [
          part("b1", "battery", { voltageVolts: 9 }),
          part("b2", "battery", { voltageVolts: 9 }),
          part("b3", "battery", { voltageVolts: 9 }),
          part("b4", "battery", { voltageVolts: 9 }),
          part("r1", "resistor", { resistanceOhms: firstLoopResistance }),
          part("r2", "resistor", { resistanceOhms: firstLoopResistance }),
          part("r3", "resistor", { resistanceOhms: secondLoopResistance }),
          part("r4", "resistor", { resistanceOhms: secondLoopResistance }),
          part("shared", "junction"),
        ],
        wires: [
          wire("w1", "b1", "b", "shared", "a"),
          wire("w2", "shared", "a", "r1", "a"),
          wire("w3", "r1", "b", "b2", "a"),
          wire("w4", "b2", "b", "r2", "a"),
          wire("w5", "r2", "b", "b1", "a"),
          wire("w6", "b3", "b", "shared", "a"),
          wire("w7", "shared", "a", "r3", "a"),
          wire("w8", "r3", "b", "b4", "a"),
          wire("w9", "b4", "b", "r4", "a"),
          wire("w10", "r4", "b", "b3", "a"),
        ],
      };

      expect(analyzeCircuit(document).status).toBe(status);
    },
  );

  it("keeps a closed loop with opposing equal batteries at zero current", () => {
    const document: CircuitDocument = {
      title: "逆向きの電池",
      parts: [
        part("b1", "battery", { voltageVolts: 9 }),
        part("b2", "battery", { voltageVolts: 9 }),
        part("r", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "b1", "b", "b2", "b"),
        wire("w2", "b2", "a", "r", "a"),
        wire("w3", "r", "b", "b1", "a"),
      ],
    };

    const result = analyzeCircuit(document);
    // Kirchhoff's voltage law gives (9 V - 9 V) / 10 Ω = 0 A in this closed loop.
    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeNull();
    expect(Math.abs(result.parts.r.currentAmps)).toBeCloseTo(0);
  });

  it("drops the terminal voltage across a battery's internal resistance", () => {
    const document = createExampleCircuit();
    document.parts = document.parts.map((item) =>
      item.kind === "battery" ? { ...item, internalResistanceOhms: 15 } : item,
    );
    const result = analyzeCircuit(document);
    // 9 V over 10 + 20 + 15 Ω.
    expect(result.currentAmps).toBeCloseTo(0.2);
    expect(Math.abs(result.parts["part-1"].voltageVolts)).toBeCloseTo(6);
  });

  it("treats an ammeter across a battery as a short circuit", () => {
    const document: CircuitDocument = {
      title: "誤った電流計",
      parts: [part("battery", "battery"), part("ammeter", "ammeter")],
      wires: [
        wire("w1", "battery", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "battery", "b"),
      ],
    };
    const result = analyzeCircuit(document);
    expect(result.status).toBe("short");
    expect(result.issues[0]).toMatchObject({ severity: "error", partId: "battery" });
  });

  it("warns when a bulb runs far above its rating", () => {
    const document = createExampleCircuit();
    document.parts = document.parts.map((item) =>
      item.kind === "bulb" ? { ...item, ratedPowerWatts: 0.5 } : item,
    );
    const result = analyzeCircuit(document);
    expect(result.parts["part-3"].brightness).toBe(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "warning", partId: "part-3" }),
    );
  });

  it("notes parts that are left unconnected", () => {
    const document = createExampleCircuit();
    document.parts.push(part("loose", "resistor", { x: 30, y: 20 }));
    const result = analyzeCircuit(document);
    expect(result.status).toBe("closed");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "info", partId: "loose" }),
    );
  });

  it("waits for a battery before calculating", () => {
    const result = analyzeCircuit({ title: "", parts: [part("r", "resistor")], wires: [] });
    expect(result.status).toBe("idle");
    expect(result.currentAmps).toBeNull();
  });

  it("detects a short even when a very small source voltage drives less than 100 nA", () => {
    const result = analyzeCircuit({
      title: "微小電圧の短絡",
      parts: [part("source", "battery", { voltageVolts: 1e-16 })],
      wires: [wire("short", "source", "a", "source", "b")],
    });

    expect(result.status).toBe("short");
    expect(result.issues[0]).toMatchObject({ severity: "error", partId: "source" });
  });

  it("rejects invalid values and dangling wires", () => {
    expect(
      analyzeCircuit({
        title: "",
        parts: [part("r", "resistor", { resistanceOhms: 0 })],
        wires: [],
      }).status,
    ).toBe("invalid");
    expect(
      analyzeCircuit({
        title: "",
        parts: [part("r", "resistor")],
        wires: [wire("w", "r", "a", "missing", "a")],
      }).status,
    ).toBe("invalid");
  });

  it("rejects duplicate wire IDs so current readings cannot overwrite each other", () => {
    const result = analyzeCircuit({
      title: "重複した導線 ID",
      parts: [part("battery", "battery"), part("r", "resistor")],
      wires: [wire("same-id", "battery", "a", "r", "a"), wire("same-id", "r", "b", "battery", "b")],
    });

    expect(result.status).toBe("invalid");
    expect(result.issues[0]).toMatchObject({
      severity: "error",
      message: "導線 ID が重複しています。",
    });
  });

  it("rejects malformed switch states instead of interpreting strings as closed contacts", () => {
    const document = createExampleCircuit();
    const switchPart = document.parts.find((item) => item.kind === "switch")!;
    const malformed = { [switchPart.id]: "false" } as unknown as Record<string, boolean>;

    expect(analyzeCircuit(document, malformed).status).toBe("invalid");
    expect(analyzeCircuit(document, [] as unknown as Record<string, boolean>).status).toBe("invalid");
    expect(analyzeCircuit(document, { missing: true }).status).toBe("invalid");
    switchPart.initiallyClosed = "false" as unknown as boolean;
    expect(analyzeCircuit(document).status).toBe("invalid");
  });

  it("accepts exactly the public terminal limit and rejects one terminal over it", () => {
    const atLimit = analyzeCircuit({
      title: "解析上限",
      parts: Array.from({ length: MAX_CIRCUIT_ANALYSIS_TERMINALS }, (_, index) =>
        part(`junction-${index}`, "junction"),
      ),
      wires: [],
    });
    const overLimit = analyzeCircuit({
      title: "解析上限超過",
      parts: Array.from({ length: MAX_CIRCUIT_ANALYSIS_TERMINALS + 1 }, (_, index) =>
        part(`junction-${index}`, "junction"),
      ),
      wires: [],
    });

    expect(atLimit.status).toBe("idle");
    expect(overLimit.status).toBe("invalid");
    expect(overLimit.message).toContain(`${MAX_CIRCUIT_ANALYSIS_TERMINALS}端子`);
    expect(overLimit.issues).toEqual([{ severity: "error", message: overLimit.message }]);
  });

  it("analyzes a maximum-size parallel load without repeated dense resistance probes", () => {
    const batteries = Array.from({ length: 253 }, (_, index) =>
      part(`battery-${index}`, "battery", { voltageVolts: 9 }),
    );
    const parts = [
      ...batteries,
      part("load-a", "resistor", { resistanceOhms: 0.001_999 }),
      part("load-b", "resistor", { resistanceOhms: 0.001_999 }),
      part("positive", "junction"),
      part("negative", "junction"),
    ];
    const wires = batteries.flatMap((battery, index) => [
      wire(`positive-${index}`, battery.id, "a", "positive", "a"),
      wire(`negative-${index}`, battery.id, "b", "negative", "a"),
    ]);
    for (const load of ["load-a", "load-b"]) {
      wires.push(
        wire(`${load}-positive`, load, "a", "positive", "a"),
        wire(`${load}-negative`, load, "b", "negative", "a"),
      );
    }

    const result = analyzeCircuit({ title: "最大端子数の並列回路", parts, wires });

    expect(parts.reduce((count, item) => count + (item.kind === "junction" ? 1 : 2), 0))
      .toBe(MAX_CIRCUIT_ANALYSIS_TERMINALS);
    expect(result.status).toBe("closed");
  });

  it("stops an oversized dense resistor network before solving it", () => {
    const document: CircuitDocument = {
      title: "大規模な回路",
      parts: Array.from(
        { length: Math.floor(MAX_CIRCUIT_ANALYSIS_TERMINALS / 2) + 1 },
        (_, index) => part(`r-${index}`, "resistor"),
      ),
      wires: [],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe("invalid");
    expect(result.message).toBe(
      `端子数が解析上限の${MAX_CIRCUIT_ANALYSIS_TERMINALS}端子を超えています。` +
        "部品を減らすか、回路を分けて解析してください。",
    );
    expect(result.issues).toEqual([{ severity: "error", message: result.message }]);
    expect(result.parts).toEqual({});
  });

  it("solves a balanced bridge and preserves terminal and power readings", () => {
    const document: CircuitDocument = {
      title: "平衡ブリッジ",
      parts: [
        part("battery", "battery", { voltageVolts: 10 }),
        part("top", "junction"),
        part("left", "junction"),
        part("right", "junction"),
        part("bottom", "junction"),
        part("r1", "resistor", { resistanceOhms: 100 }),
        part("r2", "resistor", { resistanceOhms: 100 }),
        part("r3", "resistor", { resistanceOhms: 100 }),
        part("r4", "resistor", { resistanceOhms: 100 }),
        part("bridge", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "battery", "a", "top", "a"),
        wire("w2", "top", "a", "r1", "a"),
        wire("w3", "top", "a", "r3", "a"),
        wire("w4", "r1", "b", "left", "a"),
        wire("w5", "r3", "b", "right", "a"),
        wire("w6", "left", "a", "r2", "a"),
        wire("w7", "right", "a", "r4", "a"),
        wire("w8", "left", "a", "bridge", "a"),
        wire("w9", "bridge", "b", "right", "a"),
        wire("w10", "r2", "b", "bottom", "a"),
        wire("w11", "r4", "b", "bottom", "a"),
        wire("w12", "bottom", "a", "battery", "b"),
      ],
    };

    const result = analyzeCircuit(document);
    const branchCurrent = Math.abs(result.parts.r1.currentAmps);

    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeCloseTo(0.1, 5);
    expect(branchCurrent).toBeCloseTo(0.05, 5);
    expect(Math.abs(result.parts.r2.currentAmps)).toBeCloseTo(branchCurrent, 5);
    expect(Math.abs(result.parts.r3.currentAmps)).toBeCloseTo(branchCurrent, 5);
    expect(Math.abs(result.parts.r4.currentAmps)).toBeCloseTo(branchCurrent, 5);
    expect(result.parts.bridge.currentAmps).toBeCloseTo(0, 8);
    expect(result.parts.r1.voltageVolts).toBeCloseTo(5, 5);
    expect(result.parts.r1.terminalVoltages!.a! - result.parts.r1.terminalVoltages!.b!)
      .toBeCloseTo(result.parts.r1.voltageVolts, 8);
    expect(
      result.parts.r1.powerWatts + result.parts.r2.powerWatts +
        result.parts.r3.powerWatts + result.parts.r4.powerWatts,
    ).toBeCloseTo(result.parts.battery.powerWatts, 5);
  });

  it("keeps low currents and their terminal readings instead of rounding them to zero", () => {
    const document: CircuitDocument = {
      title: "微小電流",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("load", "resistor", { resistanceOhms: 100_000_000 }),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeCircuit(document);
    const expectedCurrent = 9 / 100_000_000;

    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts.load.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts.battery.currentAmps).toBeCloseTo(-expectedCurrent, 12);
    expect(result.wireCurrents.w1).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts.load.terminalCurrents?.a).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts.load.powerWatts).toBeCloseTo(expectedCurrent ** 2 * 100_000_000, 12);
  });

  it("preserves a low current measured by a series ammeter", () => {
    const document: CircuitDocument = {
      title: "微小電流の直列計測",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("ammeter", "ammeter"),
        part("load", "resistor", { resistanceOhms: 100_000_000 }),
      ],
      wires: [
        wire("w1", "battery", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "load", "a"),
        wire("w3", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe("closed");
    expect(result.parts.ammeter.currentAmps).toBeCloseTo(9 / 100_000_000, 12);
    expect(result.parts.ammeter.currentAmps).not.toBe(0);
  });

  it.each([1e6, 1e8, 1e10, 1e12, 1e20])("keeps equal series resistors balanced at %s ohms", (resistanceOhms) => {
    const document: CircuitDocument = {
      title: "高抵抗の分圧回路",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("r1", "resistor", { resistanceOhms }),
        part("r2", "resistor", { resistanceOhms }),
        part("meter", "ammeter"),
      ],
      wires: [
        wire("w1", "battery", "a", "r1", "a"),
        wire("w2", "r1", "b", "r2", "a"),
        wire("w3", "r2", "b", "meter", "a"),
        wire("w4", "meter", "b", "battery", "b"),
      ],
    };
    const result = analyzeCircuit(document);
    const expectedCurrent = 9 / (2 * resistanceOhms + 6e-6);

    expect(result.status).toBe("closed");
    for (const id of ["r1", "r2"]) {
      expect(result.parts[id].voltageVolts).toBeCloseTo(expectedCurrent * resistanceOhms, 8);
      expect(result.parts[id].currentAmps / expectedCurrent).toBeCloseTo(1, 10);
    }
    expect(result.parts.battery.currentAmps / expectedCurrent).toBeCloseTo(-1, 10);
    expect(result.parts.meter.currentAmps / expectedCurrent).toBeCloseTo(1, 10);
    for (const current of Object.values(result.wireCurrents)) {
      expect(current / expectedCurrent).toBeCloseTo(1, 10);
    }
  });

  it("preserves a low source voltage and the resulting small current", () => {
    const document: CircuitDocument = {
      title: "微小電圧",
      parts: [
        part("battery", "battery", { voltageVolts: 1e-8 }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.parts.load.voltageVolts).toBeCloseTo(1e-8, 14);
    expect(result.parts.load.currentAmps).toBeCloseTo(1e-9, 14);
    expect(result.parts.battery.voltageVolts).toBeCloseTo(1e-8, 14);
  });

  it("solves unequal parallel batteries and balances source and load power", () => {
    const document: CircuitDocument = {
      title: "異なる電池の並列",
      parts: [
        part("strong", "battery", { voltageVolts: 10, internalResistanceOhms: 1 }),
        part("weak", "battery", { voltageVolts: 5, internalResistanceOhms: 2 }),
        part("load", "resistor", { resistanceOhms: 4 }),
        part("positive", "junction"),
        part("negative", "junction"),
      ],
      wires: [
        wire("w1", "strong", "a", "positive", "a"),
        wire("w2", "weak", "a", "positive", "a"),
        wire("w3", "load", "a", "positive", "a"),
        wire("w4", "strong", "b", "negative", "a"),
        wire("w5", "weak", "b", "negative", "a"),
        wire("w6", "load", "b", "negative", "a"),
      ],
    };

    const result = analyzeCircuit(document);
    const loadCurrent = 50 / 28;

    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeNull();
    expect(result.parts.load.currentAmps).toBeCloseTo(loadCurrent, 5);
    expect(result.parts.strong.currentAmps).toBeCloseTo(-20 / 7, 5);
    expect(result.parts.weak.currentAmps).toBeCloseTo(15 / 14, 5);
    const wireLoss = Object.values(result.wireCurrents).reduce(
      (loss, current) => loss + current ** 2 * 1e-6,
      0,
    );
    expect(wireLoss).toBeCloseTo(25e-6, 9);
    expect(result.parts.strong.powerWatts + result.parts.weak.powerWatts)
      .toBeCloseTo(result.parts.load.powerWatts + wireLoss, 7);
  });

  it.each([
    { resistance: 0.000_75, status: "short" },
    { resistance: 0.000_999, status: "closed" },
    { resistance: 0.0015, status: "closed" },
    { resistance: 10, status: "closed" },
  ])("classifies a $resistance-ohm parallel-battery load as $status", ({ resistance, status }) => {
    const document: CircuitDocument = {
      title: "並列電池の低抵抗負荷",
      parts: [
        part("battery-a", "battery", { voltageVolts: 9 }),
        part("battery-b", "battery", { voltageVolts: 9 }),
        part("load", "resistor", { resistanceOhms: resistance }),
        part("positive", "junction"),
        part("negative", "junction"),
      ],
      wires: [
        wire("w1", "battery-a", "a", "positive", "a"),
        wire("w2", "battery-b", "a", "positive", "a"),
        wire("w3", "load", "a", "positive", "a"),
        wire("w4", "battery-a", "b", "negative", "a"),
        wire("w5", "battery-b", "b", "negative", "a"),
        wire("w6", "load", "b", "negative", "a"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe(status);
  });

  it("detects a short across a series source group's parallel load branches", () => {
    const document: CircuitDocument = {
      title: "直列電池と並列低抵抗負荷",
      parts: [
        part("battery-a", "battery", { voltageVolts: 9 }),
        part("battery-b", "battery", { voltageVolts: 9 }),
        part("load-a", "resistor", { resistanceOhms: 0.0015 }),
        part("load-b", "resistor", { resistanceOhms: 0.0015 }),
        part("positive", "junction"),
        part("middle", "junction"),
        part("negative", "junction"),
      ],
      wires: [
        wire("w1", "battery-a", "a", "positive", "a"),
        wire("w2", "battery-a", "b", "middle", "a"),
        wire("w3", "middle", "a", "battery-b", "a"),
        wire("w4", "battery-b", "b", "negative", "a"),
        wire("w5", "load-a", "a", "positive", "a"),
        wire("w6", "load-a", "b", "negative", "a"),
        wire("w7", "load-b", "a", "positive", "a"),
        wire("w8", "load-b", "b", "negative", "a"),
      ],
    };

    expect(analyzeCircuit(document).status).toBe("short");
  });

  it("treats inherited switch-state keys as absent and stores special IDs safely", () => {
    const openSwitch: CircuitDocument = {
      title: "継承キーのスイッチ状態",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("toString", "switch", { initiallyClosed: false }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "battery", "a", "toString", "a"),
        wire("w2", "toString", "b", "load", "a"),
        wire("w3", "load", "b", "battery", "b"),
      ],
    };
    const specialIds: CircuitDocument = {
      title: "特殊な辞書キー",
      parts: [
        part("__proto__", "battery", { voltageVolts: 6 }),
        part("load", "resistor", { resistanceOhms: 6 }),
      ],
      wires: [
        wire("__proto__", "__proto__", "a", "load", "a"),
        wire("constructor", "load", "b", "__proto__", "b"),
      ],
    };

    const openResult = analyzeCircuit(openSwitch);
    const specialResult = analyzeCircuit(specialIds);

    expect(openResult.status).toBe("open");
    expect(openResult.parts.toString.currentAmps).toBe(0);
    expect(specialResult.status).toBe("closed");
    expect(Object.hasOwn(specialResult.parts, "__proto__")).toBe(true);
    expect(Object.hasOwn(specialResult.wireCurrents, "__proto__")).toBe(true);
    expect(Object.hasOwn(specialResult.wireCurrents, "constructor")).toBe(true);
  });

  it("returns a whole-circuit current only for one open battery", () => {
    const singleOpen = analyzeCircuit({
      title: "開いた単一電源",
      parts: [part("battery", "battery", { voltageVolts: 9 })],
      wires: [],
    });
    const multipleOpen = analyzeCircuit({
      title: "開いた複数電源",
      parts: [
        part("battery-a", "battery", { voltageVolts: 9 }),
        part("battery-b", "battery", { voltageVolts: 3 }),
      ],
      wires: [],
    });

    expect(singleOpen.status).toBe("open");
    expect(singleOpen.currentAmps).toBe(0);
    expect(singleOpen.parts.battery.voltageVolts).toBeCloseTo(9);
    expect(singleOpen.parts.battery.currentAmps).toBe(0);
    expect(multipleOpen.status).toBe("open");
    expect(multipleOpen.currentAmps).toBeNull();
  });

  it("rejects finite source voltages whose resulting power overflows", () => {
    const document: CircuitDocument = {
      title: "供給電力のオーバーフロー",
      parts: [
        part("battery", "battery", { voltageVolts: 1e308 }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe("invalid");
    expect(result.parts).toEqual({});
    expect(result.wireCurrents).toEqual({});
    expect(result.issues).toEqual([{ severity: "error", message: result.message }]);
  });

  it("rejects finite inputs whose calculated power exceeds the numeric range", () => {
    const document: CircuitDocument = {
      title: "電力計算のオーバーフロー",
      parts: [
        part("battery", "battery", { voltageVolts: 1e308, internalResistanceOhms: 1e100 }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe("invalid");
    expect(result.parts).toEqual({});
    expect(result.wireCurrents).toEqual({});
  });

  it("keeps an open resistor branch at exactly zero current in a branched circuit", () => {
    const document = createExampleCircuit();
    const branchedCircuit: CircuitDocument = {
      ...document,
      parts: [
        ...document.parts,
        part("branch", "junction"),
        part("open-resistor", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        ...document.wires,
        wire("branch-wire-a", "part-2", "b", "branch", "a"),
        wire("branch-wire-b", "branch", "a", "open-resistor", "a"),
      ],
    };

    const result = analyzeCircuit(branchedCircuit);

    expect(result.status).toBe("closed");
    expect(result.wireCurrents["branch-wire-a"]).toBe(0);
    expect(result.wireCurrents["branch-wire-b"]).toBe(0);
  });

  it("reads zero volts across a resistor with its series switch turned off", () => {
    const document: CircuitDocument = {
      title: "スイッチ開放時の電圧計",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("ammeter", "ammeter"),
        part("resistor", "resistor", { resistanceOhms: 30 }),
        part("switch", "switch", { initiallyClosed: true }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "resistor", "a"),
        wire("w3", "resistor", "b", "switch", "a"),
        wire("w4", "switch", "b", "source", "b"),
        wire("w5", "voltmeter", "a", "resistor", "a"),
        wire("w6", "voltmeter", "b", "resistor", "b"),
      ],
    };

    const result = analyzeCircuit(document, { switch: false });

    expect(result.parts.ammeter.currentAmps).toBe(0);
    expect(result.parts.voltmeter.voltageVolts).toBe(0);
  });
});
