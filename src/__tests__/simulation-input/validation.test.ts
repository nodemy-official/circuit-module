import { describe, expect, it } from "vitest";

import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import { analyzeAnalogCircuit, solveAnalogStep } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

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
  ["non-string part label", {
    ...validDocument,
    parts: [{ ...validDocument.parts[0], label: { toString() { throw new Error("label conversion ran"); } } }],
  }],
  ["duplicate part id", { ...validDocument, parts: [...validDocument.parts, validDocument.parts[0]] }],
  ["non-array wires", { ...validDocument, wires: null }],
  ["null wire", { ...validDocument, wires: [null] }],
  ["malformed endpoint", { ...validDocument, wires: [{ id: "w", from: null, to: { partId: "source", terminal: "a" } }] }],
  ["unknown endpoint", { ...validDocument, wires: [{ id: "w", from: { partId: "missing", terminal: "a" }, to: { partId: "source", terminal: "a" } }] }],
  ["invalid terminal", { ...validDocument, wires: [{ id: "w", from: { partId: "source", terminal: "c" }, to: { partId: "source", terminal: "b" } }] }],
  ["same-terminal wire", { ...validDocument, wires: [{ id: "w", from: { partId: "source", terminal: "a" }, to: { partId: "source", terminal: "a" } }] }],
  ["duplicate wire id", { ...validDocument, wires: [
    { id: "w", from: { partId: "source", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    { id: "w", from: { partId: "source", terminal: "b" }, to: { partId: "source", terminal: "a" } },
  ] }],
  ["duplicate endpoint pair with distinct IDs", { ...validDocument, wires: [
    { id: "first", from: { partId: "source", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    { id: "second", from: { partId: "source", terminal: "b" }, to: { partId: "source", terminal: "a" } },
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
  it.each(["nmos", "pmos"] as const)("validates explicit null %s channel modulation across DC, AC and transient APIs", (kind) => {
    const sign = kind === "nmos" ? 1 : -1;
    for (const value of [null, Number.NaN, undefined]) {
      const document: CircuitDocument = {
        title: "MOS channel modulation validation",
        parts: [
          { id: "mos", kind, label: "M", x: 0, y: 0, ...circuitPartCatalog[kind].defaults, channelLengthModulation: value } as unknown as CircuitPart,
          { id: "g", kind: "ac-source", label: "G", x: 0, y: 0, voltageVolts: 0, frequencyHz: 1000, offsetVolts: sign * 4 },
          { id: "d", kind: "ac-source", label: "D", x: 0, y: 0, voltageVolts: 1, frequencyHz: 1000, offsetVolts: sign * 5 },
          { id: "ref", kind: "ground", label: "GND", x: 0, y: 0 },
        ],
        wires: [
          { id: "gate", from: { partId: "g", terminal: "a" }, to: { partId: "mos", terminal: "b" } },
          { id: "drain", from: { partId: "d", terminal: "a" }, to: { partId: "mos", terminal: "a" } },
          ...["g", "d"].map((partId) => ({ id: partId, from: { partId, terminal: "b" as const }, to: { partId: "ref", terminal: "a" as const } })),
          { id: "source", from: { partId: "mos", terminal: "c" }, to: { partId: "ref", terminal: "a" } },
        ],
      };
      for (const mode of ["dc", "ac"] as const) {
        const results = [analyzeAnalogCircuit(document, { mode }), solveAnalogStep(document, { mode }),
          analyzeCircuit(document, {}, { mode }), analyzeExtendedCircuit(document, {}, { mode })];
        for (const result of results) {
          if (value === undefined) { expect(["closed", "valid"]).toContain(result.status); }
          else { expect(result.status).toBe("invalid"); }
        }
        if (value === undefined) {
          const result = analyzeAnalogCircuit(document, { mode });
          // Independent square-law DC and output-conductance AC values.
          const expected = mode === "dc" ? sign * 0.042 : 0.0004;
          const actual = mode === "dc" ? result.parts.mos!.current.real : Math.hypot(result.parts.mos!.current.real, result.parts.mos!.current.imaginary);
          expect(actual / expected).toBeCloseTo(1, 12);
        }
      }
      const transient = simulateTransient(document, { durationSeconds: 1e-6, timeStepSeconds: 1e-6 });
      expect(transient.status).toBe(value === undefined ? "valid" : "invalid");
    }
  });

  it("validates initial inductor current before applying the omitted-value default", () => {
    for (const value of [null, Number.NaN, undefined, 1]) {
      const document: CircuitDocument = {
        title: "Initial inductor current validation",
        parts: [
          { id: "l", kind: "inductor", label: "L", x: 0, y: 0, inductanceHenries: 1, initialCurrentAmps: value } as unknown as CircuitPart,
          { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 6 },
        ],
        wires: [
          { id: "a", from: { partId: "l", terminal: "a" }, to: { partId: "r", terminal: "a" } },
          { id: "b", from: { partId: "l", terminal: "b" }, to: { partId: "r", terminal: "b" } },
        ],
      };
      for (const analyze of [solveAnalogStep, analyzeAnalogCircuit]) {
        const result = analyze(document, { mode: "dc", initialInductorCurrents: true });
        expect(result.status).toBe(value === null || Number.isNaN(value) ? "invalid" : "valid");
        if (result.status === "valid") {
          expect(result.parts.l!.current.real).toBe(value ?? 0);
          expect(result.parts.r!.current.real).toBe(value === 1 ? -1 : 0);
          expect(result.parts.r!.voltage.real).toBe(value === 1 ? -6 : 0);
        }
      }
    }
  });

  it.each([
    ["battery", "internalResistanceOhms"],
    ["ac-source", "offsetVolts"],
    ["ac-source", "phaseDegrees"],
  ] as const)("distinguishes explicit null from an omitted %s.%s at every entry point", (kind, field) => {
    for (const value of [null, Number.NaN, undefined]) {
      const document = {
        title: "Malformed numeric field with a valid load",
        parts: [
          { id: "s", kind, label: "S", x: 0, y: 0, ...circuitPartCatalog[kind].defaults, voltageVolts: 4, [field]: value },
          { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 8 },
        ],
        wires: [
          { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
          { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "r", terminal: "b" } },
        ],
      };
      const analyzers = [...publicAnalyzers,
        ["analog DC", (input: unknown) => analyzeAnalogCircuit(input as CircuitDocument, { mode: "dc" })] as const,
        ["circuit DC", (input: unknown) => analyzeCircuit(input as CircuitDocument, {}, { mode: "dc" })] as const,
      ];
      for (const [name, analyze] of analyzers) {
        const status = analyze(document).status;
        if (value === undefined) { expect(status, name).not.toBe("invalid"); }
        else { expect(status, name).toBe("invalid"); }
      }
    }
  });

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

  it("accepts an ideal wire loop when every unordered endpoint pair is distinct", () => {
    const wireLoop: CircuitDocument = {
      title: "理想導線の三角形",
      parts: [
        { id: "j1", kind: "junction", x: 0, y: 0, label: "j1" },
        { id: "j2", kind: "junction", x: 4, y: 0, label: "j2" },
        { id: "j3", kind: "junction", x: 2, y: 3, label: "j3" },
      ],
      wires: [
        { id: "w1", from: { partId: "j1", terminal: "a" }, to: { partId: "j2", terminal: "a" } },
        { id: "w2", from: { partId: "j2", terminal: "a" }, to: { partId: "j3", terminal: "a" } },
        { id: "w3", from: { partId: "j3", terminal: "a" }, to: { partId: "j1", terminal: "a" } },
      ],
    };

    for (const [name, analyze] of publicAnalyzers) {
      const result = analyze(wireLoop);
      expect(result.status, name).not.toBe("invalid");
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
