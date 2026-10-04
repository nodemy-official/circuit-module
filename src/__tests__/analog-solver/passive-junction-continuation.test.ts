import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const supply = 24;
const saturation = 1e-12;
const thermalVoltage = 0.025_85;
const groundResistance = [683.426_686_076_684_7, 285.030_566_997_653_47, 161_456.120_245_542_73, 230.753_713_374_968_6];
const supplyResistance = [588.754_894_537_400_8, 223_392.387_408_689_95, 13_103.338_051_705_108, 185.288_788_010_258_37];

function diodeMesh(reverseOrder: boolean) {
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["supply", "battery", ["s", "input"], { voltageVolts: supply, internalResistanceOhms: 0 }],
    ["input", "ac-source", ["input", "0"], { voltageVolts: 0.001, offsetVolts: 0, frequencyHz: 1000 }],
    ...groundResistance.flatMap((resistance, node): CircuitSpec[] => [
      [`rg${node}`, "resistor", [`n${node}`, "0"], { resistanceOhms: resistance }],
      [`rs${node}`, "resistor", [`n${node}`, "s"], { resistanceOhms: supplyResistance[node]! }],
    ]),
    ["d1", "diode", ["n1", "n3"], { saturationCurrentAmps: saturation }],
    ["d2", "diode", ["n3", "n2"], { saturationCurrentAmps: saturation }],
    ["d3", "diode", ["n2", "n1"], { saturationCurrentAmps: saturation }],
    ["d4", "diode", ["n1", "n0"], { saturationCurrentAmps: saturation }],
  ];
  return createCircuitFromSpecs(reverseOrder ? specs.reverse() : specs, "Coupled passive junctions");
}

// An independent scalar bisection eliminates the two forward junctions using
// Shockley's inverse and the resistor KCL equations. The two reverse tails
// are below 1e-32 A here, much smaller than the binary64 voltage rounding.
function operatingPointOracle() {
  const conductance = groundResistance.map((resistance, node) => 1 / resistance + 1 / supplyResistance[node]!);
  const voltagesAt = (first: number) => {
    const firstCurrent = conductance[1]! * first - supply / supplyResistance[1]! - 2 * saturation;
    const second = first + thermalVoltage * Math.log1p(firstCurrent / saturation);
    const secondCurrent = firstCurrent + conductance[2]! * second - supply / supplyResistance[2]!;
    const third = second + thermalVoltage * Math.log1p(secondCurrent / saturation);
    return { second, third, residual: conductance[3]! * third - supply / supplyResistance[3]! + secondCurrent + saturation };
  };
  let low = 1;
  let high = 13;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (voltagesAt(middle).residual < 0) { low = middle; }
    else { high = middle; }
  }
  const firstVoltage = (low + high) / 2;
  const { second, third } = voltagesAt(firstVoltage);
  return [(supply / supplyResistance[0]! - saturation) / conductance[0]!, firstVoltage, second, third];
}

function smallSignalOracle(voltages: readonly number[]) {
  const matrix = groundResistance.map((resistance, node) => Array.from({ length: 4 }, (_, column) =>
    column === node ? 1 / resistance + 1 / supplyResistance[node]! : 0));
  const rhs = supplyResistance.map((resistance) => 0.001 / resistance);
  for (const [anode, cathode] of [[1, 3], [3, 2], [2, 1], [1, 0]]) {
    const slope = saturation * Math.exp((voltages[anode!]! - voltages[cathode!]!) / thermalVoltage) / thermalVoltage;
    matrix[anode!]![anode!]! += slope;
    matrix[cathode!]![cathode!]! += slope;
    matrix[anode!]![cathode!]! -= slope;
    matrix[cathode!]![anode!]! -= slope;
  }
  // Ordinary Gaussian elimination is independent of the production exact
  // solver; these four equations have moderate coefficients and pivots.
  for (let pivot = 0; pivot < 4; pivot += 1) {
    for (let row = pivot + 1; row < 4; row += 1) {
      const factor = matrix[row]![pivot]! / matrix[pivot]![pivot]!;
      for (let column = pivot; column < 4; column += 1) { matrix[row]![column]! -= factor * matrix[pivot]![column]!; }
      rhs[row]! -= factor * rhs[pivot]!;
    }
  }
  const result = [0, 0, 0, 0];
  for (let row = 3; row >= 0; row -= 1) {
    let value = rhs[row]!;
    for (let column = row + 1; column < 4; column += 1) { value -= matrix[row]![column]! * result[column]!; }
    result[row] = value / matrix[row]![row]!;
  }
  return result;
}

describe("source continuation for coupled passive junctions", () => {
  it("approaches a finite root even if the next predicted slope exceeds binary64", () => {
    const voltage = 1e7;
    const resistance = 4;
    const junctionSaturation = 1e-28;
    const ideality = 1e-300;
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["source", "battery", ["s", "0"], { voltageVolts: voltage }],
      ["load", "resistor", ["s", "d"], { resistanceOhms: resistance }],
      ["d1", "diode", ["d", "0"], { saturationCurrentAmps: junctionSaturation, emissionCoefficient: ideality }],
      ["d2", "diode", ["d", "0"], { saturationCurrentAmps: junctionSaturation, emissionCoefficient: ideality }],
    ], "Finite root near the maximum junction slope");
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    const expectedCurrent = voltage / (2 * resistance);
    const expectedVoltage = ideality * thermalVoltage * Math.log1p(expectedCurrent / junctionSaturation);
    expect(Number.isFinite(expectedCurrent / (ideality * thermalVoltage))).toBe(true);
    expect(Math.abs(result.parts.d1!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.d1!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
  });

  it("keeps a finite operating slope when the tiny-emission affine slope would overflow", () => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["source", "battery", ["s", "0"], { voltageVolts: supply }],
      ["load", "resistor", ["s", "d"], { resistanceOhms: 1000 }],
      ["d1", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: 1e-300 }],
      ["d2", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: 1e-300 }],
    ], "Finite tiny-emission operating slope");
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    const expectedVoltage = 1e-300 * thermalVoltage * Math.log1p(supply / (2000 * saturation));
    expect(Math.abs(result.parts.d1!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.d1!.current.real / 0.012 - 1)).toBeLessThan(1e-12);
  });

  it("handles ordinary series junctions beside multiple extreme parallel branches", () => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["source", "battery", ["s", "0"], { voltageVolts: supply }],
      ["normal-load", "resistor", ["s", "top"], { resistanceOhms: 1000 }],
      ["normal-first", "diode", ["top", "middle"]],
      ["normal-second", "diode", ["middle", "0"]],
    ];
    for (let branch = 0; branch < 4; branch += 1) {
      const node = `tiny${branch}`;
      specs.push([`load${branch}`, "resistor", ["s", node], { resistanceOhms: 1000 }]);
      for (let junction = 0; junction < 2; junction += 1) {
        specs.push([`${node}-diode${junction}`, "diode", [node, "0"], { saturationCurrentAmps: 1e-300, emissionCoefficient: 1e-300 }]);
      }
    }
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Ordinary and extreme parallel branches"), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const middle = (low + high) / 2;
      if (saturation * Math.expm1(middle / thermalVoltage) < (supply - 2 * middle) / 1000) { low = middle; }
      else { high = middle; }
    }
    const drop = (low + high) / 2;
    expect(Math.abs(result.parts["normal-load"]!.current.real / ((supply - 2 * drop) / 1000) - 1)).toBeLessThan(1e-12);
    for (let branch = 0; branch < 4; branch += 1) {
      const expectedVoltage = supply / (1 + 2000 * Math.exp(80) / thermalVoltage);
      expect(Math.abs(result.parts[`tiny${branch}-diode0`]!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
    }
  });

  it("solves extreme junction coefficients without visiting a thousand source scales", () => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["source", "battery", ["s", "0"], { voltageVolts: supply, internalResistanceOhms: 0 }],
      ["load", "resistor", ["s", "d"], { resistanceOhms: 1000 }],
      ["d1", "diode", ["d", "0"], { saturationCurrentAmps: 1e-300, emissionCoefficient: 1e-300 }],
      ["d2", "diode", ["d", "0"], { saturationCurrentAmps: 1e-300, emissionCoefficient: 1e-300 }],
    ], "Extreme affine junctions");
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    // Both junctions are above exponent 80 and follow the documented affine
    // extension. Its independently evaluated slope fixes this tiny voltage.
    const slope = Math.exp(80) / thermalVoltage;
    const expectedVoltage = supply / (1 + 2000 * slope);
    expect(Math.abs(result.parts.d1!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.load!.current.real - 0.024)).toBeLessThan(1e-12);
  });

  it.each([false, true])("satisfies the independent DC equations (reverse order=%s)", (reverseOrder) => {
    const document = diodeMesh(reverseOrder);
    const expected = operatingPointOracle();
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    for (const [node, voltage] of expected.entries()) {
      expect(Math.abs(dc.parts[`rg${node}`]!.voltage.real - voltage)).toBeLessThan(1e-9);
    }
    for (const id of ["d1", "d2", "d3", "d4"]) {
      const reading = dc.parts[id]!;
      const current = saturation * Math.expm1(reading.voltage.real / thermalVoltage);
      expect(Math.abs(reading.current.real - current)).toBeLessThan(1e-12 * Math.abs(current));
    }
    const powers = Object.values(dc.parts).map(({ power }) => power.real);
    expect(Math.abs(powers.reduce((sum, power) => sum + power, 0)))
      .toBeLessThan(1e-10 * powers.reduce((sum, power) => sum + Math.abs(power), 0));
  });
  it.each([false, true])("satisfies the independent small-signal equations (reverse order=%s)", (reverseOrder) => {
    const document = diodeMesh(reverseOrder);
    const expectedAc = smallSignalOracle(operatingPointOracle());
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    for (const [node, voltage] of expectedAc.entries()) {
      const actual = ac.parts[`rg${node}`]!.voltage;
      expect(Math.abs(actual.real - voltage)).toBeLessThan(1e-9 * Math.abs(voltage));
      expect(actual.imaginary).toBe(0);
    }
  });

  it("initializes a transient junction mesh without capacitors or fixed inductor currents", () => {
    const document = diodeMesh(false);
    document.parts.find(({ id }) => id === "input")!.voltageVolts = 0;
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      for (const [node, expected] of operatingPointOracle().entries()) {
        expect(Math.abs(sample.parts[`rg${node}`]!.voltageVolts - expected)).toBeLessThan(1e-9);
      }
    }
  });
});
