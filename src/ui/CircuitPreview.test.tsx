// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyCircuit, createExampleCircuit } from "../circuit-model.js";
import { CircuitPreview } from "./preset.js";

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
});

function mount(children: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(children));
  mounted.push({ root, container });
  return container;
}

function required(container: ParentNode, selector: string) {
  const element = container.querySelector(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

describe("embedded circuit preview", () => {
  it("renders directly in a lesson and stays read-only after Escape and editor shortcuts", () => {
    const container = mount(<CircuitPreview initialDocument={createExampleCircuit()} />);
    const preview = required(container, '[aria-label="回路プレビュー"]');
    expect(preview.tagName).toBe("SECTION");
    expect(container.querySelector("main, .circuit-editor__preview-toggle, .circuit-editor__left, .circuit-editor__right")).toBeNull();
    for (const key of ["Escape", "1", "Delete"]) {
      act(() => preview.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    }
    expect(required(container, ".circuit-board").getAttribute("data-read-only")).toBe("true");
    expect(container.querySelectorAll(".circuit-board__part")).toHaveLength(4);
  });

  it("keeps experiments independent when multiple blocks share the same source document", () => {
    const initialDocument = createExampleCircuit();
    const original = structuredClone(initialDocument);
    const container = mount(<><CircuitPreview initialDocument={initialDocument} /><CircuitPreview initialDocument={initialDocument} /></>);
    const [first, second] = container.querySelectorAll(".circuit-editor");
    const firstSwitch = required(first, '.circuit-preview-parts__card[data-kind="switch"] .circuit-preview-parts__switch');
    const secondSwitch = required(second, '.circuit-preview-parts__card[data-kind="switch"] .circuit-preview-parts__switch');
    expect(firstSwitch.getAttribute("aria-pressed")).toBe("true");
    act(() => firstSwitch.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(firstSwitch.getAttribute("aria-pressed")).toBe("false");
    expect(secondSwitch.getAttribute("aria-pressed")).toBe("true");
    expect(required(first, '.circuit-board__part[data-kind="switch"]').getAttribute("aria-pressed")).toBe("false");
    expect(required(first, ".circuit-analysis").getAttribute("data-status")).toBe("open");
    expect(required(second, ".circuit-analysis").getAttribute("data-status")).toBe("closed");
    expect(initialDocument).toEqual(original);
  });

  it("updates live readings when a part card toggles a switch", () => {
    const container = mount(<CircuitPreview initialDocument={createExampleCircuit()} />);
    const preview = required(container, ".circuit-editor");
    const switchControl = required(preview, '.circuit-preview-parts__card[data-kind="switch"] .circuit-preview-parts__switch');
    const resistorReadings = required(preview, '.circuit-preview-parts__card[data-part-id="part-2"] .circuit-preview-parts__readings');
    const initialReadings = resistorReadings.textContent;

    expect(required(preview, ".circuit-analysis").getAttribute("data-status")).toBe("closed");
    expect(switchControl.getAttribute("aria-pressed")).toBe("true");
    act(() => switchControl.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(required(preview, ".circuit-analysis").getAttribute("data-status")).toBe("open");
    expect(required(preview, '.circuit-preview-parts__card[data-kind="switch"] .circuit-preview-parts__switch').getAttribute("aria-pressed")).toBe("false");
    expect(required(preview, '.circuit-preview-parts__card[data-part-id="part-2"] .circuit-preview-parts__readings').textContent).not.toBe(initialReadings);
  });

  it("restores the initial values from the always-visible parts section", () => {
    const container = mount(<CircuitPreview initialDocument={createExampleCircuit()} />);
    const preview = required(container, ".circuit-editor");
    const switchControl = required(preview, '.circuit-preview-parts__card[data-kind="switch"] .circuit-preview-parts__switch');
    act(() => switchControl.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(required(preview, ".circuit-analysis").getAttribute("data-status")).toBe("open");

    const resetButton = required(preview, ".circuit-preview-parts__heading button") as HTMLButtonElement;
    expect(resetButton.disabled).toBe(false);
    act(() => resetButton.click());

    expect(required(preview, '.circuit-preview-parts__card[data-kind="switch"]').getAttribute("data-changed")).toBe("false");
    expect(required(preview, '.circuit-preview-parts__card[data-kind="switch"] .circuit-preview-parts__switch').getAttribute("aria-pressed")).toBe("true");
    expect(required(preview, ".circuit-analysis").getAttribute("data-status")).toBe("closed");
    expect((required(preview, ".circuit-preview-parts__heading button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the detail dialog for the selected part card", () => {
    const container = mount(<CircuitPreview initialDocument={createExampleCircuit()} />);
    const preview = required(container, ".circuit-editor");
    const detailButton = required(preview, '.circuit-preview-parts__card[data-part-id="part-2"] .circuit-preview-parts__inspect');

    act(() => detailButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect((required(preview, ".circuit-editor__preview-panel-toggle") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("true");
    expect(required(preview, '[role="dialog"] .circuit-ui-dialog-title').textContent).toBe("抵抗");
  });

  it("shows the empty-circuit message without rendering part cards", () => {
    const container = mount(<CircuitPreview initialDocument={createEmptyCircuit("空の回路")} />);
    const preview = required(container, ".circuit-editor");

    expect(required(preview, ".circuit-editor__empty-canvas h2").textContent).toBe("表示する部品がありません");
    expect(preview.querySelector(".circuit-preview-parts")).toBeNull();
    expect(required(preview, ".circuit-analysis").getAttribute("data-status")).toBe("empty");
  });

  it("does not label a lamp as off when the circuit analysis is invalid", () => {
    const document = createExampleCircuit();
    const invalidDocument = {
      ...document,
      parts: document.parts.map((part) => part.kind === "resistor" ? { ...part, resistanceOhms: 0 } : part),
    };
    const container = mount(<CircuitPreview initialDocument={invalidDocument} />);
    const preview = required(container, ".circuit-editor");
    const bulbStatus = required(preview, '.circuit-preview-parts__card[data-kind="bulb"] .circuit-preview-parts__light');

    expect(required(preview, ".circuit-analysis").getAttribute("data-status")).toBe("invalid");
    expect(bulbStatus.textContent).toBe("点灯状態未計測");
    expect(bulbStatus.textContent).not.toBe("消灯");
  });

  it("leaves ordinary wheel events to the page while retaining modified-wheel zoom", async () => {
    const container = mount(<CircuitPreview initialDocument={createExampleCircuit()} />);
    const viewport = required(container, ".circuit-board__viewport");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 320));
    const surface = required(container, ".circuit-board__surface");
    const initialView = surface.getAttribute("viewBox");
    const scroll = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 60 });
    act(() => viewport.dispatchEvent(scroll));
    expect(scroll.defaultPrevented).toBe(false);
    expect(surface.getAttribute("viewBox")).toBe(initialView);
    const zoom = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 60, ctrlKey: true });
    await act(async () => {
      viewport.dispatchEvent(zoom);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(zoom.defaultPrevented).toBe(true);
    expect(surface.getAttribute("viewBox")).not.toBe(initialView);
  });
});
