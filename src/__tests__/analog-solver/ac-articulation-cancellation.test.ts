import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { complex, complexAdd, complexMagnitude, complexSubtract } from "../../analog-math.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { circuitNodes, circuitPotential } from "../../circuit-visualization.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function cancellingSources(phase: number): CircuitSpec[] {
  return [
    ["first", "ac-source", ["n1", "g"], { voltageVolts: 1, phaseDegrees: phase, frequencyHz: 1 }],
    ["axis", "ac-source", ["n2", "n1"], { voltageVolts: 1, phaseDegrees: 0, frequencyHz: 1 }],
    ["reverse-axis", "ac-source", ["n2", "n3"], { voltageVolts: 1, phaseDegrees: 0, frequencyHz: 1 }],
    ["reverse-first", "ac-source", ["n3", "n4"], { voltageVolts: 1, phaseDegrees: phase, frequencyHz: 1 }],
  ];
}

describe("AC cancellation across independent response groups", () => {
  it.each([37, -37, 45, 1e-200].flatMap((phase) => [
    { phase, loaded: false }, { phase, loaded: true },
  ]))("reports exact zero across cancelling phase $phase sources; loaded=$loaded", ({ phase, loaded }) => {
    const document = createCircuitFromSpecs([
      ...cancellingSources(phase),
      ...(loaded ? [["load", "resistor", ["n2", "g"], { resistanceOhms: 1 }]] satisfies CircuitSpec[] : []),
      ["meter", "voltmeter", ["n4", "g"]], ["ground", "ground", ["g"]],
    ], "Cancelling sources across articulations");
    const analog = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1 });
    expect(analog.status, analog.message).toBe("valid");
    expect(analog.parts.meter.voltage).toEqual(complex());
    expect(complexMagnitude(analog.parts.meter.voltage)).toBe(0);
    // Independent ideal constraints: Vfirst + Vaxis - Vreverse-axis - Vreverse-first = 0.
    expect(complexSubtract(complexAdd(analog.parts.first.voltage, analog.parts.axis.voltage),
      complexAdd(analog.parts["reverse-axis"].voltage, analog.parts["reverse-first"].voltage))).toEqual(complex());
    for (const id of ["first", "axis", "reverse-axis", "reverse-first"]) {
      expect(complexMagnitude(analog.parts[id]!.voltage)).toBe(1);
      const reading = analog.parts[id]!;
      expect(complexSubtract(complexSubtract(reading.terminalVoltages.a!, reading.terminalVoltages.b!), reading.voltage)).toEqual(complex());
    }
    expect(analog.parts["reverse-axis"].current).toEqual(complex());
    expect(analog.parts["reverse-first"].current).toEqual(complex());
    if (loaded) {
      // A one-ohm load has I = V and P = |1 + exp(j*phase)|².
      expect(complexSubtract(analog.parts.load.current, analog.parts.load.voltage)).toEqual(complex());
      expect(analog.parts.load.voltage.real).toBeCloseTo(1 + Math.cos(phase * Math.PI / 180), 14);
      const expectedImaginary = Math.sin(phase * Math.PI / 180);
      expect(analog.parts.load.voltage.imaginary / expectedImaginary).toBeCloseTo(1, 14);
      expect(analog.parts.load.power.real).toBeCloseTo(2 + 2 * Math.cos(phase * Math.PI / 180), 14);
      expect(analog.parts.load.power.imaginary).toBe(0);
      expect(complexAdd(analog.parts.first.current, analog.parts.load.current)).toEqual(complex());
      expect(complexSubtract(analog.parts.first.current, analog.parts.axis.current)).toEqual(complex());
      expect(complexAdd(complexAdd(analog.parts.first.power, analog.parts.axis.power), analog.parts.load.power)).toEqual(complex());
    }
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1 });
    for (const restored of [analysis, structuredClone(analysis), JSON.parse(JSON.stringify(analysis)) as typeof analysis]) {
      expect(restored.parts.meter.voltageVolts).toBe(0);
      const nodes = circuitNodes(document, restored);
      const nodeAt = (terminal: "a" | "b") => nodes.find((node) =>
        node.endpoints.some((endpoint) => endpoint.partId === "meter" && endpoint.terminal === terminal))!;
      expect(circuitPotential(nodeAt("a"), nodeAt("b"), true, { document, analysis: restored, nodes })?.volts).toBe(0);
    }
  });

  it.each([1e-200, Number.MIN_VALUE])("retains a %s V response after loaded source cancellation", (voltageVolts) => {
    const document = createCircuitFromSpecs([
      ...cancellingSources(37),
      ["load", "resistor", ["n2", "g"], { resistanceOhms: 1 }],
      ["tiny", "ac-source", ["n5", "n4"], { voltageVolts, phaseDegrees: 0, frequencyHz: 1 }],
      ["tiny-load", "resistor", ["n5", "g"], { resistanceOhms: 1 }],
      ["meter", "voltmeter", ["n5", "g"]], ["ground", "ground", ["g"]],
    ], "Tiny response after loaded cancellation");
    const analog = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1 });
    expect(analog.status, analog.message).toBe("valid");
    expect(analog.parts.meter.voltage).toEqual(complex(voltageVolts));
    expect(analog.parts["tiny-load"].current).toEqual(complex(voltageVolts));
    expect(analog.parts["reverse-axis"].current).toEqual(complex(voltageVolts));
    expect(analog.parts["reverse-first"].current).toEqual(complex(voltageVolts));
    expect(analog.parts.tiny.current).toEqual(complex(-voltageVolts));
    expect(complexAdd(complexAdd(analog.parts.axis.current, analog.parts["reverse-axis"].current), analog.parts.load.current)).toEqual(complex());
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1 });
    expect(scalar.parts.meter.voltageVolts).toBe(voltageVolts);
    expect(scalar.parts["tiny-load"].currentAmps).toBe(voltageVolts);
  });
});
