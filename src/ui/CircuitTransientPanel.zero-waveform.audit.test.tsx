// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("zero transient waveforms", () => {
  it("centers the current waveform when all sampled values are zero", () => {
    const circuit: CircuitDocument = {
      title: "開回路",
      parts: [{ id: "source", kind: "battery", label: "電池", x: 0, y: 0, voltageVolts: 9 }],
      wires: [],
    };
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<CircuitTransientPanel document={circuit} />));
    mounted.push({ root, container });

    const calculate = [...container.querySelectorAll("button")].find((button) => button.textContent === "波形を計算");
    if (!calculate) { throw new Error("Missing transient calculation button"); }
    act(() => calculate.click());

    const zeroCurrentTraces = container.querySelectorAll<SVGPolylineElement>(
      '.circuit-waveform[data-quantity="currentAmps"] .circuit-waveform__trace',
    );
    expect(zeroCurrentTraces.length).toBeGreaterThan(0);
    for (const trace of zeroCurrentTraces) {
      const yCoordinates = (trace.getAttribute("points") ?? "").split(" ").map((point) => Number(point.split(",")[1]));
      expect(yCoordinates.length).toBeGreaterThan(0);
      expect(yCoordinates.every((coordinate) => coordinate === 72)).toBe(true);
    }
  });
});
