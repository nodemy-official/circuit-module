import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

type IdealBridge = "wire" | "ammeter" | "switch" | "pot-a" | "pot-b";

function sourceLoop(bridge: IdealBridge, amplitude: number, reverse: boolean, initialVoltageVolts?: number, capacitorAcrossBridge = false) {
  const specs: CircuitSpec[] = [
    ["left", "ac-source", ["v", "m"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: -60 }],
    ["right", "ac-source", [bridge === "wire" ? "m" : "n", "g"],
      { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: 60 }],
    ["total", "ac-source", ["v", "g"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: 0 }],
  ];
  if (bridge === "pot-a" || bridge === "pot-b") {
    specs.push(["bridge", "potentiometer", bridge === "pot-a" ? ["m", "g", "n"] : ["g", "m", "n"],
      { resistanceOhms: 2, wiperPosition: bridge === "pot-a" ? 0 : 1 }]);
  } else if (bridge !== "wire") {
    specs.push(["bridge", bridge, ["m", "n"], { initiallyClosed: true }]);
  }
  specs.push(["ground", "ground", ["g"]]);
  if (initialVoltageVolts !== undefined) {
    specs.push(["cap", "capacitor", capacitorAcrossBridge ? ["m", "n"] : ["v", "g"],
      { capacitanceFarads: 1, initialVoltageVolts }]);
  }
  return createCircuitFromSpecs(reverse ? specs.toReversed() : specs, "Consistent source loop with an initial capacitor state");
}

const bridges: IdealBridge[] = ["wire", "ammeter", "switch", "pot-a", "pot-b"];

describe("initial capacitor constraints in a consistent source forest", () => {
  it.each(bridges.filter((bridge) => bridge !== "wire").flatMap((bridge) =>
    [false, true].map((reverse) => ({ bridge, reverse }))))(
    "keeps a capacitor shorted by $bridge at zero, reverse=$reverse",
    ({ bridge, reverse }) => {
      const document = sourceLoop(bridge, 0.1, reverse, 0, true);
      const result = simulateTransient(document, { durationSeconds: 1 / 32, timeStepSeconds: 1 / 128 });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(5);
      for (const sample of result.samples) {
        const capacitor = sample.parts.cap!;
        expect(capacitor.voltageVolts).toBe(0);
        expect(capacitor.currentAmps).toBe(0);
        expect(capacitor.powerWatts).toBe(0);
        expect(capacitor.terminalVoltages!.a).toBe(capacitor.terminalVoltages!.b);
        const reading = sample.parts.bridge!;
        if (bridge === "pot-a" || bridge === "pot-b") {
          expect(reading.terminalVoltages![bridge === "pot-a" ? "a" : "b"]).toBe(reading.terminalVoltages!.c);
        } else {
          expect(reading.voltageVolts).toBe(0);
        }
      }
    },
  );

  it.each(bridges.flatMap((bridge) => [0.1, 1, 3].flatMap((amplitude) =>
    [false, true].map((reverse) => ({ bridge, amplitude, reverse })))))(
    "accepts the sampled initial voltage through $bridge at amplitude=$amplitude, reverse=$reverse",
    ({ bridge, amplitude, reverse }) => {
      // cos(x-60deg)+cos(x+60deg)=cos(x): the source loop is
      // consistent for the entire waveform, independently of its forest.
      const step = 1e-5;
      const options = { durationSeconds: step, timeStepSeconds: step };
      const sourceOnly = simulateTransient(sourceLoop(bridge, amplitude, reverse), options);
      expect(sourceOnly.status, sourceOnly.message).toBe("valid");
      const total = sourceOnly.samples[0]!.parts.total!;
      const initialVoltage = total.voltageVolts;
      // The total source returns to physical ground, so this comparison
      // does not subtract two independently rounded nonzero potentials.
      expect(total.terminalVoltages!.b).toBe(0);
      expect(initialVoltage).toBe(total.terminalVoltages!.a);
      const result = simulateTransient(sourceLoop(bridge, amplitude, reverse, initialVoltage), options);

      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(2);
      expect(result.samples[0]!.parts.cap!.currentAmps).toBe(0);
      for (const sample of result.samples) {
        expect(sample.parts.total!.voltageVolts).toBe(sample.parts.total!.terminalVoltages!.a);
        expect(sample.parts.cap!.voltageVolts).toBe(sample.parts.total!.voltageVolts);
      }
      // Independent half-angle identity for the first backward-Euler
      // current, without subtracting two nearly equal peak voltages.
      const expectedCurrent = -2 * amplitude * Math.SQRT2 * Math.sin(Math.PI * step) ** 2 / step;
      expect(Math.abs(result.samples[1]!.parts.cap!.currentAmps / expectedCurrent - 1)).toBeLessThan(1e-12);
    },
  );
});
