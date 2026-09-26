// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createExampleCircuit, type CircuitDocument } from "../circuit-model.js";
import { createCircuitExample } from "../circuit-examples.js";
import { CircuitEditor } from "./CircuitEditor.js";
import { CircuitEditorLayout } from "./CircuitEditorLayout.js";
import type { CircuitEditorController } from "./useCircuitEditor.js";

const battery = { id: "battery", kind: "battery" as const, x: 3, y: 5, label: "電池" };
const junction = { id: "junction", kind: "junction" as const, x: 13, y: 5, label: "接続点" };

function fixture(withWire = false): CircuitDocument {
  return {
    title: "",
    parts: [battery, junction],
    wires: withWire
      ? [{ id: "wire-1", from: { partId: battery.id, terminal: "b" }, to: { partId: junction.id, terminal: "a" } }]
      : [],
  };
}

const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    }),
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  if (matchMediaDescriptor) { Object.defineProperty(window, "matchMedia", matchMediaDescriptor); }
  else { Reflect.deleteProperty(window, "matchMedia"); }
  if (actEnvironmentDescriptor) { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor); }
  else { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); }
});

function mount(initialDocument: CircuitDocument) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: CircuitEditorController | null = null;
  act(() => {
    root.render(
      <CircuitEditor initialDocument={initialDocument}>
        {(editor) => {
          latest = editor;
          return <CircuitEditorLayout />;
        }}
      </CircuitEditor>,
    );
  });
  mounted.push({ root, container });
  return {
    container,
    get editor(): CircuitEditorController {
      if (!latest) { throw new Error("CircuitEditor did not render"); }
      return latest;
    },
  };
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function dispatchKeyDown(target: Element, key: string, options: { shiftKey?: boolean } = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    code: key === " " ? "Space" : key,
    shiftKey: options.shiftKey,
    bubbles: true,
    cancelable: true,
  }));
}

function keyDown(target: Element, key: string, options: { shiftKey?: boolean } = {}) {
  act(() => dispatchKeyDown(target, key, options));
}

async function keyDownAndWait(target: Element, key: string) {
  await act(async () => {
    dispatchKeyDown(target, key);
    await Promise.resolve();
  });
}

async function waitForAnimationFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function changeNumber(target: Element, value: string) {
  if (!(target instanceof HTMLInputElement)) { throw new Error("Expected a number input"); }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) { throw new Error("Missing input value setter"); }
  act(() => {
    setter.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function required(container: ParentNode, selector: string): Element {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function terminal(container: ParentNode, partId: string): Element {
  return required(container, `[data-part-id="${partId}"][data-terminal="a"]`);
}

function clickTerminal(container: ParentNode, partId: string) {
  click(required(terminal(container, partId), ".circuit-board__terminal-hit"));
}

function previewToggle(container: ParentNode): HTMLButtonElement {
  const target = required(container, ".circuit-editor__preview-toggle");
  if (!(target instanceof HTMLButtonElement)) { throw new Error("Expected the preview toggle button"); }
  return target;
}

function previewDialog(container: ParentNode): HTMLElement {
  const target = container.querySelector<HTMLElement>('.circuit-preview-dialog[role="dialog"]');
  if (!target) { throw new Error("Missing preview dialog"); }
  return target;
}

function previewTab(container: ParentNode, name: "部品" | "解析設定"): HTMLButtonElement {
  const target = [...previewDialog(container).querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((tab) => tab.textContent?.trim().startsWith(name));
  if (!target) { throw new Error(`Missing preview tab: ${name}`); }
  return target;
}

function activePreviewPanel(container: ParentNode): HTMLElement {
  const target = previewDialog(container).querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
  if (!target) { throw new Error("Missing active preview tab panel"); }
  return target;
}

function sidebarTab(container: ParentNode, name: "プロパティ" | "解析" | "波形"): HTMLButtonElement {
  const target = [...container.querySelectorAll<HTMLButtonElement>('.circuit-editor__right [role="tab"]')]
    .find((tab) => tab.textContent?.trim().includes(name));
  if (!target) { throw new Error(`Missing sidebar tab: ${name}`); }
  return target;
}

function sidebarPanel(container: ParentNode, name: "プロパティ" | "解析" | "波形"): HTMLElement {
  const tab = sidebarTab(container, name);
  const panelId = tab.getAttribute("aria-controls");
  const target = [...container.querySelectorAll<HTMLElement>('.circuit-editor__right [role="tabpanel"]')]
    .find((panel) => panel.id === panelId);
  if (!target) { throw new Error(`Missing sidebar panel: ${name}`); }
  return target;
}

function activeSidebarPanel(container: ParentNode): HTMLElement {
  const target = container.querySelector<HTMLElement>('.circuit-editor__right [role="tabpanel"]:not([hidden])');
  if (!target) { throw new Error("Missing active sidebar panel"); }
  return target;
}

function previewInput(container: ParentNode, label: string): HTMLInputElement {
  const target = required(previewDialog(container), `[aria-label="${label}"]`);
  if (!(target instanceof HTMLInputElement)) { throw new Error(`Expected a number input: ${label}`); }
  return target;
}

function previewReset(container: ParentNode): HTMLButtonElement {
  const target = [...previewDialog(container).querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("この部品をリセット") || button.textContent?.includes("すべてリセット"));
  if (!(target instanceof HTMLButtonElement)) { throw new Error("Expected a preview reset button"); }
  return target;
}

function previewReading(container: ParentNode, partId: string, measurement: "voltage" | "current"): string {
  return required(
    previewDialog(container),
    `[data-part-id="${partId}"] [data-measurement="${measurement}"] dd`,
  ).textContent ?? "";
}

function previewPart(container: ParentNode, partId: string): SVGElement {
  const target = required(container, `.circuit-board__part[data-part-id="${partId}"]`);
  if (!(target instanceof SVGElement)) { throw new Error("Expected an SVG circuit part"); }
  return target;
}

function clickWithDetail(target: Element, detail: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });
}

function doubleClick(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
  });
}

function overviewPartButton(container: ParentNode, label: string): HTMLButtonElement {
  const target = [...previewDialog(container).querySelectorAll<HTMLButtonElement>(".circuit-preview-dialog__part")]
    .find((button) => button.querySelector("strong")?.textContent?.trim() === label);
  if (!target) { throw new Error(`Missing preview part: ${label}`); }
  return target;
}

function backToPreviewOverview(container: ParentNode) {
  click(required(previewDialog(container), '[aria-label="部品一覧に戻る"]'));
}

function openPreviewPart(container: ParentNode, partId: string) {
  doubleClick(previewPart(container, partId));
}

function blur(target: Element) {
  act(() => {
    target.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: false }));
  });
}

function focus(target: Element) {
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) { throw new Error("Expected a focusable element"); }
  act(() => target.focus());
}

describe("CircuitEditor interactions", () => {
  it("keeps analysis and selected part readings in the right sidebar tabs", () => {
    const ui = mount(createExampleCircuit());
    expect(required(ui.container, '.circuit-editor__right').getAttribute("aria-label")).toBe("回路の詳細");
    expect(sidebarTab(ui.container, "プロパティ").getAttribute("aria-selected")).toBe("true");
    expect(ui.container.querySelector('.circuit-editor__canvas .circuit-editor__floating-results')).toBeNull();
    expect(ui.container.querySelector('.circuit-editor__canvas .circuit-editor__selected-readings')).toBeNull();

    click(sidebarTab(ui.container, "解析"));
    expect(sidebarTab(ui.container, "解析").getAttribute("aria-selected")).toBe("true");
    expect(required(activeSidebarPanel(ui.container), ".circuit-analysis").getAttribute("data-status")).toBe("closed");
    expect(ui.container.querySelector('.circuit-editor__canvas .circuit-analysis')).toBeNull();

    click(required(ui.container, '.circuit-board__part[data-part-id="part-2"]'));
    expect(sidebarTab(ui.container, "プロパティ").getAttribute("aria-selected")).toBe("true");
    expect(required(activeSidebarPanel(ui.container), '.circuit-inspector__readings [data-measurement="voltage"] dd').textContent).toContain("V");
    expect(required(activeSidebarPanel(ui.container), '.circuit-inspector__readings [data-measurement="current"] dd').textContent).toContain("A");

    click(sidebarTab(ui.container, "解析"));
    click(required(ui.container, '[data-wire-id="wire-3"]'));
    expect(sidebarTab(ui.container, "プロパティ").getAttribute("aria-selected")).toBe("true");
    expect(required(activeSidebarPanel(ui.container), ".circuit-inspector__wire-detail").textContent).toContain("接続先");
  });

  it("supports keyboard navigation across the sidebar tabs", async () => {
    const ui = mount(createExampleCircuit());
    const properties = sidebarTab(ui.container, "プロパティ");
    focus(properties);
    await keyDownAndWait(properties, "ArrowRight");
    expect(sidebarTab(ui.container, "解析").getAttribute("aria-selected")).toBe("true");
    await keyDownAndWait(sidebarTab(ui.container, "解析"), "ArrowRight");
    expect(sidebarTab(ui.container, "波形").getAttribute("aria-selected")).toBe("true");
  });

  it("retains waveform results and cursor position when changing sidebar tabs", () => {
    const ui = mount(createCircuitExample("charging"));
    click(sidebarTab(ui.container, "波形"));
    const waveforms = sidebarPanel(ui.container, "波形");
    const calculate = [...waveforms.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "波形を計算");
    if (!calculate) { throw new Error("Missing waveform calculate button"); }
    click(calculate);

    const cursor = required(waveforms, '.circuit-transient__time-controls input[type="range"]');
    if (!(cursor instanceof HTMLInputElement)) { throw new Error("Expected the waveform time cursor"); }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) { throw new Error("Missing input value setter"); }
    act(() => {
      setter.call(cursor, "160");
      cursor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(cursor.getAttribute("data-sample-index")).toBe("160");

    click(sidebarTab(ui.container, "解析"));
    expect(waveforms.querySelector(".circuit-waveform")).not.toBeNull();
    click(sidebarTab(ui.container, "波形"));
    expect(required(activeSidebarPanel(ui.container), '.circuit-transient__time-controls input[type="range"]').getAttribute("data-sample-index")).toBe("160");
  });

  it("opens the analysis tab from the footer status control", () => {
    const ui = mount(createExampleCircuit());
    click(required(ui.container, ".circuit-editor__analysis-status"));
    expect(sidebarTab(ui.container, "解析").getAttribute("aria-selected")).toBe("true");
    expect(required(activeSidebarPanel(ui.container), ".circuit-analysis")).not.toBeNull();
  });

  it("opens the mobile detail panel from analysis status and returns focus when closed", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (media: string) => ({
        matches: media === "(max-width: 900px)",
        media,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      }),
    });
    const ui = mount(createExampleCircuit());
    const detailsTrigger = required(ui.container, '[data-panel-trigger="properties"]');
    click(required(ui.container, ".circuit-editor__analysis-status"));
    expect(required(ui.container, ".circuit-editor").getAttribute("data-panel")).toBe("properties");
    expect(sidebarTab(ui.container, "解析").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      await waitForAnimationFrame();
      await waitForAnimationFrame();
    });

    click(required(ui.container, '[aria-label="詳細パネルを閉じる"]'));
    expect(required(ui.container, ".circuit-editor").getAttribute("data-panel")).toBe("none");
    await act(async () => {
      await waitForAnimationFrame();
    });
    expect(document.activeElement).toBe(detailsTrigger);
  });

  it("opens the overview from the toolbar, exposes analysis settings, and filters a selected part", () => {
    const document: CircuitDocument = {
      ...fixture(),
      parts: [
        battery,
        junction,
        { id: "ammeter", kind: "ammeter", x: 18, y: 5, label: "電流計" },
        { id: "voltmeter", kind: "voltmeter", x: 18, y: 10, label: "電圧計" },
      ],
    };
    const ui = mount(document);
    click(previewToggle(ui.container));
    const toolbar = required(ui.container, ".circuit-editor__preview-panel-toggle");
    expect(toolbar.getAttribute("aria-haspopup")).toBe("dialog");
    click(toolbar);

    expect(required(ui.container, ".circuit-preview-dialog [data-slot=dialog-title]").textContent).toBe("解析・部品");
    expect(previewTab(ui.container, "部品").getAttribute("aria-selected")).toBe("true");
    expect(required(ui.container, ".circuit-preview-dialog .circuit-analysis")).not.toBeNull();
    expect(ui.container.querySelector(".circuit-editor__canvas .circuit-editor__floating-results")).toBeNull();
    const parts = activePreviewPanel(ui.container);
    expect([...parts.querySelectorAll(".circuit-preview-dialog__part strong")].map((part) => part.textContent)).toEqual(["電池", "接続点", "電流計", "電圧計"]);

    click(previewTab(ui.container, "解析設定"));
    expect(activePreviewPanel(ui.container).querySelector(".circuit-simulation")).not.toBeNull();
    click(previewTab(ui.container, "部品"));
    click(overviewPartButton(ui.container, "電池"));

    expect(required(ui.container, ".circuit-preview-dialog [data-slot=dialog-title]").textContent).toBe("電池");
    expect(previewInput(ui.container, "電池の電源電圧").value).toBe("");
    expect(previewInput(ui.container, "電池の内部抵抗").value).toBe("0");
    expect([...previewDialog(ui.container).querySelectorAll(".circuit-preview__controls .circuit-preview__part")]
      .map((part) => part.getAttribute("data-part-id"))).toEqual(["battery"]);
    expect([...previewDialog(ui.container).querySelectorAll(".circuit-preview__live [data-part-id]")]
      .map((part) => part.getAttribute("data-part-id"))).toEqual(["battery"]);
    expect(previewReading(ui.container, "battery", "voltage")).toBe("—");
    expect(previewReading(ui.container, "battery", "current")).toBe("—");
  });

  it("uses one instrument-specific readout for each meter part dialog", () => {
    const document: CircuitDocument = {
      ...fixture(),
      parts: [
        battery,
        junction,
        { id: "ammeter", kind: "ammeter", x: 18, y: 5, label: "電流計" },
        { id: "voltmeter", kind: "voltmeter", x: 18, y: 10, label: "電圧計" },
      ],
    };
    const ui = mount(document);
    click(previewToggle(ui.container));

    for (const [partId, meterKind] of [["ammeter", "ammeter"], ["voltmeter", "voltmeter"]] as const) {
      openPreviewPart(ui.container, partId);
      const live = required(previewDialog(ui.container), ".circuit-preview__live");
      expect(live.querySelectorAll(".circuit-meter-readout")).toHaveLength(1);
      expect(live.querySelector(`[data-meter-kind="${meterKind}"] .circuit-meter-readout__value`)).not.toBeNull();
      expect(live.querySelector(".circuit-preview__readings")).toBeNull();
      keyDown(previewDialog(ui.container), "Escape");
    }
  });

  it("keeps AC phase and reactive-power readings in a part dialog", () => {
    const acDocument = createCircuitExample("ac");
    const source = acDocument.parts.find((part) => part.kind === "ac-source");
    if (!source) { throw new Error("Expected the AC example to contain a source"); }
    const ui = mount(acDocument);
    click(previewToggle(ui.container));
    openPreviewPart(ui.container, source.id);

    const readings = required(previewDialog(ui.container), '.circuit-preview__live [data-part-id="source"]');
    expect(readings.querySelector('[data-measurement="voltage-phase"]')).not.toBeNull();
    expect(readings.querySelector('[data-measurement="current-phase"]')).not.toBeNull();
    expect(readings.querySelector('[data-measurement="reactive-power"]')).not.toBeNull();
    expect(required(previewDialog(ui.container), ".circuit-preview__measurement-note").textContent).toContain("交流解析");
  });

  it("opens only the double-clicked resistor, applies local edits, and keeps them when the dialog closes", () => {
    const initial = createExampleCircuit();
    const ui = mount(initial);
    click(previewToggle(ui.container));
    openPreviewPart(ui.container, "part-2");
    const dialog = previewDialog(ui.container);
    expect(dialog.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("抵抗");
    expect([...dialog.querySelectorAll(".circuit-preview__controls .circuit-preview__part")]
      .map((part) => part.getAttribute("data-part-id"))).toEqual(["part-2"]);
    expect(dialog.querySelector('[aria-label="抵抗の抵抗値"]')).not.toBeNull();
    expect(dialog.querySelector('[aria-label="電球の抵抗値"]')).toBeNull();
    expect(dialog.querySelector('[aria-label="電池の電源電圧"]')).toBeNull();
    expect(dialog.querySelector('.circuit-preview__live [data-part-id="part-2"]')).not.toBeNull();
    expect(dialog.querySelector('.circuit-preview__live [data-part-id="part-1"]')).toBeNull();

    changeNumber(previewInput(ui.container, "抵抗の抵抗値"), "20");
    expect(required(ui.container, '.circuit-board__part[data-part-id="part-2"] .circuit-board__part-detail').textContent).toBe("20 Ω");
    expect(ui.editor.document.parts.find((part) => part.id === "part-2")?.resistanceOhms).toBe(10);
    expect(ui.editor.document).toEqual(initial);

    const boardPart = previewPart(ui.container, "part-2");
    keyDown(previewDialog(ui.container), "Escape");
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("true");
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview-panel")).toBe("closed");
    expect(document.activeElement).toBe(boardPart);

    openPreviewPart(ui.container, "part-2");
    expect(previewInput(ui.container, "抵抗の抵抗値").value).toBe("20");
    expect(ui.editor.document).toEqual(initial);
  });

  it("resets one part without resetting another, then resets all preview values", () => {
    const initial = createExampleCircuit();
    const ui = mount(initial);
    click(previewToggle(ui.container));

    openPreviewPart(ui.container, "part-1");
    changeNumber(previewInput(ui.container, "電池の電源電圧"), "18");
    keyDown(previewDialog(ui.container), "Escape");
    openPreviewPart(ui.container, "part-2");
    changeNumber(previewInput(ui.container, "抵抗の抵抗値"), "20");
    click(previewReset(ui.container));

    expect(previewInput(ui.container, "抵抗の抵抗値").value).toBe("10");
    expect(required(ui.container, '.circuit-board__part[data-part-id="part-1"] .circuit-board__part-detail').textContent).toBe("18 V");
    expect(ui.editor.document).toEqual(initial);

    changeNumber(previewInput(ui.container, "抵抗の抵抗値"), "15");
    backToPreviewOverview(ui.container);
    const resetAll = previewReset(ui.container);
    expect(resetAll.textContent).toContain("すべてリセット");
    click(resetAll);
    expect(required(ui.container, '.circuit-board__part[data-part-id="part-1"] .circuit-board__part-detail').textContent).toBe("9 V");
    expect(required(ui.container, '.circuit-board__part[data-part-id="part-2"] .circuit-board__part-detail').textContent).toBe("10 Ω");
    expect(ui.editor.document).toEqual(initial);
  });

  it("supports overview tab arrow, Home, and End keys", async () => {
    const ui = mount(createExampleCircuit());
    click(previewToggle(ui.container));
    click(required(ui.container, ".circuit-editor__preview-panel-toggle"));
    const parts = previewTab(ui.container, "部品");
    const analysis = previewTab(ui.container, "解析設定");

    focus(parts);
    await keyDownAndWait(parts, "ArrowRight");
    expect(analysis.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(analysis);

    await keyDownAndWait(analysis, "ArrowLeft");
    expect(parts.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(parts);

    await keyDownAndWait(parts, "End");
    expect(analysis.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(analysis);

    await keyDownAndWait(analysis, "Home");
    expect(parts.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(parts);
  });

  it.each([
    ["電池の電源電圧", "9"],
    ["抵抗の抵抗値", "10"],
  ] as const)("does not apply empty, zero, or negative values for %s and restores the value on blur", (label, originalValue) => {
    const initial = createExampleCircuit();
    const ui = mount(initial);
    click(previewToggle(ui.container));
    openPreviewPart(ui.container, label === "電池の電源電圧" ? "part-1" : "part-2");
    const status = required(previewDialog(ui.container), ".circuit-preview__change-status");

    for (const invalidValue of ["", "0", "-1"]) {
      const input = previewInput(ui.container, label);
      changeNumber(input, invalidValue);
      expect(input.value).toBe(invalidValue);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(previewDialog(ui.container).querySelector(".circuit-preview__field-error")).not.toBeNull();
      expect(status.textContent).toBe("変更なし");
      expect(previewReset(ui.container).disabled).toBe(true);
      expect(ui.editor.document).toEqual(initial);

      blur(input);
      expect(input.value).toBe(originalValue);
      expect(input.getAttribute("aria-invalid")).toBeNull();
      expect(previewDialog(ui.container).querySelector(".circuit-preview__field-error")).toBeNull();
    }
  });

  it("accepts zero internal resistance as a valid preview value", () => {
    const initial = createExampleCircuit();
    const documentWithInternalResistance: CircuitDocument = {
      ...initial,
      parts: initial.parts.map((part) => part.id === "part-1" ? { ...part, internalResistanceOhms: 1 } : part),
    };
    const ui = mount(documentWithInternalResistance);
    click(previewToggle(ui.container));
    openPreviewPart(ui.container, "part-1");

    const input = previewInput(ui.container, "電池の内部抵抗");
    changeNumber(input, "0");
    expect(input.value).toBe("0");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(ui.container.querySelector(".circuit-preview__field-error")).toBeNull();
    expect(required(ui.container, ".circuit-preview__change-status").textContent).toBe("1項目を変更");
    expect(previewReset(ui.container).disabled).toBe(false);
    expect(ui.editor.document.parts.find((part) => part.id === "part-1")?.internalResistanceOhms).toBe(1);
  });

  it("opens a part with Enter or from the toolbar and uses a second Escape to return to editing", () => {
    const ui = mount(fixture());
    const toggle = previewToggle(ui.container);
    click(toggle);
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("true");
    expect(required(ui.container, ".circuit-board").getAttribute("data-read-only")).toBe("true");
    expect(previewPart(ui.container, battery.id).getAttribute("role")).toBe("button");

    const batteryPart = previewPart(ui.container, battery.id);
    focus(batteryPart);
    keyDown(batteryPart, "Enter");
    expect(previewDialog(ui.container).querySelector('[data-slot="dialog-title"]')?.textContent).toBe("電池");
    keyDown(previewDialog(ui.container), "Escape");
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("true");
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview-panel")).toBe("closed");
    expect(document.activeElement).toBe(batteryPart);

    click(required(ui.container, ".circuit-editor__preview-panel-toggle"));
    expect(previewDialog(ui.container).querySelector('[data-slot="dialog-title"]')?.textContent).toBe("解析・部品");
    click(overviewPartButton(ui.container, "電池"));
    expect(previewDialog(ui.container).querySelector('[data-slot="dialog-title"]')?.textContent).toBe("電池");
    keyDown(previewDialog(ui.container), "Escape");
    keyDown(required(ui.container, ".circuit-editor"), "Escape");

    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("false");
    expect(required(ui.container, ".circuit-board").getAttribute("data-read-only")).toBe("false");
    expect(required(ui.container, '[data-part-id="battery"][data-kind="battery"]').getAttribute("role")).toBe("button");
    expect(document.activeElement).toBe(toggle);
  });

  it("does not toggle a switch on pointer double-click; Enter, Space, and Shift+Enter keep their roles", async () => {
    const ui = mount(createExampleCircuit());
    click(previewToggle(ui.container));
    const switchPart = previewPart(ui.container, "part-4");

    vi.useFakeTimers();
    try {
      clickWithDetail(switchPart, 1);
      clickWithDetail(switchPart, 2);
      doubleClick(switchPart);
      expect(previewDialog(ui.container).querySelector('[data-slot="dialog-title"]')?.textContent).toBe("スイッチ");
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(switchPart.getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.useRealTimers();
    }

    keyDown(previewDialog(ui.container), "Escape");
    click(switchPart);
    expect(switchPart.getAttribute("aria-pressed")).toBe("false");
    keyDown(switchPart, "Enter");
    expect(switchPart.getAttribute("aria-pressed")).toBe("true");
    keyDown(switchPart, " ");
    expect(switchPart.getAttribute("aria-pressed")).toBe("false");
    keyDown(switchPart, "Enter", { shiftKey: true });
    expect(previewDialog(ui.container).querySelector('[data-slot="dialog-title"]')?.textContent).toBe("スイッチ");
    expect(switchPart.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the board read-only during preview and ignores edit shortcuts", () => {
    const ui = mount(fixture());
    click(previewToggle(ui.container));
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("true");
    expect(required(ui.container, ".circuit-board").getAttribute("data-read-only")).toBe("true");
    expect(required(ui.container, '[data-part-id="battery"][data-kind="battery"]').getAttribute("role")).toBe("button");

    click(required(ui.container, '[data-part-id="junction"][data-kind="junction"]'));
    clickTerminal(ui.container, junction.id);
    keyDown(required(ui.container, ".circuit-editor"), "1");
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.document.parts).toHaveLength(2);

    keyDown(required(ui.container, ".circuit-editor"), "Escape");
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("false");
    expect(required(ui.container, ".circuit-board").getAttribute("data-read-only")).toBe("false");
    expect(required(ui.container, '[data-part-id="battery"][data-kind="battery"]').getAttribute("role")).toBe("button");
  });

  it("keeps editor values when leaving preview after changing its temporary values", () => {
    const initial = createExampleCircuit();
    const ui = mount(initial);
    act(() => ui.editor.updatePart("part-1", { voltageVolts: 12 }));
    const toggle = previewToggle(ui.container);
    click(toggle);

    openPreviewPart(ui.container, "part-1");
    changeNumber(previewInput(ui.container, "電池の電源電圧"), "18");
    expect(ui.editor.document.parts.find((part) => part.id === "part-1")?.voltageVolts).toBe(12);
    keyDown(previewDialog(ui.container), "Escape");

    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("true");
    expect(document.activeElement).toBe(previewPart(ui.container, "part-1"));
    keyDown(required(ui.container, ".circuit-editor"), "Escape");
    expect(required(ui.container, ".circuit-editor").getAttribute("data-preview")).toBe("false");
    expect(ui.editor.document.parts.find((part) => part.id === "part-1")?.voltageVolts).toBe(12);
    expect(document.activeElement).toBe(toggle);
  });

  it.each(["Delete", "Backspace", "toolbar"])("deletes a junction after its terminal is clicked, even when another part was selected (%s)", (action) => {
    const ui = mount(fixture());
    click(required(ui.container, '[data-part-id="battery"][data-kind="battery"]'));
    expect(ui.editor.selection.parts).toEqual([battery.id]);

    clickTerminal(ui.container, junction.id);
    expect(ui.editor.selection.parts).toEqual([junction.id]);
    expect(ui.editor.pendingEndpoint).toEqual({ partId: junction.id, terminal: "a" });

    if (action === "toolbar") { click(required(ui.container, '[aria-label="選択した部品または導線を削除"]')); }
    else { keyDown(terminal(ui.container, junction.id), action); }

    expect(ui.editor.document.parts.map((part) => part.id)).toEqual([battery.id]);
    expect(ui.editor.pendingEndpoint).toBeNull();
  });

  it.each(["toolbar", "Delete", "Backspace"])("deletes a wire and its isolated junction as one undoable action (%s)", (action) => {
    const ui = mount(fixture(true));
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    click(required(ui.container, '[data-wire-id="wire-1"][data-wire-handle="to"]'));
    expect(ui.editor.selection).toEqual({ parts: [], wires: ["wire-1"] });
    expect(ui.editor.pendingEndpoint).toEqual({ partId: battery.id, terminal: "b" });

    if (action === "toolbar") { click(required(ui.container, '[aria-label="選択した部品または導線を削除"]')); }
    else { keyDown(required(ui.container, "main"), action); }

    expect(ui.editor.document.wires).toHaveLength(0);
    expect(ui.editor.document.parts.map((part) => part.id)).toEqual([battery.id]);
    expect(ui.editor.selection).toEqual({ parts: [], wires: [] });
    expect(ui.editor.pendingEndpoint).toBeNull();

    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document.parts.map((part) => part.id)).toEqual([battery.id, junction.id]);
    expect(ui.editor.document.wires.map((wire) => wire.id)).toEqual(["wire-1"]);
    expect(ui.editor.selection).toEqual({ parts: [], wires: [] });
    expect(ui.editor.pendingEndpoint).toBeNull();
    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document.parts.map((part) => part.id)).toEqual([battery.id]);
    expect(ui.editor.document.wires).toHaveLength(0);
    expect(ui.editor.selection).toEqual({ parts: [], wires: [] });
    expect(ui.editor.pendingEndpoint).toBeNull();
  });

  it.each(["junction", "battery"] as const)("connects a wire when %s is clicked first", (firstPart) => {
    const ui = mount(fixture());
    const first = firstPart === "junction" ? junction.id : battery.id;
    const second = firstPart === "junction" ? battery.id : junction.id;
    clickTerminal(ui.container, first);
    clickTerminal(ui.container, second);

    expect(ui.editor.document.wires).toHaveLength(1);
    const wire = ui.editor.document.wires[0];
    if (!wire) { throw new Error("Expected the connection to create a wire"); }
    expect(wire.from).toEqual({ partId: first, terminal: "a" });
    expect(wire.to).toEqual({ partId: second, terminal: "a" });
    expect(ui.editor.selection).toEqual({ parts: [], wires: [wire.id] });
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(required(ui.container, `[data-wire-id="${wire.id}"]`).getAttribute("data-selected")).toBe("true");
  });

  it.each(["Enter", " "])("selects and deletes a junction through terminal keyboard activation (%s)", (key) => {
    const ui = mount(fixture());
    keyDown(terminal(ui.container, junction.id), key);
    expect(ui.editor.selection.parts).toEqual([junction.id]);
    keyDown(required(ui.container, "main"), "Delete");

    expect(ui.editor.document.parts.map((part) => part.id)).toEqual([battery.id]);
    expect(ui.editor.pendingEndpoint).toBeNull();
  });
});
