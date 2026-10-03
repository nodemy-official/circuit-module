import { describe, expect, it } from "vitest";
import { MAX_TRANSIENT_STEPS, simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

describe("represented transient sampling intervals", () => {
  it.each([Number.EPSILON / 2, Number.EPSILON, 8 * Number.EPSILON])(
    "preserves the final capacitor charge interval of %s seconds",
    (gap) => {
      const document = createCircuitFromSpecs([
        ["source", "ac-source", ["v", "g"], { voltageVolts: 1, frequencyHz: 1, phaseDegrees: 90 }],
        ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
      ], "One-cycle capacitor charge balance");
      const step = 1 - gap;
      const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: step });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, step, 1]);
      const previous = result.samples[1]!.parts.c;
      const final = result.samples[2]!.parts.c;
      const dt = 1 - step;
      // V(1-dt)=sqrt(2)*sin(2*pi*dt), V(1)=0. Factor the endpoint
      // difference to avoid independently subtracting two cosine values.
      const expectedCurrent = -Math.SQRT2 * Math.sin(2 * Math.PI * dt) / dt;
      expect(previous.voltageVolts).toBeGreaterThan(0);
      expect(final.voltageVolts).toBe(0);
      expect(Math.abs(final.currentAmps / expectedCurrent - 1)).toBeLessThan(1e-13);
      expect(Math.abs((final.voltageVolts - previous.voltageVolts) / dt / final.currentAmps - 1)).toBeLessThan(1e-13);
    },
  );

  it("rejects a represented final interval beyond the maximum step count", () => {
    const document = createCircuitFromSpecs([
      ["r", "resistor", ["a", "b"], { resistanceOhms: 1 }],
    ], "Strict transient step limit");
    const durationSeconds = MAX_TRANSIENT_STEPS + Number.EPSILON * MAX_TRANSIENT_STEPS;
    const result = simulateTransient(document, { durationSeconds, timeStepSeconds: 1 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
    expect(result.message).toContain(`時間分割数は${MAX_TRANSIENT_STEPS}以下`);
  });
});
