import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit, solveAnalogStep, type AnalogStepOptions } from "../../analog-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const document = createCircuitFromSpecs([
  ["source", "battery", ["positive", "negative"], { voltageVolts: 1, internalResistanceOhms: 1 }],
  ["switch", "switch", ["positive", "load"], { initiallyClosed: false }],
  ["load", "resistor", ["load", "negative"], { resistanceOhms: 1 }],
], "Direct analog option snapshots");

describe.each([
  { name: "analyzeAnalogCircuit", analyze: analyzeAnalogCircuit },
  { name: "solveAnalogStep", analyze: solveAnalogStep },
])("$name option snapshots", ({ analyze }) => {
  it.each(["ac", "invalid-mode", "throw"])("retains the validated mode instead of rereading %s", (later) => {
    let reads = 0;
    const options = new Proxy<AnalogStepOptions>({ mode: "dc", switchStates: { switch: true } }, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "mode" || !descriptor || ++reads <= 4) { return descriptor; }
        if (later === "throw") { throw new Error("Mode was reread"); }
        return { ...descriptor, value: later };
      },
    });
    const result = analyze(document, options);
    expect(result.status, result.message).toBe("valid");
    expect(result.mode).toBe("dc");
    expect(result.parts.load!.current.real).toBe(0.5);
    expect(reads).toBeLessThanOrEqual(2);
  });

  it.each([2000, -1, Number.NaN, Number.POSITIVE_INFINITY])("retains the validated frequency instead of %s", (later) => {
    const acDocument = createCircuitFromSpecs([
      ["source", "ac-source", ["positive", "negative"], { voltageVolts: 1, frequencyHz: 1000 }],
      ["load", "resistor", ["positive", "negative"], { resistanceOhms: 1 }],
    ], "Direct AC frequency snapshot");
    let reads = 0;
    const options = new Proxy<AnalogStepOptions>({ mode: "ac", frequencyHz: 1000 }, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "frequencyHz" && descriptor && ++reads > 3 ? { ...descriptor, value: later } : descriptor;
      },
    });
    const result = analyze(acDocument, options);
    expect(result.status, result.message).toBe("valid");
    expect(result.frequencyHz).toBe(1000);
    expect(result.parts.load!.current.real).toBe(1);
    expect(reads).toBeLessThanOrEqual(2);
  });

  it.each(["switchStates", "voltageOverrides"] as const)("snapshots %s before validating its values", (field) => {
    let reads = 0;
    const controls = field === "switchStates" ? { switch: true } : { source: 2 };
    const trapped = new Proxy(controls, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (!descriptor) { return descriptor; }
        if (++reads > 2) { throw new Error("Control was reread"); }
        return descriptor;
      },
    });
    const options = { mode: "dc", switchStates: { switch: true }, [field]: trapped } as AnalogStepOptions;
    const result = analyze(document, options);
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.load!.current.real).toBe(field === "voltageOverrides" ? 1 : 0.5);
    expect(reads).toBeLessThanOrEqual(2);
  });
});
