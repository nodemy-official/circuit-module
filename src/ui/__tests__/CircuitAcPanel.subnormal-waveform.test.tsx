// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "../../circuit-solver.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";

function renderPanel(circuit: CircuitDocument, analysis: CircuitAnalysis) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitAcPanel
    document={circuit} analysis={analysis} options={{ mode: "ac", frequencyHz: 1000 }}
  />);
  return container;
}

function renderDivider(sourceRms: number, options?: { phaseDegrees?: number; updateReading?: (reading: CircuitPartReading) => void }) {
  const circuit = createCircuitFromSpecs([
    ["load", "resistor", ["middle", "0"], { resistanceOhms: 1 }],
    ["source", "ac-source", ["positive", "0"], { voltageVolts: sourceRms, frequencyHz: 1000, phaseDegrees: options?.phaseDegrees ?? 0 }],
    ["series", "resistor", ["positive", "middle"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "AC divider below scalar display precision");
  const analysis = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 1000 });
  if (analysis.status !== "closed" && analysis.status !== "idle") {
    throw new Error(`Unexpected fixture analysis: ${analysis.message}`);
  }
  const reading = analysis.parts.load!;
  options?.updateReading?.(reading);
  return { container: renderPanel(circuit, analysis), reading };
}

function tracePoints(container: HTMLElement, quantity: "voltage" | "current") {
  return container.querySelector(`.circuit-ac__trace--${quantity}`)?.getAttribute("points")?.split(" ");
}

describe("AC waveforms before RMS display rounding", () => {
  it("keeps independently normalized nonzero voltage and current waveforms below Number.MIN_VALUE", () => {
    const ordinary = renderDivider(1);
    const tiny = renderDivider(Number.MIN_VALUE);
    expect(tiny.reading.voltageVolts).toBe(0);
    expect(tiny.reading.currentAmps).toBe(0);
    // Independent divider/Ohm oracle: Vload = Iload = MIN_VALUE / 2,
    // both nonzero, even though their scalar display projections are zero.
    expect(tiny.reading.exactVoltage?.real).toMatchObject({ numerator: "0x1" });
    expect(tiny.reading.exactTerminalCurrents?.a?.real).toMatchObject({ numerator: "0x1" });

    for (const quantity of ["voltage", "current"] as const) {
      const ordinaryPoints = tracePoints(ordinary.container, quantity);
      expect(ordinaryPoints).toHaveLength(97);
      expect(ordinaryPoints?.[0]).toBe("72,42");
      expect(ordinaryPoints?.[48]).toBe("240,166");
      // Each quantity has its own axis; changing amplitude preserves its shape.
      expect(tracePoints(tiny.container, quantity)).toEqual(ordinaryPoints);
    }
  });

  it("keeps the defined in-phase relationship for nonzero retained voltage and current", () => {
    const { container } = renderDivider(Number.MIN_VALUE);

    expect(container.querySelector(".circuit-ac__phase")?.getAttribute("data-phase-difference-degrees")).toBe("0");
    expect(container.textContent).toContain("電圧と電流はほぼ同位相です。");
    expect(container.textContent).not.toContain("電圧または電流が0");
  });

  it("rounds the physical peak only after applying the RMS-to-peak factor", () => {
    const { container } = renderDivider(Number.MIN_VALUE);
    const axisLabels = [...container.querySelectorAll(".circuit-ac__waveform svg text")].map((element) => element.textContent);

    // Peak = MIN_VALUE / sqrt(2), between MIN_VALUE/2 and MIN_VALUE;
    // binary64 therefore rounds it to MIN_VALUE, not zero.
    expect(axisLabels).toContain("+5e-324 V");
    expect(axisLabels).toContain("−5e-324 V");
    expect(axisLabels).toContain("+5e-324 A");
    expect(axisLabels).toContain("−5e-324 A");
  });

  it("keeps genuinely zero waveforms horizontal and leaves their phase undefined", () => {
    const { container } = renderDivider(0);

    for (const quantity of ["voltage", "current"] as const) {
      const points = tracePoints(container, quantity);
      expect(points).toHaveLength(97);
      expect(points?.every((point) => point.split(",")[1] === "104")).toBe(true);
    }
    expect(container.querySelector(".circuit-ac__phase")?.getAttribute("data-phase-difference-degrees")).toBe("undefined");
  });

  it.each([45, 90, -90, 180])("preserves the normalized waveform at a retained %s degree phase", (phaseDegrees) => {
    const ordinary = renderDivider(1, { phaseDegrees });
    const tiny = renderDivider(Number.MIN_VALUE, { phaseDegrees });

    for (const quantity of ["voltage", "current"] as const) {
      expect(tracePoints(tiny.container, quantity)).toEqual(tracePoints(ordinary.container, quantity));
    }
    expect(tiny.container.querySelector(".circuit-ac__phase")?.getAttribute("data-phase-difference-degrees")).toBe("0");
  });

  it.each(["stale", "unreadable", "malformed"] as const)("uses scalar fallback for %s optional precision", (metadata) => {
    const { container } = renderDivider(metadata === "stale" ? 3 * Number.MIN_VALUE : Number.MIN_VALUE, {
      updateReading(reading) {
        reading.voltageVolts = 0;
        reading.currentAmps = 0;
        if (metadata === "unreadable") {
          for (const property of ["exactVoltage", "exactTerminalCurrents"]) {
            Object.defineProperty(reading, property, { get() { throw new Error("Optional precision unavailable"); } });
          }
        } else if (metadata === "malformed") {
          reading.exactVoltage!.real = { numerator: "invalid", denominator: "1" };
          reading.exactTerminalCurrents!.a!.real = { numerator: "1", denominator: "0" };
        }
      },
    });

    for (const quantity of ["voltage", "current"] as const) {
      expect(tracePoints(container, quantity)?.every((point) => point.split(",")[1] === "104")).toBe(true);
    }
    expect(container.querySelector(".circuit-ac__phase")?.getAttribute("data-phase-difference-degrees")).toBe("undefined");
  });

  it("uses the op-amp output terminal for retained current waveforms", () => {
    const circuit = createCircuitFromSpecs([
      ["amplifier", "op-amp", ["input", "0", "output"], { openLoopGain: 1 }],
      ["source", "ac-source", ["input", "0"], { voltageVolts: Number.MIN_VALUE, frequencyHz: 1000, phaseDegrees: 0 }],
      ["load", "resistor", ["output", "0"], { resistanceOhms: 2 }],
      ["ground", "ground", ["0"]],
    ], "Op-amp with a subnormal output current");
    const analysis = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 1000 });
    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.amplifier!.currentAmps).toBe(0);
    expect(analysis.parts.amplifier!.exactTerminalCurrents?.c).toBeDefined();
    const container = renderPanel(circuit, analysis);
    const points = tracePoints(container, "current");

    // Output current enters the amplifier at phase 180°, opposite the load.
    expect(points).toHaveLength(97);
    expect(points?.[0]).toBe("72,166");
    expect(points?.[48]).toBe("240,42");
    expect(container.querySelector(".circuit-ac__phase")?.getAttribute("data-phase-difference-degrees")).toBe("-180");
  });
});
