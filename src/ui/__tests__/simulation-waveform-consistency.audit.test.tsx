// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";
import { CircuitTransientPanel } from "../CircuitTransientPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function meterCircuit(floating: boolean): CircuitDocument {
  return {
    title: "測定できない計器",
    parts: [
      { id: "meter", kind: "voltmeter", label: "計器", x: 0, y: 0 },
      { id: "source", kind: "ac-source", label: "電源", x: 0, y: 0, voltageVolts: 5, frequencyHz: 1000 },
      { id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: 100 },
      { id: "isolated", kind: "junction", label: "孤立端子", x: 0, y: 0 },
    ],
    wires: [
      { id: "supply", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "return", from: { partId: "source", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      { id: "meter-a", from: { partId: "source", terminal: "a" }, to: { partId: "meter", terminal: "a" } },
      ...(floating ? [{ id: "meter-b", from: { partId: "isolated", terminal: "a" as const }, to: { partId: "meter", terminal: "b" as const } }] : []),
    ],
  };
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  return { root, container };
}

function clickButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!button) { throw new Error(`Missing button: ${label}`); }
  act(() => button.click());
}

describe("simulation waveform consistency", () => {
  it("sweeps with the switch state used by the displayed analysis", () => {
    const circuit = meterCircuit(false);
    circuit.parts = circuit.parts.filter((part) => part.id !== "meter" && part.id !== "isolated");
    circuit.parts.reverse();
    circuit.parts.push({ id: "switch", kind: "switch", label: "スイッチ", x: 0, y: 0, initiallyClosed: false });
    circuit.parts.push({ id: "bypass", kind: "resistor", label: "並列抵抗", x: 0, y: 0, resistanceOhms: 100 });
    circuit.wires = [
      { id: "supply", from: { partId: "source", terminal: "a" }, to: { partId: "switch", terminal: "a" } },
      { id: "middle", from: { partId: "switch", terminal: "b" }, to: { partId: "load", terminal: "a" } },
      { id: "return", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      { id: "bypass-a", from: { partId: "switch", terminal: "a" }, to: { partId: "bypass", terminal: "a" } },
      { id: "bypass-b", from: { partId: "switch", terminal: "b" }, to: { partId: "bypass", terminal: "b" } },
    ];
    const options = { mode: "ac" as const, frequencyHz: 1000 };
    const analysis = analyzeCircuit(circuit, { switch: true }, options);
    expect(analysis.status).toBe("closed");
    const { root, container } = mount();
    act(() => root.render(<CircuitAcPanel document={circuit} analysis={analysis} options={options} />));
    clickButton(container, "対数スイープを計算");
    const values = [...container.querySelectorAll(".circuit-ac__response-dot")]
      .map((point) => Number(point.getAttribute("data-voltage-rms")));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) { expect(value).toBeCloseTo(5, 12); }
    const opened = analyzeCircuit(circuit, { switch: false }, options);
    expect(opened.status).toBe("closed");
    act(() => root.render(<CircuitAcPanel document={circuit} analysis={opened} options={options} />));
    expect(container.querySelectorAll(".circuit-ac__response-dot")).toHaveLength(0);
    clickButton(container, "対数スイープを計算");
    const updated = [...container.querySelectorAll(".circuit-ac__response-dot")];
    expect(updated.length).toBeGreaterThan(0);
    for (const point of updated) {
      expect(Number(point.getAttribute("data-voltage-rms"))).toBeCloseTo(2.5, 12);
    }
  });

  it("continues to show a connected meter in both analyses", () => {
    const circuit = meterCircuit(false);
    circuit.wires.push({ id: "meter-return", from: { partId: "source", terminal: "b" }, to: { partId: "meter", terminal: "b" } });
    const options = { mode: "ac" as const, frequencyHz: 1000 };
    const analysis = analyzeCircuit(circuit, {}, options);
    expect(analysis.parts.meter.meterStatus).toBe("connected");
    const { root, container } = mount();
    act(() => root.render(<>
      <CircuitAcPanel document={circuit} analysis={analysis} options={options} />
      <CircuitTransientPanel document={circuit} />
    </>));
    clickButton(container, "波形を計算");
    expect(container.querySelector('[data-part-id="meter"] td')?.textContent).toBe("7.071");
    expect(container.querySelectorAll('.circuit-waveform [data-series-index="1"] polyline')).toHaveLength(2);
    expect(container.querySelectorAll(".circuit-ac__trace")).toHaveLength(2);
    clickButton(container, "対数スイープを計算");
    const values = [...container.querySelectorAll(".circuit-ac__response-dot")]
      .map((point) => Number(point.getAttribute("data-voltage-rms")));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) { expect(value).toBeCloseTo(5, 12); }
  });

  it.each([false, true])("hides invalid transient meter readings (floating=%s)", (floating) => {
    const circuit = meterCircuit(floating);
    const { root, container } = mount();
    act(() => root.render(<CircuitTransientPanel document={circuit} baselineDocument={{ ...circuit }} />));
    clickButton(container, "波形を計算");

    const cells = [...container.querySelectorAll('[data-part-id="meter"] td')];
    expect(cells.map((cell) => cell.textContent)).toEqual(["—", "—", "—", "—"]);
    // Load is selected first, followed by the meter and source.
    expect(container.querySelectorAll('.circuit-waveform [data-series-index="1"] polyline')).toHaveLength(0);
    expect(container.querySelectorAll('.circuit-waveform [data-series-index="1"] circle')).toHaveLength(0);
    expect(container.querySelectorAll('.circuit-waveform [data-series-index="0"] polyline').length).toBeGreaterThan(0);
  });

  it.each([false, true])("hides invalid AC meter waveforms and sweep values (floating=%s)", (floating) => {
    const circuit = meterCircuit(floating);
    const options = { mode: "ac" as const, frequencyHz: 1000 };
    const analysis = analyzeCircuit(circuit, {}, options);
    expect(analysis.status).toBe("closed");
    expect(analysis.parts.meter.meterStatus).toBe(floating ? "floating" : "unconnected");
    const { root, container } = mount();
    act(() => root.render(<CircuitAcPanel document={circuit} analysis={analysis} options={options} />));
    expect(container.querySelectorAll(".circuit-ac__trace")).toHaveLength(0);
    clickButton(container, "対数スイープを計算");
    expect(container.querySelectorAll(".circuit-ac__response-dot")).toHaveLength(0);
  });
});
