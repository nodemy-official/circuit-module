import { describe, expect, it } from "vitest";

import { MAX_WIRE_COORDINATE } from "../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_ROUTE_ANCHORS, type CircuitDocument, type CircuitRouteAnchor } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument, validateCircuitFragment, validateCircuitRouteAnchors } from "../circuit-serialization.js";

function documentWithAnchors(routeAnchors?: CircuitRouteAnchor[]): CircuitDocument {
  return {
    title: "境界ルートの保存",
    parts: [
      { id: "source", kind: "junction", x: 0, y: 3, label: "S" },
      { id: "target", kind: "junction", x: 10, y: 3, label: "T" },
    ],
    wires: [{ id: "wire", from: { partId: "source", terminal: "a" }, to: { partId: "target", terminal: "a" },
      ...(routeAnchors === undefined ? {} : { routeAnchors }) }],
  };
}

const anchors: CircuitRouteAnchor[] = [
  { x: 4, y: 3, xBoundary: 1 },
  { x: 4, y: -2, xBoundary: 1, yBoundary: -1 },
  { x: -3, y: -2, xBoundary: -1, yBoundary: -1 },
  { x: -3, y: 5, xBoundary: -1, yBoundary: 1 },
  { x: MAX_WIRE_COORDINATE, y: 5, yBoundary: 1 },
  { x: MAX_WIRE_COORDINATE, y: 3 },
  { x: 10, y: 3 },
];

function parseRaw(document: unknown) {
  return parseCircuitDocument(JSON.stringify(document));
}

describe("generated wire route anchor serialization", () => {
  it.each([
    [{ x: 0, y: 3 }, { x: 1, y: 4 }],
    [{ x: 4, y: 3, xBoundary: 1 as const }, { x: 4, y: 4 }],
  ].map((routeAnchors) => ({ routeAnchors })))("rejects nonorthogonal decoded internal vertices (%j)", ({ routeAnchors }) => {
    expect(validateCircuitRouteAnchors(routeAnchors)).toMatchObject({ ok: false, reason: expect.stringContaining("直交") });
    const document = documentWithAnchors(routeAnchors);
    expect(() => serializeCircuitDocument(document)).toThrow(/直交/);
    expect(validateCircuitFragment(document)).toMatchObject({ ok: false, reason: expect.stringContaining("直交") });
    expect(parseRaw({ format: "circuit-module", version: 2, document })).toMatchObject({ ok: false, reason: expect.stringContaining("直交") });
  });

  it.each([
    { endpoint: "始点", routeAnchors: [{ x: 1, y: 1 }] },
    { endpoint: "始点", routeAnchors: [{ x: 4, y: 3, yBoundary: 1 as const }] },
    { endpoint: "終点", routeAnchors: [{ x: 0, y: 1 }, { x: 1, y: 1 }] },
  ])("rejects a nonorthogonal connection to the $endpoint terminal", ({ endpoint, routeAnchors }) => {
    expect(validateCircuitRouteAnchors(routeAnchors).ok).toBe(true);
    const document = documentWithAnchors(routeAnchors);
    expect(() => serializeCircuitDocument(document)).toThrow(new RegExp(`${endpoint}.*直交`));
    expect(validateCircuitFragment(document)).toMatchObject({ ok: false, reason: expect.stringContaining(endpoint) });
    expect(parseRaw({ format: "circuit-module", version: 2, document })).toMatchObject({ ok: false, reason: expect.stringContaining(endpoint) });
  });

  it("accepts orthogonal vertices with duplicates while retaining implicit legacy waypoint routing", () => {
    const routeAnchors = [{ x: 0, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 4 }, { x: 10, y: 4 }, { x: 10, y: 3 }];
    expect(validateCircuitRouteAnchors(routeAnchors)).toEqual({ ok: true, routeAnchors });
    const explicit = documentWithAnchors(routeAnchors);
    expect(parseCircuitDocument(serializeCircuitDocument(explicit))).toEqual({ ok: true, document: explicit });
    const legacy = documentWithAnchors();
    legacy.wires[0]!.waypoints = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(JSON.parse(serializeCircuitDocument(legacy)).version).toBe(1);
    expect(parseCircuitDocument(serializeCircuitDocument(legacy))).toEqual({ ok: true, document: legacy });
  });

  it("uses version 2 only for nonempty route anchors and preserves raw documents and fragments", () => {
    const document = documentWithAnchors(anchors);
    const json = serializeCircuitDocument(document);
    expect(JSON.parse(json).version).toBe(2);
    expect(parseCircuitDocument(json)).toEqual({ ok: true, document });
    expect(parseRaw(document)).toEqual({ ok: true, document });
    const fragment = validateCircuitFragment(document);
    expect(fragment).toEqual({ ok: true, fragment: { parts: document.parts, wires: document.wires } });
    if (!fragment.ok) { throw new Error(fragment.reason); }
    expect(fragment.fragment.wires[0]!.routeAnchors).not.toBe(anchors);
    expect(fragment.fragment.wires[0]!.routeAnchors![0]).not.toBe(anchors[0]);

    for (const routeAnchors of [undefined, []]) {
      const ordinary = JSON.parse(serializeCircuitDocument(documentWithAnchors(routeAnchors)));
      expect(ordinary.version).toBe(1);
      expect(ordinary.document.wires[0]).not.toHaveProperty("routeAnchors");
    }
  });

  it("accepts both envelope versions but rejects generated metadata in version 1", () => {
    const ordinary = documentWithAnchors();
    const document = documentWithAnchors(anchors);
    for (const version of [1, 2]) {
      expect(parseRaw({ format: "circuit-module", version, document: ordinary })).toEqual({ ok: true, document: ordinary });
    }
    expect(parseRaw({ format: "circuit-module", version: 1, document })).toMatchObject({
      ok: false, reason: expect.stringContaining("バージョン2"),
    });
    expect(parseRaw({ format: "circuit-module", version: 2, document })).toEqual({ ok: true, document });
  });

  it("rejects competing nonempty routing fields and omits empty fields", () => {
    const document = documentWithAnchors(anchors);
    document.wires[0]!.waypoints = [{ x: 3, y: 4 }];
    expect(() => serializeCircuitDocument(document)).toThrow(/同時/);
    expect(validateCircuitFragment(document)).toMatchObject({ ok: false, reason: expect.stringContaining("同時") });
    expect(parseRaw(document)).toMatchObject({ ok: false, reason: expect.stringContaining("同時") });

    document.wires[0]!.waypoints = [];
    const withAnchors = JSON.parse(serializeCircuitDocument(document));
    expect(withAnchors.version).toBe(2);
    expect(withAnchors.document.wires[0]).not.toHaveProperty("waypoints");
    document.wires[0]!.waypoints = [{ x: 3, y: 4 }];
    document.wires[0]!.routeAnchors = [];
    const withWaypoints = JSON.parse(serializeCircuitDocument(document));
    expect(withWaypoints.version).toBe(1);
    expect(withWaypoints.document.wires[0].waypoints).toEqual([{ x: 3, y: 4 }]);
    expect(withWaypoints.document.wires[0]).not.toHaveProperty("routeAnchors");
  });

  it.each([
    undefined, null, {}, "route", [null], [{ x: 0 }],
    [{ x: Number.NaN, y: 0 }], [{ x: 0, y: Number.POSITIVE_INFINITY }],
    [{ x: MAX_WIRE_COORDINATE + 1, y: 0 }], [{ x: 0, y: -MAX_WIRE_COORDINATE - 1 }],
    [{ x: 4, y: 0, xBoundary: 0 }], [{ x: 4, y: 0, xBoundary: 2 }],
    [{ x: 0, y: 4, yBoundary: "1" }], [{ x: 4, y: 0, xBoundary: null }],
    [{ x: 0, y: 0, xBoundary: 1 }], [{ x: -0, y: 0, xBoundary: -1 }],
    [{ x: -4, y: 0, xBoundary: 1 }], [{ x: 0, y: 4, yBoundary: -1 }],
    [{ x: Number.MIN_VALUE, y: 0, xBoundary: 1 }],
    [{ x: 0, y: -Number.MIN_VALUE, yBoundary: -1 }],
  ].map((value) => ({ value })))("rejects malformed or nonrepresentable route anchors (%j)", ({ value }) => {
    expect(validateCircuitRouteAnchors(value)).toMatchObject({ ok: false, reason: expect.any(String) });
    if (value === undefined) { return; }
    const document = documentWithAnchors(value as CircuitRouteAnchor[]);
    expect(() => serializeCircuitDocument(document)).toThrow(TypeError);
    expect(validateCircuitFragment(document)).toMatchObject({ ok: false });
  });

  it("keeps ordinary waypoint bounds unchanged", () => {
    const document = documentWithAnchors();
    document.wires[0]!.waypoints = [{ x: MAX_WIRE_COORDINATE + 1, y: 0 }];
    expect(() => serializeCircuitDocument(document)).toThrow(TypeError);
    expect(parseRaw(document)).toMatchObject({ ok: false });
  });

  it("accepts the generated-anchor count boundary and rejects excess or sparse arrays before reading entries", () => {
    const values = Array.from({ length: MAX_CIRCUIT_WIRE_ROUTE_ANCHORS }, () => ({ x: 2, y: 0, xBoundary: 1 as const }));
    const result = validateCircuitRouteAnchors(values);
    expect(result.ok && result.routeAnchors).toHaveLength(MAX_CIRCUIT_WIRE_ROUTE_ANCHORS);
    const excessive = [...values, values[0]!];
    let reads = 0;
    Object.defineProperty(excessive, "0", { get() { reads += 1; throw new Error("Limit must be checked first"); } });
    expect(validateCircuitRouteAnchors(excessive)).toMatchObject({ ok: false, reason: expect.stringContaining(`${MAX_CIRCUIT_WIRE_ROUTE_ANCHORS}`) });
    expect(reads).toBe(0);
    expect(validateCircuitRouteAnchors(new Array(2))).toMatchObject({ ok: false });
    expect(() => serializeCircuitDocument(documentWithAnchors(excessive))).toThrow(TypeError);
    expect(() => serializeCircuitDocument(documentWithAnchors(new Array(2)))).toThrow(TypeError);
  });

  it("captures arrays, shared points, and markers once without invoking Proxy get traps", () => {
    let reads = 0;
    let captures = 0;
    const point = new Proxy({ x: 2, y: 3, xBoundary: 1 as const }, {
      get() { reads += 1; throw new Error("Property reads must not run"); },
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "x" && descriptor ? { ...descriptor, value: ++captures } : descriptor;
      },
    });
    const values = new Proxy([point, point], { get() { reads += 1; throw new Error("Array reads must not run"); } });
    const document = documentWithAnchors(values);
    document.parts.push({ id: "other", kind: "junction", x: 20, y: 3, label: "O" });
    document.wires.push({ id: "other", from: { partId: "source", terminal: "a" }, to: { partId: "other", terminal: "a" }, routeAnchors: values });
    for (const x of [1, 2]) {
      const restored = parseCircuitDocument(serializeCircuitDocument(document));
      if (!restored.ok) { throw new Error(restored.reason); }
      for (const wire of restored.document.wires) {
        expect(wire.routeAnchors).toEqual([{ x, y: 3, xBoundary: 1 }, { x, y: 3, xBoundary: 1 }]);
      }
      expect(captures).toBe(x);
    }
    expect(reads).toBe(0);
  });

  it.each(["array", "index", "x", "y", "xBoundary", "yBoundary"] as const)("rejects a known %s accessor without invoking it", (field) => {
    const values: CircuitRouteAnchor[] = [{ x: 2, y: -3, xBoundary: 1, yBoundary: -1 }];
    const document = documentWithAnchors(values);
    const record = field === "array" ? document.wires[0]! : field === "index" ? values : values[0]!;
    const key = field === "array" ? "routeAnchors" : field === "index" ? "0" : field;
    let reads = 0;
    Object.defineProperty(record, key, { configurable: true, get() { reads += 1; throw new Error("Getter must not run"); } });
    expect(() => serializeCircuitDocument(document)).toThrow(TypeError);
    expect(validateCircuitFragment(document)).toMatchObject({ ok: false });
    expect(reads).toBe(0);
  });

  it("preserves non-enumerable route fields, drops unknown fields, and ignores inherited markers", () => {
    const point = { x: 2, y: 3, xBoundary: 1 as const };
    const values = [point];
    const document = documentWithAnchors(values);
    for (const record of [document.wires[0]!, values, point]) {
      for (const key of Object.keys(record)) { Object.defineProperty(record, key, { enumerable: false }); }
      Object.defineProperty(record, "unknown", { get() { throw new Error("Unknown getter must not run"); } });
    }
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: documentWithAnchors([{ x: 2, y: 3, xBoundary: 1 }]) });
    expect(validateCircuitRouteAnchors([Object.assign(Object.create({ xBoundary: 1 }), { x: 2, y: 3 })])).toEqual({ ok: true, routeAnchors: [{ x: 2, y: 3 }] });
  });
});
