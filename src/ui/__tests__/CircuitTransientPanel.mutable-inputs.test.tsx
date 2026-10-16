// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import type { CircuitTransientFrame } from "../../circuit-visualization.js";
import { CircuitSimulationPanel } from "../CircuitSimulationPanel.js";
import { CircuitTransientPanel } from "../CircuitTransientPanel.js";

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const root of roots.splice(0)) { act(() => root.unmount()); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function circuit(): CircuitDocument {
  return {
    title: "スイッチ付き抵抗回路",
    parts: [
      { id: "load", kind: "resistor", label: "負荷", x: 4, y: 0, resistanceOhms: 20 },
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 1 },
      { id: "toggle", kind: "switch", label: "スイッチ", x: 8, y: 0, initiallyClosed: true },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "toggle", terminal: "a" } },
      { id: "c", from: { partId: "toggle", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

function containerAndRoot() {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  return { container, root };
}

function calculate(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "波形を計算");
  if (!button) { throw new Error("Missing calculate button"); }
  act(() => button.click());
}

describe("transient results after in-place circuit edits", () => {
  it.each(["current", "baseline"] as const)("invalidates a shared %s capture on a child's playback tick", (side) => {
    vi.useFakeTimers();
    const document = circuit();
    const baselineDocument = circuit();
    const options = { mode: "dc" as const };
    const analysis = analyzeCircuit(document, {}, options);
    const frames: Array<CircuitTransientFrame | null> = [];
    const { container, root } = containerAndRoot();
    act(() => root.render(<CircuitSimulationPanel
      document={document} baselineDocument={baselineDocument} analysis={analysis} options={options}
      onChange={() => {}} onFrameChange={(frame) => frames.push(frame)}
    />));
    calculate(container);
    expect(frames.at(-1)?.analysis.samples[0]?.parts.load?.voltageVolts).toBe(1);
    const play = [...container.querySelectorAll("button")].find((button) => button.textContent === "再生");
    if (!play) { throw new Error("Missing playback button"); }
    act(() => play.click());

    const changed = side === "current" ? document : baselineDocument;
    changed.parts[1]!.voltageVolts = 2;
    act(() => vi.advanceTimersByTime(50));

    expect(container.querySelector(".circuit-waveform") === null).toBe(true);
    expect(frames.at(-1)).toBeNull();
    expect(container.textContent).toContain("波形を再計算してください");
  });

  it.each([
    ["current", "source"], ["current", "wire"], ["current", "switch"],
    ["baseline", "source"], ["baseline", "wire"], ["baseline", "switch"],
  ] as const)("invalidates current frames after the %s %s changes", (side, field) => {
    const document = circuit();
    const baselineDocument = circuit();
    const frames: Array<CircuitTransientFrame | null> = [];
    const { container, root } = containerAndRoot();
    const render = () => act(() => root.render(<CircuitTransientPanel
      document={document} baselineDocument={baselineDocument} onFrameChange={(frame) => frames.push(frame)}
    />));
    render();
    calculate(container);
    expect(frames.at(-1)?.analysis.samples[0]?.parts.load?.voltageVolts).toBe(1);

    const changed = side === "current" ? document : baselineDocument;
    if (field === "source") { changed.parts[1]!.voltageVolts = 2; }
    if (field === "wire") { changed.wires[0]!.from.terminal = "b"; }
    if (field === "switch") { changed.parts[2]!.initiallyClosed = false; }
    render();

    expect(container.querySelector(".circuit-waveform")).toBeNull();
    expect(container.textContent).toContain("波形を再計算してください");
    expect(frames.at(-1)).toBeNull();
    calculate(container);
    const expectedVoltage = field === "source" ? 2 : 0;
    expect(frames.at(-1)?.analysis.samples[0]?.parts.load?.voltageVolts).toBe(side === "current" ? expectedVoltage : 1);
    const cells = container.querySelectorAll('.circuit-transient__readings tr[data-part-id="load"] td');
    expect(cells[side === "current" ? 0 : 2]?.textContent).toBe(String(expectedVoltage));
  });

  it("refreshes a switch-override copy before recalculating an in-place document edit", () => {
    const document = circuit();
    document.parts[2]!.initiallyClosed = false;
    const options = { mode: "dc" as const };
    const analysis = analyzeCircuit(document, { toggle: true }, options);
    const frames: Array<CircuitTransientFrame | null> = [];
    const { container, root } = containerAndRoot();
    const render = () => act(() => root.render(<CircuitSimulationPanel
      document={document} analysis={analysis} options={options} onChange={() => {}}
      onFrameChange={(frame) => frames.push(frame)}
    />));
    render();
    calculate(container);
    expect(frames.at(-1)?.analysis.samples[0]?.parts.load?.voltageVolts).toBe(1);

    document.parts[1]!.voltageVolts = 2;
    Object.assign(analysis, analyzeCircuit(document, { toggle: true }, options));
    render();

    expect(container.querySelector(".circuit-waveform")).toBeNull();
    expect(frames.at(-1)).toBeNull();
    calculate(container);
    expect(frames.at(-1)?.analysis.samples[0]?.parts.load?.voltageVolts).toBe(2);
    expect(frames.at(-1)?.analysis.samples[0]?.parts.toggle?.switchClosed).toBe(true);
    expect(document.parts[2]!.initiallyClosed).toBe(false);
  });

  it("refreshes the steady comparison after its baseline is edited in place", () => {
    const document = circuit();
    const baselineDocument = circuit();
    const options = { mode: "dc" as const };
    const analysis = analyzeCircuit(document, {}, options);
    const { container, root } = containerAndRoot();
    const render = () => act(() => root.render(<CircuitSimulationPanel
      document={document} analysis={analysis} options={options} onChange={() => {}} baselineDocument={baselineDocument}
    />));
    render();
    const beforeVoltage = () => container.querySelector('.circuit-comparison tr[data-part-id="load"] td')?.textContent;
    expect(beforeVoltage()).toBe("1");

    baselineDocument.parts[1]!.voltageVolts = 2;
    render();

    expect(beforeVoltage()).toBe("2");
  });
});
