import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { nextDown, nextUp } from "../helpers/numeric-oracle.js";

function capacitorAtWiper(wiperPosition: number, initialVoltageVolts: number, phaseDegrees = 0) {
  return createCircuitFromSpecs([
    ["source", "ac-source", ["v", "g"], { voltageVolts: 0.1, frequencyHz: 1, phaseDegrees }],
    ["pot", "potentiometer", wiperPosition === 0 ? ["v", "g", "c"] : ["g", "v", "c"],
      { resistanceOhms: 1000, wiperPosition }],
    ["cap", "capacitor", ["c", "g"], { capacitanceFarads: 1, initialVoltageVolts }],
  ], "Capacitor connected through an ideal wiper segment");
}

describe("initial capacitor voltage through an ideal potentiometer segment", () => {
  it.each([0, 1].flatMap((position) => [false, true].map((reverse) => ({ position, reverse }))))(
    "keeps the AC constraint at position=$position, reversed order=$reverse",
    ({ position, reverse }) => {
      const document = capacitorAtWiper(position, 0.1 * Math.SQRT2);
      if (reverse) { document.parts.reverse(); document.wires.reverse(); }
      const step = 1e-5;
      const result = simulateTransient(document, { durationSeconds: step, timeStepSeconds: step });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(2);
      expect(result.samples[0]!.parts.cap.currentAmps).toBe(0);
      // C*dV/dt averaged over the first backward-Euler interval. The
      // half-angle identity avoids subtracting two nearly equal voltages.
      const expectedCurrent = -2 * 0.1 * Math.SQRT2 * Math.sin(Math.PI * step) ** 2 / step;
      const sample = result.samples[1]!;
      expect(Math.abs(sample.parts.cap.currentAmps / expectedCurrent - 1)).toBeLessThan(1e-13);
      expect(sample.parts.cap.voltageVolts).toBe(sample.parts.source.voltageVolts);
    },
  );

  it.each([0, 1].flatMap((position) => [-1, 1].map((side) => ({ position, side }))))(
    "rejects an adjacent initial voltage at position=$position, side=$side",
    ({ position, side }) => {
      const voltage = 0.1 * Math.SQRT2;
      const document = capacitorAtWiper(position, side < 0 ? nextDown(voltage) : nextUp(voltage));
      const result = simulateTransient(document, { durationSeconds: 1e-5, timeStepSeconds: 1e-5 });
      expect(result.status).toBe("invalid");
      expect(result.samples).toHaveLength(0);
    },
  );

  it.each([0, 1])("keeps the initial source derivative through the ideal segment at position=%s", (position) => {
    const document = capacitorAtWiper(position, 0.1, 45);
    const result = simulateTransient(document, { durationSeconds: 1e-5, timeStepSeconds: 1e-5 });
    expect(result.status, result.message).toBe("valid");
    const initial = result.samples[0]!;
    // At phase 45 degrees, V(0)=Vrms and C*dV/dt=-2*pi*f*C*Vrms.
    const expectedCurrent = -2 * Math.PI * 0.1;
    expect(Math.abs(initial.parts.cap.currentAmps / expectedCurrent - 1)).toBeLessThan(1e-13);
    expect(initial.parts.cap.voltageVolts).toBe(0.1);
  });

  it("retains a nonzero internal segment even when its displayed resistance underflows", () => {
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["v", "g"], { voltageVolts: Number.MIN_VALUE, frequencyHz: 1, phaseDegrees: 45 }],
      ["pot", "potentiometer", ["v", "g", "c"], { resistanceOhms: Number.MIN_VALUE, wiperPosition: 0.5 }],
      ["cap", "capacitor", ["c", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
    ], "Two finite potentiometer segments below the display range");
    const result = simulateTransient(document, { durationSeconds: 1 / 8, timeStepSeconds: 1 / 8 });
    expect(result.status, result.message).toBe("valid");
    const initial = result.samples[0]!;
    // V/(R/2)=2 A; the wiper starts at ground, so the other segment
    // carries no current and the entire source current charges C.
    expect(initial.parts.cap.voltageVolts).toBe(0);
    expect(initial.parts.cap.currentAmps).toBe(2);
    expect(initial.parts.source.currentAmps).toBe(-2);
  });
});
