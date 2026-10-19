import { describe, expect, it } from "vitest";

import { canPlace, connectToPoint, moveParts, reconnectWire, reconnectWireToPoint, rotateParts } from "../circuit-edit.js";
import { MAX_WIRE_COORDINATE, rotate, routeDocumentWires } from "../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_ROUTE_ANCHORS, MAX_CIRCUIT_WIRE_WAYPOINTS, type CircuitDocument, type CircuitRotation } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

describe("splitting routes near the coordinate boundary", () => {
  it.each([8, MAX_CIRCUIT_WIRE_ROUTE_ANCHORS].flatMap((count) =>
    [14, 19.5].map((cutX) => ({ count, cutX })),
  ))("splits an explicit $count-vertex route after its final dog-leg at x=$cutX without adding stored vertices", ({ count, cutX }) => {
    const loop = [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 0 }];
    const tail = [{ x: 2, y: 5 }, { x: 13, y: 5 }, { x: 13, y: 10 }, { x: 19, y: 10 }];
    const document: CircuitDocument = {
      title: "上限の生成経路を再分割",
      parts: [
        { id: "source", kind: "resistor", x: -2, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 20, y: 10, label: "終点" },
        { id: "branch", kind: "junction", x: -5, y: -5, label: "枝" },
      ],
      wires: [{
        id: "crossed", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        routeAnchors: Array.from({ length: count }, (_, index) => ({ ...(
          index < count - tail.length ? loop[index % loop.length]! : tail[index - count + tail.length]!
        ) })),
      }],
    };
    expect(canPlace(document, document.parts)).toBe(true);
    const input = serializeCircuitDocument(document);
    expect(parseCircuitDocument(input).ok).toBe(true);
    const original = routeDocumentWires(document).get("crossed")!;
    const point = { x: cutX, y: 10 };
    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, point);
    if (!result.ok) { throw new Error(result.reason); }
    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === "target")!;
    const routes = routeDocumentWires(result.document);
    expect(routes.get("crossed")).toEqual([...original.slice(0, -1), point]);
    expect(routes.get(second.id)).toEqual([point, original.at(-1)]);
    for (const wire of [result.document.wires.find((item) => item.id === "crossed")!, second]) {
      expect(wire.routeAnchors!.length).toBeLessThanOrEqual(count);
    }
    if (cutX === 19.5) {
      expect(result.document.wires.find((wire) => wire.id === "crossed")!.routeAnchors).toHaveLength(count);
    }
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
    if (count === MAX_CIRCUIT_WIRE_ROUTE_ANCHORS && cutX === 19.5) {
      for (const [operation, edited] of [
        ["move", moveParts(document, ["source"], -5, 1)],
        ["rotate", rotateParts(document, ["source"])],
        ["reconnect", reconnectWire(document, "crossed", "to", { partId: "branch", terminal: "a" })],
      ] as const) {
        expect(edited.ok, operation).toBe(false);
        if (!edited.ok) { expect(edited.reason).toContain(String(MAX_CIRCUIT_WIRE_ROUTE_ANCHORS)); }
      }
    }
    expect(serializeCircuitDocument(document)).toBe(input);
  });

  it.each(([90, 270] as const).flatMap((rotation) =>
    [false, true].flatMap((reversed) => [false, true].map((boundary) => ({ rotation, reversed, boundary }))),
  ))(
    "retains a saved endpoint approach (rotation=$rotation, reversed=$reversed, boundary=$boundary)",
    ({ rotation, reversed, boundary }) => {
      const source = { partId: "source", terminal: "b" as const };
      const target = { partId: "target", terminal: "a" as const };
      const direction = rotation === 90 ? 1 : -1;
      const sourceY = boundary ? direction * MAX_WIRE_COORDINATE : 0;
      const document: CircuitDocument = {
        title: "通常座標の既保存経路",
        parts: [
          { id: "source", kind: "resistor", x: 0, y: sourceY, rotation, label: "R" },
          { id: "target", kind: "junction", x: 10, y: 0, label: "J" },
        ],
        wires: [{ id: "wire", from: reversed ? target : source, to: reversed ? source : target, waypoints: [{ x: 10, y: 0 }] }],
      };
      const expected = [
        { x: 0, y: sourceY + direction * 2 }, { x: 0, y: sourceY + direction * 3 },
        { x: 11, y: sourceY + direction * 3 }, { x: 11, y: 0 }, { x: 10, y: 0 },
      ];
      const rendered = routeDocumentWires(document);
      expect(rendered.get("wire")).toEqual(reversed ? expected.reverse() : expected);
      const restored = parseCircuitDocument(serializeCircuitDocument(document));
      if (!restored.ok) { throw new Error(restored.reason); }
      expect(routeDocumentWires(restored.document)).toEqual(rendered);
    },
  );

  it.each([6002, MAX_CIRCUIT_WIRE_WAYPOINTS].flatMap((waypointCount) =>
    [false, true].map((boundary) => ({ waypointCount, boundary })),
  ))("compacts a $waypointCount-anchor approach without exceeding the limit (boundary=$boundary)", ({ waypointCount, boundary }) => {
    let seed = 123;
    let x = 100;
    let y = 100;
    const increment = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return seed % 7 + 2;
    };
    const waypoints = [
      { x: MAX_WIRE_COORDINATE - 10, y: 20 }, { x: MAX_WIRE_COORDINATE - 30, y: 40 },
      ...Array.from({ length: waypointCount - 2 }, () => {
        x += increment();
        y += increment();
        return { x, y };
      }),
    ];
    const document: CircuitDocument = {
      title: "長い境界端子アプローチ",
      parts: [
        { id: "source", kind: "resistor", x: boundary ? MAX_WIRE_COORDINATE : 0, y: 0, label: "R" },
        { id: "target", kind: "junction", x: x + 20, y: y + 20, label: "終点" },
        { id: "branch", kind: "junction", x: x + 15, y: y + 40, label: "枝" },
      ],
      wires: [{ id: "crossed", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" }, waypoints }],
    };
    expect(() => serializeCircuitDocument(document)).not.toThrow();
    const original = routeDocumentWires(document).get("crossed")!;
    const point = { x: x + 15, y: y + 20 };
    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, point);
    if (!result.ok) { throw new Error(result.reason); }
    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === "target")!;
    const routes = routeDocumentWires(result.document);
    expect(routes.get("crossed")).toEqual([...original.slice(0, -1), point]);
    expect(routes.get(second.id)).toEqual([point, original.at(-1)]);
    for (const wire of result.document.wires) {
      expect(wire.waypoints?.length ?? 0).toBeLessThanOrEqual(MAX_CIRCUIT_WIRE_WAYPOINTS);
    }
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
    expect(document.wires[0]?.waypoints).toHaveLength(waypointCount);
  });

  it.each(([0, 90, 180, 270] as CircuitRotation[]).flatMap((rotation) =>
    [false, true].flatMap((reversed) => ["connect", "reconnect"].flatMap((operation) =>
      [false, true].map((manual) => ({ rotation, reversed, operation, manual })),
    )),
  ))("keeps generated terminal corners implicit (rotation=$rotation, reversed=$reversed, operation=$operation, manual=$manual)", ({ rotation, reversed, operation, manual }) => {
    const position = (x: number, y: number) => {
      const point = rotate({ x, y }, rotation);
      return { x: point.x || 0, y: point.y || 0 };
    };
    const targetY = manual ? 60 : 20;
    const source = { partId: "source", terminal: "b" as const };
    const target = { partId: "target", terminal: "a" as const };
    const waypoints = [
      position(MAX_WIRE_COORDINATE - 10, 20), position(MAX_WIRE_COORDINATE - 30, 40),
      position(100, 40), position(100, targetY),
    ];
    const document: CircuitDocument = {
      title: "座標境界の端子リード",
      parts: [
        { id: "source", kind: "resistor", ...position(MAX_WIRE_COORDINATE, 0), rotation, label: "R" },
        { id: "target", kind: "junction", ...position(0, targetY), label: "終点" },
        { id: "branch", kind: "junction", ...position(0, targetY + 20), label: "枝" },
        { id: "old", kind: "junction", ...position(20, targetY + 20), label: "旧接続先" },
      ],
      wires: [{
        id: "crossed", from: reversed ? target : source, to: reversed ? source : target,
        ...(manual ? { waypoints: reversed ? [...waypoints].reverse() : waypoints } : {}),
      }],
    };
    if (operation === "reconnect") {
      document.wires.push({ id: "edited", from: { partId: "branch", terminal: "a" }, to: { partId: "old", terminal: "a" } });
    }
    expect(canPlace(document, document.parts)).toBe(true);
    expect(() => serializeCircuitDocument(document)).not.toThrow();
    const point = position(manual ? 50 : MAX_WIRE_COORDINATE / 2, targetY);
    const rendered = routeDocumentWires(document).get("crossed")!;
    const original = reversed ? [...rendered].reverse() : rendered;
    if (!manual) {
      expect(original).toEqual([
        position(MAX_WIRE_COORDINATE + 2, 0), position(MAX_WIRE_COORDINATE + 3, 0),
        position(MAX_WIRE_COORDINATE + 3, targetY), position(0, targetY),
      ]);
    }
    const terminalSide = [...original.slice(0, -1), point];
    const junctionSide = [point, original.at(-1)!];

    const result = operation === "connect"
      ? connectToPoint(document, { partId: "branch", terminal: "a" }, point)
      : reconnectWireToPoint(document, "edited", "to", point);
    if (!result.ok) { throw new Error(result.reason); }
    const second = result.document.wires.find((wire) => wire.id !== "crossed" && wire.to.partId === (reversed ? "source" : "target"))!;
    const routes = routeDocumentWires(result.document);
    expect(routes.get("crossed")).toEqual(reversed ? [...junctionSide].reverse() : terminalSide);
    expect(routes.get(second.id)).toEqual(reversed ? [...terminalSide].reverse() : junctionSide);
    for (const wire of result.document.wires) {
      for (const waypoint of wire.waypoints ?? []) {
        expect(Math.abs(waypoint.x)).toBeLessThanOrEqual(MAX_WIRE_COORDINATE);
        expect(Math.abs(waypoint.y)).toBeLessThanOrEqual(MAX_WIRE_COORDINATE);
      }
    }
    const restored = parseCircuitDocument(serializeCircuitDocument(result.document));
    if (!restored.ok) { throw new Error(restored.reason); }
    expect(routeDocumentWires(restored.document)).toEqual(routes);
    expect(document.wires[0]?.waypoints).toEqual(manual ? reversed ? [...waypoints].reverse() : waypoints : undefined);
  });
});
