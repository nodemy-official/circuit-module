import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

describe("capacitor current over a short final AC interval", () => {
  it.each([1e-10, 3e-9])("keeps rounded initial voltage constraints independent of step=%s", (step) => {
    // Independently evaluated with 90 decimal digits for the binary64 phase.
    const initialVoltageVolts = 1.000_000_017_453_292_4;
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 44.999_999 }],
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts }],
    ], "Rounded initial AC voltage");
    const result = simulateTransient(document, { durationSeconds: 3e-9, timeStepSeconds: step });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]!.parts.c.voltageVolts).toBe(initialVoltageVolts);
    for (let index = 1; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const dt = sample.timeSeconds - result.samples[index - 1]!.timeSeconds;
      const angle = 44.999_999 * Math.PI / 180 + 2 * Math.PI * (sample.timeSeconds - dt / 2);
      const expected = -2 * Math.SQRT2 * Math.sin(angle) * Math.sin(Math.PI * dt) / dt;
      expect(Math.abs(sample.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
    }
  });

  it.each([1e-10, 3e-9])("rejects a neighboring initial voltage with step=%s", (step) => {
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 44.999_999 }],
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 1.000_000_017_453_292_4 + Number.EPSILON }],
    ], "Inconsistent rounded AC voltage");
    const result = simulateTransient(document, { durationSeconds: 3e-9, timeStepSeconds: step });
    expect(result.status).toBe("invalid");
    expect(result.message).toContain("電圧が一致しません");
  });

  it.each([1, -1])("aligns rounded series-source initial constraints with orientation=%s", (orientation) => {
    const time = 3e-9;
    const document = createCircuitFromSpecs([
      ["first", "ac-source", ["v", "m"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 44.999_999 }],
      ["third", "ac-source", ["m", "g"], { voltageVolts: 1, frequencyHz: 3, phaseDegrees: 44.999_999 }],
      ["c", "capacitor", orientation === 1 ? ["v", "g"] : ["g", "v"], { capacitanceFarads: 1, initialVoltageVolts: orientation * 2 * 1.000_000_017_453_292_4 }],
    ], "Rounded series AC voltage");
    const result = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time });
    expect(result.status, result.message).toBe("valid");
    const expected = -orientation * 2 * Math.SQRT2 * (
      Math.sin(44.999_999 * Math.PI / 180 + Math.PI * time) * Math.sin(Math.PI * time) +
      Math.sin(44.999_999 * Math.PI / 180 + 3 * Math.PI * time) * Math.sin(3 * Math.PI * time)
    ) / time;
    expect(Math.abs(result.samples.at(-1)!.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
  });

  it.each([false, true])("preserves exact diagonal cancellation with series capacitor=%s", (seriesCapacitor) => {
    const time = 2 ** -30;
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 45 - 360 * time, offsetVolts: -1 }],
      ["r", "resistor", ["v", seriesCapacitor ? "c" : "g"], { resistanceOhms: 1e-18 }],
      ...(seriesCapacitor ? [["c", "capacitor", ["c", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }] as const] : []),
    ], "Exact short AC endpoint");
    const result = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time });
    expect(result.status, result.message).toBe("valid");
    const final = result.samples.at(-1)!;
    expect(final.parts.source.voltageVolts).toBe(0);
    expect(final.parts.r.voltageVolts).toBe(0);
    expect(final.parts.r.currentAmps).toBe(0);
    if (seriesCapacitor) { expect(final.parts.c.currentAmps).toBe(0); }
  });

  it.each([
    [0, Math.SQRT2, 0], [45, 1, 1], [90, 0, Math.SQRT2], [135, -1, 1],
    [180, -Math.SQRT2, 0], [225, -1, -1], [270, 0, -Math.SQRT2], [315, 1, -1],
  ].flatMap(([phase, cosine, sine]) => [-1, 0, 1].map((side) => ({ phase, cosine, sine, side }))))(
    "keeps exact and neighboring endpoints consistent at phase=$phase, side=$side",
    ({ phase, cosine, sine, side }) => {
      const anchorTime = 2 ** -30;
      const time = anchorTime + side * 2 ** -45;
      const document = createCircuitFromSpecs([
        ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: phase - 360 * anchorTime, offsetVolts: -cosine }],
        ["r", "resistor", ["v", "g"], { resistanceOhms: 1e-18 }],
      ], "Short AC normalization around axes and diagonals");
      const direct = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time });
      const split = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time / 2 });
      expect(direct.status, direct.message).toBe("valid");
      expect(split.status, split.message).toBe("valid");
      const final = split.samples.at(-1)!.parts.r;
      expect(final.voltageVolts).toBe(direct.samples.at(-1)!.parts.r.voltageVolts);
      expect(final.currentAmps).toBe(direct.samples.at(-1)!.parts.r.currentAmps);
      if (side === 0) {
        expect(final.voltageVolts).toBe(0);
        expect(final.currentAmps).toBe(0);
      } else {
        // Independent half-angle identity retains the quadratic axis response.
        const delta = time - anchorTime;
        const expected = -2 * cosine * Math.sin(Math.PI * delta) ** 2 - sine * Math.sin(2 * Math.PI * delta);
        expect(Math.abs(final.voltageVolts / expected - 1)).toBeLessThan(1e-13);
        expect(Math.abs(final.currentAmps / (expected / 1e-18) - 1)).toBeLessThan(1e-13);
      }
    },
  );

  it.each([false, true])("uses consistent voltage endpoints with multitone=%s", (multitone) => {
    const duration = 0.875;
    const step = multitone ? 0.874_999_999_9 : 0.874_999_999_7;
    const dt = duration - step;
    const document = createCircuitFromSpecs([
      ["first", "ac-source", ["v", multitone ? "m" : "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 45 }],
      ...(multitone ? [["third", "ac-source", ["m", "g"], { voltageVolts: 1, frequencyHz: 3, phaseDegrees: 135 }] as const] : []),
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: multitone ? 0 : 1 }],
    ], "Short interval at an AC peak");
    const result = simulateTransient(document, { durationSeconds: duration, timeStepSeconds: step });
    expect(result.status, result.message).toBe("valid");
    // cos(0)-cos(w*h)=2*sin(w*h/2)^2 avoids the subtraction under test.
    const expected = 2 * Math.SQRT2 * (Math.sin(Math.PI * dt) ** 2 + (multitone ? Math.sin(3 * Math.PI * dt) ** 2 : 0)) / dt;
    const actual = result.samples.at(-1)!.parts.c.currentAmps;
    expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-13);
  });

  it("keeps short regular intervals continuous when the phase approaches a diagonal", () => {
    const phase = 45 - 1e-6;
    const step = 1e-10;
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: phase }],
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: Math.SQRT2 * Math.cos(phase * (Math.PI / 180)) }],
    ], "Continuous short AC intervals");
    const result = simulateTransient(document, { durationSeconds: 4e-9, timeStepSeconds: step });
    expect(result.status, result.message).toBe("valid");
    for (let index = 1; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const dt = sample.timeSeconds - result.samples[index - 1]!.timeSeconds;
      const midpointAngle = phase * Math.PI / 180 + 2 * Math.PI * (sample.timeSeconds - dt / 2);
      const expected = -2 * Math.SQRT2 * Math.sin(midpointAngle) * Math.sin(Math.PI * dt) / dt;
      expect(Math.abs(sample.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
    }
  });

  it("keeps 40 regular multitone samples continuous when their initial slopes cancel", () => {
    const step = 1e-10;
    const document = createCircuitFromSpecs([
      ["first", "ac-source", ["v", "m"], { voltageVolts: 3, frequencyHz: 1, phaseDegrees: 45 }],
      ["third", "ac-source", ["m", "g"], { voltageVolts: 1, frequencyHz: 3, phaseDegrees: 225 }],
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 2 }],
    ], "Continuous multitone slope cancellation");
    const result = simulateTransient(document, { durationSeconds: 40 * step, timeStepSeconds: step });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(41);
    expect(result.samples[0]!.parts.c.currentAmps).toBe(0);
    for (let index = 1; index < result.samples.length; index += 1) {
      const sample = result.samples[index]!;
      const previousTime = result.samples[index - 1]!.timeSeconds;
      const dt = sample.timeSeconds - previousTime;
      const midpoint = Math.PI * (sample.timeSeconds + previousTime);
      const u0 = Math.sin(Math.PI * previousTime) ** 2;
      const u1 = Math.sin(Math.PI * sample.timeSeconds) ** 2;
      const s0 = Math.sin(2 * Math.PI * previousTime);
      const s1 = Math.sin(2 * Math.PI * sample.timeSeconds);
      const du = Math.sin(midpoint) * Math.sin(Math.PI * dt);
      const ds = 2 * Math.cos(midpoint) * Math.sin(Math.PI * dt);
      // Triple-angle identities give V(t)=2+12*u-48*u^2+32*u^3-4*s^3,
      // u=sin(pi*t)^2, s=sin(2*pi*t). Factor their endpoint differences.
      const expected = (du * (12 - 48 * (u1 + u0) + 32 * (u1 * u1 + u0 * u1 + u0 * u0)) -
        4 * ds * (s1 * s1 + s0 * s1 + s0 * s0)) / dt;
      expect(Math.abs(sample.parts.c.currentAmps / expected - 1)).toBeLessThan(1e-13);
    }
  });
});
