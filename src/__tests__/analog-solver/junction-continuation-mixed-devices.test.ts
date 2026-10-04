import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const thermalVoltage = 0.025_85;
const saturation = 1e-12;
const groundResistance = [300, 160_000, 230];
const supplyResistance = [200_000, 13_000, 180];
const modes = ["dc", "ac", "transient"] as const;
const companions = ["zero-amplifier", "observer", "bjt", "current-driven-mos"] as const;

function operatingPoint() {
  const conductance = groundResistance.map((resistance, node) => 1 / resistance + 1 / supplyResistance[node]!);
  const voltagesAt = (first: number) => {
    const firstCurrent = conductance[0]! * first - 24 / supplyResistance[0]! - saturation;
    const second = first + thermalVoltage * Math.log1p(firstCurrent / saturation);
    const secondCurrent = firstCurrent + conductance[1]! * second - 24 / supplyResistance[1]!;
    const third = second + thermalVoltage * Math.log1p(secondCurrent / saturation);
    return { second, third, residual: conductance[2]! * third - 24 / supplyResistance[2]! + secondCurrent + saturation };
  };
  let low = 1;
  let high = 14;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const middle = (low + high) / 2;
    if (voltagesAt(middle).residual < 0) { low = middle; }
    else { high = middle; }
  }
  const firstVoltage = (low + high) / 2;
  const { second, third } = voltagesAt(firstVoltage);
  return [firstVoltage, second, third];
}

function smallSignal() {
  const voltages = operatingPoint();
  const matrix = groundResistance.map((resistance, row) => groundResistance.map((_other, column) =>
    row === column ? 1 / resistance + 1 / supplyResistance[row]! : 0));
  for (const [anode, cathode] of [[0, 2], [2, 1], [1, 0]]) {
    const slope = saturation * Math.exp((voltages[anode!]! - voltages[cathode!]!) / thermalVoltage) / thermalVoltage;
    matrix[anode!]![anode!]! += slope;
    matrix[cathode!]![cathode!]! += slope;
    matrix[anode!]![cathode!]! -= slope;
    matrix[cathode!]![anode!]! -= slope;
  }
  const rhs = supplyResistance.map((resistance) => 0.001 / resistance);
  for (let pivot = 0; pivot < 3; pivot += 1) {
    for (let row = pivot + 1; row < 3; row += 1) {
      const factor = matrix[row]![pivot]! / matrix[pivot]![pivot]!;
      for (let column = pivot; column < 3; column += 1) { matrix[row]![column]! -= factor * matrix[pivot]![column]!; }
      rhs[row]! -= factor * rhs[pivot]!;
    }
  }
  const response = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let value = rhs[row]!;
    for (let column = row + 1; column < 3; column += 1) { value -= matrix[row]![column]! * response[column]!; }
    response[row] = value / matrix[row]![row]!;
  }
  return response;
}

function collectorVoltage() {
  const forward = saturation * Math.expm1(0.6 / thermalVoltage);
  let low = 0;
  let high = 0.6;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const voltage = (low + high) / 2;
    const reverse = saturation * Math.expm1((0.6 - voltage) / thermalVoltage);
    if (forward - 2 * reverse > (3 - voltage) / 1000) { high = voltage; }
    else { low = voltage; }
  }
  return (low + high) / 2;
}

function companionSpecs(companion: typeof companions[number]): CircuitSpec[] {
  if (companion === "zero-amplifier") { return [["amplifier", "op-amp", ["0", "0", "out"]]]; }
  if (companion === "observer") {
    return [["amplifier", "op-amp", ["n0", "out", "out"]],
      ["observed-load", "resistor", ["out", "0"], { resistanceOhms: 10_000 }]];
  }
  if (companion === "bjt") {
    return [["collector-supply", "battery", ["collector-supply", "0"], { voltageVolts: 3 }],
      ["base-supply", "battery", ["base", "0"], { voltageVolts: 0.6 }],
      ["collector-load", "resistor", ["collector-supply", "collector"], { resistanceOhms: 1000 }],
      ["transistor", "npn-transistor", ["collector", "base", "0"], { saturationCurrentAmps: saturation, currentGain: 100 }]];
  }
  return [["gate-supply", "battery", ["gate", "0"], { voltageVolts: 3 }],
    ["mos-current", "current-source", ["0", "drain"], { currentAmps: 0.75 }],
    ["mos", "nmos", ["drain", "gate", "0"], {
      thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0,
    }]];
}

function fixture(companion: typeof companions[number], mode: typeof modes[number], reverse: boolean) {
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["source", "ac-source", ["s", "0"], { offsetVolts: 24, voltageVolts: mode === "transient" ? 0 : 0.001 }],
    ...groundResistance.flatMap((resistance, node): CircuitSpec[] => [
      [`rg${node}`, "resistor", [`n${node}`, "0"], { resistanceOhms: resistance }],
      [`rs${node}`, "resistor", [`n${node}`, "s"], { resistanceOhms: supplyResistance[node]! }],
    ]),
    ["d1", "diode", ["n0", "n2"]],
    ["d2", "diode", ["n2", "n1"]],
    ["d3", "diode", ["n1", "n0"]],
    ...companionSpecs(companion),
  ];
  return createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Junction mesh with other nonlinear devices");
}

describe("junction continuation with other nonlinear devices", () => {
  it.each(companions.flatMap((companion) => modes.flatMap((mode) =>
    [false, true].map((reverse) => ({ companion, mode, reverse })))))
    ("keeps $companion solvable in $mode (reverse=$reverse)", ({ companion, mode, reverse }) => {
      const document = fixture(companion, mode, reverse);
      const original = JSON.stringify(document);
      const expected = mode === "ac" ? smallSignal() : operatingPoint();
      if (mode === "transient") {
        const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
        expect(result.status, result.message).toBe("valid");
        expect(result.samples).toHaveLength(2);
        for (const sample of result.samples) {
          for (const [node, voltage] of expected.entries()) {
            expect(Math.abs(sample.parts[`rg${node}`]!.voltageVolts / voltage - 1)).toBeLessThan(1e-10);
          }
          if (companion === "current-driven-mos") {
            expect(sample.parts.mos!.voltageVolts).toBe(0.5);
            expect(sample.parts.mos!.currentAmps).toBe(0.75);
          }
          if (companion === "bjt") {
            expect(Math.abs(sample.parts.transistor!.voltageVolts / collectorVoltage() - 1)).toBeLessThan(1e-10);
          }
        }
      } else {
        const result = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });
        expect(result.status, result.message).toBe("valid");
        for (const [node, voltage] of expected.entries()) {
          expect(Math.abs(result.parts[`rg${node}`]!.voltage.real / voltage - 1)).toBeLessThan(1e-10);
          expect(result.parts[`rg${node}`]!.voltage.imaginary).toBe(0);
        }
        if (companion === "zero-amplifier") { expect(result.parts.amplifier!.voltage.real).toBe(0); }
        if (companion === "observer") {
          const voltage = 100_000 * expected[0]! / (100_001 + 20 / 10_000);
          expect(Math.abs(result.parts.amplifier!.voltage.real / voltage - 1)).toBeLessThan(1e-10);
        }
        if (companion === "current-driven-mos") {
          expect(result.parts.mos!.voltage.real).toBe(mode === "dc" ? 0.5 : 0);
          expect(result.parts.mos!.current.real).toBe(mode === "dc" ? 0.75 : 0);
        }
        if (companion === "bjt") {
          if (mode === "dc") {
            const voltage = collectorVoltage();
            expect(Math.abs(result.parts.transistor!.voltage.real / voltage - 1)).toBeLessThan(1e-10);
            expect(Math.abs(result.parts.transistor!.current.real / ((3 - voltage) / 1000) - 1)).toBeLessThan(1e-10);
          } else {
            expect(result.parts.transistor!.voltage.real).toBe(0);
            expect(result.parts.transistor!.current.real).toBe(0);
          }
        }
        const powers = Object.values(result.parts).map(({ power }) => power.real);
        expect(Math.abs(powers.reduce((total, power) => total + power, 0)))
          .toBeLessThan(1e-11 * powers.reduce((total, power) => total + Math.abs(power), 0));
      }
      expect(JSON.stringify(document)).toBe(original);
    });
});
