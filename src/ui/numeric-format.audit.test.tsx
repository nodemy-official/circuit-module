// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument, CircuitPart } from "../circuit-model.js";
import type { CircuitAnalysis, CircuitPartReading } from "../circuit-solver.js";
import { formatCircuitNumber } from "../number-format.js";
import type { TransientAnalysis } from "../transient-solver.js";
import { CircuitAcPanel } from "./CircuitAcPanel.js";
import { CircuitAnalysisPanel } from "./CircuitAnalysisPanel.js";
import { CircuitComparisonPanel } from "./CircuitComparisonPanel.js";
import { CircuitEnergyPanel } from "./CircuitEnergyPanel.js";
import { CircuitInspector } from "./CircuitInspector.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const maximum = Number.MAX_VALUE;
const maximumText = "1.798e+308";

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

function part(id: string, kind: CircuitPart["kind"], label: string): CircuitPart {
  return { id, kind, label, x: 0, y: 0 };
}

function analysis(parts: Record<string, CircuitPartReading> = {}): CircuitAnalysis {
  return {
    status: "closed",
    currentAmps: maximum,
    message: "解析完了",
    bulbPowerWatts: {},
    parts,
    wireCurrents: {},
    issues: [],
  };
}

function mountTransientPanel(document: CircuitDocument) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CircuitTransientPanel document={document} />));
  mounted.push({ root, container });
  return container;
}

describe("shared numeric formatting at the finite range boundary", () => {
  it("preserves rounded finite maxima, ordinary precision, and the non-finite placeholder", () => {
    expect(formatCircuitNumber(maximum)).toBe(maximumText);
    expect(formatCircuitNumber(-maximum)).toBe(`-${maximumText}`);
    expect(formatCircuitNumber(12.345_67)).toBe("12.35");
    expect(formatCircuitNumber(0)).toBe("0");
    expect(formatCircuitNumber(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCircuitNumber(Number.NaN)).toBe("—");
  });

  it("keeps finite maxima readable in the AC panel, analysis summary, and inspector", () => {
    const source = part("source", "ac-source", "交流電源");
    const document: CircuitDocument = { title: "最大有限値", parts: [source], wires: [] };
    const reading: CircuitPartReading = {
      voltageVolts: maximum,
      currentAmps: maximum,
      powerWatts: maximum,
      voltagePhaseDegrees: 0,
      currentPhaseDegrees: 0,
    };
    const acMarkup = renderToStaticMarkup(<CircuitAcPanel
      document={document}
      analysis={{ ...analysis({ source: reading }), mode: "ac", frequencyHz: 50 }}
      options={{ mode: "ac", frequencyHz: 50 }}
    />);
    const analysisMarkup = renderToStaticMarkup(<CircuitAnalysisPanel analysis={{
      ...analysis(),
      timeSeconds: maximum,
    }} />);
    const inspectorMarkup = renderToStaticMarkup(<CircuitInspector
      part={part("load", "resistor", "負荷")}
      reading={reading}
      readingTimeSeconds={maximum}
      analysisStatus="closed"
    />);

    for (const markup of [acMarkup, analysisMarkup, inspectorMarkup]) {
      expect(markup).toContain(maximumText);
      expect(markup).not.toContain("Infinity");
    }
    expect(acMarkup).toContain(`実効値 ${maximumText} V`);
    expect(analysisMarkup).toContain(`過渡 ${maximumText} s`);
    expect(inspectorMarkup).toContain(`時間カーソル ${maximumText} s の瞬時値です。`);
  });

  it("keeps finite maxima readable in comparison and energy panels", () => {
    const load = part("load", "resistor", "負荷");
    const document: CircuitDocument = { title: "最大有限値", parts: [load], wires: [] };
    const reading: CircuitPartReading = { voltageVolts: maximum, currentAmps: maximum, powerWatts: maximum };
    const current = analysis({ load: reading });
    const baseline: CircuitAnalysis = {
      ...analysis({ load: { voltageVolts: -maximum, currentAmps: -maximum, powerWatts: -maximum } }),
    };
    const comparisonMarkup = renderToStaticMarkup(<CircuitComparisonPanel
      document={document}
      analysis={current}
      baselineDocument={document}
      baselineAnalysis={baseline}
    />);
    const transient: TransientAnalysis = {
      status: "valid",
      message: "過渡解析が完了しました。",
      issues: [],
      samples: [{
        timeSeconds: maximum,
        parts: { load: { voltageVolts: maximum, currentAmps: maximum, powerWatts: maximum } },
      }],
    };
    const energyMarkup = renderToStaticMarkup(<CircuitEnergyPanel
      document={document}
      analysis={current}
      frame={{ analysis: transient, sampleIndex: 0 }}
    />);

    for (const markup of [comparisonMarkup, energyMarkup]) {
      expect(markup).toContain(maximumText);
      expect(markup).not.toContain("Infinity");
    }
    expect(energyMarkup).toContain(`t = ${maximumText} s`);
    expect(energyMarkup).toContain(`${maximumText} W`);
  });

  it("shows a finite maximum endpoint in the interactive transient waveform", () => {
    const document: CircuitDocument = {
      title: "最大時間波形",
      parts: [part("load", "resistor", "負荷")],
      wires: [],
    };
    const container = mountTransientPanel(document);
    const durationInput = container.querySelector<HTMLInputElement>('input[type="number"][id$="-duration"]');
    const calculateButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "波形を計算");
    if (!durationInput || !calculateButton) { throw new Error("Transient controls were not rendered"); }

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(durationInput, String(maximum));
      durationInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => calculateButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector('[role="alert"]')?.textContent).toBeUndefined();
    expect(container.textContent).toContain(`${maximumText} s`);
    expect(container.textContent).not.toContain("Infinity");
  });
});
