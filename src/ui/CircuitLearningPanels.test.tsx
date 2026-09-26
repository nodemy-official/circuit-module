// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitExample } from "../circuit-examples.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { simulateTransient } from "../transient-solver.js";
import { CircuitAcPanel } from "./CircuitAcPanel.js";
import { CircuitEnergyPanel } from "./CircuitEnergyPanel.js";

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

function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return { container, root };
}

function required<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

describe("CircuitEnergyPanel", () => {
  it("shows a valid transient frame when the steady analysis is invalid", () => {
    const document = createCircuitExample("charging");
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.0001 });
    expect(transient.status).toBe("valid");
    const analysis = { ...analyzeCircuit(document), status: "invalid" as const, message: "定常解析に失敗" };
    const markup = renderToStaticMarkup(
      <CircuitEnergyPanel document={document} analysis={analysis} frame={{ analysis: transient, sampleIndex: 5 }} />,
    );

    expect(markup).toContain('data-state="transient"');
    expect(markup).toContain("過渡解析 · t =");
    expect(markup).not.toContain("定常解析に失敗");
  });

  it("uses passive transient power signs and integrates resistor dissipation through the selected sample", () => {
    const document = createCircuitExample("charging");
    const transient = simulateTransient(document, { durationSeconds: 0.002, timeStepSeconds: 0.000_02 });
    expect(transient.status).toBe("valid");
    const sampleIndex = Math.floor((transient.samples.length - 1) / 2);
    const sample = transient.samples[sampleIndex];
    expect(sample).toBeDefined();
    const capacitor = document.parts.find((part) => part.id === "load");
    expect(capacitor?.kind).toBe("capacitor");
    const expectedStoredJoules = 0.5 * (capacitor?.capacitanceFarads ?? 0) * (sample?.parts.load?.voltageVolts ?? 0) ** 2;
    const expectedMaximumStoredJoules = Math.max(...transient.samples.map((entry) =>
      0.5 * (capacitor?.capacitanceFarads ?? 0) * (entry.parts.load?.voltageVolts ?? 0) ** 2,
    ));
    let expectedDissipationJoules = 0;
    let expectedMaximumDissipationJoules = 0;
    for (let index = 1; index <= sampleIndex; index += 1) {
      const previous = transient.samples[index - 1];
      const current = transient.samples[index];
      const previousPower = Math.max(0, previous?.parts.resistor?.powerWatts ?? 0);
      const currentPower = Math.max(0, current?.parts.resistor?.powerWatts ?? 0);
      expectedDissipationJoules += (previousPower + currentPower) / 2 * ((current?.timeSeconds ?? 0) - (previous?.timeSeconds ?? 0));
    }
    for (let index = 1; index < transient.samples.length; index += 1) {
      const previous = transient.samples[index - 1];
      const current = transient.samples[index];
      const previousPower = Math.max(0, previous?.parts.resistor?.powerWatts ?? 0);
      const currentPower = Math.max(0, current?.parts.resistor?.powerWatts ?? 0);
      expectedMaximumDissipationJoules += (previousPower + currentPower) / 2 * ((current?.timeSeconds ?? 0) - (previous?.timeSeconds ?? 0));
    }
    const analysis = analyzeCircuit(document, {}, { mode: "dc" });
    const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis} frame={{ analysis: transient, sampleIndex }} />);

    const stored = markup.match(/class="circuit-energy__energy-row"[^>]*data-part-id="load"[^>]*data-energy-joules="([^"]+)"/);
    const dissipated = markup.match(/class="circuit-energy__energy-row"[^>]*data-part-id="resistor"[^>]*data-dissipated-joules="([^"]+)"/);
    const sourceRow = markup.match(/class="circuit-energy__power-row"[^>]*data-part-id="source"[^>]*data-watts="([^"]+)"/);
    const resistorRow = markup.match(/class="circuit-energy__power-row"[^>]*data-part-id="resistor"[^>]*data-watts="([^"]+)"/);
    expect(Number(stored?.[1])).toBeCloseTo(expectedStoredJoules, 14);
    expect(Number(dissipated?.[1])).toBeCloseTo(expectedDissipationJoules, 14);
    expect(Number(sourceRow?.[1])).toBeCloseTo(-(sample?.parts.source?.powerWatts ?? 0), 12);
    expect(Number(resistorRow?.[1])).toBeCloseTo(sample?.parts.resistor?.powerWatts ?? 0, 12);
    const scaleMaxima = Array.from(markup.matchAll(/data-scale-max="([^"]+)"/g), (match) => Number(match[1]));
    expect(scaleMaxima[0]).toBeCloseTo(expectedMaximumStoredJoules, 14);
    expect(scaleMaxima[1]).toBeCloseTo(expectedMaximumDissipationJoules, 14);
    expect(markup).toContain("circuit-energy__quantity-bar-fill\" style=\"width:");
    expect(markup).toContain("過渡サンプルの瞬時電力を積分しています");
    expect(markup).toContain("総和を保存則の検査値としては表示しません");

    const missingSamples = transient.samples.map((entry, index) => {
      if (index !== 2) { return entry; }
      const parts = Object.fromEntries(Object.entries(entry.parts).filter(([partId]) => partId !== "resistor"));
      return { ...entry, parts };
    });
    const missingMarkup = renderToStaticMarkup(<CircuitEnergyPanel
      document={document}
      analysis={analysis}
      frame={{ analysis: { ...transient, samples: missingSamples }, sampleIndex }}
    />);
    expect(missingMarkup).toContain('data-dissipation-valid="false"');
    expect(missingMarkup).toContain("<output>—</output>");
  });

  it("labels AC capacitor energy as a cycle average and follows the RMS phasor equations", () => {
    const document = createCircuitExample("ac");
    const frequencyHz = document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const capacitor = document.parts.find((part) => part.id === "load");
    const reading = analysis.parts.load;
    expect(analysis.status).toBe("closed");
    expect(reading).toBeDefined();
    if (!capacitor || !reading) { throw new Error("AC example capacitor reading is missing"); }
    const expectedAverageJoules = 0.5 * (capacitor.capacitanceFarads ?? 0) * reading.voltageVolts ** 2;
    const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis} />);
    const stored = markup.match(/class="circuit-energy__energy-row"[^>]*data-part-id="load"[^>]*data-energy-joules="([^"]+)"/);

    expect(markup).toContain("交流成分の周期平均です。瞬時値ではありません。");
    expect(markup).toContain('data-energy-kind="period-average"');
    expect(Number(stored?.[1])).toBeCloseTo(expectedAverageJoules, 14);
  });

  it("matches the stored and dissipated halves of a long RC charge to the source-energy formula", () => {
    const document = createCircuitExample("charging");
    const transient = simulateTransient(document, { durationSeconds: 0.02, timeStepSeconds: 0.000_02 });
    expect(transient.status).toBe("valid");
    const sampleIndex = transient.samples.length - 1;
    const sample = transient.samples[sampleIndex];
    const capacitor = document.parts.find((part) => part.id === "load");
    const battery = document.parts.find((part) => part.id === "source");
    if (!sample || !capacitor || capacitor.kind !== "capacitor" || !battery || capacitor.capacitanceFarads === undefined) {
      throw new Error("RC example is incomplete");
    }
    const expectedHalfEnergy = 0.5 * capacitor.capacitanceFarads * (battery.voltageVolts ?? 0) ** 2;
    const analysis = analyzeCircuit(document, {}, { mode: "dc" });
    const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis} frame={{ analysis: transient, sampleIndex }} />);
    const storedJoules = Number(markup.match(/data-part-id="load" data-energy-joules="([^"]+)"/)?.[1]);
    const dissipatedJoules = Number(markup.match(/data-part-id="resistor" data-dissipated-joules="([^"]+)"/)?.[1]);

    expect(Math.abs(storedJoules - expectedHalfEnergy) / expectedHalfEnergy).toBeLessThan(0.02);
    expect(Math.abs(dissipatedJoules - expectedHalfEnergy) / expectedHalfEnergy).toBeLessThan(0.02);
  });
});

describe("CircuitAcPanel", () => {
  it("shows independent voltage and current axes with a phase difference from AC solver phasors", () => {
    const document = createCircuitExample("ac");
    const frequencyHz = document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const reading = analysis.parts.load;
    if (!reading) { throw new Error("AC example capacitor reading is missing"); }
    const markup = renderToStaticMarkup(<CircuitAcPanel document={document} analysis={analysis} options={{ mode: "ac", frequencyHz }} />);
    const phaseDifference = ((reading.currentPhaseDegrees ?? 0) - (reading.voltagePhaseDegrees ?? 0) + 180 + 360) % 360 - 180;
    const renderedDifference = markup.match(/data-phase-difference-degrees="([^"]+)"/)?.[1];

    expect(markup).toContain("電圧（左軸、V");
    expect(markup).toContain("電流（右軸、A");
    expect(Number(renderedDifference)).toBeCloseTo(phaseDifference, 5);
    expect(phaseDifference).toBeCloseTo(90, 0);
    expect(markup).toContain(`data-analysis-frequency="${frequencyHz}"`);
  });

  it("runs a bounded logarithmic sweep through the AC solver and preserves the source document", () => {
    const document = createCircuitExample("ac");
    const frequencyHz = document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const ui = mount(<CircuitAcPanel document={document} analysis={analysis} options={{ mode: "ac", frequencyHz }} />);

    act(() => required<HTMLButtonElement>(ui.container, "button").click());

    const dots = Array.from(ui.container.querySelectorAll<SVGCircleElement>(".circuit-ac__response-dot"));
    expect(dots).toHaveLength(41);
    expect(Number(dots[0]?.getAttribute("data-voltage-rms"))).toBeGreaterThan(Number(dots.at(-1)?.getAttribute("data-voltage-rms")));
    expect(Number(dots[0]?.getAttribute("data-frequency-hz"))).toBeCloseTo(frequencyHz / 10, 8);
    expect(Number(dots.at(-1)?.getAttribute("data-frequency-hz"))).toBeCloseTo(frequencyHz * 10, 6);
    expect(document.parts.find((part) => part.kind === "ac-source")?.frequencyHz).toBe(frequencyHz);
  });

  it("tracks the current AC analysis frequency and renders an empty state when AC is disabled", () => {
    const document = createCircuitExample("ac");
    const frequencyHz = document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const ui = mount(<CircuitAcPanel document={document} analysis={analysis} options={{ mode: "ac", frequencyHz }} />);
    const nextFrequencyHz = frequencyHz * 2;
    const nextAnalysis = analyzeCircuit({
      ...document,
      parts: document.parts.map((part) => part.kind === "ac-source" ? { ...part, frequencyHz: nextFrequencyHz } : part),
    }, {}, { mode: "ac", frequencyHz: nextFrequencyHz });

    act(() => ui.root.render(<CircuitAcPanel document={document} analysis={nextAnalysis} options={{ mode: "ac", frequencyHz: nextFrequencyHz }} />));
    expect(required<HTMLElement>(ui.container, ".circuit-ac__frequency").getAttribute("data-analysis-frequency")).toBe(String(nextFrequencyHz));
    act(() => ui.root.render(<CircuitAcPanel document={document} analysis={{ ...nextAnalysis, mode: "dc" }} options={{ mode: "dc" }} />));
    expect(required<HTMLElement>(ui.container, ".circuit-ac").getAttribute("data-state")).toBe("empty");
    expect(ui.container.textContent).toContain("交流解析を選ぶと");
  });
});
