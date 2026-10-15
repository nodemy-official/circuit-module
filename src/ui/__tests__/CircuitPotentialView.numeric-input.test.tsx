// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExampleCircuit } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitPotentialControls, useCircuitPotentialView } from "../CircuitPotentialView.js";

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

function mount(mode: "dc" | "ac" = "dc") {
  const initial = createExampleCircuit();
  const circuit = mode === "dc" ? initial : {
    ...initial,
    parts: initial.parts.map((part) => part.kind === "battery"
      ? { ...part, kind: "ac-source" as const, frequencyHz: 1000, phaseDegrees: 0, offsetVolts: 0 } : part),
  };
  const analysis = analyzeCircuit(circuit);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let scale = 0;
  function Harness() {
    const view = useCircuitPotentialView(circuit, analysis);
    scale = view.scale;
    return <CircuitPotentialControls view={view} />;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => input.focus());
  return { container, input, get scale() { return scale; } };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("potential color scale drafts", () => {
  it("keeps an incomplete exponent without changing the color scale", () => {
    const ui = mount();
    inputValue(ui.input, "1");
    // Native number inputs expose an empty value while '1e-' is being typed.
    inputValue(ui.input, "");
    expect(ui.input.value).toBe("");
    expect(ui.scale).toBe(1);
    inputValue(ui.input, "1e-9");
    expect(ui.input.value).toBe("1e-9");
    expect(ui.scale).toBe(1e-9);
    expect(ui.input.validity.rangeUnderflow).toBe(false);
  });

  it("retains a rejected draft until blur then restores the committed scale", () => {
    const ui = mount();
    inputValue(ui.input, "-1");
    expect(ui.input.value).toBe("-1");
    expect(ui.scale).toBe(10);
    act(() => ui.input.blur());
    expect(ui.input.value).toBe("10");
  });

  it("uses distinct legend keys when the midpoint underflows to zero", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ui = mount("ac");
    inputValue(ui.input, String(Number.MIN_VALUE));
    expect(ui.scale).toBe(Number.MIN_VALUE);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(["dc", "ac"] as const)("keeps the full %s legend colors at tiny scales", (mode) => {
    const ui = mount(mode);
    const colors = () => [...ui.container.querySelectorAll<HTMLElement>(".circuit-potential__legend i")]
      .filter((_, index) => index !== 1).map((item) => item.style.backgroundColor);
    inputValue(ui.input, "1");
    const normalColors = colors();
    for (const scale of [1e-20, Number.MIN_VALUE]) {
      inputValue(ui.input, String(scale));
      expect(ui.scale).toBe(scale);
      expect(colors()).toEqual(normalColors);
    }
  });
});
