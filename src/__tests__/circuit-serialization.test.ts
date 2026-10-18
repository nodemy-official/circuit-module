import { describe, expect, it } from "vitest";

import { inspectCircuit } from "../circuit-diagnostics.js";
import { analyzeCircuit } from "../circuit-solver.js";
import {
  MAX_CIRCUIT_DOCUMENT_JSON_LENGTH,
  MAX_CIRCUIT_DOCUMENT_PARTS,
  MAX_CIRCUIT_DOCUMENT_WIRES,
  MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS,
  MAX_CIRCUIT_DOCUMENT_COORDINATE,
  parseCircuitDocument,
  serializeCircuitDocument,
  validateCircuitFragment,
} from "../circuit-serialization.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../circuit-model.js";

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

function documentWithWaypoints() {
  const document = structuredClone(simpleDocument);
  document.wires[0]!.waypoints = [{ x: 3, y: 4 }];
  return document;
}

describe("circuit document serialization", () => {
  it("counts UTF-16 units at the JSON input length boundary", () => {
    const prefix = '{"title":"';
    const suffix = '","parts":[],"wires":[]}';
    const titleLength = MAX_CIRCUIT_DOCUMENT_JSON_LENGTH - prefix.length - suffix.length;
    const title = "😀".repeat(Math.floor(titleLength / 2)) + "a".repeat(titleLength % 2);
    const json = prefix + title + suffix;
    expect(json.length).toBe(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(parseCircuitDocument(json)).toEqual({ ok: true, document: { title, parts: [], wires: [] } });
    expect(parseCircuitDocument(`${prefix}${title}a${suffix}`)).toEqual({
      ok: false,
      reason: `読み込みデータは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`,
    });
  });

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

  it("ignores unknown getters when saving a document", () => {
    const document = structuredClone(simpleDocument);
    for (const record of [document, ...document.parts, ...document.wires,
      ...document.wires.flatMap((wire) => [wire.from, wire.to])]) {
      Object.defineProperty(record, "futureProperty", {
        enumerable: true,
        get() { throw new Error("Unknown getter must not run"); },
      });
    }
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: simpleDocument });
  });

  it.each([undefined, 20])("preserves the analyzed resistance %s when a Proxy supplies a different value", (resistanceOhms) => {
    const resistor: CircuitPart = part("resistor");
    if (resistanceOhms !== undefined) { resistor.resistanceOhms = resistanceOhms; }
    let reads = 0;
    const trapped = new Proxy(resistor, {
      get(target, key, receiver) {
        if (key === "resistanceOhms") { reads += 1; return 100; }
        return Reflect.get(target, key, receiver);
      },
    });
    const document: CircuitDocument = {
      title: "抵抗値の保持",
      parts: [part("battery", "battery", { voltageVolts: 9, internalResistanceOhms: 0 }), trapped],
      wires: [
        { id: "a", from: { partId: "battery", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "b", from: { partId: "battery", terminal: "b" }, to: { partId: "resistor", terminal: "b" } },
      ],
    };
    const before = analyzeCircuit(document);
    const restored = parseCircuitDocument(serializeCircuitDocument(document));
    expect(restored.ok).toBe(true);
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(restored.document.parts[1]).toEqual(resistor);
    expect(analyzeCircuit(restored.document).parts.resistor!.currentAmps).toBe(before.parts.resistor!.currentAmps);
    expect(reads).toBe(0);
  });

  it.each([undefined, false])("preserves the analyzed switch state %s when a Proxy supplies a different value", (initiallyClosed) => {
    const switchPart: CircuitPart = part("switch", "switch");
    if (initiallyClosed !== undefined) { switchPart.initiallyClosed = initiallyClosed; }
    let reads = 0;
    const trapped = new Proxy(switchPart, {
      get(target, key, receiver) {
        if (key === "initiallyClosed") { reads += 1; return initiallyClosed !== undefined; }
        return Reflect.get(target, key, receiver);
      },
    });
    const document: CircuitDocument = {
      title: "スイッチ状態の保持",
      parts: [part("battery", "battery", { voltageVolts: 9, internalResistanceOhms: 0 }),
        part("resistor", "resistor", { resistanceOhms: 10 }), trapped],
      wires: [
        { id: "a", from: { partId: "battery", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "b", from: { partId: "resistor", terminal: "b" }, to: { partId: "switch", terminal: "a" } },
        { id: "c", from: { partId: "switch", terminal: "b" }, to: { partId: "battery", terminal: "b" } },
      ],
    };
    const before = analyzeCircuit(document);
    const restored = parseCircuitDocument(serializeCircuitDocument(document));
    expect(restored.ok).toBe(true);
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(restored.document.parts[2]).toEqual(switchPart);
    const after = analyzeCircuit(restored.document);
    expect(after.status).toBe(before.status);
    expect(after.parts.resistor!.currentAmps).toBe(before.parts.resistor!.currentAmps);
    expect(reads).toBe(0);
  });

  it("snapshots all saved records and array entries without invoking Proxy get traps", () => {
    const expected = documentWithWaypoints();
    let reads = 0;
    function trap<T extends object>(value: T): T {
      return new Proxy(value, {
        get() { reads += 1; throw new Error("Property read must not run"); },
      });
    }
    const document = trap({
      title: expected.title,
      parts: trap(expected.parts.map((item) => trap(item))),
      wires: trap(expected.wires.map((wire) => trap({
        ...wire,
        from: trap(wire.from),
        to: trap(wire.to),
        ...(wire.waypoints ? { waypoints: trap(wire.waypoints.map((point) => trap(point))) } : {}),
      }))),
    });
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: expected });
    expect(reads).toBe(0);
  });

  it("preserves array entries when a Proxy supplies a different length, index, or iterator", () => {
    const document = documentWithWaypoints();
    const expected = structuredClone(document);
    let reads = 0;
    document.parts = new Proxy(document.parts, {
      get(target, key, receiver) {
        reads += 1;
        if (key === "length") { return 0; }
        if (key === "0") { return part("replacement"); }
        if (key === Symbol.iterator) {
          return function* replacement() { yield part("replacement"); };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: expected });
    expect(reads).toBe(0);
  });

  it.each([
    ["document title", (document: CircuitDocument) => [document, "title"]],
    ["part array index", (document: CircuitDocument) => [document.parts, "0"]],
    ["part coordinate", (document: CircuitDocument) => [document.parts[0]!, "x"]],
    ["numeric part value", (document: CircuitDocument) => [document.parts[1]!, "resistanceOhms"]],
    ["optional switch state", (document: CircuitDocument) => [document.parts[1]!, "initiallyClosed"]],
    ["wire array index", (document: CircuitDocument) => [document.wires, "0"]],
    ["wire endpoint", (document: CircuitDocument) => [document.wires[0]!, "from"]],
    ["endpoint part ID", (document: CircuitDocument) => [document.wires[0]!.from, "partId"]],
    ["endpoint terminal", (document: CircuitDocument) => [document.wires[0]!.to, "terminal"]],
    ["wire waypoints", (document: CircuitDocument) => [document.wires[0]!, "waypoints"]],
    ["waypoint array index", (document: CircuitDocument) => [document.wires[0]!.waypoints!, "0"]],
    ["waypoint coordinate", (document: CircuitDocument) => [document.wires[0]!.waypoints![0]!, "x"]],
  ] as const)("rejects a saved %s accessor without invoking it", (_name, target) => {
    const document = documentWithWaypoints();
    const [record, key] = target(document);
    let reads = 0;
    Object.defineProperty(record, key, {
      configurable: true,
      get() { reads += 1; throw new Error("Known getter must not run"); },
    });
    expect(() => serializeCircuitDocument(document)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("preserves non-enumerable own values and ignores unknown getters throughout a saved graph", () => {
    const document = documentWithWaypoints();
    const expected = structuredClone(document);
    const records = [document, document.parts, document.wires, ...document.parts, ...document.wires,
      ...document.wires.flatMap((wire) => [wire.from, wire.to, ...(wire.waypoints ?? []),
        ...(wire.waypoints ? [wire.waypoints] : [])])];
    for (const record of records) {
      for (const key of Object.keys(record)) {
        Object.defineProperty(record, key, { enumerable: false });
      }
      Object.defineProperty(record, "futureProperty", {
        get() { throw new Error("Unknown getter must not run"); },
      });
    }
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: expected });
  });

  it("captures each saved descriptor once before numeric validation and normalization", () => {
    let captures = 0;
    const resistor = new Proxy(part("resistor", "resistor", { resistanceOhms: 20 }), {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "resistanceOhms" && descriptor) {
          captures += 1;
          return { ...descriptor, value: captures === 1 ? 20 : 100 };
        }
        return descriptor;
      },
    });
    const restored = parseCircuitDocument(serializeCircuitDocument({ title: "", parts: [resistor], wires: [] }));
    expect(restored.ok && restored.document.parts[0]!.resistanceOhms).toBe(20);
    expect(captures).toBe(1);
  });

  it.each(["document", "fragment"] as const)("rejects a shared endpoint's self-connection while capturing a %s", (kind) => {
    let captures = 0;
    const endpoint = new Proxy({ partId: "first", terminal: "a" as const }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "partId" && ++captures === 2) { target.partId = "second"; }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const document: CircuitDocument = {
      title: "共有された接続先",
      parts: [part("first"), part("second")],
      wires: [{ id: "wire", from: endpoint, to: endpoint }],
    };

    if (kind === "document") { expect(() => serializeCircuitDocument(document)).toThrow(/同じ端子/); }
    else { expect(validateCircuitFragment(document)).toMatchObject({ ok: false, reason: expect.stringContaining("同じ端子") }); }
    expect(captures).toBe(1);
  });

  it.each(["document", "fragment"] as const)("rejects a repeated part while capturing a %s without inventing another ID", (kind) => {
    let captures = 0;
    const sharedPart = new Proxy(part("first"), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "id" && ++captures === 2) { target.id = "second"; }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const document: CircuitDocument = { title: "共有された部品", parts: [sharedPart, sharedPart], wires: [] };

    if (kind === "document") { expect(() => serializeCircuitDocument(document)).toThrow(/重複/); }
    else { expect(validateCircuitFragment(document)).toMatchObject({ ok: false, reason: expect.stringContaining("重複") }); }
    expect(captures).toBe(1);
  });

  it("shares captured route values within a save and refreshes them on the next save", () => {
    let captures = 0;
    const point = new Proxy({ x: 3, y: 4 }, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "x" && descriptor ? { ...descriptor, value: ++captures } : descriptor;
      },
    });
    const waypoints = [point, point];
    const sharedFrom = { partId: "first", terminal: "a" as const };
    const document: CircuitDocument = {
      title: "共有された経由点",
      parts: [part("first"), part("second"), part("third")],
      wires: [
        { id: "one", from: sharedFrom, to: { partId: "second", terminal: "a" }, waypoints },
        { id: "two", from: sharedFrom, to: { partId: "third", terminal: "a" }, waypoints },
      ],
    };

    for (const x of [1, 2]) {
      const saved = parseCircuitDocument(serializeCircuitDocument(document));
      if (!saved.ok) { throw new Error(saved.reason); }
      for (const wire of saved.document.wires) {
        expect(wire.waypoints).toEqual([{ x, y: 4 }, { x, y: 4 }]);
      }
      expect(captures).toBe(x);
    }
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
