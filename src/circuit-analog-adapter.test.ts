import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
} from "./circuit-model.js";
import { createCircuitExample } from "./circuit-examples.js";
import { analyzeCircuit } from "./circuit-solver.js";

const part = (
  id: string,
  kind: CircuitPartKind,
  extra: Partial<CircuitPart> = {},
): CircuitPart => ({ id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...extra });

describe("analyzeExtendedCircuit", () => {
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
      parts: [part("source", "ac-source", { voltageVolts: 5, frequencyHz: 100 }), part("capacitor", "capacitor")],
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
