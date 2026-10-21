// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import type { CircuitTransientFrame } from "../../circuit-visualization.js";
import { CircuitTransientPanel } from "../CircuitTransientPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(active = true) {
  const circuit: CircuitDocument = {
    title: "interaction order",
    parts: Array.from({ length: 4 }, (_, index) => ({
      id: `resistor-${index}`, kind: "resistor", label: `R${index}`, x: index * 5, y: 0, resistanceOhms: 10,
    })),
    wires: [],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const frames: Array<CircuitTransientFrame | null> = [];
  const render = (nextActive: boolean) => act(() => root.render(<CircuitTransientPanel document={circuit} active={nextActive} onFrameChange={(frame) => frames.push(frame)} />));
  render(active);
  const button = (text: string) => {
    const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
    if (!element) { throw new Error(`Missing button: ${text}`); }
    return element;
  };
  return { container, button, frames, render };
}

it.each([false, true])("does not arm playback while inactive or begin playing when the panel becomes active (previously active=%s)", (previouslyActive) => {
  vi.useFakeTimers();
  const ui = mount(previouslyActive);
  act(() => ui.button("波形を計算").click());
  if (previouslyActive) { ui.render(false); }
  const play = ui.button("再生");
  act(() => play.click());
  expect(play.getAttribute("aria-pressed")).toBe("false");
  ui.render(true);
  act(() => vi.advanceTimersByTime(100));
  expect(ui.frames.at(-1)?.sampleIndex).toBe(0);
});
