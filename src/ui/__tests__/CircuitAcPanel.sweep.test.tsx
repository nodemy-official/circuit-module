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
  it("hides a saved sweep when its switch snapshot becomes unreadable and recovers on retry", () => {
    const document: CircuitDocument = {
      title: "読み取りできないスイッチ状態",
      parts: [
        { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50 },
        { id: "load", kind: "resistor", label: "負荷", x: 8, y: 0, resistanceOhms: 20 },
        { id: "toggle", kind: "switch", label: "スイッチ", x: 16, y: 0, initiallyClosed: true },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "toggle", terminal: "a" } },
        { id: "c", from: { partId: "toggle", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const options = { mode: "ac" as const, frequencyHz: 50 };
    const analysis = analyzeCircuit(document, {}, options);
    let readSwitch = () => true;
    Object.defineProperty(analysis.parts.toggle!, "switchClosed", {
      get: () => readSwitch(),
    });
    const container = globalThis.document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });
    const render = () => act(() => root.render(<CircuitAcPanel document={document} analysis={analysis} options={options} />));
    render();
    expect(sweepFrequencies(container)).toHaveLength(41);

    readSwitch = () => { throw new Error("スイッチ状態が利用できません"); };
    expect(render).not.toThrow();
    expect(container.querySelector(".circuit-ac__response")).toBeNull();
    sweepFrequencies(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("スイッチ状態が利用できません");

    readSwitch = () => true;
    expect(sweepFrequencies(container)).toHaveLength(41);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([false, true])("reports a rejected document snapshot and recovers on retry (previous sweep=%s)", (previousSweep) => {
    const document: CircuitDocument = {
      title: "接続先の更新中",
      parts: [
        { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50 },
        { id: "load", kind: "resistor", label: "負荷", x: 8, y: 0, resistanceOhms: 20 },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const options = { mode: "ac" as const, frequencyHz: 50 };
    const analysis = analyzeCircuit(document, {}, options);
    const container = globalThis.document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => root.render(<CircuitAcPanel document={document} analysis={analysis} options={options} />));
    if (previousSweep) { sweepFrequencies(container); }
    // The host can update inputs while an earlier analysis is still displayed.
    document.wires[0]!.to.partId = "missing";
    const errors: unknown[] = [];
    const captureError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", captureError);
    try {
      sweepFrequencies(container);
    } finally {
      window.removeEventListener("error", captureError);
    }

    expect(errors).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("missing");
    expect(container.querySelector(".circuit-ac__response")).toBeNull();

    document.wires[0]!.to.partId = "load";
    expect(sweepFrequencies(container)).toHaveLength(41);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["source", "switch", "wire", "switch accessor"] as const)("hides an earlier sweep after %s inputs and analysis are updated in place", (changed) => {
    const document: CircuitDocument = {
      title: "電源振幅を変更した後の掃引",
      parts: [
        { id: "load", kind: "resistor", label: "負荷", x: 4, y: 0, resistanceOhms: 20 },
        { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50 },
        { id: "toggle", kind: "switch", label: "スイッチ", x: 8, y: 0, initiallyClosed: true },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "toggle", terminal: "a" } },
        { id: "c", from: { partId: "toggle", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const options = { mode: "ac" as const, frequencyHz: 50 };
    const analysis = analyzeCircuit(document, {}, options);
    let closed = true;
    const installSwitchAccessor = () => {
      if (changed === "switch accessor") {
        Object.defineProperty(analysis.parts.toggle, "switchClosed", { get: () => closed, configurable: true });
      }
    };
    installSwitchAccessor();
    const container = globalThis.document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });
    const render = () => act(() => root.render(<CircuitAcPanel document={document} analysis={analysis} options={options} />));
    render();
    sweepFrequencies(container);
    expect(container.querySelector(".circuit-ac__response-dot")?.getAttribute("data-voltage-rms")).toBe("1");

    if (changed === "source") { document.parts[1]!.voltageVolts = 2; }
    if (changed === "wire") { document.wires[0]!.from.terminal = "b"; }
    Object.assign(analysis, analyzeCircuit(document, changed === "switch" || changed === "switch accessor" ? { toggle: false } : {}, options));
    closed = false;
    installSwitchAccessor();
    render();

    const expectedVoltage = changed === "source" ? "2" : "0";
    expect(container.querySelector(".circuit-ac__waveform")?.getAttribute("data-voltage-rms")).toBe(expectedVoltage);
    expect(container.querySelector(".circuit-ac__response")).toBeNull();
    sweepFrequencies(container);
    const points = [...container.querySelectorAll(".circuit-ac__response-dot")];
    expect(points).toHaveLength(41);
    for (const point of points) { expect(point.getAttribute("data-voltage-rms")).toBe(expectedVoltage); }
  });

  it.each([false, true])("preserves non-enumerable source fields when sweeping (document fields: %s)", (hideDocumentFields) => {
    const source: CircuitDocument["parts"][number] = {
      id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, frequencyHz: 1000,
    };
    Object.defineProperty(source, "voltageVolts", { value: 1, enumerable: false });
    const document: CircuitDocument = {
      title: "非列挙フィールドの掃引",
      parts: [source, { id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: 20 }],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    if (hideDocumentFields) {
      Object.defineProperty(document, "wires", { value: document.wires, enumerable: false });
    }
    const options = { mode: "ac" as const, frequencyHz: 1000 };
    const analysis = analyzeCircuit(document, {}, options);
    expect(analysis.status).toBe("closed");
    expect(analysis.parts.source!.voltageVolts).toBe(1);
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<CircuitAcPanel document={document} analysis={analysis} options={options} />));
    mounted.push({ root, container });

    sweepFrequencies(container);

    const points = [...container.querySelectorAll(".circuit-ac__response-dot")];
    expect(points).toHaveLength(41);
    for (const point of points) { expect(Number(point.getAttribute("data-voltage-rms"))).toBe(1); }
    expect(Object.getOwnPropertyDescriptor(source, "voltageVolts")?.enumerable).toBe(false);
    expect(source.voltageVolts).toBe(1);
    expect(source.frequencyHz).toBe(1000);
  });

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
