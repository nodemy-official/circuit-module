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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(kind: "ac" | "charging") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let controller: CircuitEditorController | undefined;
  act(() => root.render(<CircuitEditor initialDocument={createCircuitExample(kind)}>{(editor) => {
    controller = editor;
    return <CircuitEditorLayout />;
  }}</CircuitEditor>));
  mounted.push({ root, container });
  return {
    container,
    get editor() { if (!controller) { throw new Error("Editor missing"); } return controller; },
  };
}

function required(container: ParentNode, selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

function buttonWithText(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text);
  if (!button) { throw new Error(`Missing button ${text}`); }
  return button;
}

function click(element: Element) { act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); }

describe("analysis controls and waveform integration", () => {
  it("shows waveform learning controls without steady-state settings in the Waveforms tab", () => {
    const ui = mount("charging");
    click(required(ui.container, '[data-sidebar-tab="waveforms"]'));

    const transient = ui.container.querySelector<HTMLDetailsElement>(".circuit-editor__right .circuit-transient");
    if (!transient) { throw new Error("Missing waveform details"); }
    const simulation = transient.closest(".circuit-simulation");
    expect(transient.open).toBe(true);
    expect(simulation?.firstElementChild?.classList.contains("circuit-panel__heading")).not.toBe(true);
    expect(simulation?.querySelector("select")).toBeNull();
    expect(simulation?.getAttribute("aria-label")).toBe("解析結果と学習ビュー");
  });

  it("changes AC/DC analysis from the controls without modifying the circuit", () => {
    const ui = mount("ac");
    const original = ui.editor.document;
    expect(ui.editor.analysis.mode).toBe("ac");
    expect(ui.container.textContent).toContain("電圧・電流は実効値");
    const select = required(ui.container, '.circuit-simulation select');
    act(() => {
      (select as HTMLSelectElement).value = "dc";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ui.editor.analysis.mode).toBe("dc");
    expect(ui.editor.analysis.parts.source.voltageVolts).toBe(0);
    expect(ui.editor.document).toBe(original);
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    expect(ui.container.textContent).not.toContain("交流 1000 Hz");
  });

  it("computes charging waveforms and hides stale results after a component edit", () => {
    const ui = mount("charging");
    click(buttonWithText(ui.container, "波形を計算"));
    expect(ui.container.querySelector(".circuit-waveform__trace")).not.toBeNull();
    const capacitor = ui.editor.document.parts.find((part) => part.kind === "capacitor");
    expect(capacitor).toBeDefined();
    if (!capacitor) { throw new Error("Missing charging capacitor"); }
    const capacitorRow = required(ui.container, `.circuit-transient__readings tr[data-part-id="${capacitor.id}"]`);
    expect(capacitorRow.querySelector("td")?.textContent).toBe("0");
    expect(capacitorRow.textContent).toContain("電圧（A−B）");
    expect(required(ui.container, ".circuit-transient__time-output").textContent).toBe("0 s");
    expect(required(ui.container, '.circuit-transient__time-controls input[type="range"]').getAttribute("max")).toBe("400");
    act(() => ui.editor.updatePart("resistor", { resistanceOhms: 2000 }));
    expect(ui.container.querySelector(".circuit-waveform__trace")).toBeNull();
    expect(ui.container.textContent).toContain("波形を再計算してください");
    click(buttonWithText(ui.container, "波形を計算"));
    expect(ui.container.querySelector(".circuit-waveform__trace")).not.toBeNull();
  });

  it("opens an analog sample as one undoable document replacement", () => {
    const ui = mount("charging");
    const original = ui.editor.document;
    act(() => ui.editor.openExample("opamp"));
    expect(ui.editor.document.parts.some((part) => part.kind === "op-amp")).toBe(true);
    expect(ui.editor.analysis.parts.opamp.voltageVolts).toBeCloseTo(2, 3);
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(original);
  });
});
