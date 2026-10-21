// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { parseCircuitDocument } from "../../circuit-serialization.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitInspector } from "../CircuitInspector.js";
import type { CircuitEditorController } from "../useCircuitEditor.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); }
  vi.unstubAllGlobals();
});

function fixture(kind: "battery" | "switch", getter?: () => unknown) {
  const part: CircuitPart = { id: "part", kind, x: 3, y: 4, ...circuitPartCatalog[kind].defaults };
  Object.defineProperty(part, "label", { value: "Hidden label", enumerable: false });
  Object.defineProperty(part, "retained", { value: "own metadata", enumerable: false });
  if (kind === "battery") { Object.defineProperty(part, "internalResistanceOhms", { value: 5, enumerable: false }); }
  const key = kind === "battery" ? "voltageVolts" : "initiallyClosed";
  if (getter) { Object.defineProperty(part, key, { get: getter, enumerable: true, configurable: true }); }
  const document: CircuitDocument = { title: "Hidden document fields", parts: [part], wires: [] };
  Object.defineProperty(document, "title", { value: document.title, enumerable: false });
  Object.defineProperty(document, "wires", { value: document.wires, enumerable: false });
  return { document, part, key };
}

function mount(initialDocument: CircuitDocument, showInspector = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  mounted.push({ root, container });
  act(() => root.render(<CircuitEditor initialDocument={initialDocument}>{(editor) => {
    latest = editor;
    return showInspector ? <CircuitInspector part={editor.document.parts[0]} onChange={editor.updatePart} /> : null;
  }}</CircuitEditor>));
  return { container, get editor() { if (!latest) { throw new Error("Missing editor"); } return latest; } };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("renames an invalid hidden frozen document before repairing its label and retains history", () => {
  const resistor: CircuitPart = { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 10 };
  Object.defineProperty(resistor, "label", { value: null, enumerable: false, configurable: false, writable: false });
  Object.freeze(resistor);
  const metadata = { owner: "host" };
  const initialDocument: CircuitDocument = {
    title: "Original title",
    parts: [resistor, { id: "j", kind: "junction", label: "J", x: 10, y: 0 }],
    wires: [{ id: "w", from: { partId: "r", terminal: "b" }, to: { partId: "j", terminal: "a" } }],
  };
  Object.defineProperty(initialDocument, "retained", { value: metadata, enumerable: false });
  for (const key of Object.getOwnPropertyNames(initialDocument)) {
    Object.defineProperty(initialDocument, key, { enumerable: false, configurable: false, writable: false });
  }
  Object.freeze(initialDocument.parts);
  Object.freeze(initialDocument.wires);
  Object.freeze(initialDocument);
  const ui = mount(initialDocument, false);
  const original = ui.editor.document;
  expect(ui.editor.analysis.status).toBe("invalid");
  expect(ui.editor.diagnostics).toContainEqual(expect.objectContaining({ code: "unconnected-terminal", partIds: ["r"] }));

  act(() => ui.editor.setTitle("Renamed title"));

  expect(ui.editor.document.title).toBe("Renamed title");
  expect(ui.editor.document.parts[0]?.label).toBeNull();
  expect(ui.editor.document.wires).toEqual(initialDocument.wires);
  expect(Object.getOwnPropertyDescriptor(ui.editor.document, "retained")?.value).toBe(metadata);
  expect(ui.editor.analysis.status).toBe("invalid");
  expect(ui.editor.error).toBeNull();
  act(() => ui.editor.updatePart("r", { label: "Repaired resistor" }));
  const repaired = ui.editor.document;
  const saved = ui.editor.exportDocument();
  expect(parseCircuitDocument(saved)).toMatchObject({
    ok: true,
    document: { title: "Renamed title", parts: [{ id: "r", label: "Repaired resistor", resistanceOhms: 10 }, { id: "j" }], wires: initialDocument.wires },
  });
  expect(ui.editor.analysis.status).not.toBe("invalid");
  act(() => ui.editor.undo());
  expect(ui.editor.document.title).toBe("Renamed title");
  expect(ui.editor.document.parts[0]?.label).toBeNull();
  expect(ui.editor.analysis.status).toBe("invalid");
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(original);
  act(() => ui.editor.redo());
  expect(ui.editor.document.title).toBe("Renamed title");
  act(() => ui.editor.redo());
  expect(ui.editor.document).toBe(repaired);
  expect(ui.editor.exportDocument()).toBe(saved);
  expect(ui.editor.document.wires).toEqual(initialDocument.wires);
  expect(Object.getOwnPropertyDescriptor(ui.editor.document, "retained")?.value).toBe(metadata);
  expect(initialDocument.title).toBe("Original title");
  expect(resistor.label).toBeNull();
});

describe.each(["battery", "switch"] as const)("%s editor accessor repair", (kind) => {
  it.each(["map", "iterator", "ordinary metadata"])("normalizes editable accessors while retaining array metadata (%s)", (metadataKind) => {
    const getter = vi.fn(() => { throw new Error("Editable getters must not run"); });
    const arrayGetter = vi.fn(() => { throw new Error("Array getters must not run"); });
    const source = fixture(kind, getter);
    const metadata = { owner: "host" };
    Object.defineProperty(source.document.parts, "retained", { value: metadata, enumerable: false });
    Object.defineProperty(source.document.parts, metadataKind === "iterator" ? Symbol.iterator : metadataKind === "map" ? "map" : "unknown", { get: arrayGetter });
    const ui = mount(source.document, false);
    const before = ui.editor.document;
    expect(before.parts[0]![source.key]).toBe(kind === "battery" ? Number.NaN : null);
    expect(Object.getOwnPropertyDescriptor(before.parts, "retained")?.value).toBe(metadata);

    act(() => { ui.editor.selectPart("part"); ui.editor.movePart("part", 1, 0); ui.editor.endEdit(); });
    expect(ui.editor.document.parts[0]!.x).toBe(4);
    expect(ui.editor.analysis.status).toBe("invalid");
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(before);
    act(() => ui.editor.redo());
    expect(ui.editor.document.parts[0]![source.key]).toBe(kind === "battery" ? Number.NaN : null);
    expect(getter).not.toHaveBeenCalled();
    expect(arrayGetter).not.toHaveBeenCalled();
  });

  it("repairs through Inspector and preserves hidden own fields through undo and redo", () => {
    const getter = vi.fn(() => { throw new Error("Editable getters must not run"); });
    const source = fixture(kind, getter);
    const ui = mount(source.document);
    expect(ui.editor.analysis.status).toBe("invalid");
    const input = ui.container.querySelector<HTMLInputElement>(`input[data-field="${source.key}"]`)!;

    if (kind === "switch") { act(() => input.click()); }
    else { inputValue(input, "9"); }

    const repaired = kind === "battery" ? 9 : true;
    expect(ui.editor.document.parts[0]![source.key]).toBe(repaired);
    expect(ui.editor.analysis.status).not.toBe("invalid");
    expect(ui.editor.document.parts[0]!.label).toBe("Hidden label");
    expect(Object.getOwnPropertyDescriptor(ui.editor.document.parts[0]!, "retained")?.value).toBe("own metadata");
    if (kind === "battery") { expect(ui.editor.document.parts[0]!.internalResistanceOhms).toBe(5); }
    expect(ui.editor.document.title).toBe("Hidden document fields");
    expect(ui.editor.document.wires).toEqual([]);
    act(() => ui.editor.updatePart("part", { [source.key]: repaired }));

    act(() => ui.editor.undo());
    expect(ui.editor.analysis.status).toBe("invalid");
    expect(ui.editor.canUndo).toBe(false);
    act(() => ui.editor.redo());
    expect(ui.editor.document.parts[0]![source.key]).toBe(repaired);
    expect(ui.editor.analysis.status).not.toBe("invalid");
    expect(Object.getOwnPropertyDescriptor(source.part, source.key)?.get).toBe(getter);
    expect(getter).not.toHaveBeenCalled();
  });

  it("repairs an accessor installed after initialization even when it returns the requested value", () => {
    const source = fixture(kind);
    const ui = mount(source.document);
    const repaired = kind === "battery" ? 9 : true;
    const getter = vi.fn(() => repaired);
    const corrupted = ui.editor.document.parts[0]!;
    Object.defineProperty(corrupted, source.key, { get: getter, configurable: true, enumerable: true });

    act(() => ui.editor.updatePart("part", { [source.key]: repaired }));

    expect(ui.editor.document.parts[0]![source.key]).toBe(repaired);
    expect(ui.editor.canUndo).toBe(true);
    expect(ui.editor.analysis.status).not.toBe("invalid");
    expect(getter).not.toHaveBeenCalled();
    act(() => ui.editor.undo());
    expect(ui.editor.analysis.status).toBe("invalid");
    expect(ui.editor.document.parts[0]![source.key]).toBe(kind === "battery" ? Number.NaN : null);
    expect(Object.getOwnPropertyDescriptor(corrupted, source.key)?.get).toBe(getter);
    act(() => ui.editor.redo());
    expect(ui.editor.analysis.status).not.toBe("invalid");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["move", "rotate", "copy"] as const)("keeps an initial getter unevaluated during ordinary %s operations", (operation) => {
    const getter = vi.fn(() => { throw new Error("Editable getters must not run"); });
    const source = fixture(kind, getter);
    const ui = mount(source.document);
    act(() => {
      ui.editor.selectPart("part");
      if (operation === "move") { ui.editor.movePart("part", 1, 0); }
      if (operation === "rotate") { ui.editor.rotateSelected(); }
      if (operation === "copy") { expect(ui.editor.copySelected()).toBe(true); }
    });
    expect(ui.editor.analysis.status).toBe("invalid");
    expect(ui.editor.document.parts[0]!.label).toBe("Hidden label");
    if (operation === "move") { expect(ui.editor.document.parts[0]!.x).toBe(4); }
    if (operation === "rotate") { expect(ui.editor.document.parts[0]!.rotation).toBe(90); }
    if (operation === "copy") {
      expect(ui.editor.canPaste).toBe(true);
      act(() => ui.editor.paste());
      expect(ui.editor.document.parts).toHaveLength(1);
      expect(ui.editor.error).not.toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([true, false].flatMap((enumerable) => (["move", "rotate", "copy"] as const)
    .map((operation) => ({ operation, enumerable }))))
  ("does not revive a getter when $operation follows undoing its repair (enumerable=$enumerable)", ({ operation, enumerable }) => {
    const source = fixture(kind);
    const ui = mount(source.document);
    const corrupted = ui.editor.document.parts[0]!;
    const getter = vi.fn(() => { throw new Error("Restored getters must not run"); });
    Object.defineProperty(corrupted, source.key, { get: getter, configurable: true, enumerable });
    act(() => ui.editor.updatePart("part", { [source.key]: kind === "battery" ? 9 : true }));
    act(() => ui.editor.undo());
    expect(ui.editor.analysis.status).toBe("invalid");

    act(() => {
      ui.editor.selectPart("part");
      if (operation === "move") { ui.editor.movePart("part", 1, 0); }
      if (operation === "rotate") { ui.editor.rotateSelected(); }
      if (operation === "copy") { expect(ui.editor.copySelected()).toBe(true); }
    });

    expect(ui.editor.analysis.status).toBe("invalid");
    expect(ui.editor.document.parts[0]!.label).toBe("Hidden label");
    if (operation === "move") { expect(ui.editor.document.parts[0]!.x).toBe(4); }
    if (operation === "rotate") { expect(ui.editor.document.parts[0]!.rotation).toBe(90); }
    if (operation === "copy") {
      expect(ui.editor.canPaste).toBe(true);
      act(() => ui.editor.paste());
      expect(ui.editor.document.parts).toHaveLength(1);
      expect(ui.editor.error).not.toBeNull();
    }
    expect(Object.getOwnPropertyDescriptor(corrupted, source.key)?.get).toBe(getter);
    expect(getter).not.toHaveBeenCalled();
  });
});
