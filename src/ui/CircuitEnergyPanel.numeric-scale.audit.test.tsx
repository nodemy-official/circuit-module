// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { simulateTransient, type TransientAnalysis } from "../transient-solver.js";
import { renderToStaticMarkup } from "react-dom/server";
import { CircuitEnergyPanel } from "./CircuitEnergyPanel.js";

function rowValue(markup: string, partId: string, attribute: string): number | null {
  const match = markup.match(new RegExp(`data-part-id="${partId}"[^>]*${attribute}="([^"]+)"`));
  return match?.[1] === undefined ? null : Number(match[1]);
}

function panelMarkup(document: CircuitDocument, analysis: TransientAnalysis, sampleIndex = 0) {
  return renderToStaticMarkup(<CircuitEnergyPanel
    document={document}
    analysis={analyzeCircuit(document)}
    frame={{ analysis, sampleIndex }}
  />);
}

describe("energy numeric scale audit", () => {
  it.each([
    ["capacitor large", "capacitor", 1e-200, 1e200, 5e199],
    ["capacitor small", "capacitor", 1e200, 1e-200, 5e-201],
    ["inductor large", "inductor", 1e-200, 1e200, 5e199],
    ["inductor small", "inductor", 1e200, 1e-200, 5e-201],
  ] as const)("keeps %s stored energy representable", (_label, kind, coefficient, state, expected) => {
    const id = "reactive";
    const document: CircuitDocument = {
      title: "極端な有限エネルギー",
      parts: kind === "capacitor"
        ? [{ id, kind, label: id, x: 0, y: 0, capacitanceFarads: coefficient, initialVoltageVolts: state }]
        : [
          { id: "source", kind: "current-source", label: "source", x: 0, y: 0, currentAmps: state },
          { id, kind, label: id, x: 0, y: 0, inductanceHenries: coefficient, initialCurrentAmps: state },
        ],
      wires: kind === "inductor"
        ? [
          { id: "wire-a", from: { partId: "source", terminal: "b" }, to: { partId: id, terminal: "a" } },
          { id: "wire-b", from: { partId: id, terminal: "b" }, to: { partId: "source", terminal: "a" } },
        ]
        : [],
    };
    const durationSeconds = kind === "inductor" ? coefficient : Math.max(1e-100, coefficient);
    const result = simulateTransient(document, { durationSeconds, timeStepSeconds: durationSeconds });

    expect(result.status, result.message).toBe("valid");
    const markup = panelMarkup(document, result);
    const energy = rowValue(markup, id, "data-energy-joules");
    expect(energy).not.toBeNull();
    expect((energy ?? Number.NaN) / expected).toBeCloseTo(1, 12);
  });

  it("integrates two large finite resistor powers without overflowing their sum", () => {
    const document: CircuitDocument = {
      title: "大電力・短時間の抵抗",
      parts: [
        { id: "source", kind: "current-source", label: "source", x: 0, y: 0, currentAmps: 1 },
        { id: "load", kind: "resistor", label: "load", x: 0, y: 0, resistanceOhms: 1e308 },
      ],
      wires: [
        { id: "wire-a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "wire-b", from: { partId: "source", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 1e-308, timeStepSeconds: 1e-308 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.load?.powerWatts).toBe(1e308);
    expect(result.samples[1]?.parts.load?.powerWatts).toBe(1e308);
    const markup = panelMarkup(document, result, 1);
    expect(rowValue(markup, "load", "data-dissipated-joules")).toBeCloseTo(1, 14);
    expect(markup).toContain('data-dissipation-valid="true"');
  });

  it("preserves the smallest positive power when averaging identical endpoints", () => {
    const document: CircuitDocument = {
      title: "最小の有限電力",
      parts: [{ id: "load", kind: "resistor", label: "load", x: 0, y: 0, resistanceOhms: 1 }],
      wires: [],
    };
    const solved = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
    const analysis: TransientAnalysis = {
      ...solved,
      samples: solved.samples.map((sample) => ({
        ...sample,
        parts: { ...sample.parts, load: { ...sample.parts.load!, powerWatts: Number.MIN_VALUE } },
      })),
    };

    expect(solved.status, solved.message).toBe("valid");
    const markup = panelMarkup(document, analysis, 1);
    expect(rowValue(markup, "load", "data-dissipated-joules")).toBe(Number.MIN_VALUE);
  });

  it("rounds a subnormal stored-energy product to the nearest representable value", () => {
    const document: CircuitDocument = {
      title: "サブノーマルな蓄積エネルギー",
      parts: [{ id: "capacitor", kind: "capacitor", label: "capacitor", x: 0, y: 0, capacitanceFarads: Number.MIN_VALUE }],
      wires: [],
    };
    const analysis: TransientAnalysis = {
      status: "valid",
      message: "過渡解析が完了しました。",
      issues: [],
      samples: [{
        timeSeconds: 0,
        parts: {
          capacitor: { voltageVolts: 1.5, currentAmps: 0, powerWatts: 0 },
        },
      }],
    };

    const markup = panelMarkup(document, analysis);
    expect(rowValue(markup, "capacitor", "data-energy-joules")).toBe(Number.MIN_VALUE);
  });

  it("marks cumulative dissipation unavailable after its true value exceeds the numeric range", () => {
    const document: CircuitDocument = {
      title: "表現範囲を超える累積消費",
      parts: [
        { id: "source", kind: "current-source", label: "source", x: 0, y: 0, currentAmps: 1 },
        { id: "load", kind: "resistor", label: "load", x: 0, y: 0, resistanceOhms: 1e308 },
      ],
      wires: [
        { id: "wire-a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "wire-b", from: { partId: "source", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 2, timeStepSeconds: 2 });

    expect(result.status, result.message).toBe("valid");
    const markup = panelMarkup(document, result, 1);
    expect(markup).toContain('data-dissipation-valid="false"');
    expect(markup).toContain("<output>—</output>");
  });
});
