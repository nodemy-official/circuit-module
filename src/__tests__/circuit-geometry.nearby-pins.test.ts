import { describe, expect, it } from "vitest";

import { canPlace } from "../circuit-edit.js";
import { compactWireRouteWaypoints, rotate, routeDocumentWires, routeEnd, type Point } from "../circuit-geometry.js";
import type { CircuitDocument, CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function containsPoint(from: Point, to: Point, point: Point) {
  return from.x === to.x
    ? point.x === from.x && point.y >= Math.min(from.y, to.y) && point.y <= Math.max(from.y, to.y)
    : point.y === from.y && point.x >= Math.min(from.x, to.x) && point.x <= Math.max(from.x, to.x);
}

describe("nearby perpendicular component pins", () => {
  it.each(([0, 90, 180, 270] as CircuitRotation[]).flatMap((rotation) =>
    [false, true].flatMap((reversed) => [false, true].map((manual) => ({ rotation, reversed, manual }))),
  ))("keeps the destination out of an outward lead (rotation=$rotation, reversed=$reversed, manual=$manual)", ({ rotation, reversed, manual }) => {
    const position = (point: Point) => {
      const rotated = rotate(point, rotation);
      return { x: rotated.x + 10, y: rotated.y + 10 };
    };
    const ground = { id: "ground", kind: "ground" as const, ...position({ x: 0, y: 2 }), label: "GND", rotation };
    const resistor = { id: "resistor", kind: "resistor" as const, ...position({ x: 2, y: -1 }), label: "R", rotation };
    const first = { partId: ground.id, terminal: "a" as const };
    const last = { partId: resistor.id, terminal: "a" as const };
    const document: CircuitDocument = {
      title: "隣接する直交端子",
      parts: [ground, resistor],
      wires: [{
        id: "wire",
        from: reversed ? last : first,
        to: reversed ? first : last,
        ...(manual ? { waypoints: [position({ x: -3, y: -3 })] } : {}),
      }],
    };
    expect(canPlace(document, document.parts)).toBe(true);
    const start = routeEnd(reversed ? resistor : ground, "a");
    const end = routeEnd(reversed ? ground : resistor, "a");
    const route = routeDocumentWires(document).get("wire")!;
    expect(route[0]).toEqual(start.point);
    expect(route.at(-1)).toEqual(end.point);
    for (let index = 0; index < route.length - 1; index += 1) {
      const from = route[index]!;
      const to = route[index + 1]!;
      expect(from.x === to.x || from.y === to.y).toBe(true);
      if (index > 0) { expect(containsPoint(from, to, start.point)).toBe(false); }
      if (index < route.length - 2) { expect(containsPoint(from, to, end.point)).toBe(false); }
    }
    const next = route[1]!;
    const previous = route.at(-2)!;
    expect((next.x - start.point.x) * start.direction!.x + (next.y - start.point.y) * start.direction!.y).toBeGreaterThan(0);
    expect((previous.x - end.point.x) * end.direction!.x + (previous.y - end.point.y) * end.direction!.y).toBeGreaterThan(0);
    const restored = parseCircuitDocument(serializeCircuitDocument(document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document).get("wire")).toEqual(route);
    const waypoints = compactWireRouteWaypoints(route, start, end);
    const compacted = { ...document, wires: [{ ...document.wires[0]!, waypoints }] };
    expect(routeDocumentWires(compacted).get("wire")).toEqual(route);
  });
});
