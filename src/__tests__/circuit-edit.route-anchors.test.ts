import { describe, expect, it } from "vitest";

import {
  canPlace, connectToPoint, copyFragment, moveParts, pasteFragment, reconnectWire,
  reconnectWireToPoint, repairWireRoutes, rotateParts, setWireRoute, setWireWaypoints,
} from "../circuit-edit.js";
import { decodeWireRouteAnchors, encodeWireRouteAnchors, MAX_WIRE_COORDINATE, rotate, routeDocumentWires, terminalPoint, type Point } from "../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_ROUTE_ANCHORS, type CircuitDocument, type CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function occupiedBoundaryDocument(rotation: CircuitRotation = 0, reversed = false): CircuitDocument {
  const position = (x: number, y: number) => {
    const point = rotate({ x, y }, rotation);
    return { x: point.x || 0, y: point.y || 0 };
  };
  const wire = (index: number) => ({
    id: `wire-${index}`,
    from: { partId: `source-${index}`, terminal: "b" as const },
    to: { partId: `target-${index}`, terminal: "a" as const },
  });
  const parts = [0, 1, 2].map((index) => ({
    id: `source-${index}`, kind: "resistor" as const, ...position(index * 10, MAX_WIRE_COORDINATE),
    rotation: ((90 + rotation) % 360) as CircuitRotation, label: `R${index}`,
  }));
  const third = wire(2);
  return {
    title: "既存導線で長くなった境界リード",
    parts: [
      ...parts,
      { id: "target-0", kind: "junction", ...position(30, MAX_WIRE_COORDINATE - 10), label: "J0" },
      { id: "target-1", kind: "junction", ...position(-20, MAX_WIRE_COORDINATE - 60), label: "J1" },
      { id: "target-2", kind: "junction", ...position(30, MAX_WIRE_COORDINATE - 60), label: "J2" },
      { id: "branch", kind: "junction", ...position(0, MAX_WIRE_COORDINATE - 100), label: "枝" },
      { id: "old", kind: "junction", ...position(10, MAX_WIRE_COORDINATE - 100), label: "旧接続先" },
    ],
    wires: [wire(0), wire(1), reversed ? { ...third, from: third.to, to: third.from } : third],
  };
}

function splitBoundaryDocument() {
  const document = occupiedBoundaryDocument();
  const result = connectToPoint(document, { partId: "branch", terminal: "a" }, { x: 29.5, y: MAX_WIRE_COORDINATE - 60 });
  if (!result.ok) { throw new Error(result.reason); }
  return result.document;
}

function finishedRouteIssues(document: CircuitDocument, id: string) {
  const wire = document.wires.find((item) => item.id === id)!;
  const route = routeDocumentWires(document).get(id)!;
  const from = terminalPoint(document.parts.find((part) => part.id === wire.from.partId)!, wire.from.terminal);
  const to = terminalPoint(document.parts.find((part) => part.id === wire.to.partId)!, wire.to.terminal);
  const issues: string[] = [];
  if (route[0]?.x !== from.x || route[0]?.y !== from.y) { issues.push("wrong start terminal"); }
  if (route.at(-1)?.x !== to.x || route.at(-1)?.y !== to.y) { issues.push("wrong end terminal"); }
  if (!route.every((point, index) => !route[index + 1] || point.x === route[index + 1]!.x || point.y === route[index + 1]!.y)) {
    issues.push("diagonal segment");
  }
  const restored = parseCircuitDocument(serializeCircuitDocument(document));
  if (!restored.ok) { throw new Error(restored.reason); }
  if (JSON.stringify(routeDocumentWires(restored.document).get(id)) !== JSON.stringify(route)) { issues.push("changed after save"); }
  return issues;
}

describe("generated route anchors", () => {
  it("keeps a rigid fractional move orthogonal when terminal arithmetic rounds differently", () => {
    const document: CircuitDocument = {
      title: "端数座標の平行移動",
      parts: [
        { id: "source", kind: "resistor", x: 0.01, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 10.01, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, routeAnchors: [{ x: 2.01, y: 1 }, { x: 10.01, y: 1 }] }],
    };
    const before = serializeCircuitDocument(document);
    const result = moveParts(document, ["source", "target"], 0.03, 0);
    if (!result.ok) { throw new Error(result.reason); }
    expect(finishedRouteIssues(result.document, "wire")).toEqual([]);
    expect(routeDocumentWires(result.document).get("wire")).toEqual([
      { x: 2.04, y: 0 }, { x: 2.04, y: 1 }, { x: 10.04, y: 1 }, { x: 10.04, y: 10 },
    ]);
    expect(result.document.wires[0]!.routeAnchors).toHaveLength(2);
    expect(serializeCircuitDocument(document)).toBe(before);
  });

  it("repairs fractional pin alignment when pasting at the second available offset", () => {
    const document: CircuitDocument = {
      title: "端数座標の貼り付け",
      parts: [
        { id: "source", kind: "resistor", x: 0.0002, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 10.0002, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, routeAnchors: [{ x: 2.0002, y: 1 }, { x: 10.0002, y: 1 }] }],
    };
    const target: CircuitDocument = { title: "貼付先", parts: [{ id: "blocked", kind: "resistor", x: 2.0002, y: 2, label: "障害物" }], wires: [] };
    const fragment = copyFragment(document, { parts: ["source", "target"], wires: [] });
    const result = pasteFragment(target, fragment);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.parts.find((part) => part.id === result.selection.parts[0])?.x).toBe(4.0002);
    expect(finishedRouteIssues(result.document, result.selection.wires[0]!)).toEqual([]);
    expect(routeDocumentWires(result.document).get(result.selection.wires[0]!)).toEqual([
      { x: 6.0002, y: 4 }, { x: 6.0002, y: 5 }, { x: 14.0002, y: 5 }, { x: 14.0002, y: 14 },
    ]);
    expect(result.document.wires[0]!.routeAnchors).toHaveLength(2);
    expect(target.wires).toEqual([]);
  });

  it("keeps a nonzero one-ulp connection when formerly aligned pins translate to different axes", () => {
    const document: CircuitDocument = {
      title: "平行移動で分かれる端子軸",
      parts: [
        { id: "source", kind: "resistor", x: 0.01, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 2.01, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, routeAnchors: [{ x: 2.01, y: 1 }, { x: 2.01, y: 9 }] }],
    };
    const result = moveParts(document, ["source", "target"], 0.03, 0);
    if (!result.ok) { throw new Error(result.reason); }
    expect(routeDocumentWires(result.document).get("wire")).toEqual([
      { x: 2.04, y: 0 }, { x: 2.04, y: 1 }, { x: 2.039_999_999_999_999_6, y: 1 }, { x: 2.039_999_999_999_999_6, y: 10 },
    ]);
    expect(result.document.wires[0]!.routeAnchors).toHaveLength(3);
    expect(finishedRouteIssues(result.document, "wire")).toEqual([]);
  });

  it("repairs explicit terminal connections after an external part geometry update", () => {
    const document: CircuitDocument = {
      title: "外部の部品編集",
      parts: [
        { id: "source", kind: "resistor", x: 2, y: 1, label: "R" },
        { id: "target", kind: "junction", x: 10, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, routeAnchors: [{ x: 3, y: 0 }, { x: 3, y: 10 }] }],
    };
    const original = structuredClone(document);
    const result = repairWireRoutes(document, ["source"]);
    if (!result.ok) { throw new Error(result.reason); }
    expect(finishedRouteIssues(result.document, "wire")).toEqual([]);
    expect(document).toEqual(original);
  });

  it("keeps an existing explicit inward pin visit literal when restoring the same anchors", () => {
    const document: CircuitDocument = {
      title: "明示した逆向き経路",
      parts: [
        { id: "source", kind: "resistor", x: 0, y: 0, label: "R" },
        { id: "target", kind: "junction", x: -10, y: 0, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, routeAnchors: [{ x: -5, y: 0 }] }],
    };
    const before = routeDocumentWires(document);
    expect(before.get("wire")).toEqual([{ x: 2, y: 0 }, { x: -10, y: 0 }]);
    const result = setWireRoute(document, "wire", decodeWireRouteAnchors(document.wires[0]!.routeAnchors!));
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document).toBe(document);
    expect(routeDocumentWires(result.document)).toEqual(before);
    expect(finishedRouteIssues(result.document, "wire")).toEqual([]);
    const moved = moveParts(document, ["source", "target"], 2, 3);
    if (!moved.ok) { throw new Error(moved.reason); }
    expect(routeDocumentWires(moved.document).get("wire")).toEqual([{ x: 4, y: 3 }, { x: -8, y: 3 }]);
    expect(finishedRouteIssues(moved.document, "wire")).toEqual([]);
  });

  it("saves an ordinary completed route as legacy waypoints when replay is exact", () => {
    const document: CircuitDocument = {
      title: "通常の導線調整",
      parts: [
        { id: "source", kind: "resistor", x: 0, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 10, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" } }],
    };
    const result = setWireRoute(document, "wire", [{ x: 3, y: 0 }, { x: 3, y: 10 }]);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]!.waypoints?.length).toBeGreaterThan(0);
    expect(result.document.wires[0]).not.toHaveProperty("routeAnchors");
    expect(routeDocumentWires(result.document).get("wire")).toEqual([{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 10 }, { x: 10, y: 10 }]);
    expect(JSON.parse(serializeCircuitDocument(result.document)).version).toBe(1);
    expect(finishedRouteIssues(result.document, "wire")).toEqual([]);
  });

  it.each([false, true])("retains implicit pin avoidance for a legacy wire (manual=%s)", (manual) => {
    const document: CircuitDocument = {
      title: "旧経由点の端子回避",
      parts: [
        { id: "source", kind: "resistor", x: 0, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 10, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, ...(manual ? { waypoints: [{ x: 3, y: 5 }] } : {}) }],
    };
    const result = setWireRoute(document, "wire", [{ x: 3, y: 0 }, { x: 3, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }]);
    if (!result.ok) { throw new Error(result.reason); }
    expect(routeDocumentWires(result.document).get("wire")).toEqual([
      { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 0 },
      { x: 0, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    ]);
    expect(JSON.parse(serializeCircuitDocument(result.document)).version).toBe(1);
  });

  it.each(([0, 90, 180, 270] as CircuitRotation[]).flatMap((rotation) =>
    [false, true].flatMap((reversed) => ["connect", "reconnect"].map((operation) => ({ rotation, reversed, operation }))),
  ))("preserves occupied boundary approaches (rotation=$rotation, reversed=$reversed, operation=$operation)", ({ rotation, reversed, operation }) => {
    const document = occupiedBoundaryDocument(rotation, reversed);
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    expect(canPlace(document, document.parts)).toBe(true);
    expect(() => serializeCircuitDocument(document)).not.toThrow();
    const before = routeDocumentWires(document);
    const rendered = before.get("wire-2")!;
    const original = reversed ? [...rendered].reverse() : rendered;
    const last = original.at(-1)!;
    const corner = original.at(-2)!;
    const point = { x: (corner.x + last.x) / 2, y: (corner.y + last.y) / 2 };
    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, point)
      : reconnectWireToPoint(document, "edited", "to", point);
    if (!result.ok) { throw new Error(result.reason); }
    const second = result.document.wires.find((wire) => wire.id !== "wire-2" && wire.to.partId === (reversed ? "source-2" : "target-2"))!;
    const terminalSide = [...original.slice(0, -1), point];
    const junctionSide = [point, last];
    const after = routeDocumentWires(result.document);
    expect(after.get("wire-2")).toEqual(reversed ? [...junctionSide].reverse() : terminalSide);
    expect(after.get(second.id)).toEqual(reversed ? [...terminalSide].reverse() : junctionSide);
    expect(after.get("wire-0")).toEqual(before.get("wire-0"));
    expect(after.get("wire-1")).toEqual(before.get("wire-1"));
    expect(result.document.wires.some((wire) => wire.routeAnchors?.length)).toBe(true);
    const serialized = serializeCircuitDocument(result.document);
    expect(JSON.parse(serialized).version).toBe(2);
    const restored = parseCircuitDocument(serialized);
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(after);
  });

  it("keeps encoded anchors through moves, copies, pastes, rotations and reconnects", () => {
    const document = splitBoundaryDocument();
    const originalRoutes = routeDocumentWires(document);
    const ids = document.parts.map((part) => part.id);
    const moved = moveParts(document, ids, -100, -100);
    if (!moved.ok) { throw new Error(moved.reason); }
    const movedRoutes = routeDocumentWires(moved.document);
    for (const [id, route] of originalRoutes) {
      expect(movedRoutes.get(id)).toEqual(route.map((point) => ({ x: point.x - 100, y: point.y - 100 })));
    }
    const manual = moved.document.wires.find((wire) => wire.routeAnchors)!;
    expect(manual.routeAnchors!.every((point) => point.xBoundary === undefined && point.yBoundary === undefined)).toBe(true);
    const selection = { parts: moved.document.parts.map((part) => part.id), wires: [] };
    const fragment = copyFragment(moved.document, selection);
    const copied = fragment.wires.find((wire) => wire.id === manual.id)!;
    expect(copied.routeAnchors).not.toBe(manual.routeAnchors);
    expect(copied.routeAnchors![0]).not.toBe(manual.routeAnchors![0]);
    const pasted = pasteFragment({ title: "", parts: [], wires: [] }, fragment);
    if (!pasted.ok) { throw new Error(pasted.reason); }
    const pastedRoutes = routeDocumentWires(pasted.document);
    for (const [index, wire] of fragment.wires.entries()) {
      expect(pastedRoutes.get(pasted.document.wires[index]!.id)).toEqual(movedRoutes.get(wire.id)!.map((point) => ({ x: point.x + 2, y: point.y + 2 })));
    }
    const rotated = rotateParts(moved.document, ["source-2"]);
    if (!rotated.ok) { throw new Error(rotated.reason); }
    expect(finishedRouteIssues(rotated.document, manual.id)).toEqual([]);
    const movedEndpoint = moveParts(moved.document, ["source-2"], -5, -5);
    if (!movedEndpoint.ok) { throw new Error(movedEndpoint.reason); }
    expect(finishedRouteIssues(movedEndpoint.document, manual.id)).toEqual([]);
    const reconnected = reconnectWire(moved.document, manual.id, "to", { partId: "old", terminal: "a" });
    if (!reconnected.ok) { throw new Error(reconnected.reason); }
    expect(finishedRouteIssues(reconnected.document, manual.id)).toEqual([]);
    expect(() => serializeCircuitDocument(pasted.document)).not.toThrow();
  });

  it("preserves generated corners when splitting an encoded route again", () => {
    const document = splitBoundaryDocument();
    const original = routeDocumentWires(document).get("wire-2")!;
    const point = { x: 29, y: MAX_WIRE_COORDINATE - 30 };
    const result = connectToPoint(document, { partId: "source-2", terminal: "b" }, point);
    if (!result.ok) { throw new Error(result.reason); }
    const second = result.document.wires.find((wire) => wire.id !== "wire-2" && wire.to.partId === document.wires[2]!.to.partId)!;
    const routes = routeDocumentWires(result.document);
    expect(routes.get("wire-2")).toEqual([...original.slice(0, 3), point]);
    expect(routes.get(second.id)).toEqual([point, ...original.slice(3)]);
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
  });

  it("copies own nonenumerable anchor coordinates and boundary markers", () => {
    const document = splitBoundaryDocument();
    for (const wire of document.wires) {
      for (const point of wire.routeAnchors ?? []) {
        for (const key of ["x", "y", "xBoundary", "yBoundary"] as const) {
          if (Object.hasOwn(point, key)) { Object.defineProperty(point, key, { enumerable: false }); }
        }
      }
    }
    expect(() => serializeCircuitDocument(document)).not.toThrow();
    const before = routeDocumentWires(document);
    const fragment = copyFragment(document, { parts: document.parts.map((part) => part.id), wires: [] });
    expect(routeDocumentWires({ title: "copied", ...fragment })).toEqual(before);
    expect(() => serializeCircuitDocument({ title: "copied", ...fragment })).not.toThrow();
  });

  it("re-encodes copied negative-boundary corners after the paste offset", () => {
    const source = occupiedBoundaryDocument(180);
    const result = connectToPoint(source, { partId: "branch", terminal: "a" }, { x: -29.5, y: -MAX_WIRE_COORDINATE + 60 });
    if (!result.ok) { throw new Error(result.reason); }
    const before = routeDocumentWires(result.document);
    const fragment = copyFragment(result.document, { parts: result.document.parts.map((part) => part.id), wires: [] });
    const pasted = pasteFragment({ title: "", parts: [], wires: [] }, fragment);
    if (!pasted.ok) { throw new Error(pasted.reason); }
    const after = routeDocumentWires(pasted.document);
    for (const [index, wire] of result.document.wires.entries()) {
      expect(after.get(pasted.document.wires[index]!.id)).toEqual(before.get(wire.id)!.map((point) => ({ x: point.x + 2, y: point.y + 2 })));
    }
    expect(pasted.document.wires.some((wire) => wire.routeAnchors?.some((point) => point.yBoundary === -1))).toBe(true);
    expect(() => serializeCircuitDocument(pasted.document)).not.toThrow();
  });

  it("clears generated anchors when resetting or replacing manual waypoints", () => {
    const document = splitBoundaryDocument();
    const wire = document.wires.find((item) => item.routeAnchors)!;
    Object.assign(wire, { extension: "kept" });
    for (const result of [setWireRoute(document, wire.id), setWireWaypoints(document, wire.id), setWireWaypoints(document, wire.id, [{ x: 10, y: 5 }])]) {
      if (!result.ok) { throw new Error(result.reason); }
      expect(result.document.wires.find((item) => item.id === wire.id)).not.toHaveProperty("routeAnchors");
      expect(result.document.wires.find((item) => item.id === wire.id)).toHaveProperty("extension", "kept");
      expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    }
    expect(document.wires.find((item) => item.id === wire.id)).toHaveProperty("routeAnchors");
  });

  it("captures a shared generated point once and keeps the authored coordinate limit", () => {
    const document = occupiedBoundaryDocument();
    Object.assign(document.wires[2]!, { extension: "kept" });
    let reads = 0;
    const point = { get x() { reads += 1; return reads === 1 ? MAX_WIRE_COORDINATE + 4 : Number.NaN; }, y: 5 };
    const result = setWireRoute(document, "wire-2", [point, point]);
    if (!result.ok) { throw new Error(result.reason); }
    expect(reads).toBe(1);
    const stable = setWireRoute(document, "wire-2", [{ x: MAX_WIRE_COORDINATE + 4, y: 5 }, { x: MAX_WIRE_COORDINATE + 4, y: 5 }]);
    if (!stable.ok) { throw new Error(stable.reason); }
    expect(result.document).toEqual(stable.document);
    expect(result.document.wires[2]).toHaveProperty("extension", "kept");
    expect(finishedRouteIssues(result.document, "wire-2")).toEqual([]);
    expect(setWireWaypoints(document, "wire-2", [{ x: MAX_WIRE_COORDINATE + 4, y: 5 }]).ok).toBe(false);
    expect(setWireRoute(document, "wire-2", [{ x: Number.POSITIVE_INFINITY, y: 5 }]).ok).toBe(false);
    expect(setWireRoute(document, "wire-2", new Array<Point>(2)).ok).toBe(false);
    expect(setWireRoute(document, "wire-2", new Array<Point>(MAX_CIRCUIT_WIRE_ROUTE_ANCHORS + 1)).ok).toBe(false);
  });

  it.each([0, 90, 180, 270] as CircuitRotation[])("round-trips boundary-relative coordinates exactly after rotating %s degrees", (rotation) => {
    const points = [
      { x: MAX_WIRE_COORDINATE + 0.015_625, y: -MAX_WIRE_COORDINATE - 0.031_25 },
      { x: -MAX_WIRE_COORDINATE - 0.25, y: MAX_WIRE_COORDINATE + 0.5 },
      { x: MAX_WIRE_COORDINATE * 2, y: -MAX_WIRE_COORDINATE * 2 },
      { x: 10.5, y: -20.25 },
    ].map((point) => rotate(point, rotation));
    expect(decodeWireRouteAnchors(encodeWireRouteAnchors(points))).toEqual(points);
  });
});
