import { expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient, type TransientAnalysisOptions } from "../../transient-solver.js";

const document: CircuitDocument = {
  title: "Switch override snapshots",
  parts: [
    { id: "source", kind: "battery", label: "Source", x: 0, y: 0, voltageVolts: 1 },
    { id: "switch", kind: "switch", label: "Switch", x: 0, y: 0, initiallyClosed: false },
    { id: "load", kind: "resistor", label: "Load", x: 0, y: 0, resistanceOhms: 1 },
  ],
  wires: [
    { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "switch", terminal: "a" } },
    { id: "b", from: { partId: "switch", terminal: "b" }, to: { partId: "load", terminal: "a" } },
    { id: "c", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
  ],
};

it.each(["startFromOperatingPoint", "switchStates"])("does not read an absent transient option %s through a Proxy", (field) => {
  const options = { durationSeconds: 1, timeStepSeconds: 0.5 };
  let reads = 0;
  const trapped = new Proxy(options, {
    get(target, key, receiver) {
      if (key === field) {
        reads += 1;
        throw new Error("Absent optional field was read");
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const expected = simulateTransient(document, options);
  expect(expected.status, expected.message).toBe("valid");
  expect(simulateTransient(document, trapped)).toEqual(expected);
  expect(reads).toBe(0);
});

it("uses descriptor snapshots after checking the required transient option reads", () => {
  const options = { durationSeconds: 1, timeStepSeconds: 0.5 };
  const reads = new Map<PropertyKey, number>();
  const trapped = new Proxy(options, {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (count > 1) { throw new Error("Validated option was read again"); }
      }
      return Reflect.get(target, key, receiver);
    },
  });
  expect(simulateTransient(document, trapped)).toEqual(simulateTransient(document, options));
  expect(reads.get("durationSeconds")).toBe(1);
  expect(reads.get("timeStepSeconds")).toBe(1);
});

it("uses the validated switch override snapshot for every sample", () => {
  let reads = 0;
  const switchStates = new Proxy({ switch: true }, {
    get(target, key, receiver) {
      if (key === "switch") {
        reads += 1;
        if (reads > 1) { throw new Error("Validated switch state was read again"); }
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const options = { durationSeconds: 1, timeStepSeconds: 0.5 };
  const result = simulateTransient(document, { ...options, switchStates });
  expect(result).toEqual(simulateTransient(document, { ...options, switchStates: { switch: true } }));
  expect(reads).toBe(1);
  for (const sample of result.samples) {
    expect(sample.parts.switch!.switchClosed).toBe(true);
    expect(sample.parts.load!.currentAmps).toBe(1);
  }
});

it.each([false, "invalid-state", "throw"])("keeps the validated switch state when later descriptors return %s", (laterValue) => {
  let reads = 0;
  const switchStates = new Proxy({ switch: true }, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "switch" || !descriptor) { return descriptor; }
      reads += 1;
      if (reads <= 2) { return descriptor; }
      if (laterValue === "throw") { throw new Error("Validated switch descriptor was read again"); }
      return { ...descriptor, value: laterValue };
    },
  });
  const options = { durationSeconds: 1, timeStepSeconds: 0.5 };
  const result = simulateTransient(document, { ...options, switchStates });
  expect(result.status, result.message).toBe("valid");
  expect(result).toEqual(simulateTransient(document, { ...options, switchStates: { switch: true } }));
  expect(reads).toBeLessThanOrEqual(2);
  for (const sample of result.samples) {
    expect(sample.parts.switch!.switchClosed).toBe(true);
    expect(sample.parts.load!.currentAmps).toBe(1);
  }
});

it.each(["durationSeconds", "timeStepSeconds", "startFromOperatingPoint", "switchStates"])(
  "keeps the validated top-level %s descriptor snapshot",
  (field) => {
    let reads = 0;
    const options = { durationSeconds: 1, timeStepSeconds: 0.5, startFromOperatingPoint: true, switchStates: { switch: true } };
    const trapped = new Proxy(options, {
      getOwnPropertyDescriptor(target, key) {
        if (key === field && ++reads > 2) { throw new Error("Validated transient option was read again"); }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = simulateTransient(document, trapped);
    expect(result.status, result.message).toBe("valid");
    expect(result).toEqual(simulateTransient(document, options));
    expect(reads).toBeLessThanOrEqual(2);
  },
);

it("preserves null-prototype transient options and switch states", () => {
  const plain: TransientAnalysisOptions = { durationSeconds: 1, timeStepSeconds: 0.5, switchStates: { switch: true } };
  const options = Object.assign(Object.create(null), plain, {
    switchStates: Object.assign(Object.create(null), plain.switchStates),
  });
  const result = simulateTransient(document, options);
  expect(result.status, result.message).toBe("valid");
  expect(result).toEqual(simulateTransient(document, plain));
});

it("retains non-enumerable required, optional and switch-state data fields", () => {
  const plain: TransientAnalysisOptions = { durationSeconds: 1, timeStepSeconds: 0.5, startFromOperatingPoint: true, switchStates: { switch: true } };
  const values = { ...plain, switchStates: Object.defineProperty({}, "switch", { value: true }) };
  const hidden = Object.defineProperties({}, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]))) as TransientAnalysisOptions;
  expect(simulateTransient(document, hidden)).toEqual(simulateTransient(document, plain));
});

it.each(["startFromOperatingPoint", "switchStates"])("rejects a transient %s accessor without invoking it", (field) => {
  let reads = 0;
  const options = Object.defineProperty({ durationSeconds: 1, timeStepSeconds: 0.5 }, field, {
    get() { reads += 1; throw new Error("Optional accessor was called"); },
  });
  expect(simulateTransient(document, options).status).toBe("invalid");
  expect(reads).toBe(0);
});
