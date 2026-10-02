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
