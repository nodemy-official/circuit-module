// @vitest-environment jsdom
import { act, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWireRoute } from "../../circuit-edit.js";
import { GRID, MAX_WIRE_COORDINATE, routeDocumentWires, terminalPoint } from "../../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_ROUTE_ANCHORS, type CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../../circuit-serialization.js";
import { CircuitBoard, type CircuitBoardControls } from "../CircuitBoard.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { useCircuitEditor, type CircuitEditorController } from "../useCircuitEditor.js";
import { useWireRouteDrag } from "../useWireRouteDrag.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(content: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(content));
  mounted.push({ root, container });
  return { container, render: (next: ReactNode) => act(() => root.render(next)) };
}

function fixture(): CircuitDocument {
  return {
    title: "境界付近の保存経路",
    parts: [
      { id: "source", kind: "resistor", x: 0, y: MAX_WIRE_COORDINATE, rotation: 90, label: "R" },
      { id: "target", kind: "junction", x: 10, y: MAX_WIRE_COORDINATE - 10, label: "J" },
    ],
    wires: [{
      id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
      routeAnchors: [{ x: 0, y: 3, yBoundary: 1 }, { x: 10, y: 3, yBoundary: 1 }],
    }],
  };
}

function expectedRoute(height: number) {
  return [
    { x: 0, y: MAX_WIRE_COORDINATE + 2 },
    { x: 0, y: MAX_WIRE_COORDINATE + height },
    { x: 10, y: MAX_WIRE_COORDINATE + height },
    { x: 10, y: MAX_WIRE_COORDINATE - 10 },
  ];
}

function mountEditor(initial: CircuitDocument) {
  let latest: CircuitEditorController | undefined;
  const ui = mount(<CircuitEditor initialDocument={initial}>{(editor) => {
    latest = editor;
    return <CircuitInspector wire={editor.document.wires[0]} onResetWireRoute={() => editor.resetWireRoute("wire")} />;
  }}</CircuitEditor>);
  return {
    ...ui,
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

function mountDrag(initial: CircuitDocument, yOffset = MAX_WIRE_COORDINATE, segmentIndex = 1) {
  let latest = initial;
  const errors: string[] = [];
  function Harness() {
    const [document, setDocument] = useState(initial);
    latest = document;
    const svgRef = useRef<SVGSVGElement | null>(null);
    const drag = useWireRouteDrag({
      document, routes: routeDocumentWires(document), enabled: true, svgRef,
      // Pointer event coordinates are native 32-bit pixel values. Map a small local
      // viewport to the large world coordinates instead of overflowing that input.
      pointAtPointer: (event) => ({ x: event.clientX / GRID, y: yOffset + event.clientY / GRID }),
      onChange: (id, points) => {
        const result = setWireRoute(document, id, points);
        if (result.ok) { setDocument(result.document); }
        else { errors.push(result.reason); }
      },
      onDrag: () => {}, onFinish: () => {},
    });
    return (
      // biome-ignore lint/a11y/useSemanticElements: SVG route handles expose the pointer interaction under test.
      <svg ref={svgRef} role="group" aria-label="route" onPointerMove={drag.move} onPointerUp={drag.finish} onPointerCancel={() => drag.cancel()}>
        {/* biome-ignore lint/a11y/useSemanticElements: The draggable handle belongs to an SVG route. */}
        <g role="button" tabIndex={0} aria-label="move" onPointerDown={(event) => drag.start(event, "wire", segmentIndex)} onKeyDown={(event) => drag.keyDown(event, "wire", segmentIndex)} />
      </svg>
    );
  }
  const ui = mount(<Harness />);
  return { ...ui, errors, get document() { return latest; } };
}

function mountControllerDrag(initial: CircuitDocument, segmentIndex: number) {
  let latest: CircuitEditorController | undefined;
  function Harness() {
    const editor = useCircuitEditor(initial);
    latest = editor;
    const svgRef = useRef<SVGSVGElement | null>(null);
    const drag = useWireRouteDrag({
      document: editor.document, documentVersion: editor.getDocumentVersion,
      routes: routeDocumentWires(editor.document), enabled: true, svgRef,
      pointAtPointer: (event) => ({ x: event.clientX / GRID, y: MAX_WIRE_COORDINATE + event.clientY / GRID }),
      onChange: editor.updateWireRoute, onCancel: editor.cancelWireRoute, onEnd: editor.endEdit,
      onDrag: () => {}, onFinish: () => {},
    });
    return (
      // biome-ignore lint/a11y/useSemanticElements: SVG route handles expose the pointer interaction under test.
      <svg ref={svgRef} role="group" aria-label="controller route" onPointerMove={drag.move} onPointerUp={drag.finish}>
        {/* biome-ignore lint/a11y/useSemanticElements: The draggable handle belongs to an SVG route. */}
        <g role="button" tabIndex={0} aria-label="move" onPointerDown={(event) => drag.start(event, "wire", segmentIndex)} />
      </svg>
    );
  }
  const ui = mount(<Harness />);
  return {
    ...ui,
    get editor() {
      if (!latest) { throw new Error("Missing editor"); }
      return latest;
    },
  };
}

function dispatchPointer(target: Element, type: string, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 5 * GRID, clientY: y * GRID });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function pointer(target: Element, type: string, y: number) {
  act(() => dispatchPointer(target, type, y));
}

describe("boundary routes in the optional UI", () => {
  it.each(["separate", "batched"] as const)("preserves route semantics and history after a promoted drag returns and moves again (%s)", (updates) => {
    const y = MAX_WIRE_COORDINATE;
    const ui = mountControllerDrag({
      title: "復帰直後に再移動する経路",
      parts: [
        { id: "source", kind: "resistor", x: 0, y, label: "R" },
        { id: "target", kind: "junction", x: 10, y: y - 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        waypoints: [{ x: 1, y }, { x: 1, y: y - 5 }, { x: 10, y: y - 5 }],
      }],
    }, 2);
    const before = ui.editor.document;
    const originalRoute = routeDocumentWires(before).get("wire");
    const handle = ui.container.querySelector("g")!;
    const surface = ui.container.querySelector("svg")!;
    expect(ui.editor.canUndo).toBe(false);
    pointer(handle, "pointerdown", 2);
    pointer(surface, "pointermove", 4);
    expect(ui.editor.document.wires[0]!.routeAnchors?.length).toBeGreaterThan(0);
    expect(ui.editor.error).toBeNull();

    if (updates === "batched") {
      // The controller restores historyRef immediately, while the hook's props
      // still describe the promoted explicit route until this act commits.
      act(() => {
        dispatchPointer(surface, "pointermove", 2);
        dispatchPointer(surface, "pointermove", 1);
      });
    } else {
      pointer(surface, "pointermove", 2);
      pointer(surface, "pointermove", 1);
    }
    pointer(surface, "pointerup", 1);

    const after = ui.editor.document;
    expect(ui.editor.error).toBeNull();
    expect(after.wires[0]).toEqual({
      ...before.wires[0],
      waypoints: [{ x: 3, y }, { x: 0, y }, { x: 1, y }, { x: 10, y: y - 5 }],
    });
    expect(after.wires[0]).not.toHaveProperty("routeAnchors");
    expect(routeDocumentWires(after).get("wire")).toEqual([
      { x: 2, y }, { x: 3, y }, { x: 3, y: y + 1 }, { x: 0, y: y + 1 },
      { x: 0, y }, { x: 1, y }, { x: 1, y: y - 5 }, { x: 10, y: y - 5 }, { x: 10, y: y - 10 },
    ]);
    const saved = serializeCircuitDocument(after);
    expect(JSON.parse(saved).version).toBe(1);
    expect(parseCircuitDocument(saved)).toEqual({ ok: true, document: after });
    expect(ui.editor.canUndo).toBe(true);
    expect(ui.editor.canRedo).toBe(false);

    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(before);
    expect(routeDocumentWires(ui.editor.document).get("wire")).toEqual(originalRoute);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(after);
    expect(serializeCircuitDocument(ui.editor.document)).toBe(saved);
    expect(ui.editor.error).toBeNull();
  });

  it.each(["return", "cancel", "commit"] as const)("follows a legacy-to-explicit promotion throughout one drag (%s)", (finish) => {
    const y = MAX_WIRE_COORDINATE;
    const ui = mountDrag({
      title: "ドラッグ途中の保存形式変更",
      parts: [
        { id: "source", kind: "resistor", x: 0, y, label: "R" },
        { id: "target", kind: "junction", x: 10, y: y - 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        waypoints: [{ x: 3, y }, { x: 3, y: y - 5 }, { x: 0, y: y - 5 }, { x: 0, y: y - 1 }, { x: 10, y: y - 1 }],
      }],
    }, y, 4);
    const originalWire = structuredClone(ui.document.wires[0]);
    const before = routeDocumentWires(ui.document).get("wire");
    const handle = ui.container.querySelector("g")!;
    const surface = ui.container.querySelector("svg")!;
    pointer(handle, "pointerdown", -1);
    pointer(surface, "pointermove", 1);
    expect(ui.document.wires[0]!.routeAnchors?.length).toBeGreaterThan(0);
    pointer(surface, "pointermove", 0);
    const moved = [
      { x: 2, y }, { x: 3, y }, { x: 3, y: y - 5 }, { x: 0, y: y - 5 },
      { x: 0, y: y + 1 }, { x: 10, y: y + 1 }, { x: 10, y: y - 10 },
    ];
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(moved);
    if (finish === "return") {
      pointer(surface, "pointermove", -1);
      pointer(surface, "pointerup", -1);
    } else { pointer(surface, finish === "cancel" ? "pointercancel" : "pointerup", 0); }
    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(finish === "commit" ? moved : before);
    if (finish !== "commit") { expect(ui.document.wires[0]).toEqual(originalWire); }
    expect(parseCircuitDocument(serializeCircuitDocument(ui.document)).ok).toBe(true);
  });

  it.each(["return", "cancel"] as const)("restores automatic routing after a promoted drag (%s)", (finish) => {
    const y = MAX_WIRE_COORDINATE;
    const initial: CircuitDocument = {
      title: "自動配線の取消",
      parts: [
        { id: "source", kind: "resistor", x: 0, y, label: "R" },
        { id: "target", kind: "junction", x: 10, y: y - 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" } }],
    };
    const ui = mountDrag(initial, y, 0);
    const handle = ui.container.querySelector("g")!;
    const surface = ui.container.querySelector("svg")!;
    pointer(handle, "pointerdown", 0);
    pointer(surface, "pointermove", 2);
    expect(ui.document.wires[0]!.routeAnchors?.length).toBeGreaterThan(0);
    if (finish === "return") { pointer(surface, "pointermove", 0); }
    pointer(surface, finish === "cancel" ? "pointercancel" : "pointerup", finish === "cancel" ? 2 : 0);
    expect(ui.errors).toEqual([]);
    expect(ui.document.wires).toEqual(initial.wires);
    expect(JSON.parse(serializeCircuitDocument(ui.document)).version).toBe(1);
  });

  it.each(["return", "cancel"] as const)("restores the stored boundary offset without a decode/encode round trip (%s)", (finish) => {
    const x = MAX_WIRE_COORDINATE;
    const initial: CircuitDocument = {
      title: "境界差分の取消",
      parts: [
        { id: "source", kind: "resistor", x, y: 0, label: "R" },
        { id: "target", kind: "junction", x: x - 10, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        routeAnchors: [{ x: 4.001, y: 0, xBoundary: 1 }, { x: 4.001, y: 10, xBoundary: 1 }],
      }],
    };
    const before = serializeCircuitDocument(initial);
    const ui = mountDrag(initial, 0, 0);
    const handle = ui.container.querySelector("g")!;
    const surface = ui.container.querySelector("svg")!;
    pointer(handle, "pointerdown", 0);
    pointer(surface, "pointermove", 2);
    if (finish === "return") { pointer(surface, "pointermove", 0); }
    pointer(surface, finish === "cancel" ? "pointercancel" : "pointerup", finish === "cancel" ? 2 : 0);
    expect(ui.errors).toEqual([]);
    expect(ui.document.wires).toEqual(initial.wires);
    expect(serializeCircuitDocument(ui.document)).toBe(before);
  });

  it.each(["keyboard", "pointer"])("preserves a terminal detour during an explicit route %s edit", (operation) => {
    const ui = mountDrag({
      title: "端子を避ける明示経路",
      parts: [
        { id: "source", kind: "resistor", x: 0, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 10, y: 10, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        routeAnchors: [{ x: 3, y: 0 }, { x: 3, y: 5 }, { x: 0, y: 5 }, { x: 0, y: -1 }, { x: 10, y: -1 }],
      }],
    }, 0, 4);
    const handle = ui.container.querySelector("g")!;
    if (operation === "keyboard") {
      act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    } else {
      const surface = ui.container.querySelector("svg")!;
      pointer(handle, "pointerdown", -1);
      pointer(surface, "pointermove", 0);
      pointer(surface, "pointerup", 0);
    }
    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual([
      { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 0 },
      { x: 0, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    ]);
    expect(parseCircuitDocument(serializeCircuitDocument(ui.document)).ok).toBe(true);
  });

  it("rejects a property edit that exceeds the explicit route limit without changing history", () => {
    const corners = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
    const ui = mountEditor({
      title: "最大経路",
      parts: [
        { id: "source", kind: "resistor", x: -2, y: 0, label: "R" },
        { id: "target", kind: "junction", x: 10, y: 0, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" },
        routeAnchors: Array.from({ length: MAX_CIRCUIT_WIRE_ROUTE_ANCHORS }, (_, index) => ({ ...corners[index % 4]! })),
      }],
    });
    act(() => ui.editor.setTitle("redo"));
    act(() => ui.editor.undo());
    const before = ui.editor.document;
    const version = ui.editor.documentVersion;
    act(() => ui.editor.updatePart("source", { x: -3 }));
    expect(ui.editor.error).toContain(`${MAX_CIRCUIT_WIRE_ROUTE_ANCHORS}`);
    expect(ui.editor.document).toBe(before);
    expect(ui.editor.documentVersion).toBe(version);
    expect(ui.editor.canUndo).toBe(false);
    expect(ui.editor.canRedo).toBe(true);
    act(() => ui.editor.redo());
    expect(ui.editor.document.title).toBe("redo");
  });

  it.each(["move", "rotate", "combined"] as const)("repairs explicit endpoints after a property %s and preserves undo/redo", (operation) => {
    const ui = mountEditor(fixture());
    const before = ui.editor.document;
    const patch = operation === "move" ? { x: 2, y: MAX_WIRE_COORDINATE - 1 }
      : operation === "rotate" ? { rotation: 0 as const }
        : { x: 2, y: MAX_WIRE_COORDINATE - 1, rotation: 180 as const };
    act(() => ui.editor.updatePart("source", patch));
    expect(ui.editor.error).toBeNull();
    const after = ui.editor.document;
    expect(after).not.toBe(before);
    expect(after.parts[0]).toMatchObject(patch);
    const route = routeDocumentWires(after).get("wire")!;
    expect(route[0]).toEqual(terminalPoint(after.parts[0]!, "b"));
    expect(route.at(-1)).toEqual(terminalPoint(after.parts[1]!, "a"));
    expect(route.every((point, index) => !route[index + 1] || point.x === route[index + 1]!.x || point.y === route[index + 1]!.y)).toBe(true);
    const restored = parseCircuitDocument(ui.editor.exportDocument());
    expect(restored).toEqual({ ok: true, document: after });
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(before);
    act(() => ui.editor.redo());
    expect(ui.editor.document).toBe(after);
  });

  it("retains explicit route objects when updating an electrical property", () => {
    const ui = mountEditor(fixture());
    const before = ui.editor.document.wires[0];
    act(() => ui.editor.updatePart("source", { resistanceOhms: 20 }));
    expect(ui.editor.document.wires[0]).toBe(before);
    expect(parseCircuitDocument(ui.editor.exportDocument()).ok).toBe(true);
  });

  it("aligns potential colors and flow paths with a distant circuit", () => {
    const x = MAX_WIRE_COORDINATE - 20;
    const y = -MAX_WIRE_COORDINATE + 20;
    const document: CircuitDocument = {
      title: "境界の可視化",
      parts: [
        { id: "source", kind: "battery", x, y, label: "電源", voltageVolts: 9 },
        { id: "load", kind: "resistor", x: x + 8, y, label: "抵抗", resistanceOhms: 10 },
      ],
      wires: [
        { id: "supply", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "return", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("closed");
    let controls: CircuitBoardControls | undefined;
    const ui = mount(<CircuitBoard document={document} analysis={analysis} showFlow showPotentials renderControls={(next) => { controls = next; return null; }} />);
    act(controls!.fit);
    act(() => ui.container.querySelector<HTMLInputElement>(".circuit-potential__toggle input")!.click());
    const overlays = ui.container.querySelectorAll("[data-potential-wire]");
    expect(overlays).toHaveLength(2);
    for (const overlay of overlays) {
      const wire = ui.container.querySelector(`[data-wire-id="${overlay.getAttribute("data-potential-wire")}"] .circuit-board__wire-line`)!;
      expect(overlay.getAttribute("d")).toBe(wire.getAttribute("d"));
    }
    const terminals = ui.container.querySelectorAll("[data-potential-terminal]");
    expect(terminals.length).toBeGreaterThan(0);
    const particles = ui.container.querySelectorAll<SVGGElement>(".circuit-board__flow-particle");
    expect(particles.length).toBeGreaterThan(0);
    for (const value of [
      ...Array.from(terminals, (terminal) => terminal.getAttribute("transform")!),
      ...Array.from(particles, (particle) => particle.style.offsetPath),
    ]) {
      expect(value.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number).every((number) => Number.isFinite(number) && Math.abs(number) < 1_000_000), value).toBe(true);
    }
  });

  it("retains route handle focus while panning across a drawing origin boundary", () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
    const x = 1280 * 100 + 12;
    const document: CircuitDocument = {
      title: "原点をまたぐ移動",
      parts: [
        { id: "source", kind: "resistor", x, y: 0, label: "R" },
        { id: "target", kind: "junction", x: x + 10, y: 5, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" } }],
    };
    let controls: CircuitBoardControls | undefined;
    const ui = mount(<CircuitBoard document={document} selection={{ parts: [], wires: ["wire"] }} onWireRouteChange={() => {}}
      renderControls={(next) => { controls = next; return null; }} />);
    act(controls!.fit);
    const handle = ui.container.querySelector<SVGGElement>(".circuit-board__wire-segment-handle")!;
    handle.focus();
    expect(globalThis.document.activeElement).toBe(handle);
    const before = handle.getAttribute("transform");
    act(() => {
      ui.container.querySelector(".circuit-board__viewport")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: -10 }));
      frame?.(16);
    });
    expect(handle.isConnected).toBe(true);
    expect(globalThis.document.activeElement).toBe(handle);
    expect(handle.getAttribute("transform")).not.toBe(before);
  });

  it.each([
    { x: MAX_WIRE_COORDINATE - 20, y: 0 }, { x: -MAX_WIRE_COORDINATE + 20, y: 0 },
    { x: 0, y: MAX_WIRE_COORDINATE - 20 }, { x: 0, y: -MAX_WIRE_COORDINATE + 20 },
    { x: MAX_WIRE_COORDINATE - 20, y: -MAX_WIRE_COORDINATE + 20 },
  ])("renders a fitted circuit near ($x,$y) using small SVG coordinates", (offset) => {
    const document: CircuitDocument = {
      title: "遠い原点",
      parts: [
        { id: "source", kind: "resistor", x: offset.x, y: offset.y, label: "R" },
        { id: "target", kind: "junction", x: offset.x + 10, y: offset.y + 5, label: "J" },
      ],
      wires: [{ id: "wire", from: { partId: "source", terminal: "b" }, to: { partId: "target", terminal: "a" } }],
    };
    const before = serializeCircuitDocument(document);
    const renderedParts: unknown[] = [];
    let controls: CircuitBoardControls | undefined;
    const ui = mount(<CircuitBoard document={document} selection={{ parts: [], wires: ["wire"] }} onWireRouteChange={() => {}} onReconnectStart={() => {}}
      renderPart={(part) => { renderedParts.push(part); return <circle r="2" />; }}
      renderControls={(next) => { controls = next; return null; }} />);
    act(controls!.fit);
    const elements = ui.container.querySelectorAll("svg[viewBox], .circuit-board__part, .circuit-board__terminal, .circuit-board__wire-handle, .circuit-board__wire-segment-handle, .circuit-board__wire-line");
    for (const element of elements) {
      for (const attribute of ["viewBox", "transform", "d"]) {
        const value = element.getAttribute(attribute);
        if (!value) { continue; }
        const values = value.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
        expect(values.every((number) => Number.isFinite(number) && Math.abs(number) < 1_000_000), `${attribute}=${value}`).toBe(true);
      }
    }
    expect(renderedParts.every((part) => document.parts.includes(part as CircuitDocument["parts"][number]))).toBe(true);
    act(() => controls!.zoomIn());
    act(() => controls!.zoomOut());
    expect(serializeCircuitDocument(document)).toBe(before);
  });

  it("keeps background clicks in model coordinates after fitting a distant circuit", () => {
    const point = { x: 15, y: Math.trunc(MAX_WIRE_COORDINATE) - 20 };
    const document: CircuitDocument = { title: "遠い接続点", parts: [{ id: "node", kind: "junction", ...point, label: "J" }], wires: [] };
    const onBoardClick = vi.fn();
    let controls: CircuitBoardControls | undefined;
    const ui = mount(<CircuitBoard document={document} onBoardClick={onBoardClick} renderControls={(next) => { controls = next; return null; }} />);
    act(controls!.fit);
    const surface = ui.container.querySelector("svg.circuit-board__surface")!;
    const box = surface.getAttribute("viewBox")!.split(" ").map(Number);
    const transform = ui.container.querySelector(".circuit-board__part")!.getAttribute("transform")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const background = ui.container.querySelector("[data-circuit-board-background]")!;
    act(() => background.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, detail: 1,
      clientX: (transform[0]! - box[0]!) * 960 / box[2]!,
      clientY: (transform[1]! - box[1]!) * 560 / box[3]!,
    })));
    expect(onBoardClick).toHaveBeenCalledWith(point);
  });

  it("detaches initial anchor arrays before retaining editor history", () => {
    const initial = fixture();
    const ui = mountEditor(initial);
    initial.wires[0]!.routeAnchors![0]!.y = 20;
    expect(routeDocumentWires(ui.editor.document).get("wire")).toEqual(expectedRoute(3));

    act(() => ui.editor.setTitle("changed"));
    act(() => ui.editor.undo());
    expect(routeDocumentWires(ui.editor.document).get("wire")).toEqual(expectedRoute(3));
    const imported = parseCircuitDocument(ui.editor.exportDocument());
    if (!imported.ok) { throw new Error(imported.reason); }
    expect(routeDocumentWires(imported.document).get("wire")).toEqual(expectedRoute(3));
  });

  it("offers reset for encoded anchors and restores them with undo", () => {
    const initial = fixture();
    const ui = mountEditor(initial);
    const before = ui.editor.document;
    const button = ui.container.querySelector<HTMLButtonElement>('[aria-label="自動配線に戻す"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(ui.editor.document.wires[0]).not.toHaveProperty("routeAnchors");
    expect(ui.editor.document.wires[0]).not.toHaveProperty("waypoints");
    act(() => ui.editor.undo());
    expect(ui.editor.document).toBe(before);
    expect(routeDocumentWires(ui.editor.document).get("wire")).toEqual(expectedRoute(3));
  });

  it("invalidates cached SVG paths when a host changes an anchor in place", () => {
    const document = fixture();
    const ui = mount(<CircuitBoard document={document} readOnly />);
    const path = () => ui.container.querySelector(".circuit-board__wire-line")!.getAttribute("d");
    const before = path();
    for (const anchor of document.wires[0]!.routeAnchors!) { anchor.y = 4; }
    ui.render(<CircuitBoard document={document} readOnly />);
    expect(path()).not.toBe(before);
    expect(routeDocumentWires(document).get("wire")).toEqual(expectedRoute(4));
  });

  it("invalidates cached SVG paths when only a boundary marker changes", () => {
    const document = fixture();
    const ui = mount(<CircuitBoard document={document} readOnly />);
    const path = () => ui.container.querySelector(".circuit-board__wire-line")!.getAttribute("d");
    const before = path();
    for (const anchor of document.wires[0]!.routeAnchors!) { Reflect.deleteProperty(anchor, "yBoundary"); }
    ui.render(<CircuitBoard document={document} readOnly />);
    expect(path()).not.toBe(before);
  });

  it("persists keyboard moves on a boundary route", () => {
    const ui = mountDrag(fixture());
    const handle = ui.container.querySelector("g")!;
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(expectedRoute(4));
    expect(() => serializeCircuitDocument(ui.document)).not.toThrow();
  });

  it.each(["return", "cancel", "commit"] as const)("preserves the original boundary representation on drag %s", (finish) => {
    const initial = fixture();
    const ui = mountDrag(initial);
    const handle = ui.container.querySelector("g")!;
    const surface = ui.container.querySelector("svg")!;
    pointer(handle, "pointerdown", 3);
    pointer(surface, "pointermove", 4);
    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(expectedRoute(4));
    if (finish === "return") {
      pointer(surface, "pointermove", 3);
      pointer(surface, "pointerup", 3);
    } else { pointer(surface, finish === "cancel" ? "pointercancel" : "pointerup", 4); }
    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(expectedRoute(finish === "commit" ? 4 : 3));
    const parsed = parseCircuitDocument(serializeCircuitDocument(ui.document));
    if (!parsed.ok) { throw new Error(parsed.reason); }
    expect(routeDocumentWires(parsed.document)).toEqual(routeDocumentWires(ui.document));
    expect(initial).toEqual(fixture());
  });
});
