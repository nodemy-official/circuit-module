import { expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { restoredComplex } from "../circuit-reading.js";
import { analysisAtTransientFrame, circuitNodes } from "../circuit-visualization.js";
import { exactComplexValue } from "../exact-numeric-state.js";
import { simulateTransient } from "../transient-solver.js";

interface Fraction { numerator: bigint; denominator: bigint; }

function binaryFraction(value: number): Fraction {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits / 2n ** 52n) % 2048n);
  const significand = bits % 2n ** 52n + (exponent === 0 ? 0n : 2n ** 52n);
  const power = exponent === 0 ? -1074 : exponent - 1075;
  return { numerator: significand * (power >= 0 ? 2n ** BigInt(power) : 1n), denominator: power < 0 ? 2n ** BigInt(-power) : 1n };
}

const cases = (["diode", "led"] as const).flatMap((kind) => [-1, 1].flatMap((sign) => [false, true].map((commonMode) => ({ kind, sign, commonMode }))));

it.each(cases)("preserves subnormal diode discharge current ($kind, sign=$sign, commonMode=$commonMode)", ({ kind, sign, commonMode }) => {
  const document: CircuitDocument = {
    title: "Exact small diode control",
    parts: [
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1, initialVoltageVolts: sign * Number.MIN_VALUE },
      { id: "d", kind, label: "D", x: 0, y: 0, saturationCurrentAmps: 1, emissionCoefficient: kind === "led" ? 2 : 1 },
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
      ...(commonMode ? [{ id: "base", kind: "battery" as const, label: "Base", x: 0, y: 0, voltageVolts: 1 }] : []),
    ], wires: [
      { id: "a", from: { partId: "c", terminal: "a" }, to: { partId: "d", terminal: "a" } },
      { id: "b", from: { partId: "c", terminal: "b" }, to: { partId: "d", terminal: "b" } },
      { id: "ref", from: { partId: "c", terminal: "b" }, to: { partId: commonMode ? "base" : "g", terminal: "a" } },
      ...(commonMode ? [{ id: "bg", from: { partId: "base", terminal: "b" as const }, to: { partId: "g", terminal: "a" as const } }] : []),
    ],
  };
  const original = simulateTransient(document, { durationSeconds: 4 / 128, timeStepSeconds: 1 / 128 });
  expect(original.status, original.message).toBe("valid");
  expect(original.samples).toHaveLength(5);
  // Independent BE oracle. At |V|<=MIN, the exponential's nonlinear term is
  // far below one binary64 ULP; I=V/(n*Vt), Vnext=Vprev*n*Vt/(n*Vt+h).
  const thermal = binaryFraction(0.025_85);
  const scale = { numerator: thermal.numerator * (kind === "led" ? 2n : 1n), denominator: thermal.denominator };
  const h = { numerator: 1n, denominator: 128n };
  let expected: Fraction = { numerator: BigInt(sign), denominator: 2n ** 1074n };
  const voltages: Fraction[] = [];
  for (let index = 1; index <= 4; index += 1) {
    expected = { numerator: expected.numerator * scale.numerator * h.denominator,
      denominator: expected.denominator * (scale.numerator * h.denominator + h.numerator * scale.denominator) };
    voltages.push(expected);
  }
  for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    for (const [index, voltage] of voltages.entries()) {
      const frame = analysisAtTransientFrame(document, { analysis, sampleIndex: index + 1 })!;
      const actualVoltage = exactComplexValue(restoredComplex(frame.parts.c!.exactVoltage, frame.precisionExpressions)!)!.real;
      expect(actualVoltage.numerator * voltage.denominator).toBe(voltage.numerator * actualVoltage.denominator);
      const current = { numerator: voltage.numerator * scale.denominator, denominator: voltage.denominator * scale.numerator };
      const actualCurrent = exactComplexValue(restoredComplex(frame.parts.d!.exactTerminalCurrents!.a, frame.precisionExpressions)!)!.real;
      expect(actualCurrent.numerator * current.denominator).toBe(current.numerator * actualCurrent.denominator);
      expect(frame.status).toBe("closed");
      expect(circuitNodes(document, frame).every((node) => node.currentResidualAmps === 0)).toBe(true);
    }
    if (kind === "diode") { expect(analysis.samples[1]!.parts.d!.currentAmps).toBe(sign * 30 * Number.MIN_VALUE); }
  }
});
