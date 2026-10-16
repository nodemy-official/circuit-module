// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitSimulationPanel } from "../CircuitSimulationPanel.js";
import { CircuitTransientPanel } from "../CircuitTransientPanel.js";
import { SimulationDocumentKeysContext, useSimulationDocumentKey } from "../simulation-document-context.js";
import { simulationDocumentKey } from "../simulation-document-key.js";

vi.mock("../simulation-document-key.js", { spy: true });

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const root of roots.splice(0)) { act(() => root.unmount()); }
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function circuit(): CircuitDocument {
  return {
    title: "描画ごとのキー共有",
    parts: [{ id: "load", kind: "resistor", label: "抵抗", x: 0, y: 0, resistanceOhms: 10 }],
    wires: [],
  };
}

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  return { container, root };
}

function Consumer({ document }: { document: CircuitDocument }) {
  const [count, setCount] = useState(0);
  const key = useSimulationDocumentKey(document, true);
  return <button type="button" data-key={key} onClick={() => setCount(count + 1)}>{count}</button>;
}

describe("simulation document key sharing", () => {
  it("reuses a parent capture once and reads in-place edits during local child updates", () => {
    const document = circuit();
    const key = simulationDocumentKey(document);
    const capture = vi.mocked(simulationDocumentKey).mockClear();
    const { container, root } = mount();
    act(() => root.render(<SimulationDocumentKeysContext.Provider value={[{ document, key }]}>
      <Consumer document={document} />
    </SimulationDocumentKeysContext.Provider>));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("data-key")).toBe(key);
    expect(capture).not.toHaveBeenCalled();

    document.parts[0]!.resistanceOhms = 20;
    act(() => button.click());

    expect(button.getAttribute("data-key")).not.toBe(key);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("skips capture before a transient run and when learning panels are hidden", () => {
    const document = circuit();
    const analysis = analyzeCircuit(document);
    const capture = vi.mocked(simulationDocumentKey).mockClear();
    const { root } = mount();
    act(() => root.render(<CircuitTransientPanel document={document} />));
    expect(capture).not.toHaveBeenCalled();
    act(() => root.render(<CircuitSimulationPanel document={document} analysis={analysis} options={{}}
      onChange={() => {}} showLearningPanels={false} />));
    expect(capture).not.toHaveBeenCalled();
  });
});
