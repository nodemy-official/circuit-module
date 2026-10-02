import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitTerminal } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function part(id: string, kind: CircuitPartKind, properties: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) {
  return { id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } };
}

describe("transient AC source at an operating-point start", () => {
  it("keeps the instantaneous t=0 source waveform when the circuit has no stored state", () => {
    const rmsVoltage = 5;
    const offsetVolts = 0.25;
    const document: CircuitDocument = {
      title: "AC source without stored state",
      parts: [
        part("source", "ac-source", { voltageVolts: rmsVoltage, frequencyHz: 50, phaseDegrees: 0, offsetVolts }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-load", "source", "a", "load", "a"),
        wire("load-source", "load", "b", "source", "b"),
      ],
    };
    const expectedInitialVoltage = offsetVolts + Math.SQRT2 * rmsVoltage;
    const ordinaryStart = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
    const operatingPointStart = simulateTransient(document, {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      startFromOperatingPoint: true,
    });

    expect(ordinaryStart.status, ordinaryStart.message).toBe("valid");
    expect(operatingPointStart.status, operatingPointStart.message).toBe("valid");
    expect(ordinaryStart.samples[0]?.parts.source?.voltageVolts).toBeCloseTo(expectedInitialVoltage, 12);
    expect(operatingPointStart.samples[0]?.parts.source?.voltageVolts).toBeCloseTo(expectedInitialVoltage, 12);
  });

  it("preserves DC capacitor voltage and inductor current while sampling the AC source at t=0", () => {
    const rmsVoltage = 1;
    const offsetVolts = 2;
    const frequencyHz = 50;
    const timeStepSeconds = 0.01;
    const inductorResistance = 10;
    const inductorHenries = 1;
    const capacitorResistance = 100;
    const capacitanceFarads = 0.001;
    const document: CircuitDocument = {
      title: "AC-driven parallel RC and RL branches",
      parts: [
        part("source", "ac-source", { voltageVolts: rmsVoltage, frequencyHz, phaseDegrees: 0, offsetVolts }),
        part("inductor-resistor", "resistor", { resistanceOhms: inductorResistance }),
        part("inductor", "inductor", { inductanceHenries: inductorHenries }),
        part("capacitor-resistor", "resistor", { resistanceOhms: capacitorResistance }),
        part("capacitor", "capacitor", { capacitanceFarads }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-inductor-resistor", "source", "a", "inductor-resistor", "a"),
        wire("inductor-resistor-inductor", "inductor-resistor", "b", "inductor", "a"),
        wire("inductor-ground", "inductor", "b", "ground", "a"),
        wire("source-capacitor-resistor", "source", "a", "capacitor-resistor", "a"),
        wire("capacitor-resistor-capacitor", "capacitor-resistor", "b", "capacitor", "a"),
        wire("capacitor-ground", "capacitor", "b", "ground", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: timeStepSeconds,
      timeStepSeconds,
      startFromOperatingPoint: true,
    });
    const initial = result.samples[0]?.parts;
    const next = result.samples[1]?.parts;
    const initialSourceVoltage = offsetVolts + Math.SQRT2 * rmsVoltage;
    const nextSourceVoltage = offsetVolts - Math.SQRT2 * rmsVoltage;
    const expectedNextInductorCurrent =
      (nextSourceVoltage + (inductorHenries / timeStepSeconds) * (offsetVolts / inductorResistance)) /
      (inductorResistance + inductorHenries / timeStepSeconds);
    const capacitorRatio = timeStepSeconds / (capacitorResistance * capacitanceFarads);
    const expectedNextCapacitorVoltage = (offsetVolts + capacitorRatio * nextSourceVoltage) / (1 + capacitorRatio);

    expect(result.status, result.message).toBe("valid");
    expect(initial?.source?.voltageVolts).toBeCloseTo(initialSourceVoltage, 12);
    expect(initial?.capacitor?.voltageVolts).toBeCloseTo(offsetVolts, 12);
    expect(initial?.inductor?.currentAmps).toBeCloseTo(offsetVolts / inductorResistance, 12);
    expect(next?.source?.voltageVolts).toBeCloseTo(nextSourceVoltage, 12);
    expect(next?.inductor?.currentAmps).toBeCloseTo(expectedNextInductorCurrent, 12);
    expect(next?.capacitor?.voltageVolts).toBeCloseTo(expectedNextCapacitorVoltage, 12);
  });

  it("retains exact one-third capacitor states through an ideal voltage loop", () => {
    const document: CircuitDocument = {
      title: "Exact divider capacitor state",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("r1", "resistor", { resistanceOhms: 1 }),
        part("r2", "resistor", { resistanceOhms: 1 }),
        part("r3", "resistor", { resistanceOhms: 1 }),
        part("c1", "capacitor", { capacitanceFarads: 1 }),
        part("c2", "capacitor", { capacitanceFarads: 1 }),
        part("c3", "capacitor", { capacitanceFarads: 1 }),
      ],
      wires: [
        wire("source-r1", "source", "a", "r1", "a"),
        wire("r1-r2", "r1", "b", "r2", "a"),
        wire("r2-r3", "r2", "b", "r3", "a"),
        wire("r3-source", "r3", "b", "source", "b"),
        wire("c1-r1-a", "c1", "a", "r1", "a"),
        wire("c1-r1-b", "c1", "b", "r1", "b"),
        wire("c2-r2-a", "c2", "a", "r2", "a"),
        wire("c2-r2-b", "c2", "b", "r2", "b"),
        wire("c3-r3-a", "c3", "a", "r3", "a"),
        wire("c3-r3-b", "c3", "b", "r3", "b"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: 0.1,
      timeStepSeconds: 0.1,
      startFromOperatingPoint: true,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      for (const id of ["c1", "c2", "c3"]) {
        expect(sample.parts[id].voltageVolts).toBeCloseTo(1 / 3, 15);
        expect(sample.parts[id].currentAmps).toBe(0);
      }
      for (const id of ["r1", "r2", "r3"]) {
        expect(sample.parts[id].currentAmps).toBeCloseTo(1 / 3, 15);
      }
    }
  });

  it("uses exact DC capacitor voltages when the t=0 AC source matches the DC operating point", () => {
    const document: CircuitDocument = {
      title: "Exact divider capacitor state at an AC zero crossing",
      parts: [
        part("source", "ac-source", {
          voltageVolts: 1,
          frequencyHz: 50,
          phaseDegrees: 90,
          offsetVolts: 1,
        }),
        part("r1", "resistor", { resistanceOhms: 1 }),
        part("r2", "resistor", { resistanceOhms: 1 }),
        part("r3", "resistor", { resistanceOhms: 1 }),
        part("c1", "capacitor", { capacitanceFarads: 1 }),
        part("c2", "capacitor", { capacitanceFarads: 1 }),
        part("c3", "capacitor", { capacitanceFarads: 1 }),
      ],
      wires: [
        wire("source-r1", "source", "a", "r1", "a"),
        wire("r1-r2", "r1", "b", "r2", "a"),
        wire("r2-r3", "r2", "b", "r3", "a"),
        wire("r3-source", "r3", "b", "source", "b"),
        wire("c1-r1-a", "c1", "a", "r1", "a"),
        wire("c1-r1-b", "c1", "b", "r1", "b"),
        wire("c2-r2-a", "c2", "a", "r2", "a"),
        wire("c2-r2-b", "c2", "b", "r2", "b"),
        wire("c3-r3-a", "c3", "a", "r3", "a"),
        wire("c3-r3-b", "c3", "b", "r3", "b"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: 0.02,
      timeStepSeconds: 0.02,
      startFromOperatingPoint: true,
    });
    const initialCapacitorCurrent = -Math.SQRT2 * 2 * Math.PI * 50 / 3;

    expect(result.status, result.message).toBe("valid");
    for (const [index, sample] of result.samples.entries()) {
      expect(sample.parts.source?.voltageVolts).toBeCloseTo(1, 14);
      for (const id of ["c1", "c2", "c3"]) {
        expect(sample.parts[id].voltageVolts).toBeCloseTo(1 / 3, 15);
        expect(sample.parts[id].currentAmps).toBeCloseTo(index === 0 ? initialCapacitorCurrent : 0, 12);
      }
      for (const id of ["r1", "r2", "r3"]) {
        expect(sample.parts[id].currentAmps).toBeCloseTo(1 / 3, 15);
      }
    }
  });

  it("preserves exact subnormal capacitor states even when each displayed voltage rounds to zero", () => {
    const minimum = Number.MIN_VALUE;
    const document: CircuitDocument = {
      title: "Subnormal exact capacitor operating point",
      parts: [
        part("source", "ac-source", {
          voltageVolts: minimum,
          frequencyHz: 1,
          phaseDegrees: 90,
          offsetVolts: minimum,
        }),
        part("r1", "resistor", { resistanceOhms: minimum }),
        part("r2", "resistor", { resistanceOhms: minimum }),
        part("c1", "capacitor", { capacitanceFarads: minimum }),
        part("c2", "capacitor", { capacitanceFarads: minimum }),
      ],
      wires: [
        wire("source-r1", "source", "a", "r1", "a"),
        wire("r1-r2", "r1", "b", "r2", "a"),
        wire("r2-source", "r2", "b", "source", "b"),
        wire("c1-r1-a", "c1", "a", "r1", "a"),
        wire("c1-r1-b", "c1", "b", "r1", "b"),
        wire("c2-r2-a", "c2", "a", "r2", "a"),
        wire("c2-r2-b", "c2", "b", "r2", "b"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: minimum,
      timeStepSeconds: minimum,
      startFromOperatingPoint: true,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(sample.parts.c1.voltageVolts).toBe(0);
      expect(sample.parts.c2.voltageVolts).toBe(0);
      expect(Math.abs(sample.parts.c1.currentAmps)).toBe(0);
      expect(Math.abs(sample.parts.c2.currentAmps)).toBe(0);
      expect(sample.parts.r1.currentAmps).toBe(0.5);
      expect(sample.parts.r2.currentAmps).toBe(0.5);
    }
  });

  it("preserves an exact one-third ampere DC inductor current", () => {
    const document: CircuitDocument = {
      title: "Exact inductor current operating point",
      parts: [
        part("source", "ac-source", {
          voltageVolts: 1,
          frequencyHz: 1,
          phaseDegrees: 90,
          offsetVolts: 1,
        }),
        part("resistor", "resistor", { resistanceOhms: 3 }),
        part("inductor", "inductor", { inductanceHenries: 1 }),
      ],
      wires: [
        wire("source-r", "source", "a", "resistor", "a"),
        wire("r-l", "resistor", "b", "inductor", "a"),
        wire("l-source", "inductor", "b", "source", "b"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: 1,
      timeStepSeconds: 1,
      startFromOperatingPoint: true,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(sample.parts.source.voltageVolts).toBeCloseTo(1, 12);
      expect(sample.parts.inductor.currentAmps).toBeCloseTo(1 / 3, 15);
      expect(Math.abs(sample.parts.inductor.voltageVolts)).toBe(0);
      expect(sample.parts.resistor.currentAmps).toBeCloseTo(1 / 3, 15);
    }
  });

  it("rejects a DC capacitor state that conflicts with the actual t=0 ideal AC-source voltage", () => {
    const document: CircuitDocument = {
      title: "AC source directly across a capacitor at operating-point start",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 50, phaseDegrees: 0, offsetVolts: 0 }),
        part("capacitor", "capacitor", { capacitanceFarads: 1e-6 }),
      ],
      wires: [
        wire("source-capacitor-a", "source", "a", "capacitor", "a"),
        wire("source-capacitor-b", "source", "b", "capacitor", "b"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      startFromOperatingPoint: true,
    });

    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });
});
