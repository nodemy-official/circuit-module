// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "../../circuit-solver.js";
import { CircuitComparisonPanel } from "../CircuitComparisonPanel.js";

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

function part(id: string, kind: CircuitPart["kind"], label: string): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, label };
}

function documentOf(parts: CircuitPart[], title = "テスト回路"): CircuitDocument {
  return { title, parts, wires: [] };
}

function reading(voltageVolts: number, currentAmps: number, powerWatts: number): CircuitPartReading {
  return { voltageVolts, currentAmps, powerWatts };
}

function analysis(
  parts: Record<string, CircuitPartReading> = {},
  options: Partial<Pick<CircuitAnalysis, "status" | "mode" | "frequencyHz">> & { timeSeconds?: number } = {},
): CircuitAnalysis {
  return {
    status: "closed",
    currentAmps: null,
    message: "",
    bulbPowerWatts: {},
    parts,
    wireCurrents: {},
    issues: [],
    ...options,
  };
}

function mount(props: ComponentProps<typeof CircuitComparisonPanel>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CircuitComparisonPanel {...props} />));
  mounted.push({ root, container });
  return {
    container,
    rerender(nextProps: ComponentProps<typeof CircuitComparisonPanel>) {
      act(() => root.render(<CircuitComparisonPanel {...nextProps} />));
    },
  };
}

function required<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) { throw new Error(`Missing element: ${selector}`); }
  return element;
}

function chooseMetric(container: ParentNode, metric: "voltageVolts" | "currentAmps" | "powerWatts") {
  act(() => required<HTMLInputElement>(container, `input[value="${metric}"]`).click());
}

describe("CircuitComparisonPanel", () => {
  const beforeDocument = documentOf([
    part("source", "battery", "電池"),
    part("r1", "resistor", "R1"),
  ], "変更前");
  const afterDocument = documentOf([
    part("source", "battery", "電池"),
    { ...part("r1", "resistor", "R1"), resistanceOhms: 200 },
  ], "変更後");
  const beforeAnalysis = analysis({
    source: reading(9, 0.09, 0.81),
    r1: reading(9, 0.09, 0.81),
  });
  const afterAnalysis = analysis({
    source: reading(9, 0.045, 0.405),
    r1: reading(9, 0.045, 0.405),
  });

  it("captures the current circuit as a local baseline and highlights changed readings", () => {
    const ui = mount({ document: beforeDocument, analysis: beforeAnalysis });
    act(() => required<HTMLButtonElement>(ui.container, "button").click());
    expect(ui.container.querySelector(".circuit-comparison")?.getAttribute("data-comparison-state")).toBe("ready");

    ui.rerender({ document: afterDocument, analysis: afterAnalysis });
    chooseMetric(ui.container, "currentAmps");

    const row = required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="r1"]');
    expect(row.getAttribute("data-changed")).toBe("true");
    expect(row.querySelector(".circuit-comparison__changed")?.textContent).toBe("計測値に変化");
    expect(row.querySelectorAll("td")[2]?.textContent).toBe("-0.045");
    expect(required<HTMLElement>(row, ".circuit-comparison__bar-fill").getAttribute("data-bar-percent")).toBe("50");
  });

  it("uses supplied baselines and labels AC RMS, average power, and power sign conventions", () => {
    const acBeforeDocument = documentOf([part("source", "ac-source", "交流電源"), part("r1", "resistor", "R1")], "交流基準");
    const acAfterDocument = documentOf([part("source", "ac-source", "交流電源"), part("r1", "resistor", "R1")], "交流現在");
    const acBefore = analysis({ source: reading(5, 0.1, 0.5), r1: reading(5, 0.1, 0.5) }, { mode: "ac", frequencyHz: 50 });
    const acAfter = analysis({ source: reading(5, 0.2, 1), r1: reading(5, 0.2, 1) }, { mode: "ac", frequencyHz: 50 });
    const ui = mount({
      document: acAfterDocument,
      analysis: acAfter,
      baselineDocument: acBeforeDocument,
      baselineAnalysis: acBefore,
    });

    expect(ui.container.textContent).toContain("交流 50 Hz");
    expect(ui.container.textContent).toContain("RMS");
    chooseMetric(ui.container, "powerWatts");
    expect(ui.container.textContent).toContain("平均電力");
    expect(required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="source"] td:last-child').textContent).toBe("供給（＋）");
    expect(required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="r1"] td:last-child').textContent).toBe("吸収（＋）");
  });

  it("labels an AC battery's internal resistance as absorbing power", () => {
    const acBaselineDocument: CircuitDocument = {
      title: "交流基準",
      parts: [
        { ...part("source", "ac-source", "交流電源"), voltageVolts: 10, frequencyHz: 50 },
        { ...part("load", "resistor", "負荷"), resistanceOhms: 10 },
        { ...part("battery", "battery", "電池"), internalResistanceOhms: 10 },
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "battery", terminal: "a" } },
        { id: "w3", from: { partId: "battery", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const currentDocument = { ...acBaselineDocument, title: "交流現在" };
    const acBaselineAnalysis = analyzeCircuit(acBaselineDocument, {}, { mode: "ac", frequencyHz: 50 });
    const currentAnalysis = analyzeCircuit(currentDocument, {}, { mode: "ac", frequencyHz: 50 });
    expect(currentAnalysis.parts.battery.powerWatts).toBeCloseTo(2.5, 10);
    const ui = mount({
      document: currentDocument,
      analysis: currentAnalysis,
      baselineDocument: acBaselineDocument,
      baselineAnalysis: acBaselineAnalysis,
    });

    chooseMetric(ui.container, "powerWatts");

    expect(required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="source"] td:last-child').textContent).toBe("供給（＋）");
    expect(required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="battery"] td:last-child').textContent).toBe("吸収（＋）");
    expect(ui.container.textContent).toContain("電池の内部抵抗など受動部品は吸収（＋）");
  });

  it("does not subtract AC readings when their frequencies differ", () => {
    const baseline = analysis({ r1: reading(5, 0.1, 0.5) }, { mode: "ac", frequencyHz: 50 });
    const current = analysis({ r1: reading(5, 0.2, 1) }, { mode: "ac", frequencyHz: 60 });
    const ui = mount({ document: afterDocument, analysis: current, baselineDocument: beforeDocument, baselineAnalysis: baseline });

    expect(ui.container.querySelector(".circuit-comparison")?.getAttribute("data-comparison-state")).toBe("unavailable");
    expect(ui.container.textContent).toContain("交流の周波数が異なる");
    const row = required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="r1"]');
    expect(row.querySelectorAll("td")[2]?.textContent).toBe("比較不可");
    expect(row.querySelector(".circuit-comparison__bar")).toBeNull();
  });

  it("does not compare transient instantaneous values with steady-state readings", () => {
    const transient = analysis({ r1: reading(3, 0.2, 0.6) }, { timeSeconds: 0.02 });
    const ui = mount({ document: afterDocument, analysis: transient, baselineDocument: beforeDocument, baselineAnalysis: beforeAnalysis });

    expect(ui.container.querySelector(".circuit-comparison")?.getAttribute("data-comparison-state")).toBe("unavailable");
    expect(ui.container.textContent).toContain("瞬時値と定常解析は比較できません");
    expect(required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="r1"]').querySelectorAll("td")[2]?.textContent).toBe("比較不可");
    expect(ui.container.textContent).toContain("瞬時値 V");
  });

  it("marks added, removed, and kind-changed parts as ineligible for deltas", () => {
    const baselineDocument = documentOf([
      part("same-id", "resistor", "R1"),
      part("removed", "bulb", "L1"),
    ]);
    const currentDocument = documentOf([
      part("same-id", "battery", "B1"),
      part("added", "capacitor", "C1"),
    ]);
    const readings = { "same-id": reading(4, 0.2, 0.8), removed: reading(3, 0.3, 0.9), added: reading(2, 0.1, 0.2) };
    const ui = mount({
      document: currentDocument,
      analysis: analysis(readings),
      baselineDocument,
      baselineAnalysis: analysis(readings),
    });

    for (const [partId, status] of [["same-id", "kind-changed"], ["added", "added"], ["removed", "removed"]]) {
      const row = required<HTMLTableRowElement>(ui.container, `tr[data-part-id="${partId}"]`);
      expect(row.getAttribute("data-row-status")).toBe(status);
      expect(row.querySelectorAll("td")[2]?.textContent).toBe("差分対象外");
      expect(row.querySelector(".circuit-comparison__bar")).toBeNull();
    }
  });

  it("keeps invalid or missing readings blank instead of substituting zero", () => {
    const invalid = analysis({ r1: reading(99, 99, 99) }, { status: "invalid" });
    const ui = mount({
      document: afterDocument,
      analysis: invalid,
      baselineDocument: beforeDocument,
      baselineAnalysis: beforeAnalysis,
    });

    const row = required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="r1"]');
    expect(row.querySelectorAll("td")[0]?.textContent).toBe("9");
    expect(row.querySelectorAll("td")[1]?.textContent).toBe("—");
    expect(row.querySelectorAll("td")[2]?.textContent).toBe("比較不可");

    const missing = mount({
      document: afterDocument,
      analysis: analysis(),
      baselineDocument: beforeDocument,
      baselineAnalysis: analysis(),
    });
    const missingRow = required<HTMLTableRowElement>(missing.container, 'tr[data-part-id="r1"]');
    expect(Array.from(missingRow.querySelectorAll("td")).slice(0, 3).map((cell) => cell.textContent)).toEqual(["—", "—", "—"]);
  });

  it("treats short and empty analyses as unavailable on either side", () => {
    for (const status of ["short", "empty"] as const) {
      const unavailable = analysis({ r1: reading(99, 99, 99) }, { status });
      const currentUnavailable = mount({
        document: afterDocument,
        analysis: unavailable,
        baselineDocument: beforeDocument,
        baselineAnalysis: beforeAnalysis,
      });
      const currentRow = required<HTMLTableRowElement>(currentUnavailable.container, 'tr[data-part-id="r1"]');
      expect(currentUnavailable.container.querySelector(".circuit-comparison")?.getAttribute("data-comparison-state")).toBe("unavailable");
      expect(currentUnavailable.container.textContent).toContain(`現在の解析状態が「${status === "empty" ? "空の回路" : "短絡"}」`);
      expect(Array.from(currentRow.querySelectorAll("td")).slice(0, 3).map((cell) => cell.textContent)).toEqual(["9", "—", "比較不可"]);
      expect(currentRow.querySelector(".circuit-comparison__bar")).toBeNull();

      const baselineUnavailable = mount({
        document: afterDocument,
        analysis: afterAnalysis,
        baselineDocument: beforeDocument,
        baselineAnalysis: unavailable,
      });
      const baselineRow = required<HTMLTableRowElement>(baselineUnavailable.container, 'tr[data-part-id="r1"]');
      expect(baselineUnavailable.container.querySelector(".circuit-comparison")?.getAttribute("data-comparison-state")).toBe("unavailable");
      expect(Array.from(baselineRow.querySelectorAll("td")).slice(0, 3).map((cell) => cell.textContent)).toEqual(["—", "9", "比較不可"]);
      expect(baselineRow.querySelector(".circuit-comparison__bar")).toBeNull();
    }
  });
});
