import { describe, expect, it } from "vitest";

import { copyFragment, pasteFragment } from "../circuit-edit.js";
import { routeDocumentWires } from "../circuit-geometry.js";
import type { CircuitDocument } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function fixture(): CircuitDocument {
  return {
    title: "コピー元",
    parts: [
      { id: "a", kind: "resistor", x: 0, y: 0, label: "R", resistanceOhms: 12, rotation: 90 },
      { id: "b", kind: "junction", x: 8, y: 0, label: "J" },
    ],
    wires: [{ id: "wire", from: { partId: "a", terminal: "b" }, to: { partId: "b", terminal: "a" },
      waypoints: [{ x: 0, y: 3 }, { x: 8, y: 3 }],
    }],
  };
}

describe("copying saved own data fields", () => {
  it.each(["document", "collections", "parts", "wires", "endpoints", "waypoints"] as const)("selects and copies own values without reading Proxy get traps (%s)", (scope) => {
    let document = fixture();
    const expected = structuredClone(document);
    let reads = 0;
    const wrap = <T extends object>(value: T): T => new Proxy(value, {
      get() { reads += 1; throw new Error("Proxy get must not run"); },
    });
    if (scope === "document") { document = wrap(document); }
    else if (scope === "collections") {
      document.parts = wrap(document.parts);
      document.wires = wrap(document.wires);
    } else if (scope === "parts") { document.parts = document.parts.map(wrap); }
    else if (scope === "wires") { document.wires = document.wires.map(wrap); }
    else if (scope === "endpoints") {
      document.wires[0]!.from = wrap(document.wires[0]!.from);
      document.wires[0]!.to = wrap(document.wires[0]!.to);
    } else { document.wires[0]!.waypoints = wrap(document.wires[0]!.waypoints!.map(wrap)); }

    const copied = copyFragment(document, { parts: ["a", "b"], wires: [] });

    expect(reads).toBe(0);
    expect(copied).toEqual({ parts: expected.parts, wires: expected.wires });
    const pasted = pasteFragment({ title: "", parts: [], wires: [] }, copied);
    expect(pasted.ok).toBe(true);
    expect(reads).toBe(0);
  });

  it.each(["parts", "wire", "endpoints", "waypoints"] as const)("retains nonenumerable %s fields through copy and paste", (scope) => {
    const document = fixture();
    const expected = structuredClone(document);
    const wire = document.wires[0]!;
    const values = { parts: document.parts, wire: [wire], endpoints: [wire.from, wire.to], waypoints: wire.waypoints! }[scope];
    for (const value of values) {
      for (const key of Object.keys(value)) { Object.defineProperty(value, key, { enumerable: false }); }
    }
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: expected });

    const copied = copyFragment(document, { parts: ["a", "b"], wires: [] });

    expect(copied).toEqual({ parts: expected.parts, wires: expected.wires });
    expect(copied.parts[0]).not.toBe(document.parts[0]);
    expect(copied.wires[0]!.from).not.toBe(wire.from);
    expect(copied.wires[0]!.waypoints![0]).not.toBe(wire.waypoints![0]);
    const pasted = pasteFragment({ title: "", parts: [], wires: [] }, copied);
    if (!pasted.ok) { throw new Error(pasted.reason); }
    const originalRoute = routeDocumentWires(expected).get("wire")!;
    expect(routeDocumentWires(pasted.document).get(pasted.selection.wires[0]!)).toEqual(
      originalRoute.map((point) => ({ x: point.x + 2, y: point.y + 2 })),
    );
    expect(parseCircuitDocument(serializeCircuitDocument(pasted.document)).ok).toBe(true);
    expect(parseCircuitDocument(serializeCircuitDocument(document))).toEqual({ ok: true, document: expected });
  });
});
