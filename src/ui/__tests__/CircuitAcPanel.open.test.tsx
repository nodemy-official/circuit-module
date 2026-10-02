// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { CircuitAcPanel } from "../CircuitAcPanel.js";

const options = { mode: "ac" as const, frequencyHz: 50 };
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

function openMeterCircuit(): CircuitDocument {
  return {
    title: "交流電源と電圧計だけの開回路",
    parts: [
      { id: "meter", kind: "voltmeter", label: "電圧計", x: 4, y: 0 },
      { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 5, frequencyHz: 50, phaseDegrees: 0 },
    ],
    wires: [
      { id: "meter-a", from: { partId: "source", terminal: "a" }, to: { partId: "meter", terminal: "a" } },
      { id: "meter-b", from: { partId: "source", terminal: "b" }, to: { partId: "meter", terminal: "b" } },
    ],
  };
}

function mountPanel(circuit: CircuitDocument, analysis: CircuitAnalysis) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<CircuitAcPanel document={circuit} analysis={analysis} options={options} />));
  return { root, container };
}

function runSweep(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === "対数スイープを計算");
  if (!button) { throw new Error("Missing frequency sweep button"); }
  act(() => button.click());
}

describe("CircuitAcPanel open AC circuits", () => {
  it("draws a connected voltmeter's 5 V RMS waveform without a current path", () => {
    const circuit = openMeterCircuit();
    const analysis = analyzeCircuit(circuit, {}, options);
    expect(analysis.status).toBe("open");
    expect(analysis.parts.meter).toMatchObject({
      meterStatus: "connected",
      voltageVolts: 5,
      voltagePhaseDegrees: 0,
      currentAmps: 0,
    });
    const { container } = mountPanel(circuit, analysis);

    expect(container.querySelector(".circuit-ac")?.getAttribute("data-state")).toBe("active");
    expect(container.querySelector(".circuit-ac__waveform")?.getAttribute("data-voltage-rms")).toBe("5");
    expect(container.querySelector(".circuit-ac__waveform")?.getAttribute("data-current-rms")).toBe("0");
    expect(container.textContent).toContain("電圧計の電圧と電流の交流波形");
    expect(container.textContent).toContain("実効値 5 V");
    expect(container.textContent).toContain("T = 0.02 s");
    const voltagePoints = container.querySelector(".circuit-ac__trace--voltage")?.getAttribute("points")?.split(" ");
    expect(voltagePoints).toHaveLength(97);
    expect(voltagePoints?.[0]).toBe("72,42");
    expect(voltagePoints?.[48]).toBe("240,166");
    expect(voltagePoints?.[96]).toBe("408,42");
    const currentPoints = container.querySelector(".circuit-ac__trace--current")?.getAttribute("points")?.split(" ");
    expect(currentPoints).toHaveLength(97);
    expect(currentPoints?.every((point) => Number(point.split(",")[1]) === 104)).toBe(true);
  });

  it("sweeps the connected voltmeter at 5 V RMS across the open circuit's frequency range", () => {
    const circuit = openMeterCircuit();
    const analysis = analyzeCircuit(circuit, {}, options);
    expect(analysis.status).toBe("open");
    const { container } = mountPanel(circuit, analysis);

    runSweep(container);

    const points = Array.from(container.querySelectorAll(".circuit-ac__response-dot"));
    expect(points).toHaveLength(41);
    expect(container.querySelector(".circuit-ac__response")?.getAttribute("data-valid-points")).toBe("41");
    expect(container.querySelectorAll(".circuit-ac__response-trace")).toHaveLength(1);
    const frequencies = points.map((point) => Number(point.getAttribute("data-frequency-hz")));
    expect(frequencies[0]).toBe(5);
    expect(frequencies).toContain(50);
    expect(frequencies.at(-1)).toBe(500);
    for (const point of points) {
      expect(Number(point.getAttribute("data-voltage-rms"))).toBe(5);
    }
  });

  it.each(["floating", "unconnected"] as const)("hides %s meter waveforms and sweep values in an open circuit", (meterStatus) => {
    const circuit = openMeterCircuit();
    circuit.wires = circuit.wires.filter((wire) => wire.id !== "meter-b");
    if (meterStatus === "floating") {
      circuit.parts.push({ id: "isolated", kind: "junction", label: "孤立端子", x: 8, y: 0 });
      circuit.wires.push({ id: "meter-b", from: { partId: "isolated", terminal: "a" }, to: { partId: "meter", terminal: "b" } });
    }
    const analysis = analyzeCircuit(circuit, {}, options);
    expect(analysis.status).toBe("open");
    expect(analysis.parts.meter.meterStatus).toBe(meterStatus);
    const { container } = mountPanel(circuit, analysis);

    expect(container.querySelector(".circuit-ac")?.getAttribute("data-state")).toBe("active");
    expect(container.querySelector(".circuit-ac__waveform")?.getAttribute("data-voltage-rms")).toBe("undefined");
    expect(container.querySelector(".circuit-ac__waveform")?.getAttribute("data-current-rms")).toBe("undefined");
    expect(container.querySelectorAll(".circuit-ac__trace")).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("波形を表示できません。");

    runSweep(container);

    expect(container.querySelector(".circuit-ac__response")?.getAttribute("data-valid-points")).toBe("0");
    expect(container.querySelectorAll(".circuit-ac__response-dot, .circuit-ac__response-trace")).toHaveLength(0);
    expect(container.querySelectorAll('.circuit-ac__response [data-valid="false"]')).toHaveLength(41);
  });

  it.each(["invalid", "short"] as const)("hides previous readings and sweep values when the analysis becomes %s", (status) => {
    const circuit = openMeterCircuit();
    const analysis = analyzeCircuit(circuit, {}, options);
    const { root, container } = mountPanel(circuit, analysis);
    runSweep(container);
    expect(container.querySelectorAll(".circuit-ac__response-dot")).toHaveLength(41);

    act(() => root.render(<CircuitAcPanel document={circuit} analysis={{ ...analysis, status }} options={options} />));

    expect(container.querySelector(".circuit-ac")?.getAttribute("data-state")).toBe("empty");
    expect(container.querySelector(".circuit-ac__waveform")).toBeNull();
    expect(container.querySelector(".circuit-ac__response")).toBeNull();
    expect(container.querySelectorAll(".circuit-ac__trace, .circuit-ac__response-dot")).toHaveLength(0);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("実効値 5 V");
  });

  it.each(["invalid", "short"] as const)("omits %s sweep points even if they retain finite readings", async (status) => {
    const circuitSolver = await import("../../circuit-solver.js");
    const circuit = openMeterCircuit();
    const analysis = analyzeCircuit(circuit, {}, options);
    const { container } = mountPanel(circuit, analysis);
    vi.spyOn(circuitSolver, "analyzeCircuit").mockReturnValue({ ...analysis, status });

    runSweep(container);

    expect(container.querySelector(".circuit-ac__response")?.getAttribute("data-valid-points")).toBe("0");
    expect(container.querySelectorAll(".circuit-ac__response-dot, .circuit-ac__response-trace")).toHaveLength(0);
    expect(container.querySelectorAll('.circuit-ac__response [data-valid="false"]')).toHaveLength(41);
  });
});
