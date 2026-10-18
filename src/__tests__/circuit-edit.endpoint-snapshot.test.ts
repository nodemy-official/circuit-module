import { describe, expect, it } from "vitest";

import { connect, connectToPoint, reconnectWire } from "../circuit-edit.js";
import type { CircuitDocument, CircuitEndpoint } from "../circuit-model.js";
import { serializeCircuitDocument } from "../circuit-serialization.js";

function sourceDocument(): CircuitDocument {
  return {
    title: "接続先のスナップショット",
    parts: [
      { id: "left", kind: "junction", x: 0, y: 0, label: "左" },
      { id: "right", kind: "junction", x: 10, y: 0, label: "右" },
      { id: "branch", kind: "junction", x: 5, y: 10, label: "枝" },
      { id: "other", kind: "junction", x: 15, y: 10, label: "別の端子" },
    ],
    wires: [{ id: "original", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" } }],
  };
}

function changeEndpoint(endpoint: CircuitEndpoint) {
  endpoint.partId = "missing";
  endpoint.terminal = "c";
}

describe("new connection endpoint snapshots", () => {
  it("rejects a shared endpoint's self-connection without reading it twice", () => {
    const document = sourceDocument();
    let reads = 0;
    const endpoint: CircuitEndpoint = {
      get partId() { reads += 1; return reads === 1 ? "branch" : "other"; },
      terminal: "a",
    };

    expect(connect(document, endpoint, endpoint)).toMatchObject({
      ok: false, reason: expect.stringContaining("同じ端子"),
    });
    expect(reads).toBe(1);
    expect(document.wires).toHaveLength(1);
  });

  it("keeps a new connection independent of both caller endpoints", () => {
    const document = sourceDocument();
    const before = structuredClone(document);
    const from: CircuitEndpoint = { partId: "branch", terminal: "a" };
    const to: CircuitEndpoint = { partId: "other", terminal: "a" };
    const result = connect(document, from, to);
    if (!result.ok) { throw new Error(result.reason); }

    changeEndpoint(from);
    changeEndpoint(to);

    expect(result.document.wires.at(-1)).toEqual({
      id: result.id,
      from: { partId: "branch", terminal: "a" },
      to: { partId: "other", terminal: "a" },
    });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(before);
  });

  it.each([
    { name: "existing terminal", point: { x: 15, y: 10 } },
    { name: "new junction", point: { x: 20, y: 10 } },
    { name: "split wire", point: { x: 5, y: 0 } },
  ])("captures the source when connecting to a $name", ({ point }) => {
    const document = sourceDocument();
    const before = structuredClone(document);
    const from: CircuitEndpoint = { partId: "branch", terminal: "a" };
    const result = connectToPoint(document, from, point);
    if (!result.ok) { throw new Error(result.reason); }

    changeEndpoint(from);

    expect(result.document.wires.find((wire) => wire.id === result.id)?.from).toEqual({ partId: "branch", terminal: "a" });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(before);
  });

  it("uses the first source endpoint throughout wire splitting", () => {
    const document = sourceDocument();
    const before = structuredClone(document);
    let reads = 0;
    const from: CircuitEndpoint = {
      get partId() { reads += 1; return reads === 1 ? "branch" : "missing"; },
      terminal: "a",
    };
    const result = connectToPoint(document, from, { x: 5, y: 0 });
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.document.wires).toHaveLength(3);
    expect(result.document.wires.find((wire) => wire.id === result.id)?.from).toEqual({ partId: "branch", terminal: "a" });
    expect(reads).toBe(1);
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(before);
  });

  it.each(["from", "to"] as const)("keeps the reconnected %s end independent of the caller target", (end) => {
    const document = sourceDocument();
    const before = structuredClone(document);
    const target: CircuitEndpoint = { partId: "branch", terminal: "a" };
    const result = reconnectWire(document, "original", end, target);
    if (!result.ok) { throw new Error(result.reason); }

    changeEndpoint(target);

    expect(result.document.wires[0]?.[end]).toEqual({ partId: "branch", terminal: "a" });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(before);
  });

  it.each(["connect", "reconnect"] as const)("detaches an endpoint borrowed from another wire for %s", (operation) => {
    const document = sourceDocument();
    document.wires.push({ id: "other-wire", from: { partId: "branch", terminal: "a" }, to: { partId: "other", terminal: "a" } });
    const before = structuredClone(document);
    const borrowed = document.wires[1]!.from;
    const result = operation === "connect"
      ? connect(document, borrowed, { partId: "right", terminal: "a" })
      : reconnectWire(document, "original", "from", borrowed);
    if (!result.ok) { throw new Error(result.reason); }
    const added = result.document.wires.find((wire) => wire.id === result.id)!;

    changeEndpoint(added.from);

    expect(document).toEqual(before);
    expect(result.document.wires.find((wire) => wire.id === "other-wire")?.from).toEqual({ partId: "branch", terminal: "a" });
  });
});
