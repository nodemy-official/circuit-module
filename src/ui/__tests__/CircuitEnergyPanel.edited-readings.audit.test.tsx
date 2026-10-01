// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

function rc(): CircuitDocument {
  return {
    title: "編集後のRCエネルギー",
    parts: [
      { id: "v", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 1 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1 },
    ],
    wires: [
      { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "r", terminal: "b" }, to: { partId: "c", terminal: "a" } },
      { id: "c", from: { partId: "c", terminal: "b" }, to: { partId: "v", terminal: "b" } },
    ],
  };
}

it.each(["voltage", "exact", "coefficient", "power", "time", "expression"])("updates energy on rerender after an in-place %s edit", (field) => {
  const circuit = rc();
  const transient = simulateTransient(circuit, { durationSeconds: 1, timeStepSeconds: 0.5 });
  const analysis = analyzeCircuit(circuit);
  const container = document.createElement("div");
  const root = createRoot(container);
  if (field === "expression") {
    transient.precisionExpressions = [{ operation: "literal", numerator: "5", denominator: "9" }];
    transient.samples[2]!.parts.c!.exactVoltage!.real = { expression: 0, sign: 1 };
  }
  const render = (sampleIndex: number) => act(() => root.render(<CircuitEnergyPanel
    document={circuit} analysis={analysis} frame={{ analysis: transient, sampleIndex }}
  />));
  try {
    render(field === "expression" ? 2 : 1);
    let expected = 0;
    let partId = "c";
    let attribute = "data-energy-joules";
    switch (field) {
      case "voltage": transient.samples[2]!.parts.c!.voltageVolts = 2; expected = 2; break;
      case "exact": transient.samples[2]!.parts.c!.exactVoltage!.real = { numerator: "1", denominator: "3" }; expected = 1 / 18; break;
      case "coefficient": circuit.parts[2]!.capacitanceFarads = 2; expected = 25 / 81; break;
      case "power": transient.samples[2]!.parts.r!.powerWatts = 10; expected = 107 / 36; partId = "r"; attribute = "data-dissipated-joules"; break;
      case "time": transient.samples[1]!.timeSeconds = 0.25; expected = 91 / 216; partId = "r"; attribute = "data-dissipated-joules"; break;
      case "expression": transient.precisionExpressions = [{ operation: "literal", numerator: "1", denominator: "3" }]; expected = 1 / 18; break;
      default: throw new Error("Unknown edit");
    }
    // Backward Euler gives V1=1/3, V2=5/9; the expectations use
    // independent fractions and the edited input, never production helpers.
    render(2);
    expect(Number(container.querySelector(`[data-part-id="${partId}"][${attribute}]`)?.getAttribute(attribute))).toBe(expected);
  } finally { act(() => root.unmount()); }
});

it("falls back to scalar energies for malformed optional expression tables", () => {
  const circuit = rc();
  const transient = JSON.parse(JSON.stringify(simulateTransient(circuit, { durationSeconds: 1, timeStepSeconds: 0.5 })));
  transient.precisionExpressions = {};
  transient.samples[2].parts.c.exactVoltage.real = { expression: 0, sign: 1 };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<CircuitEnergyPanel document={circuit} analysis={analyzeCircuit(circuit)} frame={{ analysis: transient, sampleIndex: 2 }} />));
    const voltage = transient.samples[2].parts.c.voltageVolts;
    expect(Number(container.querySelector("[data-energy-joules]")?.getAttribute("data-energy-joules"))).toBe(0.5 * voltage * voltage);
  } finally { act(() => root.unmount()); }
});
