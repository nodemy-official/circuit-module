import { describe, expect, it } from "vitest";

import { analyzeExtendedCircuit } from "./circuit-analog-adapter.js";
import { analyzeAnalogCircuit, solveAnalogStep } from "./analog-solver.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { circuitPartCatalog, type CircuitDocument } from "./circuit-model.js";
import { simulateTransient } from "./transient-solver.js";

const validDocument: CircuitDocument = {
  title: "入力検証",
  parts: [{ id: "source", kind: "ac-source", label: "source", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults }],
  wires: [],
};

const malformedDocuments: [string, unknown][] = [
  ["null document", null],
  ["missing parts", { title: "bad", wires: [] }],
  ["non-array parts", { title: "bad", parts: null, wires: [] }],
  ["null part", { title: "bad", parts: [null], wires: [] }],
  ["duplicate part id", { ...validDocument, parts: [...validDocument.parts, validDocument.parts[0]] }],
  ["non-array wires", { ...validDocument, wires: null }],
  ["null wire", { ...validDocument, wires: [null] }],
  ["malformed endpoint", { ...validDocument, wires: [{ id: "w", from: null, to: { partId: "source", terminal: "a" } }] }],
  ["unknown endpoint", { ...validDocument, wires: [{ id: "w", from: { partId: "missing", terminal: "a" }, to: { partId: "source", terminal: "a" } }] }],
  ["invalid terminal", { ...validDocument, wires: [{ id: "w", from: { partId: "source", terminal: "c" }, to: { partId: "source", terminal: "b" } }] }],
  ["duplicate wire id", { ...validDocument, wires: [
    { id: "w", from: { partId: "source", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    { id: "w", from: { partId: "source", terminal: "b" }, to: { partId: "source", terminal: "a" } },
  ] }],
];

const publicAnalyzers: [string, (document: unknown) => { status: string }][] = [
  ["analyzeCircuit", (document) => analyzeCircuit(document as CircuitDocument)],
  ["analyzeAnalogCircuit", (document) => analyzeAnalogCircuit(document as CircuitDocument, { mode: "ac" })],
  ["solveAnalogStep", (document) => solveAnalogStep(document as CircuitDocument, { mode: "ac" })],
  ["analyzeExtendedCircuit", (document) => analyzeExtendedCircuit(document as CircuitDocument, {}, { mode: "ac" })],
  ["simulateTransient", (document) => simulateTransient(document as CircuitDocument, { durationSeconds: 1, timeStepSeconds: 0.1 })],
];

describe("simulation API runtime input validation", () => {
  it.each(publicAnalyzers)("returns invalid rather than throwing for malformed documents through %s", (_name, analyze) => {
    for (const [description, document] of malformedDocuments) {
      let result: { status: string } | undefined;
      expect(() => { result = analyze(document); }, description).not.toThrow();
      expect(result?.status, description).toBe("invalid");
    }
  });

  it("rejects malformed runtime options at every direct entry point", () => {
    const invalidCalls = [
      () => analyzeCircuit(validDocument, null as never),
      () => analyzeCircuit(validDocument, {}, null as never),
      () => analyzeAnalogCircuit(validDocument, null as never),
      () => solveAnalogStep(validDocument, null as never),
      () => analyzeExtendedCircuit(validDocument, {}, null as never),
      () => analyzeExtendedCircuit(validDocument, null as never, { mode: "ac" }),
      () => simulateTransient(validDocument, null as never),
    ];
    for (const analyze of invalidCalls) {
      expect(() => analyze()).not.toThrow();
      expect(analyze().status).toBe("invalid");
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid requested AC frequency %s without throwing",
    (frequencyHz) => {
      expect(analyzeAnalogCircuit(validDocument, { mode: "ac", frequencyHz }).status).toBe("invalid");
      expect(analyzeCircuit(validDocument, {}, { mode: "ac", frequencyHz }).status).toBe("invalid");
      expect(analyzeExtendedCircuit(validDocument, {}, { mode: "ac", frequencyHz }).status).toBe("invalid");
    },
  );

  it.each([
    ["voltageVolts", -1],
    ["frequencyHz", 0],
    ["frequencyHz", -1],
    ["frequencyHz", Number.NaN],
    ["frequencyHz", Number.POSITIVE_INFINITY],
    ["phaseDegrees", Number.NaN],
    ["phaseDegrees", Number.NEGATIVE_INFINITY],
    ["offsetVolts", Number.NaN],
    ["offsetVolts", Number.POSITIVE_INFINITY],
  ] as const)("rejects invalid AC source field %s=%s", (field, value) => {
    const document = {
      ...validDocument,
      parts: [{ ...validDocument.parts[0], [field]: value }],
    };
    expect(analyzeAnalogCircuit(document, { mode: "ac" }).status).toBe("invalid");
    expect(analyzeCircuit(document, {}, { mode: "ac" }).status).toBe("invalid");
    expect(analyzeExtendedCircuit(document, {}, { mode: "ac" }).status).toBe("invalid");
    expect(simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.1 }).status).toBe("invalid");
  });

  it.each([Number.MIN_VALUE, 1e308])(
    "keeps a valid AC source at representable frequency boundary %s finite",
    (frequencyHz) => {
      const document = {
        ...validDocument,
        parts: [{ ...validDocument.parts[0], frequencyHz, phaseDegrees: 1e308 }],
      };
      const result = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(result.status, result.message).toBe("valid");
      expect(Number.isFinite(result.parts.source.voltage.real)).toBe(true);
      expect(Number.isFinite(result.parts.source.voltage.imaginary)).toBe(true);
    },
  );

  it("preserves catalog label defaults for analog calls from untyped JavaScript", () => {
    const document = {
      ...validDocument,
      parts: [{ id: "source", kind: "ac-source", x: 0, y: 0, voltageVolts: 5, frequencyHz: 1000 }],
    } as unknown as CircuitDocument;
    expect(analyzeAnalogCircuit(document, { mode: "ac" }).status).toBe("valid");
  });
});
