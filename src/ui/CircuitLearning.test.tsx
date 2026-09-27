// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitExample } from "../circuit-examples.js";
import { CircuitEditor } from "./CircuitEditor.js";
import { CircuitEditorLayout } from "./CircuitEditorLayout.js";
import type { CircuitEditorController } from "./useCircuitEditor.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media }));
});
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function mount(initialDocument = createCircuitExample("charging")) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let controller: CircuitEditorController | undefined;
  act(() => root.render(<CircuitEditor initialDocument={initialDocument}>{(editor) => {
    controller = editor; return <CircuitEditorLayout />;
  }}</CircuitEditor>));
  mounted.push({ root, container });
  return { container, get editor() { if (!controller) { throw new Error("Missing editor"); } return controller; } };
}

function required<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

function click(element: Element) { act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); }
function clickButton(container: ParentNode, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) { throw new Error(`Missing ${label}`); }
  click(button);
}
function setRange(input: HTMLInputElement, value: number) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("learning visualization integration", () => {
  it("moves board potentials and energy together, then drops stale sample values after edits", () => {
    const ui = mount();
    click(required(ui.container, '.circuit-potential__toggle input'));
    const voltage = () => Number(required(ui.container, '[data-potential-wire="wire-2"]').getAttribute("data-voltage"));
    expect(voltage()).toBeCloseTo(5, 6);
    clickButton(ui.container, "波形を計算");
    expect(voltage()).toBeCloseTo(0, 8);
    expect(ui.container.querySelector('.circuit-potential__time')?.textContent).toContain("瞬時値");
    expect(required(ui.container, '[data-energy-joules]').getAttribute("data-energy-joules")).toBe("0");
    setRange(required<HTMLInputElement>(ui.container, '.circuit-transient__time-controls input[type="range"]'), 40);
    expect(voltage()).toBeGreaterThan(3);
    expect(voltage()).toBeLessThan(3.3);
    expect(Number(required(ui.container, '[data-energy-joules]').getAttribute("data-energy-joules"))).toBeGreaterThan(4e-6);
    act(() => ui.editor.updatePart("resistor", { resistanceOhms: 2000 }));
    expect(ui.container.querySelector('.circuit-potential__time')).toBeNull();
    expect(ui.container.querySelector('.circuit-waveform__trace')).toBeNull();
    expect(voltage()).toBeCloseTo(5, 6);
  });

  it("keeps preview waveforms beside the board and overlays the original circuit without editing it", () => {
    const ui = mount();
    const original = ui.editor.document;
    click(required(ui.container, '.circuit-editor__preview-toggle'));
    const learning = required(ui.container, '.circuit-editor__learning');
    clickButton(learning, "波形を計算");
    expect(learning.querySelectorAll('[data-source="baseline"].circuit-waveform__trace').length).toBeGreaterThan(0);
    expect(learning.querySelector('.circuit-comparison[data-comparison-state="ready"]')).not.toBeNull();
    expect(ui.container.querySelector('.circuit-potential__time')).not.toBeNull();
    expect(ui.editor.document).toBe(original);
    click(required(ui.container, '.circuit-editor__preview-toggle'));
    expect(ui.container.querySelector('.circuit-potential__time')).toBeNull();
  });

  it("shows a live differential voltage when the reference probe is changed", () => {
    const ui = mount();
    const reference = required<HTMLSelectElement>(ui.container, '.circuit-potential select');
    const before = required(ui.container, '.circuit-potential__difference').textContent;
    const selected = required<HTMLSelectElement>(ui.container, '.circuit-potential select:nth-of-type(2)');
    act(() => { reference.value = selected.value; reference.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(required(ui.container, '.circuit-potential__difference').textContent).toContain("0 V");
    expect(before).not.toContain("：0 V");
  });

  it("omits phase labels for zero AC potential and terminal current", () => {
    const document = createCircuitExample("ac");
    const source = document.parts.find((part) => part.id === "source");
    if (!source) { throw new Error("Expected the AC example to contain a source"); }
    source.voltageVolts = 0;
    const ui = mount(document);
    const details = required(ui.container, ".circuit-potential__difference").closest("details");

    expect(details?.textContent).toContain("0 V");
    expect(details?.textContent).toContain("0 A");
    expect(details?.textContent).not.toContain("∠0°");
  });
});
