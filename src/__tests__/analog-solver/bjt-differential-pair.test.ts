import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const THERMAL = 0.025_85;
const SATURATION = 1e-14;
const BETA = 100;
const TAIL = 0.001;
const LOAD = 1000;
const INPUT = 0.01;
const SIGNAL = 1e-3;

function differentialPair(kind: "npn-transistor" | "pnp-transistor", {
  common = 0,
  reverse = false,
  signal = false,
  scale = 1,
  reference = "0",
  tailCurrents = [TAIL * scale],
  extraParts = [] as CircuitSpec[],
} = {}) {
  const sign = kind === "npn-transistor" ? 1 : -1;
  const voltage = (id: string, node: string, value: number, amplitude = 0): CircuitSpec => [
    id, "ac-source", [node, reference],
    { offsetVolts: sign * value, voltageVolts: amplitude, phaseDegrees: sign === 1 ? 0 : 180, frequencyHz: 1000 },
  ];
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    voltage("supply", "supply", common + 5),
    voltage("input", "base1", common + INPUT, signal ? SIGNAL : 0),
    voltage("reference", "base2", common),
    ...tailCurrents.map((current, index): CircuitSpec => [
      `tail${index}`, "current-source", ["emitter", reference], { currentAmps: sign * current },
    ]),
    ["load1", "resistor", ["supply", "collector1"], { resistanceOhms: LOAD / scale }],
    ["load2", "resistor", ["supply", "collector2"], { resistanceOhms: LOAD / scale }],
    ["q1", kind, ["collector1", "base1", "emitter"], { saturationCurrentAmps: SATURATION * scale }],
    ["q2", kind, ["collector2", "base2", "emitter"], { saturationCurrentAmps: SATURATION * scale }],
    ...extraParts,
  ];
  return createCircuitFromSpecs(reverse ? specs.toReversed() : specs, "Current-biased BJT differential pair");
}

function pairOracle() {
  // Both base-collector junctions are reverse biased by more than 4 V.
  // Their exponential terms are below 1e-67 of Is; retaining -Is gives an
  // independent closed form far more accurate than the tested tolerance.
  const forwardSum = (TAIL - 2 * SATURATION) / (1 + 1 / BETA);
  const ratio = Math.exp(INPUT / THERMAL);
  const forward2 = (forwardSum - SATURATION * (ratio - 1)) / (ratio + 1);
  const forward1 = forwardSum - forward2;
  const currents = [forward1 + 2 * SATURATION, forward2 + 2 * SATURATION];
  const emitter = -THERMAL * Math.log1p(forward2 / SATURATION);
  const gm1 = (forward1 + SATURATION) / THERMAL;
  const gm2 = (forward2 + SATURATION) / THERMAL;
  const transfer = (gm1 * gm2) / (gm1 + gm2);
  return { currents, emitter, transfer, emitterGain: gm1 / (gm1 + gm2) };
}

describe("current-biased BJT differential pairs", () => {
  function expectRelative(actual: number, expected: number) {
    if (!Number.isFinite(actual) || Math.abs((actual - expected) / expected) >= 2e-10) {
      throw new Error(`Expected ${actual} to match ${expected} within relative error 2e-10.`);
    }
  }

  it.each([
    { kind: "npn-transistor", common: 0, reverse: false },
    { kind: "npn-transistor", common: 0, reverse: true },
    { kind: "npn-transistor", common: 1, reverse: false },
    { kind: "pnp-transistor", common: 0, reverse: false },
    { kind: "pnp-transistor", common: 0, reverse: true },
    { kind: "pnp-transistor", common: 1, reverse: false },
  ] as const)("solves $kind with common=$common and reversed order=$reverse", ({ kind, common, reverse }) => {
    const analysis = analyzeAnalogCircuit(differentialPair(kind, { common, reverse }), { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    const sign = kind === "npn-transistor" ? 1 : -1;
    const oracle = pairOracle();
    for (const [index, id] of ["q1", "q2"].entries()) {
      const reading = analysis.parts[id]!;
      expectRelative(reading.current.real, sign * oracle.currents[index]!);
      expectRelative(reading.terminalVoltages.a!.real, sign * (common + 5 - LOAD * oracle.currents[index]!));
      expectRelative(reading.terminalVoltages.c!.real, sign * (common + oracle.emitter));
      const terminalBalance = Object.values(reading.terminalCurrents).reduce((sum, current) => sum + current.real, 0);
      expect(Math.abs(terminalBalance)).toBeLessThan(TAIL * 1e-14);
    }
    const emitterBalance = analysis.parts.q1!.terminalCurrents.c!.real + analysis.parts.q2!.terminalCurrents.c!.real + sign * TAIL;
    expect(Math.abs(emitterBalance)).toBeLessThan(TAIL * 1e-10);
  });

  it.each(["npn-transistor", "pnp-transistor"] as const)("linearizes the differential response of %s", (kind) => {
    const analysis = analyzeAnalogCircuit(differentialPair(kind, { signal: true }), { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("valid");
    const sign = kind === "npn-transistor" ? 1 : -1;
    const oracle = pairOracle();
    expectRelative(analysis.parts.q1!.current.real, sign * SIGNAL * oracle.transfer);
    expectRelative(analysis.parts.q2!.current.real, -sign * SIGNAL * oracle.transfer);
    expectRelative(analysis.parts.q1!.terminalVoltages.a!.real, -sign * SIGNAL * LOAD * oracle.transfer);
    expectRelative(analysis.parts.q1!.terminalVoltages.c!.real, sign * SIGNAL * oracle.emitterGain);
  });

  it.each((["npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
    [1e-200, 1e-100, 1e-20, 1e20, 1e100, 1e200].map((scale) => ({ kind, scale })),
  ))("preserves the DC and AC solution of $kind at current scale $scale", ({ kind, scale }) => {
    const document = differentialPair(kind, { signal: true, scale });
    const original = JSON.stringify(document);
    const sign = kind === "npn-transistor" ? 1 : -1;
    const oracle = pairOracle();
    for (const mode of ["dc", "ac"] as const) {
      const analysis = analyzeAnalogCircuit(document, { mode });
      expect(analysis.status, analysis.message).toBe("valid");
      for (const [index, id] of ["q1", "q2"].entries()) {
        const current = mode === "dc" ? oracle.currents[index]!
          : (index === 0 ? 1 : -1) * SIGNAL * oracle.transfer;
        expectRelative(analysis.parts[id]!.current.real, sign * current * scale);
        const collector = (mode === "dc" ? 5 : 0) - LOAD * current;
        expectRelative(analysis.parts[id]!.terminalVoltages.a!.real, sign * collector);
      }
      const emitter = mode === "dc" ? oracle.emitter : SIGNAL * oracle.emitterGain;
      expectRelative(analysis.parts.q1!.terminalVoltages.c!.real, sign * emitter);
    }
    expect(JSON.stringify(document)).toBe(original);
  }, 30_000);

  it.each((["npn-transistor", "pnp-transistor"] as const).flatMap((kind) => [
    { name: "ordinary cancellation", tailCurrents: [1, -0.999] },
    { name: "huge cancellation", tailCurrents: [1e300, -1e300, TAIL] },
    { name: "huge cancellation with the small current between sources", tailCurrents: [1e300, TAIL, -1e300] },
  ].map((scenario) => ({ kind, ...scenario }))))("balances $kind with $name", ({ kind, tailCurrents }) => {
    const document = differentialPair(kind, { tailCurrents });
    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    const sign = kind === "npn-transistor" ? 1 : -1;
    const oracle = pairOracle();
    expectRelative(analysis.parts.q1!.current.real, sign * oracle.currents[0]!);
    expectRelative(analysis.parts.q2!.current.real, sign * oracle.currents[1]!);
    expectRelative(analysis.parts.q1!.terminalVoltages.c!.real, sign * oracle.emitter);
    for (const [index, current] of tailCurrents.entries()) {
      expect(analysis.parts[`tail${index}`]!.current.real).toBe(sign * current);
    }
  }, 30_000);

  it.each([
    { kind: "npn-transistor", reference: "0", reverse: false, gain: 1000 },
    { kind: "npn-transistor", reference: "floating", reverse: false, gain: 1000 },
    { kind: "npn-transistor", reference: "floating", reverse: true, gain: 1000 },
    { kind: "pnp-transistor", reference: "floating", reverse: false, gain: 1000 },
    { kind: "pnp-transistor", reference: "floating", reverse: true, gain: 1000 },
    { kind: "npn-transistor", reference: "floating", reverse: false, gain: 1e12 },
    { kind: "pnp-transistor", reference: "floating", reverse: true, gain: 1e12 },
  ] as const)("solves $kind beside MOS feedback, reference=$reference, reversed=$reverse, gain=$gain", ({ kind, reference, reverse, gain }) => {
    const extraParts: CircuitSpec[] = [
      ["feedback-input", "ac-source", ["feedback-input", "0"], { offsetVolts: 1, voltageVolts: 0 }],
      ["feedback-op", "op-amp", ["feedback-input", "feedback", "gate"], { openLoopGain: gain }],
      ["feedback-load", "resistor", ["feedback", "0"], { resistanceOhms: 1000 }],
      ["feedback-supply", "ac-source", ["feedback-supply", "0"], { offsetVolts: 5, voltageVolts: 0 }],
      ["feedback-mos", "nmos", ["feedback-supply", "gate", "feedback"]],
    ];
    const analysis = analyzeAnalogCircuit(differentialPair(kind, { reference, reverse, extraParts }), { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    const oracle = pairOracle();
    const sign = kind === "npn-transistor" ? 1 : -1;
    expectRelative(analysis.parts.q1!.current.real, sign * oracle.currents[0]!);
    expectRelative(analysis.parts.q2!.current.real, sign * oracle.currents[1]!);
    // Scalar KCL: I = Vf / 1000, Vg = gain * (1 - Vf), and the MOS
    // saturation law determine the independent feedback island's root.
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const error = (low + high) / 2;
      const feedback = 1 - error;
      const gate = feedback + 2 + Math.sqrt(2 * feedback / (1000 * 0.02 * (1 + 0.01 * (5 - feedback))));
      if (gain * error > gate) { high = error; } else { low = error; }
    }
    expectRelative(analysis.parts["feedback-load"]!.voltage.real, 1 - (low + high) / 2);
  }, 30_000);

  it.each((["npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
    [false, true].map((reverse) => ({ kind, reverse })),
  ))("solves a floating $kind beside an unconnected ground, reversed=$reverse", ({ kind, reverse }) => {
    const document = differentialPair(kind, { reference: "floating", reverse, signal: true });
    const oracle = pairOracle();
    const sign = kind === "npn-transistor" ? 1 : -1;
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    expectRelative(dc.parts.q1!.current.real, sign * oracle.currents[0]!);
    expectRelative(dc.parts.q2!.current.real, sign * oracle.currents[1]!);
    expectRelative(dc.parts.q1!.voltage.real, sign * (5 - LOAD * oracle.currents[0]! - oracle.emitter));
    const ac = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(ac.status, ac.message).toBe("valid");
    expectRelative(ac.parts.q1!.current.real, sign * SIGNAL * oracle.transfer);
    expectRelative(ac.parts.q2!.current.real, -sign * SIGNAL * oracle.transfer);
  }, 30_000);

  it.each(["npn-transistor", "pnp-transistor"] as const)("keeps the constant transient bias of %s", (kind) => {
    const analysis = simulateTransient(differentialPair(kind), { durationSeconds: 0.002, timeStepSeconds: 0.001 });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.samples).toHaveLength(3);
    const sign = kind === "npn-transistor" ? 1 : -1;
    const oracle = pairOracle();
    for (const sample of analysis.samples) {
      expectRelative(sample.parts.q1!.currentAmps, sign * oracle.currents[0]!);
      expectRelative(sample.parts.q2!.currentAmps, sign * oracle.currents[1]!);
    }
  }, 30_000);
});
