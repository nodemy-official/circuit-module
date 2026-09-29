import { expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeAnalogCircuit, type ComplexValue } from "../analog-solver.js";

function part(id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...fields };
}

function wire(
  id: string,
  fromPartId: string,
  fromTerminal: CircuitTerminal,
  toPartId: string,
  toTerminal: CircuitTerminal,
) {
  return { id, from: { partId: fromPartId, terminal: fromTerminal }, to: { partId: toPartId, terminal: toTerminal } };
}

interface SeriesCase {
  label: string;
  reactive: "capacitor" | "inductor";
  resistance: number;
  reactance: number;
  voltage: number;
}

function documentForSeriesCase(testCase: SeriesCase): CircuitDocument {
  const { reactive, resistance, reactance, voltage } = testCase;
  // Choose an exactly convenient physical value pair whose product yields the
  // requested impedance scale after the 2π factor, without overflowing.
  const frequencyHz = 0.5;
  const reactiveValue = reactive === "capacitor"
    ? 1 / (Math.PI * reactance)
    : reactance / Math.PI;
  return {
    title: testCase.label,
    parts: [
      part("source", "ac-source", { voltageVolts: voltage, frequencyHz }),
      part("resistor", "resistor", { resistanceOhms: resistance }),
      part(reactive, reactive, reactive === "capacitor"
        ? { capacitanceFarads: reactiveValue }
        : { inductanceHenries: reactiveValue }),
      part("ground", "ground"),
    ],
    wires: [
      wire("w1", "source", "a", "resistor", "a"),
      wire("w2", "resistor", "b", reactive, "a"),
      wire("w3", reactive, "b", "source", "b"),
      wire("w4", "ground", "a", "source", "b"),
    ],
  };
}

function expectedSeries(testCase: SeriesCase) {
  const { resistance, reactance, voltage, reactive } = testCase;
  const scale = Math.max(resistance, reactance);
  const normalizedResistance = resistance / scale;
  const normalizedReactance = reactance / scale;
  const denominator = normalizedResistance ** 2 + normalizedReactance ** 2;
  const quadratureSign = reactive === "capacitor" ? 1 : -1;
  const current = {
    real: (voltage / scale) * normalizedResistance / denominator,
    imaginary: (voltage / scale) * quadratureSign * normalizedReactance / denominator,
  };
  // Form the cross term before the tiny impedance ratio is rounded to zero.
  const crossVoltage = voltage / scale === 0
    ? voltage * (Math.min(resistance, reactance) / scale) *
      (Math.max(resistance, reactance) / scale) / denominator
    : ((voltage / scale) * Math.min(resistance, reactance)) *
      (Math.max(resistance, reactance) / scale) / denominator;
  const resistorVoltage = {
    real: ((voltage * normalizedResistance) * normalizedResistance) / denominator,
    imaginary: quadratureSign * crossVoltage,
  };
  const reactiveVoltage = {
    real: ((voltage * normalizedReactance) * normalizedReactance) / denominator,
    imaginary: -quadratureSign * crossVoltage,
  };
  return { current, resistorVoltage, reactiveVoltage };
}

function expectRelative(actual: ComplexValue, expected: ComplexValue, label: string) {
  for (const component of ["real", "imaginary"] as const) {
    const a = actual[component];
    const e = expected[component];
    const scale = Math.max(Math.abs(a), Math.abs(e));
    if (scale === 0) {
      if (a !== 0) { throw new Error(`${label}.${component}: actual ${a}, expected ${e}`); }
      continue;
    }
    const relativeError = Math.abs(a - e) / scale;
    if (!(relativeError < 2e-7)) {
      throw new Error(`${label}.${component}: actual ${a}, expected ${e}, relative error ${relativeError}`);
    }
  }
}

it.each<SeriesCase>([
  { label: "RC at a subnormal-adjacent low reactance", reactive: "capacitor", resistance: 1e-300, reactance: 1e-300, voltage: 1 },
  { label: "RC at an extreme high reactance", reactive: "capacitor", resistance: 1e300, reactance: 1e300, voltage: 1 },
  { label: "RC with a 600-decade resistance ratio", reactive: "capacitor", resistance: 1e-300, reactance: 1e300, voltage: 1 },
  { label: "RC with a 600-decade inverse resistance ratio", reactive: "capacitor", resistance: 1e300, reactance: 1e-300, voltage: 1 },
  { label: "RL at a subnormal-adjacent low reactance", reactive: "inductor", resistance: 1e-300, reactance: 1e-300, voltage: 1 },
  { label: "RL at an extreme high reactance", reactive: "inductor", resistance: 1e300, reactance: 1e300, voltage: 1 },
  { label: "RL with a 600-decade resistance ratio", reactive: "inductor", resistance: 1e-300, reactance: 1e300, voltage: 1 },
  { label: "RL with a 600-decade inverse resistance ratio", reactive: "inductor", resistance: 1e300, reactance: 1e-300, voltage: 1 },
])("matches an independently normalized series $reactive oracle: $label", (testCase) => {
  const result = analyzeAnalogCircuit(documentForSeriesCase(testCase), { mode: "ac" });
  expect(result.status, result.message).toBe("valid");

  const expected = expectedSeries(testCase);
  expectRelative(result.parts.resistor.current, expected.current, "resistor.current");
  expectRelative(result.parts[ testCase.reactive ]!.current, expected.current, `${testCase.reactive}.current`);
  expectRelative(result.parts.resistor.voltage, expected.resistorVoltage, "resistor.voltage");
  expectRelative(result.parts[ testCase.reactive ]!.voltage, expected.reactiveVoltage, `${testCase.reactive}.voltage`);
});

it("keeps normalized series AC answers across a deterministic 600-decade R/X grid", () => {
  const exponents = [-300, -200, -100, 0, 31, 32, 33, 100, 200, 300];
  for (const reactive of ["capacitor", "inductor"] as const) {
    for (const resistanceExponent of exponents) {
      for (const reactanceExponent of exponents) {
        const testCase: SeriesCase = {
          label: `${reactive} R=1e${resistanceExponent} X=1e${reactanceExponent}`,
          reactive,
          resistance: 10 ** resistanceExponent,
          reactance: 10 ** reactanceExponent,
          voltage: 1,
        };
        const result = analyzeAnalogCircuit(documentForSeriesCase(testCase), { mode: "ac" });
        expect(result.status, `${testCase.label}: ${result.message}`).toBe("valid");

        const expected = expectedSeries(testCase);
        expectRelative(result.parts.resistor.current, expected.current, `${testCase.label}.current`);
        expectRelative(result.parts.resistor.voltage, expected.resistorVoltage, `${testCase.label}.R voltage`);
        expectRelative(
          result.parts[reactive]!.voltage,
          expected.reactiveVoltage,
          `${testCase.label}.reactive voltage`,
        );
      }
    }
  }
});

it("preserves AC series voltages when source and impedance scales vary together", () => {
  const impedanceExponents = [-200, -100, 0, 100, 200];
  const sourceExponents = [-300, -200, -100, 0, 100];
  for (const reactive of ["capacitor", "inductor"] as const) {
    for (const resistanceExponent of impedanceExponents) {
      for (const reactanceExponent of impedanceExponents) {
        const largestImpedanceExponent = Math.max(resistanceExponent, reactanceExponent);
        for (const sourceExponent of sourceExponents) {
          // Keep current and apparent power inside binary64, so failures
          // expose a voltage-calculation error rather than an overflow.
          if (sourceExponent - largestImpedanceExponent > 300 ||
            2 * sourceExponent - largestImpedanceExponent > 300) { continue; }
          const testCase: SeriesCase = {
            label: `${reactive} R=1e${resistanceExponent} X=1e${reactanceExponent} V=1e${sourceExponent}`,
            reactive,
            resistance: 10 ** resistanceExponent,
            reactance: 10 ** reactanceExponent,
            voltage: 10 ** sourceExponent,
          };
          const result = analyzeAnalogCircuit(documentForSeriesCase(testCase), { mode: "ac" });
          expect(result.status, `${testCase.label}: ${result.message}`).toBe("valid");
          const expected = expectedSeries(testCase);
          expectRelative(result.parts.resistor.voltage, expected.resistorVoltage, `${testCase.label}.R voltage`);
          expectRelative(result.parts[reactive]!.voltage, expected.reactiveVoltage, `${testCase.label}.reactive voltage`);
        }
      }
    }
  }
});

it.each([
  { kind: "capacitor" as const, frequencyHz: 1e308, value: 1e-100 },
  { kind: "capacitor" as const, frequencyHz: 1e-308, value: 1e308 },
  { kind: "inductor" as const, frequencyHz: 1e308, value: 1e-100 },
  { kind: "inductor" as const, frequencyHz: 1e-308, value: 1e308 },
])("matches the series oracle at extreme $kind frequency $frequencyHz Hz", ({ kind, frequencyHz, value }) => {
  const angularProduct = (frequencyHz * value) * (2 * Math.PI);
  const reactance = kind === "capacitor" ? 1 / angularProduct : angularProduct;
  const document: CircuitDocument = {
    title: `極端周波数の${kind}交流解析`,
    parts: [
      part("source", "ac-source", { voltageVolts: reactance, frequencyHz }),
      part("resistor", "resistor", { resistanceOhms: reactance }),
      part(kind, kind, kind === "capacitor"
        ? { capacitanceFarads: value }
        : { inductanceHenries: value }),
      part("ground", "ground"),
    ],
    wires: [
      wire("w1", "source", "a", "resistor", "a"),
      wire("w2", "resistor", "b", kind, "a"),
      wire("w3", kind, "b", "source", "b"),
      wire("w4", "ground", "a", "source", "b"),
    ],
  };
  const result = analyzeAnalogCircuit(document, { mode: "ac" });
  expect(result.status, result.message).toBe("valid");

  const sign = kind === "capacitor" ? 1 : -1;
  const current = { real: 0.5, imaginary: sign * 0.5 };
  const resistorVoltage = { real: reactance / 2, imaginary: sign * reactance / 2 };
  const reactiveVoltage = { real: reactance / 2, imaginary: -sign * reactance / 2 };
  expectRelative(result.parts.resistor.current, current, `${kind}.current`);
  expectRelative(result.parts[kind]!.current, current, `${kind}.current`);
  expectRelative(result.parts.resistor.voltage, resistorVoltage, `${kind}.resistor voltage`);
  expectRelative(result.parts[kind]!.voltage, reactiveVoltage, `${kind}.reactive voltage`);
});
