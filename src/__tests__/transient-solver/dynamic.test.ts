import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function part(id: string, kind: CircuitPartKind, properties: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(
  id: string,
  fromPart: string,
  fromTerminal: "a" | "b",
  toPart: string,
  toTerminal: "a" | "b",
): CircuitWire {
  return { id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } };
}

describe("transient independent dynamic audits", () => {
  it("redistributes initial parallel-capacitor current through a multi-link tree while preserving node KCL", () => {
    const capacitances = [1e-6, 2e-6, 3e-6];
    const resistance = 3000;
    const initialVoltage = 0.2;
    const sourceVoltage = 1;
    const totalCurrent = (sourceVoltage - initialVoltage) / resistance;
    const document: CircuitDocument = {
      title: "Three parallel capacitors through two switches",
      parts: [
        part("source", "battery", { voltageVolts: sourceVoltage }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        ...capacitances.map((capacitanceFarads, index) => part(`c${index + 1}`, "capacitor", {
          capacitanceFarads,
          initialVoltageVolts: initialVoltage,
        })),
        part("link1", "switch", { initiallyClosed: true }),
        part("link2", "switch", { initiallyClosed: true }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-resistor", "source", "a", "resistor", "a"),
        wire("resistor-c1", "resistor", "b", "c1", "a"),
        wire("c1-link1", "c1", "a", "link1", "a"),
        wire("link1-c2", "link1", "b", "c2", "a"),
        wire("c2-link2", "c2", "a", "link2", "a"),
        wire("link2-c3", "link2", "b", "c3", "a"),
        wire("c1-ground", "c1", "b", "ground", "a"),
        wire("c2-ground", "c2", "b", "ground", "a"),
        wire("c3-ground", "c3", "b", "ground", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
      ],
    };

    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
    const initial = result.samples[0]?.parts;
    const currentAt = (partId: string, terminal: "a" | "b") =>
      initial?.[partId]?.terminalCurrents?.[terminal] ?? Number.NaN;
    expect(result.status, result.message).toBe("valid");

    for (const [index, capacitanceFarads] of capacitances.entries()) {
      expect(initial?.[`c${index + 1}`]?.currentAmps).toBeCloseTo(
        totalCurrent * capacitanceFarads / capacitances.reduce((sum, value) => sum + value, 0),
        12,
      );
    }
    expect(initial?.link1?.currentAmps).toBeCloseTo(totalCurrent * 5 / 6, 12);
    expect(initial?.link2?.currentAmps).toBeCloseTo(totalCurrent / 2, 12);
    expect(currentAt("resistor", "b") + currentAt("c1", "a") + currentAt("link1", "a"))
      .toBeCloseTo(0, 12);
    expect(currentAt("link1", "b") + currentAt("c2", "a") + currentAt("link2", "a"))
      .toBeCloseTo(0, 12);
    expect(currentAt("link2", "b") + currentAt("c3", "a")).toBeCloseTo(0, 12);
  });

  it("matches the backward-Euler recurrence for an AC-driven RC circuit with a short final interval", () => {
    const resistance = 470;
    const capacitance = 22e-6;
    const rms = 3.5;
    const frequency = 73;
    const phaseDegrees = -31;
    const offset = 0.4;
    const initialVoltage = -0.2;
    const duration = 0.003;
    const requestedStep = 0.0007;
    const document: CircuitDocument = {
      title: "AC RC backward-Euler oracle",
      parts: [
        part("source", "ac-source", {
          voltageVolts: rms,
          frequencyHz: frequency,
          phaseDegrees,
          offsetVolts: offset,
        }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("capacitor", "capacitor", {
          capacitanceFarads: capacitance,
          initialVoltageVolts: initialVoltage,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-resistor", "source", "a", "resistor", "a"),
        wire("resistor-capacitor", "resistor", "b", "capacitor", "a"),
        wire("capacitor-ground", "capacitor", "b", "ground", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
      ],
    };

    const result = simulateTransient(document, { durationSeconds: duration, timeStepSeconds: requestedStep });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.0007, 0.0014, 0.0021, 0.0028, duration]);

    let previousVoltage = initialVoltage;
    let previousTime = 0;
    for (const sample of result.samples.slice(1)) {
      const dt = sample.timeSeconds - previousTime;
      const sourceVoltage = offset + Math.SQRT2 * rms *
        Math.cos(2 * Math.PI * frequency * sample.timeSeconds + phaseDegrees * Math.PI / 180);
      const ratio = dt / (resistance * capacitance);
      const expectedVoltage = (previousVoltage + ratio * sourceVoltage) / (1 + ratio);
      const expectedCurrent = capacitance * (expectedVoltage - previousVoltage) / dt;

      expect(sample.parts.source?.voltageVolts).toBeCloseTo(sourceVoltage, 11);
      expect(sample.parts.capacitor?.voltageVolts).toBeCloseTo(expectedVoltage, 11);
      expect(sample.parts.capacitor?.currentAmps).toBeCloseTo(expectedCurrent, 11);
      expect(sample.parts.resistor?.currentAmps).toBeCloseTo(expectedCurrent, 11);
      expect(sample.parts.source!.powerWatts + sample.parts.resistor!.powerWatts +
        sample.parts.capacitor!.powerWatts).toBeCloseTo(0, 11);

      previousVoltage = expectedVoltage;
      previousTime = sample.timeSeconds;
    }
  });

  it("matches AC-driven Shockley diode and capacitor implicit steps and conserves node current", () => {
    const rmsVoltage = 3;
    const frequencyHz = 50;
    const phaseDegrees = 12;
    const offsetVolts = 0.1;
    const resistance = 1000;
    const capacitance = 1e-6;
    const timeStep = 0.005;
    const duration = 0.02;
    const saturationCurrent = 1e-12;
    const thermalVoltage = 0.025_85;
    const document: CircuitDocument = {
      title: "AC diode capacitor implicit-step oracle",
      parts: [
        part("source", "ac-source", {
          voltageVolts: rmsVoltage,
          frequencyHz,
          phaseDegrees,
          offsetVolts,
        }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("diode", "diode", { saturationCurrentAmps: saturationCurrent, emissionCoefficient: 1 }),
        part("capacitor", "capacitor", { capacitanceFarads: capacitance, initialVoltageVolts: 0 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-resistor", "source", "a", "resistor", "a"),
        wire("resistor-diode", "resistor", "b", "diode", "a"),
        wire("resistor-capacitor", "resistor", "b", "capacitor", "a"),
        wire("diode-ground", "diode", "b", "ground", "a"),
        wire("capacitor-ground", "capacitor", "b", "ground", "a"),
        wire("source-ground", "source", "b", "ground", "a"),
      ],
    };

    const result = simulateTransient(document, {
      durationSeconds: duration,
      timeStepSeconds: timeStep,
    });
    expect(result.status, result.message).toBe("valid");

    let previousVoltage = 0;
    for (const sample of result.samples.slice(1)) {
      const sourceVoltage = offsetVolts + Math.SQRT2 * rmsVoltage *
        Math.cos(2 * Math.PI * frequencyHz * sample.timeSeconds + phaseDegrees * Math.PI / 180);
      let low = Math.min(sourceVoltage, previousVoltage) - 1;
      let high = Math.max(sourceVoltage, previousVoltage) + 1;
      for (let iteration = 0; iteration < 100; iteration += 1) {
        const voltage = (low + high) / 2;
        const diodeCurrent = saturationCurrent * Math.expm1(voltage / thermalVoltage);
        const capacitorCurrent = capacitance * (voltage - previousVoltage) / timeStep;
        const residual = (sourceVoltage - voltage) / resistance - diodeCurrent - capacitorCurrent;
        if (residual > 0) { low = voltage; }
        else { high = voltage; }
      }
      const expectedVoltage = (low + high) / 2;
      const expectedDiodeCurrent = saturationCurrent * Math.expm1(expectedVoltage / thermalVoltage);
      const expectedCapacitorCurrent = capacitance * (expectedVoltage - previousVoltage) / timeStep;
      const readings = sample.parts;

      expect(readings.source?.voltageVolts).toBeCloseTo(sourceVoltage, 11);
      expect(readings.capacitor?.voltageVolts).toBeCloseTo(expectedVoltage, 9);
      expect(readings.capacitor?.currentAmps).toBeCloseTo(expectedCapacitorCurrent, 9);
      expect(readings.diode?.currentAmps).toBeCloseTo(expectedDiodeCurrent, 9);
      expect(readings.resistor?.currentAmps).toBeCloseTo(expectedDiodeCurrent + expectedCapacitorCurrent, 9);
      expect(readings.resistor!.terminalCurrents!.b! + readings.diode!.terminalCurrents!.a! +
        readings.capacitor!.terminalCurrents!.a!).toBeCloseTo(0, 9);
      expect(readings.source!.powerWatts + readings.resistor!.powerWatts + readings.diode!.powerWatts +
        readings.capacitor!.powerWatts).toBeCloseTo(0, 9);

      previousVoltage = expectedVoltage;
    }
  });
});
