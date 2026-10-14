// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWireWaypoints } from "../../circuit-edit.js";
import { GRID, moveWireSegment, routeDocumentWires, routeEnd, type Point } from "../../circuit-geometry.js";
import { MAX_CIRCUIT_WIRE_WAYPOINTS, type CircuitDocument } from "../../circuit-model.js";
import { serializeCircuitDocument } from "../../circuit-serialization.js";
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

function largeDocument(): CircuitDocument {
  return {
    title: "maximum manual route",
    parts: [
      { id: "left", kind: "junction", x: 0, y: 0, label: "left" },
      { id: "right", kind: "junction", x: 10_002, y: 10_002, label: "right" },
    ],
    wires: [{
      id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" },
      waypoints: Array.from({ length: MAX_CIRCUIT_WIRE_WAYPOINTS }, (_, index) => ({ x: index + 1, y: index + 1 })),
    }],
  };
}

/** Renders two SVG elements; route persistence runs through the actual headless editing API. */
function mount(initial: CircuitDocument, segmentIndex: number) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const errors: string[] = [];
  let latest = initial;
  let replaceDocument: ((next: CircuitDocument) => void) | undefined;
  function Harness() {
    const [circuit, setCircuit] = useState(initial);
    replaceDocument = setCircuit;
    const svgRef = useRef<SVGSVGElement | null>(null);
    latest = circuit;
    const drag = useWireRouteDrag({
      document: circuit,
      routes: routeDocumentWires(circuit),
      enabled: true,
      svgRef,
      pointAtPointer: (event) => ({ x: event.clientX / GRID, y: event.clientY / GRID }),
      onChange: (id, waypoints) => {
        const result = setWireWaypoints(circuit, id, waypoints);
        if (result.ok) { setCircuit(result.document); }
        else { errors.push(result.reason); }
      },
      onDrag: () => {},
      onFinish: () => {},
    });
    return (
      // biome-ignore lint/a11y/useSemanticElements: The hook handles pointer events on an SVG surface.
      <svg ref={svgRef} role="group" aria-label="route harness" onPointerMove={drag.move} onPointerUp={drag.finish}>
        {/* biome-ignore lint/a11y/useSemanticElements: The hook handles keyboard and pointer events on SVG route handles. */}
        <g role="button" tabIndex={0} aria-label="move segment" onPointerDown={(event) => drag.start(event, "wire", segmentIndex)} onKeyDown={(event) => drag.keyDown(event, "wire", segmentIndex)} />
      </svg>
    );
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  const surface = container.querySelector("svg")!;
  const handle = container.querySelector("g")!;
  return {
    surface, handle, errors,
    replaceDocument(next: CircuitDocument) { act(() => replaceDocument?.(next)); },
    get document() { return latest; },
  };
}

function pointer(target: Element, type: string, point: Point) {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: point.x * GRID, clientY: point.y * GRID,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
}

function key(target: Element, value: string) {
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}

function movedRoute(document: CircuitDocument, index: number, delta: number) {
  const route = routeDocumentWires(document).get("wire")!;
  const from = route[index]!;
  const to = route[index + 1]!;
  const coordinate = (from.y === to.y ? from.y : from.x) + delta;
  return moveWireSegment(route, index, coordinate, routeEnd(document.parts[0]!, "a"), routeEnd(document.parts[1]!, "a"));
}

describe("manual route persistence", () => {
  it("discards an old drag after an external document change without restoring old waypoints", () => {
    const initial: CircuitDocument = {
      title: "original",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "left" },
        { id: "right", kind: "junction", x: 8, y: 0, label: "right" },
      ],
      wires: [{ id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 0, y: 1 }, { x: 8, y: 1 }] }],
    };
    const ui = mount(initial, 1);
    pointer(ui.handle, "pointerdown", { x: 4, y: 1 });
    pointer(ui.surface, "pointermove", { x: 4, y: 2 });
    const replacement: CircuitDocument = {
      ...initial,
      title: "replacement",
      parts: initial.parts.map((part) => ({ ...part, x: part.x + 20, y: part.y + 20 })),
      wires: initial.wires.map((wire) => ({ ...wire, waypoints: [{ x: 20, y: 21 }, { x: 28, y: 21 }] })),
    };
    ui.replaceDocument(replacement);
    pointer(ui.surface, "pointermove", { x: 4, y: 3 });
    pointer(ui.surface, "pointerup", { x: 4, y: 3 });

    expect(ui.document).toBe(replacement);
    expect(ui.errors).toEqual([]);
  });

  it("saves a pointer move on a maximum-size route and restores its original stored points on return", () => {
    const initial = largeDocument();
    const ui = mount(initial, 1000);
    const route = routeDocumentWires(initial).get("wire")!;
    const origin = { x: (route[1000]!.x + route[1001]!.x) / 2, y: route[1000]!.y };
    pointer(ui.handle, "pointerdown", origin);
    pointer(ui.surface, "pointermove", { x: origin.x, y: origin.y + 1 });

    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(movedRoute(initial, 1000, 1));
    expect(() => serializeCircuitDocument(ui.document)).not.toThrow();
    expect(initial.wires[0]?.waypoints).toHaveLength(MAX_CIRCUIT_WIRE_WAYPOINTS);

    pointer(ui.surface, "pointermove", origin);
    pointer(ui.surface, "pointerup", origin);
    expect(ui.errors).toEqual([]);
    expect(ui.document.wires[0]?.waypoints).toEqual(initial.wires[0]?.waypoints);
  });

  it("saves a keyboard move on a maximum-size route with exactly the moved geometry", () => {
    const initial = largeDocument();
    const ui = mount(initial, 1000);
    key(ui.handle, "ArrowDown");

    expect(ui.errors).toEqual([]);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual(movedRoute(initial, 1000, 1));
    expect(() => serializeCircuitDocument(ui.document)).not.toThrow();
  });

  it("keeps a moved straight segment manual when automatic routing would avoid an earlier wire", () => {
    const initial: CircuitDocument = {
      title: "straight manual route",
      parts: [
        { id: "left", kind: "junction", x: 0, y: 0, label: "left" },
        { id: "right", kind: "junction", x: 8, y: 0, label: "right" },
        { id: "far", kind: "junction", x: 10, y: 0, label: "far" },
      ],
      wires: [
        { id: "occupied", from: { partId: "left", terminal: "a" }, to: { partId: "far", terminal: "a" } },
        { id: "wire", from: { partId: "left", terminal: "a" }, to: { partId: "right", terminal: "a" }, waypoints: [{ x: 0, y: 1 }, { x: 8, y: 1 }] },
      ],
    };
    const ui = mount(initial, 1);
    key(ui.handle, "ArrowUp");

    expect(ui.errors).toEqual([]);
    expect(ui.document.wires[1]?.waypoints?.length).toBeGreaterThan(0);
    expect(routeDocumentWires(ui.document).get("wire")).toEqual([{ x: 0, y: 0 }, { x: 8, y: 0 }]);
  });
});
