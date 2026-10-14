import { describe, expect, it } from "vitest";

import { addPart, pasteFragment, type CircuitFragment } from "../circuit-edit.js";
import type { CircuitDocument } from "../circuit-model.js";
import { serializeCircuitDocument } from "../circuit-serialization.js";

const empty: CircuitDocument = { title: "", parts: [], wires: [] };
const parts: CircuitFragment["parts"] = [
  { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
  { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
];

describe("editing input invariants", () => {
  it("reads only coordinates when a placement point has additional properties", () => {
    const location = { x: 2, y: 3, id: "unexpected", kind: "battery", rotation: 45, currentAmps: Number.NaN };
    const result = addPart(empty, "resistor", location);
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.parts[0]).toEqual({
      id: result.id,
      kind: "resistor",
      x: 2,
      y: 3,
      label: "抵抗",
      resistanceOhms: 10,
    });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
  });

  it("rejects a fragment wire connecting an endpoint to itself", () => {
    const result = pasteFragment(empty, {
      parts,
      wires: [{ id: "self", from: { partId: "left", terminal: "a" }, to: { partId: "left", terminal: "a" } }],
    });

    expect(result.ok).toBe(false);
    expect(empty.parts).toHaveLength(0);
    expect(empty.wires).toHaveLength(0);
  });

  it("rejects reversed duplicate connections in a fragment", () => {
    const result = pasteFragment(empty, {
      parts,
      wires: [
        { id: "first", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } },
        { id: "second", from: { partId: "right", terminal: "a" }, to: { partId: "left", terminal: "a" } },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("continues to allow same-part connections between different pins", () => {
    const result = pasteFragment(empty, {
      parts: [{ id: "resistor", kind: "resistor", x: 0, y: 0, label: "抵抗" }],
      wires: [{ id: "short", from: { partId: "resistor", terminal: "a" }, to: { partId: "resistor", terminal: "b" } }],
    });

    if (!result.ok) { throw new Error(result.reason); }
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
  });
});
