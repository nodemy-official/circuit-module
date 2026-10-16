// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function fixture(): CircuitDocument {
  return {
    title: "initial",
    parts: [
      { id: "left", kind: "resistor", label: "left", x: 0, y: 0, resistanceOhms: 10 },
      { id: "right", kind: "resistor", label: "right", x: 12, y: 0, resistanceOhms: 10 },
    ],
    wires: [{
      id: "wire", from: { partId: "left", terminal: "b" }, to: { partId: "right", terminal: "a" },
      waypoints: [{ x: 2, y: 2 }, { x: 10, y: 2 }],
    }],
  };
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  act(() => root.render(<CircuitEditor initialDocument={fixture()}>{(editor) => { latest = editor; return null; }}</CircuitEditor>));
  mounted.push({ root, container });
  return {
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

function createRedoBranch(editor: CircuitEditorController) {
  editor.setTitle("before group");
  editor.endEdit();
  editor.setTitle("redo");
  editor.undo();
  editor.selectAll();
}

function moveRoundTrip(editor: CircuitEditorController) {
  editor.movePart("left", 0, 3);
  editor.movePart("left", 0, -3);
}

describe("editor history for unchanged edit groups", () => {
  it.each(["endEdit", "selectAll", "copySelected", "clearSelection"] as const)("restores history when %s finishes a group with unchanged parts and wire waypoints", (command) => {
    const ui = mount();
    act(() => createRedoBranch(ui.editor));
    const before = ui.editor.document;
    act(() => { moveRoundTrip(ui.editor); ui.editor[command](); });

    expect(ui.editor.document).toBe(before);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.undo());
    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.canUndo).toBe(false);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(before);
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("redo");
  });

  it.each(["title", "property", "route"] as const)("restores the redo branch after an unchanged %s field group", (kind) => {
    const ui = mount();
    act(() => createRedoBranch(ui.editor));
    const before = ui.editor.document;
    act(() => {
      if (kind === "title") { ui.editor.setTitle("changed"); ui.editor.setTitle(before.title); }
      else if (kind === "property") { ui.editor.updatePart("left", { resistanceOhms: 22 }); ui.editor.updatePart("left", { resistanceOhms: 10 }); }
      else {
        ui.editor.updateWireRoute("wire", [{ x: 2, y: 4 }, { x: 10, y: 4 }]);
        ui.editor.updateWireRoute("wire", before.wires[0]!.waypoints);
      }
      ui.editor.endEdit();
    });

    expect(ui.editor.document).toBe(before);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("redo");
  });

  it.each(["undo", "redo"] as const)("uses the restored history for direct %s before an explicit endEdit", (command) => {
    const ui = mount();
    act(() => createRedoBranch(ui.editor));
    act(() => { moveRoundTrip(ui.editor); ui.editor[command](); });

    expect(ui.editor.document.title).toBe(command === "undo" ? "initial" : "redo");
    expect(ui.editor.document.parts).toEqual(fixture().parts);
    expect(ui.editor.canUndo).toBe(command === "redo");
    expect(ui.editor.canRedo).toBe(command === "undo");
  });

  it("keeps unavailable redo from splitting a real movement into separate undo steps", () => {
    const ui = mount();
    act(() => {
      ui.editor.selectAll();
      ui.editor.movePart("left", 0, 1);
      ui.editor.redo();
      ui.editor.movePart("left", 0, 1);
      ui.editor.endEdit();
    });
    expect(ui.editor.document.parts.map((part) => part.y)).toEqual([2, 2]);
    act(() => ui.editor.undo());
    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.canUndo).toBe(false);
  });
});
