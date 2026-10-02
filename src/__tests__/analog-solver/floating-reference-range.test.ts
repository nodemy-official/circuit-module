import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

function sourceChain(mode: "dc" | "ac", count: number, phaseDegrees = 0) {
  return Array.from({ length: count }, (_, index) => [
    `source-${index}`, mode === "dc" ? "battery" : "ac-source",
    [`node-${index}`, `node-${index + 1}`],
    { voltageVolts: 1e308, internalResistanceOhms: 1, frequencyHz: 1000, phaseDegrees },
  ] as const);
}

const cases = (["dc", "ac"] as const).flatMap((mode) =>
  [2, 3].flatMap((count) => (mode === "dc" ? [0] : [0, 37, 90]).map((phase) => ({ mode, count, phase }))),
);

describe("floating analog voltage references near the binary64 range limit", () => {
  it.each(cases)("keeps $mode source chains finite (count=$count phase=$phase)", ({ mode, count, phase }) => {
    const document = createCircuitFromSpecs(sourceChain(mode, count, phase), "Finite source differences at an extreme reference");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const analysis = analyzeAnalogCircuit({ ...document, parts }, { mode });
      expect(analysis.status, analysis.message).toBe("valid");
      for (const reading of Object.values(analysis.parts)) {
        expect(Math.hypot(reading.voltage.real, reading.voltage.imaginary) / 1e308).toBeCloseTo(1, 14);
        expect(reading.current.real).toBe(0);
        expect(reading.current.imaginary).toBe(0);
        expect(reading.power.real).toBe(0);
        expect(reading.power.imaginary).toBe(0);
        expect(Object.values(reading.terminalVoltages).every((value) =>
          Number.isFinite(value.real) && Number.isFinite(value.imaginary))).toBe(true);
      }
      expect(analyzeCircuit({ ...document, parts }, {}, { mode }).status).toBe("open");
    }
  });

  it.each(["dc", "ac"] as const)("keeps a separate grounded island fixed in %s", (mode) => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["small", mode === "dc" ? "battery" : "ac-source", ["small", "0"], { voltageVolts: 3, frequencyHz: 1000 }],
      ...sourceChain(mode, 3),
    ], "Separate fixed and floating references");
    const analysis = analyzeAnalogCircuit(document, { mode });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.parts.ground!.terminalVoltages.a!.real).toBe(0);
    expect(analysis.parts.small!.terminalVoltages.a!.real).toBe(3);
    expect(analysis.parts.small!.voltage.real).toBe(3);
  });

  it.each([false, true])("uses a finite RMS reference for a noncollinear AC chain (loaded=%s)", (loaded) => {
    const phases = [0, 0, 180, 90];
    const document = createCircuitFromSpecs([
      ...phases.map((phaseDegrees, index) => [
        `source-${index}`, "ac-source", [`node-${index}`, `node-${index + 1}`],
        { voltageVolts: 1.7e308, frequencyHz: 1000, phaseDegrees, internalResistanceOhms: 1 },
      ] as const),
      ...(loaded ? phases.map((_, index) => [
        `load-${index}`, "resistor", [`node-${index}`, `node-${index + 1}`], { resistanceOhms: 1.7e308 },
      ] as const) : []),
    ], "Finite radial range requires the center of the enclosing circle");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const analysis = analyzeCircuit({ ...document, parts }, {}, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe(loaded ? "closed" : "open");
      for (const reading of Object.values(analysis.parts)) {
        expect(reading.voltageVolts).toBe(1.7e308);
        expect(Object.values(reading.terminalVoltages!).every(Number.isFinite)).toBe(true);
        expect(reading.currentAmps).toBe(loaded ? 1 : 0);
      }
    }
  });

  it.each([2 ** 1023, Number.MAX_VALUE].flatMap((amplitude) =>
    [3, 40, 49, 89].map((phase) => ({ amplitude, phase })),
  ))("checks the normalized RMS boundary at amplitude=$amplitude phase=$phase", ({ amplitude, phase }) => {
    const document = createCircuitFromSpecs([0, 1].map((index) => [
      `source-${index}`, "ac-source", [`node-${index}`, `node-${index + 1}`],
      { voltageVolts: amplitude, frequencyHz: 1000, phaseDegrees: phase, internalResistanceOhms: 1 },
    ] as const), "The raw direction can round finite before RMS normalization");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const analysis = analyzeCircuit({ ...document, parts }, {}, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe("open");
      for (const reading of Object.values(analysis.parts)) {
        expect(reading.voltageVolts).toBe(amplitude);
        expect(reading.currentAmps).toBe(0);
        expect(Math.abs(reading.powerWatts)).toBe(0);
        expect(Object.values(reading.terminalVoltages!).every(Number.isFinite)).toBe(true);
      }
    }
  });

  it.each([3, 40, 49].flatMap((phaseDegrees) =>
    [false, true].map((withMeter) => ({ phaseDegrees, withMeter })),
  ))("keeps a floating op-amp common input separate from output GND (phase=$phaseDegrees meter=$withMeter)", ({ phaseDegrees, withMeter }) => {
    const amplitude = 2 ** 1023;
    const document = createCircuitFromSpecs([
      ...[0, 1].map((index) => [
        `source-${index}`, "ac-source", [`node-${index}`, `node-${index + 1}`],
        { voltageVolts: amplitude, frequencyHz: 1000, phaseDegrees, internalResistanceOhms: 1 },
      ] as const),
      ["amplifier", "op-amp", ["node-0", "node-0", "0"]],
      ["ground", "ground", ["0"]],
      ...(withMeter ? [["meter", "voltmeter", ["node-0", "0"]] as const] : []),
    ], "Zero-current common input need not share the amplifier output reference");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const analysis = analyzeCircuit({ ...document, parts }, {}, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe("closed");
      expect(analysis.parts.ground!.terminalVoltages!.a).toBe(0);
      const amplifier = analysis.parts.amplifier!;
      expect(amplifier.terminalVoltages!.a).toBe(amplitude);
      expect(amplifier.terminalVoltages!.a).toBe(amplifier.terminalVoltages!.b);
      expect(amplifier.voltageVolts).toBe(0);
      expect(amplifier.currentAmps).toBe(0);
      expect(amplifier.terminalVoltageDifferences!.map((difference) => difference.voltageVolts)).toEqual([0, amplitude, amplitude]);
      if (withMeter) {
        expect(analysis.parts.meter!.meterStatus).toBe("floating");
        expect(analysis.parts.meter!.voltageVolts).toBe(amplitude);
      }
      for (const reading of Object.values(analysis.parts)) {
        expect(Object.values(reading.terminalVoltages!).every(Number.isFinite)).toBe(true);
      }
    }
  });

  it.each(["dc", "ac"] as const)("rejects actual output overflow in %s", (mode) => {
    for (const extra of [
      [["ground", "ground", ["node-0"]] as const],
      [["meter", "voltmeter", ["node-0", "node-2"]] as const],
      sourceChain(mode, 4),
    ]) {
      const document = createCircuitFromSpecs(extra.length === 4 ? extra : [...sourceChain(mode, 2), ...extra], "Physical output overflow");
      expect(analyzeAnalogCircuit(document, { mode }).status).toBe("invalid");
    }
  });

  it.each(["dc", "ac"] as const)("retains currents and power in loaded %s source chains", (mode) => {
    const document = createCircuitFromSpecs([
      ...sourceChain(mode, 3),
      ...Array.from({ length: 3 }, (_, index) => [
        `load-${index}`, "resistor", [`node-${index}`, `node-${index + 1}`], { resistanceOhms: 1e308 },
      ] as const),
    ], "Loaded floating source chain");
    const analysis = analyzeAnalogCircuit(document, { mode });
    expect(analysis.status, analysis.message).toBe("valid");
    for (let index = 0; index < 3; index += 1) {
      const source = analysis.parts[`source-${index}`]!;
      const load = analysis.parts[`load-${index}`]!;
      // I = 1e308 / (1e308 + 1) rounds to 1 A, while the exact 1 V
      // internal drop and the finite external power remain in the model.
      expect(load.current.real).toBe(1);
      expect(source.current.real).toBe(-1);
      expect(load.power.real).toBe(1e308);
      expect(source.power.real).toBe(-1e308);
    }
  });

  it("preserves the finite source differences through transient initialization and steps", () => {
    const document = createCircuitFromSpecs(sourceChain("dc", 3), "Transient floating source chain");
    const analysis = simulateTransient(document, { durationSeconds: 0.002, timeStepSeconds: 0.001 });
    expect(analysis.status, analysis.message).toBe("valid");
    for (const sample of analysis.samples) {
      for (const reading of Object.values(sample.parts)) {
        expect(reading.voltageVolts).toBe(1e308);
        expect(reading.currentAmps).toBe(0);
        expect(reading.powerWatts).toBe(0);
      }
    }
  });

  it.each(["op-amp", "diode"] as const)("keeps a separate %s island from invalidating finite source differences", (kind) => {
    const island = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ...(kind === "op-amp" ? [["device", "op-amp", ["0", "0", "0"]] as const] : [
        ["bias", "battery", ["bias", "0"], { voltageVolts: 1 }] as const,
        ["load", "resistor", ["bias", "junction"], { resistanceOhms: 1000 }] as const,
        ["device", "diode", ["junction", "0"]] as const,
      ]),
    ], "Independent nonlinear island");
    const chain = createCircuitFromSpecs(sourceChain("dc", 3), "Independent extreme source chain");
    const document = { title: "Independent nonlinear and extreme voltage islands", parts: [...island.parts, ...chain.parts], wires: [
      ...island.wires, ...chain.wires.map((wire) => ({ ...wire, id: `chain-${wire.id}` })),
    ] };
    for (const mode of ["dc", "ac"] as const) {
      const baseline = analyzeAnalogCircuit(island, { mode });
      const analysis = analyzeAnalogCircuit(document, { mode });
      expect(analysis.status, analysis.message).toBe("valid");
      expect(analysis.parts.device!.current).toEqual(baseline.parts.device!.current);
      expect(analysis.parts.device!.voltage).toEqual(baseline.parts.device!.voltage);
      expect(analysis.parts.ground!.terminalVoltages.a!.real).toBe(0);
    }
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(sample.parts["source-0"]!.voltageVolts).toBe(1e308);
      expect(sample.parts["source-0"]!.currentAmps).toBe(0);
    }
  });
});
