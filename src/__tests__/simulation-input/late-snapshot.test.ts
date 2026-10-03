import { describe, expect, it } from "vitest";
import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import { analyzeAnalogCircuit, solveAnalogStep } from "../../analog-solver.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";

function document(): CircuitDocument {
  return { title: "Independent 12 V / 6 ohm snapshot", parts: [
    { id: "s", kind: "battery", label: "S", x: 0, y: 0, voltageVolts: 12, internalResistanceOhms: 0 },
    { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 6 },
  ], wires: [
    { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
    { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "r", terminal: "b" } },
  ] };
}

const analyzers = [
  { name: "analyzeCircuit", legacy: true, run(input: CircuitDocument) {
    const result = analyzeCircuit(input, {}, { mode: "dc" });
    return { status: result.status, current: result.status === "invalid" ? undefined : result.parts.r.currentAmps };
  } },
  { name: "analyzeAnalogCircuit", legacy: false, run(input: CircuitDocument) {
    const result = analyzeAnalogCircuit(input, { mode: "dc" });
    return { status: result.status, current: result.status === "invalid" ? undefined : result.parts.r.current.real };
  } },
  { name: "solveAnalogStep", legacy: false, run(input: CircuitDocument) {
    const result = solveAnalogStep(input, { mode: "dc" });
    return { status: result.status, current: result.status === "invalid" ? undefined : result.parts.r.current.real };
  } },
  { name: "analyzeExtendedCircuit", legacy: false, run(input: CircuitDocument) {
    const result = analyzeExtendedCircuit(input, {}, { mode: "dc" });
    return { status: result.status, current: result.status === "invalid" ? undefined : result.parts.r.currentAmps };
  } },
  { name: "simulateTransient", legacy: false, run(input: CircuitDocument) {
    const result = simulateTransient(input, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
    return { status: result.status, current: result.samples[0]?.parts.r?.currentAmps };
  } },
];

function expectedCurrent(legacy: boolean, resistance = 6) {
  // Independent Ohm's law, including the legacy solver's two wire resistances
  // and minimum battery internal resistance, each 1e-6 ohm.
  return 12 / (resistance + (legacy ? 3e-6 : 0));
}

function consistentSnapshot(result: { status: string; current: number | undefined }, legacy: boolean) {
  if (result.status === "invalid") { return; }
  const expected = expectedCurrent(legacy);
  if ((result.status !== "closed" && result.status !== "valid") ||
      typeof result.current !== "number" || !Number.isFinite(result.current) ||
      Math.abs(result.current / expected - 1) >= 1e-12) {
    throw new Error(`Expected rejection or the original ${expected} A; received ${result.status}, ${result.current} A.`);
  }
}

function changingDescriptor(input: CircuitDocument, behavior: "number" | "accessor" | "hidden" | "absent") {
  let descriptorReads = 0;
  let ownKeysReads = 0;
  let getterCalls = 0;
  input.parts[1] = new Proxy(input.parts[1]!, {
    ownKeys(target) {
      ownKeysReads += 1;
      return Reflect.ownKeys(target).filter((key) => behavior !== "hidden" || ownKeysReads === 1 || key !== "resistanceOhms");
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "resistanceOhms" || ++descriptorReads === 1) { return descriptor; }
      if (behavior === "number") { return { ...descriptor, value: 12 }; }
      if (behavior === "absent") { return; }
      if (behavior === "accessor") {
        return { configurable: true, enumerable: true, get() { getterCalls += 1; return 6; } };
      }
      return descriptor;
    },
  });
  return () => getterCalls;
}

describe("simulation snapshots with changing caller-owned input", () => {
  it.each(analyzers)("retains verified resistance descriptors through $name", ({ run, legacy }) => {
    for (const behavior of ["number", "accessor", "hidden", "absent"] as const) {
      const input = document();
      const getterCalls = changingDescriptor(input, behavior);
      consistentSnapshot(run(input), legacy);
      expect(getterCalls()).toBe(0);
    }
  });

  it.each(analyzers)("does not invoke a late-installed record getter through $name", ({ run, legacy }) => {
    for (const x of [0, Number.NaN]) {
      const input = document();
      input.parts[1]!.x = x;
      let getterCalls = 0;
      input.parts[1] = new Proxy(input.parts[1]!, {
        get(target, key, receiver) {
          if (key === "x") {
            Object.defineProperty(target, "label", { configurable: true, enumerable: true,
              get() { getterCalls += 1; return "R"; } });
          }
          return Reflect.get(target, key, receiver);
        },
      });
      consistentSnapshot(run(input), legacy);
      expect(getterCalls).toBe(0);
    }
  });

  it.each(analyzers)("rejects a nonfinite resistance before a get trap can replace it through $name", ({ run }) => {
    const input = document();
    Object.assign(input.parts[1]!, { resistanceOhms: Number.NaN });
    input.parts[1] = new Proxy(input.parts[1]!, {
      get(target, key, receiver) {
        const original = Reflect.get(target, key, receiver);
        if (key === "resistanceOhms") { Object.assign(target, { resistanceOhms: 6 }); }
        return original;
      },
    });
    expect(run(input).status).toBe("invalid");
  });

  it.each(analyzers)("does not invoke a late replacement of Array.map through $name", ({ run, legacy }) => {
    const input = document();
    let mapReads = 0;
    let methodCalls = 0;
    input.parts = new Proxy(input.parts, {
      get(target, key, receiver) {
        if (key === "map" && ++mapReads > 1) {
          return (callback: (part: CircuitDocument["parts"][number]) => unknown) => {
            methodCalls += 1;
            Object.assign(target[1]!, { resistanceOhms: 12 });
            return Array.prototype.map.call(target, callback);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    consistentSnapshot(run(input), legacy);
    expect(methodCalls).toBe(0);
  });

  it.each(analyzers)("takes a new snapshot after legitimate edits between calls to $name", ({ run, legacy }) => {
    const input = document();
    const first = run(input);
    expect(["closed", "valid"]).toContain(first.status);
    expect(Math.abs(first.current! / expectedCurrent(legacy) - 1)).toBeLessThan(1e-12);
    Object.assign(input.parts[1]!, { resistanceOhms: 12 });
    const next = run(input);
    expect(["closed", "valid"]).toContain(next.status);
    expect(Math.abs(next.current! / expectedCurrent(legacy, 12) - 1)).toBeLessThan(1e-12);
  });

  it.each(analyzers)("does not invoke getters installed by descriptor verification through $name", ({ run, legacy }) => {
    for (const key of ["label", "resistanceOhms"] as const) {
      const input = document();
      let descriptorReads = 0;
      let getterCalls = 0;
      input.parts[1] = new Proxy(input.parts[1]!, {
        getOwnPropertyDescriptor(target, field) {
          const original = Reflect.getOwnPropertyDescriptor(target, field);
          if (field === key && ++descriptorReads === 2) {
            Object.defineProperty(target, field, { configurable: true, enumerable: true,
              get() { getterCalls += 1; return key === "label" ? "R" : 6; } });
          }
          return original;
        },
      });
      consistentSnapshot(run(input), legacy);
      expect(getterCalls).toBe(0);
    }
  });

  it.each(analyzers)("does not invoke getters installed on array indices or methods through $name", ({ run, legacy }) => {
    for (const key of ["0", "map"] as const) {
      const input = document();
      let descriptorReads = 0;
      let getterCalls = 0;
      input.parts = new Proxy(input.parts, {
        getOwnPropertyDescriptor(target, field) {
          const original = Reflect.getOwnPropertyDescriptor(target, field);
          if (field === key && ++descriptorReads === (key === "0" ? 2 : 1)) {
            Object.defineProperty(target, field, { configurable: true, enumerable: true,
              get() { getterCalls += 1; return key === "0" ? original?.value : Array.prototype.map; } });
          }
          return original;
        },
      });
      consistentSnapshot(run(input), legacy);
      expect(getterCalls).toBe(0);
    }
  });

  it.each(analyzers)("does not combine source and load values from different edits through $name", ({ run, legacy }) => {
    const input = document();
    const source = input.parts[0]!;
    input.parts[1] = new Proxy(input.parts[1]!, {
      getPrototypeOf(target) {
        Object.assign(source, { voltageVolts: 24 });
        Object.assign(target, { resistanceOhms: 12 });
        return Reflect.getPrototypeOf(target);
      },
    });
    const result = run(input);
    if (result.status === "invalid") { return; }
    const first = expectedCurrent(legacy);
    const last = 24 / (12 + (legacy ? 3e-6 : 0));
    expect(["closed", "valid"]).toContain(result.status);
    expect(typeof result.current).toBe("number");
    const error = Math.min(Math.abs(result.current! / first - 1), Math.abs(result.current! / last - 1));
    expect(error).toBeLessThan(1e-12);
  });
});
