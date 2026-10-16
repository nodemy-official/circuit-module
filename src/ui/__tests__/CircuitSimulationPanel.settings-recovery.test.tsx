// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitExample } from "../../circuit-examples.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitAnalysisOptions } from "../../circuit-solver.js";
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

describe("analysis settings after failed AC analysis", () => {
  it.each((["ac", "auto"] as const).flatMap((mode) => [0, -1, Number.NaN].map((frequencyHz) => ({ mode, frequencyHz }))))
  ("allows correcting an invalid frequency in $mode mode ($frequencyHz Hz)", ({ mode, frequencyHz }) => {
    const circuit = createCircuitExample("ac");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    let latestAnalysis: CircuitAnalysis | undefined;
    function Harness() {
      const [options, setOptions] = useState<CircuitAnalysisOptions>({ mode, frequencyHz });
      latestAnalysis = analyzeCircuit(circuit, {}, options);
      return <CircuitSimulationPanel document={circuit} analysis={latestAnalysis} options={options} onChange={setOptions} showLearningPanels={false} />;
    }
    act(() => root.render(<Harness />));
    expect(latestAnalysis?.status).toBe("invalid");
    const frequency = container.querySelector<HTMLInputElement>('input[id$="-frequency"]');
    expect(frequency).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(frequency, "1000");
      frequency!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(latestAnalysis?.status).toBe("closed");
    expect(latestAnalysis?.mode).toBe("ac");
    expect(latestAnalysis?.frequencyHz).toBe(1000);
    expect(frequency?.value).toBe("1000");
  });

  it.each((["dc", "auto"] as const).flatMap((mode) => [0, -1, Number.NaN].map((frequencyHz) => ({ mode, frequencyHz }))))
  ("clears an invalid frequency when changing $mode mode without an AC source ($frequencyHz Hz)", ({ mode, frequencyHz }) => {
    const circuit = createCircuitExample("dc");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    let latestAnalysis: CircuitAnalysis | undefined;
    function Harness() {
      const [options, setOptions] = useState<CircuitAnalysisOptions>({ mode, frequencyHz });
      latestAnalysis = analyzeCircuit(circuit, {}, options);
      return <CircuitSimulationPanel document={circuit} analysis={latestAnalysis} options={options} onChange={setOptions} showLearningPanels={false} />;
    }
    act(() => root.render(<Harness />));
    expect(latestAnalysis?.status).toBe("invalid");
    expect(container.querySelector('input[id$="-frequency"]')).toBeNull();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      select.value = mode === "dc" ? "auto" : "dc";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(latestAnalysis?.status).toBe("closed");
    expect(select.value).toBe(mode === "dc" ? "auto" : "dc");
  });
});
