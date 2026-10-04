import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { type CircuitSpec, createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const thermalVoltage = 0.025_85;

describe("finite junction slopes near the affine boundary", () => {
  it.each([
    { mode: "dc", reverse: false },
    { mode: "dc", reverse: true },
    { mode: "ac", reverse: false },
    { mode: "ac", reverse: true },
  ] as const)("retains the finite solution in $mode, reversed=$reverse", ({ mode, reverse }) => {
    const supply = 10_000_000;
    const resistance = 4;
    const saturation = 1e-28;
    const emission = 1e-300;
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["source", "ac-source", ["s", "0"], { voltageVolts: 1, offsetVolts: supply, frequencyHz: 1000 }],
      ["load", "resistor", ["s", "d"], { resistanceOhms: resistance }],
      ["first", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
      ["second", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
    ];
    const document = createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Finite slopes near the affine junction boundary");
    const result = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });
    expect(result.status, result.message).toBe("valid");
    // The DC junction drop is under 3e-300 V, so its correction to the
    // source current is below binary64 rounding. Invert Shockley separately.
    const dcCurrent = supply / (2 * resistance);
    const dcVoltage = emission * (thermalVoltage * Math.log1p(dcCurrent / saturation));
    // g=(I+Is)/(n*Vt). Evaluate its inverse to avoid overflowing 2*R*g;
    // the omitted unity changes this voltage by less than 1e-308 relatively.
    const expectedVoltage = mode === "dc" ? dcVoltage
      : (emission * thermalVoltage / (2 * resistance)) / (dcCurrent + saturation);
    const expectedCurrent = mode === "dc" ? dcCurrent : 1 / (2 * resistance);
    for (const id of ["first", "second"]) {
      expect(Math.abs(result.parts[id]!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
      expect(Math.abs(result.parts[id]!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
      expect(result.parts[id]!.voltage.imaginary).toBe(0);
    }
    expect(Math.abs(result.parts.load!.current.real / (2 * expectedCurrent) - 1)).toBeLessThan(1e-12);
  });

  it.each([false, true])("retains finite currents when the junction voltage is subnormal, reversed=%s", (reverse) => {
    const supply = 24;
    const resistance = 2e18;
    const saturation = 1e-50;
    const emission = Number.MIN_VALUE;
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["source", "battery", ["s", "0"], { voltageVolts: supply }],
      ["load", "resistor", ["s", "d"], { resistanceOhms: resistance }],
      ["first", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
      ["second", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
    ];
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Finite subnormal junction voltage"), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    const expectedCurrent = supply / (2 * resistance);
    const expectedVoltage = (thermalVoltage * Math.log1p(expectedCurrent / saturation)) * emission;
    for (const id of ["first", "second"]) {
      expect(result.parts[id]!.voltage.real).toBe(expectedVoltage);
      expect(Math.abs(result.parts[id]!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
    }
  });
});
