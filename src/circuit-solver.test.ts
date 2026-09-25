import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  createExampleCircuit,
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
    expect(Math.abs(result.parts.r1?.currentAmps ?? 0)).toBeCloseTo(2);
    expect(Math.abs(result.parts.r2?.currentAmps ?? 0)).toBeCloseTo(1);
    expect(result.bulbPowerWatts.r2).toBeCloseTo(12);
  });

  it("reads the ammeter in series and the voltmeter across the branch", () => {
    const result = analyzeCircuit(parallel(6, 12));
    expect(Math.abs(result.parts.ammeter?.currentAmps ?? 0)).toBeCloseTo(3);
    expect(result.parts.voltmeter?.voltageVolts).toBeCloseTo(12);
    expect(result.parts.voltmeter?.currentAmps).toBe(0);
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
    expect(Math.abs(result.parts.r?.currentAmps ?? 0)).toBeCloseTo(2);
  });

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
    expect(Math.abs(result.parts.r?.currentAmps ?? 0)).toBeCloseTo(0);
  });

  it("drops the terminal voltage across a battery's internal resistance", () => {
    const document = createExampleCircuit();
    document.parts = document.parts.map((item) =>
      item.kind === "battery" ? { ...item, internalResistanceOhms: 15 } : item,
    );
    const result = analyzeCircuit(document);
    // 9 V over 10 + 20 + 15 Ω.
    expect(result.currentAmps).toBeCloseTo(0.2);
    expect(Math.abs(result.parts["part-1"]?.voltageVolts ?? 0)).toBeCloseTo(6);
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
    expect(result.parts["part-3"]?.brightness).toBe(1);
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
});
