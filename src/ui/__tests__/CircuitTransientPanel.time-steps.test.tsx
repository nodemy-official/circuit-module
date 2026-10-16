// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import type { CircuitTransientFrame } from "../../circuit-visualization.js";
import { CircuitTransientPanel } from "../CircuitTransientPanel.js";

const mounted: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const cleanup of mounted.splice(0)) { cleanup(); }
  vi.unstubAllGlobals();
});

function changeNumber(input: HTMLInputElement, value: number) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function runPanel(duration: number, steps: number) {
  const circuit: CircuitDocument = {
    title: "指定した時間分割数",
    parts: [{ id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: 10 }],
    wires: [],
  };
  const frames: Array<CircuitTransientFrame | null> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(<CircuitTransientPanel document={circuit} onFrameChange={(frame) => frames.push(frame)} />));
  changeNumber(container.querySelector<HTMLInputElement>('input[id$="-duration"]')!, duration);
  changeNumber(container.querySelector<HTMLInputElement>('input[id$="-steps"]')!, steps);
  const calculate = [...container.querySelectorAll("button")].find((button) => button.textContent === "波形を計算")!;
  act(() => calculate.click());
  return { container, result: frames.at(-1)?.analysis };
}

it.each([
  { duration: 0.1, steps: 19 },
  { duration: 0.249, steps: 2000 },
  { duration: Number.MIN_VALUE, steps: 1 },
  { duration: 1e-320, steps: 1012 },
])("honors $steps requested intervals over $duration seconds after quotient rounding", ({ duration, steps }) => {
  const { container, result } = runPanel(duration, steps);
  expect(container.querySelector('[role="alert"]')?.textContent).toBeUndefined();
  expect(result?.status).toBe("valid");
  expect(result?.samples).toHaveLength(steps + 1);
  expect(result?.samples.at(-1)?.timeSeconds).toBe(duration);
  const times = result!.samples.map((sample) => sample.timeSeconds);
  for (let index = 1; index < times.length; index += 1) {
    const interval = times[index]! - times[index - 1]!;
    expect(interval / (duration / steps)).toBeCloseTo(1, 10);
  }
  expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.max).toBe(String(steps));
});

it.each([
  { duration: Number.MIN_VALUE, steps: 2 },
  { duration: 1e-320, steps: 2000 },
])("explains when $duration seconds cannot represent $steps intervals", ({ duration, steps }) => {
  const { container, result } = runPanel(duration, steps);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("指定した時間分割数を数値精度の範囲内で表せません");
  expect(container.querySelector('input[type="range"]')).toBeNull();
  expect(result).toBeUndefined();
});
