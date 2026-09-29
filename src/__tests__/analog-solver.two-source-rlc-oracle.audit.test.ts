import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeAnalogCircuit } from "../analog-solver.js";
import { analyzeCircuit } from "../circuit-solver.js";

interface Phasor {
  real: number;
  imaginary: number;
}

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

const add = (left: Phasor, right: Phasor): Phasor => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

const divide = (left: Phasor, right: Phasor): Phasor => {
  const denominator = right.real ** 2 + right.imaginary ** 2;
  return {
    real: (left.real * right.real + left.imaginary * right.imaginary) / denominator,
    imaginary: (left.imaginary * right.real - left.real * right.imaginary) / denominator,
  };
};

const assertPhasorClose = (actual: Phasor, expected: Phasor) => {
  const error = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  const tolerance = 1e-10 + 2e-9 * Math.hypot(expected.real, expected.imaginary);
  if (error > tolerance) {
    throw new Error(`actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} error=${error}`);
  }
};

function sourcePhasor(magnitude: number, phaseDegrees: number): Phasor {
  const phase = (phaseDegrees * Math.PI) / 180;
  return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
}

function twoSourceRlcCircuit(): CircuitDocument {
  const frequencyHz = 73;
  return {
    title: "二つの交流源で駆動する並列RLC負荷",
    parts: [
      part("source-1", "ac-source", { voltageVolts: 9, phaseDegrees: 23, frequencyHz }),
      part("source-2", "ac-source", { voltageVolts: 5, phaseDegrees: -71, frequencyHz }),
      part("series-1", "resistor", { resistanceOhms: 130 }),
      part("series-2", "resistor", { resistanceOhms: 240 }),
      part("load", "resistor", { resistanceOhms: 470 }),
      part("capacitor", "capacitor", { capacitanceFarads: 33e-6 }),
      part("inductor", "inductor", { inductanceHenries: 68e-3 }),
      part("meter", "voltmeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-1-series", "source-1", "a", "series-1", "a"),
      wire("series-1-output", "series-1", "b", "load", "a"),
      wire("source-2-series", "source-2", "a", "series-2", "a"),
      wire("series-2-output", "series-2", "b", "load", "a"),
      wire("source-1-return", "source-1", "b", "ground", "a"),
      wire("source-2-return", "source-2", "b", "source-1", "b"),
      wire("load-return", "load", "b", "source-1", "b"),
      wire("capacitor-output", "capacitor", "a", "load", "a"),
      wire("capacitor-return", "capacitor", "b", "source-1", "b"),
      wire("inductor-output", "inductor", "a", "load", "a"),
      wire("inductor-return", "inductor", "b", "source-1", "b"),
      wire("meter-output", "meter", "a", "load", "a"),
      wire("meter-return", "meter", "b", "source-1", "b"),
    ],
  };
}

describe("AC two-source parallel-RLC voltage oracle", () => {
  it("matches the closed-form output and branch phasors", () => {
    const frequencyHz = 73;
    const omega = 2 * Math.PI * frequencyHz;
    const series1Ohms = 130;
    const series2Ohms = 240;
    const loadOhms = 470;
    const capacitanceFarads = 33e-6;
    const inductanceHenries = 68e-3;
    const source1 = sourcePhasor(9, 23);
    const source2 = sourcePhasor(5, -71);

    // The two source branches reduce to a Norton phasor feeding the passive parallel load.
    const nortonCurrent = add(
      { real: source1.real / series1Ohms, imaginary: source1.imaginary / series1Ohms },
      { real: source2.real / series2Ohms, imaginary: source2.imaginary / series2Ohms },
    );
    const totalAdmittance = {
      real: 1 / series1Ohms + 1 / series2Ohms + 1 / loadOhms,
      imaginary: omega * capacitanceFarads - 1 / (omega * inductanceHenries),
    };
    const outputVoltage = divide(nortonCurrent, totalAdmittance);
    const expectedSeries1Voltage = {
      real: source1.real - outputVoltage.real,
      imaginary: source1.imaginary - outputVoltage.imaginary,
    };
    const expectedSeries2Voltage = {
      real: source2.real - outputVoltage.real,
      imaginary: source2.imaginary - outputVoltage.imaginary,
    };

    const document = twoSourceRlcCircuit();
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });

    expect(result.status, result.message).toBe("valid");
    assertPhasorClose(result.parts.load.voltage, outputVoltage);
    assertPhasorClose(result.parts.capacitor.voltage, outputVoltage);
    assertPhasorClose(result.parts.inductor.voltage, outputVoltage);
    assertPhasorClose(result.parts["series-1"].voltage, expectedSeries1Voltage);
    assertPhasorClose(result.parts["series-2"].voltage, expectedSeries2Voltage);
    assertPhasorClose(result.parts["source-1"].voltage, source1);
    assertPhasorClose(result.parts["source-2"].voltage, source2);
    assertPhasorClose(result.parts.meter.voltage, outputVoltage);

    assertPhasorClose(result.parts.load.current, {
      real: outputVoltage.real / loadOhms,
      imaginary: outputVoltage.imaginary / loadOhms,
    });
    assertPhasorClose(result.parts.capacitor.current, {
      real: -omega * capacitanceFarads * outputVoltage.imaginary,
      imaginary: omega * capacitanceFarads * outputVoltage.real,
    });
    assertPhasorClose(result.parts.inductor.current, {
      real: outputVoltage.imaginary / (omega * inductanceHenries),
      imaginary: -outputVoltage.real / (omega * inductanceHenries),
    });

    const scalarResult = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const outputVoltageMagnitude = Math.hypot(outputVoltage.real, outputVoltage.imaginary);
    const outputPhaseDegrees = (Math.atan2(outputVoltage.imaginary, outputVoltage.real) * 180) / Math.PI;
    expect(scalarResult.status, scalarResult.message).toBe("closed");
    expect(scalarResult.parts.meter.voltageVolts).toBeCloseTo(outputVoltageMagnitude, 9);
    expect(scalarResult.parts.meter.voltagePhaseDegrees).toBeCloseTo(outputPhaseDegrees, 9);
    expect(scalarResult.parts.load.voltageVolts).toBeCloseTo(outputVoltageMagnitude, 9);
    expect(scalarResult.parts.capacitor.voltageVolts).toBeCloseTo(outputVoltageMagnitude, 9);
    expect(scalarResult.parts.inductor.voltageVolts).toBeCloseTo(outputVoltageMagnitude, 9);
  });
});
