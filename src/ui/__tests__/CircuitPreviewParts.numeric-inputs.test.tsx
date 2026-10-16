// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
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

function mount(document: CircuitDocument, initialDocument: CircuitDocument, analysis = analyzeCircuit(document)) {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CircuitPreviewParts document={document} initialDocument={initialDocument} analysis={analysis}
    onInspectPart={() => {}} onSwitchToggle={() => {}} onReset={() => {}} />));
  mounted.push({ root, container });
  act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click());
  return container;
}

function circuit() {
  return createCircuitFromSpecs([
    ["source", "battery", ["s", "0"], { voltageVolts: 9, internalResistanceOhms: 0 }],
    ["load", "resistor", ["s", "0"], { resistanceOhms: 100 }],
    ["switch", "switch", ["a", "b"]],
  ], "部品一覧と解析の設定値");
}

describe("CircuitPreviewParts numeric inputs", () => {
  it.each([
    { resistance: 100, proxyResistance: 1000, changed: false },
    { resistance: 200, proxyResistance: 100, changed: true },
  ])("uses the analyzed own resistance for settings and change markers ($resistance)", ({ resistance, proxyResistance, changed }) => {
    const initialDocument = circuit();
    const document = circuit();
    const part = document.parts[1]!;
    Object.defineProperty(part, "resistanceOhms", { value: resistance, enumerable: false });
    document.parts[1] = new Proxy(part, {
      get(target, key, receiver) {
        return key === "resistanceOhms" ? proxyResistance : Reflect.get(target, key, receiver);
      },
    });
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("closed");

    const container = mount(document, initialDocument, analysis);

    const card = container.querySelector('[data-part-id="load"]')!;
    expect(card.querySelector(".circuit-preview-parts__setting strong")?.textContent).toBe(`${resistance} Ω`);
    expect(card.getAttribute("data-changed")).toBe(String(changed));
    expect(container.querySelector<HTMLButtonElement>(".circuit-preview-parts__reset")!.disabled).toBe(!changed);
  });

  it("uses the own default switch state for change markers and an unavailable reading", () => {
    const initialDocument = circuit();
    const document = circuit();
    const part = document.parts[2]!;
    Reflect.deleteProperty(part, "initiallyClosed");
    document.parts[2] = new Proxy(part, {
      get(target, key, receiver) {
        return key === "initiallyClosed" ? false : Reflect.get(target, key, receiver);
      },
    });
    const analysis: CircuitAnalysis = { ...analyzeCircuit(document), parts: {} };

    const container = mount(document, initialDocument, analysis);

    const card = container.querySelector('[data-part-id="switch"]')!;
    expect(card.getAttribute("data-changed")).toBe("false");
    expect(card.querySelector(".circuit-preview-parts__switch")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>(".circuit-preview-parts__reset")!.disabled).toBe(true);
  });
});
