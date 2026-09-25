import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "./circuit-model.js";
import {
  MAX_TRANSIENT_STEPS,
  simulateTransient,
} from "./transient-solver.js";

function part(
  id: string,
  kind: CircuitPartKind,
  properties: Partial<CircuitPart> = {},
): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(id: string, fromPart: string, fromTerminal: "a" | "b", toPart: string, toTerminal: "a" | "b") {
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal },
    to: { partId: toPart, terminal: toTerminal },
  } satisfies CircuitWire;
}

function rcCircuit(initialVoltageVolts = 0): CircuitDocument {
  return {
    title: "RC charging",
    parts: [
      part("source", "battery", { voltageVolts: 1, internalResistanceOhms: 0 }),
      part("resistor", "resistor", { resistanceOhms: 1000 }),
      part("capacitor", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts }),
      part("ground", "ground"),
    ],
    wires: [
      wire("wire-source-r", "source", "a", "resistor", "a"),
      wire("wire-r-c", "resistor", "b", "capacitor", "a"),
      wire("wire-c-ground", "capacitor", "b", "ground", "a"),
      wire("wire-source-ground", "source", "b", "ground", "a"),
    ],
  };
}

describe("simulateTransient", () => {
  it("charges an RC circuit with backward Euler and includes both endpoints", () => {
    const document = rcCircuit();
    const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(101);
    expect(result.samples[0]?.timeSeconds).toBe(0);
    expect(result.samples.at(-1)?.timeSeconds).toBe(1);
    expect(result.samples[1]?.parts.capacitor?.currentAmps).toBeCloseTo(0.000_990_1, 6);
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(0.6303, 3);
  });

  it("accepts equal initial voltages on parallel capacitors without duplicate ideal sources", () => {
    const document = rcCircuit();
    document.parts.push(part("capacitor-2", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts: 0 }));
    document.wires.push(
      wire("wire-parallel-a", "capacitor", "a", "capacitor-2", "a"),
      wire("wire-parallel-b", "capacitor", "b", "capacitor-2", "b"),
    );
    const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBe(0);
    expect(result.samples[0]?.parts["capacitor-2"]?.voltageVolts).toBe(0);
    expect(result.samples[0]?.parts.capacitor?.currentAmps).toBeCloseTo(
      result.samples[0]?.parts["capacitor-2"]?.currentAmps ?? Number.NaN,
      8,
    );
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(0.3927, 4);
    expect(result.samples.at(-1)?.parts["capacitor-2"]?.voltageVolts).toBeCloseTo(0.3927, 4);
  });

  it("matches reversed parallel capacitor polarities and shares their initial branch current", () => {
    const document = rcCircuit(2);
    document.parts.push(part("capacitor-2", "capacitor", {
      capacitanceFarads: 3e-3,
      initialVoltageVolts: -2,
    }));
    document.wires.push(
      wire("wire-reversed-a", "capacitor", "a", "capacitor-2", "b"),
      wire("wire-reversed-b", "capacitor", "b", "capacitor-2", "a"),
    );
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBe(2);
    expect(result.samples[0]?.parts["capacitor-2"]?.voltageVolts).toBe(-2);
    expect(result.samples[0]?.parts.capacitor?.currentAmps).toBeCloseTo(-0.000_25, 8);
    expect(result.samples[0]?.parts["capacitor-2"]?.currentAmps).toBeCloseTo(0.000_75, 8);
  });

  it("accepts a zero-initial-voltage capacitor whose terminals are shorted", () => {
    const document: CircuitDocument = {
      title: "Shorted capacitor",
      parts: [part("capacitor", "capacitor", { capacitanceFarads: 1e-6 })],
      wires: [wire("wire-short", "capacitor", "a", "capacitor", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor).toMatchObject({ voltageVolts: 0, currentAmps: 0, powerWatts: 0, terminalVoltages: { a: 0, b: 0 }, terminalCurrents: { a: 0, b: 0 } });
  });

  it("satisfies capacitor initial voltage exactly at t=0", () => {
    const document = rcCircuit(2);
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.01 });

    expect(result.status).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBe(2);
    expect(result.samples[0]?.parts.capacitor?.currentAmps).toBeCloseTo(-0.001, 8);
  });

  it("satisfies inductor initial current exactly at t=0", () => {
    const document: CircuitDocument = {
      title: "Inductor initial current",
      parts: [
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0.25 }),
        part("resistor", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("wire-a", "inductor", "a", "resistor", "a"),
        wire("wire-b", "inductor", "b", "resistor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.inductor?.currentAmps).toBe(0.25);
  });

  it("simulates an RL step and carries inductor branch current between steps", () => {
    const document: CircuitDocument = {
      title: "RL step",
      parts: [
        part("source", "battery", { voltageVolts: 1, internalResistanceOhms: 0 }),
        part("resistor", "resistor", { resistanceOhms: 100 }),
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-r", "source", "a", "resistor", "a"),
        wire("wire-r-l", "resistor", "b", "inductor", "a"),
        wire("wire-l-ground", "inductor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[1]?.parts.inductor?.currentAmps).toBeCloseTo(1 / 1100, 7);
    expect(result.samples.at(-1)?.parts.inductor?.currentAmps).toBeCloseTo(0.01, 5);
  });

  it("starts from the DC operating point when requested", () => {
    const result = simulateTransient(rcCircuit(), {
      durationSeconds: 0.1,
      timeStepSeconds: 0.01,
      startFromOperatingPoint: true,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBeCloseTo(1, 8);
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(1, 8);
    expect(result.samples.at(-1)?.parts.capacitor?.currentAmps).toBeCloseTo(0, 9);
  });

  it("includes an exact final sample when the duration is not divisible by the step", () => {
    const result = simulateTransient(rcCircuit(), { durationSeconds: 0.025, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.01, 0.02, 0.025]);
  });

  it("uses the AC source RMS setting as a peak-valued time waveform", () => {
    const document: CircuitDocument = {
      title: "AC input",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 50, phaseDegrees: 0, offsetVolts: 0 }),
        part("load", "resistor", { resistanceOhms: 100 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-load", "source", "a", "load", "a"),
        wire("wire-load-ground", "load", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.02, timeStepSeconds: 0.0001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.source?.voltageVolts).toBeCloseTo(Math.SQRT2 * 5, 8);
    expect(result.samples[50]?.parts.source?.voltageVolts).toBeCloseTo(0, 8);
    expect(result.samples[100]?.parts.source?.voltageVolts).toBeCloseTo(-Math.SQRT2 * 5, 8);
  });

  it("rectifies the AC waveform with a nonlinear diode", () => {
    const document: CircuitDocument = {
      title: "Half-wave rectifier",
      parts: [
        part("source", "ac-source", { voltageVolts: 3, frequencyHz: 50 }),
        part("diode", "diode"),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-diode", "source", "a", "diode", "a"),
        wire("wire-diode-load", "diode", "b", "load", "a"),
        wire("wire-load-ground", "load", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.02, timeStepSeconds: 0.0001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.load?.voltageVolts).toBeGreaterThan(3);
    expect(Math.abs(result.samples[100]?.parts.load?.voltageVolts ?? 1)).toBeLessThan(1e-5);
  });

  it("reports incompatible capacitor initial constraints instead of hiding them", () => {
    const document: CircuitDocument = {
      title: "Conflicting initial state",
      parts: [
        part("c1", "capacitor", { capacitanceFarads: 1e-6, initialVoltageVolts: 1 }),
        part("c2", "capacitor", { capacitanceFarads: 1e-6, initialVoltageVolts: 2 }),
      ],
      wires: [
        wire("wire-a", "c1", "a", "c2", "a"),
        wire("wire-b", "c1", "b", "c2", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("初期電圧");
  });

  it("returns invalid for malformed input documents instead of throwing", () => {
    const duplicateIds = rcCircuit();
    duplicateIds.parts[1] = { ...duplicateIds.parts[1]!, id: "source" };
    expect(simulateTransient(duplicateIds, { durationSeconds: 0.1, timeStepSeconds: 0.01 }).status).toBe("invalid");

    const unknownKind = rcCircuit();
    unknownKind.parts[0] = { ...unknownKind.parts[0]!, kind: "mystery" as CircuitPartKind };
    expect(simulateTransient(unknownKind, { durationSeconds: 0.1, timeStepSeconds: 0.01 }).status).toBe("invalid");

    const duplicateWireIds = rcCircuit();
    duplicateWireIds.wires[1] = { ...duplicateWireIds.wires[1]!, id: duplicateWireIds.wires[0]!.id };
    expect(simulateTransient(duplicateWireIds, { durationSeconds: 0.1, timeStepSeconds: 0.01 }).status)
      .toBe("invalid");
  });

  it.each([
    ["capacitor", { capacitanceFarads: 0 }],
    ["inductor", { inductanceHenries: 0 }],
  ] as const)("does not hide an invalid original %s value during equivalent conversion", (kind, value) => {
    const document = kind === "capacitor" ? rcCircuit() : {
      title: "Invalid inductor",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("inductor", "inductor", { inductanceHenries: 1e-3 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-l", "source", "a", "inductor", "a"),
        wire("wire-l-ground", "inductor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const target = kind === "capacitor" ? document.parts.find(({ kind: itemKind }) => itemKind === "capacitor")
      : document.parts.find(({ kind: itemKind }) => itemKind === "inductor");
    if (!target) { throw new Error(`Missing ${kind}`); }
    Object.assign(target, value);

    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });
    expect(result.status).toBe("invalid");

    if (kind === "capacitor") {
      const explicitNull = rcCircuit();
      const capacitor = explicitNull.parts.find(({ kind: itemKind }) => itemKind === "capacitor");
      if (!capacitor) { throw new Error("Missing capacitor"); }
      Object.assign(capacitor, { capacitanceFarads: null });
      expect(simulateTransient(explicitNull, { durationSeconds: 0.01, timeStepSeconds: 0.001 }).status)
        .toBe("invalid");
    }
  });

  it("rejects invalid, oversized, and excessively expensive analyses before solving", () => {
    const document = rcCircuit();
    expect(simulateTransient(document, { durationSeconds: 0, timeStepSeconds: 0.01 }).status).toBe("invalid");
    expect(simulateTransient(document, { durationSeconds: 10, timeStepSeconds: 0.001 }).message)
      .toContain(`${MAX_TRANSIENT_STEPS}以下`);

    const tooManyPins: CircuitDocument = {
      title: "Too many terminals",
      parts: Array.from({ length: 257 }, (_, index) => part(`r${index}`, "resistor")),
      wires: [],
    };
    expect(simulateTransient(tooManyPins, { durationSeconds: 0.01, timeStepSeconds: 0.01 }).message)
      .toContain("端子数");

    const tooMuchWork: CircuitDocument = {
      title: "Too much transient solver work",
      parts: Array.from({ length: 100 }, (_, index) => part(`r${index}`, "resistor")),
      wires: [],
    };
    expect(simulateTransient(tooMuchWork, { durationSeconds: 2, timeStepSeconds: 0.001 }).message)
      .toContain("演算量");
  });
});
