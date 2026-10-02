import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit, type AnalogCircuitAnalysis, type ComplexValue } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const gain = 1;
const outputResistance = 20;
const loadResistance = 20;

function floatingInputCircuit(input: "positive" | "negative", phaseDegrees: number) {
  return createCircuitFromSpecs([
    ["signal", "ac-source", ["input", "floating-return"], { voltageVolts: 1, frequencyHz: 1000, phaseDegrees }],
    ["dangling", "resistor", ["floating-return", "unused"], { resistanceOhms: 1 }],
    ["amp", "op-amp", input === "positive" ? ["input", "0", "output"] : ["0", "input", "output"], { openLoopGain: gain }],
    ["load", "resistor", ["output", "0"], { resistanceOhms: loadResistance }],
    ["meter", "voltmeter", ["input", "0"]],
    ["ground", "ground", ["0"]],
  ], "Floating op-amp input display coordinates");
}

function complexResidual(actual: ComplexValue, expected: ComplexValue) {
  return Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
}

// Independent op-amp and resistor equations use the published terminal values.
// Input islands may choose an arbitrary common mode, but that coordinate
// choice must describe the same output current and satisfy output-node KCL.
function modelAndConservationResiduals(analysis: AnalogCircuitAnalysis) {
  const amp = analysis.parts.amp;
  const positive = amp.terminalVoltages.a!;
  const negative = amp.terminalVoltages.b!;
  const output = amp.terminalVoltages.c!;
  const reference = analysis.parts.ground.terminalVoltages.a!;
  const current = amp.terminalCurrents.c!;
  const loadCurrent = analysis.parts.load.terminalCurrents.a!;
  const relativeOutput = {
    real: output.real - reference.real,
    imaginary: output.imaginary - reference.imaginary,
  };
  return [
    complexResidual(current, {
      real: (relativeOutput.real - gain * (positive.real - negative.real)) / outputResistance,
      imaginary: (relativeOutput.imaginary - gain * (positive.imaginary - negative.imaginary)) / outputResistance,
    }),
    complexResidual(loadCurrent, {
      real: relativeOutput.real / loadResistance,
      imaginary: relativeOutput.imaginary / loadResistance,
    }),
    Math.hypot(current.real + loadCurrent.real, current.imaginary + loadCurrent.imaginary),
    complexResidual(amp.voltage, relativeOutput),
    Math.abs(Object.values(analysis.parts).reduce((power, reading) => power + reading.power.real, 0)),
    Math.abs(Object.values(analysis.parts).reduce((power, reading) => power + reading.power.imaginary, 0)),
  ];
}

describe("AC op-amp floating input coordinates", () => {
  it.each([0, 37, 90])("preserves the model for either floating input at phase %s", (phaseDegrees) => {
    for (const input of ["positive", "negative"] as const) {
      const document = floatingInputCircuit(input, phaseDegrees);
      const analysis = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe("valid");
      for (const residual of modelAndConservationResiduals(analysis)) { expect(residual).toBeLessThan(1e-12); }
      expect(analysis.parts.meter.meterStatus).toBe("floating");
      expect(complexResidual(analysis.parts.dangling.current, { real: 0, imaginary: 0 })).toBe(0);
      expect(Math.hypot(analysis.parts.amp.voltage.real, analysis.parts.amp.voltage.imaginary)).toBeCloseTo(0.5, 12);
    }
  });

  it.each([0, 37, 90])("shifts separate floating input islands together at phase %s", (phaseDegrees) => {
    const specs: CircuitSpec[] = [
      ["first", "ac-source", ["positive", "first-return"], { voltageVolts: 1, frequencyHz: 1000, phaseDegrees }],
      ["second", "ac-source", ["negative", "second-return"], { voltageVolts: 2, frequencyHz: 1000, phaseDegrees: phaseDegrees + 90 }],
      ["first-dangling", "resistor", ["first-return", "first-unused"], { resistanceOhms: 1 }],
      ["second-dangling", "resistor", ["second-return", "second-unused"], { resistanceOhms: 1 }],
      ["amp", "op-amp", ["positive", "negative", "output"], { openLoopGain: gain }],
      ["load", "resistor", ["output", "0"], { resistanceOhms: loadResistance }],
      ["ground", "ground", ["0"]],
    ];
    const document = createCircuitFromSpecs(specs, "Two floating op-amp input islands");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const analysis = analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe("valid");
      for (const residual of modelAndConservationResiduals(analysis)) { expect(residual).toBeLessThan(1e-12); }
    }
  });

  it("keeps a floating differential source's shared input common mode independent of the output", () => {
    const document = createCircuitFromSpecs([
      ["signal", "ac-source", ["positive", "negative"], { voltageVolts: 1, frequencyHz: 1000 }],
      ["dangling", "resistor", ["negative", "unused"], { resistanceOhms: 1 }],
      ["amp", "op-amp", ["positive", "negative", "output"], { openLoopGain: gain }],
      ["load", "resistor", ["output", "0"], { resistanceOhms: loadResistance }],
      ["ground", "ground", ["0"]],
    ], "Floating differential op-amp signal");
    const analysis = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("valid");
    for (const residual of modelAndConservationResiduals(analysis)) { expect(residual).toBeLessThan(1e-12); }
    expect(complexResidual(analysis.parts.amp.terminalVoltages.a!, { real: 0, imaginary: 0 })).toBe(0);
    expect(complexResidual(analysis.parts.amp.terminalVoltages.b!, { real: -1, imaginary: 0 })).toBe(0);
    expect(complexResidual(analysis.parts.amp.voltage, { real: 0.5, imaginary: 0 })).toBe(0);
  });

  it("preserves the control voltage when converting the result to scalar readings", () => {
    const document = floatingInputCircuit("positive", 0);
    const analysis = analyzeCircuit(document, {}, { mode: "ac" });
    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.amp.terminalVoltages?.a).toBe(1);
    expect(analysis.parts.amp.terminalVoltages?.b).toBe(0);
    expect(analysis.parts.amp.terminalVoltages?.c).toBe(0.5);
    expect(analysis.parts.amp.terminalCurrents?.c).toBe(0.025);
    expect(analysis.parts.amp.terminalCurrentPhasesDegrees?.c).toBe(180);
    expect(analysis.parts.meter.meterStatus).toBe("floating");
  });
});
