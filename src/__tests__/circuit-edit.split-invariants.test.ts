import { describe, expect, it } from "vitest";

import { connectToPoint, reconnectWireToPoint } from "../circuit-edit.js";
import { rotate, routeDocumentWires } from "../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_WAYPOINTS, type CircuitDocument, type CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function crossingDocument(): CircuitDocument {
  return {
    title: "分割後の一意性",
    parts: [
      { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
      { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      { id: "tap", kind: "junction", x: 5, y: 0, label: "分岐" },
      { id: "branch", kind: "junction", x: 5, y: 8, label: "枝" },
      { id: "old", kind: "junction", x: 10, y: 8, label: "古い接続点" },
    ],
    wires: [
      { id: "crossed", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } },
      { id: "existing", from: { partId: "tap", terminal: "a" }, to: { partId: "left", terminal: "a" } },
    ],
  };
}

describe("wire split invariants", () => {
  it.each(([0, 90, 180, 270] as CircuitRotation[]).flatMap((rotation) =>
    [false, true].flatMap((reversed) => ["connect", "reconnect"].map((operation) => ({ rotation, reversed, operation }))),
  ))("preserves a split inside a terminal lead at $rotation degrees (reversed=$reversed, operation=$operation)", ({ rotation, reversed, operation }) => {
    const position = (x: number, y: number) => {
      const point = rotate({ x, y }, rotation);
      return { x: point.x || 0, y: point.y || 0 };
    };
    const source = { partId: "source", terminal: "b" as const };
    const target = { partId: "target", terminal: "a" as const };
    const document: CircuitDocument = {
      title: "短い端子リードの分割",
      parts: [
        { id: "source", kind: "resistor", x: 0, y: 0, rotation, label: "抵抗" },
        { id: "target", kind: "junction", ...position(10, 0), label: "終点" },
        { id: "branch", kind: "junction", ...position(0, 10), label: "枝" },
        { id: "old", kind: "junction", ...position(10, 10), label: "旧終点" },
      ],
      wires: [{ id: "crossed", from: reversed ? target : source, to: reversed ? source : target }],
    };
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    const point = position(2.5, 0);
    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, point)
      : reconnectWireToPoint(document, "edited", "to", point);
    if (!result.ok) { throw new Error(result.reason); }

    const first = result.document.wires.find((wire) => wire.id === "crossed")!;
    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === (reversed ? "source" : "target"))!;
    const routes = routeDocumentWires(result.document);
    expect(routes.get(first.id)).toEqual([position(reversed ? 10 : 2, 0), point]);
    expect(routes.get(second.id)).toEqual([point, position(reversed ? 2 : 10, 0)]);
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
  });

  it.each(["connect", "reconnect"] as const)("keeps later automatic wires detoured after an earlier wire is split with %s", (operation) => {
    const document: CircuitDocument = {
      title: "分割後も別ネットの迂回を保持",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
        { id: "inner-left", kind: "junction", x: 2, y: 0, label: "内左" },
        { id: "inner-right", kind: "junction", x: 8, y: 0, label: "内右" },
        { id: "branch", kind: "junction", x: 5, y: 5, label: "枝" },
        { id: "old", kind: "junction", x: 10, y: 5, label: "古い接続点" },
      ],
      wires: [
        { id: "crossed", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } },
        { id: "detoured", from: { partId: "inner-left", terminal: "a" }, to: { partId: "inner-right", terminal: "a" } },
      ],
    };
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    const original = routeDocumentWires(document).get("detoured");
    expect(original).toEqual([{ x: 2, y: 0 }, { x: 2, y: -1 }, { x: 8, y: -1 }, { x: 8, y: 0 }]);

    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, { x: 5, y: 0 })
      : reconnectWireToPoint(document, "edited", "to", { x: 5, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    const route = routeDocumentWires(result.document).get("detoured");
    if (!route) { throw new Error("Missing detoured route"); }
    expect(route[0]).toEqual({ x: 2, y: 0 });
    expect(route.at(-1)).toEqual({ x: 8, y: 0 });
    expect(route.slice(1).some((to, index) => {
      const from = route[index]!;
      return from.y === 0 && to.y === 0 &&
        Math.max(Math.min(from.x, to.x), 0) < Math.min(Math.max(from.x, to.x), 10);
    })).toBe(false);
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document).get("detoured")).toEqual(route);
  });

  it("splits a crossed wire when connecting another terminal of the same part", () => {
    const document: CircuitDocument = {
      title: "同一部品への接続と分岐",
      parts: [
        { id: "r", kind: "resistor", x: 0, y: 0, label: "R" },
        { id: "top", kind: "junction", x: 2, y: -10, label: "上" },
        { id: "bottom", kind: "junction", x: 2, y: 10, label: "下" },
      ],
      wires: [{ id: "crossed", from: { partId: "top", terminal: "a" }, to: { partId: "bottom", terminal: "a" } }],
    };
    expect(routeDocumentWires(document).get("crossed")).toEqual([{ x: 2, y: -10 }, { x: 2, y: 10 }]);

    const result = connectToPoint(document, { partId: "r", terminal: "a" }, { x: 2, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires).toContainEqual(expect.objectContaining({
      id: "crossed", from: { partId: "top", terminal: "a" }, to: { partId: "r", terminal: "b" },
    }));
    expect(result.document.wires).toContainEqual(expect.objectContaining({
      from: { partId: "r", terminal: "b" }, to: { partId: "bottom", terminal: "a" },
    }));
    expect(result.document.wires.find((wire) => wire.id === result.id)).toMatchObject({
      from: { partId: "r", terminal: "a" }, to: { partId: "r", terminal: "b" },
    });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document.wires).toHaveLength(1);
  });

  it.each(["junction", "resistor"] as const)("pins a straight first split segment after reserving an edited connection (%s)", (kind) => {
    const document: CircuitDocument = {
      title: "直線区間を保持",
      parts: [
        { id: "left", kind, x: kind === "junction" ? 0 : -2, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 30, y: 20, label: "右" },
        { id: "branch", kind: "junction", x: -40, y: -40, label: "枝" },
        { id: "old", kind: "junction", x: -40, y: -30, label: "古い接続点" },
      ],
      wires: [
        { id: "crossed", from: { partId: "left", terminal: kind === "junction" ? "a" : "b" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 15, y: 8 }] },
        { id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } },
      ],
    };
    const result = reconnectWireToPoint(document, "edited", "to", { x: 4, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(routeDocumentWires(result.document).get("crossed")).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document).get("crossed")).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  });

  it("pins a straight second split segment when the edited connection approaches along it", () => {
    const document: CircuitDocument = {
      title: "終端の直線区間を保持",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 30, y: 20, label: "右" },
        { id: "branch", kind: "junction", x: 60, y: 20, label: "枝" },
        { id: "old", kind: "junction", x: 60, y: 30, label: "古い接続点" },
      ],
      wires: [
        { id: "crossed", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 15, y: 8 }] },
        { id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } },
      ],
    };
    const result = reconnectWireToPoint(document, "edited", "to", { x: 26, y: 20 });
    if (!result.ok) { throw new Error(result.reason); }
    const second = result.document.wires.find((wire) => wire.to.partId === "right");
    if (!second) { throw new Error("Missing second segment"); }

    expect(routeDocumentWires(result.document).get(second.id)).toEqual([{ x: 26, y: 20 }, { x: 30, y: 20 }]);
  });

  it.each(["connect", "reconnect"] as const)("preserves a maximum-size manual route when splitting with %s", (operation) => {
    const document = crossingDocument();
    document.parts = [
      { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
      { id: "right", kind: "junction", x: 10_002, y: 10_002, label: "右" },
      { id: "branch", kind: "junction", x: 0, y: -10, label: "枝" },
      { id: "old", kind: "junction", x: 10, y: -10, label: "古い接続点" },
    ];
    document.wires = [{
      id: "crossed",
      from: { partId: "left", terminal: "a" },
      to: { partId: "right", terminal: "a" },
      waypoints: Array.from({ length: MAX_CIRCUIT_WIRE_WAYPOINTS }, (_, index) => ({ x: index + 1, y: index + 1 })),
    }];
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    expect(() => serializeCircuitDocument(document)).not.toThrow();
    const originalRoute = routeDocumentWires(document).get("crossed");
    const point = { x: 9999, y: 9999 };
    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, point)
      : reconnectWireToPoint(document, "edited", "to", point);
    if (!result.ok) { throw new Error(result.reason); }

    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === "right");
    if (!second) { throw new Error("Missing second segment"); }
    const routes = routeDocumentWires(result.document);
    const firstRoute = routes.get("crossed")!;
    const secondRoute = routes.get(second.id)!;
    expect([...firstRoute, ...secondRoute.slice(1)]).toEqual(originalRoute);
    expect(document.wires[0]?.waypoints).toHaveLength(MAX_CIRCUIT_WIRE_WAYPOINTS);
  });

  it("reuses an existing segment when a connection splits a wire at an existing terminal", () => {
    const document = crossingDocument();
    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, { x: 5, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires.find((wire) => wire.id === "existing")).toBe(document.wires[1]);
    expect(parseCircuitDocument(serializeCircuitDocument(result.document))).toEqual({ ok: true, document: result.document });
    expect(document.wires).toHaveLength(2);
  });

  it("returns the reused segment when the connection starts at that segment's other endpoint", () => {
    const result = connectToPoint(crossingDocument(), { partId: "left", terminal: "a" }, { x: 5, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.id).toBe("existing");
    expect(result.document.wires).toHaveLength(2);
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
  });

  it("preserves unique endpoint pairs when reconnecting another wire to a crossed terminal", () => {
    const document = crossingDocument();
    document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    const result = reconnectWireToPoint(document, "edited", "to", { x: 5, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires.find((wire) => wire.id === "edited")?.to).toEqual({ partId: "tap", terminal: "a" });
    expect(result.document.parts.some((part) => part.id === "old")).toBe(false);
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
  });

  it("keeps the edited wire when a new split segment would have the same endpoints", () => {
    const document = crossingDocument();
    document.wires = [document.wires[0]!, {
      id: "edited",
      from: { partId: "left", terminal: "a" },
      to: { partId: "old", terminal: "a" },
    }];
    const result = reconnectWireToPoint(document, "edited", "to", { x: 5, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.id).toBe("edited");
    expect(result.document.wires).toHaveLength(2);
    expect(result.document.wires.find((wire) => wire.id === "edited")?.to).toEqual({ partId: "tap", terminal: "a" });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
  });
});
