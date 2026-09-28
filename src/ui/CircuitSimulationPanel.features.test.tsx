// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitExample } from "../circuit-examples.js";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysisOptions } from "../circuit-solver.js";
import { CircuitSimulationPanel, type CircuitSimulationPanelProps } from "./CircuitSimulationPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return { container, root };
}

function panelProps(
  document = createCircuitExample("charging"),
  options: CircuitAnalysisOptions = { mode: "auto" },
  overrides: Partial<CircuitSimulationPanelProps> = {},
): CircuitSimulationPanelProps {
  return {
    document,
    analysis: analyzeCircuit(document, {}, options),
    options,
    onChange: vi.fn(),
    ...overrides,
  };
}

describe("CircuitSimulationPanel learning feature visibility", () => {
  it("uses the displayed switch state for transient calculation and clears stale frames", () => {
    const document: CircuitDocument = {
      title: "Switch override",
      parts: [
        { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 5 },
        { id: "load", kind: "resistor", label: "抵抗", x: 0, y: 0, resistanceOhms: 100 },
        { id: "switch", kind: "switch", label: "スイッチ", x: 0, y: 0, initiallyClosed: false },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "switch", terminal: "a" } },
        { id: "b", from: { partId: "switch", terminal: "b" }, to: { partId: "load", terminal: "a" } },
        { id: "c", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const onFrameChange = vi.fn();
    const props = panelProps(document, { mode: "dc" }, {
      analysis: analyzeCircuit(document, { switch: true }), onFrameChange,
    });
    const ui = mount(<CircuitSimulationPanel {...props} />);
    const calculate = () => {
      const button = [...ui.container.querySelectorAll("button")].find((item) => item.textContent === "波形を計算");
      if (!button) { throw new Error("Missing calculate button"); }
      act(() => button.click());
    };
    calculate();
    expect(ui.container.querySelector('[data-part-id="load"] td')?.textContent).toBe("5");
    expect(onFrameChange.mock.calls.at(-1)?.[0]?.analysis.samples[0].parts.switch.switchClosed).toBe(true);
    act(() => ui.root.render(<CircuitSimulationPanel {...props} analysis={analyzeCircuit(document, { switch: true })} />));
    expect(ui.container.querySelector('[data-part-id="load"] td')?.textContent).toBe("5");
    expect(ui.container.querySelector(".circuit-energy__time")).not.toBeNull();
    act(() => ui.root.render(<CircuitSimulationPanel {...props} analysis={analyzeCircuit(document, { switch: false })} />));
    expect(ui.container.querySelector(".circuit-waveform")).toBeNull();
    expect(ui.container.querySelector(".circuit-energy__time")).toBeNull();
    expect(onFrameChange.mock.calls.at(-1)?.[0]).toBeNull();
    calculate();
    expect(ui.container.querySelector('[data-part-id="load"] td')?.textContent).toBe("0");
    expect(onFrameChange.mock.calls.at(-1)?.[0]?.analysis.samples[0].parts.switch.switchClosed).toBe(false);
  });

  it("hides AC tools and its analysis option by default when the circuit has no AC source", () => {
    const props = panelProps();
    const ui = mount(<CircuitSimulationPanel {...props} />);
    const modeLabel = Array.from(ui.container.querySelectorAll("label"))
      .find((label) => label.textContent === "定常解析");
    const modeSelect = modeLabel ? ui.container.querySelector<HTMLSelectElement>(`#${modeLabel.htmlFor}`) : null;

    expect(ui.container.querySelector('[aria-label="交流の波形と周波数応答"]')).toBeNull();
    expect(Array.from(modeSelect?.options ?? []).map((option) => option.value)).toEqual(["auto", "dc"]);
  });

  it("allows an explicit AC override and independent control of learning panels", () => {
    const props = panelProps(undefined, undefined, {
      learningFeatures: { transient: false, energy: true, ac: true, comparison: false },
    });
    const ui = mount(<CircuitSimulationPanel {...props} />);
    const modeLabel = Array.from(ui.container.querySelectorAll("label"))
      .find((label) => label.textContent === "定常解析");
    const modeSelect = modeLabel ? ui.container.querySelector<HTMLSelectElement>(`#${modeLabel.htmlFor}`) : null;

    expect(ui.container.querySelector(".circuit-transient")).toBeNull();
    expect(ui.container.querySelector(".circuit-energy")).not.toBeNull();
    expect(ui.container.querySelector('[aria-label="交流の波形と周波数応答"]')).not.toBeNull();
    expect(ui.container.querySelector(".circuit-comparison")).toBeNull();
    expect(Array.from(modeSelect?.options ?? []).map((option) => option.value)).toEqual(["auto", "dc", "ac"]);
  });

  it("keeps an existing AC analysis read-only when AC controls and tools are hidden", () => {
    const document = createCircuitExample("ac");
    const onChange = vi.fn();
    const props = panelProps(document, { mode: "auto" }, {
      onChange,
      learningFeatures: { ac: false },
    });
    const ui = mount(<CircuitSimulationPanel {...props} />);

    const labels = Array.from(ui.container.querySelectorAll("label"));
    expect(labels.some((label) => label.textContent === "定常解析")).toBe(false);
    expect(labels.some((label) => label.textContent?.includes("解析周波数"))).toBe(false);
    expect(ui.container.querySelector('[aria-label="交流の波形と周波数応答"]')).toBeNull();
    expect(ui.container.textContent).toContain("定常解析：交流・小信号");
    expect(ui.container.textContent).toContain("計測値は実効値と位相です。");
    expect(props.analysis.mode).toBe("ac");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the transient frame when its panel is hidden", () => {
    const document = createCircuitExample("charging");
    const options: CircuitAnalysisOptions = { mode: "auto" };
    const onFrameChange = vi.fn();
    const props = panelProps(document, options, { onFrameChange });
    const ui = mount(<CircuitSimulationPanel {...props} />);
    const calculateButton = Array.from(ui.container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("波形を計算"));
    if (!calculateButton) { throw new Error("Missing transient calculation button"); }

    act(() => calculateButton.click());

    expect(onFrameChange.mock.calls.some(([frame]) => frame !== null)).toBe(true);
    expect(ui.container.querySelector(".circuit-energy__time")).not.toBeNull();

    act(() => ui.root.render(<CircuitSimulationPanel {...props} learningFeatures={{ transient: false }} />));

    expect(ui.container.querySelector(".circuit-transient")).toBeNull();
    expect(ui.container.querySelector(".circuit-energy__time")).toBeNull();
    expect(onFrameChange.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("does not render an empty section when all settings and learning panels are hidden", () => {
    const props = panelProps(undefined, undefined, {
      showAnalysisSettings: false,
      learningFeatures: { transient: false, energy: false, ac: false, comparison: false },
    });
    const ui = mount(<CircuitSimulationPanel {...props} />);

    expect(ui.container.querySelector(".circuit-simulation")).toBeNull();
  });
});
