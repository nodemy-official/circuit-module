import { describe, expect, it } from "vitest";

import {
  addPart,
  connect,
  connectToPoint,
  moveParts,
  pasteFragment,
  reconnectWire,
  reconnectWireToPoint,
  rotateParts,
  setWireRoute,
  type EditResult,
} from "../circuit-edit.js";
import type { CircuitDocument, CircuitEndpoint, CircuitWire } from "../circuit-model.js";
import {
  MAX_CIRCUIT_DOCUMENT_JSON_LENGTH,
  MAX_CIRCUIT_DOCUMENT_PARTS,
  MAX_CIRCUIT_DOCUMENT_WIRES,
  parseCircuitDocument,
  serializeCircuitDocument,
  validateCircuitFragment,
} from "../circuit-serialization.js";

function partLimitDocument(count: number): CircuitDocument {
  return {
    title: "",
    parts: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`, kind: "junction", label: "", x: index * 4, y: 0,
    })),
    wires: [],
  };
}

const addOnePart = (document: CircuitDocument) => addPart(document, "junction", { x: 0, y: 10 });
const pasteOnePart = (document: CircuitDocument) => pasteFragment(document, {
  parts: [{ id: "copied", kind: "junction", label: "J", x: 0, y: 10 }],
  wires: [],
});

describe("combined document part limits", () => {
  it.each([
    { name: "addPart", edit: addOnePart },
    { name: "pasteFragment", edit: pasteOnePart },
  ])("rejects $name beyond the part limit without changing its saveable source", ({ edit }) => {
    const document = partLimitDocument(MAX_CIRCUIT_DOCUMENT_PARTS);
    const saved = serializeCircuitDocument(document);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document });
    const before = structuredClone(document);

    expect(edit(document)).toEqual({ ok: false, reason: expect.stringContaining(String(MAX_CIRCUIT_DOCUMENT_PARTS)) });

    expect(document).toEqual(before);
    expect(serializeCircuitDocument(document)).toBe(saved);
  });

  it.each([
    { name: "addPart", edit: addOnePart },
    { name: "pasteFragment", edit: pasteOnePart },
  ])("allows $name to reach exactly the part limit", ({ edit }) => {
    const document = partLimitDocument(MAX_CIRCUIT_DOCUMENT_PARTS - 1);
    const before = structuredClone(document);

    const result = edit(document);

    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.parts).toHaveLength(MAX_CIRCUIT_DOCUMENT_PARTS);
    expect(parseCircuitDocument(serializeCircuitDocument(result.document))).toEqual({ ok: true, document: result.document });
    expect(document).toEqual(before);
  });
});

function wireLimitDocument(): { document: CircuitDocument; next: readonly [CircuitEndpoint, CircuitEndpoint] } {
  const document: CircuitDocument = {
    title: "",
    parts: Array.from({ length: 68 }, (_, index) => ({
      id: `p${index}`, kind: "op-amp", label: "", x: index * 8, y: 0,
    })),
    wires: [],
  };
  const endpoints = document.parts.flatMap((part) =>
    (["a", "b", "c"] as const).map((terminal) => ({ partId: part.id, terminal })),
  );
  const wires: CircuitWire[] = [];
  for (let first = 0; first < endpoints.length; first += 1) {
    for (let second = first + 1; second < endpoints.length; second += 1) {
      const from = endpoints[first]!;
      const to = endpoints[second]!;
      if (wires.length === MAX_CIRCUIT_DOCUMENT_WIRES) {
        return { document: { ...document, wires }, next: [from, to] };
      }
      wires.push({ id: String(wires.length), from, to });
    }
  }
  throw new Error("Not enough distinct endpoint pairs");
}

it("rejects connecting beyond the wire count limit without changing valid endpoint records", () => {
  const { document, next } = wireLimitDocument();
  // A 20,000-wire document already exceeds the separate JSON text limit. Validate
  // the records independently so this regression tests the count boundary itself.
  expect(validateCircuitFragment(document).ok).toBe(true);
  const before = structuredClone(document);

  const result = connect(document, next[0], next[1]);

  expect(result).toEqual({ ok: false, reason: expect.stringContaining(String(MAX_CIRCUIT_DOCUMENT_WIRES)) });
  expect(document).toEqual(before);
});

function explicitDocument(): CircuitDocument {
  return {
    title: "",
    parts: [
      { id: "s", kind: "resistor", label: "S", x: 0, y: 0 },
      { id: "t", kind: "resistor", label: "T", x: 10, y: 0 },
      { id: "j", kind: "junction", label: "J", x: 20, y: 10 },
    ],
    wires: [{
      id: "w", from: { partId: "s", terminal: "b" }, to: { partId: "t", terminal: "a" },
      routeAnchors: [{ x: 5, y: 0 }],
    }],
  };
}

function fillTextLimit(document: CircuitDocument): CircuitDocument {
  const envelope = { format: "circuit-module", version: 2, document };
  return { ...document, title: "T".repeat(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH - JSON.stringify(envelope).length) };
}

const textGrowingEdits: { name: string; edit: (document: CircuitDocument) => EditResult }[] = [
  { name: "moveParts", edit: (document) => moveParts(document, ["s"], 0, 1) },
  { name: "rotateParts", edit: (document) => rotateParts(document, ["s"]) },
  { name: "reconnectWire", edit: (document) => reconnectWire(document, "w", "to", { partId: "j", terminal: "a" }) },
  { name: "setWireRoute", edit: (document) => setWireRoute(document, "w", [
    { x: 5, y: 0 }, { x: 5, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 0 },
  ]) },
  { name: "connectToPoint", edit: (document) => connectToPoint(document, { partId: "j", terminal: "a" }, { x: 5, y: 0 }) },
];

describe("finished document JSON text limits", () => {
  it.each(textGrowingEdits)("rejects $name when a saveable explicit document would exceed the text limit", ({ edit }) => {
    const document = fillTextLimit(explicitDocument());
    const saved = serializeCircuitDocument(document);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document });
    expect(saved).toHaveLength(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    const before = structuredClone(document);

    expect(edit(document)).toEqual({ ok: false, reason: expect.stringContaining(String(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH)) });

    expect(document).toEqual(before);
    expect(serializeCircuitDocument(document)).toBe(saved);
  });

  it.each([
    { name: "moveParts", edit: (document: CircuitDocument) => moveParts(document, ["s", "t", "j"], 1, 0) },
    { name: "setWireRoute", edit: (document: CircuitDocument) => setWireRoute(document, "w", [{ x: 6, y: 0 }]) },
  ])("allows $name when its changed document stays exactly at the text limit", ({ edit }) => {
    const document = fillTextLimit(explicitDocument());
    const saved = serializeCircuitDocument(document);
    expect(saved).toHaveLength(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document });
    const before = structuredClone(document);

    const result = edit(document);

    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document).not.toEqual(document);
    const after = serializeCircuitDocument(result.document);
    expect(after).toHaveLength(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(parseCircuitDocument(after)).toEqual({ ok: true, document: result.document });
    expect(document).toEqual(before);
  });

  it("checks a point reconnect after pruning its old junction, rather than its larger intermediate document", () => {
    const source: CircuitDocument = {
      title: "",
      parts: [
        { id: "s", kind: "resistor", label: "S", x: 0, y: 0 },
        { id: "old", kind: "junction", label: "Old junction with a longer saved label", x: 10, y: 0 },
      ],
      wires: [{
        id: "w", from: { partId: "s", terminal: "b" }, to: { partId: "old", terminal: "a" },
        routeAnchors: [{ x: 5, y: 0 }],
      }],
    };
    const document = fillTextLimit(source);
    const saved = serializeCircuitDocument(document);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document });
    expect(saved).toHaveLength(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    const before = structuredClone(document);

    const result = reconnectWireToPoint(document, "w", "to", { x: 12, y: 0 });

    if (!result.ok) { throw new Error(result.reason); }
    expect(result.document.parts).toHaveLength(2);
    expect(result.document.parts.some((part) => part.id === "old")).toBe(false);
    expect(result.document.wires[0]?.to.partId).not.toBe("old");
    expect(parseCircuitDocument(serializeCircuitDocument(result.document))).toEqual({ ok: true, document: result.document });
    expect(document).toEqual(before);
  });
});
