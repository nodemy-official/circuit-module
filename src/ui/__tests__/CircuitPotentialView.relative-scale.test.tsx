// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitPotentialControls, CircuitPotentialOverlay, useCircuitPotentialView } from "../CircuitPotentialView.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(circuit: CircuitDocument, scale: number) {
  const analysis = analyzeCircuit(circuit);
  if (analysis.status !== "closed") { throw new Error(`Unexpected fixture analysis: ${analysis.message}`); }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: ReturnType<typeof useCircuitPotentialView> | undefined;
  const routes = new Map(circuit.wires.map((wire) => [wire.id, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]));
  function Harness() {
    const view = useCircuitPotentialView(circuit, analysis);
    latest = view;
    return <>
      <CircuitPotentialControls view={view} />
      <svg aria-hidden="true"><CircuitPotentialOverlay document={circuit} routes={routes} view={view} /></svg>
    </>;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  act(() => { latest!.setEnabled(true); latest!.setScale(scale); });
  return container;
}

function source(mode: "dc" | "ac", voltage: number, phaseDegrees: number) {
  return ["source", mode === "dc" ? "battery" : "ac-source", ["s", "0"], {
    voltageVolts: voltage, frequencyHz: 1000, phaseDegrees,
  }] as const;
}

const modes = (["dc", "ac"] as const).flatMap((mode) =>
  (mode === "ac" ? [0, 37, -90, 179.999_999_999_999_97] : [0]).map((phaseDegrees) => ({ mode, phaseDegrees })));

describe("potential visualization before display rounding", () => {
  it.each(modes)("keeps the $mode divider midpoint at half-scale color for subnormal voltages ($phaseDegrees degrees)", ({ mode, phaseDegrees }) => {
    for (const voltage of [1, Number.MIN_VALUE, 3 * Number.MIN_VALUE, 5 * Number.MIN_VALUE]) {
      const circuit = createCircuitFromSpecs([
        source(mode, voltage, phaseDegrees),
        ["r1", "resistor", ["s", "m"], { resistanceOhms: 1 }],
        ["r2", "resistor", ["m", "0"], { resistanceOhms: 1 }],
        ["ground", "ground", ["0"]],
      ], "Equal-resistance divider");
      const container = mount(circuit, voltage);
      const terminal = [...container.querySelectorAll("[data-potential-terminal]")]
        .find((item) => item.getAttribute("data-potential-terminal") === JSON.stringify(["r2", "a"]));
      const middleWire = circuit.wires.find((wire) => wire.to.partId === "r2" && wire.to.terminal === "a")!;
      const overlayWire = container.querySelector(`[data-potential-wire="${middleWire.id}"]`);

      // Independent divider oracle: R1 = R2, so Vmid / Vsource = 1/2.
      expect(terminal?.querySelector("circle")?.getAttribute("fill"), `terminal at ${voltage} V`).toBe("hsl(18 40% 49%)");
      expect(overlayWire?.getAttribute("stroke"), `wire at ${voltage} V`).toBe("hsl(18 40% 49%)");
    }
  });

  it.each(modes)("keeps $mode parallel-branch arrow widths proportional before current rounding ($phaseDegrees degrees)", ({ mode, phaseDegrees }) => {
    for (const voltage of [1, Number.MIN_VALUE, 3 * Number.MIN_VALUE, 5 * Number.MIN_VALUE]) {
      const circuit = createCircuitFromSpecs([
        source(mode, voltage, phaseDegrees),
        ["r1", "resistor", ["s", "0"], { resistanceOhms: 1 }],
        ["r2", "resistor", ["s", "0"], { resistanceOhms: 2 }],
        ["ground", "ground", ["0"]],
      ], "Parallel branches with a two-to-one current ratio");
      const container = mount(circuit, voltage);
      const widths = [...container.querySelectorAll(".circuit-potential__currents path")]
        .map((path) => Number(path.getAttribute("stroke-width")));

      // Ohm's law and KCL: source : R1 : R2 = 3 : 2 : 1.
      // SVG widths have a 1 px base plus 4 px times the relative magnitude.
      expect(widths, `currents at ${voltage} V`).toHaveLength(3);
      expect(widths[0]).toBe(5);
      expect(widths[1]).toBeCloseTo(11 / 3, 14);
      expect(widths[2]).toBeCloseTo(7 / 3, 14);
    }
  });
});
