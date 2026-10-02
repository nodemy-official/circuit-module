import { describe, expect, it } from "vitest";

import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import { nextDown, nextUp } from "../helpers/numeric-oracle.js";

const amplitudes = [0.1, 1, 3, 1e16];
const options = { durationSeconds: 0.25, timeStepSeconds: 0.125 };

function constrainedSourceLoop(amplitude: number, reversed: boolean, initialVoltage?: number) {
  const specs: CircuitSpec[] = [
    ["first", "ac-source", ["v", "m"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: -60 }],
    ["second", "ac-source", ["m", "n"], { voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: 60 }],
    ["third", "ac-source", ["n", "0"], {
      voltageVolts: amplitude, frequencyHz: 1, phaseDegrees: 180, offsetVolts: 1,
    }],
    ["dc", "battery", ["v", "0"], { voltageVolts: 1 }],
    ["load", "resistor", ["v", "0"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ];
  if (initialVoltage !== undefined) {
    specs.push(["cap", "capacitor", ["v", "0"], {
      capacitanceFarads: 1,
      initialVoltageVolts: initialVoltage,
    }]);
  }
  return createCircuitFromSpecs(reversed ? specs.toReversed() : specs, "DC constraint across a cancelling AC source loop");
}

describe("pure DC constraints take precedence over a rounded AC source forest", () => {
  it.each(amplitudes.flatMap((amplitude) => [false, true].flatMap((reversed) =>
    [false, true].map((withCapacitor) => ({ amplitude, reversed, withCapacitor })))))(
    "preserves the 1 V constraint at amplitude=$amplitude, reversed=$reversed, capacitor=$withCapacitor",
    ({ amplitude, reversed, withCapacitor }) => {
      // cos(x-60deg)+cos(x+60deg)+cos(x+180deg)=0 at every time.
      // The three AC sources therefore sum to the third source's 1 V offset.
      // The parallel ideal battery fixes Vload=1 V, Iload=1 A and Ic=C*dV/dt=0.
      const analysis = simulateTransient(constrainedSourceLoop(amplitude, reversed, withCapacitor ? 1 : undefined), options);
      expect(analysis.status, analysis.message).toBe("valid");
      expect(analysis.samples).toHaveLength(3);
      for (const sample of analysis.samples) {
        expect(sample.parts.dc!.voltageVolts).toBe(1);
        expect(sample.parts.dc!.terminalVoltages!.a).toBe(1);
        expect(sample.parts.dc!.terminalVoltages!.b).toBe(0);
        expect(sample.parts.load!.voltageVolts).toBe(1);
        expect(sample.parts.load!.currentAmps).toBe(1);
        expect(sample.parts.load!.powerWatts).toBe(1);
        if (withCapacitor) {
          expect(sample.parts.cap!.voltageVolts).toBe(1);
          expect(sample.parts.cap!.currentAmps).toBe(0);
          expect(sample.parts.cap!.powerWatts).toBe(0);
        }
      }
    },
  );

  it.each(amplitudes.flatMap((amplitude) => [false, true].flatMap((reversed) =>
    [-1, 1].map((side) => ({ amplitude, reversed, side })))))(
    "rejects an adjacent capacitor voltage at amplitude=$amplitude, reversed=$reversed, side=$side",
    ({ amplitude, reversed, side }) => {
      const initialVoltage = side < 0 ? nextDown(1) : nextUp(1);
      const analysis = simulateTransient(constrainedSourceLoop(amplitude, reversed, initialVoltage), options);
      expect(analysis.status).toBe("invalid");
      expect(analysis.samples).toHaveLength(0);
    },
  );
});
