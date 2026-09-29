// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "../../circuit-model.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitEditorLayout } from "../CircuitEditorLayout.js";
import type { CircuitEditorController } from "../useCircuitEditor.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media }));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function part(id: string, kind: CircuitPartKind, x: number, y: number, patch: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x, y, ...circuitPartCatalog[kind].defaults, ...patch };
}

function wire(id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) {
  return {
    id,
    from: { partId: from, terminal: fromTerminal },
    to: { partId: to, terminal: toTerminal },
  };
}

function meterCircuit({
  sourceKind = "battery",
  voltageVolts = 9,
  resistanceOhms = 30,
  reverseMeters = false,
  connectVoltmeter = true,
}: {
  sourceKind?: "battery" | "ac-source";
  voltageVolts?: number;
  resistanceOhms?: number;
  reverseMeters?: boolean;
  connectVoltmeter?: boolean;
} = {}): CircuitDocument {
  const source = sourceKind === "battery" ? "source" : "ac-source";
  const parts = [
    part(source, sourceKind, 4, 5, { voltageVolts }),
    part("ammeter", "ammeter", 8, 5),
    part("resistor", "resistor", 12, 5, { resistanceOhms }),
    part("switch", "switch", 16, 5, { initiallyClosed: true }),
    part("voltmeter", "voltmeter", 12, 10),
  ];
  const connections = [
    wire("w1", source, "a", "ammeter", reverseMeters ? "b" : "a"),
    wire("w2", "ammeter", reverseMeters ? "a" : "b", "resistor", "a"),
    wire("w3", "resistor", "b", "switch", "a"),
    wire("w4", "switch", "b", source, "b"),
  ];
  if (connectVoltmeter) {
    connections.push(
      wire("w5", "voltmeter", "a", "resistor", reverseMeters ? "b" : "a"),
      wire("w6", "voltmeter", "b", "resistor", reverseMeters ? "a" : "b"),
    );
  }
  return { title: "計器の確認", parts, wires: connections };
}

function shortCircuitWithAmmeter(): CircuitDocument {
  return {
    title: "電流計の短絡",
    parts: [part("source", "battery", 4, 5), part("ammeter", "ammeter", 8, 5)],
    wires: [wire("w1", "source", "a", "ammeter", "a"), wire("w2", "ammeter", "b", "source", "b")],
  };
}

function mount(initialDocument: CircuitDocument) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let controller: CircuitEditorController | undefined;
  act(() => root.render(
    <CircuitEditor initialDocument={initialDocument}>
      {(editor) => {
        controller = editor;
        return <CircuitEditorLayout />;
      }}
    </CircuitEditor>,
  ));
  mounted.push({ root, container });
  return {
    container,
    get editor() {
      if (!controller) { throw new Error("CircuitEditor did not render"); }
      return controller;
    },
  };
}

function required<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) { throw new Error(`Missing element: ${selector}`); }
  return element;
}

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function doubleClick(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
}

function changeNumber(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) { throw new Error("Missing input value setter"); }
  act(() => {
    setter.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function meterReading(container: ParentNode, partId: string, measurement: "current" | "voltage") {
  return required<SVGTextElement>(
    container,
    `.circuit-board__part[data-part-id="${partId}"] .circuit-board__meter-reading[data-measurement="${measurement}"]`,
  );
}

function readingText(container: ParentNode, partId: string, measurement: "current" | "voltage") {
  return meterReading(container, partId, measurement).textContent?.trim() ?? "";
}

function meterTitle(container: ParentNode, partId: string) {
  return required<SVGTitleElement>(container, `.circuit-board__part[data-part-id="${partId}"] > title`).textContent ?? "";
}

function previewInput(container: ParentNode, label: string) {
  return required<HTMLInputElement>(previewDialog(container), `[aria-label="${label}"]`);
}

function previewDialog(container: ParentNode): HTMLElement {
  return required<HTMLElement>(container, '.circuit-preview-dialog[role="dialog"]');
}

function openPreviewPart(container: ParentNode, partId: string) {
  doubleClick(required(container, `.circuit-board__part[data-part-id="${partId}"]`));
}

function closePreviewDialog(container: ParentNode) {
  const close = [...previewDialog(container).querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "回路に戻る");
  if (!close) { throw new Error("Missing preview dialog close button"); }
  click(close);
}

describe("CircuitEditorLayout meter readouts", () => {
  it("updates DC readings after document edits and preview value and switch changes", () => {
    const ui = mount(meterCircuit());
    expect(meterReading(ui.container, "ammeter", "current").getAttribute("data-meter-status")).toBe("connected");
    expect(readingText(ui.container, "ammeter", "current")).toContain("300 mA");
    expect(readingText(ui.container, "voltmeter", "voltage")).toContain("9 V");

    act(() => ui.editor.updatePart("source", { voltageVolts: 12 }));
    expect(readingText(ui.container, "ammeter", "current")).toContain("400 mA");
    expect(readingText(ui.container, "voltmeter", "voltage")).toContain("12 V");

    click(required(ui.container, '.circuit-editor__preview-toggle'));
    openPreviewPart(ui.container, "source");
    changeNumber(previewInput(ui.container, "電池の電源電圧"), "18");
    expect(readingText(ui.container, "ammeter", "current")).toContain("600 mA");
    expect(ui.editor.document.parts.find((item) => item.id === "source")?.voltageVolts).toBe(12);
    closePreviewDialog(ui.container);

    openPreviewPart(ui.container, "resistor");
    changeNumber(previewInput(ui.container, "抵抗の抵抗値"), "60");
    expect(readingText(ui.container, "ammeter", "current")).toContain("300 mA");
    expect(readingText(ui.container, "voltmeter", "voltage")).toContain("18 V");
    expect(ui.editor.document.parts.find((item) => item.id === "resistor")?.resistanceOhms).toBe(30);
    closePreviewDialog(ui.container);

    openPreviewPart(ui.container, "switch");
    const switchControl = required<HTMLElement>(previewDialog(ui.container), '[role="switch"]');
    click(switchControl);
    expect(readingText(ui.container, "ammeter", "current")).toMatch(/0(?:\.0+)?\s*(?:mA|A)/);
    expect(readingText(ui.container, "voltmeter", "voltage")).toMatch(/0(?:\.0+)?\s*V/);
    click(switchControl);
    expect(readingText(ui.container, "ammeter", "current")).toContain("300 mA");
    expect(readingText(ui.container, "voltmeter", "voltage")).toContain("18 V");
    expect(ui.editor.document.parts.find((item) => item.id === "switch")?.initiallyClosed).toBe(true);
  });

  it("shows signed DC readings when the meter polarities are reversed", () => {
    const ui = mount(meterCircuit({ reverseMeters: true }));
    expect(readingText(ui.container, "ammeter", "current")).toMatch(/[-−]\s*300 mA/);
    expect(readingText(ui.container, "voltmeter", "voltage")).toMatch(/[-−]\s*9 V/);
  });

  it("labels AC meter values as RMS readings", () => {
    const ui = mount(meterCircuit({ sourceKind: "ac-source" }));
    expect(readingText(ui.container, "ammeter", "current")).toContain("実効値");
    expect(readingText(ui.container, "ammeter", "current")).toContain("300 mA");
    expect(readingText(ui.container, "voltmeter", "voltage")).toContain("実効値");
    expect(readingText(ui.container, "voltmeter", "voltage")).toContain("9 V");
  });

  it("keeps AC voltmeter RMS magnitude and shifts its displayed phase by 180 degrees when A/B are swapped", () => {
    const forward = mount(meterCircuit({ sourceKind: "ac-source" }));
    const reversed = mount(meterCircuit({ sourceKind: "ac-source", reverseMeters: true }));
    const forwardValue = readingText(forward.container, "voltmeter", "voltage");
    const reversedValue = readingText(reversed.container, "voltmeter", "voltage");

    expect(forwardValue).toBe("9 V（実効値）");
    expect(reversedValue).toBe(forwardValue);
    expect(meterTitle(forward.container, "voltmeter")).toContain("電圧位相 0°");
    expect(meterTitle(reversed.container, "voltmeter")).toMatch(/電圧位相 [+−-]?180°/);
  });

  it("explains unconnected meters and short-circuit analysis failures", () => {
    const unconnected = mount(meterCircuit({ connectVoltmeter: false }));
    const floatingVoltage = meterReading(unconnected.container, "voltmeter", "voltage");
    expect(floatingVoltage.getAttribute("data-meter-status")).toBe("unconnected");
    expect(readingText(unconnected.container, "voltmeter", "voltage")).toContain("—");
    expect(readingText(unconnected.container, "voltmeter", "voltage")).toMatch(/未接続|接続されていません/);

    const shorted = mount(shortCircuitWithAmmeter());
    expect(readingText(shorted.container, "ammeter", "current")).toContain("—");
    expect(readingText(shorted.container, "ammeter", "current")).toContain("短絡");
  });
});
