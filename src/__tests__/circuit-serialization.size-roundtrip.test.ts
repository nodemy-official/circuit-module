import { describe, expect, it } from "vitest";

import type { CircuitDocument } from "../circuit-model.js";
import { MAX_CIRCUIT_DOCUMENT_JSON_LENGTH, MAX_CIRCUIT_DOCUMENT_PARTS, parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";

function fixture(version: number, large = false): CircuitDocument {
  if (version === 1) {
    return {
      title: "",
      parts: Array.from({ length: large ? MAX_CIRCUIT_DOCUMENT_PARTS : 1 }, (_, index) => ({
        id: `part-${index}`, kind: "junction", x: 0, y: 0, label: "",
      })),
      wires: [],
    };
  }
  return {
    title: "",
    parts: [
      { id: "source", kind: "junction", x: 0, y: 0, label: "" },
      { id: "target", kind: "junction", x: 1, y: 0, label: "" },
    ],
    wires: [{ id: "wire", from: { partId: "source", terminal: "a" }, to: { partId: "target", terminal: "a" },
      routeAnchors: Array.from({ length: large ? 15_000 : 1 }, () => ({ x: 4, y: 0, xBoundary: 1 })),
    }],
  };
}

function envelope(version: number, document: CircuitDocument) {
  return { format: "circuit-module", version, document };
}

describe("saved JSON formatting at the text limit", () => {
  it("rejects a legacy document when its versioned save would exceed the text limit", () => {
    const document: CircuitDocument = { title: "", parts: [], wires: [] };
    const overhead = JSON.stringify(envelope(1, document)).length - JSON.stringify(document).length;
    document.title = "x".repeat(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH - JSON.stringify(document).length - overhead);
    const accepted = parseCircuitDocument(JSON.stringify(document));
    if (!accepted.ok) { throw new Error(accepted.reason); }
    expect(serializeCircuitDocument(accepted.document)).toHaveLength(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);

    for (const added of [1, overhead]) {
      const input = JSON.stringify({ ...document, title: document.title + "x".repeat(added) });
      expect(input.length).toBeLessThanOrEqual(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
      expect(parseCircuitDocument(input)).toEqual({ ok: false,
        reason: `正規化後の保存データは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`,
      });
    }
  });

  it.each([1, 2])("checks the normalized size of short numeric literals in version %s", (version) => {
    const document = fixture(version);
    document.parts[0]!.x = 1e13;
    document.title = "x".repeat(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH - JSON.stringify(envelope(version, document)).length);
    const numericInput = () => JSON.stringify(envelope(version, document)).replace('"x":10000000000000', '"x":1e13');
    const accepted = parseCircuitDocument(numericInput());
    if (!accepted.ok) { throw new Error(accepted.reason); }
    expect(serializeCircuitDocument(accepted.document)).toHaveLength(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);

    document.title += "x";
    expect(numericInput().length).toBeLessThan(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(parseCircuitDocument(numericInput())).toEqual({ ok: false,
      reason: `正規化後の保存データは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`,
    });
  });

  it.each([1, 2])("can save a valid compact version %s file after loading it", (version) => {
    const document = fixture(version, true);
    const value = envelope(version, document);
    const input = JSON.stringify(value);
    expect(input.length).toBeLessThanOrEqual(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(JSON.stringify(value, null, 2).length).toBeGreaterThan(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    const parsed = parseCircuitDocument(input);
    if (!parsed.ok) { throw new Error(parsed.reason); }

    const saved = serializeCircuitDocument(parsed.document);

    expect(saved.length).toBeLessThanOrEqual(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(JSON.parse(saved).version).toBe(version);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document });
  });

  it.each([1, 2])("accepts the exact compact text limit and rejects one extra unit in version %s", (version) => {
    const document = fixture(version);
    document.title = "x".repeat(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH - JSON.stringify(envelope(version, document)).length);
    expect(JSON.stringify(envelope(version, document)).length).toBe(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);

    const saved = serializeCircuitDocument(document);

    expect(saved.length).toBe(MAX_CIRCUIT_DOCUMENT_JSON_LENGTH);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document });
    document.title += "x";
    expect(() => serializeCircuitDocument(document)).toThrow(new RangeError(`保存データは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`));
  });
});
