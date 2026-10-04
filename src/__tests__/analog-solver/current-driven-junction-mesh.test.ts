import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const voltages = [0, 0.64, 0.06, 0.05, 0.65, 0.22, 0.23];
const resistances = [0, 1000, 1000, 100, 10_000, 100, 1000];
const junctions = [
  [2, 1, 1e-14], [0, 3, 1e-14], [4, 0, 1e-12], [1, 0, 1e-14],
  [2, 4, 1e-12], [5, 1, 1e-12], [5, 1, 1e-14], [0, 3, 1e-12],
  [2, 6, 1e-14], [6, 2, 1e-14], [6, 5, 1e-10], [1, 4, 1e-14],
  [3, 4, 1e-10], [0, 3, 1e-10], [3, 4, 1e-10], [2, 6, 1e-12],
] as const;
const thermalVoltage = 0.025_85;

function fixture() {
  const injections = voltages.map((voltage, node) => node === 0 ? 0 : voltage / resistances[node]!);
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["input", "ac-source", ["1", "0"], { offsetVolts: voltages[1], voltageVolts: 0.001, frequencyHz: 1000 }],
  ];
  for (let node = 1; node < voltages.length; node += 1) {
    specs.push([`load${node}`, "resistor", [String(node), "0"], { resistanceOhms: resistances[node]! }]);
  }
  for (const [index, [anode, cathode, saturation]] of junctions.entries()) {
    const current = saturation * Math.expm1((voltages[anode]! - voltages[cathode]!) / thermalVoltage);
    injections[anode]! += current;
    injections[cathode]! -= current;
    specs.push([`diode${index}`, "diode", [String(anode), String(cathode)], { saturationCurrentAmps: saturation }]);
  }
  for (let node = 2; node < voltages.length; node += 1) {
    specs.push([`bias${node}`, "current-source", ["0", String(node)], { currentAmps: injections[node]! }]);
  }
  return createCircuitFromSpecs(specs, "Independent current-driven junction mesh");
}

function responseOracle() {
  const matrix = Array.from({ length: 6 }, (_row, row) => Array.from({ length: 6 }, (_column, column) =>
    row === column ? 1 / resistances[row + 1]! : 0));
  for (const [anode, cathode, saturation] of junctions) {
    const slope = saturation * Math.exp((voltages[anode]! - voltages[cathode]!) / thermalVoltage) / thermalVoltage;
    if (anode !== 0) { matrix[anode - 1]![anode - 1]! += slope; }
    if (cathode !== 0) { matrix[cathode - 1]![cathode - 1]! += slope; }
    if (anode !== 0 && cathode !== 0) {
      matrix[anode - 1]![cathode - 1]! -= slope;
      matrix[cathode - 1]![anode - 1]! -= slope;
    }
  }
  matrix[0] = [1, 0, 0, 0, 0, 0];
  const rhs = [0.001, 0, 0, 0, 0, 0];
  for (let pivot = 0; pivot < 6; pivot += 1) {
    for (let row = pivot + 1; row < 6; row += 1) {
      const factor = matrix[row]![pivot]! / matrix[pivot]![pivot]!;
      for (let column = pivot; column < 6; column += 1) { matrix[row]![column]! -= factor * matrix[pivot]![column]!; }
      rhs[row]! -= factor * rhs[pivot]!;
    }
  }
  const response = [0, 0, 0, 0, 0, 0];
  for (let row = 5; row >= 0; row -= 1) {
    let value = rhs[row]!;
    for (let column = row + 1; column < 6; column += 1) { value -= matrix[row]![column]! * response[column]!; }
    response[row] = value / matrix[row]![row]!;
  }
  return response;
}

describe("junction continuation with simultaneous voltage and current sources", () => {
  it("recovers the operating point constructed from independent KCL and Shockley equations", () => {
    const result = analyzeAnalogCircuit(fixture(), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    for (let node = 1; node < voltages.length; node += 1) {
      expect(Math.abs(result.parts[`load${node}`]!.voltage.real - voltages[node]!)).toBeLessThan(1e-10);
    }
  });

  it("matches the independently differentiated small-signal response", () => {
    const result = analyzeAnalogCircuit(fixture(), { mode: "ac", frequencyHz: 1000 });
    expect(result.status, result.message).toBe("valid");
    for (const [index, expected] of responseOracle().entries()) {
      const actual = result.parts[`load${index + 1}`]!.voltage;
      expect(Math.abs(actual.real - expected)).toBeLessThan(1e-9 * Math.abs(expected));
      expect(actual.imaginary).toBe(0);
    }
  });
});
