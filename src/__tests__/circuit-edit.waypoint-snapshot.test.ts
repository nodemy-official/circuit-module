import { describe, expect, it } from "vitest";

import { setWireWaypoints } from "../circuit-edit.js";
import type { CircuitDocument } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

describe("wire waypoint snapshots", () => {
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
});
