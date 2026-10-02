import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

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

function sourceTriangle(thirdSourcePhaseDegrees: number): CircuitDocument {
  return {
    title: "三つの交流電圧源の閉ループ",
    parts: [
      part("source-ab", "ac-source", { voltageVolts: 3, phaseDegrees: 0, frequencyHz: 50 }),
      part("source-bc", "ac-source", { voltageVolts: 5, phaseDegrees: 0, frequencyHz: 50 }),
      part("source-ca", "ac-source", { voltageVolts: 8, phaseDegrees: thirdSourcePhaseDegrees, frequencyHz: 50 }),
      part("load", "resistor", { resistanceOhms: 10 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("node-a-sources", "source-ab", "a", "source-ca", "b"),
      wire("node-a-load", "source-ab", "a", "load", "a"),
      wire("node-b-sources", "source-ab", "b", "source-bc", "a"),
      wire("node-b-load", "source-ab", "b", "load", "b"),
      wire("node-c-sources", "source-bc", "b", "source-ca", "a"),
      wire("node-c-ground", "source-bc", "b", "ground", "a"),
    ],
  };
}

function batteryTriangle(thirdSourceVoltageVolts: number): CircuitDocument {
  return {
    title: "三つの電池の閉ループ",
    parts: [
      part("battery-ab", "battery", { voltageVolts: 3, internalResistanceOhms: 0 }),
      part("battery-bc", "battery", { voltageVolts: 5, internalResistanceOhms: 0 }),
      part("battery-ac", "battery", { voltageVolts: thirdSourceVoltageVolts, internalResistanceOhms: 0 }),
      part("load", "resistor", { resistanceOhms: 10 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("node-a-sources", "battery-ab", "a", "battery-ac", "a"),
      wire("node-a-load", "battery-ab", "a", "load", "a"),
      wire("node-b-sources", "battery-ab", "b", "battery-bc", "a"),
      wire("node-b-load", "battery-ab", "b", "load", "b"),
      wire("node-c-sources", "battery-bc", "b", "battery-ac", "b"),
      wire("node-c-ground", "battery-bc", "b", "ground", "a"),
    ],
  };
}

function largeCancellationLoop(): CircuitDocument {
  return {
    title: "大きな相殺を含む交流電圧源ループ",
    parts: [
      part("source-ab", "ac-source", { voltageVolts: 1e16, frequencyHz: 50 }),
      part("source-bc", "ac-source", { voltageVolts: 0.001, frequencyHz: 50 }),
      part("source-dc", "ac-source", { voltageVolts: 1e16, frequencyHz: 50 }),
      part("source-da", "ac-source", { voltageVolts: 0.002, frequencyHz: 50 }),
      part("load", "resistor", { resistanceOhms: 10 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("node-a-source", "source-ab", "a", "source-da", "b"),
      wire("node-a-load", "source-ab", "a", "load", "a"),
      wire("node-b-sources", "source-ab", "b", "source-bc", "a"),
      wire("node-c-sources", "source-bc", "b", "source-dc", "b"),
      wire("node-d-sources", "source-dc", "a", "source-da", "a"),
      wire("node-d-load", "source-dc", "a", "load", "b"),
      wire("node-d-ground", "source-dc", "a", "ground", "a"),
    ],
  };
}

function finiteLargeCancellationLoop(): CircuitDocument {
  return {
    title: "中間和が浮動小数の範囲を超える交流電源ループ",
    parts: [
      part("source-ab", "ac-source", { voltageVolts: 1e308, frequencyHz: 50 }),
      part("source-bc", "ac-source", { voltageVolts: 1e308, frequencyHz: 50 }),
      part("source-dc", "ac-source", { voltageVolts: 1e308, frequencyHz: 50 }),
      part("source-ed", "ac-source", { voltageVolts: 1e308, frequencyHz: 50 }),
      part("source-ea", "ac-source", { voltageVolts: 0, frequencyHz: 50 }),
      part("load", "resistor", { resistanceOhms: 10 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("node-a", "source-ab", "a", "source-ea", "b"),
      wire("node-b", "source-ab", "b", "source-bc", "a"),
      wire("node-c", "source-bc", "b", "source-dc", "b"),
      wire("node-d-source", "source-dc", "a", "source-ed", "b"),
      wire("node-d-ground", "source-dc", "a", "ground", "a"),
      wire("node-e-sources", "source-ed", "a", "source-ea", "a"),
      wire("load-e", "source-ed", "a", "load", "a"),
      wire("load-a", "source-ea", "b", "load", "b"),
    ],
  };
}

describe("AC ideal-source cycle audit", () => {
  it("solves a KVL-consistent triangle with a uniquely determined load voltage", () => {
    // Vab=3∠0°, Vbc=5∠0°, Vca=8∠180°: the oriented loop sum is zero.
    const result = analyzeCircuit(sourceTriangle(180), {}, { mode: "ac", frequencyHz: 50 });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.load.voltageVolts).toBeCloseTo(3, 10);
    expect(result.parts.load.voltagePhaseDegrees).toBeCloseTo(0, 9);
  });

  it("rejects a KVL-inconsistent triangle", () => {
    // Vca=7∠180° leaves a 1 V nonzero sum around the oriented loop.
    const consistent = sourceTriangle(180);
    const inconsistent = {
      ...consistent,
      parts: consistent.parts.map((item) => item.id === "source-ca"
        ? { ...item, voltageVolts: 7 }
        : item),
    };
    const inconsistentResult = analyzeCircuit(inconsistent, {}, { mode: "ac", frequencyHz: 50 });

    expect(inconsistentResult.status).toBe("invalid");
  });

  it("detects a millivolt KVL error after large cancelling source voltages", () => {
    const result = analyzeAnalogCircuit(largeCancellationLoop(), { mode: "ac", frequencyHz: 50 });

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  it("retains a finite KVL sum when path prefixes exceed the floating-point range", () => {
    const result = analyzeAnalogCircuit(finiteLargeCancellationLoop(), { mode: "ac", frequencyHz: 50 });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.load.voltage.real).toBeCloseTo(0, 10);
  });

  it("solves a KVL-consistent DC battery triangle with a uniquely determined load voltage", () => {
    // Vab=3 V, Vbc=5 V, Vac=8 V. The third source duplicates the voltage
    // constraint implied by the first two, while the load still sees 3 V.
    const result = analyzeAnalogCircuit(batteryTriangle(8), { mode: "dc" });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.load.voltage.real).toBeCloseTo(3, 10);
  });

  it("rejects a KVL-inconsistent DC battery triangle", () => {
    const result = analyzeAnalogCircuit(batteryTriangle(7), { mode: "dc" });

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });
});
