import { expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { restoredComplex } from "../circuit-reading.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential } from "../circuit-visualization.js";
import { exactComplexValue } from "../exact-numeric-state.js";
import { simulateTransient } from "../transient-solver.js";
import type { ExactExpressionNode } from "../exact-expression.js";

interface Fraction { numerator: bigint; denominator: bigint; }

function gcd(first: bigint, second: bigint): bigint {
  let left = first < 0n ? -first : first;
  let right = second < 0n ? -second : second;
  while (right !== 0n) { [left, right] = [right, left % right]; }
  return left;
}

function binaryFraction(value: number): Fraction {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits / 2n ** 52n) % 2048n);
  const significand = bits % 2n ** 52n + (exponent === 0 ? 0n : 2n ** 52n);
  const power = exponent === 0 ? -1074 : exponent - 1075;
  const numerator = significand * (power >= 0 ? 2n ** BigInt(power) : 1n);
  const denominator = power < 0 ? 2n ** BigInt(-power) : 1n;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function product(first: Fraction, second: Fraction): Fraction {
  const left = gcd(first.numerator, second.denominator);
  const right = gcd(second.numerator, first.denominator);
  return { numerator: (first.numerator / left) * (second.numerator / right),
    denominator: (first.denominator / right) * (second.denominator / left) };
}

function rcDocument(): CircuitDocument {
  return {
    title: "Long exact RC discharge",
    parts: [
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1e-12, initialVoltageVolts: 1 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 100 },
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "a", from: { partId: "c", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "c", terminal: "b" }, to: { partId: "r", terminal: "b" } },
      { id: "g", from: { partId: "c", terminal: "b" }, to: { partId: "g", terminal: "a" } },
    ],
  };
}

it("saves a maximum-length discharge and restores exact voltage and KCL after JSON or structured cloning", () => {
  const document = rcDocument();
  const original = simulateTransient(document, { durationSeconds: 2, timeStepSeconds: 0.001 });
  expect(original.status, original.message).toBe("valid");
  expect(original.samples).toHaveLength(2001);
  const serialized = JSON.stringify(original);
  // The previous expanded per-sample fractions exceeded Node's string limit
  // (548,665,885 characters). Exact transport must remain practical to save.
  expect(serialized.length).toBeLessThan(8_000_000);
  const checkpoints = new Map<number, Fraction>();
  const rc = product(binaryFraction(100), binaryFraction(1e-12));
  let voltage: Fraction = { numerator: 1n, denominator: 1n };
  for (let index = 1; index < original.samples.length; index += 1) {
    const h = binaryFraction(original.samples[index]!.timeSeconds - original.samples[index - 1]!.timeSeconds);
    // Independent backward-Euler oracle: Vn/Vn-1 = RC/(RC+h).
    const common = rc.numerator * h.denominator;
    voltage = product(voltage, { numerator: common, denominator: common + h.numerator * rc.denominator });
    if (index === 1 || index === 80 || index === 2000) { checkpoints.set(index, voltage); }
  }
  for (const analysis of [original, JSON.parse(serialized) as typeof original, structuredClone(original)]) {
    for (const [sampleIndex, expected] of checkpoints) {
      const frame = analysisAtTransientFrame(document, { analysis, sampleIndex })!;
      expect(frame.status).toBe("closed");
      const retained = restoredComplex(frame.parts.c!.exactVoltage, frame.precisionExpressions)!;
      const actual = exactComplexValue(retained)!.real;
      expect(actual.numerator * expected.denominator).toBe(expected.numerator * actual.denominator);
      const nodes = circuitNodes(document, frame);
      expect(nodes.every((node) => node.currentResidualAmps === 0)).toBe(true);
      const context = { document, analysis: frame, nodes };
      const a = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "c" && endpoint.terminal === "a"));
      const b = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "c" && endpoint.terminal === "b"));
      expect(circuitPotential(a, b, false, context)?.volts).toBe(frame.parts.c!.voltageVolts);
    }
    const last = analysis.samples.at(-1)!.parts.c!;
    expect(last.voltageVolts).toBe(0);
    expect(Math.abs(last.currentAmps)).toBe(0);
  }
}, 60_000);

it.each([false, true])("retains compact exact history with an unexcited diode (separate zero-voltage node: %s)", (separateNode) => {
  const document = rcDocument();
  document.parts[0]!.capacitanceFarads = 2 ** -1000;
  document.parts.push({ id: "d", kind: "diode", label: "D", x: 0, y: 0 });
  document.wires.push(
    { id: "da", from: { partId: "d", terminal: "a" }, to: { partId: separateNode ? "zero" : "g", terminal: "a" } },
    { id: "db", from: { partId: "d", terminal: "b" }, to: { partId: "g", terminal: "a" } },
  );
  if (separateNode) {
    document.parts.push({ id: "zero", kind: "ac-source", label: "Zero", x: 0, y: 0, voltageVolts: 0, frequencyHz: 50 });
    document.wires.push({ id: "zb", from: { partId: "zero", terminal: "b" }, to: { partId: "g", terminal: "a" } });
  }
  const steps = separateNode ? 100 : 800;
  const original = simulateTransient(document, { durationSeconds: steps / 128, timeStepSeconds: 1 / 128 });
  expect(original.status, original.message).toBe("valid");
  expect(original.samples).toHaveLength(steps + 1);
  const json = JSON.stringify(original);
  expect(json.length).toBeLessThan(separateNode ? 4_000_000 : 16_000_000);
  for (const analysis of [original, JSON.parse(json) as typeof original, structuredClone(original)]) {
    for (const sampleIndex of new Set([1, 100, steps])) {
      const frame = analysisAtTransientFrame(document, { analysis, sampleIndex })!;
      const exact = exactComplexValue(restoredComplex(frame.parts.c!.exactVoltage, frame.precisionExpressions)!)!.real;
      // Independent RC/(RC+h)=25/(25+2^991); grounded diode carries no current.
      expect(exact.numerator * (25n + 2n ** 991n) ** BigInt(sampleIndex)).toBe(25n ** BigInt(sampleIndex) * exact.denominator);
      expect(frame.parts.d!.currentAmps).toBe(0);
      expect(frame.status).toBe("closed");
      expect(circuitNodes(document, frame).every((node) => node.currentResidualAmps === 0)).toBe(true);
    }
  }
}, 60_000);

it.each([
  { operation: "literal", numerator: "0x1", denominator: "0x0" },
  { operation: "literal", numerator: "0x0", denominator: "0x1" },
  { operation: "divide", arguments: [0, 0] },
] satisfies ExactExpressionNode[])("ignores unusable expression metadata in activity detection (%s)", (node) => {
  const document = rcDocument();
  document.parts[0]!.initialVoltageVolts = 0;
  document.parts[0]!.capacitanceFarads = 0.001;
  const original = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
  expect(original.status).toBe("valid");
  original.precisionExpressions = Object.freeze([Object.freeze(node)]);
  original.samples[1]!.parts.c!.exactVoltage = { real: { expression: 0, sign: 1 }, imaginary: { numerator: "0x0", denominator: "0x1" } };
  for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    const frame = analysisAtTransientFrame(document, { analysis, sampleIndex: 1 })!;
    expect(frame.status).toBe("idle");
    expect(frame.parts.c!.voltageVolts).toBe(0);
    expect(circuitNodes(document, frame).every((value) => value.currentResidualAmps === 0)).toBe(true);
  }
});
