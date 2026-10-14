// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { GRID, type Point } from "../../circuit-geometry.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const mount = setupEditorHarness();

function required(container: ParentNode, selector: string): Element {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function pointer(container: ParentNode, target: Element, type: string, point: Point) {
  const surface = required(container, ".circuit-board__surface");
  const viewport = required(container, ".circuit-board__viewport");
  const [left = 0, top = 0, width = 960] = (surface.getAttribute("viewBox") ?? "0 0 960 560").split(/\s+/).map(Number);
  const zoom = Number(surface.getAttribute("width")) / width;
  const rect = viewport.getBoundingClientRect();
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: rect.left + (point.x * GRID - left) * zoom,
    clientY: rect.top + (point.y * GRID - top) * zoom,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
}

describe("Circuit part dragging", () => {
  it("keeps deletion as one undo step when pointer events arrive after deleting the dragged part", () => {
    const initial: CircuitDocument = {
      title: "ドラッグ中の削除",
      parts: [{ id: "moving", kind: "resistor", x: 0, y: 0, label: "移動", resistanceOhms: 10 }],
      wires: [],
    };
    const ui = mount(initial);
    const part = required(ui.container, '.circuit-board__part[data-part-id="moving"]');
    const surface = required(ui.container, ".circuit-board__surface");
    pointer(ui.container, part, "pointerdown", { x: 0, y: 0 });
    act(() => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    const deletedDocument = ui.editor.document;
    expect(deletedDocument.parts).toHaveLength(0);

    pointer(ui.container, surface, "pointermove", { x: 3, y: 0 });
    pointer(ui.container, surface, "pointerup", { x: 3, y: 0 });

    expect(ui.editor.document).toBe(deletedDocument);
    act(() => ui.editor.undo());
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canUndo).toBe(false);
  });

  it.each([false, true])("restores redo history when a drag returns to its origin (batched=%s)", (batched) => {
    const initial: CircuitDocument = {
      title: "往復後の履歴",
      parts: [{ id: "moving", kind: "resistor", x: 0, y: 0, label: "移動", resistanceOhms: 10 }],
      wires: [],
    };
    const ui = mount(initial);
    act(() => ui.editor.updatePart("moving", { label: "編集後" }));
    const redoDocument = ui.editor.document;
    act(() => ui.editor.undo());
    expect(ui.editor.canRedo).toBe(true);
    const part = required(ui.container, '.circuit-board__part[data-part-id="moving"]');
    const surface = required(ui.container, ".circuit-board__surface");
    pointer(ui.container, part, "pointerdown", { x: 0, y: 0 });
    const finishRoundTrip = () => {
      pointer(ui.container, surface, "pointermove", { x: 0, y: 2 });
      pointer(ui.container, surface, "pointermove", { x: 0, y: 0 });
      pointer(ui.container, surface, "pointerup", { x: 0, y: 0 });
    };
    if (batched) { act(finishRoundTrip); }
    else { finishRoundTrip(); }

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toEqual(redoDocument);
  });

  it.each([false, true])("tracks the pointer after a collision rejects a move (multiple=%s)", (multiple) => {
    const initial: CircuitDocument = {
      title: "衝突後のドラッグ",
      parts: [
        { id: "moving", kind: "resistor", x: 0, y: 0, label: "移動", resistanceOhms: 10 },
        { id: "obstacle", kind: "resistor", x: 6, y: 0, label: "障害物", resistanceOhms: 10 },
        ...(multiple ? [{ id: "companion", kind: "resistor" as const, x: 0, y: 6, label: "同時に移動", resistanceOhms: 10 }] : []),
      ],
      wires: [],
    };
    const ui = mount(initial);
    if (multiple) {
      act(() => {
        ui.editor.selectPart("moving");
        ui.editor.selectPart("companion", true);
      });
    }
    const part = required(ui.container, '.circuit-board__part[data-part-id="moving"]');
    const surface = required(ui.container, ".circuit-board__surface");
    pointer(ui.container, part, "pointerdown", { x: 0, y: 0 });
    pointer(ui.container, surface, "pointermove", { x: 6, y: 0 });
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.error).toBe("その位置にはほかの部品があります。");

    pointer(ui.container, surface, "pointermove", { x: 18, y: 0 });
    expect(ui.editor.document.parts.filter((item) => item.id !== "obstacle").map((item) => item.x))
      .toEqual(multiple ? [18, 18] : [18]);
    expect(ui.editor.document.parts.find((item) => item.id === "obstacle")?.x).toBe(6);
    expect(ui.editor.error).toBeNull();

    pointer(ui.container, surface, "pointermove", { x: 0, y: 0 });
    pointer(ui.container, surface, "pointerup", { x: 0, y: 0 });
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.selection.parts).toEqual(multiple ? ["moving", "companion"] : ["moving"]);
  });
});
