// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { createExampleCircuit } from "../../circuit-model.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const mount = setupEditorHarness();

function required(container: ParentNode, selector: string): Element {
  const element = container.querySelector(selector);
  if (!element) { throw new Error(`Missing element: ${selector}`); }
  return element;
}

function click(target: Element, detail = 0) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail, clientX: 100, clientY: 100 })));
}

function pointer(target: Element, type: string) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  act(() => target.dispatchEvent(event));
}

function pointerClick(surface: Element, target: Element) {
  let captured = false;
  Object.defineProperties(surface, {
    setPointerCapture: { configurable: true, value: () => { captured = true; } },
    hasPointerCapture: { configurable: true, value: () => captured },
    releasePointerCapture: { configurable: true, value: () => {
      captured = false;
      pointer(surface, "lostpointercapture");
    } },
  });
  pointer(target, "pointerdown");
  const releaseTarget = captured ? surface : target;
  pointer(releaseTarget, "pointerup");
  click(releaseTarget, 1);
}

describe("editor preview pointer activation", () => {
  it.each(["select", "pan"])("toggles a preview switch after editing with the %s tool", async (tool) => {
    const ui = mount(createExampleCircuit());
    if (tool === "pan") { click(required(ui.container, '[aria-label="移動ツール"]')); }
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    const surface = required(ui.container, ".circuit-board__surface");
    const part = required(ui.container, '.circuit-board__part[data-kind="switch"]');
    vi.useFakeTimers();
    try {
      pointerClick(surface, required(part, 'path[d="M -9 0 L 9 0"]'));
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(part.getAttribute("aria-pressed")).toBe("false");
      expect(surface.getAttribute("data-panning")).toBe("false");
      expect(ui.editor.document.parts.find((item) => item.kind === "switch")?.initiallyClosed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each(["select", "pan"])("opens preview properties after editing with the %s tool", (tool) => {
    const ui = mount(createExampleCircuit());
    if (tool === "pan") { click(required(ui.container, '[aria-label="移動ツール"]')); }
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    const surface = required(ui.container, ".circuit-board__surface");
    pointerClick(surface, required(ui.container, '.circuit-board__part[data-kind="resistor"] .circuit-board__symbol path'));
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview-panel")).toBe("open");
    expect(required(ui.container, '.circuit-preview-dialog [data-slot="dialog-title"]').textContent).toBe("抵抗");
  });
});
