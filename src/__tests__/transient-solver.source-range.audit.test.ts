import { expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { simulateTransient } from "../transient-solver.js";

it("retains a thirteenth-order initial voltage after same-frequency phase cancellation", () => {
  const epsilon = 2 ** -40;
  const amplitudes = [1716, 1287, 715, 286, 78, 13, 1];
  const document: CircuitDocument = {
    title: "Thirteenth-order phase cancellation at one frequency",
    parts: [
      ...amplitudes.map((voltageVolts, index) => ({
        id: `s${index}`, kind: "ac-source" as const, label: "S", x: 0, y: 0, voltageVolts, frequencyHz: 1,
        phaseDegrees: (index % 2 === 0 ? 270 : 90) + (2 * index + 1) * epsilon,
      })),
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1e-176 },
    ],
    wires: [
      ...amplitudes.slice(1).map((_, index) => ({ id: `w${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const } })),
      { id: "a", from: { partId: "s6", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "s0", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 1e-200, timeStepSeconds: 1e-200 });
  expect(result.status, result.message).toBe("valid");
  // Independent sin^13 identity; no solver arithmetic in the oracle.
  const voltage = 4096 * Math.SQRT2 * Math.sin(epsilon * Math.PI / 180) ** 13;
  expect(result.samples[0]!.parts.r!.voltageVolts / voltage).toBeCloseTo(1, 14);
  expect(result.samples[0]!.parts.r!.currentAmps / (voltage / 1e-176)).toBeCloseTo(1, 14);
});

it("uses complete phase coefficients for a thirteenth-order initial capacitor current", () => {
  const epsilon = 2 ** -40;
  const amplitudes = [1716, 1287, 715, 286, 78, 13, 1];
  const sources = amplitudes.flatMap((voltageVolts, index) => [0, 1].map((pair) => ({
    id: `s${2 * index + pair}`, kind: "ac-source" as const, label: "S", x: 0, y: 0, voltageVolts,
    frequencyHz: 2 * index + 1 + pair, phaseDegrees: ((index + pair) % 2 === 0 ? 0 : 180) + (2 * index + 1) * epsilon,
  })));
  const document: CircuitDocument = {
    title: "Consistent zero initial voltage with a thirteenth-order derivative",
    parts: [...sources, { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1e176, initialVoltageVolts: 0 }],
    wires: [
      ...sources.slice(1).map((_, index) => ({ id: `w${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const } })),
      { id: "a", from: { partId: "s13", terminal: "a" }, to: { partId: "c", terminal: "a" } },
      { id: "b", from: { partId: "s0", terminal: "b" }, to: { partId: "c", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 1e-130, timeStepSeconds: 1e-130 });
  expect(result.status, result.message).toBe("valid");
  const expected = 2 * Math.PI * 4096 * Math.SQRT2 * Math.sin(epsilon * Math.PI / 180) ** 13 * 1e176;
  expect(result.samples[0]!.parts.c!.voltageVolts).toBe(0);
  expect(result.samples[0]!.parts.c!.currentAmps / expected).toBeCloseTo(1, 14);
});

it("retains tiny phase curvature when repeated small increments cancel leading coefficients", () => {
  const epsilon = 2 ** -40;
  const phases = [epsilon, -epsilon, 180 + epsilon, 180 - epsilon, 0, 0, 180, 180];
  const frequencies = [1, 1, 2, 2, 2, 2, 1, 1];
  const timeStepSeconds = 1e-20;
  const document: CircuitDocument = {
    title: "Phase curvature after cancellation over multiple steps",
    parts: [
      ...phases.map((phaseDegrees, index) => ({
        id: `s${index}`, kind: "ac-source" as const, label: "S", x: 0, y: 0, voltageVolts: 1, frequencyHz: frequencies[index], phaseDegrees,
      })),
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1e16, initialVoltageVolts: 0 },
    ],
    wires: [
      ...phases.slice(1).map((_, index) => ({
        id: `series${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const },
      })),
      { id: "positive", from: { partId: "s7", terminal: "a" }, to: { partId: "c", terminal: "a" } },
      { id: "negative", from: { partId: "s0", terminal: "b" }, to: { partId: "c", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 5 * timeStepSeconds, timeStepSeconds });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples[0]!.parts.c!.currentAmps).toBe(0);
  // V=2*sqrt(2)*(cos(delta)-1)*(cos(x)-cos(2*x))
  //  =-1.5*sqrt(2)*delta^2*x^2*(1+O(delta^2+x^2)), relative error <1e-28.
  const delta = epsilon * Math.PI / 180;
  const firstCurrent = -1.5 * Math.SQRT2 * delta * delta * (2 * Math.PI) ** 2 * 1e16 * timeStepSeconds;
  for (const [index, sample] of result.samples.entries()) {
    if (index === 0) { continue; }
    expect(sample.parts.c!.currentAmps / ((2 * index - 1) * firstCurrent)).toBeCloseTo(1, 14);
  }
});

it.each([1e-20, 1e-8, 1e-5, 0.02])("uses the waveform's normalized diagonal coefficients for capacitor current at %s seconds", (timeStepSeconds) => {
  const epsilon = 2 ** -45;
  const phases = [45 + epsilon, 135 - epsilon, 225, 315];
  const document: CircuitDocument = {
    title: "Consistent initial derivative around 45 degrees",
    parts: [
      ...phases.map((phaseDegrees, index) => ({
        id: `s${index}`, kind: "ac-source" as const, label: "S", x: 0, y: 0, voltageVolts: 1, frequencyHz: 1, phaseDegrees,
      })),
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1e16, initialVoltageVolts: 0 },
    ],
    wires: [
      ...phases.slice(1).map((_, index) => ({
        id: `series${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const },
      })),
      { id: "positive", from: { partId: "s3", terminal: "a" }, to: { partId: "c", terminal: "a" } },
      { id: "negative", from: { partId: "s0", terminal: "b" }, to: { partId: "c", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: timeStepSeconds, timeStepSeconds });
  expect(result.status, result.message).toBe("valid");
  const delta = epsilon * Math.PI / 180;
  const expected = -4 * Math.PI * 1e16 * (Math.sin(delta) - 2 * Math.sin(delta / 2) ** 2);
  expect(result.samples[0]!.parts.c!.currentAmps / expected).toBeCloseTo(1, 14);
  const angle = 2 * Math.PI * timeStepSeconds;
  expect(result.samples[1]!.parts.c!.currentAmps / (expected * Math.sin(angle) / angle)).toBeCloseTo(1, 14);
});

it("retains tiny initial phase curvature in the ordinary time interval", () => {
  const epsilon = 1e-20;
  const phases = [epsilon, -epsilon, 180];
  const document: CircuitDocument = {
    title: "Tiny phase curvature outside the small-angle interval",
    parts: [
      ...phases.map((phaseDegrees, index) => ({
        id: `s${index}`, kind: "ac-source" as const, label: "S", x: 0, y: 0, voltageVolts: index === 2 ? 2 : 1, frequencyHz: 1, phaseDegrees,
      })),
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1e-44 },
    ],
    wires: [
      ...phases.slice(1).map((_, index) => ({
        id: `series${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const },
      })),
      { id: "positive", from: { partId: "s2", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "negative", from: { partId: "s0", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 0.04, timeStepSeconds: 0.02 });
  expect(result.status, result.message).toBe("valid");
  const delta = epsilon * Math.PI / 180;
  for (const sample of result.samples) {
    const expected = -4 * Math.SQRT2 * Math.sin(delta / 2) ** 2 * Math.cos(2 * Math.PI * sample.timeSeconds) / 1e-44;
    expect(sample.parts.r!.currentAmps / expected).toBeCloseTo(1, 14);
  }
});

it.each([0, 90, 180, 270].flatMap((phaseDegrees) =>
  [0.125 - 2 ** -56, 0.125, 0.125 + 2 ** -55].map((time) => ({ phaseDegrees, time })),
))("normalizes the time-shifted 45-degree coefficient at phase $phaseDegrees, t=$time", ({ phaseDegrees, time }) => {
  const sign = phaseDegrees === 0 || phaseDegrees === 270 ? 1 : -1;
  const document: CircuitDocument = {
    title: "Time-shifted 45-degree cancellation",
    parts: [
      { id: "s", kind: "ac-source", label: "S", x: 0, y: 0, voltageVolts: 1, offsetVolts: -sign, frequencyHz: 1, phaseDegrees },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1e-18 },
    ],
    wires: [
      { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time });
  expect(result.status, result.message).toBe("valid");
  if (time === 0.125) {
    expect(result.samples[1]!.parts.r!.voltageVolts).toBe(0);
    expect(result.samples[1]!.parts.r!.currentAmps).toBe(0);
  } else {
    // At a neighbouring binary64 time the quadratic correction is <1e-16
    // relative to the leading slope, and must not be rounded to zero.
    const expected = (phaseDegrees < 180 ? -1 : 1) * 2 * Math.PI * (time - 0.125);
    expect(result.samples[1]!.parts.r!.voltageVolts / expected).toBeCloseTo(1, 14);
    expect(result.samples[1]!.parts.r!.currentAmps / (expected / 1e-18)).toBeCloseTo(1, 14);
  }
});

it.each([1e-20, -1e-20])("retains the sine coefficient of a %s-degree phase without rounding a 90-degree shift", (phaseDegrees) => {
  const capacitanceFarads = 1e16;
  const timeStepSeconds = 1e-25;
  const resistanceOhms = 1e-40;
  const document: CircuitDocument = {
    title: "Sub-ULP phase shift with finite capacitor response",
    parts: [
      { id: "s", kind: "ac-source", label: "S", x: 0, y: 0, voltageVolts: 1, offsetVolts: -Math.SQRT2, frequencyHz: 1, phaseDegrees },
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads, initialVoltageVolts: 0 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms },
    ],
    wires: [
      { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "rc", from: { partId: "r", terminal: "b" }, to: { partId: "c", terminal: "a" } },
      { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "c", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: timeStepSeconds, timeStepSeconds });
  expect(result.status, result.message).toBe("valid");
  const phase = phaseDegrees * Math.PI / 180;
  const initialCurrent = -0.5 * Math.SQRT2 * phase * phase / resistanceOhms;
  const finalPhase = phase + 2 * Math.PI * timeStepSeconds;
  const expectedCurrent = -0.5 * Math.SQRT2 * finalPhase * finalPhase / (resistanceOhms + timeStepSeconds / capacitanceFarads);
  expect(result.samples[0]!.parts.c!.currentAmps / initialCurrent).toBeCloseTo(1, 14);
  expect(result.samples[1]!.parts.c!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
});

it.each([1e-20, 2 ** -80, 1e-100])("preserves cubic voltage differences between sources with equal initial slopes at %s seconds", (timeStepSeconds) => {
  const amplitude = 1 + 2 ** -52;
  const document: CircuitDocument = {
    title: "Equal slopes with different cubic response",
    parts: [
      { id: "s1", kind: "ac-source", label: "AC1", x: 0, y: 0, voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: 90 },
      { id: "s2", kind: "ac-source", label: "AC2", x: 0, y: 0, voltageVolts: 1, frequencyHz: amplitude, phaseDegrees: 90 },
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1e16, initialVoltageVolts: 0 },
    ],
    wires: [
      { id: "a", from: { partId: "s1", terminal: "a" }, to: { partId: "c", terminal: "a" } },
      { id: "b", from: { partId: "s2", terminal: "a" }, to: { partId: "c", terminal: "b" } },
      { id: "return", from: { partId: "s1", terminal: "b" }, to: { partId: "s2", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: timeStepSeconds, timeStepSeconds });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples[0]!.parts.c!.currentAmps).toBe(0);
  // -sqrt(2)*[a*sin(x)-sin(a*x)] = -sqrt(2)*a*(a-1)*(a+1)*x^3/6+O(x^5).
  // The next relative correction is <1e-38 for every time step here.
  const expectedCurrent = -Math.SQRT2 * amplitude * (amplitude - 1) * (amplitude + 1)
    * (2 * Math.PI) ** 3 / 6 * 1e16 * timeStepSeconds * timeStepSeconds;
  expect(result.samples[1]!.parts.c!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
});

it.each([4, -4])("keeps finite RL response when the unused history voltage overflows (%s A)", (initialCurrentAmps) => {
  const document: CircuitDocument = {
    title: "Finite RL response beyond history voltage range",
    parts: [
      { id: "l", kind: "inductor", label: "L", x: 0, y: 0, inductanceHenries: 2 ** 1023, initialCurrentAmps },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    ],
    wires: [
      { id: "a", from: { partId: "l", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "l", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 2, timeStepSeconds: 1 });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(3);
  // I_n=I_0/(1+R*dt/L)^n differs from I_0 by far less than half an ULP.
  // Ohm's law and KCL give V_L=-R*I_L and P_L=-R*I_L^2.
  for (const sample of result.samples) {
    expect(sample.parts.l!.currentAmps).toBe(initialCurrentAmps);
    expect(sample.parts.l!.voltageVolts).toBe(-initialCurrentAmps);
    expect(sample.parts.l!.powerWatts).toBe(-16);
    expect(sample.parts.r!.currentAmps).toBe(-initialCurrentAmps);
    expect(sample.parts.r!.powerWatts).toBe(16);
  }
});

it.each([
  [60, 1], [120, -1], [240, -1], [300, 1],
  [45, 1], [135, -1], [225, -1], [315, 1],
] as const)("rounds the complete AC peak product once at %s degrees", (phaseDegrees, sign) => {
  const document: CircuitDocument = {
    title: "Subnormal AC peak",
    parts: [
      { id: "source", kind: "ac-source", label: "AC", x: 0, y: 0, voltageVolts: Number.MIN_VALUE, frequencyHz: 1, phaseDegrees },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: Number.MIN_VALUE },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "source", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(2);
  // At 60-degree axes |sqrt(2)*cos(phase)|=1/sqrt(2)>1/2; at 45-degree
  // axes it is exactly 1. Both round to one MIN_VALUE quantum, never zero.
  for (const sample of result.samples) {
    expect(sample.parts.source!.voltageVolts).toBe(sign * Number.MIN_VALUE);
    expect(sample.parts.r!.voltageVolts).toBe(sign * Number.MIN_VALUE);
    const expectedCurrent = Math.abs(phaseDegrees % 90) === 45 ? sign : sign / Math.SQRT2;
    expect(sample.parts.r!.currentAmps).toBeCloseTo(expectedCurrent, 14);
  }
});

it.each([75, 105, 255, 285])("keeps finite current when AC voltage rounds below display range at %s degrees", (phaseDegrees) => {
  const document: CircuitDocument = {
    title: "AC voltage below display range with finite current",
    parts: [
      { id: "source", kind: "ac-source", label: "AC", x: 0, y: 0, voltageVolts: Number.MIN_VALUE, frequencyHz: 1, phaseDegrees },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: Number.MIN_VALUE },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "source", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 2, timeStepSeconds: 0.5 });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(5);
  for (const [index, sample] of result.samples.entries()) {
    const expectedCurrent = Math.SQRT2 * Math.cos(phaseDegrees * Math.PI / 180) * (index % 2 === 0 ? 1 : -1);
    expect(Math.abs(sample.parts.source!.voltageVolts)).toBe(0);
    expect(Math.abs(sample.parts.r!.voltageVolts)).toBe(0);
    expect(sample.parts.r!.currentAmps).toBeCloseTo(expectedCurrent, 14);
    expect(sample.parts.source!.currentAmps).toBeCloseTo(-expectedCurrent, 14);
  }
});

it.each([
  [1e-20, 1e-20], [1e-8, 9.999_999_990_686_774e-9],
  [1e-8 * (1 - 2 ** -52), 1e-8 * (1 - 2 ** -52)],
  [1e-8, 1e-8], [1e-8 * (1 + 2 ** -52), 1e-8 * (1 + 2 ** -52)],
  [2e-8, 2e-8], [1e-7, 1e-7],
  [1e-6, 1e-6], [3e-6, 3e-6], [0.001, 0.001], [0.02, 0.02],
])("preserves differential capacitor current across waveform evaluation boundaries at %s seconds", (durationSeconds, timeStepSeconds) => {
  const document: CircuitDocument = {
    title: "Equal initial slopes with opposite cosine coefficients",
    parts: [
      { id: "s45", kind: "ac-source", label: "AC45", x: 0, y: 0, voltageVolts: 1, frequencyHz: 1, phaseDegrees: 45, offsetVolts: -1 },
      { id: "s135", kind: "ac-source", label: "AC135", x: 0, y: 0, voltageVolts: 1, frequencyHz: 1, phaseDegrees: 135, offsetVolts: 1 },
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1e16, initialVoltageVolts: 0 },
    ],
    wires: [
      { id: "a", from: { partId: "s45", terminal: "a" }, to: { partId: "c", terminal: "a" } },
      { id: "b", from: { partId: "s135", terminal: "a" }, to: { partId: "c", terminal: "b" } },
      { id: "return", from: { partId: "s45", terminal: "b" }, to: { partId: "s135", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds, timeStepSeconds });
  expect(result.status, result.message).toBe("valid");
  // dV45/dt=dV135/dt=-2*pi at t=0, so the capacitor initially carries no current.
  expect(result.samples[0]!.parts.c!.currentAmps).toBe(0);
  // V45-V135=-4*sin(pi*t)^2; factor its difference instead of subtracting
  // nearly equal rounded voltages when the final interval is very short.
  for (const [index, sample] of result.samples.entries()) {
    if (index === 0) { continue; }
    const previousTime = result.samples[index - 1]!.timeSeconds;
    const dt = sample.timeSeconds - previousTime;
    const expectedCurrent = -4 * 1e16 * Math.sin(Math.PI * (sample.timeSeconds + previousTime)) * Math.sin(Math.PI * dt) / dt;
    expect(sample.parts.c!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
    const expectedVoltage = -4 * Math.sin(Math.PI * sample.timeSeconds) ** 2;
    expect(sample.parts.c!.voltageVolts / expectedVoltage).toBeCloseTo(1, 14);
  }
});

function binomial(n: number, k: number) {
  let value = 1;
  for (let index = 1; index <= k; index += 1) { value = value * (n - index + 1) / index; }
  return value;
}

it.each([13, 23, 31].flatMap((power) => [0.007_812_5, 0.02, 0.05].map((time) => ({ power, time }))))(
  "preserves order $power harmonic cancellation after quarter-turn reduction at $time seconds", ({ power, time }) => {
  const amplitudes = Array.from({ length: (power + 1) / 2 }, (_, index) => binomial(power, (power - 1) / 2 - index));
  const document: CircuitDocument = {
    title: "Harmonic identity across different time quadrants",
    parts: [
      ...amplitudes.map((voltageVolts, index) => ({
        id: `s${index}`, kind: "ac-source" as const, label: "S", x: 0, y: 0,
        voltageVolts, frequencyHz: 2 * index + 1, phaseDegrees: index % 2 === 0 ? 270 : 90,
      })),
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    ],
    wires: [
      ...amplitudes.slice(1).map((_, index) => ({
        id: `series${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const },
      })),
      { id: "positive", from: { partId: `s${amplitudes.length - 1}`, terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "negative", from: { partId: "s0", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: time, timeStepSeconds: time });
  expect(result.status, result.message).toBe("valid");
  const expected = 2 ** (power - 1) * Math.SQRT2 * Math.sin(2 * Math.PI * time) ** power;
  // The independent power identity uses only binary64 trig at the final
  // non-cancelling boundary; its relative rounding error grows with power.
  expect(result.samples[1]!.parts.r!.voltageVolts / expected).toBeCloseTo(1, 12);
  expect(result.samples[1]!.parts.r!.currentAmps / expected).toBeCloseTo(1, 12);
});

it.each([13, 15, 17, 23].flatMap((power) => [1, 5].map((steps) => ({ power, steps }))))(
  "keeps order $power response across $steps steps after lower orders cancel", ({ power, steps }) => {
  const amplitudes = Array.from({ length: (power + 1) / 2 }, (_, index) => binomial(power, (power - 1) / 2 - index));
  const durationSeconds = 2 ** -32;
  const capacitanceFarads = 2 ** 332;
  const document: CircuitDocument = {
    title: "Thirteenth-order sine identity",
    parts: [
      ...amplitudes.map((voltageVolts, index) => ({
        id: `s${index}`, kind: "ac-source" as const, label: `S${index}`, x: 0, y: 0,
        voltageVolts, frequencyHz: 2 * index + 1, phaseDegrees: index % 2 === 0 ? 270 : 90,
      })),
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads, initialVoltageVolts: 0 },
    ],
    wires: [
      ...amplitudes.slice(1).map((_, index) => ({
        id: `series${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `s${index + 1}`, terminal: "b" as const },
      })),
      { id: "positive", from: { partId: `s${amplitudes.length - 1}`, terminal: "a" }, to: { partId: "c", terminal: "a" } },
      { id: "negative", from: { partId: "s0", terminal: "b" }, to: { partId: "c", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: steps * durationSeconds, timeStepSeconds: durationSeconds });
  expect(result.status, result.message).toBe("valid");
  // The independent harmonic identity gives V=2^(power-1)*sqrt(2)*sin(2*pi*t)^power.
  let previousVoltage = 0;
  for (const sample of result.samples.slice(1)) {
    const expectedVoltage = 2 ** (power - 1) * Math.SQRT2 * Math.sin(2 * Math.PI * sample.timeSeconds) ** power;
    const expectedCurrent = capacitanceFarads * (expectedVoltage - previousVoltage) / durationSeconds;
    expect(sample.parts.c!.voltageVolts / expectedVoltage).toBeCloseTo(1, 14);
    expect(sample.parts.c!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
    previousVoltage = expectedVoltage;
  }
});

it.each([0, 180])("keeps finite offset-cancelled source voltage when its peak exceeds binary64 range at %s degrees", (phaseDegrees) => {
  const sign = phaseDegrees === 0 ? 1 : -1;
  const document: CircuitDocument = {
    title: "Peak overflow with finite complete source voltage",
    parts: [
      { id: "s", kind: "ac-source", label: "S", x: 0, y: 0, voltageVolts: 1.5e308, offsetVolts: -sign * 1.5e308, frequencyHz: 1, phaseDegrees },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1e308 },
    ],
    wires: [
      { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
  const result = simulateTransient(document, { durationSeconds: 1e-20, timeStepSeconds: 1e-20 });
  expect(result.status, result.message).toBe("valid");
  for (const sample of result.samples) {
    expect(sample.parts.r!.currentAmps / (sign * 1.5 * (Math.SQRT2 - 1))).toBeCloseTo(1, 14);
    expect(Number.isFinite(sample.parts.r!.voltageVolts)).toBe(true);
  }
});
