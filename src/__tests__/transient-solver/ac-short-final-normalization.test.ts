import { expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function sourceAndLoad(phaseDegrees: number, offsetVolts: number): CircuitDocument {
  return {
    title: "AC normalization after a short final interval",
    parts: [
      { id: "s", kind: "ac-source", label: "S", x: 0, y: 0, voltageVolts: 1, frequencyHz: 1, phaseDegrees, offsetVolts },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1e-18 },
    ],
    wires: [
      { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
}

it.each([0, 90, 180, 270].flatMap((phaseDegrees) =>
  [0.125 - 2 ** -56, 0.125, 0.125 + 2 ** -55].flatMap((time) =>
    [1e-9, 1e-10].map((finalStep) => ({ phaseDegrees, time, finalStep }))),
))("keeps diagonal cancellation independent of a $finalStep-second final interval at phase $phaseDegrees, t=$time", ({ phaseDegrees, time, finalStep }) => {
  const peakSign = phaseDegrees === 0 || phaseDegrees === 270 ? 1 : -1;
  const document = sourceAndLoad(phaseDegrees, -peakSign);
  const direct = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time });
  const split = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time - finalStep });
  expect(direct.status, direct.message).toBe("valid");
  expect(split.status, split.message).toBe("valid");
  expect(split.samples).toHaveLength(3);
  const final = split.samples.at(-1)!.parts.r!;
  expect(final.voltageVolts).toBe(direct.samples.at(-1)!.parts.r!.voltageVolts);
  expect(final.currentAmps).toBe(direct.samples.at(-1)!.parts.r!.currentAmps);
  if (time === 0.125) {
    // sqrt(2)*cos(45 + n*90 degrees) is exactly +/-1.
    expect(final.voltageVolts).toBe(0);
    expect(final.currentAmps).toBe(0);
  } else {
    // The quadratic correction is <1e-16 relative to this independent slope.
    const expected = (phaseDegrees < 180 ? -1 : 1) * 2 * Math.PI * (time - 0.125);
    expect(final.voltageVolts / expected).toBeCloseTo(1, 14);
    expect(final.currentAmps / (expected / 1e-18)).toBeCloseTo(1, 14);
  }
});

it.each([0, 90, 180, 270])("keeps quarter-cycle axis values after a short final interval at phase %s", (phaseDegrees) => {
  const oddPhase = phaseDegrees % 180 !== 0;
  const offsetVolts = oddPhase ? (phaseDegrees === 90 ? Math.SQRT2 : -Math.SQRT2) : 0;
  const document = sourceAndLoad(phaseDegrees, offsetVolts);
  const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.25 - 1e-9 });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples.at(-1)!.parts.r!.voltageVolts).toBe(0);
  expect(result.samples.at(-1)!.parts.r!.currentAmps).toBe(0);
});
