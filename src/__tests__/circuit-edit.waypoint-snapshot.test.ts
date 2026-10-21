import { describe, expect, it } from "vitest";

import { setWireWaypoints } from "../circuit-edit.js";
import type { CircuitDocument } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

describe("wire waypoint snapshots", () => {
  it.each([null, false, 0, "", { length: 0 }, { 0: { x: 3, y: 3 }, length: 1 }])("rejects a non-array route input (%j)", (waypoints) => {
    const document: CircuitDocument = {
      title: "経由点の配列型",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      ],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 5, y: 5 }] }],
    };
    const before = structuredClone(document);
    expect(Reflect.apply(setWireWaypoints, undefined, [document, "wire", waypoints])).toMatchObject({ ok: false });
    expect(document).toEqual(before);
  });

  it("captures a shared point once and refreshes it on the next edit", () => {
    const document: CircuitDocument = {
      title: "共有経由点",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      ],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } }],
    };
    let reads = 0;
    const point = { get x() { return ++reads; }, y: 5 };

    for (const x of [1, 2]) {
      const result = setWireWaypoints(document, "wire", [point, point]);
      if (!result.ok) { throw new Error(result.reason); }
      expect(result.document.wires[0]?.waypoints).toEqual([{ x, y: 5 }, { x, y: 5 }]);
      expect(reads).toBe(x);
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined])("rejects an invalid array length (%s) without clearing the existing route", (length) => {
    const document: CircuitDocument = {
      title: "経由点配列の長さ",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      ],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 5, y: 5 }] }],
    };
    const before = structuredClone(document);
    const waypoints = new Proxy([{ x: 3, y: 3 }], {
      get(target, key, receiver) { return key === "length" ? length : Reflect.get(target, key, receiver); },
    });

    expect(setWireWaypoints(document, "wire", waypoints)).toMatchObject({ ok: false });
    expect(document).toEqual(before);
  });

  it.each(["x", "y"] as const)("validates and saves the same captured %s coordinate", (coordinate) => {
    const document: CircuitDocument = {
      title: "経由点のスナップショット",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      ],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } }],
    };
    const before = structuredClone(document);
    let reads = 0;
    const point = { x: 5, y: 5 };
    Object.defineProperty(point, coordinate, {
      get() {
        reads += 1;
        return reads <= 2 ? 5 : Number.NaN;
      },
    });

    const result = setWireWaypoints(document, "wire", [point]);
    if (!result.ok) { throw new Error(result.reason); }

    expect(reads).toBe(1);
    expect(result.document.wires[0]?.waypoints).toEqual([{ x: 5, y: 5 }]);
    expect(parseCircuitDocument(serializeCircuitDocument(result.document))).toEqual({ ok: true, document: result.document });
    expect(document).toEqual(before);
  });

  it("rejects a throwing waypoint count without changing the document", () => {
    const document: CircuitDocument = {
      title: "経由点数の読み取り例外",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      ],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 5, y: 5 }] }],
    };
    const before = structuredClone(document);
    let reads = 0;
    const waypoints = new Proxy([{ x: 3, y: 3 }], {
      get(target, key, receiver) {
        if (key === "length") { reads += 1; throw new Error("Invalid count"); }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(setWireWaypoints(document, "wire", waypoints)).toMatchObject({ ok: false });
    expect(reads).toBe(1);
    expect(document).toEqual(before);
  });
});
