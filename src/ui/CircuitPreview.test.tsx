// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyCircuit, createExampleCircuit } from "../circuit-model.js";
import { createCircuitExample } from "../circuit-examples.js";
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

function rerender(container: HTMLElement, children: ReactNode) {
  const preview = mounted.find((entry) => entry.container === container);
  if (!preview) { throw new Error("Preview root is not mounted"); }
  act(() => preview.root.render(children));
}

function required(container: ParentNode, selector: string) {
  const element = container.querySelector(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

function hasSummaryText(container: ParentNode, text: string) {
  return [...container.querySelectorAll("summary")].some((summary) => summary.textContent?.includes(text));
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

  it("shows AC features automatically only for an AC circuit and honors explicit overrides", () => {
    const dc = mount(<CircuitPreview initialDocument={createExampleCircuit()} />);
    const dcPreview = required(dc, ".circuit-editor");
    expect(hasSummaryText(required(dcPreview, ".circuit-editor__learning"), "交流の位相・周波数応答")).toBe(false);
    act(() => required(dcPreview, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(required(dcPreview, '[role="dialog"] select').querySelector('option[value="ac"]')).toBeNull();

    const acDocument = createCircuitExample("ac");
    const ac = mount(<CircuitPreview initialDocument={acDocument} />);
    const acPreview = required(ac, ".circuit-editor");
    expect(hasSummaryText(required(acPreview, ".circuit-editor__learning"), "交流の位相・周波数応答")).toBe(true);
    act(() => required(acPreview, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(required(acPreview, '[role="dialog"] select').querySelector('option[value="ac"]')).not.toBeNull();

    const forcedOn = mount(<CircuitPreview initialDocument={createExampleCircuit()} previewFeatures={{ ac: true }} />);
    const forcedOnPreview = required(forcedOn, ".circuit-editor");
    expect(hasSummaryText(required(forcedOnPreview, ".circuit-editor__learning"), "交流の位相・周波数応答")).toBe(true);
    act(() => required(forcedOnPreview, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(required(forcedOnPreview, '[role="dialog"] select').querySelector('option[value="ac"]')).not.toBeNull();

    const forcedOff = mount(<CircuitPreview initialDocument={acDocument} previewFeatures={{ ac: false }} />);
    const forcedOffPreview = required(forcedOff, ".circuit-editor");
    expect(hasSummaryText(required(forcedOffPreview, ".circuit-editor__learning"), "交流の位相・周波数応答")).toBe(false);
    act(() => required(forcedOffPreview, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(forcedOffPreview.querySelector('[role="dialog"] option[value="ac"]')).toBeNull();
  });

  it("hides each optional preview section independently", () => {
    const document = createCircuitExample("ac");

    const noTitle = mount(<CircuitPreview initialDocument={document} previewFeatures={{ title: false }} />);
    expect(required(noTitle, ".circuit-editor__header").querySelector(".circuit-editor__document-name")).toBeNull();
    expect(required(noTitle, ".circuit-editor__preview-panel-toggle")).not.toBeNull();

    const noSummary = mount(<CircuitPreview initialDocument={document} previewFeatures={{ summary: false }} />);
    expect(noSummary.querySelector(".circuit-editor__preview-footer")).toBeNull();
    act(() => required(noSummary, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(noSummary.querySelector('[role="dialog"] .circuit-preview-dialog__analysis')).toBeNull();

    const noParts = mount(<CircuitPreview initialDocument={createExampleCircuit()} previewFeatures={{ parts: false }} />);
    const noPartsPreview = required(noParts, ".circuit-editor");
    expect(noPartsPreview.querySelector(".circuit-preview-parts")).toBeNull();
    const switchPart = required(noPartsPreview, '.circuit-board__part[data-kind="switch"]');
    expect(required(noPartsPreview, ".circuit-board").getAttribute("data-switch-interactive")).toBe("false");
    expect(switchPart.getAttribute("aria-pressed")).toBeNull();
    expect(switchPart.getAttribute("aria-haspopup")).toBeNull();
    act(() => required(noPartsPreview, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect([...required(noPartsPreview, '[role="dialog"]').querySelectorAll('[role="tab"]')].some((tab) => tab.textContent?.includes("部品"))).toBe(false);
    expect(required(noPartsPreview, '[role="dialog"] select').querySelector('option[value="dc"]')).not.toBeNull();

    const noAnalysisSettings = mount(<CircuitPreview initialDocument={document} previewFeatures={{ analysisSettings: false }} />);
    act(() => required(noAnalysisSettings, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(required(noAnalysisSettings, '[role="dialog"]').textContent).not.toContain("解析設定");
    expect(required(noAnalysisSettings, '[role="dialog"]').textContent).toContain("部品");
    expect(noAnalysisSettings.querySelector('[role="dialog"] select')).toBeNull();

    const noLearning = mount(<CircuitPreview initialDocument={document} previewFeatures={{ learning: false }} />);
    expect(noLearning.querySelector(".circuit-editor__learning")).toBeNull();
  });

  it("hides individual learning tools and removes the learning section when none remain", () => {
    const document = createCircuitExample("ac");
    const onlyTransient = mount(<CircuitPreview initialDocument={document} previewFeatures={{ energy: false, ac: false, comparison: false }} />);
    expect(onlyTransient.querySelector(".circuit-editor__learning")).not.toBeNull();
    expect(onlyTransient.querySelector(".circuit-transient")).not.toBeNull();
    expect(onlyTransient.querySelector('[aria-label="電力とエネルギー"]')).toBeNull();
    expect(hasSummaryText(onlyTransient, "交流の位相・周波数応答")).toBe(false);
    expect(onlyTransient.querySelector(".circuit-comparison")).toBeNull();

    const onlyEnergy = mount(<CircuitPreview initialDocument={document} previewFeatures={{ transient: false, ac: false, comparison: false }} />);
    expect(onlyEnergy.querySelector(".circuit-transient")).toBeNull();
    expect(onlyEnergy.querySelector('[aria-label="電力とエネルギー"]')).not.toBeNull();
    expect(hasSummaryText(onlyEnergy, "交流の位相・周波数応答")).toBe(false);
    expect(onlyEnergy.querySelector(".circuit-comparison")).toBeNull();

    const onlyComparison = mount(<CircuitPreview initialDocument={document} previewFeatures={{ transient: false, energy: false, ac: false }} />);
    expect(onlyComparison.querySelector(".circuit-transient")).toBeNull();
    expect(onlyComparison.querySelector('[aria-label="電力とエネルギー"]')).toBeNull();
    expect(hasSummaryText(onlyComparison, "交流の位相・周波数応答")).toBe(false);
    expect(onlyComparison.querySelector(".circuit-comparison")).not.toBeNull();

    const noLearningTools = mount(<CircuitPreview initialDocument={document} previewFeatures={{ transient: false, energy: false, ac: false, comparison: false }} />);
    expect(noLearningTools.querySelector(".circuit-editor__learning")).toBeNull();
  });

  it("updates feature visibility on rerender and closes a dialog when its sections disappear", () => {
    const document = createExampleCircuit();
    const container = mount(<CircuitPreview initialDocument={document} previewFeatures={{ parts: false, analysisSettings: true }} />);
    const preview = required(container, ".circuit-editor");
    expect(preview.querySelector(".circuit-preview-parts")).toBeNull();
    act(() => required(preview, ".circuit-editor__preview-panel-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(preview.querySelector('[role="dialog"]')).not.toBeNull();

    rerender(container, <CircuitPreview initialDocument={document} previewFeatures={{ title: false, summary: false, parts: false, analysisSettings: false, learning: false }} />);
    expect(container.querySelector(".circuit-editor__header")).toBeNull();
    expect(container.querySelector(".circuit-editor__preview-footer")).toBeNull();
    expect(container.querySelector(".circuit-editor__learning")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    rerender(container, <CircuitPreview initialDocument={document} previewFeatures={{ parts: true, analysisSettings: false }} />);
    expect(container.querySelector(".circuit-preview-parts")).not.toBeNull();
    expect(required(container, ".circuit-editor__preview-panel-toggle")).not.toBeNull();
  });

  it("honors board display props in preview without mutating the supplied document", () => {
    const document = createExampleCircuit();
    const original = structuredClone(document);
    const container = mount(
      <CircuitPreview
        initialDocument={document}
        previewFeatures={{ title: false, summary: false, parts: false, analysisSettings: false, learning: false, transient: false, energy: false, ac: false, comparison: false }}
        boardProps={{ showFlow: false, showPotentials: false, renderControls: null }}
      />,
    );
    const preview = required(container, ".circuit-editor");
    const board = required(preview, ".circuit-board");
    expect(board.getAttribute("data-show-flow")).toBe("false");
    expect(board.querySelector(".circuit-board__flow-legend")).toBeNull();
    expect(board.querySelector(".circuit-potential")).toBeNull();
    expect(board.querySelector(".circuit-board__controls")).toBeNull();
    act(() => required(board, '.circuit-board__part[data-kind="switch"]').dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document).toEqual(original);
  });
});
