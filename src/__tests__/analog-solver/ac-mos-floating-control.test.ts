import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const scenarios = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].flatMap((reverse) => [0, 0.01].flatMap((lambda) =>
    [0, 37, 90].map((phase) => ({ kind, reverse, lambda, phase })),
  )),
);

describe("AC MOS floating gate coordinates", () => {
  it.each(scenarios)("preserves $kind control at reverse=$reverse lambda=$lambda phase=$phase", ({ kind, reverse, lambda, phase }) => {
    const sign = kind === "nmos" ? 1 : -1;
    const document = createCircuitFromSpecs([
      ["signal", "ac-source", ["gate", "return"], { voltageVolts: 0.01, offsetVolts: sign * 5, frequencyHz: 1000, phaseDegrees: phase }],
      ["dangling", "resistor", ["return", "unused"], { resistanceOhms: 1 }],
      ["supply", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 10 }],
      ["load", "resistor", ["supply", "output"], { resistanceOhms: 100 }],
      ["device", kind, reverse ? ["0", "gate", "output"] : ["output", "gate", "0"], { channelLengthModulation: lambda }],
      ["meter", "voltmeter", ["gate", "0"]],
      ["ground", "ground", ["0"]],
    ], "Floating MOS gate display preserves its small-signal equation");
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    const vds = Math.abs(dc.parts.device!.voltage.real);
    const gm = 0.02 * vds * (1 + lambda * vds);
    const gds = 0.02 * (3 - vds) * (1 + lambda * vds) +
      0.02 * (3 * vds - vds * vds / 2) * lambda;
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const ac = analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" });
      expect(ac.status, ac.message).toBe("valid");
      const device = ac.parts.device!;
      const drain = device.terminalVoltages.a!;
      const gate = device.terminalVoltages.b!;
      const source = device.terminalVoltages.c!;
      const effectiveSource = reverse ? drain : source;
      // The published voltage coordinates must reproduce the published
      // current through the independent square-law small-signal equation.
      for (const axis of ["real", "imaginary"] as const) {
        const expected = gds * (drain[axis] - source[axis]) +
          (reverse ? -gm : gm) * (gate[axis] - effectiveSource[axis]);
        expect(Math.abs(device.current[axis] - expected)).toBeLessThan(1e-14);
        const outputCurrent = reverse ? device.terminalCurrents.c! : device.terminalCurrents.a!;
        expect(Math.abs(outputCurrent[axis] - ac.parts.load!.current[axis])).toBeLessThan(1e-14);
        expect(device.terminalCurrents.b![axis]).toBe(0);
      }
      expect(ac.parts.meter!.meterStatus).toBe("floating");
    }
    const scalar = analyzeCircuit(document, {}, { mode: "ac" });
    expect(scalar.status, scalar.message).toBe("closed");
    expect(scalar.parts.device!.terminalVoltages!.b).toBeCloseTo(0.01, 14);
    expect(scalar.parts.meter!.meterStatus).toBe("floating");
  });
});
