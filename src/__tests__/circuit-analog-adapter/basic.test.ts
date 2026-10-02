import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { createCircuitExample } from "../../circuit-examples.js";
import { analyzeCircuit } from "../../circuit-solver.js";

const part = (
  id: string,
  kind: CircuitPartKind,
  extra: Partial<CircuitPart> = {},
): CircuitPart => ({ id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...extra });

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("analyzeExtendedCircuit", () => {
  it("preserves AC source, load, and voltmeter power readings above a large common-mode voltage", () => {
    const expectedCurrent = (1e12 + 1e-3) / 1e12;
    const document: CircuitDocument = {
      title: "大きい共通電位上の交流電力",
      parts: [
        part("big", "ac-source", { voltageVolts: 1e12, frequencyHz: 1000 }),
        part("small", "ac-source", { voltageVolts: 1e-3, frequencyHz: 1000 }),
        part("load", "resistor", { resistanceOhms: 1e12 }),
        part("meter", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "big", "a", "small", "b"),
        wire("w2", "small", "a", "load", "a"),
        wire("w3", "load", "b", "big", "b"),
        wire("w4", "meter", "a", "small", "a"),
        wire("w5", "meter", "b", "small", "b"),
        wire("w6", "ground", "a", "big", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.big.voltageVolts).toBeCloseTo(1e12, 1);
    expect(result.parts.small.voltageVolts).toBeCloseTo(1e-3, 12);
    expect(result.parts.meter.voltageVolts).toBeCloseTo(1e-3, 12);
    expect(result.parts.big.powerWatts / (1e12 * expectedCurrent)).toBeCloseTo(1, 12);
    expect(result.parts.small.powerWatts / (1e-3 * expectedCurrent)).toBeCloseTo(1, 12);
    expect(result.parts.load.powerWatts / (1e12 * expectedCurrent ** 2)).toBeCloseTo(1, 12);
    expect(result.parts.meter.powerWatts).toBe(0);
    expect(result.parts.meter.reactivePowerVars).toBe(0);
  });

  it("reports an AC-biased battery's internal resistance as absorbed power", () => {
    const document: CircuitDocument = {
      title: "交流回路中の電池内部抵抗",
      parts: [
        part("source", "ac-source", { voltageVolts: 10, frequencyHz: 1000 }),
        part("load", "resistor", { resistanceOhms: 10 }),
        part("battery", "battery", { internalResistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "a"),
        wire("w3", "battery", "b", "source", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.battery.currentAmps).toBeCloseTo(0.5, 10);
    expect(result.parts.battery.voltageVolts).toBeCloseTo(5, 10);
    expect(result.parts.battery.powerWatts).toBeCloseTo(2.5, 10);
    expect(result.parts.load.powerWatts).toBeCloseTo(2.5, 10);
    expect(result.parts.source.powerWatts).toBeCloseTo(5, 10);
    expect(result.parts.source.powerWatts).toBeCloseTo(
      result.parts.load.powerWatts + result.parts.battery.powerWatts,
      10,
    );
  });

  it("adds same-frequency AC source phasors and measures the differential voltage without a fixed reference", () => {
    const document: CircuitDocument = {
      title: "交流電源2個の直列合成",
      parts: [
        part("source-1", "ac-source", { voltageVolts: 3, frequencyHz: 50, phaseDegrees: 0 }),
        part("source-2", "ac-source", { voltageVolts: 4, frequencyHz: 50, phaseDegrees: 90 }),
        part("load", "resistor", { resistanceOhms: 10 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source-1", "b", "source-2", "a"),
        wire("w2", "source-1", "a", "load", "a"),
        wire("w3", "load", "b", "source-2", "b"),
        wire("w4", "voltmeter", "a", "load", "a"),
        wire("w5", "voltmeter", "b", "load", "b"),
      ],
    };
    const expectedReal = 3;
    const expectedImaginary = 4;
    const expectedMagnitude = Math.hypot(expectedReal, expectedImaginary);
    const expectedPhase = Math.atan2(expectedImaginary, expectedReal) * 180 / Math.PI;

    const floating = analyzeCircuit(document, {}, { mode: "ac" });
    const grounded = analyzeCircuit({
      ...document,
      parts: [...document.parts, part("ground", "ground")],
      wires: [...document.wires, wire("w6", "source-1", "b", "ground", "a")],
    }, {}, { mode: "ac" });

    for (const result of [floating, grounded]) {
      expect(result.status, result.message).toBe("closed");
      expect(result.frequencyHz).toBe(50);
      expect(result.parts.load.voltageVolts).toBeCloseTo(expectedMagnitude, 10);
      expect(result.parts.load.voltagePhaseDegrees).toBeCloseTo(expectedPhase, 10);
      expect(result.parts.load.currentAmps).toBeCloseTo(expectedMagnitude / 10, 10);
      expect(result.parts.voltmeter.meterStatus).toBe("connected");
      expect(result.parts.voltmeter.voltageVolts).toBeCloseTo(expectedMagnitude, 10);
      expect(result.parts.voltmeter.voltagePhaseDegrees).toBeCloseTo(expectedPhase, 10);
      expect(result.parts.voltmeter.currentAmps).toBe(0);
    }
  });

  it("partitions a series RLC source voltage by independently calculated reactances", () => {
    const frequencyHz = 60;
    const sourceVoltage = 10;
    const resistance = 10;
    const inductance = 0.1;
    const capacitance = 100e-6;
    const omega = 2 * Math.PI * frequencyHz;
    const inductiveReactance = omega * inductance;
    const capacitiveReactance = 1 / (omega * capacitance);
    const netReactance = inductiveReactance - capacitiveReactance;
    const impedanceMagnitude = Math.hypot(resistance, netReactance);
    const currentMagnitude = sourceVoltage / impedanceMagnitude;
    const currentPhase = -Math.atan2(netReactance, resistance) * 180 / Math.PI;
    const document: CircuitDocument = {
      title: "交流RLC直列電圧分配",
      parts: [
        part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("inductor", "inductor", { inductanceHenries: inductance }),
        part("capacitor", "capacitor", { capacitanceFarads: capacitance }),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "inductor", "a"),
        wire("w3", "inductor", "b", "capacitor", "a"),
        wire("w4", "capacitor", "b", "source", "b"),
      ],
    };
    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status, result.message).toBe("closed");
    expect(result.frequencyHz).toBe(frequencyHz);
    expect(result.parts.resistor.currentAmps).toBeCloseTo(currentMagnitude, 10);
    expect(result.parts.inductor.currentAmps).toBeCloseTo(currentMagnitude, 10);
    expect(result.parts.capacitor.currentAmps).toBeCloseTo(currentMagnitude, 10);
    expect(result.parts.resistor.voltageVolts).toBeCloseTo(currentMagnitude * resistance, 10);
    expect(result.parts.inductor.voltageVolts).toBeCloseTo(currentMagnitude * inductiveReactance, 10);
    expect(result.parts.capacitor.voltageVolts).toBeCloseTo(currentMagnitude * capacitiveReactance, 10);
    expect(result.parts.resistor.voltagePhaseDegrees).toBeCloseTo(currentPhase, 10);
    expect(result.parts.inductor.voltagePhaseDegrees).toBeCloseTo(currentPhase + 90, 10);
    expect(result.parts.capacitor.voltagePhaseDegrees).toBeCloseTo(currentPhase - 90, 10);
    expect(Math.hypot(
      result.parts.resistor.voltageVolts,
      result.parts.inductor.voltageVolts - result.parts.capacitor.voltageVolts,
    )).toBeCloseTo(sourceVoltage, 10);
  });

  it("stores readings for prototype-named part IDs as ordinary own properties", () => {
    const document: CircuitDocument = {
      title: "特殊な部品ID",
      parts: [
        part("__proto__", "current-source", { currentAmps: 1 }),
        part("constructor", "resistor", { resistanceOhms: 10 }),
        part("toString", "junction"),
      ],
      wires: [
        { id: "wire-a", from: { partId: "__proto__", terminal: "a" }, to: { partId: "constructor", terminal: "a" } },
        { id: "wire-b", from: { partId: "constructor", terminal: "b" }, to: { partId: "__proto__", terminal: "b" } },
        { id: "wire-c", from: { partId: "toString", terminal: "a" }, to: { partId: "constructor", terminal: "a" } },
      ],
    };

    const result = analyzeCircuit(document);
    const protoId = "__proto__";

    expect(result.status).toBe("closed");
    expect(Object.hasOwn(result.parts, protoId)).toBe(true);
    expect(Object.hasOwn(result.parts, "constructor")).toBe(true);
    expect(Object.hasOwn(result.parts, "toString")).toBe(true);
    expect(result.parts[protoId].currentAmps).toBeCloseTo(1);
    expect(result.parts.constructor.powerWatts).toBeCloseTo(10);
    expect(result.parts.toString.currentAmps).toBe(0);
  });

  it("preserves the phase of a very small non-zero AC phasor", () => {
    const document: CircuitDocument = {
      title: "微小な交流電流の位相",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 100, phaseDegrees: 90 }),
        part("load", "resistor", { resistanceOhms: 1e16 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
        { id: "w3", from: { partId: "voltmeter", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w4", from: { partId: "voltmeter", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status).toBe("closed");
    expect(result.parts.load.currentAmps).toBeGreaterThan(0);
    expect(result.parts.load.currentAmps).toBeCloseTo(1e-16, 24);
    expect(result.parts.load.currentPhaseDegrees).toBeCloseTo(90, 8);
    expect(result.parts.voltmeter.currentAmps).toBe(0);
    expect(result.parts.voltmeter.currentPhaseDegrees).toBe(0);
  });

  it("returns invalid instead of throwing when switch states are explicitly null", () => {
    const document: CircuitDocument = {
      title: "nullのスイッチ状態",
      parts: [part("switch", "switch"), part("ground", "ground")],
      wires: [],
    };

    const result = analyzeCircuit(document, null as unknown as Record<string, boolean>);

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("スイッチ状態");
  });

  it("reports an open DC return through an open switch and honors the solved switch state", () => {
    const document: CircuitDocument = {
      title: "スイッチで開いた拡張回路",
      parts: [
        part("source", "battery", { voltageVolts: 5 }),
        part("switch", "switch", { initiallyClosed: false }),
        part("load", "resistor", { resistanceOhms: 100 }),
        part("capacitor", "capacitor"),
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "switch", terminal: "a" } },
        { id: "w2", from: { partId: "switch", terminal: "b" }, to: { partId: "load", terminal: "a" } },
        { id: "w3", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };

    const open = analyzeCircuit(document);
    const closed = analyzeCircuit(document, { switch: true });

    expect(open.status).toBe("open");
    expect(open.currentAmps).toBe(0);
    expect(open.message).toContain("開いている");
    expect(closed.status).toBe("closed");
    expect(closed.parts.load.currentAmps).toBeCloseTo(0.05, 8);
  });

  it("treats a capacitor as open in DC and as a return path in AC", () => {
    const document: CircuitDocument = {
      title: "コンデンサーの直流・交流経路",
      parts: [part("source", "ac-source", { voltageVolts: 5, frequencyHz: 100, offsetVolts: 5 }), part("capacitor", "capacitor")],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "w2", from: { partId: "source", terminal: "b" }, to: { partId: "capacitor", terminal: "b" } },
      ],
    };

    expect(analyzeCircuit(document, {}, { mode: "dc" }).status).toBe("open");
    const ac = analyzeCircuit(document, {}, { mode: "ac" });
    expect(ac.status).toBe("closed");
    expect(ac.parts.capacitor.currentAmps).toBeGreaterThan(0);
  });

  it("keeps a balanced multi-source loop closed even when its current is zero", () => {
    const document: CircuitDocument = {
      title: "逆向きの拡張回路電池",
      parts: [
        part("first", "battery", { voltageVolts: 9 }),
        part("second", "battery", { voltageVolts: 9 }),
        part("load", "resistor", { resistanceOhms: 10 }),
        part("capacitor", "capacitor"),
      ],
      wires: [
        { id: "w1", from: { partId: "first", terminal: "b" }, to: { partId: "second", terminal: "b" } },
        { id: "w2", from: { partId: "second", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w3", from: { partId: "load", terminal: "b" }, to: { partId: "first", terminal: "a" } },
      ],
    };

    const result = analyzeCircuit(document);

    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeNull();
    expect(result.parts.load.currentAmps).toBeCloseTo(0, 12);
  });

  it("does not use an unexcited current source as a return path", () => {
    const dcCircuit: CircuitDocument = {
      title: "0 A電流源と電池",
      parts: [part("battery", "battery", { voltageVolts: 5 }), part("current", "current-source", { currentAmps: 0 })],
      wires: [
        { id: "w1", from: { partId: "battery", terminal: "a" }, to: { partId: "current", terminal: "a" } },
        { id: "w2", from: { partId: "battery", terminal: "b" }, to: { partId: "current", terminal: "b" } },
      ],
    };
    const acCircuit: CircuitDocument = {
      title: "交流解析中の電流源",
      parts: [part("source", "ac-source", { voltageVolts: 5, frequencyHz: 100 }), part("current", "current-source", { currentAmps: 0.01 })],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "current", terminal: "a" } },
        { id: "w2", from: { partId: "source", terminal: "b" }, to: { partId: "current", terminal: "b" } },
      ],
    };

    const dc = analyzeCircuit(dcCircuit, {}, { mode: "dc" });
    const ac = analyzeCircuit(acCircuit, {}, { mode: "ac" });

    expect(dc.status).toBe("open");
    expect(dc.currentAmps).toBeNull();
    expect(dc.parts.battery.currentAmps).toBeCloseTo(0, 12);
    expect(ac.status).toBe("open");
    expect(ac.currentAmps).toBeNull();
    expect(ac.parts.source.currentAmps).toBeCloseTo(0, 12);
  });

  it("marks sources idle when they do not excite the selected analysis mode", () => {
    const batteryInAc: CircuitDocument = {
      title: "交流解析中の電池",
      parts: [
        part("battery", "battery", { voltageVolts: 5 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "b"),
      ],
    };
    const zeroOffsetInDc: CircuitDocument = {
      title: "直流解析中のオフセットなし交流電源",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, offsetVolts: 0 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
      ],
    };
    const ac = analyzeCircuit(batteryInAc, {}, { mode: "ac" });
    const dc = analyzeCircuit(zeroOffsetInDc, {}, { mode: "dc" });
    const dcWithOffset = analyzeCircuit({
      ...zeroOffsetInDc,
      parts: zeroOffsetInDc.parts.map((item) => item.id === "source" ? { ...item, offsetVolts: 2 } : item),
    }, {}, { mode: "dc" });

    expect(ac.status, ac.message).toBe("idle");
    expect(ac.parts.load.voltageVolts).toBe(0);
    expect(ac.parts.load.currentAmps).toBe(0);
    expect(ac.issues.some((issue) => issue.message.includes("交流電源がない"))).toBe(true);
    expect(dc.status, dc.message).toBe("idle");
    expect(dc.parts.load.voltageVolts).toBe(0);
    expect(dc.parts.load.currentAmps).toBe(0);
    expect(dcWithOffset.status, dcWithOffset.message).toBe("closed");
    expect(dcWithOffset.parts.load.voltageVolts).toBeCloseTo(2, 10);
    expect(dcWithOffset.parts.load.currentAmps).toBeCloseTo(0.02, 10);
  });

  it("keeps a battery available as an AC return path without treating it as an AC source", () => {
    const document: CircuitDocument = {
      title: "交流解析の直流電池経路",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 50 }),
        part("battery", "battery", { voltageVolts: 9 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "a"),
        wire("w3", "battery", "b", "source", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac" });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.load.voltageVolts).toBeCloseTo(5, 10);
    expect(result.parts.load.currentAmps).toBeCloseTo(0.05, 10);
  });

  it("does not mark an AC source active at a different analysis frequency", () => {
    const document: CircuitDocument = {
      title: "解析周波数と異なる交流電源",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 50 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 60 });

    expect(result.status, result.message).toBe("idle");
    expect(result.parts.load.voltageVolts).toBe(0);
    expect(result.parts.load.currentAmps).toBe(0);
    expect(result.issues.some((issue) => issue.message.includes("解析周波数と異なる"))).toBe(true);
  });

  it("requires an external op-amp output return path and ignores an isolated part", () => {
    const unloaded: CircuitDocument = {
      title: "無負荷オペアンプ",
      parts: [part("amp", "op-amp"), part("isolated", "resistor", { resistanceOhms: 100 })],
      wires: [],
    };
    const capacitiveLoad: CircuitDocument = {
      title: "コンデンサー負荷のオペアンプ",
      parts: [part("amp", "op-amp"), part("load", "capacitor"), part("ground", "ground")],
      wires: [
        { id: "w1", from: { partId: "amp", terminal: "c" }, to: { partId: "load", terminal: "a" } },
        { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      ],
    };

    expect(analyzeCircuit(unloaded, {}, { mode: "dc" }).status).toBe("idle");
    expect(analyzeCircuit(createCircuitExample("opamp"), {}, { mode: "dc" }).status).toBe("closed");
    expect(analyzeCircuit(capacitiveLoad, {}, { mode: "dc" }).status).toBe("idle");
    expect(analyzeCircuit(capacitiveLoad, {}, { mode: "ac" }).status).toBe("closed");
  });
});
