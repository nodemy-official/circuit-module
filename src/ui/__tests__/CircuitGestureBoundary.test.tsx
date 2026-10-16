// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { GRID, routeDocumentWires, type Point } from "../../circuit-geometry.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const mount = setupEditorHarness();
type EditorHarness = ReturnType<typeof mount>;
type Gesture = "part" | "wire" | "connection" | "reconnect";
const gestures: Gesture[] = ["part", "wire", "connection", "reconnect"];

function fixture(): CircuitDocument {
  return {
    title: "original",
    parts: [
      { id: "part-1", kind: "resistor", x: 0, y: 0, label: "R1", resistanceOhms: 10 },
      { id: "part-2", kind: "resistor", x: 10, y: 0, label: "R2", resistanceOhms: 10 },
    ],
    wires: [{ id: "wire-1", from: { partId: "part-1", terminal: "b" }, to: { partId: "part-2", terminal: "a" } }],
  };
}

function required(container: ParentNode, selector: string): Element {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function pointer(ui: EditorHarness, selector: string, type: string, point: Point, options: MouseEventInit = {}) {
  const surface = required(ui.container, ".circuit-board__surface");
  const rect = required(ui.container, ".circuit-board__viewport").getBoundingClientRect();
  const [left = 0, top = 0, width = 960] = (surface.getAttribute("viewBox") ?? "0 0 960 560").split(/\s+/).map(Number);
  const zoom = Number(surface.getAttribute("width")) / width;
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0,
    ...options,
    clientX: rect.left + (point.x * GRID - left) * zoom,
    clientY: rect.top + (point.y * GRID - top) * zoom,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => required(ui.container, selector).dispatchEvent(event));
}

function start(ui: EditorHarness, gesture: Gesture, moved: boolean) {
  const origins = { part: { x: 0, y: 0 }, wire: { x: 5, y: 0 }, connection: { x: -2, y: 0 }, reconnect: { x: 8, y: 0 } };
  const selectors = {
    part: '.circuit-board__part[data-part-id="part-1"]',
    wire: '.circuit-board__wire[data-wire-id="wire-1"]',
    connection: '[data-part-id="part-1"][data-terminal="a"]',
    reconnect: '[data-wire-id="wire-1"][data-wire-handle="to"]',
  };
  if (gesture === "reconnect") { act(() => ui.editor.selectWire("wire-1")); }
  const origin = origins[gesture];
  pointer(ui, selectors[gesture], "pointerdown", origin);
  if (moved) { pointer(ui, ".circuit-board__surface", "pointermove", { x: origin.x, y: 2 }); }
  return origin;
}

function finish(ui: EditorHarness, origin: Point) {
  pointer(ui, ".circuit-board__surface", "pointermove", { x: origin.x, y: 4 });
  pointer(ui, ".circuit-board__surface", "pointerup", { x: origin.x, y: 4 });
  act(() => required(ui.container, ".circuit-board__surface").dispatchEvent(new MouseEvent("click", {
    bubbles: true, cancelable: true, detail: 1,
  })));
}

describe("document gesture boundaries", () => {
  it.each(["part", "wire"] as const)("finishes %s before a selection or clipboard shortcut", (gesture) => {
    for (const key of ["a", "c"] as const) {
      const ui = mount(fixture());
      const origin = start(ui, gesture, true);
      const committed = ui.editor.exportDocument();
      act(() => required(ui.container, ".circuit-board__surface").dispatchEvent(new KeyboardEvent("keydown", {
        key, ctrlKey: true, bubbles: true, cancelable: true,
      })));
      const selection = ui.editor.selection;
      finish(ui, origin);

      expect(ui.editor.exportDocument()).toBe(committed);
      expect(ui.editor.selection).toEqual(selection);
      act(() => ui.editor.undo());
      expect(ui.editor.document).toEqual(fixture());
      expect(ui.editor.canUndo).toBe(false);
      act(() => ui.editor.redo());
      expect(ui.editor.exportDocument()).toBe(committed);
    }
  });

  it.each(gestures.flatMap((gesture) => [false, true].flatMap((moved) => [false, true].map((batched) => ({ gesture, moved, batched })))))
  ("discards $gesture after import (moved=$moved, batched=$batched)", ({ gesture, moved, batched }) => {
    const ui = mount(fixture());
    const origin = start(ui, gesture, moved);
    const replacement = { ...fixture(), title: "replacement", parts: fixture().parts.map((part) => ({ ...part, x: part.x + 20, y: part.y + 20 })) };
    let saved = "";
    const replace = () => {
      expect(ui.editor.importDocument(JSON.stringify(replacement))).toBe(true);
      saved = ui.editor.exportDocument();
    };
    if (batched) { act(() => { replace(); finish(ui, origin); }); }
    else { act(replace); finish(ui, origin); }
    expect(ui.editor.exportDocument()).toBe(saved);
    expect(ui.editor.error).toBeNull();
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.selection).toEqual({ parts: [], wires: [] });
  });

  it.each(["part", "wire"] as const)("discards $0 after new documents, examples and history travel", (gesture) => {
    for (const action of ["new", "example", "undo", "redo"] as const) {
      const ui = mount(fixture());
      if (action === "redo") {
        act(() => { ui.editor.setTitle("redo"); ui.editor.undo(); });
      }
      const origin = start(ui, gesture, action !== "redo");
      let saved = "";
      act(() => {
        if (action === "new") {
          ui.editor.newDocument();
          ui.editor.add("resistor", { x: 20, y: 20 });
          ui.editor.add("resistor", { x: 30, y: 20 });
          ui.editor.chooseTerminal({ partId: "part-1", terminal: "b" });
          ui.editor.chooseTerminal({ partId: "part-2", terminal: "a" });
        } else if (action === "example") { ui.editor.openExample("dc"); }
        else if (action === "undo") { ui.editor.undo(); }
        else { ui.editor.redo(); }
        saved = ui.editor.exportDocument();
        finish(ui, origin);
      });
      expect(ui.editor.exportDocument()).toBe(saved);
      expect(ui.editor.error).toBeNull();
    }
  });

  it.each((["part", "wire"] as const).flatMap((gesture) => [false, true].map((moved) => ({ gesture, moved }))))
  ("discards $gesture after external cancellation before rendering (moved=$moved)", ({ gesture, moved }) => {
    const ui = mount(fixture());
    const origin = start(ui, gesture, moved);
    let saved = "";
    act(() => {
      if (gesture === "part") { ui.editor.cancelMove("part-1"); }
      else { ui.editor.cancelWireRoute("wire-1"); }
      saved = ui.editor.exportDocument();
      finish(ui, origin);
    });
    expect(ui.editor.exportDocument()).toBe(saved);
    expect(ui.editor.canUndo).toBe(false);
  });

  it.each((["part", "wire"] as const).flatMap((gesture) => [false, true].flatMap((moved) =>
    ["other-id", "other-group", "connection"].map((target) => ({ gesture, moved, target })),
  )))
  ("continues $gesture after cancelling $target (moved=$moved)", ({ gesture, moved, target }) => {
    const initial = fixture();
    initial.wires.push({
      id: "wire-other", from: { partId: "part-1", terminal: "a" }, to: { partId: "part-2", terminal: "b" },
    });
    const ui = mount(initial);
    const origin = start(ui, gesture, moved);
    act(() => {
      if (target === "connection") { ui.editor.cancelConnection(); }
      else if (gesture === "part" && target === "other-id") { ui.editor.cancelMove("part-2"); }
      else if (gesture === "wire" && target === "other-group") { ui.editor.cancelMove("part-1"); }
      else { ui.editor.cancelWireRoute(target === "other-id" ? "wire-other" : "wire-1"); }
      finish(ui, origin);
    });

    if (gesture === "part") { expect(ui.editor.document.parts[0]?.y).toBe(4); }
    else { expect(routeDocumentWires(ui.editor.document).get("wire-1")?.some((point) => point.y === 4)).toBe(true); }
    expect(ui.editor.error).toBeNull();
    act(() => ui.editor.undo());
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canUndo).toBe(false);
  });

  it.each(["part", "wire"] as const)("keeps a queued %s edit when cancelling another drag before rendering", (gesture) => {
    const ui = mount(fixture());
    const origin = start(ui, gesture, false);
    act(() => {
      pointer(ui, ".circuit-board__surface", "pointermove", { x: origin.x, y: 2 });
      if (gesture === "part") { ui.editor.cancelWireRoute("wire-1"); }
      else { ui.editor.cancelMove("part-1"); }
      finish(ui, origin);
    });

    if (gesture === "part") { expect(ui.editor.document.parts[0]?.y).toBe(4); }
    else { expect(routeDocumentWires(ui.editor.document).get("wire-1")?.some((point) => point.y === 4)).toBe(true); }
    act(() => ui.editor.undo());
    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.canUndo).toBe(false);
  });

  it.each((["connection", "reconnect"] as const).flatMap((gesture) => [false, true].map((moved) => ({ gesture, moved }))))
  ("discards $gesture after its connection is cancelled externally (moved=$moved)", ({ gesture, moved }) => {
    const ui = mount(fixture());
    start(ui, gesture, moved);
    act(() => {
      ui.editor.cancelConnection();
      pointer(ui, ".circuit-board__surface", "pointermove", { x: 12, y: 0 });
      pointer(ui, ".circuit-board__surface", "pointerup", { x: 12, y: 0 });
    });
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.document).toEqual(fixture());
  });

  it.each((["connection", "reconnect"] as const).flatMap((gesture) => [false, true].flatMap((moved) =>
    ["part", "wire"].map((target) => ({ gesture, moved, target })),
  )))
  ("continues $gesture after cancelling an unrelated $target drag (moved=$moved)", ({ gesture, moved, target }) => {
    const ui = mount(fixture());
    const origin = start(ui, gesture, moved);
    act(() => {
      if (target === "part") { ui.editor.cancelMove("part-1"); }
      else { ui.editor.cancelWireRoute("wire-1"); }
      finish(ui, origin);
    });

    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.error).toBeNull();
    if (gesture === "connection") { expect(ui.editor.document.wires).toHaveLength(2); }
    else { expect(ui.editor.document.wires[0]?.to.partId).not.toBe("part-2"); }
    act(() => ui.editor.undo());
    expect(ui.editor.document).toEqual(fixture());
  });

  it.each(gestures)("continues %s after undo or redo with no available history", (gesture) => {
    const ui = mount(fixture());
    const origin = start(ui, gesture, false);
    act(() => ui.editor.undo());
    pointer(ui, ".circuit-board__surface", "pointermove", { x: origin.x, y: 2 });
    act(() => ui.editor.redo());
    if (gesture === "connection" || gesture === "reconnect") { expect(ui.editor.pendingEndpoint).not.toBeNull(); }
    finish(ui, origin);
    if (gesture === "part") { expect(ui.editor.document.parts[0]?.y).toBe(4); }
    else if (gesture === "wire") { expect(routeDocumentWires(ui.editor.document).get("wire-1")?.some((point) => point.y === 4)).toBe(true); }
    else if (gesture === "connection") { expect(ui.editor.document.wires).toHaveLength(2); }
    else { expect(ui.editor.document.wires[0]?.to.partId).not.toBe("part-2"); }
  });

  it.each([false, true])("discards range selection after import (batched=%s)", (batched) => {
    const ui = mount(fixture());
    pointer(ui, "[data-circuit-board-background]", "pointerdown", { x: -3, y: -3 }, { shiftKey: true });
    pointer(ui, ".circuit-board__surface", "pointermove", { x: 13, y: 3 });
    const replace = () => {
      expect(ui.editor.importDocument(JSON.stringify({ ...fixture(), title: "replacement" }))).toBe(true);
      ui.editor.selectPart("part-2");
    };
    const finishRange = () => {
      pointer(ui, ".circuit-board__surface", "pointermove", { x: 14, y: 3 });
      pointer(ui, ".circuit-board__surface", "pointerup", { x: 14, y: 3 });
      act(() => required(ui.container, "[data-circuit-board-background]").dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, detail: 1,
      })));
    };
    if (batched) { act(() => { replace(); finishRange(); }); }
    else { act(replace); finishRange(); }
    expect(ui.editor.selection).toEqual({ parts: ["part-2"], wires: [] });
    expect(ui.container.querySelector("[data-selection-rect]")).toBeNull();
  });
});
