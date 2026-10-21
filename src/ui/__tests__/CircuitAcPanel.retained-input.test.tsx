// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(circuit: CircuitDocument, analysis: CircuitAnalysis) {
  const options = { mode: "ac" as const, frequencyHz: 1000 };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = () => act(() => root.render(<CircuitAcPanel document={circuit} analysis={analysis} options={options} />));
  render();
  return { container, options, render };
}

function sweep(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "対数スイープを計算");
  if (!button) { throw new Error("Missing sweep button"); }
  act(() => button.click());
}

describe("mutable AC analysis snapshots", () => {
  it.each(["scalar", "phase", "precision", "projection", "terminal", "status", "frequency", "expression", "getter"] as const)
  ("hides a saved sweep after in-place %s changes", (changed) => {
    const circuit = createCircuitFromSpecs([
      ["load", "resistor", ["middle", "0"], { resistanceOhms: 1 }],
      ["source", "ac-source", ["positive", "0"], { voltageVolts: 3 * Number.MIN_VALUE, frequencyHz: 1000, phaseDegrees: 0 }],
      ["series", "resistor", ["positive", "middle"], { resistanceOhms: 1 }],
      ["ground", "ground", ["0"]],
    ], "Reused transported AC results");
    const analysis: CircuitAnalysis = JSON.parse(JSON.stringify(analyzeCircuit(circuit)));
    const ui = mount(circuit, analysis);
    sweep(ui.container);
    expect(ui.container.querySelectorAll(".circuit-ac__response-dot")).toHaveLength(41);
    const reading = analysis.parts.load!;
    if (changed === "scalar") { reading.voltageVolts = 3 * Number.MIN_VALUE; }
    if (changed === "phase") { reading.voltagePhaseDegrees = 90; }
    if (changed === "precision") {
      const real = reading.exactVoltage!.real;
      if (!("numerator" in real)) { throw new Error("Expected literal precision"); }
      real.numerator = "0x5";
    }
    if (changed === "projection") { reading.exactVoltage!.projection!.phaseDegrees = 90; }
    if (changed === "terminal") { reading.terminalCurrents!.a = Number.MIN_VALUE; }
    if (changed === "status") { analysis.status = "open"; }
    if (changed === "frequency") { analysis.frequencyHz = 2000; ui.options.frequencyHz = 2000; }
    if (changed === "expression") {
      analysis.precisionExpressions = [{ operation: "literal", numerator: "1", denominator: "1" }];
    }
    if (changed === "getter") {
      Object.defineProperty(reading, "exactVoltage", { get() { throw new Error("Precision temporarily unavailable"); } });
    }

    expect(ui.render).not.toThrow();
    expect(ui.container.querySelector(".circuit-ac__response")).toBeNull();
    expect(ui.container.querySelector(".circuit-ac__waveform")).not.toBeNull();
  });
});

describe("AC relative phase before individual angle rounding", () => {
  it.each([0, 37, 180, 397].flatMap((phaseDegrees) => [false, true].map((transport) => ({ phaseDegrees, transport }))))
  ("keeps a tiny relative phase at $phaseDegrees degrees with transport=$transport", ({ phaseDegrees, transport }) => {
    const capacitance = 1e-20;
    const frequency = 1000;
    const circuit = createCircuitFromSpecs([
      ["pot", "potentiometer", ["positive", "0", "wiper"], { resistanceOhms: 1, wiperPosition: 0.5 }],
      ["source", "ac-source", ["positive", "0"], { voltageVolts: 1, frequencyHz: frequency, phaseDegrees }],
      ["load", "capacitor", ["wiper", "0"], { capacitanceFarads: capacitance }],
      ["ground", "ground", ["0"]],
    ], "Tiny relative phase near a full or half turn");
    const computed = analyzeCircuit(circuit);
    const analysis: CircuitAnalysis = transport ? JSON.parse(JSON.stringify(computed)) : computed;
    if (transport) {
      const reading = analysis.parts.pot!;
      reading.voltagePhaseDegrees! += 360;
      reading.currentPhaseDegrees! += 360;
      if (reading.exactVoltage?.projection) { reading.exactVoltage.projection.phaseDegrees += 360; }
      const currentProjection = reading.exactTerminalCurrents?.a?.projection;
      if (currentProjection) { currentProjection.phaseDegrees += 360; }
    }
    const ui = mount(circuit, analysis);
    const select = ui.container.querySelector("select")!;
    act(() => {
      select.value = "pot";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const actual = Number(ui.container.querySelector(".circuit-ac__phase")?.getAttribute("data-phase-difference-degrees"));
    // Independent impedance oracle: each pot segment is 1/2 ohm; the lower
    // segment is parallel with C. Yin=(1+j*pi*f*C)/(1+j*pi*f*C/2).
    const expected = (Math.atan(Math.PI * frequency * capacitance) - Math.atan(Math.PI * frequency * capacitance / 2)) * 180 / Math.PI;

    expect(expected).toBeGreaterThan(0);
    expect(Math.abs((actual - expected) / expected)).toBeLessThan(1e-12);
  });
});
