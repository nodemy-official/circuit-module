import { describe, expect, it } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function source(id: string, frequencyHz: number, phaseDegrees = 0, voltageVolts = 1): CircuitPart {
  return { id, kind: "ac-source", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults,
    frequencyHz, phaseDegrees, voltageVolts };
}

function parallel(parts: CircuitPart[]): CircuitDocument {
  return { title: "Ideal waveform constraints", parts, wires: parts.slice(1).flatMap((part, index) =>
    (["a", "b"] as const).map((terminal) => ({ id: `${index}-${terminal}`,
      from: { partId: parts[0]!.id, terminal }, to: { partId: part.id, terminal } }))) };
}

function rotatedTriangle(rotation: number, reversed: boolean): CircuitDocument {
  const parts = [source("one", 1, rotation - 60), source("two", 1, rotation + 60), source("three", 1, rotation),
    { id: "load", kind: "resistor" as const, x: 0, y: 0, ...circuitPartCatalog.resistor.defaults, resistanceOhms: 100 }];
  parts[0]!.offsetVolts = 1;
  parts[1]!.offsetVolts = 2;
  parts[2]!.offsetVolts = 3;
  return { title: "Exact trigonometric identity", parts: reversed ? parts.reverse() : parts,
    wires: [
      { id: "mid", from: { partId: "one", terminal: "b" }, to: { partId: "two", terminal: "a" } },
      { id: "top", from: { partId: "one", terminal: "a" }, to: { partId: "three", terminal: "a" } },
      { id: "bottom", from: { partId: "two", terminal: "b" }, to: { partId: "three", terminal: "b" } },
      { id: "load-top", from: { partId: "load", terminal: "a" }, to: { partId: "three", terminal: "a" } },
      { id: "load-bottom", from: { partId: "load", terminal: "b" }, to: { partId: "three", terminal: "b" } },
    ] };
}

describe("continuous ideal transient waveform constraints", () => {
  it.each([false, true])("rejects different frequencies even when voltage and first derivative agree at all samples (reversed %s)", (reversed) => {
    const parts = [source("one", 1), source("two", 2)];
    const result = simulateTransient(parallel(reversed ? parts.reverse() : parts), {
      durationSeconds: 2, timeStepSeconds: 1,
    });
    // At integer seconds both cosine waves equal sqrt(2) and both slopes
    // vanish, but at t=1/2 their voltages have opposite signs.
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it("rejects a shorted AC source even when every sampled voltage is zero", () => {
    const document: CircuitDocument = { title: "Shorted sine wave", parts: [source("s", 1, 90)],
      wires: [{ id: "short", from: { partId: "s", terminal: "a" }, to: { partId: "s", terminal: "b" } }] };
    expect(simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 }).status).toBe("invalid");
  });

  it.each([false, true])("retains compatible redundant sources and the capacitor derivative (reversed %s)", (reversed) => {
    const sources = [source("first", 1, 90), source("second", 1, 450)];
    const capacitor: CircuitPart = { id: "c", kind: "capacitor", x: 0, y: 0,
      ...circuitPartCatalog.capacitor.defaults, capacitanceFarads: 1, initialVoltageVolts: 0 };
    const result = simulateTransient(parallel([...(reversed ? sources.reverse() : sources), capacitor]), {
      durationSeconds: 1, timeStepSeconds: 0.5,
    });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]!.parts.c!.currentAmps / (-2 * Math.PI * Math.SQRT2)).toBeCloseTo(1, 14);
  });

  it("retains a consistent source triangle for the entire waveform", () => {
    const document: CircuitDocument = { title: "Consistent source triangle",
      parts: [source("one", 1, 37), source("two", 1, 37, 2), source("three", 1, 37, 3)],
      wires: [
        { id: "mid", from: { partId: "one", terminal: "b" }, to: { partId: "two", terminal: "a" } },
        { id: "top", from: { partId: "one", terminal: "a" }, to: { partId: "three", terminal: "a" } },
        { id: "bottom", from: { partId: "two", terminal: "b" }, to: { partId: "three", terminal: "b" } },
      ] };
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      const expected = 3 * Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + 37 * Math.PI / 180);
      expect(sample.parts.three!.voltageVolts).toBeCloseTo(expected, 13);
    }
  });

  for (const startFromOperatingPoint of [false, true]) {
    it.each([0, 37, 90].flatMap((rotation) => [false, true].map((reversed) => ({ rotation, reversed }))))(
      `preserves exact phase identities across every sample (rotation=$rotation, reversed=$reversed, operating point=${startFromOperatingPoint})`,
      ({ rotation, reversed }) => {
        // cos(x-60 degrees) + cos(x+60 degrees) = cos(x). Independent
        // binary64 evaluations can disagree even though the identity is exact.
        const result = simulateTransient(rotatedTriangle(rotation, reversed), {
          durationSeconds: 0.5, timeStepSeconds: 0.125, startFromOperatingPoint,
        });
        expect(result.status, result.message).toBe("valid");
        expect(result.samples).toHaveLength(5);
        for (const sample of result.samples) {
          const voltage = 3 + Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + rotation * Math.PI / 180);
          expect(Math.abs((sample.parts.load!.voltageVolts - voltage) / voltage)).toBeLessThan(2e-14);
          expect(Math.abs((sample.parts.load!.currentAmps - voltage / 100) / (voltage / 100))).toBeLessThan(2e-14);
        }
      },
    );
  }

  it.each([Number.MIN_VALUE, Number.EPSILON])("rejects an exact nonzero DC mismatch instead of absorbing it as trig rounding (%s V)", (offset) => {
    const document = rotatedTriangle(0, false);
    for (const part of document.parts) {
      if (part.kind === "ac-source") { part.offsetVolts = part.id === "three" ? offset : 0; }
    }
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });
});
