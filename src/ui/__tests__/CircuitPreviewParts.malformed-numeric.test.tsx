// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
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

describe("malformed numeric preview settings", () => {
  it("shows an invalid own value and keeps reset available instead of using the catalog default", () => {
    const initialPart: CircuitPart = { id: "load", kind: "resistor", x: 0, y: 0, ...circuitPartCatalog.resistor.defaults };
    const part = { ...initialPart };
    Object.defineProperty(part, "resistanceOhms", { value: null, enumerable: true });
    const document = { title: "", parts: [part], wires: [] };
    const initialDocument = { ...document, parts: [initialPart] };
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("invalid");
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const reset = vi.fn();
    act(() => root.render(<CircuitPreviewParts document={document} initialDocument={initialDocument} analysis={analysis}
      onInspectPart={() => {}} onSwitchToggle={() => {}} onReset={reset} />));
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click());

    const card = container.querySelector('[data-part-id="load"]')!;
    expect(card.querySelector(".circuit-preview-parts__setting strong")?.textContent).toBe("—");
    expect(card.getAttribute("data-changed")).toBe("true");
    const resetButton = container.querySelector<HTMLButtonElement>(".circuit-preview-parts__reset")!;
    expect(resetButton.disabled).toBe(false);
    act(() => resetButton.click());
    expect(reset).toHaveBeenCalledOnce();
  });
});
