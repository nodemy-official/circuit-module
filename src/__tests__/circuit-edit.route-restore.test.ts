import { describe, expect, it } from "vitest";

import { setWireRoute } from "../circuit-edit.js";
import { MAX_CIRCUIT_WIRE_ROUTE_ANCHORS, type CircuitDocument } from "../circuit-model.js";
import { routeDocumentWires } from "../circuit-geometry.js";
import { serializeCircuitDocument } from "../circuit-serialization.js";

function fixture(): CircuitDocument {
  return {
    title: "保存経路の復元",
    parts: [
      { id: "source", kind: "resistor", x: 0, y: 0, label: "R" },
      { id: "target", kind: "junction", x: 10, y: 10, label: "J" },
    ],
    wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
      routeAnchors: [{ x: 3, y: 0 }, { x: 3, y: 5 }, { x: 10, y: 5 }],
    }],
  };
}

function restorePoints(snapshot: unknown) {
  return Object.defineProperty([{ x: 3, y: 0 }, { x: 3, y: 5 }, { x: 10, y: 5 }], "restoreRoute", { value: snapshot });
}

describe("stored wire route restoration", () => {
  it("stores generated geometry consistently when compact coordinates meet either current format", () => {
    const explicit = fixture();
    const legacy: CircuitDocument = { ...explicit, wires: [{ id: "wire", from: explicit.wires[0]!.from, to: explicit.wires[0]!.to,
      waypoints: [{ x: 0, y: 4 }, { x: 10, y: 4 }],
    }] };
    const results = [explicit, legacy].map((document) => {
      const points = Object.defineProperty([{ x: 3, y: 6 }], "generatedRoute", {
        value: { kind: "generated", points: [{ x: 3, y: 0 }, { x: 3, y: 6 }, { x: 10, y: 6 }] },
      });
      const result = setWireRoute(document, "wire", points);
      if (!result.ok) { throw new Error(result.reason); }
      expect(result.document.wires[0]!.waypoints?.length).toBeGreaterThan(0);
      expect(result.document.wires[0]).not.toHaveProperty("routeAnchors");
      expect(routeDocumentWires(result.document).get("wire")).toEqual([
        { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 6 }, { x: 10, y: 6 }, { x: 10, y: 10 },
      ]);
      return result.document;
    });
    expect(results[0]).toEqual(results[1]);
  });

  it("keeps explicitly generated inward visits literal even on a legacy wire", () => {
    const document = fixture();
    const { routeAnchors: _anchors, ...wire } = document.wires[0]!;
    document.wires = [wire];
    const vertices = [{ x: 1, y: 0 }, { x: 1, y: 5 }, { x: 10, y: 5 }];
    const points = Object.defineProperty([{ x: 1, y: 5 }], "generatedRoute", { value: { kind: "routeAnchors", points: vertices } });
    const result = setWireRoute(document, "wire", points);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]!.routeAnchors).toEqual(vertices);
    expect(routeDocumentWires(result.document).get("wire")).toEqual([{ x: 2, y: 0 }, ...vertices, { x: 10, y: 10 }]);
  });

  it.each(["generated", "routeAnchors"])("applies storage limits after processing a long %s candidate", (kind) => {
    const document: CircuitDocument = {
      title: "長い完成経路",
      parts: [{ id: "a", kind: "junction", x: 0, y: 0, label: "A" }, { id: "b", kind: "junction", x: 10, y: 0, label: "B" }],
      wires: [{ id: "wire", from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "a" } }],
    };
    const points = Object.defineProperty([{ x: 4, y: 0 }], "generatedRoute", {
      value: { kind, points: Array.from({ length: MAX_CIRCUIT_WIRE_ROUTE_ANCHORS + 1 }, () => ({ x: 4, y: 0 })) },
    });
    const result = setWireRoute(document, "wire", points);
    if (kind === "routeAnchors") {
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.reason).toContain(String(MAX_CIRCUIT_WIRE_ROUTE_ANCHORS)); }
    } else {
      if (!result.ok) { throw new Error(result.reason); }
      expect(result.document.wires[0]!.waypoints).toHaveLength(1);
      expect(JSON.parse(serializeCircuitDocument(result.document)).version).toBe(1);
    }
    expect(document.wires[0]).not.toHaveProperty("waypoints");
  });

  it.each([
    null,
    { kind: "other", points: [] },
    { kind: "generated", points: {} },
    { kind: "generated", points: [{ x: Number.NaN, y: 0 }] },
    { kind: "generated", points: [{ x: 3, y: 0 }, { x: 4, y: 1 }] },
  ])("rejects invalid generated geometry (%j)", (generated) => {
    const document = fixture();
    const points = Object.defineProperty([{ x: 3, y: 0 }], "generatedRoute", { value: generated });
    expect(setWireRoute(document, "wire", points).ok).toBe(false);
    expect(document).toEqual(fixture());
  });

  it.each((["generated", "routeAnchors"] as const).flatMap((kind) =>
    [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined].map((length) => ({ kind, length })),
  ))("rejects an invalid $kind point count ($length) without changing the stored route", ({ kind, length }) => {
    const document = fixture();
    document.parts[1]!.y = 0;
    const before = serializeCircuitDocument(document);
    const vertices = new Proxy([{ x: 3, y: 0 }], {
      get(target, key, receiver) { return key === "length" ? length : Reflect.get(target, key, receiver); },
    });
    const points = Object.defineProperty([{ x: 3, y: 0 }], "generatedRoute", { value: { kind, points: vertices } });

    expect(setWireRoute(document, "wire", points)).toMatchObject({ ok: false });
    expect(serializeCircuitDocument(document)).toBe(before);
  });

  it.each((["generated", "routeAnchors"] as const).flatMap((kind) =>
    [2 ** 32, 2 ** 53, Number.MAX_VALUE, 0xff_ff_ff_ff + 1].map((length) => ({ kind, length })),
  ))("rejects an impossible $kind array length ($length) before reading points", ({ kind, length }) => {
    const document = fixture();
    let lengthReads = 0;
    let pointReads = 0;
    const vertices = new Proxy([{ x: 3, y: 0 }], {
      get(_target, key) {
        if (key === "length") { lengthReads += 1; return length; }
        pointReads += 1;
        throw new Error("Points must not be read");
      },
    });
    const points = Object.defineProperty([{ x: 3, y: 0 }], "generatedRoute", { value: { kind, points: vertices } });

    expect(setWireRoute(document, "wire", points)).toMatchObject({ ok: false });
    expect(lengthReads).toBe(1);
    expect(pointReads).toBe(0);
    expect(document).toEqual(fixture());
  });

  it.each(["generated", "routeAnchors"] as const)("rejects a throwing %s point count", (kind) => {
    const document = fixture();
    let reads = 0;
    const vertices = new Proxy([{ x: 3, y: 0 }], {
      get(target, key, receiver) {
        if (key === "length") { reads += 1; throw new Error("Invalid count"); }
        return Reflect.get(target, key, receiver);
      },
    });
    const points = Object.defineProperty([{ x: 3, y: 0 }], "generatedRoute", { value: { kind, points: vertices } });

    expect(setWireRoute(document, "wire", points)).toMatchObject({ ok: false });
    expect(reads).toBe(1);
    expect(document).toEqual(fixture());
  });

  it.each([
    { mode: undefined, shared: true },
    { mode: "generated", shared: false },
    { mode: "generated", shared: true },
    { mode: "routeAnchors", shared: false },
    { mode: "routeAnchors", shared: true },
  ] as const)("captures the point count once (mode=$mode, shared=$shared)", ({ mode, shared }) => {
    const document = fixture();
    const vertices = [{ x: 4, y: 0 }, { x: 4, y: 6 }, { x: 10, y: 6 }];
    let reads = 0;
    const captured = new Proxy(vertices, {
      get(target, key, receiver) {
        if (key === "length") { reads += 1; return reads === 1 ? 3 : Number.NaN; }
        return Reflect.get(target, key, receiver);
      },
    });
    const points = mode === undefined ? captured : Object.defineProperty(shared ? captured : [{ x: 4, y: 6 }], "generatedRoute", {
      value: { kind: mode, points: captured },
    });

    const result = setWireRoute(document, "wire", points);
    if (!result.ok) { throw new Error(result.reason); }
    expect(reads).toBe(1);
    expect(routeDocumentWires(result.document).get("wire")).toEqual([
      { x: 2, y: 0 }, ...vertices, { x: 10, y: 10 },
    ]);
    expect(document).toEqual(fixture());
  });

  it("rejects a throwing callback point count", () => {
    const document = fixture();
    let reads = 0;
    const points = new Proxy([{ x: 3, y: 0 }], {
      get(target, key, receiver) {
        if (key === "length") { reads += 1; throw new Error("Invalid count"); }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(setWireRoute(document, "wire", points)).toMatchObject({ ok: false });
    expect(reads).toBe(1);
    expect(document).toEqual(fixture());
  });

  it.each(["generatedRoute", "kind", "points"])("rejects a generated %s accessor without invoking it", (field) => {
    let reads = 0;
    const accessor = { get() { reads += 1; throw new Error("Accessor must not run"); } };
    const generated = { kind: "generated", points: [{ x: 3, y: 0 }, { x: 3, y: 6 }, { x: 10, y: 6 }] };
    const points = [{ x: 3, y: 0 }];
    if (field === "generatedRoute") { Object.defineProperty(points, field, accessor); }
    else {
      Object.defineProperty(generated, field, accessor);
      Object.defineProperty(points, "generatedRoute", { value: generated });
    }
    expect(setWireRoute(fixture(), "wire", points).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("restores authored waypoints independently of the current explicit representation", () => {
    const document = fixture();
    const points = [{ x: 0, y: 4 }, { x: 10, y: 4 }];
    const result = setWireRoute(document, "wire", restorePoints({ kind: "waypoints", points }));
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]!.waypoints).toEqual(points);
    expect(result.document.wires[0]).not.toHaveProperty("routeAnchors");
    expect(JSON.parse(serializeCircuitDocument(result.document)).version).toBe(1);
    points[0]!.x = 100;
    expect(result.document.wires[0]!.waypoints![0]!.x).toBe(0);
    expect(document).toEqual(fixture());
  });

  it("captures explicit own data without running unknown getters or sharing the supplied points", () => {
    const document = fixture();
    const points = [{ x: 4, y: 0 }, { x: 4, y: 6 }, { x: 10, y: 6 }];
    for (const point of points) {
      for (const key of ["x", "y"]) { Object.defineProperty(point, key, { enumerable: false }); }
    }
    const snapshot = { kind: "routeAnchors", points };
    let reads = 0;
    Object.defineProperty(snapshot, "extra", { get() { reads += 1; throw new Error("Unknown getter must not run"); } });
    const result = setWireRoute(document, "wire", restorePoints(snapshot));
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]!.routeAnchors).toEqual([{ x: 4, y: 0 }, { x: 4, y: 6 }, { x: 10, y: 6 }]);
    points[0]!.x = 100;
    expect(result.document.wires[0]!.routeAnchors![0]!.x).toBe(4);
    expect(reads).toBe(0);
    expect(document).toEqual(fixture());
  });

  it.each([
    null,
    { kind: "other", points: [] },
    { kind: "waypoints", points: {} },
    { kind: "waypoints", points: [{ x: Number.NaN, y: 0 }] },
    { kind: "routeAnchors", points: [{ x: Number.POSITIVE_INFINITY, y: 0 }] },
    { kind: "routeAnchors", points: [{ x: 4, y: 0 }, { x: 5, y: 1 }] },
    { kind: "routeAnchors", points: [{ x: 4, y: 1 }, { x: 10, y: 1 }] },
    { kind: "routeAnchors", points: [{ x: 4, y: 0 }, { x: 4, y: 5 }, { x: 9, y: 5 }] },
  ])("rejects invalid restoration data without modifying the document (%j)", (snapshot) => {
    const document = fixture();
    const before = serializeCircuitDocument(document);
    expect(setWireRoute(document, "wire", restorePoints(snapshot)).ok).toBe(false);
    expect(serializeCircuitDocument(document)).toBe(before);
  });

  it.each(["restoreRoute", "kind", "points"])("rejects a %s accessor without invoking it", (field) => {
    let reads = 0;
    const accessor = { get() { reads += 1; throw new Error("Accessor must not run"); } };
    const snapshot = { kind: "routeAnchors", points: [{ x: 4, y: 0 }, { x: 4, y: 6 }, { x: 10, y: 6 }] };
    if (field !== "restoreRoute") { Object.defineProperty(snapshot, field, accessor); }
    const points = field === "restoreRoute" ? Object.defineProperty([{ x: 3, y: 0 }], field, accessor) : restorePoints(snapshot);
    const document = fixture();
    expect(setWireRoute(document, "wire", points).ok).toBe(false);
    expect(reads).toBe(0);
    expect(document).toEqual(fixture());
  });

  it("ignores an inherited restoration tag", () => {
    const points = [{ x: 3, y: 0 }, { x: 3, y: 6 }, { x: 10, y: 6 }];
    Object.setPrototypeOf(points, Object.create(Array.prototype, {
      restoreRoute: { value: { kind: "waypoints", points: [{ x: 0, y: 4 }] } },
      generatedRoute: { value: { kind: "generated", points: [{ x: 3, y: 0 }, { x: 3, y: 6 }, { x: 10, y: 6 }] } },
    }));
    const result = setWireRoute(fixture(), "wire", points);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]!.routeAnchors).toEqual([{ x: 3, y: 0 }, { x: 3, y: 6 }, { x: 10, y: 6 }]);
    expect(result.document.wires[0]).not.toHaveProperty("waypoints");
  });
});
