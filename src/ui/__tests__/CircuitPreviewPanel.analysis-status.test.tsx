// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { createExampleCircuit } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitBoard } from "../CircuitBoard.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { getMeterDisplay } from "../CircuitMeterReadout.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";
import { CircuitPreviewParts } from "../CircuitPreviewParts.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function analyzedCircuit(mode: "dc" | "ac") {
  const document = createCircuitFromSpecs([
    ["source", mode === "dc" ? "battery" : "ac-source", ["s", "0"], { voltageVolts: 9, frequencyHz: 1000, phaseDegrees: 45 }],
    ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
  ], "状態が変わったプレビューの計測値");
  const analysis = analyzeCircuit(document);
  if (analysis.status !== "closed") { throw new Error(`Unexpected fixture analysis: ${analysis.message}`); }
  return { document, analysis };
}

function readings(mode: "dc" | "ac", status?: "invalid" | "short" | "empty") {
  const { document, analysis } = analyzedCircuit(mode);
  const container = globalThis.document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitPreviewPanel document={document}
    analysis={status ? { ...analysis, status } : analysis} partId="load" onChange={() => {}} onReset={() => {}} />);
  return container;
}

describe("preview readings after analysis becomes unavailable", () => {
  it.each((["dc", "ac"] as const).flatMap((mode) =>
    (["invalid", "short", "empty"] as const).map((status) => ({ mode, status }))))
  ("hides retained $mode readings when the analysis is $status", ({ mode, status }) => {
    const container = readings(mode, status);

    expect([...container.querySelectorAll("[data-measurement] dd")].map((item) => item.textContent))
      .toEqual(mode === "ac" ? ["—", "—", "—", "—"] : ["—", "—", "—"]);
    expect(container.querySelector('[data-measurement="voltage-phase"]')).toBeNull();
    expect(container.querySelector('[data-measurement="current-phase"]')).toBeNull();
  });

  it.each(["dc", "ac"] as const)("keeps valid %s measurements visible", (mode) => {
    const container = readings(mode);

    expect(container.querySelector('[data-measurement="voltage"] dd')?.textContent).toBe("9 V");
    expect(container.querySelector('[data-measurement="current"] dd')?.textContent).toBe("900 mA");
    expect(container.querySelector('[data-measurement="voltage-phase"]') !== null).toBe(mode === "ac");
  });

  it.each(["invalid", "short", "empty"] as const)("hides a retained Inspector reading when the analysis is %s", (status) => {
    const { document, analysis } = analyzedCircuit("ac");
    const container = globalThis.document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CircuitInspector part={document.parts[1]}
      reading={analysis.parts.load} analysisStatus={status} />);

    expect(container.querySelector(".circuit-inspector__readings")).toBeNull();
  });

  it.each(["invalid", "short", "empty"] as const)("stops retained bulb light and switch overrides on a %s board", (status) => {
    const document = createExampleCircuit();
    const analysis = analyzeCircuit(document);
    expect(analysis.parts["part-3"]!.brightness).toBeGreaterThan(0);
    document.parts[3]!.initiallyClosed = false;
    const container = globalThis.document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CircuitBoard document={document} analysis={{ ...analysis, status }}
      readOnly onSwitchToggle={() => {}} showPotentials={false} showFlow={false} renderControls={null} />);

    expect(container.querySelector('[data-part-id="part-3"] [data-lit]')?.getAttribute("data-lit")).toBe("false");
    expect(container.querySelector('[data-part-id="part-4"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it.each(["invalid", "short", "empty"] as const)("stops retained bulb light and switch overrides in a %s parts list", (status) => {
    const document = createExampleCircuit();
    const analysis = analyzeCircuit(document);
    document.parts[3]!.initiallyClosed = false;
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => root.render(<CircuitPreviewParts document={document} initialDocument={document} analysis={{ ...analysis, status }}
      onInspectPart={() => {}} onSwitchToggle={() => {}} onReset={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click());

    expect(container.querySelector('[data-part-id="part-3"] [data-lit]')?.getAttribute("data-lit")).toBe("false");
    expect(container.querySelector('[data-part-id="part-4"] [aria-pressed]')?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[data-part-id="part-3"] .circuit-preview-parts__readings')?.textContent).not.toContain("1.8");
  });

  it("does not call a retained meter reading connected when the analysis is empty", () => {
    const { analysis } = analyzedCircuit("ac");
    const display = getMeterDisplay("voltmeter", analysis.parts.load, "empty");

    expect(display?.status).toBe("unmeasured");
    expect(display?.text).toContain("—");
    expect(display?.phaseText).toBeUndefined();
  });
});
