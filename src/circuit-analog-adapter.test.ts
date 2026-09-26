import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
} from "./circuit-model.js";
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
});
