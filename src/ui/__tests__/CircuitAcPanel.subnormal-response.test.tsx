// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitPartReading } from "../../circuit-solver.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountResponse(circuit: CircuitDocument, updateSweepReading?: (reading: CircuitPartReading) => void) {
  const solve = analyzeCircuit;
  const options = { mode: "ac" as const, frequencyHz: 1000 };
  const analysis = solve(circuit, {}, options);
  if (analysis.status !== "closed" && analysis.status !== "idle") {
    throw new Error(`Unexpected fixture analysis: ${analysis.message}`);
  }
  if (updateSweepReading) {
    const circuitSolver = await import("../../circuit-solver.js");
    vi.spyOn(circuitSolver, "analyzeCircuit").mockImplementation((...args) => {
      const result = solve(...args);
      updateSweepReading(result.parts.load!);
      return result;
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<CircuitAcPanel document={circuit} analysis={analysis} options={options} />));
  const calculate = [...container.querySelectorAll("button")].find((button) => button.textContent === "対数スイープを計算");
  if (!calculate) { throw new Error("Missing sweep button"); }
  act(() => calculate.click());
  return container;
}

function divider(sourceRms: number) {
  return createCircuitFromSpecs([
    ["load", "resistor", ["middle", "0"], { resistanceOhms: 1 }],
    ["source", "ac-source", ["positive", "0"], { voltageVolts: sourceRms, frequencyHz: 1000, phaseDegrees: 0 }],
    ["series", "resistor", ["positive", "middle"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "Frequency-independent subnormal divider");
}

describe("AC frequency response before voltage display rounding", () => {
  it.each([1, Number.MIN_VALUE, 3 * Number.MIN_VALUE])("keeps a nonzero constant response at the top of its own scale for %s V", async (sourceRms) => {
    const container = await mountResponse(divider(sourceRms));
    const points = [...container.querySelectorAll(".circuit-ac__response-dot")];

    // The equal-resistance divider has the same Vsource/2 response at every
    // frequency. Its ratio to the largest response is exactly one.
    expect(points).toHaveLength(41);
    expect(points.every((point) => point.getAttribute("cy") === "30")).toBe(true);
    expect(container.querySelectorAll(".circuit-ac__response-trace")).toHaveLength(1);
  });

  it.each([1, Number.MIN_VALUE].flatMap((sourceRms) => [0, 45, 90].map((phaseDegrees) => ({ sourceRms, phaseDegrees }))))
  ("preserves the normalized RC response for $sourceRms V at $phaseDegrees degrees", async ({ sourceRms, phaseDegrees }) => {
    const resistance = 1000;
    const capacitance = 1e-6;
    const circuit = createCircuitFromSpecs([
      ["load", "capacitor", ["middle", "0"], { capacitanceFarads: capacitance }],
      ["source", "ac-source", ["positive", "0"], { voltageVolts: sourceRms, frequencyHz: 1000, phaseDegrees }],
      ["series", "resistor", ["positive", "middle"], { resistanceOhms: resistance }],
      ["ground", "ground", ["0"]],
    ], "RC low-pass response below display precision");
    const container = await mountResponse(circuit);
    const points = [...container.querySelectorAll(".circuit-ac__response-dot")];
    expect(points).toHaveLength(41);
    const minFrequency = Number(points[0]!.getAttribute("data-frequency-hz"));
    const minDenominator = Math.hypot(1, 2 * Math.PI * minFrequency * resistance * capacitance);

    for (const point of points) {
      const frequency = Number(point.getAttribute("data-frequency-hz"));
      // Independent transfer-function oracle: |H(f)| = 1/sqrt(1+(2πfRC)^2).
      const denominator = Math.hypot(1, 2 * Math.PI * frequency * resistance * capacitance);
      const expectedY = 146 - 116 * minDenominator / denominator;
      expect(Number(point.getAttribute("cy"))).toBeCloseTo(expectedY, 10);
    }
  });

  it.each(["zero", "stale", "unreadable", "malformed"] as const)("uses a genuine zero response for %s readings", async (metadata) => {
    const container = await mountResponse(divider(metadata === "zero" ? 0 : metadata === "stale" ? 3 * Number.MIN_VALUE : Number.MIN_VALUE),
      metadata === "zero" ? undefined : (reading) => {
        reading.voltageVolts = 0;
        if (metadata === "unreadable") {
          Object.defineProperty(reading, "exactVoltage", { get() { throw new Error("Optional precision unavailable"); } });
        } else if (metadata === "malformed") {
          reading.exactVoltage!.real = { numerator: "invalid", denominator: "1" };
        }
      });
    const points = [...container.querySelectorAll(".circuit-ac__response-dot")];

    expect(points).toHaveLength(41);
    expect(points.every((point) => point.getAttribute("cy") === "146")).toBe(true);
  });
});
