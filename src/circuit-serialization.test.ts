import { describe, expect, it } from "vitest";

import { inspectCircuit } from "./circuit-diagnostics.js";
import { analyzeCircuit } from "./circuit-solver.js";
import {
  MAX_CIRCUIT_DOCUMENT_JSON_LENGTH,
  MAX_CIRCUIT_DOCUMENT_PARTS,
  MAX_CIRCUIT_DOCUMENT_WIRES,
  MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS,
  MAX_CIRCUIT_DOCUMENT_COORDINATE,
  parseCircuitDocument,
  serializeCircuitDocument,
} from "./circuit-serialization.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "./circuit-model.js";

function part(id: string, kind: CircuitPartKind = "resistor", extra: object = {}) {
  return { id, kind, x: 0, y: 0, label: id, ...extra };
}

const simpleDocument: CircuitDocument = {
  title: "保存テスト",
  parts: [
    { ...part("battery", "battery", { voltageVolts: 9, internalResistanceOhms: 0 }), rotation: 90 },
    { ...part("resistor", "resistor", { resistanceOhms: 10 }) },
    { ...part("junction", "junction"), x: 5, y: -2 },
  ],
  wires: [
    { id: "wire-1", from: { partId: "battery", terminal: "a" }, to: { partId: "resistor", terminal: "b" } },
    { id: "wire-2", from: { partId: "junction", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
  ],
};

function parseRaw(document: unknown) {
  return parseCircuitDocument(JSON.stringify(document));
}

describe("circuit document serialization", () => {
  it("round trips a versioned document into a fresh normalized object", () => {
    const json = serializeCircuitDocument(simpleDocument);
    const envelope = JSON.parse(json) as Record<string, unknown>;
    expect(envelope).toMatchObject({ format: "circuit-module", version: 1 });
    const result = parseCircuitDocument(json);
    expect(result).toEqual({ ok: true, document: simpleDocument });
    if (result.ok) { expect(result.document).not.toBe(simpleDocument); }
  });

  it("round trips manual wire waypoints and treats an empty list as automatic routing", () => {
    const wire = simpleDocument.wires[0];
    if (!wire) { throw new Error("Missing fixture wire"); }
    const document: CircuitDocument = {
      ...simpleDocument,
      wires: [{ ...wire, waypoints: [{ x: 3, y: 0 }, { x: 3, y: 5 }] }],
    };

    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document });
    const normalized = parseRaw({ ...document, wires: [{ ...document.wires[0], waypoints: [] }] });
    expect(normalized.ok && normalized.document.wires[0]).not.toHaveProperty("waypoints");
  });

  it("round trips every analog part default and accepts a wire on a three-terminal pin", () => {
    const analogKinds = [
      "ac-source", "capacitor", "inductor", "ground", "current-source", "potentiometer",
      "diode", "led", "npn-transistor", "pnp-transistor", "nmos", "pmos", "op-amp",
    ] as const;
    const parts: CircuitPart[] = analogKinds.map((kind, index) => ({
      id: `part-${kind}`,
      kind,
      x: index * 8,
      y: 0,
      ...circuitPartCatalog[kind].defaults,
    }));
    const document: CircuitDocument = {
      title: "アナログ部品",
      parts,
      wires: [
        {
          id: "three-pin-wire",
          from: { partId: "part-potentiometer", terminal: "c" },
          to: { partId: "part-npn-transistor", terminal: "c" },
        },
        {
          id: "op-amp-feedback",
          from: { partId: "part-op-amp", terminal: "c" },
          to: { partId: "part-op-amp", terminal: "b" },
        },
      ],
    };

    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document });
  });

  it("round trips direct terminal shorts and preserves their analysis and diagnostic meaning", () => {
    const batteryShort: CircuitDocument = {
      title: "電池短絡",
      parts: [part("battery", "battery", { voltageVolts: 9, internalResistanceOhms: 0 })],
      wires: [{
        id: "short",
        from: { partId: "battery", terminal: "a" },
        to: { partId: "battery", terminal: "b" },
      }],
    };
    const batteryShortViaJunction: CircuitDocument = {
      title: batteryShort.title,
      parts: [...batteryShort.parts, part("battery-junction", "junction", { x: 5 })],
      wires: [
        { id: "short-a", from: { partId: "battery", terminal: "a" }, to: { partId: "battery-junction", terminal: "a" } },
        { id: "short-b", from: { partId: "battery-junction", terminal: "a" }, to: { partId: "battery", terminal: "b" } },
      ],
    };
    const resistorBypass: CircuitDocument = {
      title: "抵抗バイパス",
      parts: [part("resistor", "resistor", { resistanceOhms: 10 })],
      wires: [{
        id: "bypass",
        from: { partId: "resistor", terminal: "a" },
        to: { partId: "resistor", terminal: "b" },
      }],
    };
    const resistorBypassViaJunction: CircuitDocument = {
      title: resistorBypass.title,
      parts: [...resistorBypass.parts, part("resistor-junction", "junction", { x: 5 })],
      wires: [
        { id: "bypass-a", from: { partId: "resistor", terminal: "a" }, to: { partId: "resistor-junction", terminal: "a" } },
        { id: "bypass-b", from: { partId: "resistor-junction", terminal: "a" }, to: { partId: "resistor", terminal: "b" } },
      ],
    };

    for (const [direct, viaJunction, status, diagnosticCode] of [
      [batteryShort, batteryShortViaJunction, "short", "wire-shorted-battery"],
      [resistorBypass, resistorBypassViaJunction, "idle", "wire-bypassed-part"],
    ] as const) {
      expect(parseCircuitDocument(serializeCircuitDocument(direct))).toEqual({ ok: true, document: direct });
      expect(analyzeCircuit(direct).status).toBe(status);
      expect(analyzeCircuit(viaJunction).status).toBe(status);
      expect(inspectCircuit(direct).map(({ code }) => code)).toContain(diagnosticCode);
      expect(inspectCircuit(viaJunction).map(({ code }) => code)).toContain(diagnosticCode);
    }
  });

  it("accepts legacy raw JSON and drops unknown fields while normalizing", () => {
    const raw = {
      ...simpleDocument,
      futureDocumentProperty: { ignored: true },
      parts: simpleDocument.parts.map((item) => ({ ...item, futurePartProperty: "ignored" })),
      wires: simpleDocument.wires.map((wire) => ({ ...wire, futureWireProperty: "ignored" })),
    };
    const result = parseRaw(raw);
    expect(result).toEqual({ ok: true, document: simpleDocument });
  });

  it("preserves omitted model properties and allows empty, incomplete, and unpowered circuits", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [
        { id: "unpowered", kind: "battery", x: 0, y: 0, label: "電池" },
        { id: "incomplete", kind: "resistor", x: 2, y: 0, label: "抵抗" },
      ],
      wires: [],
    };
    const result = parseCircuitDocument(serializeCircuitDocument(document));
    expect(result).toEqual({ ok: true, document });
    expect(parseCircuitDocument(serializeCircuitDocument({ title: "", parts: [], wires: [] }))).toEqual({
      ok: true,
      document: { title: "", parts: [], wires: [] },
    });
  });

  it("accepts the coordinate limit and separate part and wire ID namespaces", () => {
    const document: CircuitDocument = {
      title: "境界値",
      parts: [
        {
          id: "same-id",
          kind: "resistor",
          x: MAX_CIRCUIT_DOCUMENT_COORDINATE,
          y: -MAX_CIRCUIT_DOCUMENT_COORDINATE,
          label: "",
        },
        { id: "other", kind: "battery", x: 0, y: 0, label: "電池" },
      ],
      wires: [{
        id: "same-id",
        from: { partId: "same-id", terminal: "a" },
        to: { partId: "other", terminal: "b" },
      }],
    };
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document });
  });

  it("rejects coordinates above the public limit while parsing and saving", () => {
    const invalidDocuments: CircuitDocument[] = [
      {
        title: "範囲外",
        parts: [{ id: "far-x", kind: "resistor", x: MAX_CIRCUIT_DOCUMENT_COORDINATE + 1, y: 0, label: "遠方" }],
        wires: [],
      },
      {
        title: "範囲外",
        parts: [{ id: "far-y", kind: "resistor", x: 0, y: -MAX_CIRCUIT_DOCUMENT_COORDINATE - 1, label: "遠方" }],
        wires: [],
      },
    ];
    for (const invalid of invalidDocuments) {
      const parsed = parseRaw(invalid);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) { expect(parsed.reason).toContain("セル以内"); }
      expect(() => serializeCircuitDocument(invalid)).toThrow(/セル以内/);
    }
  });

  it("rejects malformed, non-finite, out-of-range, and excessive wire waypoints", () => {
    const wire = simpleDocument.wires[0];
    if (!wire) { throw new Error("Missing fixture wire"); }
    const invalidWaypoints = [
      "not-an-array",
      [null],
      [{ x: "1", y: 0 }],
      [{ x: Number.MAX_VALUE, y: 0 }],
      Array.from({ length: MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS + 1 }, () => ({ x: 0, y: 0 })),
    ];
    for (const waypoints of invalidWaypoints) {
      const invalid = { ...simpleDocument, wires: [{ ...wire, waypoints }] } as unknown as CircuitDocument;
      expect(parseRaw(invalid).ok).toBe(false);
      expect(() => serializeCircuitDocument(invalid)).toThrow(/経由点/);
    }
    const overflow = `{"title":"","parts":${JSON.stringify(simpleDocument.parts)},"wires":[{"id":"${wire.id}","from":${JSON.stringify(wire.from)},"to":${JSON.stringify(wire.to)},"waypoints":[{"x":1e400,"y":0}]}]}`;
    expect(parseCircuitDocument(overflow).ok).toBe(false);
  });

  it("rejects Number.MAX_VALUE coordinates before they can overflow board pixel calculations", () => {
    const invalid: CircuitDocument = {
      title: "巨大座標",
      parts: [{ id: "far", kind: "resistor", x: Number.MAX_VALUE, y: 0, label: "遠方" }],
      wires: [],
    };
    expect(parseRaw(invalid).ok).toBe(false);
    expect(() => serializeCircuitDocument(invalid)).toThrow(/セル以内/);
  });

  it("rejects malformed JSON, unsupported envelopes, and invalid top-level values in Japanese", () => {
    for (const input of ["{", "null", "[]", "false", "{}", JSON.stringify({ format: "other", version: 1 })]) {
      const result = parseCircuitDocument(input);
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.reason).toMatch(/[ぁ-んァ-ヶ一-龠]/); }
    }
    expect(parseCircuitDocument(JSON.stringify({ format: "circuit-module", version: 2, document: simpleDocument }))).toEqual({
      ok: false,
      reason: "回路ファイルのバージョン1に対応しています。",
    });
  });

  it.each([
    ["title is not a string", { ...simpleDocument, title: 1 }],
    ["arrays are required", { ...simpleDocument, parts: {} }],
    ["unknown kind", { ...simpleDocument, parts: [part("unknown", "resistor"), { ...part("bad"), kind: "motor" }] }],
    ["duplicate part IDs", { ...simpleDocument, parts: [part("duplicate"), part("duplicate")] }],
    ["illegal rotation", { title: "", parts: [{ ...part("bad"), rotation: 45 }], wires: [] }],
    ["zero resistance", { title: "", parts: [{ ...part("bad"), resistanceOhms: 0 }], wires: [] }],
    ["negative internal resistance", { title: "", parts: [{ ...part("bad"), internalResistanceOhms: -1 }], wires: [] }],
    ["non-boolean switch state", { title: "", parts: [{ ...part("bad"), initiallyClosed: 1 }], wires: [] }],
    ["duplicate wire IDs", {
      title: "",
      parts: [part("left"), part("right"), part("third")],
      wires: [
        { id: "duplicate", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } },
        { id: "duplicate", from: { partId: "right", terminal: "b" }, to: { partId: "third", terminal: "a" } },
      ],
    }],
    ["missing endpoint part", {
      title: "",
      parts: [part("left")],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "missing", terminal: "a" } }],
    }],
    ["junction has no b terminal", {
      title: "",
      parts: [part("junction", "junction"), part("right")],
      wires: [{ id: "wire", from: { partId: "junction", terminal: "b" }, to: { partId: "right", terminal: "a" } }],
    }],
    ["same-terminal connection", {
      title: "",
      parts: [part("one")],
      wires: [{ id: "wire", from: { partId: "one", terminal: "a" }, to: { partId: "one", terminal: "a" } }],
    }],
    ["same-terminal connection on a three-terminal part", {
      title: "",
      parts: [part("one", "nmos")],
      wires: [{ id: "wire", from: { partId: "one", terminal: "a" }, to: { partId: "one", terminal: "a" } }],
    }],
    ["reversed duplicate wire", {
      title: "",
      parts: [part("left"), part("right")],
      wires: [
        { id: "first", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "b" } },
        { id: "second", from: { partId: "right", terminal: "b" }, to: { partId: "left", terminal: "a" } },
      ],
    }],
  ])("rejects %s", (_name, invalidDocument) => {
    const result = parseRaw(invalidDocument);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.reason).toMatch(/[ぁ-んァ-ヶ一-龠]/); }
  });

  it.each([
    ["zero AC frequency", "ac-source", { frequencyHz: 0 }],
    ["negative capacitance", "capacitor", { capacitanceFarads: -1 }],
    ["zero inductance", "inductor", { inductanceHenries: 0 }],
    ["out-of-range potentiometer position", "potentiometer", { wiperPosition: 1.1 }],
    ["zero diode ideality factor", "diode", { emissionCoefficient: 0 }],
    ["negative MOS threshold", "nmos", { thresholdVolts: -1 }],
    ["reversed op-amp rails", "op-amp", { positiveRailVolts: -5, negativeRailVolts: 5 }],
  ] as const)("rejects invalid analog values: %s", (_name, kind, values) => {
    expect(parseRaw({ title: "", parts: [part("bad", kind, values)], wires: [] }).ok).toBe(false);
  });

  it("allows zero AC amplitude and signed phase, offsets, initial conditions, and current", () => {
    const document = {
      title: "境界値",
      parts: [
        part("ac", "ac-source", { voltageVolts: 0, phaseDegrees: -90, offsetVolts: -2 }),
        part("c", "capacitor", { initialVoltageVolts: -1 }),
        part("l", "inductor", { initialCurrentAmps: -0.01 }),
        part("i", "current-source", { currentAmps: -0.02 }),
      ],
      wires: [],
    };
    expect(parseCircuitDocument(serializeCircuitDocument(document as CircuitDocument)).ok).toBe(true);
  });

  it("throws instead of silently turning invalid numbers into JSON null", () => {
    const invalid = {
      ...simpleDocument,
      parts: [{ ...simpleDocument.parts[0], x: Number.NaN }],
      wires: [],
    } as CircuitDocument;
    expect(() => serializeCircuitDocument(invalid)).toThrow(/有限な数値/);
  });

  it("rejects JSON numbers that overflow to infinity", () => {
    const json = '{"title":"","parts":[{"id":"bad","kind":"resistor","x":1e400,"y":0,"label":"bad"}],"wires":[]}';
    const result = parseCircuitDocument(json);
    expect(result).toEqual({ ok: false, reason: "部品1の x 座標は有限な数値で指定してください。" });
  });

  it("enforces the documented text and element limits at their boundaries", () => {
    const small = JSON.stringify({ title: "", parts: [], wires: [] });
    const exactlyAtLimit = small.padEnd(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH, " ");
    expect(parseCircuitDocument(exactlyAtLimit).ok).toBe(true);
    expect(parseCircuitDocument(`${exactlyAtLimit} `)).toEqual({
      ok: false,
      reason: `読み込みデータは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`,
    });

    const tooManyParts = {
      title: "",
      parts: Array.from({ length: MAX_CIRCUIT_DOCUMENT_PARTS + 1 }, (_, index) => part(`p${index}`)),
      wires: [],
    } as CircuitDocument;
    expect(() => serializeCircuitDocument(tooManyParts)).toThrow(`部品数は${MAX_CIRCUIT_DOCUMENT_PARTS}個以下`);

    const tooManyWires = {
      title: "",
      parts: [],
      wires: Array.from({ length: MAX_CIRCUIT_DOCUMENT_WIRES + 1 }, (_, index) => ({ id: `w${index}` })),
    } as unknown as CircuitDocument;
    expect(() => serializeCircuitDocument(tooManyWires)).toThrow(`導線数は${MAX_CIRCUIT_DOCUMENT_WIRES}本以下`);
  });
});
