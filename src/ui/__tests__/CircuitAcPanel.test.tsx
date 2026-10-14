import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { circuitPartCatalog, type CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import type { CircuitAnalysis, CircuitAnalysisOptions } from "../../circuit-solver.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";

function phasePanelMarkup(voltagePhaseDegrees: number, currentPhaseDegrees: number) {
  const document: CircuitDocument = {
    title: "位相の境界値",
    parts: [{ id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0 }],
    wires: [],
  };
  const analysis: CircuitAnalysis = {
    status: "closed", mode: "ac", frequencyHz: 1000, currentAmps: 1, message: "解析完了",
    bulbPowerWatts: {}, wireCurrents: {}, issues: [],
    parts: { source: { voltageVolts: 1, currentAmps: 1, powerWatts: 0, voltagePhaseDegrees, currentPhaseDegrees } },
  };
  return renderToStaticMarkup(<CircuitAcPanel document={document} analysis={analysis} options={{ mode: "ac", frequencyHz: 1000 }} />);
}

describe("CircuitAcPanel tiny AC readings", () => {
  it.each([1e-12, -1e-12, 1e-20, -1e-20])("preserves a small nonzero phase difference of %s degrees", (difference) => {
    expect(phasePanelMarkup(0, difference)).toContain(`data-phase-difference-degrees="${difference}"`);
  });

  it.each([180, -180, 540, -540])("uses the same half-turn phase convention for %s degrees", (phase) => {
    expect(phasePanelMarkup(0, phase)).toContain('data-phase-difference-degrees="-180"');
  });

  it.each([
    [179.999_999_999_999_97, 180, 2 ** -45],
    [-180, -180.000_000_000_000_03, -(2 ** -45)],
    [1, 2 ** 60, 135],
  ])("preserves the phase difference across turn reduction from %s to %s degrees", (voltage, current, difference) => {
    expect(phasePanelMarkup(voltage, current)).toContain(`data-phase-difference-degrees="${difference}"`);
  });

  it("renders finite waveforms when finite phase angles need large turn reduction", () => {
    const markup = phasePanelMarkup(-Number.MAX_VALUE, Number.MAX_VALUE);
    // MAX_VALUE = (2^53-1)*2^971; its exact integer remainder is 128 degrees.
    // Thus current-minus-voltage is 256 degrees, equivalent to -104 degrees.
    expect(markup).toContain('data-phase-difference-degrees="-104"');
    expect(markup.match(/<polyline /g)).toHaveLength(2);
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  it("hides readings calculated at the previous frequency until the new result arrives", () => {
    const source = { id: "source", kind: "ac-source" as const, label: "交流電源", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults, frequencyHz: 50 };
    const resistor = { id: "resistor", kind: "resistor" as const, label: "抵抗", x: 4, y: 0, ...circuitPartCatalog.resistor.defaults, resistanceOhms: 100 };
    const document: CircuitDocument = {
      title: "周波数変更後の計算待ち",
      parts: [source, resistor],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w2", from: { partId: "resistor", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const oldAnalysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const markup = renderToStaticMarkup(
      <CircuitAcPanel document={document} analysis={oldAnalysis} options={{ mode: "ac", frequencyHz: 60 }} />,
    );

    expect(oldAnalysis.status).toBe("closed");
    expect(markup).toContain('data-state="empty"');
    expect(markup).toContain("解析周波数が変更されました。新しい解析結果を待っています。");
    expect(markup).not.toContain('data-analysis-frequency="50"');
  });

  it("keeps the phase difference for nonzero values at the femto scale", () => {
    const document: CircuitDocument = {
      title: "微小な交流値",
      parts: [{ id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults }],
      wires: [],
    };
    const analysis: CircuitAnalysis = {
      status: "closed",
      mode: "ac",
      frequencyHz: 1000,
      currentAmps: 1e-15,
      message: "解析完了",
      bulbPowerWatts: {},
      parts: {
        source: {
          voltageVolts: 1e-15,
          currentAmps: 1e-15,
          powerWatts: 0,
          voltagePhaseDegrees: 30,
          currentPhaseDegrees: 90,
        },
      },
      wireCurrents: {},
      issues: [],
    };
    const options: CircuitAnalysisOptions = { mode: "ac", frequencyHz: 1000 };
    const markup = renderToStaticMarkup(<CircuitAcPanel document={document} analysis={analysis} options={options} />);

    expect(markup).toContain('data-phase-difference-degrees="60"');
    expect(markup).toContain("位相差：+60°。電流は電圧より60°進みます。");
    expect(markup).toContain("<title id=");
    expect(markup).toContain("交流電源の電圧と電流の交流波形</title>");
  });

  it("keeps a readable peak label when a finite RMS value exceeds the peak range", () => {
    const source = { id: "source", kind: "ac-source" as const, label: "交流電源", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults };
    source.voltageVolts = 1.5e308;
    source.frequencyHz = 50;
    const resistor = { id: "resistor", kind: "resistor" as const, label: "抵抗", x: 1, y: 0, ...circuitPartCatalog.resistor.defaults, resistanceOhms: Number.MAX_VALUE };
    const document: CircuitDocument = {
      title: "上限に近い交流値",
      parts: [source, resistor],
      wires: [
        { id: "out", from: { partId: "source", terminal: "a" as const }, to: { partId: "resistor", terminal: "a" as const } },
        { id: "return", from: { partId: "resistor", terminal: "b" as const }, to: { partId: "source", terminal: "b" as const } },
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });
    const markup = renderToStaticMarkup(
      <CircuitAcPanel document={document} analysis={analysis} options={{ mode: "ac", frequencyHz: 50 }} />,
    );

    expect(analysis.status).toBe("closed");
    expect(analysis.parts.source.voltageVolts).toBe(1.5e308);
    expect(markup).toContain("+1.5e+308 × √2 V");
    expect(markup).toContain("実効値 1.5e+308 V");
  });

  it("omits undefined zero-amplitude phases in non-meter AC readings", () => {
    const source = { id: "source", kind: "ac-source" as const, label: "交流電源", x: 0, y: 0, ...circuitPartCatalog["ac-source"].defaults };
    const document: CircuitDocument = { title: "位相のない交流値", parts: [source], wires: [] };
    const reading = {
      voltageVolts: 0,
      currentAmps: 0,
      powerWatts: 0,
      voltagePhaseDegrees: 0,
      currentPhaseDegrees: 0,
      reactivePowerVars: 0,
    };
    const analysis: CircuitAnalysis = {
      status: "closed",
      mode: "ac",
      frequencyHz: 50,
      currentAmps: 0,
      message: "解析完了",
      bulbPowerWatts: {},
      parts: { source: reading },
      wireCurrents: {},
      issues: [],
    };
    const inspector = renderToStaticMarkup(<CircuitInspector part={source} reading={reading} analysisStatus="closed" />);
    const preview = renderToStaticMarkup(
      <CircuitPreviewPanel document={document} initialDocument={document} analysis={analysis} onChange={() => {}} onReset={() => {}} />,
    );

    for (const markup of [inspector, preview]) {
      expect(markup).not.toContain('data-measurement="voltage-phase"');
      expect(markup).not.toContain('data-measurement="current-phase"');
      expect(markup).toContain('data-measurement="reactive-power"');
    }
  });
});
