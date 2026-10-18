import { describe, expect, it } from "vitest";
import { addPart, connectToPoint, findFreeSpot, reconnectWireToPoint, terminalAt } from "../circuit-edit.js";
import type { Point } from "../circuit-geometry.js";
import type { CircuitDocument } from "../circuit-model.js";
import { serializeCircuitDocument } from "../circuit-serialization.js";

function fixture(): CircuitDocument {
  return {
    title: "座標のスナップショット",
    parts: [
      { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
      { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      { id: "branch", kind: "junction", x: 5, y: 10, label: "枝" },
    ],
    wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } }],
  };
}

function changingPoint(x: number, y: number, coordinate: keyof Point) {
  let reads = 0;
  const point = { x, y };
  Object.defineProperty(point, coordinate, {
    get() { reads += 1; return reads === 1 ? coordinate === "x" ? x : y : Number.NaN; },
  });
  return { point, reads: () => reads };
}

describe("edit point snapshots", () => {
  it.each([null, undefined])("rejects a missing placement point (%s)", (point) => {
    expect(Reflect.apply(addPart, undefined, [fixture(), "resistor", point])).toMatchObject({ ok: false });
  });

  it.each(["x", "y"] as const)("places a part using its first %s coordinate", (coordinate) => {
    const document = fixture();
    const input = changingPoint(20, 20, coordinate);
    const result = addPart(document, "resistor", input.point);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.parts.at(-1)).toMatchObject({ x: 20, y: 20 });
    expect(input.reads()).toBe(1);
    expect(document).toEqual(fixture());
  });

  it.each(["x", "y"] as const)("keeps the original search center when its %s coordinate changes", (coordinate) => {
    const input = changingPoint(0, 0, coordinate);
    const document = fixture();
    expect(findFreeSpot(document, "resistor", input.point)).toEqual({ x: -2, y: -2 });
    expect(input.reads()).toBe(1);
    expect(document).toEqual(fixture());
  });

  it.each(["x", "y"] as const)("finds a terminal from one captured %s coordinate", (coordinate) => {
    const document = fixture();
    document.parts[1] = { ...document.parts[1]!, x: 0, y: 10 };
    const input = changingPoint(0, 10, coordinate);
    expect(terminalAt(document, input.point)).toEqual({ partId: "right", terminal: "a" });
    expect(input.reads()).toBe(1);
  });

  it.each((["connect", "reconnect"] as const).flatMap((operation) =>
    (["x", "y"] as const).map((coordinate) => ({ operation, coordinate })),
  ))("uses a single $coordinate coordinate for $operation", ({ operation, coordinate }) => {
    const document = fixture();
    const input = changingPoint(5, 0, coordinate);
    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, input.point)
      : reconnectWireToPoint(document, "wire", "to", input.point);
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.wires).toHaveLength(operation === "connect" ? 3 : 1);
    expect(result.document.parts.at(-1)).toMatchObject({ kind: "junction", x: 5, y: 0 });
    expect(input.reads()).toBe(1);
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(fixture());
  });
});
