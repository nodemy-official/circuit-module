import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function currentBiasedJunction(kind: "diode" | "led", current: number, sign: number, extraParts: CircuitSpec[] = []) {
  return createCircuitFromSpecs([
    ["ground", "ground", ["0"]],
    ["source", "current-source", ["0", "junction"], { currentAmps: sign * current }],
    ["junction", kind, sign === 1 ? ["junction", "0"] : ["0", "junction"], {
      saturationCurrentAmps: current,
      emissionCoefficient: kind === "led" ? 2 : 1,
    }],
    ...extraParts,
  ], "Subnormal current-biased junction");
}

describe("subnormal junction convergence", () => {
  it.each((["diode", "led"] as const).flatMap((kind) =>
    [1, -1].flatMap((sign) => [Number.MIN_VALUE, 2 * Number.MIN_VALUE].map((current) => ({ kind, sign, current }))),
  ))("balances $kind at current $current and orientation $sign", ({ kind, sign, current }) => {
    const document = currentBiasedJunction(kind, current, sign);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    // Shockley: I = Is implies V = n * Vt * ln(2), regardless of current scale.
    const expectedVoltage = (kind === "led" ? 2 : 1) * 0.025_85 * Math.LN2;
    expect(dc.parts.junction!.current.real).toBe(current);
    expect(Math.abs(dc.parts.junction!.voltage.real / expectedVoltage - 1)).toBeLessThan(1e-12);
    expect(dc.parts.source!.current.real).toBe(sign * current);
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.junction!.current.real).toBe(0);
  });

  it.each((["diode", "led"] as const).flatMap((kind) =>
    [1e16, -1e16].map((common) => ({ kind, common })),
  ))("balances a minimum-current $kind beside a circuit at $common V", ({ kind, common }) => {
    const document = currentBiasedJunction(kind, Number.MIN_VALUE, 1, [
      ["common", "ac-source", ["reference", "0"], { offsetVolts: common, voltageVolts: 0 }],
      ["supply", "battery", ["supply", "reference"], { voltageVolts: 1 }],
      ["load", "resistor", ["supply", "series"], { resistanceOhms: 1000 }],
      ["seriesDiode", "diode", ["series", "reference"], { saturationCurrentAmps: 1e-12 }],
    ]);
    // Independent scalar KCL for the ordinary diode: V + R * Is * expm1(V/Vt) = 1.
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const voltage = (low + high) / 2;
      if (voltage + 1000 * 1e-12 * Math.expm1(voltage / 0.025_85) > 1) { high = voltage; } else { low = voltage; }
    }
    const seriesVoltage = (low + high) / 2;
    const tinyVoltage = (kind === "led" ? 2 : 1) * 0.025_85 * Math.LN2;
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.junction!.current.real).toBe(Number.MIN_VALUE);
    expect(Math.abs(dc.parts.junction!.voltage.real / tinyVoltage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(dc.parts.seriesDiode!.voltage.real / seriesVoltage - 1)).toBeLessThan(1e-12);
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(sample.parts.junction!.currentAmps).toBe(Number.MIN_VALUE);
      expect(Math.abs(sample.parts.junction!.voltageVolts / tinyVoltage - 1)).toBeLessThan(1e-12);
      expect(Math.abs(sample.parts.seriesDiode!.voltageVolts / seriesVoltage - 1)).toBeLessThan(1e-12);
    }
  });

  it.each(["diode", "led"] as const)("retains the minimum-current transient bias of %s", (kind) => {
    const transient = simulateTransient(currentBiasedJunction(kind, Number.MIN_VALUE, 1), {
      durationSeconds: 0.002,
      timeStepSeconds: 0.001,
    });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples).toHaveLength(3);
    const expectedVoltage = (kind === "led" ? 2 : 1) * 0.025_85 * Math.LN2;
    for (const sample of transient.samples) {
      expect(sample.parts.junction!.currentAmps).toBe(Number.MIN_VALUE);
      expect(Math.abs(sample.parts.junction!.voltageVolts / expectedVoltage - 1)).toBeLessThan(1e-12);
    }
  });
});
