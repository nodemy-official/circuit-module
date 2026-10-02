import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec as Spec } from "../helpers/circuit-fixture.js";
import { simulateTransient } from "../../transient-solver.js";

const circuit = (specs: readonly Spec[]) =>
  createCircuitFromSpecs(specs, "Independent postfix analog review");

function relative(actual: number, expected: number) {
  return Math.abs((actual - expected) / expected);
}

function ac(id: string, nodes: readonly string[], frequencyHz: number, voltageVolts = 1, phaseDegrees = 0, offsetVolts = 0): Spec {
  return [id, "ac-source", nodes, { frequencyHz, voltageVolts, phaseDegrees, offsetVolts }];
}

describe("continuous ideal-source loop constraints", () => {
  it.each([false, true])("rejects a triangle whose sampled values and slopes agree (reversed=%s)", (reversed) => {
    const specs = [ac("one", ["a", "b"], 1), ac("two", ["b", "0"], 2), ac("sum", ["a", "0"], 3, 2)];
    const residual = (time: number) => Math.SQRT2 * (Math.cos(2 * Math.PI * time)
      + Math.cos(4 * Math.PI * time) - 2 * Math.cos(6 * Math.PI * time));
    expect(residual(0)).toBe(0);
    expect(Math.abs(residual(0.25))).toBeGreaterThan(1);
    const result = simulateTransient(circuit(reversed ? specs.reverse() : specs), { durationSeconds: 2, timeStepSeconds: 1 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it.each([false, true])("retains a mixed-frequency loop with independent cancellation per frequency and DC (reversed=%s)", (reversed) => {
    const specs: Spec[] = [
      ac("one", ["a", "b"], 1, 2, 37, 1),
      ac("two", ["b", "c"], 2, 3, 73, -2),
      ac("minus-one", ["d", "c"], 1, 2, 397, 1),
      ac("minus-two", ["0", "d"], 2, 3, 433, -2),
      ["closure", "ammeter", ["a", "0"]],
      ["load", "resistor", ["a", "b"], { resistanceOhms: 100 }],
    ];
    const result = simulateTransient(circuit(reversed ? specs.reverse() : specs), { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      const expected = 1 + 2 * Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + 37 * Math.PI / 180);
      expect(relative(sample.parts.load!.voltageVolts, expected)).toBeLessThan(2e-12);
      expect(relative(sample.parts.load!.currentAmps, expected / 100)).toBeLessThan(2e-12);
    }
  });

  it.each(["wire", "ammeter", "switch"])("rejects a zero-crossing ideal AC source shorted through %s", (short) => {
    const specs: Spec[] = [ac("source", ["a", short === "wire" ? "a" : "0"], 1, 1, 90)];
    if (short !== "wire") { specs.push(["short", short as "ammeter" | "switch", ["a", "0"], { initiallyClosed: true }]); }
    const result = simulateTransient(circuit(specs), { durationSeconds: 1, timeStepSeconds: 0.5 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it("accepts shorted zero-amplitude sources independent of their frequency", () => {
    const result = simulateTransient(circuit([ac("source", ["0", "0"], 1, 0)]), { durationSeconds: 1, timeStepSeconds: 0.5 });
    expect(result.status, result.message).toBe("valid");
  });

  it("accepts an exact trigonometric source triangle with equal RMS coefficients", () => {
    // cos(x-60 degrees) + cos(x+60 degrees) = cos(x) identically.
    const document = circuit([ac("minus", ["a", "b"], 1, 1, -60),
      ac("plus", ["b", "0"], 1, 1, 60), ac("sum", ["a", "0"], 1)]);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const acResult = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1 });
    const transient = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(dc.status, dc.message).toBe("valid");
    expect(acResult.status, acResult.message).toBe("valid");
    expect(transient.status, transient.message).toBe("valid");
  });
});
