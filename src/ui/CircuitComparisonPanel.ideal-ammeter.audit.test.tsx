// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPartKind, type CircuitTerminal } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { CircuitComparisonPanel } from "./CircuitComparisonPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

const part = (id: string, kind: CircuitPartKind) => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
});

const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function currentComparisonCells(circuit: CircuitDocument, analysis: ReturnType<typeof analyzeCircuit>) {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(
    <CircuitComparisonPanel
      document={circuit}
      analysis={analysis}
      baselineDocument={circuit}
      baselineAnalysis={analysis}
    />,
  ));
  mounted.push({ root, container });
  const currentMetric = container.querySelector<HTMLInputElement>('input[value="currentAmps"]');
  if (!currentMetric) { throw new Error("Missing current metric selector"); }
  act(() => currentMetric.click());

  const cells = container.querySelectorAll<HTMLTableRowElement>('tr[data-part-id="meter"] td');
  return [...cells].map((cell) => cell.textContent);
}

describe("comparison of an indeterminate ammeter", () => {
  it("hides floating and unconnected current readings and their deltas", () => {
    const circuit: CircuitDocument = {
      title: "理想電源並列電流計",
      parts: [
        part("source", "ac-source"),
        { ...part("load", "resistor"), resistanceOhms: 10 },
        part("meter", "ammeter"),
        part("battery", "battery"),
      ],
      wires: [
        wire("source-load", "source", "a", "load", "a"),
        wire("load-meter", "load", "b", "meter", "a"),
        wire("meter-source", "meter", "b", "source", "b"),
        wire("battery-a", "battery", "a", "meter", "a"),
        wire("battery-b", "battery", "b", "meter", "b"),
      ],
    };
    const analysis = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 1000 });
    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.meter.meterStatus).toBe("floating");
    expect(Number.isFinite(analysis.parts.meter.currentAmps)).toBe(true);
    expect(currentComparisonCells(circuit, analysis)).toEqual(["—", "—", "—"]);

    const unconnectedAnalysis = {
      ...analysis,
      parts: {
        ...analysis.parts,
        meter: { ...analysis.parts.meter!, meterStatus: "unconnected" as const },
      },
    };
    expect(currentComparisonCells(circuit, unconnectedAnalysis)).toEqual(["—", "—", "—"]);
  });
});
