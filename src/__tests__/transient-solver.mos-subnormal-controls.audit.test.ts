import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../analog-solver.js";
import type { CircuitDocument, CircuitPart, CircuitTerminal } from "../circuit-model.js";
import { retainedComplexIsNonzero } from "../circuit-reading.js";
import { simulateTransient } from "../transient-solver.js";

const part = (id: string, kind: CircuitPart["kind"], fields: Partial<CircuitPart> = {}): CircuitPart => ({ id, kind, label: id, x: 0, y: 0, ...fields });
const wire = (id: string, from: string, a: CircuitTerminal, to: string, b: CircuitTerminal) => ({ id, from: { partId: from, terminal: a }, to: { partId: to, terminal: b } });
const cases = (["nmos", "pmos"] as const).flatMap((kind) => [false, true].flatMap((reverse) => (["drain", "gate"] as const).map((control) => ({ kind, reverse, control }))));

function controlDocument({ kind, reverse, control }: typeof cases[number]): CircuitDocument {
  const sign = kind === "nmos" ? 1 : -1;
  const source = (id: string, dynamic: boolean) => part(id, "ac-source", dynamic
    ? { voltageVolts: 0.01, frequencyHz: 1, phaseDegrees: sign === 1 ? -90 : 90 }
    : { voltageVolts: 0, offsetVolts: sign, frequencyHz: 1 });
  return {
    title: "MOS amplification of a control below the binary64 range",
    parts: [part("g", "ground"), source("drain", control === "drain"), source("gate", control === "gate"),
      part("m", kind, { thresholdVolts: 0, transconductanceAmpsPerVoltSquared: 1e308, channelLengthModulation: control === "gate" ? 1e308 : 0 })],
    wires: [wire("d", "drain", "a", "m", reverse ? "c" : "a"), wire("dr", "drain", "b", "g", "a"),
      wire("gs", "gate", "a", "m", "b"), wire("gr", "gate", "b", "g", "a"), wire("s", "m", reverse ? "a" : "c", "g", "a")],
  };
}

it.each(cases)("retains amplified $kind $control current with reverse=$reverse", (test) => {
  const result = simulateTransient(controlDocument(test), { durationSeconds: Number.MIN_VALUE, timeStepSeconds: Number.MIN_VALUE });
  const sign = (test.kind === "nmos" ? 1 : -1) * (test.reverse ? -1 : 1);
  // sin(2*pi*dt) differs from 2*pi*dt far below binary64 precision here.
  // Scale before multiplication so this independent square-law oracle never
  // rounds the control to zero or overflows beta*lambda.
  const scaledVoltage = (1e308 * Number.MIN_VALUE) * (Math.SQRT2 * 0.01 * 2 * Math.PI);
  const expected = sign * (test.control === "drain" ? scaledVoltage : 0.5 * scaledVoltage ** 2);
  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(2);
  const reading = result.samples[1]!.parts.m!;
  expect(reading.currentAmps / expected).toBeCloseTo(1, 13);
  expect(reading.terminalCurrents!.a! / expected).toBeCloseTo(1, 13);
  expect(reading.terminalCurrents!.c! / -expected).toBeCloseTo(1, 13);
  expect(reading.channelConducting).toBe(true);
  expect(Math.abs(result.samples[1]!.parts[test.control]!.voltageVolts)).toBe(0);
});

it.each((["nmos", "pmos"] as const).flatMap((kind) => [false, true].map((reverse) => ({ kind, reverse }))))(
  "retains a DC divider's subnormal $kind gate bias with reverse=$reverse",
  ({ kind, reverse }) => {
    const document = controlDocument({ kind, reverse, control: "gate" });
    const gate = document.parts.find(({ id }) => id === "gate")!;
    gate.voltageVolts = 0;
    gate.offsetVolts = (kind === "nmos" ? 1 : -1) * Number.MIN_VALUE;
    document.parts.push(part("upper", "resistor", { resistanceOhms: 2 }), part("lower", "resistor", { resistanceOhms: 1 }));
    document.wires = document.wires.filter(({ id }) => id !== "gs");
    document.wires.push(wire("gu", "gate", "a", "upper", "a"), wire("um", "upper", "b", "m", "b"),
      wire("ml", "m", "b", "lower", "a"), wire("lg", "lower", "b", "g", "a"));
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    const scaledVoltage = (1e308 * Number.MIN_VALUE) / 3;
    const sign = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.m!.current.real / (sign * 0.5 * scaledVoltage ** 2)).toBeCloseTo(1, 13);
  },
);

it("keeps a long subnormal MOS discharge bounded while retaining nonzero stored currents", () => {
  const document: CircuitDocument = {
    title: "Subnormal square-law discharge",
    parts: [part("g", "ground"), part("c", "capacitor", { capacitanceFarads: 1, initialVoltageVolts: Number.MIN_VALUE }),
      part("m", "nmos", { thresholdVolts: 0, transconductanceAmpsPerVoltSquared: 1e308, channelLengthModulation: 0 })],
    wires: [wire("ca", "c", "a", "m", "a"), wire("gate", "m", "a", "m", "b"), wire("cb", "c", "b", "g", "a"), wire("source", "m", "c", "g", "a")],
  };
  const result = simulateTransient(document, { durationSeconds: 100 * Number.MIN_VALUE, timeStepSeconds: Number.MIN_VALUE });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(101);
  expect(JSON.stringify(result).length).toBeLessThan(2_000_000);
  for (const sample of result.samples) {
    expect(sample.parts.c!.voltageVolts).toBe(Number.MIN_VALUE);
    expect(sample.parts.m!.channelConducting).toBe(true);
    expect(retainedComplexIsNonzero(sample.parts.m!.exactTerminalCurrents?.a, result.precisionExpressions)).toBe(true);
  }
// A hundred exact history steps exposes nonlinear denominator growth without
// making the suite depend on the much longer extreme-value benchmark.
}, 15_000);
