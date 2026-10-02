import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { nextDown, nextUp } from "../helpers/numeric-oracle.js";

// Both phases, including phase + 180, are exactly representable. Moving the
// first phase down one ULP from 44.999 would round its opposite phase instead.
const boundaryPhase = 44.998_999_595_642_09;

function cancelledSlopeCircuit(phase: number) {
  const cosine = Math.SQRT2 * Math.cos(phase * (Math.PI / 180));
  return createCircuitFromSpecs([
    ["first", "ac-source", ["v", "m"], { voltageVolts: 3, frequencyHz: 1, phaseDegrees: phase }],
    ["third", "ac-source", ["m", "g"], { voltageVolts: 1, frequencyHz: 3, phaseDegrees: phase + 180 }],
    ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 2 * cosine }],
  ], "AC phase basis continuity");
}

function cancelledSlopeCurrent(phase: number, start: number, end: number) {
  // Independent triple-angle identity for the same binary64 initial phase
  // coefficients. This separates existing trig error from a model switch.
  const cosine = Math.SQRT2 * Math.cos(phase * (Math.PI / 180));
  const sine = Math.SQRT2 * Math.sin(phase * (Math.PI / 180));
  const dt = end - start;
  const midpoint = Math.PI * (end + start);
  const u0 = Math.sin(Math.PI * start) ** 2;
  const u1 = Math.sin(Math.PI * end) ** 2;
  const s0 = Math.sin(2 * Math.PI * start);
  const s1 = Math.sin(2 * Math.PI * end);
  const du = Math.sin(midpoint) * Math.sin(Math.PI * dt);
  const ds = 2 * Math.cos(midpoint) * Math.sin(Math.PI * dt);
  return (cosine * du * (12 - 48 * (u1 + u0) + 32 * (u1 * u1 + u0 * u1 + u0 * u0)) -
    4 * sine * ds * (s1 * s1 + s0 * s1 + s0 * s0)) / dt;
}

describe("AC waveform model continuity", () => {
  it.each([1, 5].flatMap((divisions) => [-1, 1].map((side) => ({ divisions, side }))))(
    "rejects an adjacent initial voltage at the model boundary with $divisions intervals, side=$side",
    ({ divisions, side }) => {
      const document = cancelledSlopeCircuit(boundaryPhase);
      const capacitor = document.parts.find((part) => part.id === "c")!;
      const initial = capacitor.initialVoltageVolts!;
      capacitor.initialVoltageVolts = side < 0 ? nextDown(initial) : nextUp(initial);
      const result = simulateTransient(document, { durationSeconds: 1e-8, timeStepSeconds: 1e-8 / divisions });
      expect(result.status).toBe("invalid");
      expect(result.message).toContain("一致しません");
    },
  );

  it.each([boundaryPhase, -boundaryPhase, -0.001_000_404_357_910_156_2, 37].flatMap((phase) =>
    [1e-8, 3.4e-9].map((duration) => ({ phase, duration })),
  ))("keeps cancellation across phase and short-step boundaries at phase=$phase, duration=$duration", ({ phase, duration }) => {
    expect((phase + 180) - 180).toBe(phase);
    const document = cancelledSlopeCircuit(phase);
    const averages: number[] = [];
    for (const divisions of [1, 5]) {
      const result = simulateTransient(document, { durationSeconds: duration, timeStepSeconds: duration / divisions });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(divisions + 1);
      expect(result.samples[0]!.parts.c.currentAmps).toBe(0);
      let charge = 0;
      for (let index = 1; index < result.samples.length; index += 1) {
        const previous = result.samples[index - 1]!;
        const sample = result.samples[index]!;
        const expected = cancelledSlopeCurrent(phase, previous.timeSeconds, sample.timeSeconds);
        const actual = sample.parts.c.currentAmps;
        expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-13);
        charge += actual * (sample.timeSeconds - previous.timeSeconds);
      }
      averages.push(charge / duration);
    }
    const expected = cancelledSlopeCurrent(phase, 0, duration);
    for (const average of averages) { expect(Math.abs(average / expected - 1)).toBeLessThan(1e-13); }
  });

  it.each([boundaryPhase, -0.001_000_404_357_910_156_2].flatMap((phase) =>
    [1, 5, 40].map((divisions) => ({ phase, divisions })),
  ))("retains offset curvature and sampled voltage at phase=$phase with $divisions intervals", ({ phase, divisions }) => {
    const duration = 1e-8;
    const cosine = Math.SQRT2 * Math.cos(phase * (Math.PI / 180));
    const sine = Math.SQRT2 * Math.sin(phase * (Math.PI / 180));
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: phase, offsetVolts: -cosine }],
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
    ], "Offset AC phase basis continuity");
    const result = simulateTransient(document, { durationSeconds: duration, timeStepSeconds: duration / divisions });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(divisions + 1);
    expect(result.samples[0]!.parts.c.voltageVolts).toBe(0);
    for (let index = 1; index < result.samples.length; index += 1) {
      const previousTime = result.samples[index - 1]!.timeSeconds;
      const sample = result.samples[index]!;
      const time = sample.timeSeconds;
      const dt = time - previousTime;
      const midpoint = Math.PI * (time + previousTime);
      const expectedCurrent = -2 * (cosine * Math.sin(midpoint) + sine * Math.cos(midpoint)) * Math.sin(Math.PI * dt) / dt;
      const expectedVoltage = -2 * cosine * Math.sin(Math.PI * time) ** 2 - sine * Math.sin(2 * Math.PI * time);
      expect(Math.abs(sample.parts.c.currentAmps / expectedCurrent - 1)).toBeLessThan(1e-13);
      expect(Math.abs(sample.parts.c.voltageVolts / expectedVoltage - 1)).toBeLessThan(1e-13);
      expect(sample.parts.source.voltageVolts).toBe(sample.parts.c.voltageVolts);
    }
  });

  it("keeps 40 ordinary-phase multitone samples continuous across an anchor radius", () => {
    const step = 1e-10;
    const result = simulateTransient(cancelledSlopeCircuit(boundaryPhase), { durationSeconds: 40 * step, timeStepSeconds: step });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(41);
    for (let index = 1; index < result.samples.length; index += 1) {
      const previous = result.samples[index - 1]!;
      const sample = result.samples[index]!;
      const expected = cancelledSlopeCurrent(boundaryPhase, previous.timeSeconds, sample.timeSeconds);
      expect(Math.abs(sample.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
    }
  });

  it.each([1e-10, 1e-12, 2 ** -55])("retains the ordinary initial coefficient model at a peak with final interval=%s", (finalInterval) => {
    const duration = 2 ** -15;
    const phase = -360 * duration;
    const cosine = Math.SQRT2 * Math.cos(phase * (Math.PI / 180));
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: phase }],
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: cosine }],
    ], "Short interval at an ordinary-phase model peak");
    const result = simulateTransient(document, { durationSeconds: duration, timeStepSeconds: duration - finalInterval });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    const dt = duration - result.samples[1]!.timeSeconds;
    // Independently rotate the *binary64* co/si inputs with decimal pi at
    // 100 digits. The nonzero peak sine is their original trig error, which
    // must remain part of the model rather than be reset by an axis anchor.
    const peakCosine = Math.SQRT2;
    const peakSine = 5.651_897_236_402_906e-20;
    const expected = (2 * peakCosine * Math.sin(Math.PI * dt) ** 2 - peakSine * Math.sin(2 * Math.PI * dt)) / dt;
    expect(Math.abs(result.samples.at(-1)!.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
  });

  it.each([1e-10, 2 ** -55])("keeps an ordinary-phase multitone model through final interval=%s", (finalInterval) => {
    const duration = 2 ** -15;
    const result = simulateTransient(cancelledSlopeCircuit(boundaryPhase), {
      durationSeconds: duration, timeStepSeconds: duration - finalInterval,
    });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    const expected = cancelledSlopeCurrent(boundaryPhase, result.samples[1]!.timeSeconds, duration);
    expect(Math.abs(result.samples.at(-1)!.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
  });
});
