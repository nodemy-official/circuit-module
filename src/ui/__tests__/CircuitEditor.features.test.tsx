// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExampleCircuit, type CircuitDocument } from "../../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../../circuit-serialization.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitEditorLayout } from "../CircuitEditorLayout.js";
import { MAX_CIRCUIT_EDITOR_PARTS, type CircuitEditorController } from "../useCircuitEditor.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media }));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(initialDocument = createExampleCircuit()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  const onChange = vi.fn();
  act(() => root.render(<CircuitEditor initialDocument={initialDocument} onDocumentChange={onChange}>{(editor) => {
    latest = editor;
    return <CircuitEditorLayout />;
  }}</CircuitEditor>));
  mounted.push({ root, container });
  return {
    container,
    onChange,
    get editor() {
      if (!latest) { throw new Error("Missing controller"); }
      return latest;
    },
  };
}

function required(container: ParentNode, selector: string) {
  const element = container.querySelector(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

function click(element: Element, options: MouseEventInit = {}) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options })));
}

function command(element: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...options });
  act(() => (element.querySelector("main") ?? element).dispatchEvent(event));
  return event;
}

function part(container: ParentNode, id: string) {
  return required(container, `.circuit-board__part[data-part-id="${id}"]`);
}

function button(container: ParentNode, label: string) {
  return required(container, `button[aria-label="${label}"]`);
}

describe("selection and reuse", () => {
  it("copies a multi-selection with its internal wires, assigns fresh IDs and labels, and undoes the paste", () => {
    const ui = mount();
    click(part(ui.container, "part-2"));
    click(part(ui.container, "part-3"), { shiftKey: true });
    expect(ui.editor.selection.parts).toEqual(["part-2", "part-3"]);
    expect(required(ui.container, '[aria-label="複数選択"]').textContent).toContain("部品 2 個");
    command(ui.container, "c");
    expect(ui.editor.canPaste).toBe(true);
    command(ui.container, "v");
    expect(ui.editor.document.parts).toHaveLength(6);
    expect(ui.editor.document.wires).toHaveLength(5);
    const ids = ui.editor.selection.parts;
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("part-2");
    const copiedWire = ui.editor.document.wires.at(-1);
    expect(copiedWire && ids.includes(copiedWire.from.partId) && ids.includes(copiedWire.to.partId)).toBe(true);
    expect(new Set(ui.editor.document.parts.map((item) => item.label)).size).toBe(6);
    command(ui.container, "z");
    expect(ui.editor.document).toEqual(createExampleCircuit());
    command(ui.container, "z", { shiftKey: true });
    expect(ui.editor.document.parts).toHaveLength(6);
  });

  it("toggles mixed selections, cuts and restores them, and keeps the clipboard across undo", () => {
    const ui = mount();
    click(part(ui.container, "part-1"));
    click(part(ui.container, "part-2"), { ctrlKey: true });
    click(part(ui.container, "part-1"), { metaKey: true });
    click(required(ui.container, '[data-wire-id="wire-3"]'), { shiftKey: true });
    expect(ui.editor.selection).toEqual({ parts: ["part-2"], wires: ["wire-3"] });
    expect(ui.editor.canCut).toBe(false);
    command(ui.container, "x");
    expect(ui.editor.document).toEqual(createExampleCircuit());
    expect(ui.editor.error).toContain("両端の部品");
    click(required(ui.container, '[data-wire-id="wire-3"]'), { shiftKey: true });
    expect(ui.editor.canCut).toBe(true);
    command(ui.container, "x");
    expect(ui.editor.document.parts).toHaveLength(3);
    expect(ui.editor.document.wires).toHaveLength(2);
    command(ui.container, "z");
    expect(ui.editor.document).toEqual(createExampleCircuit());
    expect(ui.editor.canPaste).toBe(true);
    command(ui.container, "v");
    expect(ui.editor.document.parts).toHaveLength(5);
    expect(ui.editor.document.wires).toHaveLength(4);
  });

  it("moves all selected parts atomically and groups a drag into one undo", () => {
    const ui = mount();
    act(() => ui.editor.selectRange({ parts: ["part-1", "part-4"], wires: [] }));
    act(() => ui.editor.movePart("part-1", 0, 1));
    act(() => ui.editor.movePart("part-1", 0, 1));
    act(() => ui.editor.endEdit());
    expect(ui.editor.document.parts[0].y).toBe(7);
    expect(ui.editor.document.parts[3].y).toBe(15);
    command(ui.container, "z");
    expect(ui.editor.document).toEqual(createExampleCircuit());
    act(() => ui.editor.selectRange({ parts: ["part-1", "part-4"], wires: [] }));
    act(() => ui.editor.movePart("part-1", 12, 0));
    expect(ui.editor.error).toBeTruthy();
    expect(ui.editor.document).toEqual(createExampleCircuit());
    expect(ui.editor.canUndo).toBe(false);
  });

  it("selects all from the toolbar and duplicates or removes the complete circuit in one undo step", () => {
    const ui = mount();
    click(button(ui.container, "すべて選択"));
    expect(ui.editor.selection.parts).toHaveLength(4);
    expect(ui.editor.selection.wires).toHaveLength(4);
    command(ui.container, "d");
    expect(ui.editor.document.parts).toHaveLength(8);
    expect(ui.editor.document.wires).toHaveLength(8);
    click(button(ui.container, "選択した部品または導線を削除"));
    expect(ui.editor.document).toEqual(createExampleCircuit());
    command(ui.container, "z");
    expect(ui.editor.document.parts).toHaveLength(8);
  });

  it("preserves native text shortcuts and blocks edit commands during preview", () => {
    const ui = mount();
    const title = required(ui.container, 'input[aria-label="回路名"]');
    expect(command(title, "a").defaultPrevented).toBe(false);
    expect(ui.editor.selection.parts).toHaveLength(0);
    command(ui.container, "a");
    command(ui.container, "c");
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    command(ui.container, "v");
    command(ui.container, "d");
    expect(ui.editor.document.parts).toHaveLength(4);
    expect(ui.container.querySelector(".circuit-editor__file-menu")).toBeNull();
  });
});

describe("documents and diagnostics", () => {
  it("creates an empty document from the menu and restores the original with undo", () => {
    const ui = mount();
    const create = [...ui.container.querySelectorAll("button")].find((item) => item.textContent === "新しい回路");
    if (!create) { throw new Error("Missing new document button"); }
    click(create);
    expect(ui.editor.document.parts).toEqual([]);
    expect(ui.editor.document.wires).toEqual([]);
    expect(ui.editor.diagnostics).toEqual([]);
    command(ui.container, "z");
    expect(ui.editor.document).toEqual(createExampleCircuit());
  });

  it("keeps failed imports unchanged and makes successful imports undoable", () => {
    const ui = mount();
    const initial = ui.editor.document;
    act(() => { expect(ui.editor.importDocument('{"parts":false}')).toBe(false); });
    expect(ui.editor.document).toBe(initial);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.onChange).not.toHaveBeenCalled();
    act(() => ui.editor.selectAll());
    act(() => ui.editor.chooseTerminal({ partId: "part-1", terminal: "a" }));
    const imported: CircuitDocument = { title: "読み込み", parts: [], wires: [] };
    act(() => { expect(ui.editor.importDocument(serializeCircuitDocument(imported))).toBe(true); });
    expect(ui.editor.document).toEqual(imported);
    expect(ui.editor.selection).toEqual({ parts: [], wires: [] });
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.error).toBeNull();
    expect(ui.onChange).toHaveBeenCalledOnce();
    command(ui.container, "z");
    expect(ui.editor.document).toEqual(initial);
  });

  it("loads a local JSON file and reports read failures without replacing the circuit", async () => {
    const ui = mount();
    const input = required(ui.container, 'input[type="file"]');
    const imported = { title: "ファイル", parts: [], wires: [] };
    const text = vi.fn().mockResolvedValue(serializeCircuitDocument(imported));
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 100, text }] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(ui.editor.document).toEqual(imported);
    text.mockRejectedValue(new Error("read failed"));
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(ui.editor.document).toEqual(imported);
    expect(required(ui.container, '[role="alert"]').textContent).toContain("読み込めませんでした");
  });

  it("downloads a versioned file using the save shortcut", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue("blob:circuit");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const clickLink = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const ui = mount();
    act(() => ui.editor.setTitle("試験/回路"));
    const titleInput = required(ui.container, '[aria-label="回路名"]');
    expect(command(titleInput, "s").defaultPrevented).toBe(true);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(clickLink).toHaveBeenCalledOnce();
    expect(clickLink.mock.instances[0].download).toBe("試験_回路.json");
    const parsed = parseCircuitDocument(ui.editor.exportDocument());
    expect(parsed.ok && parsed.document).toEqual(ui.editor.document);
    act(() => vi.runOnlyPendingTimers());
    const fileInput = required(ui.container, 'input[type="file"]');
    const openFile = vi.spyOn(fileInput as HTMLInputElement, "click").mockImplementation(() => {});
    expect(command(titleInput, "o").defaultPrevented).toBe(true);
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("rejects oversized interactive imports without mounting or analyzing them", () => {
    const ui = mount();
    const oversized: CircuitDocument = {
      title: "大きい回路",
      parts: Array.from({ length: MAX_CIRCUIT_EDITOR_PARTS + 1 }, (_, index) => ({
        id: `resistor-${index}`, kind: "resistor", x: index * 10, y: 0, label: `R${index}`, resistanceOhms: 10,
      })),
      wires: [],
    };
    act(() => { expect(ui.editor.importDocument(serializeCircuitDocument(oversized))).toBe(false); });
    expect(ui.editor.document).toEqual(createExampleCircuit());
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.error).toContain(`部品${MAX_CIRCUIT_EDITOR_PARTS}`);
  });

  it("shows the loaded document if preview was opened while a file was being read", async () => {
    const ui = mount();
    let finishRead: (value: string) => void = () => {};
    const text = () => new Promise<string>((resolve) => { finishRead = resolve; });
    const input = required(ui.container, 'input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 100, text }] });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    expect(required(ui.container, "main").getAttribute("data-preview")).toBe("true");
    await act(async () => finishRead(serializeCircuitDocument({ title: "新しい文書", parts: [], wires: [] })));
    expect(required(ui.container, "main").getAttribute("data-preview")).toBe("false");
    expect(ui.editor.document.title).toBe("新しい文書");
    expect(ui.container.querySelectorAll(".circuit-board__part")).toHaveLength(0);
    command(ui.container, "z");
    expect(ui.editor.document).toEqual(createExampleCircuit());
  });

  it("selects the affected objects from an actionable diagnostic", () => {
    const initial = createExampleCircuit();
    initial.parts.push({ id: "isolated", kind: "resistor", x: 50, y: 10, label: "孤立抵抗", resistanceOhms: 10 });
    const ui = mount(initial);
    const issue = ui.editor.diagnostics.find((item) => item.partIds.includes("isolated"));
    if (!issue) { throw new Error("Missing diagnostic"); }
    click(required(ui.container, `.circuit-diagnostics [data-code="${issue.code}"] button`));
    expect(ui.editor.selection.parts).toContain("isolated");
    expect(part(ui.container, "isolated").getAttribute("data-selected")).toBe("true");
  });
});
