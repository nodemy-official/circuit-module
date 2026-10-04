import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { type CircuitSpec, createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { addRational, divideRational, rational, rationalFromNumber, subtractRational } from "../helpers/numeric-oracle.js";

const thermalVoltage = 0.025_85;
const cases = (["diode", "led"] as const).flatMap((kind) =>
  [1e-308, 1e-320].flatMap((emission) =>
    (["dc", "ac"] as const).flatMap((mode) =>
      [false, true].map((reverse) => ({ kind, emission, mode, reverse })))));

describe("junction roots beyond the initial slope range", () => {
  it.each(cases)("finds the finite $kind root, n=$emission, $mode, reversed=$reverse", ({ kind, emission, mode, reverse }) => {
    const saturation = 1;
    const current = emission === 1e-320 ? 2 * (1 - 1e-14) : 1.98;
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["bias", "current-source", ["d", "0"], { currentAmps: current }],
      ["signal", "ac-source", ["s", "0"], { voltageVolts: 1, offsetVolts: 0, frequencyHz: 1000 }],
      ["load", "resistor", ["s", "d"], { resistanceOhms: 1 }],
      ["first", kind, ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
      ["second", kind, ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
    ];
    const document = createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Finite reverse root with an overflowing initial derivative");
    const before = JSON.stringify(document);
    const result = analyzeAnalogCircuit(document, { mode, frequencyHz: 1000 });
    expect(result.status, result.message).toBe("valid");
    expect(JSON.stringify(document)).toBe(before);
    // DC resistor current is below 1e-308 A, below the source's rounding.
    // Invert Shockley directly; form n*Vt only after evaluating the exponent.
    const dcVoltage = (thermalVoltage * Math.log1p(-current / (2 * saturation))) * emission;
    const tail = saturation - current / 2;
    expect(Number.isFinite(saturation / emission / thermalVoltage)).toBe(false);
    expect(Number.isFinite(tail / emission / thermalVoltage)).toBe(true);
    // g=tail/(n*Vt). With R=1, V_ac=1/(1+2g); its omitted unity
    // changes this voltage by less than 1e-307 relatively.
    const expectedVoltage = mode === "dc" ? dcVoltage : (thermalVoltage / (2 * tail)) * emission;
    const expectedCurrent = mode === "dc" ? -current / 2 : 0.5;
    for (const id of ["first", "second"]) {
      if (mode === "dc") { expect(result.parts[id]!.voltage.real).toBe(expectedVoltage); }
      else { expect(Math.abs(result.parts[id]!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12); }
      expect(Math.abs(result.parts[id]!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
      expect(result.parts[id]!.voltage.imaginary).toBe(0);
    }
  });

  it.each([false, true])("retains a finite reverse root alongside an amplifier, reversed=%s", (reverse) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["bias", "current-source", ["d", "0"], { currentAmps: 1.98 }],
      ["first", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
      ["second", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
      ["supply", "battery", ["s", "0"], { voltageVolts: 2 }],
      ["amplifier", "op-amp", ["s", "0", "out"]],
      ["load", "resistor", ["out", "0"], { resistanceOhms: 1000 }],
    ];
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Reverse junction and independent amplifier"), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.first!.voltage.real).toBe((thermalVoltage * Math.log1p(-0.99)) * 1e-308);
    expect(result.parts.first!.current.real).toBe(-0.99);
    expect(Math.abs(result.parts.load!.current.real / (15 / 1020) - 1)).toBeLessThan(1e-12);
  });

  it.each([false, true])("keeps a finite junction driven by an amplifier whose linear output overflows, reversed=%s", (reverse) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["supply", "battery", ["s", "0"], { voltageVolts: 2 }],
      ["amplifier", "op-amp", ["s", "0", "out"], { openLoopGain: 1e308 }],
      ["load", "resistor", ["out", "d"], { resistanceOhms: 1000 }],
      ["bias", "current-source", ["d", "0"], { currentAmps: 0.99 }],
      ["junction", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
    ];
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Finite reverse junction driven by a saturated high-gain amplifier"), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    // The internal 15 V drive sees a 20-ohm output resistor and 1k load.
    // The subnormal junction drop does not affect their displayed current.
    const loadCurrent = 15 / 1020;
    const junctionCurrent = loadCurrent - 0.99;
    const junctionVoltage = (thermalVoltage * Math.log1p(junctionCurrent)) * 1e-308;
    expect(Math.abs(result.parts.junction!.voltage.real / junctionVoltage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.junction!.current.real / junctionCurrent - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.load!.current.real / loadCurrent - 1)).toBeLessThan(1e-12);
  });

  it.each([0.01, 0.024_05, 0.024_099, 1].flatMap((current) =>
    (["dc", "ac"] as const).flatMap((mode) => [false, true].map((reverse) => ({ current, mode, reverse })))))(
    "balances resistor and current-source bias, I=$current, $mode, reversed=$reverse", ({ current, mode, reverse }) => {
      const saturation = 1e-4;
      const emission = 1e-308;
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["source", "ac-source", ["s", "0"], { voltageVolts: 1, offsetVolts: 24, frequencyHz: 1000 }],
        ["load", "resistor", ["s", "d"], { resistanceOhms: 1000 }],
        ["bias", "current-source", ["d", "0"], { currentAmps: current }],
        ["junction", "diode", ["d", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
      ];
      const result = analyzeAnalogCircuit(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Resistor and current-biased junction"), { mode, frequencyHz: 1000 });
      expect(result.status, result.message).toBe("valid");
      // Complete the source-current cancellation with an independent rational
      // oracle before the logarithm. The tiny junction drop does not change
      // the displayed resistor current at these finite-exponent roots.
      const diodeCurrent = subtractRational(rational(24n, 1000n), rationalFromNumber(current)!);
      const factor = divideRational(diodeCurrent, rationalFromNumber(saturation)!);
      const projectedCurrent = Number(diodeCurrent.numerator) / Number(diodeCurrent.denominator);
      const tail = addRational(rationalFromNumber(saturation)!, diodeCurrent);
      const projectedTail = Number(tail.numerator) / Number(tail.denominator);
      const dcVoltage = current === 1 ? 24 - 1000 * (current - saturation)
        : (thermalVoltage * Math.log1p(Number(factor.numerator) / Number(factor.denominator))) * emission;
      const acVoltage = current === 1 ? 1 : (thermalVoltage / (1000 * projectedTail)) * emission;
      const expectedVoltage = mode === "dc" ? dcVoltage : acVoltage;
      const expectedCurrent = mode === "dc" ? current === 1 ? -saturation : projectedCurrent : current === 1 ? 0 : 0.001;
      expect(Math.abs(result.parts.junction!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
      if (expectedCurrent === 0) { expect(result.parts.junction!.current.real).toBe(0); }
      else { expect(Math.abs(result.parts.junction!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12); }
    });

  it.each([false, true])("resolves an independent saturated BJT beside the overflow junction, reversed=%s", (reverse) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["bias", "current-source", ["d", "0"], { currentAmps: 0.99 }],
      ["junction", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
      ["supply", "battery", ["s", "0"], { voltageVolts: 3 }],
      ["load", "resistor", ["s", "out"], { resistanceOhms: 1000 }],
      ["base", "battery", ["base", "0"], { voltageVolts: 0.6 }],
      ["transistor", "npn-transistor", ["out", "base", "0"], { saturationCurrentAmps: 1e-12, currentGain: 100 }],
    ];
    let low = 0;
    let high = 3;
    const forward = 1e-12 * Math.expm1(0.6 / thermalVoltage);
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const middle = (low + high) / 2;
      const collector = forward - 2e-12 * Math.expm1((0.6 - middle) / thermalVoltage);
      if ((3 - middle) / 1000 > collector) { low = middle; }
      else { high = middle; }
    }
    const expectedVoltage = (low + high) / 2;
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Saturated BJT and independent reverse junction"), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    expect(Math.abs(result.parts.transistor!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.transistor!.current.real / ((3 - expectedVoltage) / 1000) - 1)).toBeLessThan(1e-12);
    expect(result.parts.junction!.current.real).toBe(-0.99);
  });

  it.each([false, true])("preserves a fixed initial inductor current and its companion, reversed=%s", (reverse) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["bias", "inductor", ["d", "0"], { inductanceHenries: 1, initialCurrentAmps: 1.98 }],
      ["first", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
      ["second", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
    ];
    const result = simulateTransient(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Reverse junction and initial inductor current"), { durationSeconds: 0.1, timeStepSeconds: 0.1 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(sample.parts.bias!.currentAmps).toBe(1.98);
      expect(sample.parts.first!.voltageVolts).toBe((thermalVoltage * Math.log1p(-0.99)) * 1e-308);
      expect(sample.parts.first!.currentAmps).toBe(-0.99);
      expect(sample.parts.bias!.currentAmps + sample.parts.first!.currentAmps + sample.parts.second!.currentAmps).toBe(0);
    }
  });

  it.each([false, true])("rejects a reverse current exceeding total saturation, reversed=%s", (reverse) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["bias", "current-source", ["d", "0"], { currentAmps: 2.01 }],
      ["first", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
      ["second", "diode", ["d", "0"], { saturationCurrentAmps: 1, emissionCoefficient: 1e-308 }],
    ];
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(reverse ? specs.reverse() : specs, "Impossible reverse current"), { mode: "dc" });
    expect(result.status).toBe("invalid");
  });
});
