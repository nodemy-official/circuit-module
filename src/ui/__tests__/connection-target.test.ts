import { describe, expect, it } from "vitest";
import { GRID } from "../../circuit-geometry.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { closestWirePoint, connectionTargetAt } from "../connection-target.js";

const empty: CircuitDocument = { title: "", parts: [], wires: [] };

describe("connection target snapping", () => {
  it("prefers a nearby terminal over a wire below it", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [{ id: "battery", kind: "battery", x: 2, y: 0, label: "電池" }],
      wires: [],
    };
    const routes = new Map([[
      "wire-1",
      [{ x: 0, y: 0 }, { x: 8, y: 0 }],
    ]] as const);

    const target = connectionTargetAt(document, routes, { x: 4, y: 0 }, 1);

    expect(target).toEqual({ point: { x: 4, y: 0 }, endpoint: { partId: "battery", terminal: "b" } });
  });

  it("projects onto grid cells on straight segments and at bends", () => {
    const route = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
    const routes = new Map([["wire-1", route]]);

    expect(closestWirePoint(route, { x: 2.7, y: 1.2 })).toEqual({ x: 3, y: 0 });
    expect(closestWirePoint(route, { x: 6.1, y: 3.6 })).toEqual({ x: 5, y: 4 });
    expect(connectionTargetAt(empty, routes, { x: 4.7, y: 0.4 }, 1)).toEqual({
      point: { x: 5, y: 0 },
      wireId: "wire-1",
    });
  });

  it("keeps the same screen-space snap radius as zoom changes", () => {
    const routes = new Map([["wire-1", [{ x: 0, y: 0 }, { x: 10, y: 0 }]]] as const);
    const pointer = { x: 4.4, y: 0.6 };
    const radiusAtZoom = (zoom: number) => 16 / (GRID * zoom);

    const atLowZoom = connectionTargetAt(empty, routes, pointer, radiusAtZoom(0.5));
    const atHighZoom = connectionTargetAt(empty, routes, pointer, radiusAtZoom(2));

    expect(atLowZoom.wireId).toBe("wire-1");
    expect(atHighZoom.wireId).toBeUndefined();
    expect(atHighZoom.point).toEqual({ x: 4, y: 1 });
  });

  it("ignores the wire being reconnected and can snap to another wire", () => {
    const routes = new Map([
      ["wire-1", [{ x: 0, y: 0 }, { x: 10, y: 0 }]],
      ["wire-2", [{ x: 0, y: 1 }, { x: 10, y: 1 }]],
    ] as const);

    const target = connectionTargetAt(empty, routes, { x: 4, y: 0 }, 2, "wire-1");

    expect(target).toEqual({ point: { x: 4, y: 1 }, wireId: "wire-2" });
  });

  it("returns the rounded grid point when every target is outside the radius", () => {
    const target = connectionTargetAt(empty, new Map(), { x: 7.2, y: -2.7 }, 0.5);

    expect(target).toEqual({ point: { x: 7, y: -3 } });
  });
});
