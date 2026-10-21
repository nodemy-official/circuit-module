// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { circuitNodes, circuitPotential, circuitPotentialColor, defaultReferenceNode } from "../../circuit-visualization.js";
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

function mount(circuit: CircuitDocument, analysis: CircuitAnalysis, scale: number, options?: {
  selectedPartId?: string;
  editPotential?: (value: NonNullable<ReturnType<typeof useCircuitPotentialView>["potential"]>) => void;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: ReturnType<typeof useCircuitPotentialView> | undefined;
  const routes = new Map(circuit.wires.map((wire) => [wire.id, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]));
  function Harness() {
    const view = useCircuitPotentialView(circuit, analysis);
    if (view.potential) { options?.editPotential?.(view.potential); }
    latest = view;
    return <>
      <CircuitPotentialControls view={view} />
      <svg aria-hidden="true"><CircuitPotentialOverlay document={circuit} routes={routes} view={view} /></svg>
    </>;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  act(() => {
    latest!.setEnabled(true);
    latest!.setScale(scale);
    const selected = latest!.nodes.find((node) => node.endpoints.some((endpoint) =>
      endpoint.partId === options?.selectedPartId && endpoint.terminal === "a"));
    if (selected) { latest!.setSelectedId(selected.id); }
  });
  return { container, nodes: latest!.nodes, potential: latest!.potential };
}

function currentRows(container: HTMLElement) {
  return [...container.querySelectorAll(".circuit-potential__currents li")].map((row) => ({
    width: Number(row.querySelector("path")?.getAttribute("stroke-width")),
    path: row.querySelector("path")?.getAttribute("d"),
    text: row.querySelector("strong")?.textContent,
  }));
}

describe("retained potential visualization inputs", () => {
  it.each([false, true])("shows a retained nonzero midpoint phase when its RMS rounds to zero (transport=%s)", (transport) => {
    const circuit = createCircuitFromSpecs([
      ["source", "ac-source", ["s", "0"], { voltageVolts: Number.MIN_VALUE, frequencyHz: 1000, phaseDegrees: 37 }],
      ["r1", "resistor", ["s", "m"], { resistanceOhms: 1 }],
      ["r2", "resistor", ["m", "0"], { resistanceOhms: 1 }],
      ["ground", "ground", ["0"]],
    ], "Subnormal measured potential phase");
    const computed = analyzeCircuit(circuit);
    const analysis: CircuitAnalysis = transport ? JSON.parse(JSON.stringify(computed)) : computed;
    const { container, potential } = mount(circuit, analysis, Number.MIN_VALUE, { selectedPartId: "r2" });

    // Equal resistors give MIN_VALUE/2 RMS at the source's defined 37° phase.
    expect(potential?.volts).toBe(0);
    expect(container.querySelector(".circuit-potential__difference")?.textContent).toContain("0 V ∠37°");
  });

  it.each(["zero", "stale", "unreadable", "malformed"] as const)("keeps a zero measured-potential phase hidden with %s precision", (metadata) => {
    const voltage = metadata === "zero" ? 0 : metadata === "stale" ? 3 * Number.MIN_VALUE : Number.MIN_VALUE;
    const circuit = createCircuitFromSpecs([
      ["source", "ac-source", ["s", "0"], { voltageVolts: voltage, frequencyHz: 1000, phaseDegrees: 37 }],
      ["r1", "resistor", ["s", "m"], { resistanceOhms: 1 }],
      ["r2", "resistor", ["m", "0"], { resistanceOhms: 1 }],
      ["ground", "ground", ["0"]],
    ], "Invalid measured potential precision fallback");
    const analysis: CircuitAnalysis = JSON.parse(JSON.stringify(analyzeCircuit(circuit)));
    const { container } = mount(circuit, analysis, Number.MIN_VALUE, {
      selectedPartId: "r2",
      editPotential(value) {
        if (metadata === "stale") { value.volts = 0; }
        if (metadata === "unreadable") {
          Object.defineProperty(value, "exactVoltage", { configurable: true, get() { throw new Error("Optional precision unavailable"); } });
        }
        if (metadata === "malformed" && value.exactVoltage) {
          value.exactVoltage.real = { numerator: "invalid", denominator: "1" };
        }
      },
    });

    expect(container.querySelector(".circuit-potential__difference")?.textContent).not.toContain("∠");
  });

  it("keeps retained current ratios when transported AC phases include full turns", () => {
    const circuit = createCircuitFromSpecs([
      ["source", "ac-source", ["s", "0"], { voltageVolts: Number.MIN_VALUE, frequencyHz: 1000, phaseDegrees: 37 }],
      ["r1", "resistor", ["s", "0"], { resistanceOhms: 1 }],
      ["r2", "resistor", ["s", "0"], { resistanceOhms: 2 }],
      ["ground", "ground", ["0"]],
    ], "retained potential input");
    const analysis: CircuitAnalysis = JSON.parse(JSON.stringify(analyzeCircuit(circuit)));
    for (const reading of Object.values(analysis.parts)) {
      for (const terminal of ["a", "b", "c"] as const) {
        const phase = reading.terminalCurrentPhasesDegrees?.[terminal];
        if (phase === undefined) { continue; }
        reading.terminalCurrentPhasesDegrees![terminal] = phase + 360;
        const projection = reading.exactTerminalCurrents?.[terminal]?.projection;
        if (projection) { projection.phaseDegrees += 360; }
      }
    }
    const { container } = mount(circuit, analysis, Number.MIN_VALUE);
    const rows = currentRows(container);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.width).toBe(5);
    // The final AC square root and fixed pixel base can round one ULP apart.
    expect(rows[1]?.width).toBeCloseTo(11 / 3, 15);
    expect(rows[2]?.width).toBeCloseTo(7 / 3, 15);
  });

  it.each([false, true])("keeps a negative subnormal divider midpoint blue after transport=%s", (transport) => {
    const circuit = createCircuitFromSpecs([
      ["source", "battery", ["0", "s"], { voltageVolts: Number.MIN_VALUE }],
      ["r1", "resistor", ["s", "m"], { resistanceOhms: 1 }],
      ["r2", "resistor", ["m", "0"], { resistanceOhms: 1 }],
      ["ground", "ground", ["0"]],
    ], "retained potential input");
    const computed = analyzeCircuit(circuit);
    expect(computed.status).toBe("closed");
    const analysis: CircuitAnalysis = transport ? JSON.parse(JSON.stringify(computed)) : computed;
    const { container, nodes, potential } = mount(circuit, analysis, Number.MIN_VALUE);
    const terminal = [...container.querySelectorAll("[data-potential-terminal]")]
      .find((item) => item.getAttribute("data-potential-terminal") === JSON.stringify(["r2", "a"]));

    // Reversing the battery gives Vmid / Vsource-magnitude = -1/2, even
    // though the midpoint voltage itself projects to a signed zero.
    expect(terminal?.querySelector("circle")?.getAttribute("fill")).toBe("hsl(218 40% 49%)");
    expect(() => JSON.stringify({ nodes, potential })).not.toThrow();
  });

  it.each([false, true])("keeps an underflowed negative branch current flowing left after transport=%s", (transport) => {
    const circuit = createCircuitFromSpecs([
      ["source", "battery", ["0", "s"], { voltageVolts: Number.MIN_VALUE }],
      ["r1", "resistor", ["s", "0"], { resistanceOhms: 1 }],
      ["r2", "resistor", ["s", "0"], { resistanceOhms: 2 }],
      ["ground", "ground", ["0"]],
    ], "retained potential input");
    const computed = analyzeCircuit(circuit);
    expect(computed.status).toBe("closed");
    const analysis: CircuitAnalysis = transport ? JSON.parse(JSON.stringify(computed)) : computed;
    const { container } = mount(circuit, analysis, Number.MIN_VALUE);
    const rows = currentRows(container);

    expect(rows).toHaveLength(3);
    expect(rows[0]?.text).toMatch(/^→ /);
    expect(rows[1]?.text).toMatch(/^← /);
    expect(rows[2]?.text).toBe("← 0 A");
    expect(rows[2]?.path).toBe("M58 10H6l7 -5M6 10l7 5");
    expect(rows.map((row) => row.width)).toEqual([5, 11 / 3, 7 / 3]);
  });

  it.each(["stale", "unreadable"] as const)("uses edited scalar currents when optional precision is %s", (metadata) => {
    const circuit = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 1 }],
      ["r1", "resistor", ["s", "0"], { resistanceOhms: 2 }],
      ["r2", "resistor", ["s", "0"], { resistanceOhms: 3 }],
      ["ground", "ground", ["0"]],
    ], "retained potential input");
    const analysis: CircuitAnalysis = JSON.parse(JSON.stringify(analyzeCircuit(circuit)));
    expect(analysis.parts.source!.exactTerminalCurrents?.a).toBeDefined();
    expect(analysis.parts.r2!.exactTerminalCurrents?.a).toBeDefined();
    // Scalar-only host edits replace 5/6 and 1/3 A with 3/2 and 1 A.
    Object.assign(analysis.parts.source!.terminalCurrents!, { a: -1.5, b: 1.5 });
    Object.assign(analysis.parts.r2!.terminalCurrents!, { a: 1, b: -1 });
    if (metadata === "unreadable") {
      Object.defineProperty(analysis.parts.r2!, "exactTerminalCurrents", {
        get() { throw new Error("Optional precision is unavailable"); },
      });
    }
    const { container } = mount(circuit, analysis, 1);
    const rows = currentRows(container);

    expect(rows).toHaveLength(3);
    expect(rows[0]?.width).toBe(5);
    expect(rows[1]?.width).toBeCloseTo(7 / 3, 14);
    expect(rows[2]?.width).toBeCloseTo(11 / 3, 14);
    expect(rows[0]?.text).toMatch(/^← /);
    expect(rows[2]?.text).toMatch(/^→ /);
  });

  it.each(["scalar", "phase", "unreadable"] as const)("ignores %s-invalidated precision while coloring a transported potential", (metadata) => {
    const circuit = createCircuitFromSpecs([
      ["source", "ac-source", ["s", "0"], { voltageVolts: Number.MIN_VALUE, frequencyHz: 1000, phaseDegrees: 0 }],
      ["r1", "resistor", ["s", "m"], { resistanceOhms: 1 }],
      ["r2", "resistor", ["m", "0"], { resistanceOhms: 1 }],
      ["ground", "ground", ["0"]],
    ], "retained potential input");
    const analysis = analyzeCircuit(circuit);
    const nodes = circuitNodes(circuit, analysis);
    const middle = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "r2" && endpoint.terminal === "a"));
    const result = circuitPotential(middle, defaultReferenceNode(circuit, nodes), true, { document: circuit, analysis });
    if (!result) { throw new Error("Missing midpoint potential"); }
    const potential: typeof result = JSON.parse(JSON.stringify(result));
    expect(potential.exactVoltage).toBeDefined();
    expect(circuitPotentialColor(potential, Number.MIN_VALUE, true)).toBe("hsl(18 40% 49%)");

    if (metadata === "scalar") { potential.volts = Number.MIN_VALUE; }
    if (metadata === "phase") { potential.phaseDegrees = 90; }
    if (metadata === "unreadable") {
      Object.defineProperty(potential, "exactVoltage", {
        get() { throw new Error("Optional precision is unavailable"); },
      });
    }

    expect(circuitPotentialColor(potential, Number.MIN_VALUE, true))
      .toBe(metadata === "scalar" ? "hsl(18 80% 43%)" : "hsl(18 0% 55%)");
  });
});
