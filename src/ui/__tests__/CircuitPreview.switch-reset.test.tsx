// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";
import { CircuitPreviewParts } from "../CircuitPreviewParts.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function switchPart(): CircuitPart {
  return { id: "switch", kind: "switch", x: 0, y: 0, ...circuitPartCatalog.switch.defaults };
}

function mount(part: CircuitPart, view: "panel" | "parts") {
  const initialDocument = { title: "", parts: [switchPart()], wires: [] };
  const currentDocument = { ...initialDocument, parts: [part] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest = currentDocument;
  function Harness() {
    const [document, setDocument] = useState<CircuitDocument>(currentDocument);
    latest = document;
    const shared = { document, initialDocument, analysis: analyzeCircuit(document), onReset: () => setDocument(initialDocument) };
    return view === "panel"
      ? <CircuitPreviewPanel {...shared} onChange={() => {}} showReadings={false} />
      : <CircuitPreviewParts {...shared} onInspectPart={() => {}} onSwitchToggle={() => {}} />;
  }
  mounted.push({ root, container });
  act(() => root.render(<Harness />));
  if (view === "parts") { act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click()); }
  const reset = container.querySelector<HTMLButtonElement>(view === "panel"
    ? ".circuit-preview__heading button" : ".circuit-preview-parts__reset")!;
  return { container, reset, get document() { return latest; } };
}

describe.each(["panel", "parts"] as const)("%s preview switch reset", (view) => {
  it.each(["null", "string", "getter"] as const)("keeps reset available for an invalid own %s value", (malformed) => {
    const part = switchPart();
    const getter = vi.fn(() => true);
    Object.defineProperty(part, "initiallyClosed", malformed === "getter"
      ? { get: getter, enumerable: true, configurable: true }
      : { value: malformed === "null" ? null : "true", enumerable: true, configurable: true });
    const ui = mount(part, view);
    expect(analyzeCircuit(ui.document).status).toBe("invalid");
    if (view === "panel") { expect(ui.container.querySelector('[role="status"]')?.textContent).toBe("1項目を変更"); }
    expect(ui.container.querySelector('[data-part-id="switch"]')?.getAttribute("data-changed")).toBe("true");
    expect(ui.reset.disabled).toBe(false);
    expect(ui.container.querySelector('[aria-label="スイッチのON / OFF"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(ui.container.querySelector(view === "panel" ? ".circuit-preview__switch strong" : ".circuit-preview-parts__switch strong")?.textContent).toBe("値を確認");

    act(() => ui.reset.click());

    expect(ui.document.parts[0]!.initiallyClosed).toBe(true);
    expect(analyzeCircuit(ui.document).status).not.toBe("invalid");
    if (view === "panel") { expect(ui.container.querySelector('[role="status"]')?.textContent).toBe("変更なし"); }
    expect(ui.container.querySelector('[data-part-id="switch"]')?.getAttribute("data-changed")).toBe("false");
    expect(ui.reset.disabled).toBe(true);
    expect(ui.container.querySelector('[aria-label="スイッチのON / OFF"]')?.hasAttribute("aria-invalid")).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
