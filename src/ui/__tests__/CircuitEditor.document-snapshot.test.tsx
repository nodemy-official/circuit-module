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

it.each(["plain", "non-enumerable", "proxy"] as const)("captures the initial document's manual route independently of the caller (%s)", (representation) => {
  const initial = fixture("最初の回路");
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
