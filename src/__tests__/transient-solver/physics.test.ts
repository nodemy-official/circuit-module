import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function part(
  id: string,
  kind: CircuitPartKind,
  properties: Partial<CircuitPart> = {},
): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(
  id: string,
  fromPart: string,
  fromTerminal: "a" | "b",
  toPart: string,
  toTerminal: "a" | "b",
): CircuitWire {
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal },
    to: { partId: toPart, terminal: toTerminal },
  };
}

describe("transient analytical physics", () => {
  it("approaches the closed-form RC charging voltage", () => {
    const sourceVoltage = 5;
    const resistance = 2000;
    const capacitance = 50e-6;
    const timeConstant = resistance * capacitance;
    const duration = 5 * timeConstant;
    const document: CircuitDocument = {
      title: "RC charging analytical check",
      parts: [
        part("source", "battery", { voltageVolts: sourceVoltage }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("capacitor", "capacitor", { capacitanceFarads: capacitance, initialVoltageVolts: 0 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-r", "source", "a", "resistor", "a"),
        wire("wire-r-c", "resistor", "b", "capacitor", "a"),
        wire("wire-c-ground", "capacitor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: duration,
      timeStepSeconds: timeConstant / 200,
    });

    expect(result.status, result.message).toBe("valid");
    const exactVoltage = sourceVoltage * (1 - Math.exp(-duration / timeConstant));
    const simulatedVoltage = result.samples.at(-1)?.parts.capacitor?.voltageVolts ?? Number.NaN;
    expect(result.samples.at(-1)?.timeSeconds).toBe(duration);
    expect(Math.abs(simulatedVoltage - exactVoltage)).toBeLessThan(0.001);
  });

  it("approaches the closed-form RL natural decay while preserving the initial current", () => {
    const resistance = 8;
    const inductance = 0.4;
    const initialCurrent = 0.75;
    const timeConstant = inductance / resistance;
    const duration = 5 * timeConstant;
    const document: CircuitDocument = {
      title: "RL natural response analytical check",
      parts: [
        part("inductor", "inductor", { inductanceHenries: inductance, initialCurrentAmps: initialCurrent }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("wire-a", "inductor", "a", "resistor", "a"),
        wire("wire-b", "inductor", "b", "resistor", "b"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: duration,
      timeStepSeconds: timeConstant / 200,
    });

    expect(result.status, result.message).toBe("valid");
    const exactCurrent = initialCurrent * Math.exp(-duration / timeConstant);
    const simulatedCurrent = result.samples.at(-1)?.parts.inductor?.currentAmps ?? Number.NaN;
    expect(result.samples[0]?.parts.inductor?.currentAmps).toBe(initialCurrent);
    expect(result.samples.at(-1)?.timeSeconds).toBe(duration);
    expect(Math.abs(simulatedCurrent - exactCurrent)).toBeLessThan(0.0001);
  });

  it.each([
    ["same orientation", "a", "b", 0, 0, 3, 6],
    ["reversed second inductor", "b", "a", 0, 0, 3, -6],
    ["same orientation with stored current", "a", "b", 1, 1, 3, 6],
    ["reversed second inductor with stored current", "b", "a", 1, -1, 3, -6],
  ] as const)("shares a series-source voltage across inductors by L ratio (%s)", (
    polarity,
    secondInductorFrom,
    secondInductorTo,
    firstInitialCurrent,
    secondInitialCurrent,
    firstVoltage,
    secondVoltage,
  ) => {
    const document: CircuitDocument = {
      title: `Series inductors (${polarity})`,
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("first", "inductor", { inductanceHenries: 1, initialCurrentAmps: firstInitialCurrent }),
        part("second", "inductor", { inductanceHenries: 2, initialCurrentAmps: secondInitialCurrent }),
      ],
      wires: [
        wire("wire-source-first", "source", "a", "first", "a"),
        wire("wire-first-second", "first", "b", "second", secondInductorFrom),
        wire("wire-second-source", "second", secondInductorTo, "source", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.first?.currentAmps).toBe(firstInitialCurrent);
    expect(result.samples[0]?.parts.second?.currentAmps).toBe(secondInitialCurrent);
    expect(result.samples[0]?.parts.first?.voltageVolts).toBeCloseTo(firstVoltage, 10);
    expect(result.samples[0]?.parts.second?.voltageVolts).toBeCloseTo(secondVoltage, 10);
  });

  it("rejects inconsistent initial currents in a series inductor path", () => {
    const document: CircuitDocument = {
      title: "Series inductors with conflicting initial currents",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("first", "inductor", { inductanceHenries: 1, initialCurrentAmps: 1 }),
        part("second", "inductor", { inductanceHenries: 2, initialCurrentAmps: 0 }),
      ],
      wires: [
        wire("wire-source-first", "source", "a", "first", "a"),
        wire("wire-first-second", "first", "b", "second", "a"),
        wire("wire-second-source", "second", "b", "source", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("初期状態");
  });

  it("rejects an extreme finite inductor-current imbalance before solving", () => {
    const document: CircuitDocument = {
      title: "Extreme conflicting parallel inductor currents",
      parts: [
        part("large-positive", "inductor", { inductanceHenries: 1, initialCurrentAmps: 1e308 }),
        part("small-mismatch", "inductor", { inductanceHenries: 1, initialCurrentAmps: 1e296 }),
        part("large-negative", "inductor", { inductanceHenries: 1, initialCurrentAmps: -1e308 }),
      ],
      wires: [
        wire("wire-a-1", "large-positive", "a", "small-mismatch", "a"),
        wire("wire-a-2", "small-mismatch", "a", "large-negative", "a"),
        wire("wire-b-1", "large-positive", "b", "small-mismatch", "b"),
        wire("wire-b-2", "small-mismatch", "b", "large-negative", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("初期電流と電流源の指定値が接続点の電流のつり合いを満たしません");
  });

  it("uses the DC operating-point current instead of the stored initial current when requested", () => {
    const document: CircuitDocument = {
      title: "Inductor initialized from DC operating point",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("resistor", "resistor", { resistanceOhms: 3 }),
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 100 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-resistor", "source", "a", "resistor", "a"),
        wire("wire-resistor-inductor", "resistor", "b", "inductor", "a"),
        wire("wire-inductor-ground", "inductor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      startFromOperatingPoint: true,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.inductor?.currentAmps).toBeCloseTo(3, 10);
  });

  it("solves multiple parallel inductor branches independently at the initial instant", () => {
    const document: CircuitDocument = {
      title: "Parallel inductors across a DC source",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("first", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0.25 }),
        part("second", "inductor", { inductanceHenries: 2, initialCurrentAmps: -0.5 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-first", "source", "a", "first", "a"),
        wire("wire-source-second", "source", "a", "second", "a"),
        wire("wire-first-ground", "first", "b", "ground", "a"),
        wire("wire-second-ground", "second", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const timeStep = 0.01;
    const result = simulateTransient(document, { durationSeconds: timeStep, timeStepSeconds: timeStep });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.first?.currentAmps).toBe(0.25);
    expect(result.samples[0]?.parts.second?.currentAmps).toBe(-0.5);
    expect(result.samples[0]?.parts.first?.voltageVolts).toBeCloseTo(9, 10);
    expect(result.samples[0]?.parts.second?.voltageVolts).toBeCloseTo(9, 10);
    expect(result.samples[1]?.parts.first?.currentAmps).toBeCloseTo(0.34, 10);
    expect(result.samples[1]?.parts.second?.currentAmps).toBeCloseTo(-0.455, 10);
  });

  it("matches backward-Euler LC energy decay and keeps the source-free loop in KCL", () => {
    const capacitance = 1;
    const inductance = 1;
    const initialVoltage = 1;
    const timeStep = 0.1;
    const steps = 10;
    const document: CircuitDocument = {
      title: "Source-free LC loop",
      parts: [
        part("inductor", "inductor", { inductanceHenries: inductance, initialCurrentAmps: 0 }),
        part("capacitor", "capacitor", { capacitanceFarads: capacitance, initialVoltageVolts: initialVoltage }),
      ],
      wires: [
        wire("wire-l-c", "inductor", "b", "capacitor", "a"),
        wire("wire-c-l", "capacitor", "b", "inductor", "a"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: steps * timeStep,
      timeStepSeconds: timeStep,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(steps + 1);
    for (const [index, sample] of result.samples.entries()) {
      const voltage = sample.parts.capacitor?.voltageVolts ?? Number.NaN;
      const current = sample.parts.inductor?.currentAmps ?? Number.NaN;
      const energy = 0.5 * capacitance * voltage ** 2 + 0.5 * inductance * current ** 2;
      const expectedEnergy = 0.5 / (1 + timeStep ** 2) ** index;
      const inductorA = sample.parts.inductor?.terminalCurrents?.a ?? Number.NaN;
      const inductorB = sample.parts.inductor?.terminalCurrents?.b ?? Number.NaN;
      const capacitorA = sample.parts.capacitor?.terminalCurrents?.a ?? Number.NaN;
      const capacitorB = sample.parts.capacitor?.terminalCurrents?.b ?? Number.NaN;

      expect(Number.isFinite(sample.timeSeconds)).toBe(true);
      expect(Number.isFinite(voltage)).toBe(true);
      expect(Number.isFinite(current)).toBe(true);
      expect(Number.isFinite(sample.parts.capacitor?.powerWatts)).toBe(true);
      expect(Number.isFinite(sample.parts.inductor?.powerWatts)).toBe(true);
      expect(energy).toBeCloseTo(expectedEnergy, 12);
      expect(inductorA + capacitorB).toBeCloseTo(0, 12);
      expect(inductorB + capacitorA).toBeCloseTo(0, 12);
    }
  });

  it.each([
    ["forward", "a", "b", 2],
    ["reversed", "b", "a", -2],
  ] as const)("accepts a %s current-source and inductor loop with matching initial current", (
    polarity,
    sourceToInductorTerminal,
    inductorToSourceTerminal,
    initialCurrent,
  ) => {
    const currentAmps = 2;
    const document: CircuitDocument = {
      title: `Current source and inductor loop (${polarity})`,
      parts: [
        part("source", "current-source", { currentAmps }),
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: initialCurrent }),
      ],
      wires: [
        wire("wire-source-inductor", "source", "b", "inductor", sourceToInductorTerminal),
        wire("wire-inductor-source", "inductor", inductorToSourceTerminal, "source", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.inductor?.currentAmps).toBe(initialCurrent);
    expect(result.samples[0]?.parts.inductor?.voltageVolts).toBeCloseTo(0, 12);
    expect(result.samples.at(-1)?.parts.inductor?.currentAmps).toBeCloseTo(initialCurrent, 12);
  });

  it.each([
    ["regular current", 2, 1],
    ["tiny current", 1e-15, 0],
  ] as const)("rejects a current-source and inductor loop with conflicting %s", (_label, currentAmps, initialCurrent) => {
    const document: CircuitDocument = {
      title: "Inconsistent current-source and inductor loop",
      parts: [
        part("source", "current-source", { currentAmps }),
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: initialCurrent }),
      ],
      wires: [
        wire("wire-source-inductor", "source", "b", "inductor", "a"),
        wire("wire-inductor-source", "inductor", "b", "source", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.01 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("初期状態");
  });

  it("preserves nonzero initial inductor voltage in a current-source and RL parallel circuit", () => {
    const sourceCurrent = 2;
    const initialInductorCurrent = 1;
    const resistance = 10;
    const inductance = 1;
    const timeStep = 0.01;
    const document: CircuitDocument = {
      title: "Current source with parallel RL branches",
      parts: [
        part("source", "current-source", { currentAmps: sourceCurrent }),
        part("inductor", "inductor", {
          inductanceHenries: inductance,
          initialCurrentAmps: initialInductorCurrent,
        }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("wire-source-inductor", "source", "b", "inductor", "a"),
        wire("wire-inductor-source", "inductor", "b", "source", "a"),
        wire("wire-resistor-inductor-a", "resistor", "a", "inductor", "a"),
        wire("wire-resistor-inductor-b", "resistor", "b", "inductor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: timeStep, timeStepSeconds: timeStep });
    const expectedNextCurrent = (initialInductorCurrent +
      (resistance * timeStep / inductance) * sourceCurrent) /
      (1 + resistance * timeStep / inductance);

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.inductor?.currentAmps).toBe(initialInductorCurrent);
    expect(result.samples[0]?.parts.inductor?.voltageVolts).toBeCloseTo(
      resistance * (sourceCurrent - initialInductorCurrent),
      10,
    );
    expect(result.samples[1]?.parts.inductor?.currentAmps).toBeCloseTo(expectedNextCurrent, 10);
  });

  it("ties only the inductor causing a missing-return-path issue in a mixed document", () => {
    const resistance = 10;
    const timeStep = 0.01;
    const document: CircuitDocument = {
      title: "Independent inductor loops with different initial states",
      parts: [
        part("source", "current-source", { currentAmps: 2 }),
        part("tied-inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 2 }),
        part("decay-inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 1 }),
        part("decay-resistor", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("wire-source-inductor", "source", "b", "tied-inductor", "a"),
        wire("wire-inductor-source", "tied-inductor", "b", "source", "a"),
        wire("wire-decay-a", "decay-inductor", "a", "decay-resistor", "a"),
        wire("wire-decay-b", "decay-inductor", "b", "decay-resistor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: timeStep, timeStepSeconds: timeStep });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts["tied-inductor"]?.currentAmps).toBe(2);
    expect(result.samples[0]?.parts["tied-inductor"]?.voltageVolts).toBeCloseTo(0, 12);
    expect(result.samples[0]?.parts["decay-inductor"]?.currentAmps).toBe(1);
    expect(result.samples[0]?.parts["decay-inductor"]?.voltageVolts).toBeCloseTo(-resistance, 12);
    expect(result.samples[1]?.parts["tied-inductor"]?.currentAmps).toBeCloseTo(2, 12);
    expect(result.samples[1]?.parts["decay-inductor"]?.currentAmps).toBeCloseTo(
      1 / (1 + resistance * timeStep),
      12,
    );
  });
});
