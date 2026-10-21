// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { CircuitEditor } from "../CircuitEditor.js";
import type { CircuitEditorController } from "../useCircuitEditor.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function fixture(title: string): CircuitDocument {
  return {
    title,
    parts: [
      { id: "a", kind: "junction", label: "A", x: 0, y: 0 },
      { id: "b", kind: "junction", label: "B", x: 10, y: 0 },
    ],
    wires: [{
      id: "wire", from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "a" },
      waypoints: [{ x: 3, y: 2 }, { x: 7, y: 2 }],
    }],
  };
}

function mount(initialDocument: CircuitDocument) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  mounted.push({ root, container });
  act(() => root.render(<CircuitEditor initialDocument={initialDocument}>{(controller) => {
    latest = controller;
    return null;
  }}</CircuitEditor>));
  return {
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

it.each(["plain", "non-enumerable", "proxy", "invalid-label"] as const)("captures the initial document's manual route independently of the caller (%s)", (representation) => {
  const initial = fixture("最初の回路");
  if (representation === "invalid-label") {
    Object.defineProperty(initial.parts[0]!, "label", { value: null, enumerable: true, configurable: true });
  }
  const expected = structuredClone(initial);
  const route = initial.wires[0]!.waypoints!;
  if (representation === "non-enumerable") {
    for (const point of route) {
      for (const key of ["x", "y"]) {
        Object.defineProperty(point, key, { enumerable: false });
      }
    }
  } else if (representation === "proxy") {
    initial.wires[0]!.waypoints = new Proxy(route, {
      get() { throw new Error("Caller array reads must not run"); },
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  const editor = () => {
    if (!latest) { throw new Error("Missing editor"); }
    return latest;
  };
  act(() => root.render(<CircuitEditor initialDocument={initial}>{(controller) => {
    latest = controller;
    return null;
  }}</CircuitEditor>));
  mounted.push({ root, container });
  const captured = editor().document;
  act(() => { editor().setTitle("履歴の後続操作"); editor().endEdit(); });

  route[0]!.x = 99;
  route.push({ x: 100, y: 100 });

  expect(captured).toEqual(expected);
  expect(editor().document.wires).toEqual(expected.wires);
  act(() => editor().undo());
  expect(editor().document).toBe(captured);
  expect(editor().document).toEqual(expected);
  act(() => editor().redo());
  expect(editor().document.wires).toEqual(expected.wires);
  expect(route).toHaveLength(3);
});

it.each((["from", "to"] as const).flatMap((side) => ["bad", 42, false].map((value) => ({ side, value }))))
("preserves an invalid own $side endpoint ($value) without replacing it with null", ({ side, value }) => {
  const initial = fixture("不正な接続先を含む回路");
  Object.defineProperty(initial.wires[0]!, side, { value, enumerable: false, configurable: true, writable: true });
  const expected = structuredClone({ ...initial, wires: [{ ...initial.wires[0], [side]: value }] });
  const route = initial.wires[0]!.waypoints!;
  const ui = mount(initial);
  const captured = ui.editor.document;
  expect(ui.editor.analysis.status).toBe("invalid");
  expect(ui.editor.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-wire-part", wireIds: ["wire"] }));
  expect(captured.wires[0]![side]).toBe(value);
  act(() => { ui.editor.setTitle("後続の変更"); ui.editor.endEdit(); });

  Object.defineProperty(initial.wires[0]!, side, { value: { partId: "a", terminal: "a" } });
  route[0]!.x = 99;

  expect(captured).toEqual(expected);
  expect(ui.editor.document.wires).toEqual(expected.wires);
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(captured);
  expect(ui.editor.analysis.status).toBe("invalid");
  act(() => ui.editor.redo());
  expect(ui.editor.document.wires).toEqual(expected.wires);
});

it.each(["coordinate", "boundary"] as const)("independently captures route points with an invalid own %s", (malformed) => {
  const initial = fixture("不正な経路値を修復する前の履歴");
  const point = { x: 3, y: 2, xBoundary: 0 };
  if (malformed === "coordinate") { Object.defineProperty(point, "x", { value: null, enumerable: false, writable: true }); }
  const metadata = { owner: "host" };
  Object.defineProperty(point, "metadata", { value: metadata, enumerable: false });
  Object.defineProperty(initial.wires[0]!, "routeAnchors", { value: [point], enumerable: false });
  const route = initial.wires[0]!.waypoints!;
  const ui = mount(initial);
  const captured = ui.editor.document;
  const beforePoint = { x: malformed === "coordinate" ? null : 3, y: 2, xBoundary: 0, metadata };
  act(() => { ui.editor.setTitle("後続の変更"); ui.editor.endEdit(); });

  point.x = 99;
  point.xBoundary = 1;
  route[0]!.x = 99;
  route.push({ x: 100, y: 100 });

  expect(captured.wires[0]!.waypoints).toEqual([{ x: 3, y: 2 }, { x: 7, y: 2 }]);
  expect(captured.wires[0]!.routeAnchors).toEqual([beforePoint]);
  expect(Object.getOwnPropertyDescriptor(captured.wires[0]!.routeAnchors![0]!, "metadata")?.value).toBe(metadata);
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(captured);
  act(() => ui.editor.redo());
  expect(ui.editor.document.wires).toEqual(captured.wires);
});

it.each(["point accessor", "array accessor"] as const)("keeps copied waypoints when route anchors contain an unreadable %s", (malformed) => {
  const initial = fixture("読み取れない経路点");
  const getter = vi.fn(() => { throw new Error("Route getters must not run"); });
  const point = { x: 3, y: 2 };
  const anchors = [point];
  if (malformed === "point accessor") { Object.defineProperty(point, "x", { get: getter }); }
  else { Object.defineProperty(anchors, "0", { get: getter }); }
  initial.wires[0]!.routeAnchors = anchors;
  const route = initial.wires[0]!.waypoints!;
  const ui = mount(initial);

  route[0]!.x = 99;

  expect(ui.editor.document.wires[0]!.waypoints).toEqual([{ x: 3, y: 2 }, { x: 7, y: 2 }]);
  expect(getter).not.toHaveBeenCalled();
  if (malformed === "point accessor") {
    const capturedPoint = ui.editor.document.wires[0]!.routeAnchors![0]!;
    expect(capturedPoint === point).toBe(false);
    expect(Object.getOwnPropertyDescriptor(capturedPoint, "x")?.get).toBe(getter);
  }
  else { expect(ui.editor.document.wires[0]!.routeAnchors).toBe(anchors); }
});

it.each(["wire route", "wire metadata", "document metadata", "part metadata"] as const)
("detaches copyable sibling data from a frozen record with a %s getter", (location) => {
  const initial = fixture("凍結された accessor を含む履歴");
  const getter = vi.fn(() => { throw new Error("Unknown and route getters must not run"); });
  const target = location === "document metadata" ? initial : location === "part metadata" ? initial.parts[0]! : initial.wires[0]!;
  const field = location === "wire route" ? "routeAnchors" : "metadata";
  Object.defineProperty(target, field, { get: getter, enumerable: false });
  Object.freeze(target);
  const route = initial.wires[0]!.waypoints!;
  const ui = mount(initial);
  const captured = ui.editor.document;
  const capturedTarget = location === "document metadata" ? captured : location === "part metadata" ? captured.parts[0]! : captured.wires[0]!;
  expect(Object.getOwnPropertyDescriptor(capturedTarget, field)?.get).toBe(getter);
  expect(capturedTarget === target).toBe(false);
  act(() => { ui.editor.setTitle("後続の変更"); ui.editor.endEdit(); });

  route[0]!.x = 99;
  route.push({ x: 100, y: 100 });

  expect(captured.wires[0]!.waypoints).toEqual([{ x: 3, y: 2 }, { x: 7, y: 2 }]);
  expect(ui.editor.document.wires).toEqual(captured.wires);
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(captured);
  act(() => ui.editor.redo());
  expect(ui.editor.document.wires).toEqual(captured.wires);
  expect(getter).not.toHaveBeenCalled();
});

it.each((["parts", "wires", "waypoints", "routeAnchors"] as const).flatMap((location) =>
  (["data", "getter"] as const).map((metadataKind) => ({ location, metadataKind }))))
("detaches indexed data while retaining $metadataKind metadata on the $location array", ({ location, metadataKind }) => {
  const initial = fixture("配列 metadata を含む履歴");
  initial.wires[0]!.routeAnchors = [{ x: 3, y: 2, xBoundary: 1 }];
  const array = location === "parts" || location === "wires" ? initial[location] : initial.wires[0]![location]!;
  const metadata = { owner: "host" };
  const getter = vi.fn(() => { throw new Error("Array metadata getters must not run"); });
  Object.defineProperty(array, "metadata", metadataKind === "data" ? { value: metadata } : { get: getter });
  Object.defineProperty(array, "01", { value: metadata });
  Object.defineProperty(array, "4294967295", { get: getter });
  Object.freeze(array);
  const ui = mount(initial);
  const captured = ui.editor.document;
  const copiedArray = location === "parts" || location === "wires" ? captured[location] : captured.wires[0]![location]!;
  expect(ui.editor.analysis.status).toBe(location === "parts" || location === "wires" ? "invalid" : "idle");
  expect(copiedArray === array).toBe(false);
  const descriptor = Object.getOwnPropertyDescriptor(copiedArray, "metadata");
  if (metadataKind === "data") { expect(descriptor?.value).toBe(metadata); }
  else { expect(descriptor?.get).toBe(getter); }
  expect(Object.getOwnPropertyDescriptor(copiedArray, "01")?.value).toBe(metadata);
  expect(Object.getOwnPropertyDescriptor(copiedArray, "4294967295")?.get).toBe(getter);
  act(() => { ui.editor.setTitle("後続の変更"); ui.editor.endEdit(); });

  initial.parts[0]!.x = 99;
  initial.wires[0]!.from.partId = "missing";
  initial.wires[0]!.waypoints![0]!.x = 99;
  initial.wires[0]!.routeAnchors![0]!.x = 99;

  expect(captured.parts[0]!.x).toBe(0);
  expect(captured.wires[0]!.from.partId).toBe("a");
  expect(captured.wires[0]!.waypoints![0]!.x).toBe(3);
  expect(captured.wires[0]!.routeAnchors![0]!.x).toBe(3);
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(captured);
  act(() => ui.editor.redo());
  expect(ui.editor.document.wires).toEqual(captured.wires);
  expect(getter).not.toHaveBeenCalled();
});

it("rejects an invalid root array whose captured length excludes its actual own indexes", () => {
  const initial = fixture("偽装された配列長");
  const parts = initial.parts;
  initial.parts = new Proxy(parts, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "length" ? { ...descriptor, value: 0 } : descriptor;
    },
  });
  expect(() => mount(initial)).toThrow(TypeError);
  expect(parts).toHaveLength(2);
  expect(parts.map(({ id }) => id)).toEqual(["a", "b"]);
});

it.each((["parts", "wires", "waypoints", "routeAnchors"] as const).flatMap((location) =>
  (["map", "every", "some", "find", "entries", "constructor", Symbol.iterator] as const).flatMap((key) =>
    (["data", "getter"] as const).map((kind) => ({ location, key, kind })))))
("normalizes own array builtins without invoking them ($location, $key, $kind)", ({ location, key, kind }) => {
  const initial = fixture("独自の配列メソッドを含む文書");
  if (location === "routeAnchors") {
    Reflect.deleteProperty(initial.wires[0]!, "waypoints");
    initial.wires[0]!.routeAnchors = [{ x: 3, y: 0 }, { x: 7, y: 0 }];
  }
  const array = location === "parts" || location === "wires" ? initial[location] : initial.wires[0]![location]!;
  const forbidden = vi.fn(() => { throw new Error("Array builtin overrides must not run"); });
  const metadata = { owner: "host" };
  Object.defineProperty(array, key, kind === "getter" ? { get: forbidden } : { value: forbidden });
  Object.defineProperty(array, "metadata", { value: metadata, enumerable: false });
  Object.freeze(array);
  const ui = mount(initial);
  const before = ui.editor.document;
  const copiedArray = location === "parts" || location === "wires" ? before[location] : before.wires[0]![location]!;
  expect(copiedArray === array).toBe(false);
  expect(Object.getOwnPropertyDescriptor(copiedArray, key)).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(copiedArray, "metadata")).toEqual(Object.getOwnPropertyDescriptor(array, "metadata"));
  expect(ui.editor.analysis.status).toBe(location === "parts" || location === "wires" ? "invalid" : "idle");

  act(() => { ui.editor.selectPart("a"); ui.editor.movePart("a", -1, 0); ui.editor.endEdit(); });
  expect(ui.editor.document.parts[0]!.x).toBe(-1);
  const moved = ui.editor.document;
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(before);
  act(() => ui.editor.redo());
  expect(ui.editor.document).toBe(moved);
  expect(forbidden).not.toHaveBeenCalled();
  expect(Object.getOwnPropertyDescriptor(array, key)?.[kind === "getter" ? "get" : "value"]).toBe(forbidden);
});

it.each((["parts", "wires"] as const).flatMap((collection) =>
  (["sparse", "index accessor", "collection accessor", "non-array"] as const).map((malformed) => ({ collection, malformed }))))
("rejects an unreadable root $collection collection ($malformed) without evaluating accessors", ({ collection, malformed }) => {
  const initial = fixture("読み取れない部品または導線一覧");
  const getter = vi.fn(() => { throw new Error("Collection getters must not run"); });
  if (malformed === "sparse") { Reflect.deleteProperty(initial[collection], "0"); }
  else if (malformed === "index accessor") { Object.defineProperty(initial[collection], "0", { get: getter }); }
  else if (malformed === "collection accessor") { Object.defineProperty(initial, collection, { get: getter }); }
  else { Object.defineProperty(initial, collection, { value: null }); }

  expect(() => mount(initial)).toThrow(TypeError);
  expect(() => mount(initial)).toThrow(/部品一覧|導線一覧/);
  expect(getter).not.toHaveBeenCalled();
});
