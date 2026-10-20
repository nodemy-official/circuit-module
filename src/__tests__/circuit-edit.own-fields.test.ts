import { describe, expect, it } from "vitest";

import {
  addPart,
  connect,
  connectToPoint,
  moveParts,
  pasteFragment,
  reconnectWire,
  reconnectWireToPoint,
  removeSelection,
  rotateParts,
  setWireRoute,
  setWireWaypoints,
  type EditResult,
} from "../circuit-edit.js";
import type { CircuitDocument, CircuitWire } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";
import { analyzeCircuit } from "../circuit-solver.js";

type RouteKind = "waypoints" | "routeAnchors";

function fixture(routeKind: RouteKind): CircuitDocument {
  const wire = (id: string, from: CircuitWire["from"], to: CircuitWire["to"], points: { x: number; y: number }[]): CircuitWire => ({
    id, from, to, [routeKind]: points,
  });
  return {
    title: "保存対象の own fields",
    parts: [
      { id: "source", kind: "battery", label: "V", x: 0, y: 0, rotation: 0, voltageVolts: 9, internalResistanceOhms: 0 },
      { id: "load", kind: "resistor", label: "123Ω", x: 12, y: 0, rotation: 0, resistanceOhms: 123 },
      { id: "tap", kind: "junction", label: "Tap", x: 24, y: 0 },
      { id: "branch", kind: "junction", label: "Branch", x: 6, y: 10 },
      { id: "spare", kind: "junction", label: "Spare", x: 30, y: 10 },
      { id: "ground", kind: "ground", label: "GND", x: 40, y: 0 },
    ],
    wires: [
      wire("forward", { partId: "source", terminal: "a" }, { partId: "load", terminal: "a" }, [
        { x: -4, y: 0 }, { x: -4, y: -6 }, { x: 8, y: -6 }, { x: 8, y: 0 },
      ]),
      wire("return", { partId: "source", terminal: "b" }, { partId: "load", terminal: "b" }, [
        { x: 4, y: 0 }, { x: 4, y: 6 }, { x: 16, y: 6 }, { x: 16, y: 0 },
      ]),
      wire("tap-link", { partId: "load", terminal: "a" }, { partId: "tap", terminal: "a" }, [
        { x: 8, y: 0 }, { x: 8, y: -10 }, { x: 24, y: -10 },
      ]),
      wire("ground-link", { partId: "source", terminal: "b" }, { partId: "ground", terminal: "a" }, [
        { x: 4, y: 0 }, { x: 4, y: 12 }, { x: 40, y: 12 },
      ]),
    ],
  };
}

function hideAndFreezeOwnData(document: CircuitDocument) {
  const routeArrays = document.wires.flatMap((wire) => [wire.waypoints, wire.routeAnchors].filter((points) => points !== undefined));
  const records = [document, ...document.parts, ...document.wires,
    ...document.wires.flatMap((wire) => [wire.from, wire.to]), ...routeArrays.flat()];
  for (const record of records) {
    for (const key of Object.getOwnPropertyNames(record)) {
      Object.defineProperty(record, key, { enumerable: false, writable: false, configurable: false });
    }
  }
  for (const array of [document.parts, document.wires, ...routeArrays]) { Object.freeze(array); }
}

const edits: { name: string; edit: (document: CircuitDocument) => EditResult }[] = [
  { name: "moveParts", edit: (document) => moveParts(document, ["load"], 0, 2) },
  { name: "rotateParts", edit: (document) => rotateParts(document, ["load"]) },
  { name: "addPart", edit: (document) => addPart(document, "junction", { x: 50, y: 10 }) },
  { name: "removeSelection", edit: (document) => ({ ok: true, document: removeSelection(document, { parts: ["spare"], wires: [] }) }) },
  { name: "connect", edit: (document) => connect(document, { partId: "branch", terminal: "a" }, { partId: "source", terminal: "a" }) },
  { name: "pasteFragment", edit: (document) => pasteFragment(document, {
    parts: [{ id: "copy", kind: "resistor", label: "Copy", resistanceOhms: 7, x: 0, y: 20 }], wires: [],
  }) },
  { name: "setWireWaypoints", edit: (document) => setWireWaypoints(document, "forward", [
    { x: -5, y: 0 }, { x: -5, y: -6 }, { x: 8, y: -6 }, { x: 8, y: 0 },
  ]) },
  { name: "setWireRoute", edit: (document) => setWireRoute(document, "forward", [
    { x: -5, y: 0 }, { x: -5, y: -6 }, { x: 8, y: -6 }, { x: 8, y: 0 },
  ]) },
  { name: "reconnectWire", edit: (document) => reconnectWire(document, "forward", "to", { partId: "tap", terminal: "a" }) },
  { name: "connectToPoint", edit: (document) => connectToPoint(document, { partId: "branch", terminal: "a" }, { x: -4, y: -3 }) },
  { name: "reconnectWireToPoint", edit: (document) => reconnectWireToPoint(document, "forward", "to", { x: 24, y: 0 }) },
];

describe.each(["waypoints", "routeAnchors"] as const)("editing nonenumerable readonly %s documents", (routeKind) => {
  it.each(edits)("preserves saved own values through $name", ({ name, edit }) => {
    const document = fixture(routeKind);
    const expected = structuredClone(document);
    hideAndFreezeOwnData(document);
    const before = serializeCircuitDocument(document);
    expect(parseCircuitDocument(before)).toEqual({ ok: true, document: expected });
    expect(analyzeCircuit(document).parts.load.currentAmps).toBe(9 / 123);

    const result = edit(document);

    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document).not.toBe(document);
    const saved = serializeCircuitDocument(result.document);
    const restored = parseCircuitDocument(saved);
    if (!restored.ok) { throw new Error(restored.reason); }
    const addedParts = name === "addPart" || name === "pasteFragment" || name === "connectToPoint" ? 1 : name === "removeSelection" ? -1 : 0;
    const addedWires = name === "connect" ? 1 : name === "connectToPoint" ? 2 : 0;
    expect(restored.document.parts).toHaveLength(expected.parts.length + addedParts);
    expect(restored.document.wires).toHaveLength(expected.wires.length + addedWires);
    expect(restored.document.title).toBe(expected.title);
    expect(restored.document.parts.find((part) => part.id === "load")).toEqual({
      ...expected.parts[1],
      ...(name === "moveParts" ? { y: 2 } : {}),
      ...(name === "rotateParts" ? { rotation: 90 } : {}),
    });
    for (const part of expected.parts.filter((item) => item.id !== "load" && (item.id !== "spare" || name !== "removeSelection"))) {
      expect(restored.document.parts.find((candidate) => candidate.id === part.id)).toEqual(part);
    }
    expect(restored.document.wires.map((wire) => wire.id)).toEqual(expect.arrayContaining(expected.wires.map((wire) => wire.id)));
    for (const wire of expected.wires) {
      const edited = restored.document.wires.find((candidate) => candidate.id === wire.id)!;
      expect(edited.from).toEqual(wire.from);
      if (wire.id !== "forward") {
        expect(edited.to).toEqual(wire.to);
        if (name !== "moveParts" && name !== "rotateParts") { expect(edited[routeKind]).toEqual(wire[routeKind]); }
      }
    }
    const analysis = analyzeCircuit(result.document);
    expect(analysis.status).toBe("closed");
    // Independent Ohm's law oracle: the preserved ideal 9 V source drives 123 Ω.
    expect(analysis.parts.load.currentAmps).toBe(9 / 123);
    expect(analyzeCircuit(restored.document).parts.load.currentAmps).toBe(9 / 123);
    expect(serializeCircuitDocument(document)).toBe(before);
    expect(Object.getOwnPropertyDescriptor(document, "title")).toEqual({
      value: expected.title, writable: false, enumerable: false, configurable: false,
    });
    expect(Object.getOwnPropertyDescriptor(document.parts[1]!, "resistanceOhms")).toEqual({
      value: 123, writable: false, enumerable: false, configurable: false,
    });
  });
});
