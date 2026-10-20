// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument, CircuitPart } from "../../circuit-model.js";
import { MAX_WIRE_COORDINATE } from "../../circuit-geometry.js";
import { parseCircuitDocument } from "../../circuit-serialization.js";
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
      { id: "a", kind: "resistor", label: "A", x: 0, y: 0, resistanceOhms: 10 },
      { id: "b", kind: "resistor", label: "B", x: 10, y: 0, resistanceOhms: 10 },
    ],
    wires: [{ id: "wire", from: { partId: "a", terminal: "b" }, to: { partId: "b", terminal: "a" } }],
  };
}

function mount(initialDocument = fixture()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  act(() => root.render(<StrictMode><CircuitEditor initialDocument={initialDocument}>{(editor) => {
    latest = editor;
    return null;
  }}</CircuitEditor></StrictMode>));
  mounted.push({ root, container });
  return {
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

describe("part property updates", () => {
  it.each((["x", "y"] as const).flatMap((axis) =>
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX_WIRE_COORDINATE + 1, -MAX_WIRE_COORDINATE - 1]
      .map((value) => ({ axis, value }))))
  ("rejects an unsavable $axis coordinate ($value) without changing history or connections", ({ axis, value }) => {
    const ui = mount();
    act(() => {
      ui.editor.setTitle("redo");
      ui.editor.undo();
      ui.editor.startReconnect("wire", "from");
    });
    const before = ui.editor;

    act(() => ui.editor.updatePart("a", { [axis]: value, label: "rejected" }));

    expect(ui.editor.error).toContain("座標");
    expect(ui.editor.document).toBe(before.document);
    expect(ui.editor.selection).toBe(before.selection);
    expect(ui.editor.pendingEndpoint).toBe(before.pendingEndpoint);
    expect(ui.editor.pendingWire).toBe(before.pendingWire);
    expect(ui.editor.documentVersion).toBe(before.documentVersion);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    expect(parseCircuitDocument(ui.editor.exportDocument())).toEqual({ ok: true, document: before.document });
  });

  it.each([null, 45, Number.NaN])("rejects an unsavable rotation (%s) even when it looks like the default", (rotation) => {
    const ui = mount();
    const initial = ui.editor.document;
    const patch: Partial<CircuitPart> = {};
    Object.defineProperty(patch, "rotation", { value: rotation, enumerable: true });

    act(() => ui.editor.updatePart("a", patch));

    expect(ui.editor.error).toContain("回転");
    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
  });

  it.each((["x", "y"] as const).flatMap((axis) =>
    [-MAX_WIRE_COORDINATE, MAX_WIRE_COORDINATE].map((value) => ({ axis, value }))))
  ("keeps the exact $axis coordinate boundary ($value) savable and undoable", ({ axis, value }) => {
    const ui = mount();
    const initial = ui.editor.document;

    act(() => ui.editor.updatePart("a", { [axis]: value }));

    expect(ui.editor.error).toBeNull();
    expect(ui.editor.document.parts[0]?.[axis]).toBe(value);
    expect(parseCircuitDocument(ui.editor.exportDocument())).toEqual({ ok: true, document: ui.editor.document });
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(initial);
    act(() => ui.editor.redo());
    expect(ui.editor.document.parts[0]?.[axis]).toBe(value);
  });

  it.each([10, 22])("uses the same captured patch for change detection, storage, and history (%s Ω)", (resistanceOhms) => {
    const ui = mount();
    act(() => { ui.editor.setTitle("redo"); ui.editor.undo(); });
    const initial = ui.editor.document;
    let reads = 0;
    const patch = {
      get resistanceOhms() { reads += 1; return reads === 1 ? resistanceOhms : resistanceOhms === 10 ? 22 : 10; },
    };

    act(() => ui.editor.updatePart("a", patch));

    expect(ui.editor.document.parts[0]?.resistanceOhms).toBe(resistanceOhms);
    expect(reads).toBe(1);
    if (resistanceOhms === 10) {
      expect(ui.editor.document).toBe(initial);
      expect(ui.editor.canUndo).toBe(false);
      expect(ui.editor.canRedo).toBe(true);
    } else {
      const changed = ui.editor.document;
      expect(ui.editor.canRedo).toBe(false);
      act(() => ui.editor.undo());
      expect(ui.editor.document).toBe(initial);
      act(() => ui.editor.redo());
      expect(ui.editor.document).toBe(changed);
    }
  });

  it.each([
    { field: "id", patch: { id: "renamed", label: "rejected" } },
    { field: "kind", patch: { kind: "ground", label: "rejected" } },
  ] as const)("rejects a changed $field without altering references, editor state, or history", ({ patch }) => {
    const ui = mount();
    const initial = ui.editor.document;
    act(() => {
      ui.editor.setTitle("before");
      ui.editor.endEdit();
      ui.editor.setTitle("redo");
      ui.editor.undo();
      ui.editor.startConnection({ partId: "a", terminal: "a" });
      ui.editor.selectPart("a");
    });
    const before = ui.editor;

    act(() => ui.editor.updatePart("a", patch));

    expect(ui.editor.error).toContain("変更できません");
    expect(ui.editor.document).toBe(before.document);
    expect(ui.editor.selection).toBe(before.selection);
    expect(ui.editor.pendingEndpoint).toBe(before.pendingEndpoint);
    expect(ui.editor.pendingWire).toBe(before.pendingWire);
    expect(ui.editor.documentVersion).toBe(before.documentVersion);
    expect(ui.editor.canUndo).toBe(true);
    expect(ui.editor.canRedo).toBe(true);
    expect(parseCircuitDocument(ui.editor.exportDocument())).toEqual({ ok: true, document: before.document });
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("redo");
    act(() => { ui.editor.undo(); ui.editor.undo(); });
    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
  });

  it("keeps a pending reconnect when a structural patch is rejected", () => {
    const ui = mount();
    act(() => ui.editor.startReconnect("wire", "from"));
    const before = ui.editor;
    const patch: Partial<CircuitPart> = { id: "renamed" };

    act(() => ui.editor.updatePart("a", patch));

    expect(ui.editor.error).toContain("変更できません");
    expect(ui.editor.document).toBe(before.document);
    expect(ui.editor.selection).toBe(before.selection);
    expect(ui.editor.pendingEndpoint).toBe(before.pendingEndpoint);
    expect(ui.editor.pendingWire).toBe(before.pendingWire);
    expect(ui.editor.documentVersion).toBe(before.documentVersion);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(false);
  });

  it("accepts a full property patch when ID and kind are unchanged", () => {
    const ui = mount();
    const initial = ui.editor.document;
    const patch = { ...initial.parts[0]!, label: "updated", resistanceOhms: 22 };

    act(() => ui.editor.updatePart("a", patch));

    expect(ui.editor.error).toBeNull();
    expect(ui.editor.document.parts[0]).toEqual(patch);
    expect(ui.editor.document.wires).toBe(initial.wires);
    expect(parseCircuitDocument(ui.editor.exportDocument())).toEqual({ ok: true, document: ui.editor.document });
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(initial);
    act(() => ui.editor.redo());
    expect(ui.editor.document.parts[0]).toEqual(patch);
  });

  it("keeps redo history for an unchanged ID and kind patch", () => {
    const ui = mount();
    const initial = ui.editor.document;
    act(() => { ui.editor.setTitle("redo"); ui.editor.undo(); });
    const patch: Partial<CircuitPart> = { id: "a", kind: "resistor" };

    act(() => ui.editor.updatePart("a", patch));

    expect(ui.editor.error).toBeNull();
    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
  });
});

describe("batched editor commands", () => {
  it.each([true, false])("composes document, property, selection and movement commands (batched=%s)", (batched) => {
    const ui = mount();
    const commands = [
      () => ui.editor.setTitle("changed"),
      () => ui.editor.updatePart("a", { resistanceOhms: 22 }),
      () => ui.editor.updatePart("a", { label: "edited" }),
      () => ui.editor.selectPart("a"),
      () => ui.editor.selectPart("b", true),
      () => ui.editor.movePart("a", 0, 1),
      () => ui.editor.movePart("a", 0, 1),
      () => ui.editor.endEdit(),
    ];
    if (batched) { act(() => { for (const command of commands) { command(); } }); }
    else { for (const command of commands) { act(command); } }

    expect(ui.editor.document.title).toBe("changed");
    expect(ui.editor.document.parts[0]).toMatchObject({ resistanceOhms: 22, label: "edited", y: 2 });
    expect(ui.editor.document.parts[1]?.y).toBe(2);
    expect(ui.editor.selection.parts).toEqual(["a", "b"]);
    act(() => ui.editor.undo());
    expect(ui.editor.document.parts.map((part) => part.y)).toEqual([0, 0]);
    expect(ui.editor.document.title).toBe("changed");
  });

  it("keeps both additions, assigns unique IDs, and exports the latest document within one batch", () => {
    const ui = mount({ title: "empty", parts: [], wires: [] });
    let serialized = "";
    act(() => {
      ui.editor.add("resistor", { x: 0, y: 0 });
      ui.editor.add("battery", { x: 10, y: 0 });
      ui.editor.selectAll();
      ui.editor.movePart("part-1", 0, 1);
      ui.editor.endEdit();
      serialized = ui.editor.exportDocument();
    });
    expect(ui.editor.document.parts.map((part) => part.kind)).toEqual(["resistor", "battery"]);
    expect(ui.editor.document.parts.map((part) => part.id)).toEqual(["part-1", "part-2"]);
    expect(ui.editor.document.parts.map((part) => part.y)).toEqual([1, 1]);
    expect(parseCircuitDocument(serialized)).toEqual({ ok: true, document: ui.editor.document });
  });

  it("composes repeated undo and redo commands using the latest history", () => {
    const ui = mount();
    act(() => {
      ui.editor.setTitle("changed");
      ui.editor.updatePart("a", { resistanceOhms: 22 });
      ui.editor.undo();
      ui.editor.undo();
    });
    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => { ui.editor.redo(); ui.editor.redo(); });
    expect(ui.editor.document.title).toBe("changed");
    expect(ui.editor.document.parts[0]?.resistanceOhms).toBe(22);
    expect(ui.editor.canRedo).toBe(false);
  });

  it.each([false, true])("preserves redo history when rotating only junctions or an empty selection (batched=%s)", (batched) => {
    const ui = mount({
      title: "initial",
      parts: [{ id: "junction", kind: "junction", x: 0, y: 0, label: "接続点" }],
      wires: [],
    });
    const initial = ui.editor.document;
    act(() => ui.editor.setTitle("redo"));
    const redoDocument = ui.editor.document;
    act(() => ui.editor.undo());
    const commands = [
      () => ui.editor.selectPart("junction"),
      () => ui.editor.rotateSelected(),
      () => ui.editor.clearSelection(),
      () => ui.editor.rotateSelected(),
    ];
    if (batched) { act(() => { for (const command of commands) { command(); } }); }
    else { for (const command of commands) { act(command); } }

    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(redoDocument);
  });

  it.each([false, true])("preserves undo and redo history when moving an unknown part (batched=%s)", (batched) => {
    const ui = mount();
    const initial = ui.editor.document;
    act(() => ui.editor.setTitle("redo"));
    const redoDocument = ui.editor.document;
    act(() => ui.editor.undo());
    const commands = [
      () => ui.editor.movePart("missing", 1, 0),
      () => ui.editor.movePart("missing", 0, 1),
      () => ui.editor.endEdit(),
    ];
    if (batched) { act(() => { for (const command of commands) { command(); } }); }
    else { for (const command of commands) { act(command); } }

    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(redoDocument);
  });

  it("uses the current selection and clipboard for a select, cut and paste sequence", () => {
    const ui = mount();
    act(() => {
      ui.editor.selectAll();
      ui.editor.cutSelected();
      ui.editor.paste();
    });
    expect(ui.editor.document.parts).toHaveLength(2);
    expect(ui.editor.document.wires).toHaveLength(1);
    expect(ui.editor.selection.parts).toHaveLength(2);
    expect(ui.editor.canPaste).toBe(true);
    act(() => { ui.editor.undo(); ui.editor.undo(); });
    expect(ui.editor.document).toEqual(fixture());
  });

  it("connects and reconnects terminals without requiring a render between commands", () => {
    const ui = mount();
    act(() => {
      ui.editor.chooseTerminal({ partId: "a", terminal: "a" });
      ui.editor.chooseTerminal({ partId: "b", terminal: "b" });
    });
    expect(ui.editor.document.wires).toHaveLength(2);
    expect(ui.editor.pendingEndpoint).toBeNull();
    const added = ui.editor.document.wires[1]!;
    act(() => {
      ui.editor.startReconnect(added.id, "to");
      ui.editor.chooseTerminal({ partId: "b", terminal: "a" });
    });
    expect(ui.editor.document.wires[1]?.to).toEqual({ partId: "b", terminal: "a" });
    expect(ui.editor.pendingWire).toBeNull();
    act(() => {
      ui.editor.chooseTerminal({ partId: "a", terminal: "a" });
      ui.editor.chooseTerminal({ partId: "a", terminal: "a" });
    });
    expect(ui.editor.document.wires).toHaveLength(2);
    expect(ui.editor.pendingEndpoint).toBeNull();
  });

  it("restores a cancelled batched move and its preexisting redo history", () => {
    const ui = mount();
    act(() => ui.editor.setTitle("redo"));
    act(() => ui.editor.undo());
    act(() => {
      ui.editor.selectAll();
      ui.editor.movePart("a", 0, 1);
      ui.editor.movePart("a", 0, 1);
      ui.editor.cancelMove("a");
    });
    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("redo");
  });

  it("clears a rejected movement error when cancelling the drag", () => {
    const ui = mount();
    act(() => {
      ui.editor.selectPart("a");
      ui.editor.movePart("a", 0, 1);
      ui.editor.movePart("a", 12, -1);
    });
    expect(ui.editor.error).not.toBeNull();

    act(() => ui.editor.cancelMove("a"));

    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.error).toBeNull();
    expect(ui.editor.canUndo).toBe(false);
  });

  it("uses current data when a caller retains commands from an earlier render", () => {
    const ui = mount();
    const retained = ui.editor;
    act(() => retained.setTitle("changed"));
    act(() => retained.updatePart("a", { resistanceOhms: 22 }));
    act(() => retained.selectPart("b"));
    act(() => retained.movePart("b", 0, 2));
    expect(ui.editor.document.title).toBe("changed");
    expect(ui.editor.document.parts[0]?.resistanceOhms).toBe(22);
    expect(ui.editor.document.parts[1]?.y).toBe(2);
  });
});
