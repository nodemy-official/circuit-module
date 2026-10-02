import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function reverseBiasedJunctions(kind: "diode" | "led", saturation: number, factor: number, sign: number): CircuitSpec[] {
  return [
    ["ground", "ground", ["0"]],
    ["current", "current-source", ["0", "input"], { currentAmps: sign * factor * saturation }],
    ["series", "resistor", ["input", "junction"], { resistanceOhms: 1000 }],
    ...["d1", "d2"].map((id): CircuitSpec => [
      id, kind, sign === 1 ? ["junction", "0"] : ["0", "junction"], { saturationCurrentAmps: saturation },
    ]),
  ];
}

describe("junction current feasibility", () => {
  it.each((["diode", "led"] as const).flatMap((kind) =>
    [Number.MIN_VALUE, 1e-12].flatMap((saturation) => [1, -1].map((sign) => ({ kind, saturation, sign }))),
  ))("checks the sum of reverse limits for $kind at Is=$saturation and sign=$sign", ({ kind, saturation, sign }) => {
    const invalid = analyzeAnalogCircuit(createCircuitFromSpecs(
      reverseBiasedJunctions(kind, saturation, -3, sign), "Reverse current beyond two junctions' total leakage",
    ));
    expect(invalid.status).toBe("invalid");
    expect(invalid.message).not.toContain("理想電圧源のループ");

    const valid = analyzeAnalogCircuit(createCircuitFromSpecs(
      reverseBiasedJunctions(kind, saturation, -1, sign), "Reverse current within two junctions' total leakage",
    ));
    expect(valid.status, valid.message).toBe("valid");
    // Each junction carries -Is/2, including when that current rounds to zero.
    const voltage = -(kind === "led" ? 2 : 1) * 0.025_85 * Math.LN2;
    for (const id of ["d1", "d2"]) {
      expect(Math.abs(valid.parts[id]!.voltage.real / voltage - 1)).toBeLessThan(1e-12);
    }
  });

  it("preserves a subnormal infeasibility after large imposed currents cancel", () => {
    const specs = reverseBiasedJunctions("diode", Number.MIN_VALUE, -3, 1);
    specs.push(
      ["large1", "current-source", ["0", "input"], { currentAmps: 1e300 }],
      ["large2", "current-source", ["0", "input"], { currentAmps: -1e300 }],
    );
    for (const parts of [specs, specs.toReversed()]) {
      expect(analyzeAnalogCircuit(createCircuitFromSpecs(parts, "Exact current cancellation")).status).toBe("invalid");
    }
  });

  it.each([1, -1])("allows forward conduction through reverse-parallel junctions with current sign %s", (sign) => {
    const current = sign * 1e-3;
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["current", "current-source", ["0", "junction"], { currentAmps: current }],
      ["forward", "diode", ["junction", "0"], { saturationCurrentAmps: 1e-12 }],
      ["reverse", "diode", ["0", "junction"], { saturationCurrentAmps: 1e-12 }],
    ], "Bidirectional diode return path");
    const result = analyzeAnalogCircuit(document);
    expect(result.status, result.message).toBe("valid");
    const voltage = 0.025_85 * Math.asinh(current / (2 * 1e-12));
    expect(Math.abs(result.parts.forward!.voltage.real / voltage - 1)).toBeLessThan(1e-12);
  });

  it("allows a resistor bypass and honors its actual switch state", () => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["current", "current-source", ["0", "junction"], { currentAmps: -3e-12 }],
      ["diode", "diode", ["junction", "0"]],
      ["switch", "switch", ["junction", "load"], { initiallyClosed: false }],
      ["load", "resistor", ["load", "0"], { resistanceOhms: 1e9 }],
    ], "Switchable reverse-current bypass");
    expect(analyzeAnalogCircuit(document).status).toBe("invalid");
    const result = analyzeAnalogCircuit(document, { mode: "dc", switchStates: { switch: true } });
    expect(result.status, result.message).toBe("valid");
    const voltage = result.parts.diode!.voltage.real;
    const residual = voltage / 1e9 + 1e-12 * Math.expm1(voltage / 0.025_85) + 3e-12;
    expect(Math.abs(residual / 3e-12)).toBeLessThan(1e-12);
  });

  it("allows an ideal source or transient capacitor to carry the imposed current", () => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["current", "current-source", ["0", "junction"], { currentAmps: -3e-12 }],
      ["diode", "diode", ["junction", "0"]],
    ];
    const clamped = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...specs, ["clamp", "ac-source", ["junction", "0"], { voltageVolts: 0, offsetVolts: 0 }],
    ], "Ideal voltage source bypass"), { mode: "dc" });
    expect(clamped.status, clamped.message).toBe("valid");
    expect(clamped.parts.clamp!.current.real).toBe(-3e-12);
    const document = createCircuitFromSpecs([
      ...specs, ["capacitor", "capacitor", ["junction", "0"], { capacitanceFarads: 1e-6, initialVoltageVolts: 0 }],
    ], "Capacitor accepts current beyond reverse diode leakage");
    expect(analyzeAnalogCircuit(document).status).toBe("invalid");
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples).toHaveLength(2);
    for (const sample of transient.samples) {
      const residual = sample.parts.capacitor!.currentAmps + sample.parts.diode!.currentAmps + 3e-12;
      expect(Math.abs(residual / 3e-12)).toBeLessThan(1e-12);
    }
  });

  it("checks imposed initial inductor current only at the initial transient solve", () => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["inductor", "inductor", ["0", "junction"], { initialCurrentAmps: -3e-12, inductanceHenries: 1 }],
      ["diode", "diode", ["junction", "0"]],
    ], "Inductor initial current beyond reverse diode leakage");
    expect(analyzeAnalogCircuit(document).status).toBe("valid");
    expect(simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 }).status).toBe("invalid");
  });

  it.each(["dc", "ac"] as const)("rejects an impossible tiny island beside a BJT pair promptly in %s", (mode) => {
    const document = createCircuitFromSpecs([
      ["ground", "ground", ["0"]],
      ["supply", "battery", ["supply", "0"], { voltageVolts: 5 }],
      ["input", "ac-source", ["b1", "0"], { offsetVolts: 0.01, voltageVolts: 0.001, frequencyHz: 1000 }],
      ["reference", "ac-source", ["b2", "0"], { offsetVolts: 0, voltageVolts: 0 }],
      ["tail", "current-source", ["emitter", "0"], { currentAmps: 0.001 }],
      ["r1", "resistor", ["supply", "c1"], { resistanceOhms: 1000 }],
      ["r2", "resistor", ["supply", "c2"], { resistanceOhms: 1000 }],
      ["q1", "npn-transistor", ["c1", "b1", "emitter"]],
      ["q2", "npn-transistor", ["c2", "b2", "emitter"]],
      ["tinySource", "current-source", ["0", "tiny"], { currentAmps: -2 * Number.MIN_VALUE }],
      ["tinyDiode", "diode", ["tiny", "0"], { saturationCurrentAmps: Number.MIN_VALUE }],
    ], "BJT pair beside an impossible junction current");
    const started = performance.now();
    const result = analyzeAnalogCircuit(document, { mode });
    expect(result.status).toBe("invalid");
    // The regression spent over 30 s retrying hundreds of source scales per
    // reference. Allow ample runtime variance for an exact feasibility check.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
