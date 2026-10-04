import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";

const frequencyHz = 60;
const sourceRmsVolts = 6;
const sourcePhaseDegrees = 23;
const sourceOffsetVolts = 2.5;
const samplesPerCycle = 200;
const cycles = 10;
const timeStepSeconds = 1 / (frequencyHz * samplesPerCycle);
const durationSeconds = cycles / frequencyHz;
// Exact transient histories grow with the step count, so long circuit comparisons need more time.
const longTransientTimeoutMs = 180_000;

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
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal },
    to: { partId: toPart, terminal: toTerminal },
  };
}

function seriesCircuit(reactiveParts: CircuitPart[]): CircuitDocument {
  const chain = [part("resistor", "resistor", { resistanceOhms: 100 }), ...reactiveParts];
  const parts = [
    part("source", "ac-source", {
      voltageVolts: sourceRmsVolts,
      frequencyHz,
      phaseDegrees: sourcePhaseDegrees,
      offsetVolts: sourceOffsetVolts,
    }),
    ...chain,
    part("ground", "ground"),
  ];
  const wires: CircuitWire[] = [wire("source-to-first", "source", "a", chain[0]!.id, "a")];
  for (let index = 0; index < chain.length - 1; index += 1) {
    wires.push(wire(`series-${index}`, chain[index]!.id, "b", chain[index + 1]!.id, "a"));
  }
  const last = chain.at(-1)!;
  wires.push(
    wire("last-to-source", last.id, "b", "source", "b"),
    wire("ground-to-source", "ground", "a", "source", "b"),
  );
  return { title: "AC steady-state cross-check", parts, wires };
}

function rcCircuit() {
  return seriesCircuit([part("capacitor", "capacitor", { capacitanceFarads: 100e-6 })]);
}

function rlCircuit() {
  return seriesCircuit([part("inductor", "inductor", { inductanceHenries: 0.1 })]);
}

function rlcCircuit() {
  return seriesCircuit([
    part("inductor", "inductor", { inductanceHenries: 0.1 }),
    part("capacitor", "capacitor", { capacitanceFarads: 100e-6 }),
  ]);
}

function multiplePhaseSourceCircuit(): CircuitDocument {
  return {
    title: "Two phase-shifted AC sources in series",
    parts: [
      part("source-a", "ac-source", {
        voltageVolts: 6,
        frequencyHz,
        phaseDegrees: 23,
        offsetVolts: 1,
      }),
      part("source-b", "ac-source", {
        voltageVolts: 4,
        frequencyHz,
        phaseDegrees: -41,
        offsetVolts: -0.5,
      }),
      part("resistor", "resistor", { resistanceOhms: 100 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-a-to-source-b", "source-a", "a", "source-b", "b"),
      wire("source-b-to-resistor", "source-b", "a", "resistor", "a"),
      wire("resistor-to-source-a", "resistor", "b", "source-a", "b"),
      wire("ground-to-source-a", "ground", "a", "source-a", "b"),
    ],
  };
}

function compareWithSteadyState(circuit: CircuitDocument, partIds: string[]) {
  const analysis = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz });
  const waveform = simulateTransient(circuit, { durationSeconds, timeStepSeconds });

  const firstStep = (cycles - 3) * samplesPerCycle;
  const finalStep = cycles * samplesPerCycle;
  const steadySamples = waveform.samples.slice(firstStep, finalStep);
  const comparisons: {
    partId: string;
    quantity: "voltage" | "current";
    hasReading: boolean;
    relativeMagnitudeError: number;
    phaseError: number;
  }[] = [];

  for (const partId of partIds) {
    const steadyReading = analysis.parts[partId];
    for (const quantity of ["voltage", "current"] as const) {
      const phasor = estimatedRmsPhasorFromSamples(steadySamples, partId, quantity);
      const expectedMagnitude = quantity === "voltage" ? steadyReading?.voltageVolts : steadyReading?.currentAmps;
      const expectedPhase = quantity === "voltage"
        ? steadyReading?.voltagePhaseDegrees
        : steadyReading?.currentPhaseDegrees;
      const actualMagnitude = Math.hypot(phasor.real, phasor.imaginary);
      const actualPhase = Math.atan2(phasor.imaginary, phasor.real) * 180 / Math.PI;
      const relativeMagnitudeError = expectedMagnitude === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(actualMagnitude - expectedMagnitude) / Math.max(expectedMagnitude, 1e-12);
      const phaseError = Math.abs(((actualPhase - expectedPhase + 540) % 360) - 180);

      comparisons.push({
        partId,
        quantity,
        hasReading: expectedMagnitude !== undefined && expectedPhase !== undefined,
        relativeMagnitudeError,
        phaseError,
      });
    }
  }
  return { analysis, waveform, steadySamples, comparisons };
}

function estimatedRmsPhasorFromSamples(
  samples: ReturnType<typeof simulateTransient>["samples"],
  partId: string,
  quantity: "voltage" | "current",
) {
  let cosineSum = 0;
  let sineSum = 0;
  for (const sample of samples) {
    const reading = sample.parts[partId];
    if (!reading) { return { real: Number.NaN, imaginary: Number.NaN }; }
    const value = quantity === "voltage" ? reading.voltageVolts : reading.currentAmps;
    const angle = 2 * Math.PI * frequencyHz * sample.timeSeconds;
    cosineSum += value * Math.cos(angle);
    sineSum += value * Math.sin(angle);
  }
  return {
    real: Math.SQRT2 * cosineSum / samples.length,
    imaginary: -Math.SQRT2 * sineSum / samples.length,
  };
}

describe("AC phasor and transient steady-state consistency", () => {
  it("uses catalog AC-source defaults in both the phasor and transient solvers", () => {
    const resistanceOhms = 100;
    const document: CircuitDocument = {
      title: "Default AC-source consistency",
      parts: [part("source", "ac-source"), part("resistor", "resistor", { resistanceOhms })],
      wires: [
        wire("source-to-load", "source", "a", "resistor", "a"),
        wire("load-to-source", "resistor", "b", "source", "b"),
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });
    const waveform = simulateTransient(document, { durationSeconds: 0.002, timeStepSeconds: 0.000_05 });

    expect(analysis.status, analysis.message).toBe("closed");
    expect(waveform.status, waveform.message).toBe("valid");
    expect(analysis.parts.source.voltageVolts).toBeCloseTo(5, 10);
    expect(analysis.parts.resistor.voltageVolts).toBeCloseTo(5, 10);
    expect(analysis.parts.resistor.currentAmps).toBeCloseTo(0.05, 10);
    expect(waveform.samples[0]?.parts.source?.voltageVolts).toBeCloseTo(5 * Math.SQRT2, 10);
    expect(waveform.samples[0]?.parts.resistor?.voltageVolts).toBeCloseTo(5 * Math.SQRT2, 10);
    expect(waveform.samples[0]?.parts.resistor?.currentAmps).toBeCloseTo(0.05 * Math.SQRT2, 10);
  });

  it("agrees for a series RC circuit", () => {
    const result = compareWithSteadyState(rcCircuit(), ["source", "resistor", "capacitor"]);
    expect(result.analysis.status, result.analysis.message).toBe("closed");
    expect(result.waveform.status, result.waveform.message).toBe("valid");
    expect(result.steadySamples).toHaveLength(3 * samplesPerCycle);
    for (const comparison of result.comparisons) {
      expect(comparison.hasReading, `${comparison.partId} ${comparison.quantity} reading`).toBe(true);
      expect(comparison.relativeMagnitudeError, `${comparison.partId} ${comparison.quantity} magnitude`).toBeLessThan(0.02);
      expect(comparison.phaseError, `${comparison.partId} ${comparison.quantity} phase`).toBeLessThan(1.5);
    }
  }, longTransientTimeoutMs);

  it("agrees for a series RL circuit", () => {
    const result = compareWithSteadyState(rlCircuit(), ["source", "resistor", "inductor"]);
    expect(result.analysis.status, result.analysis.message).toBe("closed");
    expect(result.waveform.status, result.waveform.message).toBe("valid");
    expect(result.steadySamples).toHaveLength(3 * samplesPerCycle);
    for (const comparison of result.comparisons) {
      expect(comparison.hasReading, `${comparison.partId} ${comparison.quantity} reading`).toBe(true);
      expect(comparison.relativeMagnitudeError, `${comparison.partId} ${comparison.quantity} magnitude`).toBeLessThan(0.02);
      expect(comparison.phaseError, `${comparison.partId} ${comparison.quantity} phase`).toBeLessThan(1.5);
    }
  }, longTransientTimeoutMs);

  it("agrees for a series RLC circuit", () => {
    const result = compareWithSteadyState(rlcCircuit(), ["source", "resistor", "inductor", "capacitor"]);
    expect(result.analysis.status, result.analysis.message).toBe("closed");
    expect(result.waveform.status, result.waveform.message).toBe("valid");
    expect(result.steadySamples).toHaveLength(3 * samplesPerCycle);
    for (const comparison of result.comparisons) {
      expect(comparison.hasReading, `${comparison.partId} ${comparison.quantity} reading`).toBe(true);
      expect(comparison.relativeMagnitudeError, `${comparison.partId} ${comparison.quantity} magnitude`).toBeLessThan(0.02);
      expect(comparison.phaseError, `${comparison.partId} ${comparison.quantity} phase`).toBeLessThan(1.5);
    }
  }, longTransientTimeoutMs);

  it("agrees for multiple same-frequency sources with different phases and DC offsets", () => {
    const result = compareWithSteadyState(multiplePhaseSourceCircuit(), ["source-a", "source-b", "resistor"]);
    expect(result.analysis.status, result.analysis.message).toBe("closed");
    expect(result.waveform.status, result.waveform.message).toBe("valid");
    for (const comparison of result.comparisons) {
      expect(comparison.hasReading, `${comparison.partId} ${comparison.quantity} reading`).toBe(true);
      expect(comparison.relativeMagnitudeError, `${comparison.partId} ${comparison.quantity} magnitude`).toBeLessThan(0.02);
      expect(comparison.phaseError, `${comparison.partId} ${comparison.quantity} phase`).toBeLessThan(1.5);
    }

    const resistance = 100;
    let meanCurrent = 0;
    let meanResistorPower = 0;
    let meanSourcePower = 0;
    for (const sample of result.steadySamples) {
      meanCurrent += sample.parts.resistor!.currentAmps / result.steadySamples.length;
      meanResistorPower += sample.parts.resistor!.powerWatts / result.steadySamples.length;
      meanSourcePower += (sample.parts["source-a"]!.powerWatts + sample.parts["source-b"]!.powerWatts) /
        result.steadySamples.length;
    }
    const acResistorLoss = meanResistorPower - meanCurrent ** 2 * resistance;
    expect(acResistorLoss).toBeCloseTo(result.analysis.parts.resistor!.powerWatts, 8);
    const acSourceDelivery = result.analysis.parts["source-a"]!.powerWatts +
      result.analysis.parts["source-b"]!.powerWatts;
    expect(Math.abs(acSourceDelivery - result.analysis.parts.resistor!.powerWatts)).toBeLessThan(1e-8);
    expect(Math.abs(meanSourcePower + meanResistorPower)).toBeLessThan(1e-8);
  }, longTransientTimeoutMs);
});
