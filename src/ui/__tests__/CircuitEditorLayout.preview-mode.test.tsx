// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExampleCircuit, type CircuitDocument } from "../../circuit-model.js";
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

it("enters an isolated read-only preview when previewOnly is enabled after mounting", () => {
  const initialDocument = createExampleCircuit();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let latest: CircuitEditorController | undefined;
  const onDocumentChange = vi.fn();
  const render = (previewOnly: boolean) => act(() => root.render(
    <CircuitEditor initialDocument={initialDocument} onDocumentChange={onDocumentChange}>{(editor) => {
      latest = editor;
      return <CircuitEditorLayout previewOnly={previewOnly} />;
    }}</CircuitEditor>,
  ));
  render(false);
  expect(container.querySelector(".circuit-board")?.getAttribute("data-read-only")).toBe("false");

  render(true);

  expect(container.querySelector(".circuit-editor")?.getAttribute("data-preview")).toBe("true");
  expect(container.querySelector(".circuit-board")?.getAttribute("data-read-only")).toBe("true");
  expect(container.querySelector(".circuit-preview-parts")).not.toBeNull();
  const toggle = container.querySelector('.circuit-board__part[data-kind="switch"]')!;
  act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(latest?.document).toEqual(initialDocument);
  expect(onDocumentChange).not.toHaveBeenCalled();

  render(false);
  act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click());
  expect(container.querySelector(".circuit-board")?.getAttribute("data-read-only")).toBe("false");
  render(true);
  expect(container.querySelector('.circuit-board__part[data-kind="switch"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(latest?.document).toEqual(initialDocument);
  expect(onDocumentChange).not.toHaveBeenCalled();
});

it.each(["connection", "reconnect"])("cancels a pending %s when previewOnly is enabled after mounting", (operation) => {
  const initialDocument = createExampleCircuit();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let latest: CircuitEditorController | undefined;
  const editor = () => {
    if (!latest) { throw new Error("Missing editor"); }
    return latest;
  };
  const render = (previewOnly: boolean) => act(() => root.render(
    <CircuitEditor initialDocument={initialDocument}>{(controller) => {
      latest = controller;
      return <CircuitEditorLayout previewOnly={previewOnly} />;
    }}</CircuitEditor>,
  ));
  render(false);
  act(() => {
    if (operation === "connection") { editor().chooseTerminal({ partId: "part-1", terminal: "a" }); }
    else { editor().startReconnect(initialDocument.wires[0]!.id, "from"); }
  });
  expect(editor().pendingEndpoint).not.toBeNull();

  render(true);

  expect(editor().pendingEndpoint).toBeNull();
  expect(editor().pendingWire).toBeNull();
  render(false);
  act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click());
  expect(container.querySelector(".circuit-editor__connection")).toBeNull();
  const endpoint = { partId: "part-2", terminal: "a" } as const;
  act(() => editor().chooseTerminal(endpoint));
  expect(editor().pendingEndpoint).toEqual(endpoint);
  expect(editor().pendingWire).toBeNull();
  expect(editor().document).toEqual(initialDocument);
  expect(editor().canUndo).toBe(false);
});

it.each(["parts", "properties"])("closes the %s panel when previewOnly is enabled after mounting", (panel) => {
  const initialDocument = createExampleCircuit();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = (previewOnly: boolean) => act(() => root.render(
    <CircuitEditor initialDocument={initialDocument}><CircuitEditorLayout previewOnly={previewOnly} /></CircuitEditor>,
  ));
  render(false);
  act(() => container.querySelector<HTMLButtonElement>(`[data-panel-trigger="${panel}"]`)!.click());
  expect(container.querySelector(".circuit-editor")?.getAttribute("data-panel")).toBe(panel);

  render(true);

  expect(container.querySelector(".circuit-editor")?.getAttribute("data-panel")).toBe("none");
  expect(container.querySelector(".circuit-editor__backdrop")).toBeNull();
  render(false);
  act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click());
  expect(container.querySelector(".circuit-editor")?.getAttribute("data-panel")).toBe("none");
});

it.each([false, true].flatMap((previewOnly) => ["new", "import"].map((command) => ({ previewOnly, command }))))
("shows controller document replacements during preview ($command, previewOnly=$previewOnly)", ({ previewOnly, command }) => {
  const initialDocument = createExampleCircuit();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let latest: CircuitEditorController | undefined;
  const editor = () => {
    if (!latest) { throw new Error("Missing editor"); }
    return latest;
  };
  const onDocumentChange = vi.fn();
  act(() => root.render(<CircuitEditor initialDocument={initialDocument} onDocumentChange={onDocumentChange}>{(controller) => {
    latest = controller;
    return <CircuitEditorLayout previewOnly={previewOnly} />;
  }}</CircuitEditor>));
  if (!previewOnly) { act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click()); }
  const replacement: CircuitDocument = {
    title: "読み込んだ回路",
    parts: [{ id: "new-source", kind: "battery", label: "新しい電池", x: 0, y: 0, voltageVolts: 3 }],
    wires: [],
  };

  act(() => {
    if (command === "new") { editor().newDocument(); }
    else { expect(editor().importDocument(serializeCircuitDocument(replacement))).toBe(true); }
  });

  const displayedPartIds = () => [...container.querySelectorAll(".circuit-board__part")].map((part) => part.getAttribute("data-part-id"));
  expect(displayedPartIds()).toEqual(command === "new" ? [] : ["new-source"]);
  expect(container.querySelector(".circuit-editor")?.getAttribute("data-preview")).toBe(String(previewOnly));
  expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith(editor().document);

  act(() => editor().undo());
  expect(editor().document).toEqual(initialDocument);
  expect(displayedPartIds()).toEqual(initialDocument.parts.map((part) => part.id));
  expect(onDocumentChange).toHaveBeenCalledTimes(2);
  expect(onDocumentChange).toHaveBeenLastCalledWith(editor().document);
});
