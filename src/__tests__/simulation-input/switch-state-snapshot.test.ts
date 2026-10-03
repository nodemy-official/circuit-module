import { expect, it } from "vitest";

import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const dcDocument = createCircuitFromSpecs([
  ["source", "battery", ["positive", "negative"], { voltageVolts: 1, internalResistanceOhms: 0 }],
  ["switch", "switch", ["positive", "load"], { initiallyClosed: false }],
  ["load", "resistor", ["load", "negative"], { resistanceOhms: 1 }],
], "Switch state snapshot");

const groundedDocument: CircuitDocument = {
  ...dcDocument,
  parts: [...dcDocument.parts, { id: "ground", kind: "ground", x: 0, y: 0, label: "GND" }],
  wires: [...dcDocument.wires, {
    id: "ground-wire", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" },
  }],
};

const acDocument: CircuitDocument = {
  ...dcDocument,
  parts: dcDocument.parts.map((part) => part.kind === "battery"
    ? { ...part, kind: "ac-source", frequencyHz: 1000 }
    : part),
};

const analyzers: { name: string; run: (states: Record<string, boolean>) => CircuitAnalysis }[] = [
  { name: "legacy DC", run: (states) => analyzeCircuit(dcDocument, states) },
  { name: "extended DC", run: (states) => analyzeCircuit(groundedDocument, states) },
  { name: "extended AC", run: (states) => analyzeCircuit(acDocument, states) },
  { name: "direct DC adapter", run: (states) => analyzeExtendedCircuit(dcDocument, states, { mode: "dc" }) },
  { name: "direct AC adapter", run: (states) => analyzeExtendedCircuit(acDocument, states, { mode: "ac" }) },
];

it.each(analyzers)("snapshots the validated switch override before solving through $name", ({ run }) => {
  for (const laterValue of ["throw", "change"] as const) {
    let reads = 0;
    const states = new Proxy({ switch: true }, {
      get(target, key, receiver) {
        if (key === "switch") {
          reads += 1;
          if (reads > 1) {
            if (laterValue === "throw") { throw new Error("Validated switch state was read again"); }
            return false;
          }
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = run(states);
    expect(result.status, result.message).toBe("closed");
    expect(result.parts.switch!.switchClosed).toBe(true);
    expect(result.parts.load!.currentAmps).toBeGreaterThan(0.99);
    expect(result.parts.switch!.currentAmps).toBe(result.parts.load!.currentAmps);
    expect(result).toEqual(run({ switch: true }));
    expect(reads).toBe(0);
  }
});

it.each([
  { analyzer: analyzers[0]!, validReads: 4 },
  { analyzer: analyzers[3]!, validReads: 5 },
])("keeps the solved circuit and readings consistent when a late get changes ($analyzer.name)", ({ analyzer, validReads }) => {
  let reads = 0;
  const states = new Proxy({ switch: true }, {
    get(target, key, receiver) {
      return key === "switch" ? ++reads <= validReads : Reflect.get(target, key, receiver);
    },
  });
  expect(analyzer.run(states)).toEqual(analyzer.run({ switch: true }));
  expect(reads).toBe(0);
});
