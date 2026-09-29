import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { simulateTransient } from "../transient-solver.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  label: id,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: "a" | "b",
  toPart: string,
  toTerminal: "a" | "b",
): CircuitWire => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function estimatePhasor(
  samples: ReturnType<typeof simulateTransient>["samples"],
  partId: string,
  quantity: "voltage" | "current",
  frequencyHz: number,
) {
  let real = 0;
  let imaginary = 0;
  for (const sample of samples) {
    const reading = sample.parts[partId];
    if (!reading) { return { real: Number.NaN, imaginary: Number.NaN }; }
    const value = quantity === "voltage" ? reading.voltageVolts : reading.currentAmps;
    const angle = 2 * Math.PI * frequencyHz * sample.timeSeconds;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  return {
    real: Math.SQRT2 * real / samples.length,
    imaginary: Math.SQRT2 * imaginary / samples.length,
  };
}

function readingPhasor(magnitude: number, phaseDegrees: number) {
  const phase = phaseDegrees * Math.PI / 180;
  return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
}

describe("AC steady-state and transient multitone consistency", () => {
  it("recovers each source-frequency phasor from a two-frequency transient", () => {
    const targetFrequencyHz = 10;
    const otherFrequencyHz = 15;
    const samplesPerSecond = 600;
    const document: CircuitDocument = {
      title: "異周波数の交流源を含む直列回路",
      parts: [
        part("source-10", "ac-source", {
          voltageVolts: 6,
          frequencyHz: targetFrequencyHz,
          phaseDegrees: 23,
          offsetVolts: 1.5,
        }),
        part("source-15", "ac-source", {
          voltageVolts: 4,
          frequencyHz: otherFrequencyHz,
          phaseDegrees: -41,
          offsetVolts: -0.5,
        }),
        part("resistor", "resistor", { resistanceOhms: 100 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("series-sources", "source-10", "a", "source-15", "b"),
        wire("source-load", "source-15", "a", "resistor", "a"),
        wire("load-return", "resistor", "b", "source-10", "b"),
        wire("ground-return", "ground", "a", "source-10", "b"),
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: targetFrequencyHz });
    const waveform = simulateTransient(document, {
      durationSeconds: 1,
      timeStepSeconds: 1 / samplesPerSecond,
    });
    const samples = waveform.samples.slice(0, samplesPerSecond);

    expect(analysis.status, analysis.message).toBe("closed");
    expect(waveform.status, waveform.message).toBe("valid");
    expect(samples).toHaveLength(samplesPerSecond);
    for (const partId of ["source-10", "source-15", "resistor"]) {
      for (const quantity of ["voltage", "current"] as const) {
        const actual = estimatePhasor(samples, partId, quantity, targetFrequencyHz);
        const magnitude = quantity === "voltage"
          ? analysis.parts[partId]?.voltageVolts
          : analysis.parts[partId]?.currentAmps;
        const phase = quantity === "voltage"
          ? analysis.parts[partId]?.voltagePhaseDegrees
          : analysis.parts[partId]?.currentPhaseDegrees;
        expect(magnitude, `${partId} ${quantity} magnitude`).toBeDefined();
        expect(phase, `${partId} ${quantity} phase`).toBeDefined();
        const expected = readingPhasor(magnitude ?? Number.NaN, phase ?? Number.NaN);
        expect(Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary),
          `${partId} ${quantity} phasor`).toBeLessThan(1e-9);
      }
    }
  });
});
