import { describe, expect, it } from "vitest";

import {
  contentBounds,
  footprint,
  localTerminalOffset,
  moveWireSegment,
  routeWire,
  routeDocumentWires,
  terminalDirection,
  terminalPoint,
  type Point,
} from "../circuit-geometry.js";
import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function part(kind: CircuitPartKind, rotation: CircuitPart["rotation"] = 0): CircuitPart {
  return { id: kind, kind, x: 10, y: 10, label: kind, rotation };
}

describe("feedback routing", () => {
  it.each([0, 90, 180, 270] as CircuitRotation[])("routes a two-terminal bypass outside its body at %s degrees", (rotation) => {
    const resistor = part("resistor", rotation);
    const route = routeDocumentWires({ title: "bypass", parts: [resistor], wires: [
      { id: "bypass", from: { partId: resistor.id, terminal: "a" }, to: { partId: resistor.id, terminal: "b" } },
    ] }).get("bypass");
    if (!route) { throw new Error("Missing bypass route"); }
    const bounds = footprint(resistor);
    expect(route[0]).toEqual(terminalPoint(resistor, "a"));
    expect(route.at(-1)).toEqual(terminalPoint(resistor, "b"));
    expect(route.slice(1).some((to, index) => {
      const from = route[index];
      return from.y === to.y
        ? from.y > bounds.minY && from.y < bounds.maxY &&
          Math.max(from.x, to.x) > bounds.minX && Math.min(from.x, to.x) < bounds.maxX
        : from.x > bounds.minX && from.x < bounds.maxX &&
          Math.max(from.y, to.y) > bounds.minY && Math.min(from.y, to.y) < bounds.maxY;
    })).toBe(false);
  });

  it.each([0, 90, 180, 270] as CircuitRotation[])("routes an op-amp's tied pins outside its body at %s degrees", (rotation) => {
    const opamp = part("op-amp", rotation);
    const route = routeDocumentWires({ title: "feedback", parts: [opamp], wires: [
      { id: "feedback", from: { partId: opamp.id, terminal: "c" }, to: { partId: opamp.id, terminal: "b" } },
    ] }).get("feedback");
    if (!route) { throw new Error("Missing feedback route"); }
    expect(route[0]).toEqual(terminalPoint(opamp, "c"));
    expect(route.at(-1)).toEqual(terminalPoint(opamp, "b"));
    const bounds = footprint(opamp);
    const crossesBody = route.slice(1).some((to, index) => {
      const from = route[index];
      const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      return middle.x > bounds.minX && middle.x < bounds.maxX && middle.y > bounds.minY && middle.y < bounds.maxY;
    });
    expect(crossesBody).toBe(false);
  });
});

function segmentsOverlap(first: readonly Point[], second: readonly Point[]) {
  for (let firstIndex = 0; firstIndex < first.length - 1; firstIndex += 1) {
    const a = first[firstIndex];
    const b = first[firstIndex + 1];
    if (!a || !b) { continue; }
    for (let secondIndex = 0; secondIndex < second.length - 1; secondIndex += 1) {
      const c = second[secondIndex];
      const d = second[secondIndex + 1];
      if (!c || !d) { continue; }

      const horizontalOverlap =
        a.y === b.y && c.y === d.y && a.y === c.y &&
        Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <
          Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
      const verticalOverlap =
        a.x === b.x && c.x === d.x && a.x === c.x &&
        Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <
          Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));

      if (horizontalOverlap || verticalOverlap) { return true; }
    }
  }
  return false;
}

function hasInteriorCrossing(first: readonly Point[], second: readonly Point[], crossing: Point) {
  for (let firstIndex = 0; firstIndex < first.length - 1; firstIndex += 1) {
    const a = first[firstIndex];
    const b = first[firstIndex + 1];
    if (!a || !b) { continue; }
    for (let secondIndex = 0; secondIndex < second.length - 1; secondIndex += 1) {
      const c = second[secondIndex];
      const d = second[secondIndex + 1];
      if (!c || !d) { continue; }

      const firstHorizontal = a.y === b.y;
      const secondHorizontal = c.y === d.y;
      if (firstHorizontal === secondHorizontal) { continue; }
      const horizontal = firstHorizontal ? [a, b] : [c, d];
      const vertical = firstHorizontal ? [c, d] : [a, b];
      const horizontalStart = horizontal[0] as Point;
      const horizontalEnd = horizontal[1] as Point;
      const verticalStart = vertical[0] as Point;
      const verticalEnd = vertical[1] as Point;
      if (
        crossing.x > Math.min(horizontalStart.x, horizontalEnd.x) &&
        crossing.x < Math.max(horizontalStart.x, horizontalEnd.x) &&
        crossing.y > Math.min(verticalStart.y, verticalEnd.y) &&
        crossing.y < Math.max(verticalStart.y, verticalEnd.y) &&
        crossing.y === horizontalStart.y &&
        crossing.x === verticalStart.x
      ) {
        return true;
      }
    }
  }
  return false;
}

describe("routeWire", () => {
  it("routes a valid billion-cell wire alongside another wire without expanding every cell", () => {
    const document: CircuitDocument = { title: "large coordinates", parts: [
      { id: "a", kind: "junction", x: 0, y: 0, label: "A" },
      { id: "b", kind: "junction", x: 1e9, y: 0, label: "B" },
      { id: "c", kind: "junction", x: 0, y: 10, label: "C" },
      { id: "d", kind: "junction", x: 10, y: 10, label: "D" },
    ], wires: [
      { id: "long", from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "a" } },
      { id: "short", from: { partId: "c", terminal: "a" }, to: { partId: "d", terminal: "a" } },
    ] };
    expect(parseCircuitDocument(serializeCircuitDocument(document)).ok).toBe(true);
    const routes = routeDocumentWires(document);
    expect(routes.get("long")).toEqual([{ x: 0, y: 0 }, { x: 1e9, y: 0 }]);
    expect(routes.get("short")).toEqual([{ x: 0, y: 10 }, { x: 10, y: 10 }]);
  }, 1000);

  it("finds a detour across a billion-cell occupied span with fixed endpoint coordinates", () => {
    const existing = [{ x: 3, y: 0 }, { x: 1e9 - 3, y: 0 }];
    const route = routeWire(
      { point: { x: 0, y: 0 }, direction: null },
      { point: { x: 1e9, y: 0 }, direction: null },
      [existing],
    );
    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(route.at(-1)).toEqual({ x: 1e9, y: 0 });
    expect(segmentsOverlap(route, existing)).toBe(false);
    expect(route.length).toBeLessThan(10);
  }, 1000);

  it.each([
    [{ x: -2, y: 0 }, { x: 8, y: 0 }, { x: -1, y: 0 }],
    [{ x: 2, y: 0 }, { x: -8, y: 0 }, { x: 1, y: 0 }],
    [{ x: 0, y: -2 }, { x: 0, y: 8 }, { x: 0, y: -1 }],
    [{ x: 0, y: 2 }, { x: 0, y: -8 }, { x: 0, y: 1 }],
  ])("keeps outward leads without retracing them when the other terminal is behind (%j)", (start, end, direction) => {
    const route = routeWire({ point: start, direction }, { point: end, direction });
    const next = route[1];
    const previous = route.at(-2);
    if (!next || !previous) { throw new Error("Missing terminal leads"); }
    expect((next.x - start.x) * direction.x + (next.y - start.y) * direction.y).toBeGreaterThan(0);
    expect((previous.x - end.x) * direction.x + (previous.y - end.y) * direction.y).toBeGreaterThan(0);
    expect(segmentsOverlap(route.slice(1), [start, { x: start.x + direction.x, y: start.y + direction.y }])).toBe(false);
    expect(segmentsOverlap(route.slice(0, -1), [end, { x: end.x + direction.x, y: end.y + direction.y }])).toBe(false);
  });

  it.each([false, true])("avoids partial overlaps on fractional coordinates (vertical=%s)", (vertical) => {
    const point = (along: number): Point => vertical ? { x: 0.1, y: along } : { x: along, y: 0.1 };
    const existing = [point(0.1), point(10.1)];
    const route = routeWire(
      { point: point(0.3), direction: null },
      { point: point(10.3), direction: null },
      [existing],
    );
    expect(route[0]).toEqual(point(0.3));
    expect(route.at(-1)).toEqual(point(10.3));
    expect(segmentsOverlap(route, existing)).toBe(false);
    expect(route.every((from, index) => {
      const to = route[index + 1];
      return !to || from.x === to.x || from.y === to.y;
    })).toBe(true);
  });

  it("avoids sharing a positive-length segment with an existing wire", () => {
    const existing = [{ x: 3, y: 0 }, { x: 7, y: 0 }];
    const route = routeWire(
      { point: { x: 0, y: 0 }, direction: null },
      { point: { x: 10, y: 0 }, direction: null },
      [existing],
    );

    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(route.at(-1)).toEqual({ x: 10, y: 0 });
    expect(segmentsOverlap(route, existing)).toBe(false);
  });

  it("allows a new wire to cross an existing wire at a point", () => {
    const existing = [{ x: 5, y: -5 }, { x: 5, y: 5 }];
    const route = routeWire(
      { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
      { point: { x: 10, y: 0 }, direction: { x: -1, y: 0 } },
      [existing],
    );

    expect(hasInteriorCrossing(route, existing, { x: 5, y: 0 })).toBe(true);
    expect(segmentsOverlap(route, existing)).toBe(false);
  });

  it("avoids multiple existing wires", () => {
    const existing = [
      [{ x: 2, y: 0 }, { x: 4, y: 0 }],
      [{ x: 6, y: 0 }, { x: 8, y: 0 }],
    ];
    const route = routeWire(
      { point: { x: 0, y: 0 }, direction: null },
      { point: { x: 10, y: 0 }, direction: null },
      existing,
    );

    expect(existing.every((occupied) => !segmentsOverlap(route, occupied))).toBe(true);
  });
});

describe("manual wire routing", () => {
  const isOrthogonal = (route: readonly Point[]) => route.every((first, index) => {
    const second = route[index + 1];
    return !second || first.x === second.x || first.y === second.y;
  });

  it("moves a middle segment perpendicular to its orientation", () => {
    const route = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 5 },
      { x: 8, y: 5 },
      { x: 8, y: 0 },
      { x: 10, y: 0 },
    ];

    const movedHorizontal = moveWireSegment(route, 2, 7);
    const movedVertical = moveWireSegment(route, 1, 5);

    expect(movedHorizontal[0]).toEqual(route[0]);
    expect(movedHorizontal.at(-1)).toEqual(route.at(-1));
    expect(movedHorizontal).toContainEqual({ x: 8, y: 7 });
    expect(isOrthogonal(movedHorizontal)).toBe(true);
    expect(movedVertical).toContainEqual({ x: 5, y: 0 });
    expect(movedVertical).toContainEqual({ x: 5, y: 5 });
    expect(isOrthogonal(movedVertical)).toBe(true);
  });

  it("moves the first and last segments while preserving terminal stubs", () => {
    const route = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const start = { point: route[0] as Point, direction: { x: 1, y: 0 } };
    const end = { point: route[1] as Point, direction: { x: -1, y: 0 } };

    const moved = moveWireSegment(route, 0, 3, start, end);

    expect(moved[0]).toEqual(start.point);
    expect(moved.at(-1)).toEqual(end.point);
    expect(moved[1]).toEqual({ x: 1, y: 0 });
    expect(moved.at(-2)).toEqual({ x: 9, y: 0 });
    expect(moved).toContainEqual({ x: 1, y: 3 });
    expect(moved).toContainEqual({ x: 9, y: 3 });
    expect(isOrthogonal(moved)).toBe(true);
  });

  it("creates a movable dog-leg for a one-segment junction wire", () => {
    const route = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
    const moved = moveWireSegment(route, 0, 2);

    expect(moved[0]).toEqual(route[0]);
    expect(moved.at(-1)).toEqual(route.at(-1));
    expect(moved).toContainEqual({ x: 0, y: 2 });
    expect(moved).toContainEqual({ x: 5, y: 2 });
    expect(isOrthogonal(moved)).toBe(true);
  });

  it("uses persisted waypoints as an orthogonal route and follows moved part endpoints", () => {
    const document = {
      title: "manual route",
      parts: [
        { id: "left", kind: "junction" as const, x: 0, y: 0, label: "left" },
        { id: "right", kind: "junction" as const, x: 10, y: 5, label: "right" },
      ],
      wires: [{
        id: "wire",
        from: { partId: "left", terminal: "a" as const },
        to: { partId: "right", terminal: "a" as const },
        waypoints: [{ x: 3, y: 0 }, { x: 3, y: 5 }],
      }],
    };
    const route = routeDocumentWires(document).get("wire");
    if (!route) { throw new Error("Missing manual route"); }
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 5 },
      { x: 10, y: 5 },
    ]);

    const movedEndpoint = routeDocumentWires({
      ...document,
      parts: document.parts.map((item) => item.id === "left" ? { ...item, x: 1, y: 1 } : item),
    }).get("wire");
    if (!movedEndpoint) { throw new Error("Missing moved route"); }
    expect(movedEndpoint[0]).toEqual({ x: 1, y: 1 });
    expect(movedEndpoint.at(-1)).toEqual({ x: 10, y: 5 });
    expect(isOrthogonal(movedEndpoint)).toBe(true);
  });

  it("includes manual route points in the board content bounds", () => {
    const bounds = contentBounds({
      title: "wide manual route",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "left" },
        { id: "right", kind: "junction", x: 10, y: 5, label: "right" },
      ],
      wires: [{
        id: "wire",
        from: { partId: "left", terminal: "a" },
        to: { partId: "right", terminal: "a" },
        waypoints: [{ x: -20, y: 30 }],
      }],
    });

    expect(bounds?.minX).toBe(-20);
    expect(bounds?.maxY).toBe(30);
  });

  it("keeps a terminal's outward stub when a moved segment folds behind the terminal", () => {
    const original = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 5 },
    ];
    const start = { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };
    const moved = moveWireSegment(original, 2, -1, start, { point: { x: 10, y: 5 }, direction: null });
    const document = {
      title: "端子のstub",
      parts: [
        { id: "source", kind: "resistor" as const, x: -2, y: 0, label: "抵抗" },
        { id: "target", kind: "junction" as const, x: 10, y: 5, label: "接続点" },
      ],
      wires: [{
        id: "wire",
        from: { partId: "source", terminal: "b" as const },
        to: { partId: "target", terminal: "a" as const },
        waypoints: moved.slice(1, -1),
      }],
    };
    const route = routeDocumentWires(document).get("wire");

    expect(route?.[0]).toEqual({ x: 0, y: 0 });
    expect(route?.[1]).toEqual({ x: 1, y: 0 });
    expect(segmentsOverlap(route?.slice(1) ?? [], [{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(false);
    expect(isOrthogonal(route ?? [])).toBe(true);
  });

  it("uses an outward L-shaped lead when a manual waypoint is diagonally behind a terminal", () => {
    const document = {
      title: "斜め後方の手動経路",
      parts: [
        { id: "source", kind: "resistor" as const, x: -2, y: 0, label: "抵抗" },
        { id: "target", kind: "junction" as const, x: -5, y: 5, label: "接続点" },
      ],
      wires: [{
        id: "wire",
        from: { partId: "source", terminal: "b" as const },
        to: { partId: "target", terminal: "a" as const },
        waypoints: [{ x: -5, y: 1 }],
      }],
    };
    const route = routeDocumentWires(document).get("wire");

    expect(route?.slice(0, 3)).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 },
    ]);
    expect(segmentsOverlap(route?.slice(1) ?? [], [{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(false);
    expect(isOrthogonal(route ?? [])).toBe(true);
  });

  it("removes same-direction collinear stub points from an ordinary manual route", () => {
    const document = {
      title: "通常の手動経路",
      parts: [
        { id: "source", kind: "resistor" as const, x: -2, y: 0, label: "抵抗" },
        { id: "target", kind: "junction" as const, x: 10, y: 5, label: "接続点" },
      ],
      wires: [{
        id: "wire",
        from: { partId: "source", terminal: "b" as const },
        to: { partId: "target", terminal: "a" as const },
        waypoints: [{ x: 3, y: 0 }, { x: 3, y: 5 }],
      }],
    };

    expect(routeDocumentWires(document).get("wire")).toEqual([
      { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }, { x: 10, y: 5 },
    ]);
  });
});

describe("multi-terminal part geometry", () => {
  it.each([
    ["potentiometer", "a", { x: -2, y: 0 }],
    ["potentiometer", "b", { x: 2, y: 0 }],
    ["potentiometer", "c", { x: 0, y: -2 }],
    ["npn-transistor", "a", { x: 0, y: -2 }],
    ["npn-transistor", "b", { x: -2, y: 0 }],
    ["npn-transistor", "c", { x: 0, y: 2 }],
    ["nmos", "a", { x: 0, y: -2 }],
    ["nmos", "b", { x: -2, y: 0 }],
    ["nmos", "c", { x: 0, y: 2 }],
    ["op-amp", "a", { x: -2, y: -1 }],
    ["op-amp", "b", { x: -2, y: 1 }],
    ["op-amp", "c", { x: 2, y: 0 }],
    ["ground", "a", { x: 0, y: -2 }],
  ] as const)("places %s terminal %s at its symbol pin", (kind, pin, offset) => {
    expect(localTerminalOffset(kind, pin)).toEqual(offset);
    expect(terminalPoint(part(kind), pin)).toEqual({ x: 10 + offset.x, y: 10 + offset.y });
  });

  it("rotates three-terminal pins and their wire-leaving directions together", () => {
    const transistor = part("npn-transistor", 90);
    expect(terminalPoint(transistor, "a")).toEqual({ x: 12, y: 10 });
    expect(terminalPoint(transistor, "b")).toEqual({ x: 10, y: 8 });
    expect(terminalPoint(transistor, "c")).toEqual({ x: 8, y: 10 });
    expect(terminalDirection(transistor, "a")).toEqual({ x: 1, y: 0 });
    expect(terminalDirection(transistor, "b")).toEqual({ x: 0, y: -1 });
    expect(terminalDirection(transistor, "c")).toEqual({ x: -1, y: 0 });
  });

  it("keeps three-terminal footprints square and rotates the ground footprint", () => {
    expect(footprint(part("potentiometer"))).toEqual({ minX: 8, minY: 8, maxX: 12, maxY: 12 });
    expect(footprint(part("op-amp", 90))).toEqual({ minX: 8, minY: 8, maxX: 12, maxY: 12 });
    expect(footprint(part("ground"))).toEqual({ minX: 9, minY: 8, maxX: 11, maxY: 11 });
    expect(footprint(part("ground", 90))).toEqual({ minX: 9, minY: 9, maxX: 12, maxY: 11 });
  });
});
