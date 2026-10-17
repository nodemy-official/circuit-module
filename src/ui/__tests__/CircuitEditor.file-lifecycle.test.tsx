// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExampleCircuit } from "../../circuit-model.js";
import { serializeCircuitDocument } from "../../circuit-serialization.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitEditorLayout } from "../CircuitEditorLayout.js";
import type { CircuitEditorController } from "../useCircuitEditor.js";

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
  vi.unstubAllGlobals();
});

function mount() {
  const initialDocument = createExampleCircuit();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let latest: CircuitEditorController | undefined;
  const render = (visible: boolean) => act(() => root.render(
    <StrictMode><CircuitEditor initialDocument={initialDocument}>{(editor) => {
      latest = editor;
      return visible ? <CircuitEditorLayout /> : null;
    }}</CircuitEditor></StrictMode>,
  ));
  render(true);
  return {
    container,
    render,
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

function beginRead(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  let resolve: (json: string) => void = () => {};
  Object.defineProperty(input, "files", { configurable: true, value: [{ size: 100,
    text: () => new Promise<string>((finish) => { resolve = finish; }),
  }] });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  return (json: string) => act(async () => resolve(json));
}

it.each(["valid", "invalid"])("ignores a %s file completion after its layout unmounts", async (kind) => {
  const ui = mount();
  const finish = beginRead(ui.container);
  ui.render(false);
  act(() => {
    ui.editor.newDocument();
    ui.editor.setTitle("作業を再開した回路");
    ui.editor.endEdit();
  });
  const resumed = ui.editor.document;
  ui.render(true);

  await finish(kind === "valid"
    ? serializeCircuitDocument({ title: "閉じた画面の読み込み", parts: [], wires: [] })
    : "{");

  expect(ui.editor.document).toBe(resumed);
  expect(ui.editor.error).toBeNull();
  expect(ui.container.querySelector('[aria-label="回路名"]')?.getAttribute("value")).toBe("作業を再開した回路");
  act(() => ui.editor.undo());
  expect(ui.editor.document.title).not.toBe(resumed.title);
  act(() => ui.editor.redo());
  expect(ui.editor.document).toBe(resumed);
});

it("keeps edits and history operations performed during an active file read available through undo", async () => {
  const ui = mount();
  const finish = beginRead(ui.container);
  act(() => {
    ui.editor.setTitle("読み込み中の編集");
    ui.editor.endEdit();
    ui.editor.updatePart("part-1", { voltageVolts: 12 });
    ui.editor.endEdit();
    ui.editor.undo();
    ui.editor.redo();
  });
  const edited = ui.editor.document;
  expect(edited.parts[0]?.voltageVolts).toBe(12);
  const imported = { title: "読み込んだ回路", parts: [], wires: [] };

  await finish(serializeCircuitDocument(imported));

  expect(ui.editor.document).toEqual(imported);
  act(() => ui.editor.undo());
  expect(ui.editor.document).toBe(edited);
  act(() => ui.editor.redo());
  expect(ui.editor.document).toEqual(imported);
});
