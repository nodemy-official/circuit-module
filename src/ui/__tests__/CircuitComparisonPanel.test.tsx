// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "../../circuit-solver.js";
import { serializeCircuitDocument } from "../../circuit-serialization.js";
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

function documentWithDanglingWire(): CircuitDocument {
  return {
    title: "接続先がない回路",
    parts: [part("source", "battery", "電池"), part("r1", "resistor", "抵抗")],
    wires: [{
      id: "dangling",
      from: { partId: "source", terminal: "a" },
      to: { partId: "missing", terminal: "a" },
    }],
  };
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

function clickButton(container: ParentNode, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) { throw new Error(`Missing button: ${label}`); }
  act(() => button.click());
}

describe("CircuitComparisonPanel", () => {
  it("captures measurements without reading unused layout data accepted by analysis and storage", () => {
    const circuit = documentOf([
      { ...part("source", "battery", "電池"), voltageVolts: 9 },
      { ...part("r", "resistor", "抵抗"), resistanceOhms: 3 },
    ]);
    const readLayout = vi.fn(() => { throw new Error("Unused layout must not be read"); });
    const route = [{ x: 2, y: 3 }, { x: 6, y: 3 }];
    circuit.wires = [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "r", terminal: "a" },
        waypoints: new Proxy(route, { get: readLayout }) },
      { id: "b", from: { partId: "r", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ];
    const result = analyzeCircuit(circuit);
    expect(result.status).toBe("closed");
    expect(() => serializeCircuitDocument(circuit)).not.toThrow();
    expect(readLayout).not.toHaveBeenCalled();
    const ui = mount({ document: circuit, analysis: result });

    clickButton(ui.container, "現在を比較の基準にする");

    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    circuit.parts[1]!.resistanceOhms = 6;
    route[0]!.x = 99;
    ui.rerender({ document: circuit, analysis: analyzeCircuit(circuit) });
    chooseMetric(ui.container, "currentAmps");
    const row = required(ui.container, 'tr[data-part-id="r"]');
    expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["3", "1.5", "-1.5"]);
    expect(readLayout).not.toHaveBeenCalled();
  });

  it.each(["exactVoltage", "exactTerminalVoltages", "exactTerminalCurrents", "precisionExpressions"] as const)(
    "captures scalar comparisons when optional %s metadata cannot be read",
    (field) => {
      const circuit = documentOf([part("r", "resistor", "抵抗")]);
      const result = analysis({ r: reading(9, 3, 27) });
      const target = field === "precisionExpressions" ? result : result.parts.r!;
      Object.defineProperty(target, field, {
        enumerable: true,
        get() { throw new Error("Unavailable optional precision"); },
      });
      const ui = mount({ document: circuit, analysis: result });

      clickButton(ui.container, "現在を比較の基準にする");

      expect(ui.container.querySelector('[role="alert"]')).toBeNull();
      const next = analysis({ r: reading(12, 4, 48) });
      ui.rerender({ document: circuit, analysis: next });
      const row = required(ui.container, 'tr[data-part-id="r"]');
      expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["9", "12", "+3"]);
      chooseMetric(ui.container, "currentAmps");
      expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["3", "4", "+1"]);
      chooseMetric(ui.container, "powerWatts");
      expect([...row.querySelectorAll("td")].slice(0, 3).map((cell) => cell.textContent)).toEqual(["27", "48", "+21"]);
    },
  );

  it.each(["id", "kind"] as const)("preserves a non-enumerable %s in a local comparison snapshot", (field) => {
    const load = part("load", "resistor", "抵抗");
    Object.defineProperty(load, field, { value: load[field], enumerable: false });
    const circuit = documentOf([part("source", "battery", "電源"), load]);
    circuit.wires = [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ];
    Object.defineProperty(circuit, "wires", { value: circuit.wires, enumerable: false });
    const result = analyzeCircuit(circuit);
    expect(result.status).toBe("closed");
    const { container } = mount({ document: circuit, analysis: result });
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "現在を比較の基準にする");
    expect(button).toBeDefined();
    act(() => button!.click());

    const row = required(container, 'tr[data-part-id="load"]');
    expect(row.getAttribute("data-row-status")).toBe("matched");
    expect(row.textContent).not.toContain("差分対象外");
    expect(row.textContent).not.toContain("部品の種類が変更");
    expect(Object.getOwnPropertyDescriptor(load, field)?.enumerable).toBe(false);
  });

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

  it.each([false, true])("does not leak snapshot errors for dangling wire endpoints (existing baseline=%s)", (existingBaseline) => {
    const circuit = documentWithDanglingWire();
    const invalid = analyzeCircuit(circuit);
    expect(invalid.status).toBe("invalid");
    const { container } = mount({
      document: circuit,
      analysis: invalid,
      ...(existingBaseline ? { baselineDocument: beforeDocument, baselineAnalysis: beforeAnalysis } : {}),
    });
    const label = existingBaseline ? "基準を現在に更新" : "現在を比較の基準にする";
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(button).toBeDefined();
    const errors: unknown[] = [];
    const captureError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", captureError);
    try {
      act(() => button!.click());
    } finally {
      window.removeEventListener("error", captureError);
    }
    expect(errors).toEqual([]);
    expect(required(container, '[role="alert"]').textContent).toContain("比較の基準を保存できませんでした。");
    expect(required(container, '[role="alert"]').textContent).toContain("missing");
    expect(required(container, ".circuit-comparison").getAttribute("data-comparison-state")).toBe(existingBaseline ? "unavailable" : "no-baseline");
    if (existingBaseline) {
      expect(required(container, ".circuit-comparison__baseline").textContent).toContain(beforeDocument.title);
    }
  });

  it("keeps a local baseline after a failed update and clears errors on release and successful retry", () => {
    const ui = mount({ document: beforeDocument, analysis: beforeAnalysis });
    clickButton(ui.container, "現在を比較の基準にする");
    const circuit = documentWithDanglingWire();
    const invalid = analyzeCircuit(circuit);
    ui.rerender({ document: circuit, analysis: invalid });

    clickButton(ui.container, "基準を現在に更新");

    expect(required(ui.container, '[role="alert"]').textContent).toContain("missing");
    expect(required(ui.container, ".circuit-comparison__baseline").textContent).toContain(beforeDocument.title);
    const row = required(ui.container, 'tr[data-part-id="r1"]');
    expect(Array.from(row.querySelectorAll("td")).slice(0, 3).map((cell) => cell.textContent)).toEqual(["9", "—", "比較不可"]);

    clickButton(ui.container, "基準を解除");
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    expect(required(ui.container, ".circuit-comparison").getAttribute("data-comparison-state")).toBe("no-baseline");
    clickButton(ui.container, "現在を比較の基準にする");
    expect(ui.container.querySelector('[role="alert"]')).not.toBeNull();

    // Repair the referenced document in place so only a successful retry can clear the error.
    circuit.wires.splice(0);
    clickButton(ui.container, "現在を比較の基準にする");

    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    expect(required(ui.container, ".circuit-comparison__baseline").textContent).toContain(circuit.title);
    expect(required(ui.container, ".circuit-comparison").getAttribute("data-comparison-state")).toBe("unavailable");
    expect(ui.container.textContent).toContain("基準側の解析状態が「無効」");
  });

  it.each(["document", "analysis"] as const)("clears snapshot errors when the current %s changes", (field) => {
    const circuit = documentWithDanglingWire();
    const invalid = analyzeCircuit(circuit);
    const ui = mount({ document: circuit, analysis: invalid });
    clickButton(ui.container, "現在を比較の基準にする");
    expect(ui.container.querySelector('[role="alert"]')).not.toBeNull();

    ui.rerender(field === "document"
      ? { document: { ...circuit, title: "別の回路" }, analysis: invalid }
      : { document: circuit, analysis: { ...invalid, message: "別の解析" } });

    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    ui.rerender({ document: circuit, analysis: invalid });
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("still captures structurally valid circuits with invalid numeric values", () => {
    const circuit = documentOf([
      part("source", "battery", "電池"),
      { ...part("r1", "resistor", "抵抗"), resistanceOhms: Number.NaN },
    ], "数値が無効な回路");
    const invalid = analyzeCircuit(circuit);
    expect(invalid.status).toBe("invalid");
    const { container } = mount({ document: circuit, analysis: invalid });

    clickButton(container, "現在を比較の基準にする");

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(required(container, ".circuit-comparison__baseline").textContent).toContain(circuit.title);
    expect(required(container, ".circuit-comparison").getAttribute("data-comparison-state")).toBe("unavailable");
    expect(container.textContent).toContain("基準側の解析状態が「無効」");
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

  it.each([undefined, 50])("uses the own source frequency or catalog default when an AC baseline omits its frequency (%s)", (frequencyHz) => {
    const source = part("source", "ac-source", "交流電源");
    if (frequencyHz === undefined) { Reflect.deleteProperty(source, "frequencyHz"); }
    else { source.frequencyHz = frequencyHz; }
    const baselineDocument = documentOf([new Proxy(source, {
      get(target, key, receiver) {
        return key === "frequencyHz" ? 60 : Reflect.get(target, key, receiver);
      },
    })], "交流基準");
    const expectedFrequency = frequencyHz ?? 1000;
    const ui = mount({
      document: documentOf([{ ...source }]),
      analysis: analysis({ source: reading(5, 0.2, 1) }, { mode: "ac", frequencyHz: expectedFrequency }),
      baselineDocument,
      baselineAnalysis: analysis({ source: reading(5, 0.1, 0.5) }, { mode: "ac" }),
    });

    expect(ui.container.querySelector(".circuit-comparison")?.getAttribute("data-comparison-state")).toBe("ready");
    expect(ui.container.querySelector(".circuit-comparison__baseline")?.textContent).toContain(`交流 ${expectedFrequency} Hz`);
    expect(required<HTMLTableRowElement>(ui.container, 'tr[data-part-id="source"]').querySelectorAll("td")[2]?.textContent).toBe("0");
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
