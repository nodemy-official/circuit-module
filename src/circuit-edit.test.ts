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
  reconnectWire,
  reconnectWireToPoint,
  removeSelection,
  rotateParts,
  setWireWaypoints,
} from "./circuit-edit.js";
import { routeDocumentWires, routeEnd, routeWire, snapToGrid, terminalPoint } from "./circuit-geometry.js";
import { createExampleCircuit, type CircuitDocument } from "./circuit-model.js";

const empty: CircuitDocument = { title: "", parts: [], wires: [] };

describe("placing parts", () => {
  it("numbers labels of repeated kinds", () => {
    const first = addPart(empty, "resistor", { x: 5, y: 5 });
    if (!first.ok) { throw new Error(first.reason); }
    const second = addPart(first.document, "resistor", { x: 12, y: 5 });
    if (!second.ok) { throw new Error(second.reason); }
    expect(second.document.parts.map((part) => part.label)).toEqual(["抵抗", "抵抗2"]);
  });

  it("refuses overlapping bodies and touching terminals", () => {
    const document = createExampleCircuit();
    // The battery sits at (8, 5) and reaches from x 6 to 10.
    expect(addPart(document, "resistor", { x: 10, y: 5 }).ok).toBe(false);
    expect(addPart(document, "resistor", { x: 12, y: 5 }).ok).toBe(false);
    expect(addPart(document, "resistor", { x: 13, y: 5 }).ok).toBe(true);
  });

  it("allows parts across the former sheet boundary", () => {
    expect(addPart(empty, "battery", { x: 2, y: 5 }).ok).toBe(true);
    expect(addPart(empty, "battery", { x: 3, y: 5 }).ok).toBe(true);
  });

  it("allows placing parts at negative world coordinates", () => {
    const placed = addPart(empty, "battery", { x: -4, y: -6 });
    expect(placed.ok).toBe(true);
    expect(placed.ok && placed.document.parts[0]).toMatchObject({ x: -4, y: -6 });
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

  it("allows moving parts across the origin into negative coordinates", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [{ id: "battery", kind: "battery", x: 1, y: 1, label: "電池" }],
      wires: [],
    };
    const moved = moveParts(document, ["battery"], -5, -7);
    expect(moved.ok && moved.document.parts[0]).toMatchObject({ x: -4, y: -6 });
  });

  it("snaps pointer positions to negative grid cells", () => {
    expect(snapToGrid({ x: -61, y: -101 })).toEqual({ x: -3, y: -5 });
  });

  it("turns terminals with the part", () => {
    const rotated = rotateParts(createExampleCircuit(), ["part-2"]);
    if (!rotated.ok) { throw new Error(rotated.reason); }
    const resistor = rotated.document.parts.find((part) => part.id === "part-2");
    if (!resistor) { throw new Error("missing resistor"); }
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

  it("allows different terminals on three-terminal parts while rejecting two-terminal self-wires", () => {
    const document: CircuitDocument = {
      title: "多端子部品",
      parts: [
        { id: "opamp", kind: "op-amp", x: 5, y: 5, label: "U1" },
        { id: "pot", kind: "potentiometer", x: 15, y: 5, label: "VR1" },
        { id: "battery", kind: "battery", x: 25, y: 5, label: "電池" },
      ],
      wires: [],
    };

    const feedback = connect(document, { partId: "opamp", terminal: "c" }, { partId: "opamp", terminal: "b" });
    const wiperShort = connect(document, { partId: "pot", terminal: "c" }, { partId: "pot", terminal: "a" });
    const batteryShort = connect(document, { partId: "battery", terminal: "a" }, { partId: "battery", terminal: "b" });

    expect(feedback.ok).toBe(true);
    expect(wiperShort.ok).toBe(true);
    expect(batteryShort.ok).toBe(false);
  });

  it("uses the same multi-terminal self-connection rule when reconnecting a wire", () => {
    const document: CircuitDocument = {
      title: "帰還配線",
      parts: [
        { id: "opamp", kind: "op-amp", x: 5, y: 5, label: "U1" },
        { id: "battery", kind: "battery", x: 20, y: 5, label: "電池" },
      ],
      wires: [{ id: "wire-1", from: { partId: "opamp", terminal: "a" }, to: { partId: "battery", terminal: "a" } }],
    };

    const result = reconnectWire(document, "wire-1", "to", { partId: "opamp", terminal: "c" });

    expect(result.ok).toBe(true);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]?.to).toEqual({ partId: "opamp", terminal: "c" });
  });

  it("reconnects one wire end while preserving its ID and array position", () => {
    const document: CircuitDocument = {
      title: "配線変更",
      parts: [
        { id: "source", kind: "battery", x: 5, y: 5, label: "電池" },
        { id: "old", kind: "junction", x: 15, y: 5, label: "古い接続点" },
        { id: "target", kind: "resistor", x: 25, y: 5, label: "抵抗" },
        { id: "other", kind: "battery", x: 35, y: 5, label: "別の電池" },
      ],
      wires: [
        { id: "wire-0", from: { partId: "source", terminal: "a" }, to: { partId: "other", terminal: "a" } },
        { id: "wire-1", from: { partId: "source", terminal: "b" }, to: { partId: "old", terminal: "a" } },
      ],
    };

    const result = reconnectWire(document, "wire-1", "to", { partId: "target", terminal: "a" });

    expect(result.ok).toBe(true);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.id).toBe("wire-1");
    expect(result.document.wires.map((wire) => wire.id)).toEqual(["wire-0", "wire-1"]);
    expect(result.document.wires[1]?.to).toEqual({ partId: "target", terminal: "a" });
    expect(result.document.parts.map((part) => part.id)).not.toContain("old");
    expect(document.parts.map((part) => part.id)).toContain("old");
  });

  it("keeps an old junction when another wire still uses it", () => {
    const document: CircuitDocument = {
      title: "共有接続点",
      parts: [
        { id: "source", kind: "battery", x: 5, y: 5, label: "電池" },
        { id: "other", kind: "battery", x: 15, y: 15, label: "別の電池" },
        { id: "old", kind: "junction", x: 20, y: 5, label: "接続点" },
        { id: "target", kind: "resistor", x: 30, y: 5, label: "抵抗" },
      ],
      wires: [
        { id: "wire-1", from: { partId: "source", terminal: "b" }, to: { partId: "old", terminal: "a" } },
        { id: "wire-2", from: { partId: "other", terminal: "a" }, to: { partId: "old", terminal: "a" } },
      ],
    };

    const result = reconnectWire(document, "wire-1", "to", { partId: "target", terminal: "a" });

    expect(result.ok).toBe(true);
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.parts.map((part) => part.id)).toContain("old");
    expect(result.document.wires.find((wire) => wire.id === "wire-2")?.to).toEqual({ partId: "old", terminal: "a" });
  });

  it("returns the original document for a no-op reconnect", () => {
    const document = createExampleCircuit();
    const wire = document.wires[0];
    if (!wire) { throw new Error("missing wire"); }

    const result = reconnectWire(document, wire.id, "from", wire.from);

    expect(result).toEqual({ ok: true, id: wire.id, document });
    expect(result.ok && result.document).toBe(document);
  });

  it("rejects missing, invalid, same-part, and duplicate reconnects without changing the document", () => {
    const document: CircuitDocument = {
      title: "無効な接続先",
      parts: [
        { id: "source", kind: "battery", x: 5, y: 5, label: "電池" },
        { id: "old", kind: "junction", x: 15, y: 5, label: "接続点" },
        { id: "target", kind: "resistor", x: 25, y: 5, label: "抵抗" },
      ],
      wires: [
        { id: "wire-1", from: { partId: "source", terminal: "a" }, to: { partId: "old", terminal: "a" } },
        { id: "wire-2", from: { partId: "source", terminal: "a" }, to: { partId: "target", terminal: "a" } },
      ],
    };

    const invalidTerminal = reconnectWire(document, "wire-1", "to", { partId: "missing", terminal: "a" });
    const samePart = reconnectWire(document, "wire-1", "to", { partId: "source", terminal: "b" });
    const duplicate = reconnectWire(document, "wire-1", "to", { partId: "target", terminal: "a" });
    const missingWire = reconnectWire(document, "wire-missing", "to", { partId: "target", terminal: "b" });

    expect(invalidTerminal.ok).toBe(false);
    expect(samePart.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
    expect(missingWire.ok).toBe(false);
    expect(document.wires[0]?.to).toEqual({ partId: "old", terminal: "a" });
    expect(document.parts.map((part) => part.id)).toEqual(["source", "old", "target"]);
  });

  it("reconnects to a point on a wire without splitting the wire being edited", () => {
    const document: CircuitDocument = {
      title: "端点を移動",
      parts: [
        { id: "left", kind: "resistor", x: 5, y: 5, label: "左" },
        { id: "right", kind: "resistor", x: 15, y: 5, label: "右" },
      ],
      wires: [
        { id: "wire-1", from: { partId: "left", terminal: "b" }, to: { partId: "right", terminal: "a" } },
      ],
    };

    const result = reconnectWireToPoint(document, "wire-1", "to", { x: 10, y: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) { throw new Error(result.reason); }
    const junction = result.document.parts.find((part) => part.kind === "junction");
    expect(junction).toMatchObject({ x: 10, y: 5 });
    expect(result.id).toBe("wire-1");
    expect(result.document.wires).toHaveLength(1);
    expect(result.document.wires[0]).toEqual({
      id: "wire-1",
      from: { partId: "left", terminal: "b" },
      to: { partId: junction?.id, terminal: "a" },
    });
    expect(result.document.parts.map((part) => part.id)).toContain("right");
  });

  it("splits other wires using their visible routes from before the reconnect", () => {
    const document: CircuitDocument = {
      title: "迂回ルートでの再接続",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
        { id: "inner-left", kind: "junction", x: 2, y: 0, label: "内左" },
        { id: "inner-right", kind: "junction", x: 8, y: 0, label: "内右" },
      ],
      wires: [
        { id: "wire-1", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } },
        { id: "wire-2", from: { partId: "inner-left", terminal: "a" }, to: { partId: "inner-right", terminal: "a" } },
      ],
    };
    const route = routeDocumentWires(document).get("wire-2");
    const detour = route?.find((point) => point.y !== 0);
    if (!detour) { throw new Error("missing detoured route"); }

    const result = reconnectWireToPoint(document, "wire-1", "to", detour);

    expect(result.ok).toBe(true);
    if (!result.ok) { throw new Error(result.reason); }
    const junction = result.document.parts.find((part) => part.kind === "junction" && part.x === detour.x && part.y === detour.y);
    expect(junction).toBeDefined();
    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires.find((wire) => wire.id === "wire-1")?.to).toEqual({ partId: junction?.id, terminal: "a" });
    expect(result.document.wires.find((wire) => wire.id === "wire-2")?.to).toEqual({ partId: junction?.id, terminal: "a" });
  });

  it("drops a junction when a wire ends on an empty cell", () => {
    const result = connectToPoint(
      createExampleCircuit(),
      { partId: "part-2", terminal: "b" },
      { x: 30, y: 5 },
    );
    if (!result.ok) { throw new Error(result.reason); }
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

    if (!result.ok) { throw new Error(result.reason); }
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

  it("splits a wire at its detoured route", () => {
    const document: CircuitDocument = {
      title: "迂回する導線",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
        { id: "inner-left", kind: "junction", x: 2, y: 0, label: "内左" },
        { id: "inner-right", kind: "junction", x: 8, y: 0, label: "内右" },
        { id: "branch", kind: "junction", x: 5, y: 5, label: "枝" },
      ],
      wires: [
        { id: "wire-1", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } },
        { id: "wire-2", from: { partId: "inner-left", terminal: "a" }, to: { partId: "inner-right", terminal: "a" } },
      ],
    };
    const route = routeDocumentWires(document).get("wire-2");
    const detour = route?.find((point) => point.y !== 0);
    if (!detour) { throw new Error("missing detour"); }

    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, detour);

    if (!result.ok) { throw new Error(result.reason); }
    const junction = result.document.parts.find((part) => part.x === detour.x && part.y === detour.y);
    expect(junction?.kind).toBe("junction");
    expect(result.document.wires).toHaveLength(4);
    expect(result.document.wires.some((wire) => wire.id === "wire-2" && wire.to.partId === junction?.id)).toBe(true);
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

    if (!result.ok) { throw new Error(result.reason); }
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
    if (!battery || !resistor) { throw new Error("missing parts"); }
    const route = routeWire(routeEnd(battery, "b"), routeEnd({ ...resistor, y: 9 }, "a"));
    for (const [index, point] of route.entries()) {
      const next = route[index + 1];
      if (next) { expect(point.x === next.x || point.y === next.y).toBe(true); }
    }
    expect(route[0]).toEqual({ x: 10, y: 5 });
    expect(route.at(-1)).toEqual({ x: 18, y: 9 });
  });
});

describe("removing selections", () => {
  const junction = (id: string, x = 10) => ({
    id,
    kind: "junction" as const,
    x,
    y: 5,
    label: "接続点",
  });
  const endpoint = (partId: string) => ({ partId, terminal: "a" as const });
  const wire = (id: string, from: string, to: string) => ({
    id,
    from: endpoint(from),
    to: endpoint(to),
  });

  it("removes a junction when deleting its last wire", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [
        { id: "battery", kind: "battery", x: 5, y: 5, label: "電池" },
        junction("junction", 15),
      ],
      wires: [wire("wire-1", "battery", "junction")],
    };

    const result = removeSelection(document, { parts: [], wires: ["wire-1"] });

    expect(result.parts.map((part) => part.id)).toEqual(["battery"]);
    expect(result.wires).toEqual([]);
  });

  it("keeps a junction that still has a remaining wire", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [
        { id: "battery-1", kind: "battery", x: 4, y: 5, label: "電池" },
        { id: "battery-2", kind: "battery", x: 16, y: 5, label: "電池2" },
        junction("junction"),
      ],
      wires: [
        wire("wire-1", "battery-1", "junction"),
        wire("wire-2", "battery-2", "junction"),
      ],
    };

    const result = removeSelection(document, { parts: [], wires: ["wire-1"] });

    expect(result.parts.map((part) => part.id)).toContain("junction");
    expect(result.wires.map((item) => item.id)).toEqual(["wire-2"]);
  });

  it("preserves a preexisting unconnected junction unrelated to the removed wire", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [
        { id: "battery", kind: "battery", x: 5, y: 5, label: "電池" },
        { id: "resistor", kind: "resistor", x: 15, y: 5, label: "抵抗" },
        junction("unconnected-junction", 30),
      ],
      wires: [wire("wire-1", "battery", "resistor")],
    };

    const result = removeSelection(document, { parts: [], wires: ["wire-1"] });

    expect(result.parts.map((part) => part.id)).toContain("unconnected-junction");
  });

  it("removes a junction orphaned by deleting a connected part", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [
        { id: "battery", kind: "battery", x: 5, y: 5, label: "電池" },
        junction("junction", 15),
      ],
      wires: [wire("wire-1", "battery", "junction")],
    };

    const result = removeSelection(document, { parts: ["battery"], wires: [] });

    expect(result.parts).toEqual([]);
    expect(result.wires).toEqual([]);
    expect(document.parts.map((part) => part.id)).toEqual(["battery", "junction"]);
    expect(document.wires).toHaveLength(1);
  });

  it("removes all junctions isolated by deleting several wires together", () => {
    const document: CircuitDocument = {
      title: "",
      parts: [junction("junction-1", 5), junction("junction-2", 10), junction("junction-3", 15)],
      wires: [
        wire("wire-1", "junction-1", "junction-2"),
        wire("wire-2", "junction-2", "junction-3"),
      ],
    };

    const result = removeSelection(document, { parts: [], wires: ["wire-1", "wire-2"] });

    expect(result.parts).toEqual([]);
    expect(result.wires).toEqual([]);
  });
});

describe("clipboard", () => {
  it("detaches copied values and endpoints from the source document", () => {
    const document = createExampleCircuit();
    const fragment = copyFragment(document, { parts: ["part-2", "part-3"], wires: [] });
    fragment.parts[0].label = "変更";
    fragment.wires[0].from.partId = "missing";
    expect(document.parts[1].label).toBe("抵抗");
    expect(document.wires[1].from.partId).toBe("part-2");
  });

  it("rejects a fragment with an external endpoint instead of attaching it to the destination", () => {
    const document = createExampleCircuit();
    const fragment = copyFragment(document, { parts: ["part-2"], wires: [] });
    fragment.wires = [document.wires[0]];
    expect(pasteFragment(document, fragment).ok).toBe(false);
    expect(document.parts).toHaveLength(4);
  });

  it("copies parts with the wires between them and removes them with their wires", () => {
    const document = createExampleCircuit();
    const fragment = copyFragment(document, { parts: ["part-2", "part-3"], wires: [] });
    expect(fragment.wires.map((wire) => wire.id)).toEqual(["wire-2"]);
    const pasted = pasteFragment(document, fragment);
    if (!pasted.ok) { throw new Error(pasted.reason); }
    expect(pasted.document.parts).toHaveLength(6);
    expect(pasted.selection.wires).toHaveLength(1);
    const removed = removeSelection(pasted.document, pasted.selection);
    expect(removed.parts).toHaveLength(4);
    expect(removed.wires).toHaveLength(4);
  });
});

describe("manual wire routing", () => {
  const documentWithManualWire = (): CircuitDocument => ({
    title: "手動経路",
    parts: [
      { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
      { id: "right", kind: "junction", x: 10, y: 5, label: "右" },
      { id: "branch", kind: "junction", x: 5, y: 8, label: "枝" },
    ],
    wires: [{
      id: "wire-1",
      from: { partId: "left", terminal: "a" },
      to: { partId: "right", terminal: "a" },
      waypoints: [{ x: 2, y: 0 }, { x: 2, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 5 }],
    }],
  });

  it("sets, detaches, and clears waypoints", () => {
    const document = documentWithManualWire();
    const points = [{ x: 3, y: 0 }, { x: 3, y: 5 }];
    const set = setWireWaypoints(document, "wire-1", points);
    if (!set.ok) { throw new Error(set.reason); }
    points[0]!.x = 99;
    expect(set.document.wires[0]?.waypoints).toEqual([{ x: 3, y: 0 }, { x: 3, y: 5 }]);
    expect(set.document.wires[0]?.waypoints?.[0]).not.toBe(points[0]);

    const reset = setWireWaypoints(set.document, "wire-1");
    if (!reset.ok) { throw new Error(reset.reason); }
    expect(reset.document.wires[0]).not.toHaveProperty("waypoints");
    expect(setWireWaypoints(document, "missing", points).ok).toBe(false);
    expect(setWireWaypoints(document, "wire-1", [{ x: Number.MAX_VALUE, y: 0 }]).ok).toBe(false);
  });

  it("translates waypoints with moved endpoint parts", () => {
    const document = documentWithManualWire();
    const result = moveParts(document, ["left"], -2, 3);
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.wires[0]?.waypoints).toEqual([
      { x: 0, y: 3 }, { x: 0, y: 7 }, { x: 6, y: 7 }, { x: 6, y: 8 },
    ]);
    expect(document.wires[0]?.waypoints?.[0]).toEqual({ x: 2, y: 0 });
  });

  it("deep-copies and offsets waypoints when pasting a fragment", () => {
    const document = documentWithManualWire();
    const fragment = copyFragment(document, { parts: ["left", "right"], wires: [] });
    fragment.wires[0]!.waypoints![0]!.x = 4;
    expect(document.wires[0]?.waypoints?.[0]?.x).toBe(2);
    fragment.wires[0]!.waypoints![0]!.x = 2;

    const pasted = pasteFragment(document, fragment);
    if (!pasted.ok) { throw new Error(pasted.reason); }
    const duplicate = pasted.document.wires.find((wire) => wire.id !== "wire-1");
    expect(duplicate?.waypoints).toEqual([
      { x: 4, y: 2 }, { x: 4, y: 6 }, { x: 10, y: 6 }, { x: 10, y: 7 },
    ]);
    expect(document.wires[0]?.waypoints?.[0]).toEqual({ x: 2, y: 0 });
  });

  it("splits both halves at the manually routed crossing point", () => {
    const document: CircuitDocument = {
      title: "手動経路の分岐",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
        { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
        { id: "branch", kind: "junction", x: 5, y: 8, label: "枝" },
      ],
      wires: [{
        id: "wire-1",
        from: { partId: "left", terminal: "a" },
        to: { partId: "right", terminal: "a" },
        waypoints: [{ x: 2, y: 0 }, { x: 2, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 0 }],
      }],
    };

    const result = connectToPoint(document, { partId: "branch", terminal: "a" }, { x: 5, y: 4 });
    if (!result.ok) { throw new Error(result.reason); }
    const junction = result.document.parts.find((part) => part.kind === "junction" && part.x === 5 && part.y === 4);
    if (!junction) { throw new Error("Missing split junction"); }
    const firstRoute = routeDocumentWires(result.document).get("wire-1");
    const secondWire = result.document.wires.find((wire) => wire.from.partId === junction.id && wire.to.partId === "right");
    const secondRoute = secondWire ? routeDocumentWires(result.document).get(secondWire.id) : undefined;

    expect(firstRoute).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4 }, { x: 5, y: 4 }]);
    expect(secondRoute).toEqual([{ x: 5, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 0 }, { x: 10, y: 0 }]);
  });

  it("keeps waypoints on reconnect and routes orthogonally to the new endpoint", () => {
    const document = documentWithManualWire();
    const result = reconnectWire(document, "wire-1", "to", { partId: "branch", terminal: "a" });
    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.wires[0]?.waypoints).toEqual(document.wires[0]?.waypoints);
    const route = routeDocumentWires(result.document).get("wire-1");
    expect(route?.at(-1)).toEqual({ x: 5, y: 8 });
    for (let index = 0; route && index < route.length - 1; index += 1) {
      const first = route[index];
      const second = route[index + 1];
      if (first && second) { expect(first.x === second.x || first.y === second.y).toBe(true); }
    }
  });
});
