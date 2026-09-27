import { expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeCircuit, type CircuitPartReading } from "./circuit-solver.js";

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

interface Phasor {
  real: number;
  imaginary: number;
}

function multiply(left: Phasor, right: Phasor): Phasor {
  return {
    real: left.real * right.real - left.imaginary * right.imaginary,
    imaginary: left.real * right.imaginary + left.imaginary * right.real,
  };
}

function fromPolar(magnitude: number, phaseDegrees: number): Phasor {
  const phase = phaseDegrees * Math.PI / 180;
  return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
}

function toPolar(value: Phasor) {
  return {
    magnitude: Math.hypot(value.real, value.imaginary),
    phaseDegrees: Math.atan2(value.imaginary, value.real) * 180 / Math.PI,
  };
}

function expectPhasorClose(actual: Phasor, expected: Phasor, label: string) {
  const scale = Math.max(Math.abs(actual.real), Math.abs(actual.imaginary), Math.abs(expected.real), Math.abs(expected.imaginary));
  const realError = Math.abs(actual.real - expected.real) / scale;
  const imaginaryError = Math.abs(actual.imaginary - expected.imaginary) / scale;
  if (!(realError < 2e-7) || !(imaginaryError < 2e-7)) {
    throw new Error(`${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} relativeErrors=${realError},${imaginaryError}`);
  }
}

function terminalPhasor(reading: CircuitPartReading, terminal: CircuitTerminal): Phasor {
  const magnitude = reading.terminalVoltages?.[terminal];
  const phase = reading.terminalVoltagePhasesDegrees?.[terminal];
  if (magnitude === undefined || phase === undefined) {
    throw new Error(`${terminal} terminal magnitude and phase must be present`);
  }
  return fromPolar(magnitude, phase);
}

const sourcePhaseDegrees = 37;
const frequencyHz = 0.5;

interface ExtremeSeriesCase {
  label: string;
  resistance: number;
  reactance: number;
  /** Tiny drops between high common-mode nodes cannot be reconstructed from terminal potentials. */
  checkResistorTerminalDifference: boolean;
  checkReactiveTerminalDifference: boolean;
}

const extremeSeriesCases: ExtremeSeriesCase[] = [
  {
    label: "balanced 1e300 ohm impedances",
    resistance: 1e300,
    reactance: 1e300,
    checkResistorTerminalDifference: true,
    checkReactiveTerminalDifference: true,
  },
  {
    label: "1e-300 ohm resistor against 1e300 ohm reactance",
    resistance: 1e-300,
    reactance: 1e300,
    checkResistorTerminalDifference: false,
    checkReactiveTerminalDifference: true,
  },
  {
    label: "1e300 ohm resistor against 1e-300 ohm reactance",
    resistance: 1e300,
    reactance: 1e-300,
    checkResistorTerminalDifference: true,
    checkReactiveTerminalDifference: false,
  },
];

function reactiveSeriesCircuit(
  kind: "capacitor" | "inductor",
  testCase: ExtremeSeriesCase,
): CircuitDocument {
  const reactiveValue = kind === "capacitor"
    ? 1 / (Math.PI * testCase.reactance)
    : testCase.reactance / Math.PI;
  return {
    title: `${testCase.label} / ${kind} の並列電圧計読み`,
    parts: [
      part("source", "ac-source", { voltageVolts: 1e300, frequencyHz, phaseDegrees: sourcePhaseDegrees }),
      part("resistor", "resistor", { resistanceOhms: testCase.resistance }),
      part(kind, kind, kind === "capacitor"
        ? { capacitanceFarads: reactiveValue }
        : { inductanceHenries: reactiveValue }),
      part("resistorMeter", "voltmeter"),
      part("reactiveMeter", "voltmeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-to-resistor", "source", "a", "resistor", "a"),
      wire("resistor-to-reactive", "resistor", "b", kind, "a"),
      wire("reactive-to-source", kind, "b", "source", "b"),
      wire("resistor-meter-positive", "resistorMeter", "a", "resistor", "a"),
      wire("resistor-meter-negative", "resistorMeter", "b", "resistor", "b"),
      wire("reactive-meter-positive", "reactiveMeter", "a", kind, "a"),
      wire("reactive-meter-negative", "reactiveMeter", "b", kind, "b"),
      wire("reference", "ground", "a", "source", "b"),
    ],
  };
}

function independentSeriesOracle(kind: "capacitor" | "inductor", testCase: ExtremeSeriesCase) {
  // Derive the series response from normalized impedance; scaling avoids R² + X² overflow.
  const reactiveValue = kind === "capacitor"
    ? 1 / (Math.PI * testCase.reactance)
    : testCase.reactance / Math.PI;
  const reactance = kind === "capacitor"
    ? 1 / (2 * Math.PI * frequencyHz * reactiveValue)
    : 2 * Math.PI * frequencyHz * reactiveValue;
  const impedanceScale = Math.max(testCase.resistance, reactance);
  const normalizedResistance = testCase.resistance / impedanceScale;
  const normalizedReactance = reactance / impedanceScale;
  const denominator = normalizedResistance ** 2 + normalizedReactance ** 2;
  const source = fromPolar(1e300, sourcePhaseDegrees);
  const currentFactor = {
    real: normalizedResistance / denominator / impedanceScale,
    imaginary: (kind === "capacitor" ? 1 : -1) * normalizedReactance / denominator / impedanceScale,
  };
  const current = multiply(source, currentFactor);
  const resistorVoltage = multiply(current, { real: testCase.resistance, imaginary: 0 });
  const reactiveVoltage = multiply(current, {
    real: 0,
    imaginary: kind === "capacitor" ? -reactance : reactance,
  });
  return { resistorVoltage, reactiveVoltage };
}

it.each(extremeSeriesCases.flatMap((testCase) => (["capacitor", "inductor"] as const).map((kind) => ({ testCase, kind }))))(
  "keeps $kind component, terminal, and parallel-meter phasors aligned at $testCase.label",
  ({ kind, testCase }) => {
    const result = analyzeCircuit(reactiveSeriesCircuit(kind, testCase), {}, { mode: "ac" });
    expect(result.status, result.message).toBe("closed");

    const expected = independentSeriesOracle(kind, testCase);
    const resistor = result.parts.resistor!;
    const component = result.parts[kind]!;
    const resistorMeter = result.parts.resistorMeter!;
    const reactiveMeter = result.parts.reactiveMeter!;
    const resistorVoltage = fromPolar(resistor.voltageVolts, resistor.voltagePhaseDegrees!);
    const componentVoltage = fromPolar(component.voltageVolts, component.voltagePhaseDegrees!);
    const resistorMeterVoltage = fromPolar(resistorMeter.voltageVolts, resistorMeter.voltagePhaseDegrees!);
    const reactiveMeterVoltage = fromPolar(reactiveMeter.voltageVolts, reactiveMeter.voltagePhaseDegrees!);
    const resistorTerminalA = terminalPhasor(resistor, "a");
    const resistorTerminalB = terminalPhasor(resistor, "b");
    const terminalA = terminalPhasor(component, "a");
    const terminalB = terminalPhasor(component, "b");
    const resistorTerminalVoltage = {
      real: resistorTerminalA.real - resistorTerminalB.real,
      imaginary: resistorTerminalA.imaginary - resistorTerminalB.imaginary,
    };
    const terminalVoltage = {
      real: terminalA.real - terminalB.real,
      imaginary: terminalA.imaginary - terminalB.imaginary,
    };

    expect(resistorMeter.meterStatus).toBe("connected");
    expect(reactiveMeter.meterStatus).toBe("connected");
    expectPhasorClose(resistorVoltage, expected.resistorVoltage, "resistor component voltage");
    expectPhasorClose(componentVoltage, expected.reactiveVoltage, `${kind} component voltage`);
    expectPhasorClose(resistorMeterVoltage, expected.resistorVoltage, "resistor voltmeter voltage");
    expectPhasorClose(reactiveMeterVoltage, expected.reactiveVoltage, `${kind} voltmeter voltage`);
    if (testCase.checkResistorTerminalDifference) {
      expectPhasorClose(resistorTerminalVoltage, expected.resistorVoltage, "resistor terminal voltage");
    }
    if (testCase.checkReactiveTerminalDifference) {
      expectPhasorClose(terminalVoltage, expected.reactiveVoltage, `${kind} terminal voltage`);
    }

    const expectedResistorPolar = toPolar(expected.resistorVoltage);
    const expectedPolar = toPolar(expected.reactiveVoltage);
    expect(Math.abs(resistor.voltageVolts - expectedResistorPolar.magnitude) / expectedResistorPolar.magnitude)
      .toBeLessThan(2e-7);
    expect(Math.abs(component.voltageVolts - expectedPolar.magnitude) / expectedPolar.magnitude)
      .toBeLessThan(2e-7);
    expect(Math.abs(resistorMeter.voltageVolts - expectedResistorPolar.magnitude) / expectedResistorPolar.magnitude)
      .toBeLessThan(2e-7);
    expect(Math.abs(reactiveMeter.voltageVolts - expectedPolar.magnitude) / expectedPolar.magnitude)
      .toBeLessThan(2e-7);
    expect(resistor.voltagePhaseDegrees).toBeCloseTo(expectedResistorPolar.phaseDegrees, 6);
    expect(component.voltagePhaseDegrees).toBeCloseTo(expectedPolar.phaseDegrees, 6);
    expect(resistorMeter.voltagePhaseDegrees).toBeCloseTo(expectedResistorPolar.phaseDegrees, 6);
    expect(reactiveMeter.voltagePhaseDegrees).toBeCloseTo(expectedPolar.phaseDegrees, 6);
  },
);
