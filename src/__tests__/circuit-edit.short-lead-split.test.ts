import { describe, expect, it } from "vitest";

import { canPlace, connectToPoint, reconnectWireToPoint } from "../circuit-edit.js";
import { compactWireRouteWaypoints, rotate, routeDocumentWires, routeEnd, type Point } from "../circuit-geometry.js";
import type { CircuitDocument, CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function containsPoint(from: Point, to: Point, point: Point) {
  return from.x === to.x
    ? point.x === from.x && point.y >= Math.min(from.y, to.y) && point.y <= Math.max(from.y, to.y)
    : point.y === from.y && point.x >= Math.min(from.x, to.x) && point.x <= Math.max(from.x, to.x);
}

describe("splitting a route with a shortened terminal lead", () => {
  it.each(([0, 90, 180, 270] as CircuitRotation[]).flatMap((rotation) =>
    [false, true].flatMap((reversed) => ["connect", "reconnect"].map((operation) => ({ rotation, reversed, operation }))),
  ))("preserves the remote short lead (rotation=$rotation, reversed=$reversed, operation=$operation)", ({ rotation, reversed, operation }) => {
    const position = (x: number, y: number) => {
      const point = rotate({ x, y }, rotation);
      return { x: point.x || 0, y: point.y || 0 };
    };
    const source = { partId: "source", terminal: "a" as const };
    const target = { partId: "target", terminal: "a" as const };
    const document: CircuitDocument = {
      title: "短い端子リードを離れた分割後も保持",
      parts: [
        { id: "source", kind: "resistor", ...position(0, 0), rotation, label: "R" },
        { id: "target", kind: "ground", ...position(-3, 2), rotation, label: "GND" },
        { id: "branch", kind: "junction", ...position(10, 10), label: "枝" },
        { id: "old", kind: "junction", ...position(15, 10), label: "旧接続先" },
      ],
      wires: [{ id: "crossed", from: reversed ? target : source, to: reversed ? source : target }],
    };
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    expect(canPlace(document, document.parts)).toBe(true);
    const original = [position(-2, 0), position(-2.5, 0), position(-2.5, -1), position(-3, -1), position(-3, 0)];
    expect(routeDocumentWires(document).get("crossed")).toEqual(reversed ? [...original].reverse() : original);

    const point = position(-3, -1);
    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, point)
      : reconnectWireToPoint(document, "edited", "to", point);
    if (!result.ok) { throw new Error(result.reason); }
    const first = result.document.wires.find((wire) => wire.id === "crossed")!;
    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === (reversed ? "source" : "target"))!;
    const routes = routeDocumentWires(result.document);
    const firstRoute = reversed ? original.slice(3).reverse() : original.slice(0, 4);
    const secondRoute = reversed ? original.slice(0, 4).reverse() : original.slice(3);
    expect(routes.get(first.id)).toEqual(firstRoute);
    expect(routes.get(second.id)).toEqual(secondRoute);

    // The resistor-side segment must not touch the old GND terminal after splitting.
    const resistorRoute = routes.get(reversed ? second.id : first.id)!;
    expect(resistorRoute.some((from, index) => {
      const to = resistorRoute[index + 1];
      return to && containsPoint(from, to, position(-3, 0));
    })).toBe(false);

    const parts = new Map(result.document.parts.map((part) => [part.id, part]));
    const compacted = {
      ...result.document,
      wires: result.document.wires.map((wire) => ({
        ...wire,
        waypoints: compactWireRouteWaypoints(routes.get(wire.id)!, routeEnd(parts.get(wire.from.partId)!, wire.from.terminal), routeEnd(parts.get(wire.to.partId)!, wire.to.terminal)),
      })),
    };
    expect(routeDocumentWires(compacted)).toEqual(routes);
    const restored = parseCircuitDocument(serializeCircuitDocument(compacted));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
  });
});
