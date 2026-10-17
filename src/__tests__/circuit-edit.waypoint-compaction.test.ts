import { describe, expect, it } from "vitest";

import { connectToPoint, reconnectWireToPoint } from "../circuit-edit.js";
import { compactWireRouteWaypoints, rotate, routeDocumentWires, routeEnd } from "../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_WAYPOINTS, type CircuitDocument, type CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

describe("wire split waypoint compaction", () => {
  it.each(([0, 90, 180, 270] as CircuitRotation[]).flatMap((rotation) =>
    [false, true].map((reversed) => ({ rotation, reversed })),
  ))("pins a short straight route between facing terminals (rotation=$rotation, reversed=$reversed)", ({ rotation, reversed }) => {
    const position = (x: number) => {
      const point = rotate({ x, y: 0 }, rotation);
      return { x: point.x + 10, y: point.y + 10 };
    };
    const source = { id: "source", kind: "resistor" as const, ...position(0), rotation, label: "R1" };
    const target = { id: "target", kind: "resistor" as const, ...position(4.5), rotation, label: "R2" };
    const sourceEndpoint = { partId: source.id, terminal: "b" as const };
    const targetEndpoint = { partId: target.id, terminal: "a" as const };
    const start = reversed ? routeEnd(target, "a") : routeEnd(source, "b");
    const end = reversed ? routeEnd(source, "b") : routeEnd(target, "a");
    const route = [start.point, end.point];
    const waypoints = compactWireRouteWaypoints(route, start, end);
    const document: CircuitDocument = {
      title: "向かい合う短い端子リード",
      parts: [source, target, { id: "tap", kind: "junction", ...position(2.25), label: "J" }],
      wires: [
        { id: "occupied", from: sourceEndpoint, to: { partId: "tap", terminal: "a" } },
        { id: "wire", from: reversed ? targetEndpoint : sourceEndpoint, to: reversed ? sourceEndpoint : targetEndpoint, waypoints },
      ],
    };

    expect(waypoints.length).toBeGreaterThan(0);
    expect(routeDocumentWires(document).get("wire")).toEqual(route);
    const restored = parseCircuitDocument(serializeCircuitDocument(document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document).get("wire")).toEqual(route);
  });

  it.each([8, 4000])("keeps %s distant spans compact when an explicit pin anchor lies on a straight run", (spanCount) => {
    let seed = 123;
    let x = 0;
    let y = 5;
    const increment = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return seed % 7 + 2;
    };
    const distant = Array.from({ length: spanCount }, () => {
      x += increment();
      y += increment();
      return { x, y };
    });
    const document: CircuitDocument = {
      title: "明示端子の局所アンカーを保持",
      parts: [
        { id: "source", kind: "resistor", x: 0, y: 0, rotation: 180, label: "source" },
        { id: "target", kind: "resistor", x: x + 20, y: y + 20, label: "target" },
      ],
      wires: [{
        id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        waypoints: [
          { x: -2, y: -5 }, { x: -2, y: 0 }, { x: -2, y: 5 },
          ...distant,
        ],
      }],
    };
    const rendered = routeDocumentWires(document).get("wire");
    const editable = routeDocumentWires(document, { preserveWaypoints: true }).get("wire")!;
    const waypoints = compactWireRouteWaypoints(editable, routeEnd(document.parts[0]!, "b"), routeEnd(document.parts[1]!, "a"));
    expect(waypoints.length).toBeLessThanOrEqual(document.wires[0]!.waypoints!.length + 3);
    expect(waypoints.length).toBeLessThanOrEqual(MAX_CIRCUIT_WIRE_WAYPOINTS);
    const saved = { ...document, wires: [{ ...document.wires[0]!, waypoints }] };
    const restored = parseCircuitDocument(serializeCircuitDocument(saved));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document).get("wire")).toEqual(rendered);
  });

  it("retains hidden manual anchors without changing later automatic routes", () => {
    const document: CircuitDocument = {
      title: "描画経路と分割候補",
      parts: [
        { id: "a", kind: "junction", x: 0, y: 0, label: "A" },
        { id: "b", kind: "junction", x: 20, y: 6, label: "B" },
        { id: "c", kind: "junction", x: 4, y: 3, label: "C" },
        { id: "d", kind: "junction", x: 8, y: 3, label: "D" },
      ],
      wires: [
        { id: "manual", from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "a" }, waypoints: [{ x: 5, y: 3 }, { x: 13, y: 6 }] },
        { id: "automatic", from: { partId: "c", terminal: "a" }, to: { partId: "d", terminal: "a" } },
      ],
    };
    const rendered = routeDocumentWires(document);
    const editable = routeDocumentWires(document, { preserveWaypoints: true });
    expect(rendered.get("manual")).not.toContainEqual({ x: 5, y: 3 });
    expect(editable.get("manual")).toContainEqual({ x: 5, y: 3 });
    expect(editable.get("automatic")).toEqual(rendered.get("automatic"));
  });

  it("compacts long collinear anchor runs while preserving the following bends", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 10_010, y: 10 };
    const route = [
      from,
      ...Array.from({ length: MAX_CIRCUIT_WIRE_WAYPOINTS }, (_, index) => ({ x: index + 1, y: 0 })),
      { x: 10_000, y: 10 },
      to,
    ];
    const waypoints = compactWireRouteWaypoints(route, { point: from, direction: null }, { point: to, direction: null });
    const document: CircuitDocument = {
      title: "一直線の経由点",
      parts: [
        { id: "a", kind: "junction", ...from, label: "A" },
        { id: "b", kind: "junction", ...to, label: "B" },
      ],
      wires: [{ id: "wire", from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "a" }, waypoints }],
    };
    expect(waypoints.length).toBeLessThanOrEqual(3);
    expect(routeDocumentWires(document).get("wire")).toEqual([
      from, { x: 10_000, y: 0 }, { x: 10_000, y: 10 }, to,
    ]);
  });

  it("keeps an anchor when an implicit dog-leg would otherwise select automatic routing", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 10, y: 5 };
    const route = [from, { x: 5, y: 0 }, { x: 5, y: 5 }, to];
    const waypoints = compactWireRouteWaypoints(route, { point: from, direction: null }, { point: to, direction: null });
    const document: CircuitDocument = {
      title: "自動経路への誤変換を防ぐ",
      parts: [
        { id: "a", kind: "junction", ...from, label: "A" },
        { id: "b", kind: "junction", ...to, label: "B" },
        { id: "c", kind: "junction", x: 3, y: 0, label: "C" },
      ],
      wires: [
        { id: "occupied", from: { partId: "a", terminal: "a" }, to: { partId: "c", terminal: "a" } },
        { id: "wire", from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "a" }, waypoints },
      ],
    };
    expect(waypoints.length).toBeGreaterThan(0);
    expect(routeDocumentWires(document).get("wire")).toEqual(route);
  });

  it.each(["connect", "reconnect"] as const)("preserves an irregular maximum-size manual route when splitting with %s", (operation) => {
    let seed = 123;
    let x = 0;
    let y = 0;
    const increment = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return seed % 7 + 2;
    };
    const waypoints = Array.from({ length: MAX_CIRCUIT_WIRE_WAYPOINTS }, () => {
      x += increment();
      y += increment();
      return { x, y };
    });
    const document: CircuitDocument = {
      title: "不規則な経由点の分割",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: x + 10, y: y + 10, label: "右" },
        { id: "branch", kind: "junction", x: x + 6, y: y + 20, label: "枝" },
        { id: "old", kind: "junction", x: x + 20, y: y + 20, label: "旧接続先" },
      ],
      wires: [{
        id: "crossed",
        from: { partId: "left", terminal: "a" },
        to: { partId: "right", terminal: "a" },
        waypoints,
      }],
    };
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    expect(() => serializeCircuitDocument(document)).not.toThrow();
    const original = routeDocumentWires(document).get("crossed")!;
    const beforeEnd = original.at(-2)!;
    const point = { x: beforeEnd.x + 1, y: beforeEnd.y };

    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, point)
      : reconnectWireToPoint(document, "edited", "to", point);
    if (!result.ok) { throw new Error(result.reason); }

    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === "right")!;
    const routes = routeDocumentWires(result.document);
    expect(routes.get("crossed")).toEqual([...original.slice(0, -1), point]);
    expect(routes.get(second.id)).toEqual([point, original.at(-1)]);
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
    expect(document.wires[0]?.waypoints).toHaveLength(MAX_CIRCUIT_WIRE_WAYPOINTS);
  });
});
