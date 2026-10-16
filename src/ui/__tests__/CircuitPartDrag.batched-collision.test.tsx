// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveParts } from "../../circuit-edit.js";
import { GRID } from "../../circuit-geometry.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { CircuitBoard } from "../CircuitBoard.js";
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

function fixture(multiple = false): CircuitDocument {
  return {
    title: "batched collisions",
    parts: [
      { id: "moving", kind: "resistor", x: 0, y: 0, label: "moving", resistanceOhms: 10 },
      { id: "obstacle", kind: "resistor", x: 6, y: 0, label: "obstacle", resistanceOhms: 10 },
      ...(multiple ? [{ id: "companion", kind: "resistor" as const, x: 0, y: 6, label: "companion", resistanceOhms: 10 }] : []),
    ],
    wires: [],
  };
}

function required(container: ParentNode, selector: string) {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function createMount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  return { root, container };
}

function mountEditor(multiple = false) {
  const { root, container } = createMount();
  const onMoveEnd = vi.fn();
  let latest: CircuitEditorController | undefined;
  act(() => root.render(<CircuitEditor initialDocument={fixture(multiple)}>{(editor) => {
    latest = editor;
    return <CircuitBoard
      document={editor.document}
      documentVersion={editor.getDocumentVersion}
      selection={editor.selection}
      onSelectPart={editor.selectPart}
      onMovePart={editor.movePart}
      onMoveCancel={editor.cancelMove}
      onMoveEnd={() => { onMoveEnd(); editor.endEdit(); }}
      onKeyDown={(event) => {
        if (!event.ctrlKey) { return; }
        if (event.key === "c") { editor.copySelected(); }
        if (event.key === "y") { editor.redo(); }
      }}
    />;
  }}</CircuitEditor>));
  const ui = {
    container, onMoveEnd,
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
  if (multiple) {
    act(() => { ui.editor.selectPart("moving"); ui.editor.selectPart("companion", true); });
  }
  return ui;
}

/** Does not open its own act boundary, so several native events can share one commit. */
function pointer(container: ParentNode, type: string, x: number) {
  const surface = required(container, ".circuit-board__surface");
  const target = type === "pointerdown" ? required(container, '.circuit-board__part[data-part-id="moving"]') : surface;
  const [left = 0, top = 0, width = 960] = (surface.getAttribute("viewBox") ?? "0 0 960 560").split(/\s+/).map(Number);
  const zoom = Number(surface.getAttribute("width")) / width;
  const rect = required(container, ".circuit-board__viewport").getBoundingClientRect();
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0,
    clientX: rect.left + (x * GRID - left) * zoom,
    clientY: rect.top - top * zoom,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function movedPositions(document: CircuitDocument) {
  return document.parts.filter((part) => part.id !== "obstacle").map((part) => part.x);
}

describe("batched part drags through collisions", () => {
  it.each([false, true].flatMap((multiple) => [
    { multiple, points: [6, 18], expected: 18 },
    { multiple, points: [6, 5, 18], expected: 18 },
    { multiple, points: [6, 18, 6], expected: 18 },
  ]))("uses the last accepted pointer position and keeps one undo step ($multiple, $points)", ({ multiple, points, expected }) => {
    const ui = mountEditor(multiple);
    const initial = ui.editor.document;
    act(() => pointer(ui.container, "pointerdown", 0));
    act(() => {
      for (const x of points) { pointer(ui.container, "pointermove", x); }
      pointer(ui.container, "pointerup", points.at(-1)!);
    });

    expect(movedPositions(ui.editor.document)).toEqual(multiple ? [expected, expected] : [expected]);
    expect(ui.editor.document.parts.find((part) => part.id === "obstacle")?.x).toBe(6);
    expect(ui.onMoveEnd).toHaveBeenCalledTimes(1);
    const moved = ui.editor.document;
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(moved);
  });

  it.each([false, true])("restores redo after returning to the origin past a rejected move (multiple=%s)", (multiple) => {
    const ui = mountEditor(multiple);
    act(() => { ui.editor.setTitle("redo"); ui.editor.undo(); });
    if (multiple) { act(() => { ui.editor.selectPart("moving"); ui.editor.selectPart("companion", true); }); }
    act(() => pointer(ui.container, "pointerdown", 0));
    act(() => {
      for (const x of [18, 6, 0]) { pointer(ui.container, "pointermove", x); }
      pointer(ui.container, "pointerup", 0);
    });

    expect(ui.editor.document).toEqual(fixture(multiple));
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    expect(ui.onMoveEnd).toHaveBeenCalledTimes(1);
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("redo");
  });

  it.each(["pointercancel", "Escape"])("discards the entire batched gesture on %s and preserves redo", (ending) => {
    const ui = mountEditor(true);
    act(() => { ui.editor.setTitle("redo"); ui.editor.undo(); ui.editor.selectPart("moving"); ui.editor.selectPart("companion", true); });
    act(() => pointer(ui.container, "pointerdown", 0));
    act(() => {
      pointer(ui.container, "pointermove", 6);
      pointer(ui.container, "pointermove", 18);
      if (ending === "Escape") {
        required(ui.container, ".circuit-board__surface").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else { pointer(ui.container, ending, 18); }
      pointer(ui.container, "pointermove", 30);
      pointer(ui.container, "pointerup", 30);
    });

    expect(ui.editor.document).toEqual(fixture(true));
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    expect(ui.onMoveEnd).toHaveBeenCalledTimes(1);
  });

  it.each(["c", "y"])("restores history before Ctrl+%s finishes a drag that returned to its origin", (key) => {
    const ui = mountEditor();
    act(() => { ui.editor.setTitle("redo"); ui.editor.undo(); });
    act(() => pointer(ui.container, "pointerdown", 0));
    act(() => {
      pointer(ui.container, "pointermove", 18);
      pointer(ui.container, "pointermove", 0);
      required(ui.container, ".circuit-board__surface").dispatchEvent(new KeyboardEvent("keydown", {
        key, ctrlKey: true, bubbles: true, cancelable: true,
      }));
      pointer(ui.container, "pointermove", 30);
      pointer(ui.container, "pointerup", 30);
    });

    expect(ui.editor.document).toEqual({ ...fixture(), title: key === "y" ? "redo" : fixture().title });
    expect(ui.editor.canUndo).toBe(key === "y");
    expect(ui.editor.canRedo).toBe(key !== "y");
    expect(ui.onMoveEnd).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("observes acceptance from a functional host before the next pointer event (observerOnly=%s)", (observerOnly) => {
    const { root, container } = createMount();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    let latest = fixture();
    function Host() {
      const [circuit, setCircuit] = useState(latest);
      latest = circuit;
      return <CircuitBoard
        document={circuit}
        onMovePart={(id, dx, dy) => {
          onMove(id, dx, dy);
          if (observerOnly) { return; }
          setCircuit((current) => {
            const result = moveParts(current, [id], dx, dy);
            return result.ok ? result.document : current;
          });
        }}
        onMoveEnd={onEnd}
      />;
    }
    act(() => root.render(<Host />));
    act(() => pointer(container, "pointerdown", 0));
    act(() => {
      for (const x of [6, 18, 6, 30]) { pointer(container, "pointermove", x); }
      pointer(container, "pointerup", 30);
    });

    expect(movedPositions(latest)).toEqual([observerOnly ? 0 : 30]);
    expect(onMove).toHaveBeenCalledTimes(4);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
