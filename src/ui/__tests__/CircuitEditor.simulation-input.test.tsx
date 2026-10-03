// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitInspector } from "../CircuitInspector.js";
import type { CircuitEditorController } from "../useCircuitEditor.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function fixture() {
  return createCircuitFromSpecs([
    ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
    ["load", "resistor", ["s", "return"], { resistanceOhms: 100 }],
    ["switch", "switch", ["return", "0"], { initiallyClosed: true }],
    ["ground", "ground", ["0"]],
  ], "Editable simulation inputs");
}

function mount(initialDocument: CircuitDocument, selected = "load") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | undefined;
  act(() => root.render(<CircuitEditor initialDocument={initialDocument}>{(editor) => {
    latest = editor;
    return <CircuitInspector part={editor.document.parts.find((part) => part.id === selected)} onChange={editor.updatePart} />;
  }}</CircuitEditor>));
  mounted.push({ root, container });
  return {
    container,
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

function nonEnumerable(record: object, key: string, value: unknown) {
  Object.defineProperty(record, key, { value, writable: true, configurable: true, enumerable: false });
}

function nonEnumerableDocument(document: CircuitDocument) {
  for (const record of [document, ...document.parts, ...document.wires,
    ...document.wires.flatMap((wire) => [wire.from, wire.to])]) {
    Object.setPrototypeOf(record, null);
    for (const key of Object.getOwnPropertyNames(record)) {
      nonEnumerable(record, key, Object.getOwnPropertyDescriptor(record, key)!.value);
    }
  }
}

describe("editor simulation input consistency", () => {
  it.each(["resistanceOhms", "initiallyClosed"] as const)("commits an Inspector edit equal to an absent Proxy value (%s)", (field) => {
    const document = fixture();
    const index = field === "resistanceOhms" ? 1 : 2;
    const phantom = field === "resistanceOhms" ? 1000 : false;
    Reflect.deleteProperty(document.parts[index]!, field);
    document.parts[index] = new Proxy(document.parts[index]!, {
      get(target, key, receiver) { return key === field ? phantom : Reflect.get(target, key, receiver); },
    });
    const ui = mount(document, field === "resistanceOhms" ? "load" : "switch");
    const before = field === "resistanceOhms" ? 0.9 : 0.09;
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(before);
    const input = ui.container.querySelector<HTMLInputElement>(`input[data-field="${field}"]`)!;
    if (field === "initiallyClosed") {
      expect(input.checked).toBe(true);
      act(() => input.click());
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, "1000");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const after = field === "resistanceOhms" ? 0.009 : 0;
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(after);
    expect(ui.editor.canUndo).toBe(true);
    act(() => ui.editor.undo());
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(before);
    act(() => ui.editor.redo());
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(after);
  });

  it.each(["otherNumeric", "id", "wires", "all"] as const)("preserves non-enumerable data through edits and history (%s)", (scope) => {
    const document = fixture();
    if (scope === "otherNumeric") { nonEnumerable(document.parts[1]!, "resistanceOhms", 100); }
    if (scope === "id") { nonEnumerable(document.parts[1]!, "id", "load"); }
    if (scope === "wires") { nonEnumerable(document, "wires", document.wires); }
    if (scope === "all") { nonEnumerableDocument(document); }
    const ui = mount(document);
    const wires = document.wires.length;
    act(() => ui.editor.updatePart("load", scope === "otherNumeric" ? { label: "Renamed load" } : { resistanceOhms: 200 }));
    const expected = scope === "otherNumeric" ? 0.09 : 0.045;
    expect(ui.editor.analysis.status).toBe("closed");
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(expected);
    expect(ui.editor.document.wires).toHaveLength(wires);
    act(() => ui.editor.undo());
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(0.09);
    act(() => ui.editor.redo());
    expect(ui.editor.analysis.parts.load!.currentAmps).toBe(expected);
  });
});
