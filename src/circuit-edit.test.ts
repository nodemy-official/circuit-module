import { describe, expect, it } from "vitest";

import {
  addPart,
  canPlace,
  connect,
  connectToPoint,
  copyFragment,
  findFreeSpot,
  moveParts,
  pasteFragment,
  removeSelection,
  rotateParts,
} from "./circuit-edit.js";
import { routeEnd, routeWire, terminalPoint } from "./circuit-geometry.js";
import { createExampleCircuit, type CircuitDocument } from "./circuit-model.js";

const empty: CircuitDocument = { title: "", parts: [], wires: [] };

describe("placing parts", () => {
  it("numbers labels of repeated kinds", () => {
    const first = addPart(empty, "resistor", { x: 5, y: 5 });
    if (!first.ok) throw new Error(first.reason);
    const second = addPart(first.document, "resistor", { x: 12, y: 5 });
    if (!second.ok) throw new Error(second.reason);
    expect(second.document.parts.map((part) => part.label)).toEqual(["抵抗", "抵抗2"]);
  });

  it("refuses overlapping bodies and touching terminals", () => {
    const document = createExampleCircuit();
    // The battery sits at (8, 5) and reaches from x 6 to 10.
    expect(addPart(document, "resistor", { x: 10, y: 5 }).ok).toBe(false);
    expect(addPart(document, "resistor", { x: 12, y: 5 }).ok).toBe(false);
    expect(addPart(document, "resistor", { x: 13, y: 5 }).ok).toBe(true);
  });

  it("keeps parts on the sheet", () => {
    expect(addPart(empty, "battery", { x: 2, y: 5 }).ok).toBe(false);
    expect(addPart(empty, "battery", { x: 3, y: 5 }).ok).toBe(true);
  });

  it("finds the nearest free spot", () => {
    const document = createExampleCircuit();
    const spot = findFreeSpot(document, "resistor", { x: 8, y: 5 });
    const placed = addPart(document, "resistor", spot);
    expect(placed.ok).toBe(true);
  });
});

describe("moving and rotating", () => {
  it("moves a selection together and rejects collisions", () => {
    const document = createExampleCircuit();
    const moved = moveParts(document, ["part-1", "part-4"], 0, 2);
    expect(moved.ok && moved.document.parts.find((part) => part.id === "part-1")?.y).toBe(7);
    expect(moveParts(document, ["part-1"], 12, 0).ok).toBe(false);
  });

  it("turns terminals with the part", () => {
    const rotated = rotateParts(createExampleCircuit(), ["part-2"]);
    if (!rotated.ok) throw new Error(rotated.reason);
    const resistor = rotated.document.parts.find((part) => part.id === "part-2");
    if (!resistor) throw new Error("missing resistor");
    expect(resistor.rotation).toBe(90);
    expect(terminalPoint(resistor, "a")).toEqual({ x: 20, y: 3 });
    expect(terminalPoint(resistor, "b")).toEqual({ x: 20, y: 7 });
  });

  it("checks that every candidate fits", () => {
    const document = createExampleCircuit();
    expect(canPlace(document, document.parts)).toBe(true);
  });
});

describe("wiring", () => {
  it("rejects duplicate and self connections", () => {
    const document = createExampleCircuit();
    expect(
      connect(document, { partId: "part-1", terminal: "b" }, { partId: "part-2", terminal: "a" })
        .ok,
    ).toBe(false);
    expect(
      connect(document, { partId: "part-1", terminal: "a" }, { partId: "part-1", terminal: "b" })
        .ok,
    ).toBe(false);
  });

  it("drops a junction when a wire ends on an empty cell", () => {
    const result = connectToPoint(
      createExampleCircuit(),
      { partId: "part-2", terminal: "b" },
      { x: 30, y: 5 },
    );
    if (!result.ok) throw new Error(result.reason);
    const junction = result.document.parts.at(-1);
    expect(junction).toMatchObject({ kind: "junction", x: 30, y: 5 });
    expect(result.document.wires.at(-1)?.to).toEqual({ partId: junction?.id, terminal: "a" });
  });

  it("splits a wire when a new branch lands on its route", () => {
    const document: CircuitDocument = {
      title: "枝分かれ",
      parts: [
        { id: "left", kind: "resistor", x: 5, y: 5, label: "左" },
        { id: "right", kind: "resistor", x: 15, y: 5, label: "右" },
        { id: "branch", kind: "battery", x: 10, y: 15, label: "電池" },
      ],
      wires: [
        {
          id: "wire-1",
          from: { partId: "left", terminal: "b" },
          to: { partId: "right", terminal: "a" },
        },
      ],
    };

    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, { x: 10, y: 5 });

    if (!result.ok) throw new Error(result.reason);
    const junction = result.document.parts.find((part) => part.kind === "junction");
    expect(junction).toMatchObject({ x: 10, y: 5 });
    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires).toContainEqual({
      id: "wire-1",
      from: { partId: "left", terminal: "b" },
      to: { partId: junction?.id, terminal: "a" },
    });
    expect(result.document.wires).toContainEqual({
      id: "wire-2",
      from: { partId: junction?.id, terminal: "a" },
      to: { partId: "right", terminal: "a" },
    });
    expect(result.document.wires).toContainEqual({
      id: result.id,
      from: { partId: "branch", terminal: "a" },
      to: { partId: junction?.id, terminal: "a" },
    });
  });

  it("connects to a terminal touched by an existing wire route", () => {
    const document: CircuitDocument = {
      title: "端子への接触",
      parts: [
        { id: "left", kind: "resistor", x: 5, y: 5, label: "左" },
        { id: "right", kind: "resistor", x: 15, y: 5, label: "右" },
        { id: "tap", kind: "resistor", x: 10, y: 7, rotation: 90, label: "分岐" },
        { id: "branch", kind: "battery", x: 20, y: 15, label: "電池" },
      ],
      wires: [
        {
          id: "wire-1",
          from: { partId: "left", terminal: "b" },
          to: { partId: "right", terminal: "a" },
        },
      ],
    };

    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, { x: 10, y: 5 });

    if (!result.ok) throw new Error(result.reason);
    expect(result.document.parts).toHaveLength(4);
    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires).toContainEqual({
      id: "wire-1",
      from: { partId: "left", terminal: "b" },
      to: { partId: "tap", terminal: "a" },
    });
    expect(result.document.wires).toContainEqual({
      id: "wire-2",
      from: { partId: "tap", terminal: "a" },
      to: { partId: "right", terminal: "a" },
    });
    expect(result.document.wires).toContainEqual({
      id: result.id,
      from: { partId: "branch", terminal: "a" },
      to: { partId: "tap", terminal: "a" },
    });
  });

  it("connects to a terminal that already sits on the cell", () => {
    const result = connectToPoint(
      createExampleCircuit(),
      { partId: "part-2", terminal: "b" },
      { x: 6, y: 13 },
    );
    expect(result.ok && result.document.wires.at(-1)?.to).toEqual({
      partId: "part-4",
      terminal: "a",
    });
  });

  it("routes wires along ruled lines", () => {
    const document = createExampleCircuit();
    const [battery, resistor] = document.parts;
    if (!battery || !resistor) throw new Error("missing parts");
    const route = routeWire(routeEnd(battery, "b"), routeEnd({ ...resistor, y: 9 }, "a"));
    for (const [index, point] of route.entries()) {
      const next = route[index + 1];
      if (next) expect(point.x === next.x || point.y === next.y).toBe(true);
    }
    expect(route[0]).toEqual({ x: 10, y: 5 });
    expect(route.at(-1)).toEqual({ x: 18, y: 9 });
  });
});

describe("clipboard", () => {
  it("copies parts with the wires between them and removes them with their wires", () => {
    const document = createExampleCircuit();
    const fragment = copyFragment(document, { parts: ["part-2", "part-3"], wires: [] });
    expect(fragment.wires.map((wire) => wire.id)).toEqual(["wire-2"]);
    const pasted = pasteFragment(document, fragment);
    if (!pasted.ok) throw new Error(pasted.reason);
    expect(pasted.document.parts).toHaveLength(6);
    expect(pasted.selection.wires).toHaveLength(1);
    const removed = removeSelection(pasted.document, pasted.selection);
    expect(removed.parts).toHaveLength(4);
    expect(removed.wires).toHaveLength(4);
  });
});
