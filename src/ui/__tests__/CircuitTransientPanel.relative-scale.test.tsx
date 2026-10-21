// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { assertCorrectRounding, rational } from "../../__tests__/helpers/numeric-oracle.js";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Quantity = "voltageVolts" | "currentAmps";

function rcCircuit(voltage: number, resistance = 2) {
  return createCircuitFromSpecs([
    ["c", "capacitor", ["v", "0"], { capacitanceFarads: 1, initialVoltageVolts: voltage }],
    ["r", "resistor", ["v", "0"], { resistanceOhms: resistance }],
    ["ground", "ground", ["0"]],
  ], "Unforced RC decay for relative waveform scaling");
}

function setNumber(container: HTMLElement, suffix: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`);
  if (!input) { throw new Error(`Missing ${suffix} input`); }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function mount(circuit: CircuitDocument, baselineDocument?: CircuitDocument) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const frame: { current: CircuitTransientFrame | null } = { current: null };
  const render = () => act(() => root.render(<CircuitTransientPanel
    document={circuit} baselineDocument={baselineDocument} onFrameChange={(next) => { frame.current = next; }}
  />));
  render();
  mounted.push({ root, container });
  setNumber(container, "duration", "1");
  setNumber(container, "steps", "4");
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "波形を計算");
  if (!button) { throw new Error("Missing waveform calculation button"); }
  act(() => button.click());
  const captured = frame.current;
  if (captured?.analysis.status !== "valid") { throw new Error("Expected a valid transient frame"); }
  return { container, render, analysis: captured.analysis };
}

function heights(container: HTMLElement, quantity: Quantity) {
  return [...container.querySelectorAll(`[data-quantity="${quantity}"] polyline`)].map((line) =>
    (line.getAttribute("points") ?? "").split(" ").map((point) => Number(point.split(",")[1])),
  );
}

describe("transient waveforms before display rounding", () => {
  it("rounds completed RC plot coordinates using the independent backward-Euler decay law", () => {
    const ui = mount(rcCircuit(Number.MIN_VALUE));
    const voltages = heights(ui.container, "voltageVolts");
    const currents = heights(ui.container, "currentAmps");
    for (let index = 0; index <= 4; index += 1) {
      // dt=1/4, RC=2 gives Vn/V0=(8/9)^n. Voltage has range [0,V0];
      // equal and opposite capacitor/resistor currents span [-V0/2,V0/2].
      const numerator = 8n ** BigInt(index);
      const denominator = 9n ** BigInt(index);
      assertCorrectRounding(voltages[0]![index]!, rational(128n * denominator - 112n * numerator, denominator), `voltage sample ${index}`);
      assertCorrectRounding(currents[0]![index]!, rational(72n * denominator + 56n * numerator, denominator), `capacitor current sample ${index}`);
      assertCorrectRounding(currents[1]![index]!, rational(72n * denominator - 56n * numerator, denominator), `resistor current sample ${index}`);
    }
  });

  it.each(["voltageVolts", "currentAmps"] as const)("keeps the self-scaled %s RC decay shape at subnormal amplitudes", (quantity) => {
    for (const compare of [false, true]) {
      const normal = mount(rcCircuit(1), compare ? rcCircuit(1, 1) : undefined);
      const expected = heights(normal.container, quantity);
      const tiny = mount(rcCircuit(Number.MIN_VALUE), compare ? rcCircuit(Number.MIN_VALUE, 1) : undefined);
      const actual = heights(tiny.container, quantity);

      expect(actual).toHaveLength(expected.length);
      for (const [index, line] of actual.entries()) {
        expect(line).toHaveLength(expected[index]!.length);
        for (const [sample, height] of line.entries()) {
          expect(height).toBeCloseTo(expected[index]![sample]!, 11);
        }
      }
      // In this unforced RC circuit the capacitor and resistor currents are
      // equal and opposite, even when both public numbers round to zero.
      expect(tiny.analysis.samples[0]!.parts.r!.currentAmps).toBe(0);
    }
  });

  it.each(["voltageVolts", "currentAmps"] as const)("prefers edited scalar %s over stale or unreadable precision", (quantity) => {
    for (const metadata of ["stale", "unreadable", "malformed"]) {
      const ui = mount(rcCircuit(1));
      for (const sample of ui.analysis.samples) {
        for (const reading of Object.values(sample.parts)) {
          reading[quantity] = 0;
          const field = quantity === "voltageVolts" ? "exactVoltage" : "exactTerminalCurrents";
          if (metadata === "unreadable") {
            Object.defineProperty(reading, field, { get() { throw new Error("Optional precision is unavailable"); } });
          }
          if (metadata === "malformed") { Reflect.set(reading, field, false); }
        }
      }

      expect(ui.render).not.toThrow();

      const lines = heights(ui.container, quantity);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) { expect(line.every((value) => value === 72)).toBe(true); }
    }
  });

  it("refreshes retained plot values after a JSON round trip and a nested precision edit", () => {
    const ui = mount(rcCircuit(Number.MIN_VALUE));
    const before = heights(ui.container, "currentAmps");
    Object.assign(ui.analysis, JSON.parse(JSON.stringify(ui.analysis)));
    ui.render();
    expect(heights(ui.container, "currentAmps")).toEqual(before);

    for (const id of ["c", "r"]) {
      const current = ui.analysis.samples[0]!.parts[id]!.exactTerminalCurrents!.a!;
      current.real = { numerator: id === "c" ? "-1" : "1", denominator: (2n ** 1075n).toString() };
    }
    ui.render();
    expect(heights(ui.container, "currentAmps")).toEqual(before);

    for (const id of ["c", "r"]) {
      const component = ui.analysis.samples[0]!.parts[id]!.exactTerminalCurrents?.a?.real;
      if (!component || !("numerator" in component)) { throw new Error("Missing retained rational current"); }
      component.numerator = "0";
    }
    ui.render();

    const after = heights(ui.container, "currentAmps");
    expect(after[0]?.[0]).toBe(72);
    expect(after[1]?.[0]).toBe(72);
    expect(after[0]?.[1]).toBe(128);
    expect(after[1]?.[1]).toBe(16);
  });

  it("reuses restored plot coordinates while playback only moves the cursor", async () => {
    vi.useFakeTimers();
    const precision = await import("../../circuit-reading.js");
    const restore = vi.spyOn(precision, "restoredReadingComplex");
    const ui = mount(rcCircuit(Number.MIN_VALUE));
    restore.mockClear();
    const play = [...ui.container.querySelectorAll("button")].find((item) => item.textContent === "再生");
    if (!play) { throw new Error("Missing playback button"); }

    act(() => play.click());
    act(() => vi.advanceTimersByTime(100));

    expect(restore).not.toHaveBeenCalled();
    expect(ui.container.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe("2");
  });

  it.each(["scalar", "precision"] as const)("observes indexed %s edits when a sample iterator omits that sample", (field) => {
    const ui = mount(rcCircuit(field === "scalar" ? 1 : Number.MIN_VALUE));
    Object.assign(ui.analysis, JSON.parse(JSON.stringify(ui.analysis)));
    const samples = ui.analysis.samples;
    Object.defineProperty(samples, Symbol.iterator, { *value() { yield samples[0]!; } });
    ui.render();

    for (const id of ["c", "r"]) {
      const reading = samples[1]!.parts[id]!;
      if (field === "scalar") { reading.voltageVolts = 0; }
      else { reading.exactTerminalCurrents!.a!.real = { numerator: "0", denominator: "1" }; }
    }
    ui.render();

    const lines = heights(ui.container, field === "scalar" ? "voltageVolts" : "currentAmps");
    for (const line of lines) { expect(line[1]).toBe(field === "scalar" ? 128 : 72); }
  });
});
