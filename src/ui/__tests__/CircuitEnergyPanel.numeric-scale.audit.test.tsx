// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient, type TransientAnalysis } from "../../transient-solver.js";
import { renderToStaticMarkup } from "react-dom/server";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

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
  it.each(["capacitor", "inductor"] as const)("uses the retained fractional %s state for stored energy", (kind) => {
    const document: CircuitDocument = {
      title: "厳密な分数の蓄積エネルギー",
      parts: [
        { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 1 },
        { id: "upper", kind: "resistor", label: "上側抵抗", x: 0, y: 0, resistanceOhms: 2 },
        { id: "lower", kind: "resistor", label: "下側抵抗", x: 0, y: 0, resistanceOhms: 1 },
        { id: "reactive", kind, label: "蓄積部品", x: 0, y: 0,
          ...(kind === "capacitor" ? { capacitanceFarads: 9 } : { inductanceHenries: 9 }) },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "upper", terminal: "a" } },
        { id: "b", from: { partId: "upper", terminal: "b" }, to: { partId: "lower", terminal: "a" } },
        { id: "c", from: { partId: "lower", terminal: "b" }, to: { partId: kind === "capacitor" ? "source" : "reactive", terminal: kind === "capacitor" ? "b" : "a" } },
        { id: "d", from: { partId: "reactive", terminal: "a" }, to: { partId: "lower", terminal: kind === "capacitor" ? "a" : "b" } },
        { id: "e", from: { partId: "reactive", terminal: "b" }, to: { partId: "source", terminal: "b" } },
        { id: "g", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      ].filter((wire) => kind === "capacitor" || wire.id !== "d"),
    };
    const steady = analyzeCircuit(document);
    expect(steady.status).toBe("closed");
    // V_C=1/(2+1) V or I_L=1/(2+1) A, giving 9/2*(1/3)²=1/2 J.
    const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={steady} />);
    expect(rowValue(markup, "reactive", "data-energy-joules")).toBe(0.5);
    const transient = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1, startFromOperatingPoint: true });
    expect(transient.status, transient.message).toBe("valid");
    for (const analysis of [transient, JSON.parse(JSON.stringify(transient)) as TransientAnalysis, structuredClone(transient)]) {
      expect(rowValue(panelMarkup(document, analysis, 1), "reactive", "data-energy-joules")).toBe(0.5);
    }
  });

  it.each([0, 37, 45, 90])("keeps normalized AC stored energy independent of the source phase (%s degrees)", (phaseDegrees) => {
    const document: CircuitDocument = {
      title: "交流の周期平均エネルギー",
      parts: [
        { id: "source", kind: "ac-source", label: "電源", x: 0, y: 0, voltageVolts: 1, frequencyHz: 1, phaseDegrees },
        { id: "capacitor", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 9 },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "b", from: { partId: "capacitor", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("closed");
    const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis} />);
    // Average E=1/2*C*V_RMS², and ideal source V_RMS=1 at every phase.
    expect(rowValue(markup, "capacitor", "data-energy-joules")).toBe(4.5);
  });

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

  it.each([
    [2 ** -537, 1, Number.MIN_VALUE],
    [2 ** -537, 2, 2 * Number.MIN_VALUE],
    [2 ** -540, 64, Number.MIN_VALUE],
  ])("accumulates unrepresentable power or interval energy (V=%s, t=%s)", (voltageVolts, durationSeconds, expected) => {
    const document: CircuitDocument = {
      title: "微小な消費エネルギーの累積",
      parts: [
        { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts },
        { id: "load", kind: "resistor", label: "抵抗", x: 0, y: 0, resistanceOhms: 1 },
        { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
        { id: "g", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      ],
    };
    const result = simulateTransient(document, { durationSeconds, timeStepSeconds: durationSeconds / 2 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples.every((sample) => sample.parts.load!.powerWatts === voltageVolts * voltageVolts)).toBe(true);
    // Constant P=V²/R gives E=P*t. Either P or each interval's energy
    // rounds to zero, while the full integral is representable.
    const markup = panelMarkup(document, result, result.samples.length - 1);
    expect(rowValue(markup, "load", "data-dissipated-joules")).toBe(expected);
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
