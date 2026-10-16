// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitSimulationPanel } from "../CircuitSimulationPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function sourceDocument(): CircuitDocument {
  return {
    title: "接続先の編集中も過渡解析を保持",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 5 },
      { id: "switch", kind: "switch", label: "スイッチ", x: 8, y: 0, initiallyClosed: false },
      { id: "load", kind: "resistor", label: "負荷", x: 16, y: 0, resistanceOhms: 100 },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "switch", terminal: "a" } },
      { id: "b", from: { partId: "switch", terminal: "b" }, to: { partId: "load", terminal: "a" } },
      { id: "c", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

function calculate(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "波形を計算");
  if (!button) { throw new Error("Missing calculate button"); }
  act(() => button.click());
}

describe("transient switch override snapshot failures", () => {
  it("hides transient results while an analyzed switch getter is unavailable and resumes after recovery", () => {
    const document = sourceDocument();
    const options = { mode: "dc" as const };
    const analysis = analyzeCircuit(document, { switch: true }, options);
    let readSwitch = () => true;
    const switchGetter = () => readSwitch();
    Object.defineProperty(analysis.parts.switch!, "switchClosed", { configurable: true, enumerable: true, get: switchGetter });
    const onFrameChange = vi.fn();
    const onChange = vi.fn();
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const render = () => act(() => root.render(<CircuitSimulationPanel
      document={document}
      analysis={analysis}
      options={options}
      onChange={onChange}
      onFrameChange={onFrameChange}
      learningFeatures={{ transient: true, energy: true, comparison: true, ac: false }}
    />));
    render();
    calculate(container);
    expect(onFrameChange.mock.calls.at(-1)?.[0]?.analysis.status).toBe("valid");
    expect(container.querySelector(".circuit-energy__time")).not.toBeNull();

    readSwitch = () => { throw new Error("Switch state is temporarily unavailable"); };
    expect(() => render()).not.toThrow();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("スイッチ状態を読み取れない");
    expect(container.querySelector(".circuit-transient")).toBeNull();
    expect(container.querySelector(".circuit-waveform")).toBeNull();
    expect(container.querySelector(".circuit-energy__time")).toBeNull();
    expect(onFrameChange.mock.calls.at(-1)?.[0]).toBeNull();
    expect(container.querySelector("select")).not.toBeNull();
    const capture = [...container.querySelectorAll("button")].find((button) => button.textContent === "現在を比較の基準にする");
    expect(capture).toBeDefined();
    act(() => capture!.click());
    expect(container.querySelector('.circuit-comparison[data-comparison-state="ready"]')).not.toBeNull();
    expect(container.querySelector('.circuit-comparison [role="alert"]')).toBeNull();

    readSwitch = () => true;
    render();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".circuit-transient")).not.toBeNull();
    expect(container.querySelector(".circuit-waveform")).toBeNull();
    expect(onFrameChange.mock.calls.at(-1)?.[0]).toBeNull();
    calculate(container);
    const frame = onFrameChange.mock.calls.at(-1)?.[0];
    expect(frame?.analysis.status).toBe("valid");
    expect(frame?.analysis.samples[0].parts.switch.switchClosed).toBe(true);
    expect(frame?.analysis.samples[0].parts.load.voltageVolts).toBe(5);
    expect(document).toEqual(sourceDocument());
    expect(Object.getOwnPropertyDescriptor(analysis.parts.switch!, "switchClosed")?.get).toBe(switchGetter);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves invalid-input diagnostics and recovers after repair (previous result=%s)", (previousResult) => {
    const document = sourceDocument();
    const options = { mode: "dc" as const };
    const analysis = analyzeCircuit(document, { switch: true }, options);
    const originalAnalysis = structuredClone(analysis);
    const onFrameChange = vi.fn();
    const onChange = vi.fn();
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const render = () => act(() => root.render(<CircuitSimulationPanel
      document={document}
      analysis={analysis}
      options={options}
      onChange={onChange}
      onFrameChange={onFrameChange}
      learningFeatures={{ transient: true, energy: false, comparison: false, ac: false }}
    />));
    render();
    if (previousResult) { calculate(container); }

    document.wires[0]!.to.partId = "missing";
    const invalidDocument = structuredClone(document);
    expect(() => render()).not.toThrow();
    expect(container.querySelector(".circuit-simulation")).not.toBeNull();
    expect(container.querySelector(".circuit-waveform")).toBeNull();
    expect(onFrameChange.mock.calls.at(-1)?.[0]).toBeNull();

    calculate(container);

    expect(container.querySelector('.circuit-transient [role="alert"]')?.textContent).toContain("missing");
    expect(container.querySelector(".circuit-waveform")).toBeNull();
    expect(document).toEqual(invalidDocument);
    expect(analysis).toEqual(originalAnalysis);
    expect(onChange).not.toHaveBeenCalled();

    document.wires[0]!.to.partId = "switch";
    render();
    calculate(container);

    expect(container.querySelector('.circuit-transient [role="alert"]')).toBeNull();
    expect(container.querySelector(".circuit-waveform")).not.toBeNull();
    const frame = onFrameChange.mock.calls.at(-1)?.[0];
    expect(frame?.analysis.status).toBe("valid");
    expect(frame?.analysis.samples[0].parts.switch.switchClosed).toBe(true);
    expect(frame?.analysis.samples[0].parts.load.voltageVolts).toBe(5);
    expect(document).toEqual(sourceDocument());
    expect(analysis).toEqual(originalAnalysis);
  });
});
