// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument, CircuitEndpoint } from "../../circuit-model.js";
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
    title: "接続開始点のスナップショット",
    parts: [
      { id: "a", kind: "resistor", label: "A", x: 0, y: 0, resistanceOhms: 10 },
      { id: "b", kind: "resistor", label: "B", x: 10, y: 0, resistanceOhms: 10 },
      { id: "c", kind: "resistor", label: "C", x: 20, y: 0, resistanceOhms: 10 },
    ],
    wires: [{ id: "wire", from: { partId: "a", terminal: "b" }, to: { partId: "b", terminal: "a" } }],
  };
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  act(() => root.render(<StrictMode><CircuitEditor initialDocument={fixture()}>{(editor) => {
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

describe("editor connection endpoint snapshots", () => {
  it.each(["startConnection", "chooseTerminal"] as const)("captures the caller endpoint when starting with %s", (command) => {
    const ui = mount();
    const initial = ui.editor.document;
    const endpoint: CircuitEndpoint = { partId: "a", terminal: "a" };
    act(() => ui.editor[command](endpoint));

    endpoint.partId = "c";
    endpoint.terminal = "b";

    expect(ui.editor.pendingEndpoint).toEqual({ partId: "a", terminal: "a" });
    act(() => ui.editor.chooseTerminal({ partId: "b", terminal: "b" }));
    const connected = ui.editor.document;
    expect(connected.wires.at(-1)).toMatchObject({
      from: { partId: "a", terminal: "a" }, to: { partId: "b", terminal: "b" },
    });
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.error).toBeNull();
    expect(initial).toEqual(fixture());
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(initial);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(connected);
    expect(connected.wires.at(-1)?.from).toEqual({ partId: "a", terminal: "a" });
  });

  it.each(["from", "to"] as const)("detaches the stationary endpoint when reconnecting the %s end", (end) => {
    const ui = mount();
    const initial = ui.editor.document;
    act(() => {
      ui.editor.setTitle("変更後");
      ui.editor.startReconnect("wire", end);
    });
    const before = ui.editor.document;
    const pending = ui.editor.pendingEndpoint!;
    pending.partId = "missing";
    pending.terminal = "c";

    expect(before.wires).toEqual(fixture().wires);
    expect(initial).toEqual(fixture());
    act(() => ui.editor.chooseTerminal({ partId: "c", terminal: "a" }));
    const reconnected = ui.editor.document;
    expect(reconnected.wires[0]?.[end]).toEqual({ partId: "c", terminal: "a" });
    expect(reconnected.wires[0]?.[end === "from" ? "to" : "from"]).toEqual(fixture().wires[0]?.[end === "from" ? "to" : "from"]);
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.error).toBeNull();
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(before);
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(initial);
    act(() => { ui.editor.redo(); ui.editor.redo(); });
    expect(ui.editor.document).toBe(reconnected);
  });

  it.each(["connect", "reconnect"] as const)("keeps the document and redo history intact after cancelling a %s", (operation) => {
    const ui = mount();
    const initial = ui.editor.document;
    act(() => { ui.editor.setTitle("やり直し先"); ui.editor.undo(); });
    act(() => {
      if (operation === "connect") { ui.editor.startConnection(ui.editor.document.wires[0]!.from); }
      else { ui.editor.startReconnect("wire", "to"); }
    });
    const pending = ui.editor.pendingEndpoint!;
    pending.partId = "missing";
    pending.terminal = "c";

    act(() => ui.editor.cancelConnection());

    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.document).toEqual(fixture());
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    expect(ui.editor.error).toBeNull();
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("やり直し先");
    expect(ui.editor.document.wires).toEqual(fixture().wires);
    expect(() => ui.editor.exportDocument()).not.toThrow();
  });
});
