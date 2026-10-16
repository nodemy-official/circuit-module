// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { circuitEndpointKey } from "../../circuit-visualization.js";
import { CircuitPotentialControls, useCircuitPotentialView } from "../CircuitPotentialView.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount() {
  const circuit: CircuitDocument = {
    title: "Mutable potential inputs",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 9 },
      { id: "load", kind: "resistor", label: "抵抗", x: 8, y: 0, resistanceOhms: 10 },
      { id: "ground", kind: "ground", label: "接地", x: 0, y: 5 },
    ],
    wires: [
      { id: "supply", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "ground", from: { partId: "source", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      { id: "return", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };
  const analysis = analyzeCircuit(circuit);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: ReturnType<typeof useCircuitPotentialView> | undefined;
  function Harness() {
    const view = useCircuitPotentialView(circuit, analysis);
    latest = view;
    return <CircuitPotentialControls view={view} />;
  }
  const render = () => act(() => root.render(<Harness />));
  render();
  mounted.push({ root, container });
  return {
    circuit,
    analysis,
    container,
    render,
    get view() {
      if (!latest) { throw new Error("Missing potential view"); }
      return latest;
    },
  };
}

it("refreshes displayed terminal currents when an analysis is updated in place", () => {
  const ui = mount();
  expect(ui.container.querySelector(".circuit-potential__currents")?.textContent).toContain("900 mA");
  act(() => { ui.view.setEnabled(true); ui.view.setScale(20); });
  const referenceId = ui.view.reference?.id;
  const selectedId = ui.view.selected?.id;
  ui.circuit.parts[1]!.resistanceOhms = 20;
  Object.assign(ui.analysis, analyzeCircuit(ui.circuit));

  ui.render();

  expect(ui.container.querySelector(".circuit-potential__currents")?.textContent).toContain("450 mA");
  expect(ui.container.querySelector(".circuit-potential__currents")?.textContent).not.toContain("900 mA");
  expect(ui.view.selected?.currents.find((entry) => entry.endpoint.partId === "load")?.amps).toBe(0.45);
  expect(ui.view.reference?.id).toBe(referenceId);
  expect(ui.view.selected?.id).toBe(selectedId);
  expect(ui.view.enabled).toBe(true);
  expect(ui.view.scale).toBe(20);
});

it("rebuilds endpoint membership when a reused circuit loses a wire", () => {
  const ui = mount();
  const sourceKey = circuitEndpointKey({ partId: "source", terminal: "b" });
  const loadKey = circuitEndpointKey({ partId: "load", terminal: "b" });
  expect(ui.view.byEndpoint.get(sourceKey)).toBe(ui.view.byEndpoint.get(loadKey));
  expect(ui.view.nodes).toHaveLength(2);
  ui.circuit.wires.pop();
  Object.assign(ui.analysis, analyzeCircuit(ui.circuit));

  ui.render();

  expect(ui.view.byEndpoint.get(sourceKey)).not.toBe(ui.view.byEndpoint.get(loadKey));
  expect(ui.view.nodes).toHaveLength(3);
  expect(ui.container.querySelectorAll('select[id$="-selected"] option')).toHaveLength(3);
});

it("hides old potential and current data when a reused analysis becomes invalid", () => {
  const ui = mount();
  expect(ui.view.nodes).toHaveLength(2);
  ui.analysis.status = "invalid";

  ui.render();

  expect(ui.view.nodes).toHaveLength(0);
  expect(ui.view.potential).toBeNull();
  expect(ui.container.querySelector(".circuit-potential__currents")).toBeNull();
  expect(ui.container.textContent).toContain("回路を接続して解析できる状態にすると表示されます。");
});
