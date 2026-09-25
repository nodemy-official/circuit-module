import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { CircuitAnalysisPanel } from "./CircuitAnalysisPanel.js";

const baseAnalysis: CircuitAnalysis = {
  status: "closed",
  currentAmps: 21.86e-6,
  message: "解析完了",
  bulbPowerWatts: {},
  parts: {},
  wireCurrents: {},
  issues: [],
};

describe("CircuitAnalysisPanel current formatting", () => {
  it("keeps small transient current visible and preserves number and unit slots", () => {
    const transientMarkup = renderToStaticMarkup(<CircuitAnalysisPanel
      analysis={{ ...baseAnalysis, timeSeconds: 0.004 }}
      slotProps={{ metricNumber: { className: "host-number" }, metricUnit: { className: "host-unit" } }}
    />);
    const nullMarkup = renderToStaticMarkup(<CircuitAnalysisPanel
      analysis={{ ...baseAnalysis, currentAmps: null, timeSeconds: 0.004 }}
    />);
    const steadyMarkup = renderToStaticMarkup(<CircuitAnalysisPanel analysis={baseAnalysis} />);

    expect(transientMarkup).toMatch(/class="host-number">21\.86<\/span><small class="host-unit">μA<\/small>/);
    expect(nullMarkup).toMatch(/<span[^>]*>—<\/span><small[^>]*>A<\/small>/);
    expect(steadyMarkup).toContain("0.000</span><small>A</small>");
  });
});
