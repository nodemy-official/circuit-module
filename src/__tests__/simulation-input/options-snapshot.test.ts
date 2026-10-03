import { describe, expect, it } from "vitest";

import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysisOptions } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const dcDocument = createCircuitFromSpecs([
  ["source", "battery", ["positive", "negative"], { voltageVolts: 1, internalResistanceOhms: 1 }],
  ["load", "resistor", ["positive", "negative"], { resistanceOhms: 1 }],
], "Analysis option snapshots");

const groundedDocument: CircuitDocument = {
  ...dcDocument,
  parts: [...dcDocument.parts, { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 }],
  wires: [...dcDocument.wires, {
    id: "ground-wire", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" },
  }],
};

const acDocument = createCircuitFromSpecs([
  ["source", "ac-source", ["positive", "negative"], { voltageVolts: 1, frequencyHz: 1000, offsetVolts: 2 }],
  ["load", "resistor", ["positive", "negative"], { resistanceOhms: 1 }],
], "Analysis frequency snapshots");

function changingOption(options: CircuitAnalysisOptions, field: string, laterValue: unknown, validReads = 2) {
  let reads = 0;
  const proxy = new Proxy(options, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== field || !descriptor) { return descriptor; }
      reads += 1;
      if (reads <= validReads) { return descriptor; }
      if (laterValue === "throw") { throw new Error("Validated option descriptor was read again"); }
      return { ...descriptor, value: laterValue };
    },
  });
  return { proxy, reads: () => reads };
}

const analyzers = [
  { name: "analyzeCircuit", analyze: analyzeCircuit, wireResistance: 2e-6 },
  { name: "analyzeExtendedCircuit", analyze: analyzeExtendedCircuit, wireResistance: 0 },
];

describe.each(analyzers)("$name option snapshots", ({ analyze, wireResistance }) => {
  it.each(["ac", "invalid-mode", "throw"])("uses the validated DC mode when later descriptors return %s", (laterValue) => {
    for (const document of [dcDocument, groundedDocument]) {
      const trapped = changingOption({ mode: "dc" }, "mode", laterValue);
      const result = analyze(document, {}, trapped.proxy);
      expect(result.status, result.message).toBe("closed");
      // Ohm's law, with the legacy solver's two finite-resistance wires.
      const expectedCurrent = 1 / (2 + (document === dcDocument ? wireResistance : 0));
      expect(result.parts.load!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
      expect(result).toEqual(analyze(document, {}, { mode: "dc" }));
      expect(trapped.reads()).toBeLessThanOrEqual(2);
    }
  });

  it.each([2000, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, "throw"])(
    "uses the validated AC frequency when later descriptors return %s",
    (laterValue) => {
      const options: CircuitAnalysisOptions = { mode: "ac", frequencyHz: 1000 };
      const trapped = changingOption(options, "frequencyHz", laterValue);
      const result = analyze(acDocument, {}, trapped.proxy);
      expect(result.status, result.message).toBe("closed");
      expect(result.mode).toBe("ac");
      expect(result.frequencyHz).toBe(1000);
      // A 1 V RMS source across 1 ohm draws 1 A at the matching frequency.
      expect(result.parts.load!.currentAmps).toBe(1);
      expect(result).toEqual(analyze(acDocument, {}, options));
      expect(trapped.reads()).toBeLessThanOrEqual(2);
    },
  );

  it.each([
    { field: "mode", value: "invalid-mode" },
    { field: "frequencyHz", value: 0 },
    { field: "frequencyHz", value: Number.NaN },
    { field: "frequencyHz", value: Number.POSITIVE_INFINITY },
  ])("rejects an invalid $field captured before value validation ($value)", ({ field, value }) => {
    const trapped = changingOption({ mode: "ac", frequencyHz: 1000 }, field, value, 1);
    expect(analyze(acDocument, {}, trapped.proxy).status).toBe("invalid");
  });

  it.each(["plain", "null prototype", "non-enumerable", "non-enumerable null prototype"])(
    "preserves mode and frequency values in %s options",
    (shape) => {
      for (const mode of [undefined, "auto", "dc", "ac"] as const) {
        for (const frequencyHz of [undefined, 1000, 2000]) {
          const values = { mode, frequencyHz };
          const options = Object.create(shape.includes("null prototype") ? null : Object.prototype,
            Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
              value, enumerable: !shape.includes("non-enumerable"),
            }]))) as CircuitAnalysisOptions;
          const result = analyze(acDocument, {}, options);
          expect(result.status, result.message).not.toBe("invalid");
          expect(result).toEqual(analyze(acDocument, {}, values));
          expect(result.mode).toBe(mode === "dc" ? "dc" : "ac");
          expect(result.parts.load!.currentAmps).toBe(mode === "dc" ? 2 : frequencyHz === 2000 ? 0 : 1);
        }
      }
    },
  );

  it.each(["mode", "frequencyHz"])("rejects a %s accessor without invoking it", (field) => {
    let reads = 0;
    const options = Object.defineProperty({ mode: "ac", frequencyHz: 1000 }, field, {
      get() { reads += 1; throw new Error("Option accessor was invoked"); },
    });
    expect(analyze(acDocument, {}, options as CircuitAnalysisOptions).status).toBe("invalid");
    expect(reads).toBe(0);
  });
});
