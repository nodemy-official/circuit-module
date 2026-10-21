// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import type { CircuitAnalysis, CircuitPartReading } from "../../circuit-solver.js";
import { CircuitComparisonPanel } from "../CircuitComparisonPanel.js";

type Metric = "voltageVolts" | "currentAmps" | "powerWatts";

function reading(metric: Metric, value: number): CircuitPartReading {
  return { voltageVolts: 0, currentAmps: 0, powerWatts: 0, [metric]: value };
}

function analysis(parts: CircuitAnalysis["parts"]): CircuitAnalysis {
  return {
    status: "closed",
    currentAmps: null,
    message: "",
    bulbPowerWatts: {},
    parts,
    wireCurrents: {},
    issues: [],
  };
}

function comparisonRows(before: CircuitAnalysis["parts"], after: CircuitAnalysis["parts"]) {
  const circuit: CircuitDocument = {
    title: "有限測定値の比較",
    parts: Object.keys(after).map((id) => ({ id, kind: "resistor", label: id, x: 0, y: 0 })),
    wires: [],
  };
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitComparisonPanel
    document={circuit}
    analysis={analysis(after)}
    baselineDocument={circuit}
    baselineAnalysis={analysis(before)}
  />);
  return container;
}

describe("comparison numeric scale", () => {
  it.each(["voltageVolts", "currentAmps", "powerWatts"] as const)("detects changed finite %s when its difference overflows", (metric) => {
    for (const sign of [-1, 1]) {
      const container = comparisonRows(
        { load: reading(metric, sign * Number.MAX_VALUE) },
        { load: reading(metric, -sign * Number.MAX_VALUE) },
      );
      const row = container.querySelector('tr[data-part-id="load"]');

      expect(row?.getAttribute("data-changed")).toBe("true");
      expect(row?.querySelector(".circuit-comparison__changed")?.textContent).toBe("計測値に変化");
      expect(row?.textContent).not.toMatch(/NaN|Infinity/);
    }
  });

  it("retains a representable tiny bar percentage when the intermediate ratio underflows", () => {
    const container = comparisonRows(
      { tiny: reading("voltageVolts", 0), large: reading("voltageVolts", 0) },
      { tiny: reading("voltageVolts", Number.MIN_VALUE), large: reading("voltageVolts", 2) },
    );
    const tiny = container.querySelector('tr[data-part-id="tiny"]');
    const large = container.querySelector('tr[data-part-id="large"]');

    // (2^-1074 / 2) * 50 = 25 * 2^-1074, an exactly representable value.
    expect(Number(tiny?.querySelector(".circuit-comparison__bar-fill")?.getAttribute("data-bar-percent")))
      .toBe(25 * Number.MIN_VALUE);
    expect(large?.querySelector(".circuit-comparison__bar-fill")?.getAttribute("data-bar-percent")).toBe("50");
    expect(tiny?.getAttribute("data-changed")).toBe("true");
  });

  it("keeps overflowed differences unavailable while normalizing a maximum finite decrease", () => {
    const container = comparisonRows(
      { overflow: reading("voltageVolts", Number.MAX_VALUE), finite: reading("voltageVolts", 0) },
      { overflow: reading("voltageVolts", -Number.MAX_VALUE), finite: reading("voltageVolts", -Number.MAX_VALUE) },
    );
    const overflow = container.querySelector('tr[data-part-id="overflow"]');
    const finite = container.querySelector('tr[data-part-id="finite"]');

    expect(overflow?.querySelectorAll("td")[2]?.textContent).toBe("—");
    expect(overflow?.querySelector(".circuit-comparison__bar")).toBeNull();
    expect(finite?.querySelector(".circuit-comparison__bar")?.getAttribute("data-direction")).toBe("decrease");
    expect(finite?.querySelector(".circuit-comparison__bar-fill")?.getAttribute("data-bar-percent")).toBe("50");
  });

  it("does not report unchanged finite values or unavailable measurements as changed", () => {
    const container = comparisonRows(
      { same: reading("voltageVolts", Number.MAX_VALUE), unavailable: reading("voltageVolts", 0) },
      { same: reading("voltageVolts", Number.MAX_VALUE), unavailable: reading("voltageVolts", Number.NaN) },
    );

    for (const row of container.querySelectorAll("tbody tr")) {
      expect(row.getAttribute("data-changed")).toBe("false");
      expect(row.querySelector(".circuit-comparison__changed")).toBeNull();
    }
  });
});
