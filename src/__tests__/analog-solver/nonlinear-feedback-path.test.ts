import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function differentialMeasurementSpecs(): CircuitSpec[] {
  return [
    ["ground", "ground", ["0"]],
    ["supply", "battery", ["s", "0"], { voltageVolts: 2 }],
    ["first", "resistor", ["s", "plus"], { resistanceOhms: 1000 }],
    ["diode", "diode", ["plus", "minus"]],
    ["second", "resistor", ["minus", "0"], { resistanceOhms: 1000 }],
    ["amplifier", "op-amp", ["plus", "minus", "out"], { openLoopGain: 1e308 }],
    ["load", "resistor", ["out", "0"], { resistanceOhms: 1000 }],
  ];
}

function differentialJunctionDrop() {
  let low = 0;
  let high = 2;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (1e-12 * Math.expm1(middle / 0.025_85) < (2 - middle) / 2000) { low = middle; }
    else { high = middle; }
  }
  return (low + high) / 2;
}

function amplifierWithLeaf(usePotentiometer: boolean, reverseOrder: boolean) {
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["bias", "battery", ["reference", "0"], { voltageVolts: 2 }],
    ["amplifier", "op-amp", ["reference", "sense", "out"], { openLoopGain: 1e308 }],
    ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
    ["transistor", "npn-transistor", ["leaf", "sense", "sense"]],
  ];
  if (usePotentiometer) {
    specs.push(["pot", "potentiometer", ["out", "leaf", "sense"], { resistanceOhms: 20_000, wiperPosition: 0.5 }]);
  } else {
    specs.push(
      ["feedback", "resistor", ["out", "sense"], { resistanceOhms: 10_000 }],
      ["leaf-resistor", "resistor", ["leaf", "sense"], { resistanceOhms: 10_000 }],
    );
  }
  return createCircuitFromSpecs(reverseOrder ? specs.reverse() : specs, "Amplifier with an unpowered nonlinear leaf");
}

describe("nonlinear devices outside the amplifier feedback path", () => {
  it.each([false, true])("does not raise target gain through an observer's reverse input path (reverse order=%s)", (reverseOrder) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["bias", "battery", ["reference", "0"], { voltageVolts: 2 }],
      ["amplifier", "op-amp", ["reference", "sense", "out"], { openLoopGain: 1e308 }],
      ["feedback", "resistor", ["out", "sense"], { resistanceOhms: 10_000 }],
      ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
      ["observer", "op-amp", ["out", "leaf", "observer-out"], { openLoopGain: 1000 }],
      ["observer-return", "resistor", ["observer-out", "sense"], { resistanceOhms: 10_000 }],
      ["diode", "diode", ["leaf", "sense"]],
    ];
    const document = createCircuitFromSpecs(reverseOrder ? specs.reverse() : specs, "Observer return with an unpowered input diode");
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    // Infinite input impedance fixes the diode drop at zero. The target's
    // gain makes sense=2 V to far better than binary64 precision, while the
    // observer reaches its 15 V rail through the 20-ohm output resistance.
    expect(Math.abs(result.parts.load!.current.real / 0.002 - 1)).toBeLessThan(1e-12);
    expect(result.parts.diode!.voltage.real).toBe(0);
    expect(result.parts.diode!.current.real).toBe(0);
    const observerVoltage = (15 + 20 * 2 / 10_000) / (1 + 20 / 10_000);
    expect(Math.abs(result.parts.observer!.voltage.real / observerVoltage - 1)).toBeLessThan(1e-12);
  });

  it.each([false, true])("keeps a cascaded differential observer outside feedback (reverse order=%s)", (reverseOrder) => {
    const specs = differentialMeasurementSpecs();
    specs.push(
      ["observer", "op-amp", ["out", "plus", "observer-out"], { openLoopGain: 1000 }],
      ["observer-load", "resistor", ["observer-out", "0"], { resistanceOhms: 1000 }],
    );
    const document = createCircuitFromSpecs(reverseOrder ? specs.reverse() : specs, "Cascaded differential observers");
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    expect(Math.abs(result.parts.diode!.voltage.real - differentialJunctionDrop())).toBeLessThan(1e-12);
    for (const id of ["load", "observer-load"]) {
      expect(Math.abs(result.parts[id]!.current.real / (15 / 1020) - 1)).toBeLessThan(1e-12);
    }
  });

  it.each([0.5, 100_000])("keeps an independent high-gain observer outside continuation (feedback gain=%s)", (gain) => {
    for (const reverseOrder of [false, true]) {
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["input", "battery", ["input", "0"], { voltageVolts: 1 }],
        ["feedback-amplifier", "op-amp", ["input", "sense", "control"], { openLoopGain: gain }],
        ["junction", "diode", ["control", "sense"]],
        ["feedback-load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
        ["observer", "op-amp", ["input", "0", "out"], { openLoopGain: 1e308 }],
        ["observer-load", "resistor", ["out", "0"], { resistanceOhms: 1000 }],
      ];
      const document = createCircuitFromSpecs(reverseOrder ? specs.reverse() : specs, "Independent amplifier observer");
      const result = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(result.status, result.message).toBe("valid");
      let low = 0;
      let high = Math.min(1, gain);
      for (let iteration = 0; iteration < 60; iteration += 1) {
        const middle = (low + high) / 2;
        const resistorCurrent = (gain - middle) / (1000 * gain + 1020);
        if (1e-12 * Math.expm1(middle / 0.025_85) < resistorCurrent) { low = middle; }
        else { high = middle; }
      }
      const expectedCurrent = (gain - (low + high) / 2) / (1000 * gain + 1020);
      expect(Math.abs(result.parts["feedback-load"]!.current.real / expectedCurrent - 1)).toBeLessThan(1e-10);
      expect(Math.abs(result.parts["observer-load"]!.current.real / (15 / 1020) - 1)).toBeLessThan(1e-12);
    }
  });

  it.each([false, true])("measures a differential junction without inventing output feedback (reverse order=%s)", (reverseOrder) => {
    const specs = differentialMeasurementSpecs();
    const document = createCircuitFromSpecs(reverseOrder ? specs.reverse() : specs, "Differential diode measurement");
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    expect(Math.abs(result.parts.diode!.voltage.real - differentialJunctionDrop())).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.load!.current.real / (15 / 1020) - 1)).toBeLessThan(1e-12);
  });

  it.each([false, true])("preserves equivalent potentiometer and resistor branches (reverse order=%s)", (reverseOrder) => {
    for (const usePotentiometer of [false, true]) {
      const result = analyzeAnalogCircuit(amplifierWithLeaf(usePotentiometer, reverseOrder), { mode: "dc" });
      expect(result.status, result.message).toBe("valid");
      // The 2 V input drives the amplifier into its 15 V rail. Only the
      // 20-ohm output resistance and the 10k + 1k load carry any current.
      const expectedCurrent = 15 / 11_020;
      expect(Math.abs(result.parts.load!.current.real / expectedCurrent - 1)).toBeLessThan(1e-12);
      expect(Math.abs(result.parts.amplifier!.voltage.real / (11_000 * expectedCurrent) - 1)).toBeLessThan(1e-12);
      expect(result.parts.transistor!.current.real).toBe(0);
    }
  });
});
