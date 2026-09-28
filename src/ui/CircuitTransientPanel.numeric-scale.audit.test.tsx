// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";

it("plots finite bipolar voltages even when the full voltage span overflows", () => {
  const circuit: CircuitDocument = {
    title: "有限な大振幅の交流波形",
    parts: [
      { id: "source", kind: "ac-source", label: "電源", x: 0, y: 0, voltageVolts: 1e308, frequencyHz: 1000 },
      { id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: Number.MAX_VALUE },
    ],
    wires: [
      { id: "positive", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "negative", from: { partId: "source", terminal: "b" }, to: { partId: "load", terminal: "b" } },
    ],
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<CircuitTransientPanel document={circuit} />));
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "波形を計算");
    if (!button) { throw new Error("Missing waveform button"); }
    act(() => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBeUndefined();
    const trace = container.querySelector('[data-quantity="voltageVolts"] polyline');
    expect(trace).not.toBeNull();
    const coordinates = (trace?.getAttribute("points") ?? "").split(" ").map((point) => point.split(",").map(Number));
    for (const point of coordinates) {
      for (const value of point) { expect(Number.isFinite(value)).toBe(true); }
    }
    const heights = coordinates.map((point) => point[1]);
    expect(Math.min(...heights)).toBeCloseTo(16, 10);
    expect(Math.max(...heights)).toBeCloseTo(128, 10);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
