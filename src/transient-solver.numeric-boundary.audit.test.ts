import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitTerminal } from "./circuit-model.js";
import { simulateTransient } from "./transient-solver.js";

function part(id: string, kind: CircuitPartKind, properties: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) {
  return { id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } };
}

describe("transient numerical boundary audit", () => {
  it("keeps a representable near-axis voltage when RMS and frequency overflow before tiny time scales them down", () => {
    const voltageVolts = 1e308;
    const frequencyHz = 1e10;
    const timeSeconds = 5e-319;
    const document: CircuitDocument = {
      title: "Subnormal transient product after large scale factors",
      parts: [
        part("source", "ac-source", { voltageVolts, frequencyHz, phaseDegrees: 90 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-load", "source", "a", "load", "a"),
        wire("load-source", "load", "b", "source", "b"),
      ],
    };
    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });
    const sampledVoltage = waveform.samples.at(-1)?.parts.source?.voltageVolts;
    const expectedVoltage = -Math.SQRT2 * ((frequencyHz * timeSeconds) * voltageVolts) * 2 * Math.PI;

    expect(frequencyHz * timeSeconds).toBeLessThan(2 ** -1022);
    expect(voltageVolts * frequencyHz).toBe(Number.POSITIVE_INFINITY);
    expect(waveform.status, waveform.message).toBe("valid");
    expect(sampledVoltage).toBeDefined();
    expect((sampledVoltage ?? Number.NaN) / expectedVoltage).toBeCloseTo(1, 10);
  });

  it.each([
    ["ordinary voltage", 5, 1e-20],
    ["large voltage", 1e16, 1e-20],
  ])("retains capacitor current when a %s voltage change is below the voltage ULP", (_label, initialVoltageVolts, timeStepSeconds) => {
    const document: CircuitDocument = {
      title: "Capacitor voltage change below one ULP",
      parts: [
        part("capacitor", "capacitor", { capacitanceFarads: 1, initialVoltageVolts }),
        part("resistor", "resistor", { resistanceOhms: 1 }),
      ],
      wires: [
        wire("parallel-a", "capacitor", "a", "resistor", "a"),
        wire("parallel-b", "capacitor", "b", "resistor", "b"),
      ],
    };
    const waveform = simulateTransient(document, {
      durationSeconds: timeStepSeconds,
      timeStepSeconds,
    });
    const sample = waveform.samples.at(-1);
    const expectedCurrent = -initialVoltageVolts / (1 + timeStepSeconds);

    expect(waveform.status, waveform.message).toBe("valid");
    expect(sample?.parts.capacitor?.voltageVolts).toBe(initialVoltageVolts);
    expect(sample?.parts.capacitor?.currentAmps).toBeCloseTo(expectedCurrent, 5);
    expect(sample?.parts.capacitor?.terminalCurrents?.a).toBeCloseTo(expectedCurrent, 5);
    expect(sample?.parts.resistor?.currentAmps).toBeCloseTo(-expectedCurrent, 5);
  });

  it("keeps the polarity of a negative capacitor initial voltage in the Thevenin companion", () => {
    const document: CircuitDocument = {
      title: "Negative capacitor initial voltage",
      parts: [
        part("capacitor", "capacitor", { capacitanceFarads: 1, initialVoltageVolts: -5 }),
        part("resistor", "resistor", { resistanceOhms: 1 }),
      ],
      wires: [
        wire("parallel-a", "capacitor", "a", "resistor", "a"),
        wire("parallel-b", "capacitor", "b", "resistor", "b"),
      ],
    };
    const waveform = simulateTransient(document, {
      durationSeconds: 0.1,
      timeStepSeconds: 0.1,
    });
    const sample = waveform.samples.at(-1);

    expect(waveform.status, waveform.message).toBe("valid");
    expect(sample?.parts.capacitor?.voltageVolts).toBeCloseTo(-5 / 1.1, 12);
    expect(sample?.parts.capacitor?.currentAmps).toBeCloseTo(5 / 1.1, 12);
    expect(sample?.parts.resistor?.currentAmps).toBeCloseTo(-5 / 1.1, 12);
  });

  it("accepts a finite capacitor companion resistance when the unused inverse resistance overflows", () => {
    const document: CircuitDocument = {
      title: "Finite Thevenin companion at extreme capacitance",
      parts: [part("capacitor", "capacitor", { capacitanceFarads: Number.MAX_VALUE, initialVoltageVolts: 1 })],
      wires: [],
    };
    const waveform = simulateTransient(document, {
      durationSeconds: 1e-10,
      timeStepSeconds: 1e-10,
    });

    expect(waveform.status, waveform.message).toBe("valid");
    expect(waveform.samples).toHaveLength(2);
    expect(waveform.samples[1]?.parts.capacitor?.voltageVolts).toBe(1);
    expect(waveform.samples[1]?.parts.capacitor?.currentAmps).toBe(0);
    for (const sample of waveform.samples) {
      const reading = sample.parts.capacitor;
      expect(Number.isFinite(reading.voltageVolts)).toBe(true);
      expect(Number.isFinite(reading.currentAmps)).toBe(true);
      expect(Number.isFinite(reading.powerWatts)).toBe(true);
    }
  });

  it("keeps a finite charging current at the smallest positive time step", () => {
    const document: CircuitDocument = {
      title: "Minimum time step RC charging",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("capacitor", "capacitor", { capacitanceFarads: 1e-3 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-resistor", "source", "a", "resistor", "a"),
        wire("resistor-capacitor", "resistor", "b", "capacitor", "a"),
        wire("capacitor-ground", "capacitor", "b", "ground", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
      ],
    };
    const waveform = simulateTransient(document, {
      durationSeconds: Number.MIN_VALUE,
      timeStepSeconds: Number.MIN_VALUE,
    });
    const sample = waveform.samples.at(-1);
    const companionResistance = Number.MIN_VALUE / 1e-3;
    const expectedCurrent = 1 / (1000 + companionResistance);
    const expectedVoltage = expectedCurrent * companionResistance;

    expect(waveform.status, waveform.message).toBe("valid");
    expect(sample?.timeSeconds).toBe(Number.MIN_VALUE);
    expect(expectedVoltage).toBe(Number.MIN_VALUE);
    expect(sample?.parts.capacitor?.voltageVolts).toBe(expectedVoltage);
    expect(sample?.parts.capacitor?.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(sample?.parts.resistor?.currentAmps).toBeCloseTo(expectedCurrent, 12);
  });

  it("rejects accessor-backed input without invoking caller getters", () => {
    let optionReads = 0;
    const options = Object.defineProperty({ timeStepSeconds: 0.1 }, "durationSeconds", {
      get() {
        optionReads += 1;
        return 1;
      },
    });
    const optionResult = simulateTransient({ title: "empty", parts: [part("load", "resistor", { resistanceOhms: 1 })], wires: [] }, options as never);

    let partReads = 0;
    const source = part("source", "ac-source", { frequencyHz: 50 });
    Object.defineProperty(source, "voltageVolts", {
      get() {
        partReads += 1;
        return 1;
      },
    });
    const partResult = simulateTransient({ title: "accessor part", parts: [source], wires: [] }, {
      durationSeconds: 1,
      timeStepSeconds: 0.1,
    });

    expect(optionResult.status).toBe("invalid");
    expect(partResult.status).toBe("invalid");
    expect(optionReads).toBe(0);
    expect(partReads).toBe(0);
  });
});
