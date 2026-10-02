import { expect, it } from "vitest";
import { analyzeAnalogCircuit, solveAnalogStep } from "../../analog-solver.js";
import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";

function document(): CircuitDocument {
  return {
    title: "Own data fields",
    parts: [
      { id: "source", kind: "battery", label: "S", x: 0, y: 0, voltageVolts: 12, internalResistanceOhms: 0 },
      { id: "sw", kind: "switch", label: "SW", x: 0, y: 0, initiallyClosed: true },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 10 },
    ],
    wires: [
      { id: "s", from: { partId: "source", terminal: "a" }, to: { partId: "sw", terminal: "a" } },
      { id: "r", from: { partId: "sw", terminal: "b" }, to: { partId: "r", terminal: "a" } },
      { id: "return", from: { partId: "r", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

const analyzers = [
  { name: "legacy", run: (input: CircuitDocument, states: Record<string, boolean> = {}) => analyzeCircuit(input, states, { mode: "dc" }) },
  { name: "analog", run: (input: CircuitDocument, states: Record<string, boolean> = {}) => analyzeAnalogCircuit(input, { mode: "dc", switchStates: states }) },
  { name: "step", run: (input: CircuitDocument, states: Record<string, boolean> = {}) => solveAnalogStep(input, { mode: "dc", switchStates: states }) },
  { name: "adapter", run: (input: CircuitDocument, states: Record<string, boolean> = {}) => analyzeExtendedCircuit(input, states, { mode: "dc" }) },
  { name: "transient", run: (input: CircuitDocument, states: Record<string, boolean> = {}) => simulateTransient(input, { durationSeconds: 0.1, timeStepSeconds: 0.1, switchStates: states }) },
];

function hideOwnFields<T extends object>(input: T): T {
  for (const key of Object.getOwnPropertyNames(input)) {
    Object.defineProperty(input, key, { enumerable: false });
  }
  return input;
}

function hideOwnKey<T extends object>(input: T, hidden: string | symbol): T {
  return new Proxy(input, { ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== hidden) });
}

it.each(analyzers)("rejects hidden array method overrides through $name without invoking accessors", ({ run }) => {
  for (const key of ["map", "entries", Symbol.iterator] as const) {
    for (const accessor of [false, true]) {
      const input = document();
      let reads = 0;
      const value = Array.prototype[key];
      Object.defineProperty(input.parts, key, { configurable: true,
        ...(accessor ? { get() { reads += 1; return value; } } : { value }) });
      input.parts = hideOwnKey(input.parts, key);
      expect(run(input).status).toBe("invalid");
      expect(reads).toBe(0);
    }
  }
});

it.each(analyzers)("rejects an inconsistent ownKeys Proxy through $name before reading hidden accessors", ({ run }) => {
  for (const accessor of [false, true]) {
    const input = document();
    let reads = 0;
    if (accessor) {
      Object.defineProperty(input.parts[0]!, "voltageVolts", { configurable: true,
        get() { reads += 1; return 12; } });
    }
    input.parts[0] = hideOwnKey(input.parts[0]!, "voltageVolts");
    expect(run(input).status).toBe("invalid");
    expect(reads).toBe(0);
  }
  expect(run(hideOwnKey(document(), "parts")).status).toBe("invalid");
  const input = document();
  input.wires[0]!.from = hideOwnKey(input.wires[0]!.from, "partId");
  expect(run(input).status).toBe("invalid");
});

it.each(analyzers)("rejects switch overrides hidden by an ownKeys Proxy through $name", ({ run }) => {
  for (const [id, value] of [["sw", "false"], ["sw", true], ["source", true]] as const) {
    const states = hideOwnKey(Object.defineProperty({}, id, { configurable: true, value }), id);
    expect(run(document(), states).status).toBe("invalid");
  }
});

it.each(analyzers)("preserves non-enumerable document, part, wire and endpoint fields through $name", ({ run }) => {
  const visible = document();
  const hidden = document();
  for (const part of hidden.parts) { hideOwnFields(part); }
  for (const wire of hidden.wires) {
    hideOwnFields(wire.from);
    hideOwnFields(wire.to);
    hideOwnFields(wire);
  }
  hideOwnFields(hidden);
  const expected = run(visible);
  expect(["closed", "valid"]).toContain(expected.status);
  expect(run(hidden)).toEqual(expected);
  expect(Object.keys(hidden)).toEqual([]);
  expect(Object.keys(hidden.parts[0]!)).toEqual([]);
});

it.each(analyzers)("validates non-enumerable numeric fields through $name", ({ run }) => {
  for (const value of [-1, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const input = document();
    Object.defineProperty(input.parts[0]!, "voltageVolts", { enumerable: false, value });
    expect(run(input).status).toBe("invalid");
  }
});

it.each(analyzers)("validates every own switch override through $name", ({ run }) => {
  for (const [id, value] of [["sw", "false"], ["sw", undefined], ["source", true], ["missing", false]] as const) {
    const states = Object.defineProperty({}, id, { value });
    expect(run(document(), states).status).toBe("invalid");
  }
  for (const value of [false, true]) {
    expect(run(document(), Object.defineProperty({}, "sw", { value })))
      .toEqual(run(document(), { sw: value }));
  }
});

it.each([analyzeAnalogCircuit, solveAnalogStep])("validates hidden voltage overrides and preserves a valid signed override", (run) => {
  for (const [id, value] of [["source", Number.NaN], ["source", undefined], ["r", 2], ["missing", 2]] as const) {
    const voltageOverrides = Object.defineProperty({}, id, { value });
    expect(run(document(), { mode: "dc", voltageOverrides }).status).toBe("invalid");
  }
  const hiddenOverride = hideOwnKey({ source: Number.NaN }, "source");
  expect(run(document(), { mode: "dc", voltageOverrides: hiddenOverride }).status).toBe("invalid");
  const voltageOverrides = Object.defineProperty({}, "source", { value: -12 });
  expect(run(document(), { mode: "dc", voltageOverrides }))
    .toEqual(run(document(), { mode: "dc", voltageOverrides: { source: -12 } }));
});

it("preserves hidden AC waveform fields in transient snapshots", () => {
  const visible = document();
  visible.parts[0] = { id: "source", kind: "ac-source", label: "S", x: 0, y: 0,
    voltageVolts: 2, frequencyHz: 1, phaseDegrees: 90, offsetVolts: 3 };
  const hidden = structuredClone(visible);
  hideOwnFields(hidden.parts[0]!);
  const options = { durationSeconds: 0.25, timeStepSeconds: 0.25 };
  const expected = simulateTransient(visible, options);
  expect(expected.status, expected.message).toBe("valid");
  expect(simulateTransient(hidden, options)).toEqual(expected);
});
