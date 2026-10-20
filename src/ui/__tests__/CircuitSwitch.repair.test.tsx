// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitBoard } from "../CircuitBoard.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";
import { CircuitPreviewParts } from "../CircuitPreviewParts.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); }
  vi.unstubAllGlobals();
});

function switchPart(): CircuitPart {
  return { id: "switch", kind: "switch", x: 0, y: 0, ...circuitPartCatalog.switch.defaults };
}

function mount(initial: CircuitPart, view: "inspector" | "panel" | "parts" | "board") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest = initial;
  function Harness() {
    const [part, setPart] = useState(initial);
    latest = part;
    const update = (closed: boolean) => setPart({ ...switchPart(), initiallyClosed: closed });
    const onChange = (_id: string, patch: Partial<CircuitPart>) => update(patch.initiallyClosed!);
    if (view === "inspector") { return <CircuitInspector part={part} onChange={onChange} />; }
    const document = { title: "", parts: [part], wires: [] };
    const analysis = analyzeCircuit(document);
    if (view === "panel") { return <CircuitPreviewPanel document={document} analysis={analysis} onChange={onChange} onReset={() => {}} showReadings={false} />; }
    if (view === "parts") { return <CircuitPreviewParts document={document} initialDocument={document} analysis={analysis} onReset={() => {}} onInspectPart={() => {}} onSwitchToggle={() => update(true)} />; }
    return <CircuitBoard document={document} readOnly onSwitchToggle={() => update(true)} renderControls={null} showFlow={false} showPotentials={false} />;
  }
  mounted.push({ root, container });
  act(() => root.render(<Harness />));
  if (view === "parts") { act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click()); }
  const selector = view === "board" ? '.circuit-board__part[data-part-id="switch"]'
    : view === "parts" ? ".circuit-preview-parts__switch" : '[role="switch"]';
  return { container, get control() { return container.querySelector<HTMLElement>(selector)!; }, get part() { return latest; } };
}

describe.each(["inspector", "panel", "parts", "board"] as const)("%s switch state", (view) => {
  it.each(["null", "string", "getter"] as const)("shows and repairs an invalid own %s value without reading accessors", (malformed) => {
    const part = switchPart();
    const getter = vi.fn(() => { throw new Error("Switch getters must not run"); });
    Object.defineProperty(part, "initiallyClosed", malformed === "getter"
      ? { get: getter, enumerable: true, configurable: true }
      : { value: malformed === "null" ? null : "true", enumerable: true, configurable: true });
    const ui = mount(part, view);
    expect(ui.control.getAttribute("aria-invalid")).toBe("true");

    act(() => ui.control.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(ui.part.initiallyClosed).toBe(true);
    expect(ui.control.hasAttribute("aria-invalid")).toBe(false);
    expect(analyzeCircuit({ title: "", parts: [ui.part], wires: [] }).status).not.toBe("invalid");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([false, true, undefined])("preserves the valid own state or omitted default (%s)", (closed) => {
    const part = switchPart();
    if (closed === undefined) { Reflect.deleteProperty(part, "initiallyClosed"); }
    else { Object.defineProperty(part, "initiallyClosed", { value: closed, enumerable: false }); }
    const ui = mount(part, view);
    expect(ui.control.hasAttribute("aria-invalid")).toBe(false);
    expect(ui.control.getAttribute(view === "board" || view === "parts" ? "aria-pressed" : "aria-checked")).toBe(String(closed ?? true));
  });
});

it.each(["switch", "resistor"] as const)("refreshes cached %s artwork when an omitted setting becomes an accessor", (kind) => {
  const part: CircuitPart = { id: "part", kind, label: "部品", x: 0, y: 0 };
  const circuit = { title: "", parts: [part], wires: [] };
  const container = document.createElement("div");
  const root = createRoot(container);
  mounted.push({ root, container });
  const toggle = vi.fn();
  const render = () => act(() => root.render(<CircuitBoard document={circuit} readOnly onSwitchToggle={toggle} renderControls={null} showFlow={false} showPotentials={false} />));
  render();
  const getter = vi.fn(() => { throw new Error("Setting getters must not run"); });
  Object.defineProperty(part, kind === "switch" ? "initiallyClosed" : "resistanceOhms", { get: getter, enumerable: true });

  render();

  if (kind === "switch") { expect(container.querySelector('[data-part-id="part"]')?.getAttribute("aria-invalid")).toBe("true"); }
  else { expect(container.querySelector(".circuit-board__part-detail")?.textContent).toBe("— Ω"); }
  expect(getter).not.toHaveBeenCalled();
});
