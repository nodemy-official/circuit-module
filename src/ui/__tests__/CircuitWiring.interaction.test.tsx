// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { GRID, routeDocumentWires, terminalPoint } from "../../circuit-geometry.js";
import type { CircuitDocument, CircuitPart } from "../../circuit-model.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const battery: CircuitPart = { id: "battery", kind: "battery", x: 3, y: 5, label: "電池" };
const resistor: CircuitPart = { id: "resistor", kind: "resistor", x: 13, y: 5, label: "抵抗" };
const junction: CircuitPart = { id: "junction", kind: "junction", x: 23, y: 5, label: "接続点" };
const existingWire = {
  id: "wire-1",
  from: { partId: battery.id, terminal: "b" as const },
  to: { partId: resistor.id, terminal: "a" as const },
};

function fixture(withWire = false, rotation: 0 | 90 | 180 | 270 = 0, withJunction = true): CircuitDocument {
  return {
    title: "",
    parts: [battery, { ...resistor, rotation }, ...(withJunction ? [junction] : [])],
    wires: withWire ? [existingWire] : [],
  };
}

const mount = setupEditorHarness();

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function keyDown(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key === " " ? "Space" : key,
      bubbles: true,
      cancelable: true,
    }));
  });
}

function keyUpWindow(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", {
      key,
      code: key === " " ? "Space" : key,
      bubbles: true,
      cancelable: true,
    }));
  });
}

function clickAt(target: Element, point: { x: number; y: number }) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      detail: 1,
    }));
  });
}

function required(container: ParentNode, selector: string): Element {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function terminal(container: ParentNode, partId: string, terminalName: "a" | "b" = "a"): Element {
  return required(container, `[data-part-id="${partId}"][data-terminal="${terminalName}"]`);
}

function clickTerminal(container: ParentNode, partId: string, terminalName: "a" | "b" = "a") {
  click(required(terminal(container, partId, terminalName), ".circuit-board__terminal-hit"));
}

function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  point: { x: number; y: number },
  pointerId = 1,
  pointerType = "mouse",
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: pointerType },
    isPrimary: { configurable: true, value: true },
  });
  act(() => target.dispatchEvent(event));
}

function screenPointForWorld(container: ParentNode, point: { x: number; y: number }) {
  const surface = required(container, ".circuit-board__surface") as SVGSVGElement;
  const viewBox = (surface.getAttribute("viewBox") ?? "0 0 960 560").split(/\s+/).map(Number);
  const [left = 0, top = 0, viewWidth = 960, viewHeight = 560] = viewBox;
  const rect = surface.getBoundingClientRect();
  const width = rect.width || Number(surface.getAttribute("width")) || 960;
  const height = rect.height || Number(surface.getAttribute("height")) || 560;
  return {
    x: rect.left + (point.x - left) * width / viewWidth,
    y: rect.top + (point.y - top) * height / viewHeight,
  };
}

function screenPointForTerminal(container: ParentNode, part: CircuitPart, terminalName: "a" | "b") {
  const point = terminalPoint(part, terminalName);
  return screenPointForWorld(container, { x: point.x * GRID, y: point.y * GRID });
}

function longestRouteMidpoint(document: CircuitDocument, wireId: string) {
  const route = routeDocumentWires(document).get(wireId);
  if (!route || route.length < 2) { throw new Error(`Missing route: ${wireId}`); }
  let longest = 0;
  let midpoint = route[0];
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    if (!start || !end) { continue; }
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longest) {
      longest = length;
      midpoint = { x: Math.round((start.x + end.x) / 2), y: Math.round((start.y + end.y) / 2) };
    }
  }
  if (!midpoint) { throw new Error(`Missing route midpoint: ${wireId}`); }
  return midpoint;
}

function pointerDrag(
  container: ParentNode,
  from: Element,
  fromPoint: { x: number; y: number },
  toPoint: { x: number; y: number },
  pointerId = 1,
  pointerType = "mouse",
) {
  pointer(from, "pointerdown", fromPoint, pointerId, pointerType);
  const surface = required(container, ".circuit-board__surface");
  pointer(surface, "pointermove", toPoint, pointerId, pointerType);
  pointer(surface, "pointerup", toPoint, pointerId, pointerType);
}

describe("Circuit wiring interactions", () => {
  it("shows keyboard-accessible wire handles and reconnects one end as one undoable edit", () => {
    const initial = fixture(true);
    const ui = mount(initial);
    click(required(ui.container, '[data-wire-id="wire-1"]'));

    const fromHandle = required(ui.container, '[data-wire-id="wire-1"][data-wire-handle="from"]');
    expect(ui.container.querySelector('[data-wire-id="wire-1"][data-wire-handle="to"]')).not.toBeNull();
    keyDown(fromHandle, "Enter");
    expect(ui.editor.pendingWire).toEqual({ wireId: "wire-1", end: "from" });
    expect(ui.editor.pendingEndpoint).toEqual({ partId: resistor.id, terminal: "a" });

    clickTerminal(ui.container, junction.id);
    const reconnected = ui.editor.document;
    expect(reconnected.wires).toEqual([{
      id: "wire-1",
      from: { partId: junction.id, terminal: "a" },
      to: { partId: resistor.id, terminal: "a" },
    }]);
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.pendingEndpoint).toBeNull();

    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.container.querySelector('[aria-label="元に戻す"]')?.hasAttribute("disabled")).toBe(true);

    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document).toEqual(reconnected);
  });

  it("reconnects an existing wire by dragging its visible endpoint handle", () => {
    const ui = mount(fixture(true));
    click(required(ui.container, '[data-wire-id="wire-1"]'));

    const fromPoint = screenPointForTerminal(ui.container, battery, "b");
    const targetPoint = screenPointForTerminal(ui.container, junction, "a");
    pointerDrag(
      ui.container,
      required(ui.container, '[data-wire-id="wire-1"][data-wire-handle="from"]'),
      fromPoint,
      targetPoint,
      17,
    );

    expect(ui.editor.document.wires).toEqual([{
      id: "wire-1",
      from: { partId: junction.id, terminal: "a" },
      to: { partId: resistor.id, terminal: "a" },
    }]);
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.pendingEndpoint).toBeNull();
  });

  it("does not start reconnection from a wire handle while Space temporarily activates pan", () => {
    const ui = mount(fixture(true));
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const viewport = required(ui.container, ".circuit-board__viewport");
    const handle = required(ui.container, '[data-wire-id="wire-1"][data-wire-handle="from"]');

    keyDown(viewport, " ");
    click(handle);
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.pendingEndpoint).toBeNull();

    keyUpWindow(" ");
    click(required(ui.container, '[data-wire-id="wire-1"][data-wire-handle="from"]'));
    expect(ui.editor.pendingWire).toEqual({ wireId: "wire-1", end: "from" });
  });

  it("keeps the original wire and connection mode after an invalid reconnect, then cancels with Escape", () => {
    const initial = fixture(true);
    initial.wires.push({
      id: "wire-2",
      from: { partId: resistor.id, terminal: "a" },
      to: { partId: junction.id, terminal: "a" },
    });
    const ui = mount(initial);
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    click(required(ui.container, '[data-wire-id="wire-1"][data-wire-handle="from"]'));

    expect(ui.editor.pendingEndpoint).toEqual({ partId: resistor.id, terminal: "a" });
    clickTerminal(ui.container, junction.id, "a");

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingWire).toEqual({ wireId: "wire-1", end: "from" });
    expect(ui.editor.pendingEndpoint).toEqual({ partId: resistor.id, terminal: "a" });
    expect(ui.container.querySelector('[role="alert"]')).not.toBeNull();

    keyDown(required(ui.container, ".circuit-editor"), "Escape");
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.pendingEndpoint).toBeNull();
  });

  it("lets a newly added part drag a wire onto an existing wire and undo that connection once", () => {
    const initial = fixture(true, 0, false);
    const ui = mount(initial);
    click(required(ui.container, '[aria-label="抵抗を追加"]'));
    const addedPart = ui.editor.document.parts.find((part) => part.id !== battery.id && part.id !== resistor.id);
    if (!addedPart) { throw new Error("Expected the palette to add a resistor"); }
    const beforeConnection = ui.editor.document;
    const routeMidpoint = longestRouteMidpoint(beforeConnection, "wire-1");
    const start = screenPointForTerminal(ui.container, addedPart, "a");
    const target = screenPointForWorld(ui.container, { x: routeMidpoint.x * GRID, y: routeMidpoint.y * GRID });

    pointer(required(terminal(ui.container, addedPart.id), ".circuit-board__terminal-hit"), "pointerdown", start, 12);
    pointer(required(ui.container, ".circuit-board__surface"), "pointermove", target, 12);
    expect(ui.container.querySelector(".circuit-board__connection-target")).not.toBeNull();
    pointer(required(ui.container, ".circuit-board__surface"), "pointerup", target, 12);

    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.document.parts.filter((part) => part.kind === "junction")).toHaveLength(1);
    expect(ui.editor.document.wires).toHaveLength(3);
    expect(ui.editor.document.wires.some((wire) => wire.from.partId === addedPart.id || wire.to.partId === addedPart.id)).toBe(true);
    const connected = ui.editor.document;

    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(beforeConnection);
    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document).toEqual(connected);
  });

  it("branches an added part onto a wire when the wire itself is clicked during connection mode", () => {
    const ui = mount(fixture(true, 0, false));
    click(required(ui.container, '[aria-label="抵抗を追加"]'));
    const addedPart = ui.editor.document.parts.find((part) => part.id !== battery.id && part.id !== resistor.id);
    if (!addedPart) { throw new Error("Expected the palette to add a resistor"); }
    const beforeConnection = ui.editor.document;
    const midpoint = longestRouteMidpoint(beforeConnection, "wire-1");
    clickTerminal(ui.container, addedPart.id, "a");

    const clickPoint = screenPointForWorld(ui.container, {
      x: midpoint.x * GRID,
      y: (midpoint.y + 0.4) * GRID,
    });
    clickAt(required(ui.container, '[data-wire-id="wire-1"]'), clickPoint);

    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
    expect(ui.editor.document.parts.filter((part) => part.kind === "junction")).toHaveLength(1);
    expect(ui.editor.document.wires).toHaveLength(3);
    expect(ui.editor.document.wires.some((wire) => wire.from.partId === addedPart.id || wire.to.partId === addedPart.id)).toBe(true);

    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(beforeConnection);
  });

  it("discards a dragged connection on pointer cancellation without changing the circuit", () => {
    const initial = fixture();
    const ui = mount(initial);
    const source = terminal(ui.container, battery.id, "a");
    const from = screenPointForTerminal(ui.container, battery, "a");
    const away = { x: from.x + 80, y: from.y + 40 };

    pointer(required(source, ".circuit-board__terminal-hit"), "pointerdown", from, 23);
    pointer(required(ui.container, ".circuit-board__surface"), "pointermove", away, 23);
    expect(ui.editor.pendingEndpoint).toEqual({ partId: battery.id, terminal: "a" });
    pointer(required(ui.container, ".circuit-board__surface"), "pointercancel", away, 23);

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
  });

  it("suppresses the cancelled gesture click but lets the next pointer gesture select a wire", () => {
    const initial = fixture(true, 0, false);
    const ui = mount(initial);
    const wire = required(ui.container, '[data-wire-id="wire-1"]');
    const sourcePoint = screenPointForTerminal(ui.container, battery, "a");
    const away = { x: sourcePoint.x + 80, y: sourcePoint.y + 40 };
    const surface = required(ui.container, ".circuit-board__surface");

    pointer(required(terminal(ui.container, battery.id, "a"), ".circuit-board__terminal-hit"), "pointerdown", sourcePoint, 51);
    pointer(surface, "pointermove", away, 51);
    pointer(surface, "pointercancel", away, 51);
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingEndpoint).toBeNull();

    click(wire);
    expect(ui.editor.selection).toEqual({ parts: [], wires: [] });

    const nextGesturePoint = screenPointForWorld(ui.container, { x: 8 * GRID, y: 5 * GRID });
    pointer(wire, "pointerdown", nextGesturePoint, 52);
    pointer(surface, "pointerup", nextGesturePoint, 52);
    click(required(ui.container, '[data-wire-id="wire-1"]'));

    expect(ui.editor.selection).toEqual({ parts: [], wires: ["wire-1"] });
  });

  it("cancels a pending connection when a touch pinch starts", () => {
    const initial = fixture();
    const ui = mount(initial);
    clickTerminal(ui.container, battery.id, "a");
    expect(ui.editor.pendingEndpoint).toEqual({ partId: battery.id, terminal: "a" });

    const surface = required(ui.container, ".circuit-board__surface");
    pointer(surface, "pointerdown", { x: 320, y: 240 }, 41, "touch");
    pointer(surface, "pointerdown", { x: 380, y: 240 }, 42, "touch");

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
  });

  it("connects rotated terminals correctly after zooming in", () => {
    const rotatedResistor = { ...resistor, rotation: 90 as const };
    const ui = mount({ ...fixture(false, 90, false), parts: [battery, rotatedResistor], wires: [] });
    click(required(ui.container, '[aria-label="拡大"]'));
    expect(required(ui.container, 'output[aria-label="拡大率"]').textContent).toBe("125%");

    const sourcePoint = screenPointForTerminal(ui.container, rotatedResistor, "a");
    const targetPoint = screenPointForTerminal(ui.container, battery, "a");
    pointerDrag(
      ui.container,
      required(terminal(ui.container, rotatedResistor.id, "a"), ".circuit-board__terminal-hit"),
      sourcePoint,
      targetPoint,
      31,
    );

    expect(ui.editor.document.wires).toHaveLength(1);
    expect(ui.editor.document.wires[0]?.from).toEqual({ partId: rotatedResistor.id, terminal: "a" });
    expect(ui.editor.document.wires[0]?.to).toEqual({ partId: battery.id, terminal: "a" });
    expect(ui.editor.pendingEndpoint).toBeNull();
  });

  it.each([
    ["read-only", { readOnly: true }],
    ["pan", { panMode: true }],
  ] as const)("does not start a wire in %s mode", (_mode, boardProps) => {
    const initial = fixture(true);
    const ui = mount(initial, boardProps);
    clickTerminal(ui.container, battery.id, "a");

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.pendingEndpoint).toBeNull();
    expect(ui.editor.pendingWire).toBeNull();
    expect(required(ui.container, ".circuit-board__surface").getAttribute("data-connecting")).toBe("false");
  });
});
