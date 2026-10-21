import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitRouteAnchor } from "../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument, validateCircuitFragment, validateCircuitRouteAnchors } from "../circuit-serialization.js";

function document(): CircuitDocument {
  return {
    title: "Consistent saved snapshots",
    parts: [
      { id: "s", kind: "battery", label: "S", x: 0, y: 0, voltageVolts: 12, internalResistanceOhms: 0 },
      { id: "r", kind: "resistor", label: "R", x: 10, y: 0, resistanceOhms: 6 },
    ],
    wires: [
      { id: "a", from: { partId: "s", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "s", terminal: "b" }, to: { partId: "r", terminal: "b" } },
    ],
  };
}

function changingRecord<T extends object>(value: T, field: string, change: () => void): T {
  let changed = false;
  return new Proxy(value, {
    getOwnPropertyDescriptor(target, key) {
      if (key === field && !changed) { changed = true; change(); }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

const mutations: { name: string; apply: (input: CircuitDocument) => void }[] = [
  { name: "part", apply(input) {
    input.parts[1] = changingRecord(input.parts[1]!, "id", () => {
      // Both the initial 12 V / 6 ohm and final 24 V / 12 ohm circuits draw 2 A.
      // Saving the old source with the new load would invent a 1 A circuit.
      input.parts[0]!.voltageVolts = 24;
      input.parts[1]!.resistanceOhms = 12;
    });
  } },
  { name: "wire", apply(input) {
    const first = input.wires[0]!;
    first.from = changingRecord(first.from, "partId", () => { first.id = "changed"; });
  } },
  { name: "endpoint", apply(input) {
    const first = input.wires[0]!;
    first.to = changingRecord(first.to, "partId", () => { first.from.terminal = "b"; });
  } },
  { name: "waypoint", apply(input) {
    const first = { x: 3, y: 0 };
    input.wires[0]!.waypoints = [first, changingRecord({ x: 4, y: 0 }, "x", () => { first.x = 2; })];
  } },
  { name: "route anchor", apply(input) {
    const first: CircuitRouteAnchor = { x: 3, y: 0 };
    input.wires[0]!.routeAnchors = [first, changingRecord({ x: 4, y: 0 }, "x", () => { first.x = 2; })];
  } },
  { name: "part array", apply(input) {
    input.parts[1] = changingRecord(input.parts[1]!, "id", () => {
      input.parts[0] = { ...input.parts[0]!, voltageVolts: 24 };
    });
  } },
  { name: "wire array", apply(input) {
    input.wires[1] = changingRecord(input.wires[1]!, "id", () => {
      input.wires[0] = { ...input.wires[0]!, id: "changed" };
    });
  } },
  { name: "waypoint array", apply(input) {
    const points = [{ x: 3, y: 0 }, { x: 4, y: 0 }];
    points[1] = changingRecord(points[1]!, "x", () => { points[0] = { x: 2, y: 0 }; });
    input.wires[0]!.waypoints = points;
  } },
  { name: "route anchor array", apply(input) {
    const points = [{ x: 3, y: 0 }, { x: 4, y: 0 }];
    points[1] = changingRecord(points[1]!, "x", () => { points[0] = { x: 2, y: 0 }; });
    input.wires[0]!.routeAnchors = points;
  } },
  { name: "previously omitted part field", apply(input) {
    input.parts[1] = changingRecord(input.parts[1]!, "id", () => { input.parts[0]!.rotation = 90; });
  } },
  { name: "previously omitted array index", apply(input) {
    input.parts[1] = changingRecord(input.parts[1]!, "id", () => {
      input.parts.push({ id: "new", kind: "junction", label: "J", x: 20, y: 0 });
    });
  } },
];

describe("saved snapshot consistency", () => {
  it.each(mutations)("rejects a changed $name after capturing the document", ({ apply }) => {
    const input = document();
    apply(input);
    expect(() => serializeCircuitDocument(input)).toThrow(/取得中に変更/);
  });

  it.each(mutations)("rejects a changed $name after capturing a fragment", ({ apply }) => {
    const input = document();
    apply(input);
    expect(validateCircuitFragment(input)).toEqual({ ok: false, reason: expect.stringContaining("取得中に変更") });
  });

  it("rejects inconsistent array length descriptors instead of dropping parts", () => {
    const input = document();
    input.parts = new Proxy(input.parts, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "length" ? { ...descriptor, value: 0 } : descriptor;
      },
    });
    expect(() => serializeCircuitDocument(input)).toThrow(TypeError);
    expect(validateCircuitFragment(input).ok).toBe(false);
  });

  it("rejects array indexes hidden during the final verification", () => {
    const input = document();
    let captures = 0;
    input.parts = new Proxy(input.parts, {
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        return ++captures === 1 ? keys : keys.filter((key) => key !== "0");
      },
    });
    expect(() => serializeCircuitDocument(input)).toThrow(/取得中に変更/);
  });

  it.each(["accessor", "throw", "value"])("rejects a late %s descriptor without invoking getters", (behavior) => {
    const input = document();
    let reads = 0;
    let getters = 0;
    input.parts[1] = new Proxy(input.parts[1]!, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "resistanceOhms" || ++reads === 1) { return descriptor; }
        if (behavior === "throw") { throw new Error("Changed descriptor trap"); }
        if (behavior === "value") { return { ...descriptor, value: 12 }; }
        return { configurable: true, enumerable: true, get() { getters += 1; return 6; } };
      },
    });
    expect(() => serializeCircuitDocument(input)).toThrow(/取得中に変更/);
    expect(getters).toBe(0);
  });

  it("ignores unrelated array metadata, including getters, while retaining the saved entries", () => {
    const input = document();
    const expected = structuredClone(input);
    for (const array of [input.parts, input.wires]) {
      Object.defineProperty(array, "future", { get() { throw new Error("Unknown getter must not run"); } });
      Object.defineProperty(array, "01", { value: "metadata" });
      Object.defineProperty(array, "4294967295", { value: "metadata" });
      Object.defineProperty(array, Symbol.iterator, { get() { throw new Error("Iterator must not run"); } });
    }
    expect(parseCircuitDocument(serializeCircuitDocument(input))).toEqual({ ok: true, document: expected });
  });

  it("ignores unknown record metadata installed after its saved fields were captured", () => {
    const input = document();
    const expected = structuredClone(input);
    input.parts[1] = changingRecord(input.parts[1]!, "id", () => {
      Object.defineProperty(input.parts[0]!, "future", { get() { throw new Error("Unknown getter must not run"); } });
    });
    expect(parseCircuitDocument(serializeCircuitDocument(input))).toEqual({ ok: true, document: expected });
  });

  it("checks the consistency of standalone route anchor validation", () => {
    const first = { x: 3, y: 0 };
    const anchors = [first, changingRecord({ x: 4, y: 0 }, "x", () => { first.x = 2; })];
    expect(validateCircuitRouteAnchors(anchors)).toEqual({ ok: false, reason: expect.stringContaining("取得中に変更") });
  });
});
