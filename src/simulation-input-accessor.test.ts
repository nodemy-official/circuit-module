import { describe, expect, it } from "vitest";
import { analyzeExtendedCircuit } from "./circuit-analog-adapter.js";
import { analyzeAnalogCircuit, solveAnalogStep } from "./analog-solver.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { circuitPartCatalog, type CircuitDocument } from "./circuit-model.js";
import { simulateTransient } from "./transient-solver.js";

const source: CircuitDocument = {
  title: "probe",
  parts: [{ id: "s", kind: "ac-source", label: "s", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults }],
  wires: [],
};

function revokedProxy() {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function missingFrequencyProxy<T extends object>(target: T) {
  return new Proxy(target, {
    get(value, key, receiver) {
      if (key === "frequencyHz") { throw new Error("bad missing-key get trap"); }
      return Reflect.get(value, key, receiver);
    },
  });
}

describe("simulation input accessor validation", () => {
  it.each(["map", "entries", Symbol.iterator] as const)(
    "rejects a parts array with an own %s override without invoking it",
    (key) => {
      const parts = [...source.parts];
      let calls = 0;
      Object.defineProperty(parts, key, {
        configurable: true,
        value() {
          calls += 1;
          throw new Error("array method override ran");
        },
      });

      expect(analyzeCircuit({ ...source, parts }).status).toBe("invalid");
      expect(calls).toBe(0);
    },
  );

  it("rejects an own array method accessor without invoking it", () => {
    const parts = [...source.parts];
    let reads = 0;
    Object.defineProperty(parts, "map", {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("array method accessor ran");
      },
    });

    expect(analyzeCircuit({ ...source, parts }).status).toBe("invalid");
    expect(reads).toBe(0);
  });

  it("rejects arrays with a custom prototype before invoking its methods", () => {
    let calls = 0;
    const prototype = Object.create(Array.prototype, {
      map: {
        value() {
          calls += 1;
          throw new Error("prototype method override ran");
        },
      },
    });
    const parts = Object.setPrototypeOf([...source.parts], prototype);

    expect(analyzeCircuit({ ...source, parts }).status).toBe("invalid");
    expect(calls).toBe(0);
  });

  it("rejects array proxies that override methods, length, or indexed reads across analysis APIs", () => {
    const calls: [string, (parts: CircuitDocument["parts"]) => { status: string }][] = [
      ["analyzeCircuit", (parts) => analyzeCircuit({ ...source, parts })],
      ["analyzeExtendedCircuit", (parts) => analyzeExtendedCircuit({ ...source, parts }, {}, { mode: "ac" })],
      ["analyzeAnalogCircuit", (parts) => analyzeAnalogCircuit({ ...source, parts }, { mode: "ac" })],
      ["solveAnalogStep", (parts) => solveAnalogStep({ ...source, parts }, { mode: "ac" })],
      ["simulateTransient", (parts) => simulateTransient({ ...source, parts }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
    ];
    const overriddenArrays = [
      new Proxy([...source.parts], {
        get(target, key, receiver) {
          if (key === "map") { throw new Error("proxy map trap"); }
          return Reflect.get(target, key, receiver);
        },
      }),
      new Proxy([...source.parts], {
        get(target, key, receiver) {
          if (key === "length") { return 0; }
          return Reflect.get(target, key, receiver);
        },
      }),
      new Proxy([...source.parts], {
        get(target, key, receiver) {
          if (key === "0") { return { ...source.parts[0], id: "substituted" }; }
          return Reflect.get(target, key, receiver);
        },
      }),
    ];

    for (const [name, call] of calls) {
      for (const parts of overriddenArrays) {
        let result: { status: string } | undefined;
        expect(() => { result = call(parts); }, name).not.toThrow();
        expect(result?.status, name).toBe("invalid");
      }
    }
  });

  it("does not throw when an array proxy changes its method behavior after validation across public APIs", () => {
    const calls: [string, (parts: CircuitDocument["parts"]) => { status: string }][] = [
      ["analyzeCircuit", (parts) => analyzeCircuit({ ...source, parts })],
      ["analyzeExtendedCircuit", (parts) => analyzeExtendedCircuit({ ...source, parts }, {}, { mode: "ac" })],
      ["analyzeAnalogCircuit", (parts) => analyzeAnalogCircuit({ ...source, parts }, { mode: "ac" })],
      ["solveAnalogStep", (parts) => solveAnalogStep({ ...source, parts }, { mode: "ac" })],
      ["simulateTransient", (parts) => simulateTransient({ ...source, parts }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
    ];

    for (const [name, call] of calls) {
      let mapReads = 0;
      const parts = new Proxy([...source.parts], {
        get(target, key, receiver) {
          if (key === "map") {
            mapReads += 1;
            if (mapReads > 1) { throw new Error("late proxy map trap"); }
            return Array.prototype.map;
          }
          return Reflect.get(target, key, receiver);
        },
      });

      let result: { status: string } | undefined;
      expect(() => { result = call(parts); }, name).not.toThrow();
      expect(result?.status, name).toBe("invalid");
    }
  });

  it("rejects indexed accessors without invoking them across public analysis APIs", () => {
    const partCalls: [string, (parts: CircuitDocument["parts"]) => { status: string }][] = [
      ["analyzeCircuit", (parts) => analyzeCircuit({ ...source, parts })],
      ["analyzeExtendedCircuit", (parts) => analyzeExtendedCircuit({ ...source, parts }, {}, { mode: "ac" })],
      ["analyzeAnalogCircuit", (parts) => analyzeAnalogCircuit({ ...source, parts }, { mode: "ac" })],
      ["solveAnalogStep", (parts) => solveAnalogStep({ ...source, parts }, { mode: "ac" })],
      ["simulateTransient", (parts) => simulateTransient({ ...source, parts }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
    ];
    for (const [name, call] of partCalls) {
      let reads = 0;
      const parts: unknown[] = [];
      Object.defineProperty(parts, "0", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return source.parts[0];
        },
      });
      parts.length = 1;

      expect(call(parts as CircuitDocument["parts"]).status, name).toBe("invalid");
      expect(reads, name).toBe(0);
    }

    const wireCalls: [string, (wires: CircuitDocument["wires"]) => { status: string }][] = [
      ["analyzeCircuit", (wires) => analyzeCircuit({ ...source, wires })],
      ["analyzeExtendedCircuit", (wires) => analyzeExtendedCircuit({ ...source, wires }, {}, { mode: "ac" })],
      ["analyzeAnalogCircuit", (wires) => analyzeAnalogCircuit({ ...source, wires }, { mode: "ac" })],
      ["solveAnalogStep", (wires) => solveAnalogStep({ ...source, wires }, { mode: "ac" })],
      ["simulateTransient", (wires) => simulateTransient({ ...source, wires }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
    ];
    for (const [name, call] of wireCalls) {
      let reads = 0;
      const wires: unknown[] = [];
      Object.defineProperty(wires, "0", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
        },
      });
      wires.length = 1;

      expect(call(wires as CircuitDocument["wires"]).status, name).toBe("invalid");
      expect(reads, name).toBe(0);
    }
  });

  it("returns invalid rather than invoking accessor properties", () => {
    const throwingMode = Object.defineProperty({}, "mode", { get() { throw new Error("bad mode"); } });
    const throwingFrequency = Object.defineProperty({ mode: "ac" }, "frequencyHz", { get() { throw new Error("bad frequency"); } });
    const throwingPart = { id: "s", kind: "ac-source", label: "s", x: 0, y: 0 };
    Object.defineProperty(throwingPart, "voltageVolts", { get() { throw new Error("bad source"); } });
    const getTrapOptions = new Proxy({ mode: "ac" }, {
      get(target, key, receiver) {
        if (key === "mode") { throw new Error("bad get trap"); }
        return Reflect.get(target, key, receiver);
      },
    });
    const throwingParts: unknown[] = [];
    Object.defineProperty(throwingParts, "0", { get() { throw new Error("bad part index"); } });
    const throwingWires: unknown[] = [];
    Object.defineProperty(throwingWires, "0", { get() { throw new Error("bad wire index"); } });
    const cases: [string, () => { status: string }][] = [
      ["analog options mode getter", () => analyzeAnalogCircuit(source, throwingMode as never)],
      ["analog options frequency getter", () => analyzeAnalogCircuit(source, throwingFrequency as never)],
      ["circuit options mode getter", () => analyzeCircuit(source, {}, throwingMode as never)],
      ["extended options mode getter", () => analyzeExtendedCircuit(source, {}, throwingMode as never)],
      ["circuit options frequency getter", () => analyzeCircuit(source, {}, throwingFrequency as never)],
      ["extended options frequency getter", () => analyzeExtendedCircuit(source, {}, throwingFrequency as never)],
      ["analog options Proxy trap", () => analyzeAnalogCircuit(source, new Proxy({}, { getPrototypeOf() { throw new Error("bad proxy"); } }) as never)],
      ["analog options get trap", () => analyzeAnalogCircuit(source, getTrapOptions as never)],
      ["analog part voltage getter", () => analyzeAnalogCircuit({ ...source, parts: [throwingPart as never] }, { mode: "ac" })],
      ["circuit part voltage getter", () => analyzeCircuit({ ...source, parts: [throwingPart as never] })],
      ["extended part voltage getter", () => analyzeExtendedCircuit({ ...source, parts: [throwingPart as never] }, {}, { mode: "ac" })],
      ["transient part voltage getter", () => simulateTransient({ ...source, parts: [throwingPart as never] }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
      ["analog parts array index getter", () => analyzeAnalogCircuit({ ...source, parts: throwingParts as CircuitDocument["parts"] }, { mode: "ac" })],
      ["circuit parts array index getter", () => analyzeCircuit({ ...source, parts: throwingParts as CircuitDocument["parts"] })],
      ["extended parts array index getter", () => analyzeExtendedCircuit({ ...source, parts: throwingParts as CircuitDocument["parts"] }, {}, { mode: "ac" })],
      ["transient parts array index getter", () => simulateTransient({ ...source, parts: throwingParts as CircuitDocument["parts"] }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
      ["analog wires array index getter", () => analyzeAnalogCircuit({ ...source, wires: throwingWires as CircuitDocument["wires"] }, { mode: "ac" })],
      ["circuit wires array index getter", () => analyzeCircuit({ ...source, wires: throwingWires as CircuitDocument["wires"] })],
      ["extended wires array index getter", () => analyzeExtendedCircuit({ ...source, wires: throwingWires as CircuitDocument["wires"] }, {}, { mode: "ac" })],
      ["transient wires array index getter", () => simulateTransient({ ...source, wires: throwingWires as CircuitDocument["wires"] }, { durationSeconds: 1, timeStepSeconds: 0.1 })],
    ];
    for (const [name, call] of cases) {
      let result: { status: string } | undefined;
      expect(() => { result = call(); }, name).not.toThrow();
      expect(result?.status, name).toBe("invalid");
    }
  });

  it("returns invalid rather than throwing for revoked proxies", () => {
    const invalidCalls: [string, () => { status: string }][] = [
      ["analyzeCircuit document", () => analyzeCircuit(revokedProxy() as never)],
      ["analyzeCircuit switch states", () => analyzeCircuit(source, revokedProxy() as never)],
      ["analyzeCircuit options", () => analyzeCircuit(source, {}, revokedProxy() as never)],
      ["analyzeExtendedCircuit document", () => analyzeExtendedCircuit(revokedProxy() as never, {}, { mode: "ac" })],
      ["analyzeExtendedCircuit switch states", () => analyzeExtendedCircuit(source, revokedProxy() as never, { mode: "ac" })],
      ["analyzeExtendedCircuit options", () => analyzeExtendedCircuit(source, {}, revokedProxy() as never)],
      ["analyzeAnalogCircuit document", () => analyzeAnalogCircuit(revokedProxy() as never, { mode: "ac" })],
      ["analyzeAnalogCircuit options", () => analyzeAnalogCircuit(source, revokedProxy() as never)],
      ["analyzeAnalogCircuit switch states", () => analyzeAnalogCircuit(source, { mode: "ac", switchStates: revokedProxy() as never })],
      ["solveAnalogStep document", () => solveAnalogStep(revokedProxy() as never, { mode: "ac" })],
      ["solveAnalogStep options", () => solveAnalogStep(source, revokedProxy() as never)],
      ["solveAnalogStep switch states", () => solveAnalogStep(source, { mode: "ac", switchStates: revokedProxy() as never })],
      ["simulateTransient document", () => simulateTransient(revokedProxy() as never, { durationSeconds: 1, timeStepSeconds: 0.1 })],
      ["simulateTransient options", () => simulateTransient(source, revokedProxy() as never)],
      ["simulateTransient switch states", () => simulateTransient(source, {
        durationSeconds: 1,
        timeStepSeconds: 0.1,
        switchStates: revokedProxy() as never,
      })],
    ];

    for (const [name, call] of invalidCalls) {
      let result: { status: string } | undefined;
      expect(() => { result = call(); }, name).not.toThrow();
      expect(result?.status, name).toBe("invalid");
    }
  });

  it("does not invoke get traps for absent optional frequency fields", () => {
    const cases: [string, () => { status: string }, () => { status: string }][] = [
      ["analyzeCircuit", () => analyzeCircuit(source, {}, { mode: "ac" }),
        () => analyzeCircuit(source, {}, missingFrequencyProxy({ mode: "ac" }) as never)],
      ["analyzeExtendedCircuit", () => analyzeExtendedCircuit(source, {}, { mode: "ac" }),
        () => analyzeExtendedCircuit(source, {}, missingFrequencyProxy({ mode: "ac" }) as never)],
      ["analyzeAnalogCircuit", () => analyzeAnalogCircuit(source, { mode: "ac" }),
        () => analyzeAnalogCircuit(source, missingFrequencyProxy({ mode: "ac" }) as never)],
      ["solveAnalogStep", () => solveAnalogStep(source, { mode: "ac" }),
        () => solveAnalogStep(source, missingFrequencyProxy({ mode: "ac" }) as never)],
      ["simulateTransient", () => simulateTransient(source, { durationSeconds: 1, timeStepSeconds: 0.1 }),
        () => simulateTransient(source, missingFrequencyProxy({ durationSeconds: 1, timeStepSeconds: 0.1 }) as never)],
    ];

    for (const [name, baseline, trapped] of cases) {
      const expected = baseline();
      let result: { status: string } | undefined;
      expect(() => { result = trapped(); }, name).not.toThrow();
      expect(result?.status, name).toBe(expected.status);
    }
  });
});
