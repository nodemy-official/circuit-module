// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeCircuit } from "../../circuit-solver.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mountAtFrequency(frequencyHz: number) {
  const document: CircuitDocument = {
    title: "周波数境界の掃引",
    parts: [
      { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 5, frequencyHz, phaseDegrees: 37 },
      { id: "load", kind: "resistor", label: "負荷", x: 4, y: 0, resistanceOhms: 100 },
    ],
    wires: [
      { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };
  const options = { mode: "ac" as const, frequencyHz };
  const analysis = analyzeCircuit(document, {}, options);
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CircuitAcPanel document={document} analysis={analysis} options={options} />));
  mounted.push({ root, container });
  return container;
}

function sweepFrequencies(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "対数スイープを計算");
  if (!button) { throw new Error("Missing frequency sweep button"); }
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return Array.from(container.querySelectorAll<SVGCircleElement>(".circuit-ac__response-dot"))
    .map((point) => Number(point.getAttribute("data-frequency-hz")));
}

describe("CircuitAcPanel frequency sweep boundaries", () => {
  it.each([Number.MIN_VALUE, 1e-10, 1e13, Number.MAX_VALUE])("keeps the analyzed center frequency in the sweep at %s Hz", (frequencyHz) => {
    const container = mountAtFrequency(frequencyHz);
    const frequencies = sweepFrequencies(container);

    expect(frequencies.length).toBeGreaterThan(0);
    expect(frequencies).toContain(frequencyHz);
    if (frequencyHz === Number.MIN_VALUE) {
      expect(container.textContent).toMatch(/T = [0-9.]+e\+323 s/);
    }
  });

  it("keeps a nearby distinct-frequency source out of the sweep", () => {
    const document: CircuitDocument = {
      title: "近接する別周波数源の掃引",
      parts: [
        { id: "load", kind: "resistor", label: "負荷", x: 4, y: 0, resistanceOhms: 20 },
        { id: "source-50", kind: "ac-source", label: "50 Hz源", x: 0, y: 0, voltageVolts: 10, frequencyHz: 50 },
        { id: "source-near-50", kind: "ac-source", label: "近接周波数源", x: 0, y: 4, voltageVolts: 7, frequencyHz: 50.000_000_025 },
      ],
      wires: [
        { id: "w1", from: { partId: "source-50", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "source-near-50", terminal: "b" } },
        { id: "w3", from: { partId: "source-near-50", terminal: "a" }, to: { partId: "source-50", terminal: "b" } },
      ],
    };
    const options = { mode: "ac" as const, frequencyHz: 50 };
    const analysis = analyzeCircuit(document, {}, options);
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<CircuitAcPanel document={document} analysis={analysis} options={options} />));
    mounted.push({ root, container });

    sweepFrequencies(container);

    const center = Array.from(container.querySelectorAll<SVGCircleElement>(".circuit-ac__response-dot"))
      .find((point) => Number(point.getAttribute("data-frequency-hz")) === 50);
    expect(center?.getAttribute("data-voltage-rms")).toBe("10");
  });
});
