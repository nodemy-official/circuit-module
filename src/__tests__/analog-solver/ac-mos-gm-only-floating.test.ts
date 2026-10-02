import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const scenarios = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].flatMap((reverse) => [0, 37, 90].map((phase) => ({ kind, reverse, phase }))),
);

describe("saturated MOS AC response with a floating gate supply", () => {
  it.each(scenarios)("solves $kind with only gm at reverse=$reverse phase=$phase", ({ kind, reverse, phase }) => {
    const sign = kind === "nmos" ? 1 : -1;
    const document = createCircuitFromSpecs([
      ["signal", "ac-source", ["gate", "return"], { voltageVolts: 0.01, offsetVolts: sign * 3, frequencyHz: 1000, phaseDegrees: phase }],
      ["dangling", "resistor", ["return", "unused"], { resistanceOhms: 1 }],
      ["supply", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 10 }],
      ["load", "resistor", ["supply", "output"], { resistanceOhms: 100 }],
      ["device", kind, reverse ? ["0", "gate", "output"] : ["output", "gate", "0"], { channelLengthModulation: 0 }],
      ["meter", "voltmeter", ["gate", "0"]],
      ["ground", "ground", ["0"]],
    ], "A floating gate supply driving a saturated MOS");
    const bias = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(bias.status, bias.message).toBe("valid");
    expect(Math.abs(bias.parts.device!.current.real)).toBeCloseTo(0.01, 14);
    // Square-law saturation: gm=k*(|Vgs|-Vth)=0.02 S, gds=0.
    // Keeping the existing floating input reference gives id=gm*vg and
    // vo=-100*id. Every source, gate, and output KCL equation still holds.
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const ac = analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" });
      expect(ac.status, ac.message).toBe("valid");
      const output = ac.parts.device!.terminalVoltages[reverse ? "c" : "a"]!;
      const gate = ac.parts.device!.terminalVoltages.b!;
      for (const axis of ["real", "imaginary"] as const) {
        const direction = axis === "real" ? Math.cos(phase * Math.PI / 180) : Math.sin(phase * Math.PI / 180);
        expect(Math.abs(gate[axis] - 0.01 * direction)).toBeLessThan(1e-14);
        expect(Math.abs(ac.parts.load!.current[axis] - 0.0002 * direction)).toBeLessThan(1e-14);
        expect(Math.abs(output[axis] + 0.02 * direction)).toBeLessThan(1e-14);
        expect(ac.parts.device!.terminalCurrents.b![axis]).toBe(0);
        expect(ac.parts.signal!.current[axis]).toBe(0);
        expect(ac.parts.dangling!.current[axis]).toBe(0);
      }
      expect(ac.parts.meter!.meterStatus).toBe("floating");
    }
  });

  it.each((["nmos", "pmos"] as const).flatMap((kind) =>
    [false, true].map((upperFloating) => ({ kind, upperFloating })),
  ))("retains the free input reference in cascaded $kind (upperFloating=$upperFloating)", ({ kind, upperFloating }) => {
    const sign = kind === "nmos" ? 1 : -1;
    const document = createCircuitFromSpecs([
      ["signal", "ac-source", ["gate", "return"], { voltageVolts: 0.01, offsetVolts: sign * 3, frequencyHz: 1000 }],
      ["dangling", "resistor", ["return", "unused"], { resistanceOhms: 1 }],
      ["upper-bias", "ac-source", ["upper-gate", upperFloating ? "upper-return" : "0"], { voltageVolts: 0, offsetVolts: sign * 5, frequencyHz: 1000 }],
      ...(upperFloating ? [["upper-dangling", "resistor", ["upper-return", "upper-unused"], { resistanceOhms: 1 }] as const] : []),
      ["supply", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 10 }],
      ["load", "resistor", ["supply", "output"], { resistanceOhms: 100 }],
      ["upper", kind, ["output", "upper-gate", "middle"], { channelLengthModulation: 0 }],
      ["lower", kind, ["middle", "gate", "0"], { channelLengthModulation: 0 }],
      ["meter", "voltmeter", ["gate", "0"]],
      ["ground", "ground", ["0"]],
    ], "Floating gate references in cascaded saturated MOS devices");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const bias = analyzeAnalogCircuit({ ...document, parts }, { mode: "dc" });
      expect(bias.status, bias.message).toBe("valid");
      expect(bias.parts.lower!.voltage.real).toBe(sign * 2);
      const ac = analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" });
      expect(ac.status, ac.message).toBe("valid");
      expect(ac.parts.lower!.current.real).toBeCloseTo(0.0002, 14);
      expect(ac.parts.upper!.current.real).toBe(ac.parts.lower!.current.real);
      expect(ac.parts.load!.current.real).toBe(ac.parts.lower!.current.real);
      const upperGate = ac.parts.upper!.terminalVoltages.b!.real;
      const middle = ac.parts.upper!.terminalVoltages.c!.real;
      expect(upperGate - middle).toBeCloseTo(0.01, 14);
      if (!upperFloating) { expect(ac.parts.lower!.voltage.real).toBeCloseTo(-0.01, 14); }
      expect(ac.parts.upper!.terminalVoltages.a!.real).toBeCloseTo(-0.02, 14);
      expect(ac.parts.signal!.current.real).toBe(0);
      expect(ac.parts.meter!.meterStatus).toBe("floating");
    }
  });
});
