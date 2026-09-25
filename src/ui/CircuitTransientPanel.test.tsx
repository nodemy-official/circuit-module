// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { createCircuitExample } from "../circuit-examples.js";
import type { CircuitTransientFrame } from "../circuit-visualization.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(document: CircuitDocument = createCircuitExample("charging"), baselineDocument?: CircuitDocument, onFrameChange?: (frame: CircuitTransientFrame | null) => void) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let currentDocument = document;
  let currentBaseline = baselineDocument;
  const render = (nextDocument = currentDocument, nextBaseline = currentBaseline) => {
    currentDocument = nextDocument;
    currentBaseline = nextBaseline;
    act(() => root.render(<CircuitTransientPanel document={currentDocument} baselineDocument={currentBaseline} onFrameChange={onFrameChange} />));
  };
  render();
  const record = { root, container };
  mounted.push(record);
  return {
    container,
    render,
    unmount() {
      act(() => root.unmount());
      const index = mounted.indexOf(record);
      if (index >= 0) { mounted.splice(index, 1); }
      container.remove();
    },
  };
}

function buttonWithText(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text);
  if (!button) { throw new Error(`Missing button ${text}`); }
  return button;
}

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function setRangeValue(input: HTMLInputElement, value: number) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CircuitTransientPanel synchronized waveforms", () => {
  it("plots several components together and overlays a baseline on a shared time cursor", () => {
    const baseline = createCircuitExample("charging");
    const document = {
      ...baseline,
      parts: baseline.parts.map((part) => part.kind === "resistor" ? { ...part, resistanceOhms: (part.resistanceOhms ?? 1000) * 2 } : part),
    };
    const frames: Array<CircuitTransientFrame | null> = [];
    const ui = mount(document, baseline, (frame) => frames.push(frame));

    click(buttonWithText(ui.container, "波形を計算"));

    expect(ui.container.querySelectorAll(".circuit-waveform svg")).toHaveLength(2);
    expect(ui.container.querySelectorAll('.circuit-waveform__trace[data-source="current"]')).toHaveLength(6);
    expect(ui.container.querySelectorAll('.circuit-waveform__trace[data-source="baseline"][stroke-dasharray="5 4"]')).toHaveLength(6);
    expect(ui.container.querySelectorAll(".circuit-transient__readings tbody tr")).toHaveLength(3);
    const slider = ui.container.querySelector<HTMLInputElement>('.circuit-transient__time-controls input[type="range"]');
    expect(slider?.max).toBe("400");
    if (!slider) { throw new Error("Missing common time cursor"); }

    setRangeValue(slider, 160);

    expect(slider.dataset.sampleIndex).toBe("160");
    expect(ui.container.querySelector(".circuit-transient__readings caption")?.textContent).toBe("0.004 s の電圧・電流");
    expect(frames.at(-1)?.sampleIndex).toBe(160);
    expect(ui.container.textContent).toContain("変更後");
    expect(ui.container.textContent).toContain("変更前");
    expect(ui.container.querySelector(".circuit-transient__plots")?.children).toHaveLength(2);
  });

  it("labels the sampled readings as current when there is no baseline", () => {
    const ui = mount();
    click(buttonWithText(ui.container, "波形を計算"));

    expect(ui.container.querySelector(".circuit-transient__readings thead")?.textContent).toContain("現在");
    expect(ui.container.querySelector(".circuit-transient__readings thead")?.textContent).not.toContain("変更後");
  });

  it("plays, pauses, and returns all traces to the first sample", () => {
    vi.useFakeTimers();
    const ui = mount();
    click(buttonWithText(ui.container, "波形を計算"));
    click(buttonWithText(ui.container, "再生"));
    expect(buttonWithText(ui.container, "一時停止").getAttribute("aria-pressed")).toBe("true");

    act(() => vi.advanceTimersByTime(100));
    const slider = ui.container.querySelector<HTMLInputElement>('.circuit-transient__time-controls input[type="range"]');
    expect(Number(slider?.dataset.sampleIndex)).toBeGreaterThan(0);

    click(buttonWithText(ui.container, "一時停止"));
    expect(buttonWithText(ui.container, "再生").getAttribute("aria-pressed")).toBe("false");
    click(buttonWithText(ui.container, "先頭へ"));
    expect(slider?.dataset.sampleIndex).toBe("0");
  });

  it("does not overlay a baseline part when the component kind changed", () => {
    const document = createCircuitExample("charging");
    const capacitor = document.parts.find((part) => part.kind === "capacitor");
    expect(capacitor).toBeDefined();
    if (!capacitor) { throw new Error("Missing charging capacitor"); }
    const baseline = {
      ...document,
      parts: document.parts.map((part) => part.id === capacitor.id
        ? { id: part.id, kind: "resistor" as const, x: part.x, y: part.y, label: part.label, resistanceOhms: 100 }
        : part),
    };
    const ui = mount(document, baseline);
    click(buttonWithText(ui.container, "波形を計算"));

    expect(ui.container.querySelectorAll('.circuit-waveform__trace[data-source="baseline"]')).toHaveLength(4);
    const capacitorBeforeVoltage = ui.container.querySelector<HTMLElement>(`.circuit-transient__readings tr[data-part-id="${capacitor.id}"] td:nth-of-type(3)`);
    expect(capacitorBeforeVoltage?.textContent).toBe("—");
  });

  it("clears stale and invalid frames and sends null when unmounted", () => {
    const document = createCircuitExample("charging");
    const frames: Array<CircuitTransientFrame | null> = [];
    const ui = mount(document, undefined, (frame) => frames.push(frame));
    click(buttonWithText(ui.container, "波形を計算"));
    expect(frames.at(-1)?.sampleIndex).toBe(0);

    ui.render({ ...document, title: "changed" });
    expect(ui.container.textContent).toContain("波形を再計算してください");
    expect(frames.at(-1)).toBeNull();

    const invalidDocument = {
      ...document,
      parts: document.parts.map((part) => part.kind === "resistor" ? { ...part, resistanceOhms: 0 } : part),
    };
    ui.render(invalidDocument);
    click(buttonWithText(ui.container, "波形を計算"));
    expect(ui.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(ui.container.querySelector(".circuit-waveform")).toBeNull();
    expect(frames.at(-1)).toBeNull();

    ui.unmount();
    expect(frames.at(-1)).toBeNull();
  });

  it("does not loop when the parent recreates the frame callback after each update", () => {
    const document = createCircuitExample("charging");
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    function Parent() {
      const [updates, setUpdates] = useState(0);
      return <>
        <output data-frame-updates="true">{updates}</output>
        <CircuitTransientPanel document={document} onFrameChange={() => setUpdates((count) => count + 1)} />
      </>;
    }
    act(() => root.render(<Parent />));
    mounted.push({ root, container });
    click(buttonWithText(container, "波形を計算"));
    expect(Number(container.querySelector("[data-frame-updates]")?.textContent)).toBe(2);
  });
});
