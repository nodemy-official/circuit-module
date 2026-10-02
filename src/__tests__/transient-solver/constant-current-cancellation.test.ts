import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

describe("constant current cancellation beside a weak junction", () => {
  it.each((["diode", "led"] as const).flatMap((kind) =>
    [
      ...[1e20, 1e100, 1e140].map((current) => ({ current, saturation: Number.MIN_VALUE, inductance: 1, timeStep: 0.001 })),
      { current: 1e100, saturation: 1e-300, inductance: 1e300, timeStep: 1 },
      { current: 1e100, saturation: 1e-240, inductance: 1e237, timeStep: 0.001 },
      { current: 1e200, saturation: 1e-200, inductance: 1e200, timeStep: 1 },
    ].map((parameters) => ({ kind, ...parameters })),
  ))("preserves zero voltage and power for $kind with I=$current, Is=$saturation, L=$inductance", ({ kind, current, saturation, inductance, timeStep }) => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["inductor", "inductor", ["node", "0"], { inductanceHenries: inductance, initialCurrentAmps: current }],
      ["source", "current-source", ["node", "0"], { currentAmps: -current }],
      ["junction", kind, ["node", "0"], { saturationCurrentAmps: saturation }],
    ], "Exact equilibrium of an inductor and current source");
    const result = simulateTransient(document, { durationSeconds: 2 * timeStep, timeStepSeconds: timeStep });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    // I_L + I_source = 0 and V_junction = 0 solve both Shockley and KCL.
    // Consequently V_L = L * dI_L/dt and every terminal power are exactly zero.
    for (const sample of result.samples) {
      expect(sample.parts.inductor!.currentAmps).toBe(current);
      expect(sample.parts.source!.currentAmps).toBe(-current);
      expect(sample.parts.junction!.currentAmps).toBe(0);
      for (const id of ["inductor", "source", "junction"]) {
        expect(sample.parts[id]!.voltageVolts).toBe(0);
        expect(sample.parts[id]!.powerWatts).toBe(0);
      }
    }
  });

  it.each([1, -1])("retains a small independent drive beside exact current cancellation (sign=%s)", (sign) => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["inductor", "inductor", ["node", "0"], { inductanceHenries: 1e300, initialCurrentAmps: sign * 1e100 }],
      ["source", "current-source", ["node", "0"], { currentAmps: -sign * 1e100 }],
      ["drive", "current-source", ["0", "node"], { currentAmps: sign * 1e-300 }],
      ["junction", "diode", sign === 1 ? ["node", "0"] : ["0", "node"], { saturationCurrentAmps: 1e-300 }],
    ], "Small drive changes a large conserved current");
    const result = simulateTransient(document, { durationSeconds: 2, timeStepSeconds: 1 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    // Scale KCL by L/dt: V + (L*Is/dt)*expm1(V/Vt) = remaining drive.
    // Each step's voltage reduces the remaining drive by its inductor update.
    const factor = 1e300 * 1e-300;
    let remaining = factor;
    for (const [index, sample] of result.samples.entries()) {
      let expected = 0.025_85 * Math.LN2;
      if (index > 0) {
        let low = 0;
        let high = expected;
        for (let iteration = 0; iteration < 100; iteration += 1) {
          const voltage = (low + high) / 2;
          if (voltage + factor * Math.expm1(voltage / 0.025_85) > remaining) { high = voltage; }
          else { low = voltage; }
        }
        expected = (low + high) / 2;
        remaining -= expected;
      }
      expect(Math.abs(sample.parts.junction!.voltageVolts / expected - 1)).toBeLessThan(1e-12);
      expect(Math.abs(sample.parts.inductor!.voltageVolts / (sign * expected) - 1)).toBeLessThan(1e-12);
    }
  });
});
