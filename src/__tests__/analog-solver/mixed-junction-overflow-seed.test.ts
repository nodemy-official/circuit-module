import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { type CircuitSpec, createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const thermalVoltage = 0.025_85;
const saturation = 1e-12;

function collectorVoltage() {
  const forward = saturation * Math.expm1(0.6 / thermalVoltage);
  let low = 0;
  let high = 0.6;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const voltage = (low + high) / 2;
    const reverse = saturation * Math.expm1((0.6 - voltage) / thermalVoltage);
    if (forward - 2 * reverse > (3 - voltage) / 1000) { high = voltage; }
    else { low = voltage; }
  }
  return (low + high) / 2;
}

describe("an overflowing junction beside an independent saturated BJT", () => {
  it.each((["npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
    (["dc", "ac"] as const).flatMap((mode) =>
      [false, true].map((reverse) => ({ kind, mode, reverse })))))
    ("preserves both roots for $kind in $mode, reversed=$reverse", ({ kind, mode, reverse }) => {
      const sign = kind === "npn-transistor" ? 1 : -1;
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["reverse-current", "current-source", ["d", "0"], { currentAmps: 0.99 }],
        ["diode", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
        ["bias", "ac-source", ["s", "0"], { voltageVolts: 1, offsetVolts: sign * 3, frequencyHz: 1000 }],
        ["load", "resistor", ["s", "out"], { resistanceOhms: 1000 }],
        ["base", "ac-source", ["base", "0"], { voltageVolts: 0, offsetVolts: sign * 0.6, frequencyHz: 1000 }],
        ["transistor", kind, ["out", "base", "0"], { saturationCurrentAmps: saturation, currentGain: 100 }],
      ];
      const document = createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Independent saturated BJT and reverse diode");
      const before = JSON.stringify(document);
      const result = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });
      expect(result.status, result.message).toBe("valid");
      expect(JSON.stringify(document)).toBe(before);
      // Independently eliminate the fixed base/emitter and solve collector
      // KCL using Ebers-Moll transport currents: Ic=If-2*Ir.
      const dcVoltage = collectorVoltage();
      const reverseSlope = saturation * Math.exp((0.6 - dcVoltage) / thermalVoltage) / thermalVoltage;
      const acVoltage = 1 / (1 + 2000 * reverseSlope);
      const expectedVoltage = mode === "dc" ? sign * dcVoltage : acVoltage;
      const expectedCurrent = mode === "dc" ? sign * (3 - dcVoltage) / 1000 : (1 - acVoltage) / 1000;
      expect(Math.abs(result.parts.transistor!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
      expect(Math.abs(result.parts.transistor!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
      expect(Math.abs(result.parts.load!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
      expect(result.parts.transistor!.voltage.imaginary).toBe(0);
      const expectedDiodeVoltage = mode === "dc" ? (thermalVoltage * Math.log1p(-0.99)) * 1e-308 : 0;
      expect(result.parts.diode!.voltage.real).toBe(expectedDiodeVoltage);
      expect(result.parts.diode!.current.real).toBe(mode === "dc" ? -0.99 : 0);
    });
});
