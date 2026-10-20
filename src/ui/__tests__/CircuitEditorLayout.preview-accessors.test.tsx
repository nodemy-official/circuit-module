// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitPart } from "../../circuit-model.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitEditorLayout } from "../CircuitEditorLayout.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media }));
});
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); }
  vi.unstubAllGlobals();
});

it.each([false, true].flatMap((previewOnly) => (["resistor", "switch"] as const).map((kind) => ({ previewOnly, kind }))))
("copies, repairs, and resets an own $kind accessor without running it (previewOnly=$previewOnly)", ({ previewOnly, kind }) => {
  const part: CircuitPart = { id: "part", kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults };
  const key = kind === "switch" ? "initiallyClosed" : "resistanceOhms";
  const getter = vi.fn(() => { throw new Error("Editable setting getters must not run"); });
  Object.defineProperty(part, key, { get: getter, enumerable: true, configurable: true });
  const initialDocument = { title: "Accessor preview", parts: [part], wires: [] };
  const onDocumentChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<CircuitEditor initialDocument={initialDocument} onDocumentChange={onDocumentChange}>
    <CircuitEditorLayout previewOnly={previewOnly} previewFeatures={{ learning: false, summary: false, analysisSettings: false }} />
  </CircuitEditor>));
  if (!previewOnly) { act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click()); }
  act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click());
  if (kind === "switch") {
    const toggle = container.querySelector<HTMLButtonElement>(".circuit-preview-parts__switch")!;
    expect(toggle.getAttribute("aria-invalid")).toBe("true");
    act(() => toggle.click());
    expect(toggle.hasAttribute("aria-invalid")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__reset")!.click());
    expect(toggle.getAttribute("aria-invalid")).toBe("true");
  } else {
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__inspect")!.click());
    const input = container.querySelector<HTMLInputElement>('.circuit-preview__field input[type="number"]')!;
    expect(input.value).toBe("");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("10");
    expect(container.querySelector(".circuit-board__part-detail")?.textContent).toBe("10 Ω");
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview__heading button")!.click());
    expect(container.querySelector<HTMLInputElement>('.circuit-preview__field input[type="number"]')?.value).toBe("");
  }
  expect(getter).not.toHaveBeenCalled();
  expect(Object.getOwnPropertyDescriptor(part, key)?.get).toBe(getter);
  expect(onDocumentChange).not.toHaveBeenCalled();
});
