// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { GRID, routeDocumentWires, type Point } from "../../circuit-geometry.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const firstJunction = { id: "junction-a", kind: "junction" as const, x: 5, y: 5, label: "接続点A" };
const secondJunction = { id: "junction-b", kind: "junction" as const, x: 15, y: 5, label: "接続点B" };

function fixture(waypoints?: Point[]): CircuitDocument {
  return {
    title: "導線経路",
    parts: [firstJunction, secondJunction],
    wires: [{
      id: "wire-1",
      from: { partId: firstJunction.id, terminal: "a" },
      to: { partId: secondJunction.id, terminal: "a" },
      ...(waypoints ? { waypoints } : {}),
    }],
  };
}

const mount = setupEditorHarness();

function required(container: ParentNode, selector: string): Element {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function click(target: Element) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
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

function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture",
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

function screenPointForCell(container: ParentNode, point: Point) {
  const surface = required(container, ".circuit-board__surface") as SVGSVGElement;
  const viewBox = (surface.getAttribute("viewBox") ?? "0 0 960 560").split(/\s+/).map(Number);
  const [left = 0, top = 0, viewWidth = 960, viewHeight = 560] = viewBox;
  const rect = surface.getBoundingClientRect();
  const width = rect.width || Number(surface.getAttribute("width")) || 960;
  const height = rect.height || Number(surface.getAttribute("height")) || 560;
  return {
    x: rect.left + (point.x * GRID - left) * width / viewWidth,
    y: rect.top + (point.y * GRID - top) * height / viewHeight,
  };
}

function pointerDrag(
  container: ParentNode,
  target: Element,
  start: Point,
  end: Point,
  pointerId = 1,
) {
  pointer(target, "pointerdown", screenPointForCell(container, start), pointerId);
  const surface = required(container, ".circuit-board__surface");
  pointer(surface, "pointermove", screenPointForCell(container, end), pointerId);
  pointer(surface, "pointerup", screenPointForCell(container, end), pointerId);
}

function routeFor(document: CircuitDocument): Point[] {
  const route = routeDocumentWires(document).get("wire-1");
  if (!route) { throw new Error("Missing wire route"); }
  return route;
}

function isOrthogonalRoute(route: Point[]) {
  for (let index = 1; index < route.length; index += 1) {
    const before = route[index - 1];
    const after = route[index];
    if (!before || !after) { throw new Error("Missing route point"); }
    if (before.x !== after.x && before.y !== after.y) { return false; }
  }
  return true;
}

describe("Circuit wire route editing", () => {
  it("moves the nearest straight wire segment by dragging its body and keeps both endpoints fixed", () => {
    const initial = fixture();
    const ui = mount(initial);
    const originalRoute = routeFor(initial);
    const start = originalRoute[0];
    const end = originalRoute.at(-1);
    if (!start || !end) { throw new Error("Expected a straight route with two endpoints"); }

    pointerDrag(
      ui.container,
      required(ui.container, '[data-wire-id="wire-1"]'),
      { x: 10, y: 5 },
      { x: 10, y: 7 },
      21,
    );

    const movedRoute = routeFor(ui.editor.document);
    expect(ui.editor.selection).toEqual({ parts: [], wires: ["wire-1"] });
    expect(movedRoute[0]).toEqual(start);
    expect(movedRoute.at(-1)).toEqual(end);
    expect(movedRoute).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 7 },
      { x: 15, y: 7 },
      { x: 15, y: 5 },
    ]);
    expect(isOrthogonalRoute(movedRoute)).toBe(true);

    click(required(ui.container, '[aria-label="自動配線に戻す"]'));
    expect(ui.editor.document.wires[0]?.waypoints).toBeUndefined();
    expect(routeFor(ui.editor.document)).toEqual(originalRoute);
  });

  it("groups multiple pointer moves into one undoable route drag", () => {
    const initial = fixture();
    const ui = mount(initial);
    const wire = required(ui.container, '[data-wire-id="wire-1"]');
    const surface = required(ui.container, ".circuit-board__surface");
    const start = screenPointForCell(ui.container, { x: 10, y: 5 });
    const middle = screenPointForCell(ui.container, { x: 10, y: 6 });
    const end = screenPointForCell(ui.container, { x: 10, y: 7 });

    pointer(wire, "pointerdown", start, 61);
    pointer(surface, "pointermove", middle, 61);
    pointer(surface, "pointermove", end, 61);
    pointer(surface, "pointerup", end, 61);
    const draggedDocument = ui.editor.document;
    expect(routeFor(draggedDocument)).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 7 },
      { x: 15, y: 7 },
      { x: 15, y: 5 },
    ]);

    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(initial);
    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document).toEqual(draggedDocument);
  });

  it("keeps redo available when a route drag returns to its starting coordinate", () => {
    const initial = fixture();
    const ui = mount(initial);
    act(() => ui.editor.updatePart(firstJunction.id, { label: "接続点Aを編集" }));
    const redoDocument = ui.editor.document;
    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canRedo).toBe(true);

    const wire = required(ui.container, '[data-wire-id="wire-1"]');
    const surface = required(ui.container, ".circuit-board__surface");
    const start = screenPointForCell(ui.container, { x: 10, y: 5 });
    const moved = screenPointForCell(ui.container, { x: 10, y: 7 });
    pointer(wire, "pointerdown", start, 62);
    pointer(surface, "pointermove", moved, 62);
    pointer(surface, "pointermove", start, 62);
    pointer(surface, "pointerup", start, 62);

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canRedo).toBe(true);
    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document).toEqual(redoDocument);
  });

  it("restores redo history when Escape cancels a route drag", () => {
    const initial = fixture();
    const ui = mount(initial);
    act(() => ui.editor.updatePart(firstJunction.id, { label: "接続点Aを編集" }));
    const redoDocument = ui.editor.document;
    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canRedo).toBe(true);

    const wire = required(ui.container, '[data-wire-id="wire-1"]');
    const surface = required(ui.container, ".circuit-board__surface");
    const start = screenPointForCell(ui.container, { x: 10, y: 5 });
    const moved = screenPointForCell(ui.container, { x: 10, y: 7 });
    pointer(wire, "pointerdown", start, 63);
    pointer(surface, "pointermove", moved, 63);
    expect(ui.editor.document).not.toEqual(initial);
    keyDown(required(ui.container, ".circuit-board__viewport"), "Escape");

    expect(ui.editor.document).toEqual(initial);
    expect(ui.editor.canRedo).toBe(true);
    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document).toEqual(redoDocument);
  });

  it.each([
    ["horizontal", 1, { x: 10, y: 3 }, { x: 14, y: 2 }, "y", 2],
    ["vertical", 0, { x: 5, y: 4 }, { x: 4, y: 6 }, "x", 4],
  ] as const)("drags a selected %s segment handle along its perpendicular axis", (_orientation, segmentIndex, start, end, axis, movedCoordinate) => {
    const ui = mount(fixture([{ x: 5, y: 3 }, { x: 15, y: 3 }]));
    const originalRoute = routeFor(ui.editor.document);
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const handle = required(
      ui.container,
      `.circuit-board__wire-segment-handle[data-wire-id="wire-1"][data-segment-index="${segmentIndex}"]`,
    );

    pointerDrag(ui.container, handle, start, end, 22);

    const movedRoute = routeFor(ui.editor.document);
    expect(movedRoute[0]).toEqual(originalRoute[0]);
    expect(movedRoute.at(-1)).toEqual(originalRoute.at(-1));
    expect(movedRoute.some((point) => point[axis] === movedCoordinate)).toBe(true);
    expect(isOrthogonalRoute(movedRoute)).toBe(true);
    expect(ui.editor.selection).toEqual({ parts: [], wires: ["wire-1"] });
  });

  it("moves a selected segment with arrow keys and undoes or redoes the route as one edit", () => {
    const initial = fixture([{ x: 5, y: 3 }, { x: 15, y: 3 }]);
    const ui = mount(initial);
    const originalRoute = routeFor(initial);
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const middleHandle = required(
      ui.container,
      '.circuit-board__wire-segment-handle[data-wire-id="wire-1"][data-segment-index="1"]',
    );

    keyDown(middleHandle, "ArrowDown");

    const movedRoute = routeFor(ui.editor.document);
    expect(movedRoute[0]).toEqual(originalRoute[0]);
    expect(movedRoute.at(-1)).toEqual(originalRoute.at(-1));
    expect(movedRoute).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 15, y: 4 },
      { x: 15, y: 5 },
    ]);
    expect(isOrthogonalRoute(movedRoute)).toBe(true);
    const editedDocument = ui.editor.document;

    click(required(ui.container, '[aria-label="元に戻す"]'));
    expect(ui.editor.document).toEqual(initial);
    click(required(ui.container, '[aria-label="やり直す"]'));
    expect(ui.editor.document).toEqual(editedDocument);
  });

  it("keeps focus on route handles so arrow-key adjustments can be repeated", () => {
    const ui = mount(fixture());
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const initialHandle = required(
      ui.container,
      '.circuit-board__wire-segment-handle[data-wire-id="wire-1"][data-segment-index="0"]',
    );

    keyDown(initialHandle, "ArrowDown");
    const focusedAfterFirstMove = document.activeElement;
    expect(focusedAfterFirstMove).not.toBeNull();
    expect((focusedAfterFirstMove as Element).getAttribute("data-wire-id")).toBe("wire-1");
    expect((focusedAfterFirstMove as Element).getAttribute("data-segment-index")).toBe("1");

    keyDown(focusedAfterFirstMove as Element, "ArrowDown");

    expect(routeFor(ui.editor.document)).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 7 },
      { x: 15, y: 7 },
      { x: 15, y: 5 },
    ]);
    expect((document.activeElement as Element).getAttribute("data-wire-id")).toBe("wire-1");
    expect((document.activeElement as Element).getAttribute("data-segment-index")).toBe("1");
  });

  it.each(["pointercancel", "lostpointercapture", "Escape"] as const)("restores the original route after %s", (cancelType) => {
    const initial = fixture([{ x: 5, y: 3 }, { x: 15, y: 3 }]);
    const ui = mount(initial);
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const handle = required(
      ui.container,
      '.circuit-board__wire-segment-handle[data-wire-id="wire-1"][data-segment-index="1"]',
    );
    const from = screenPointForCell(ui.container, { x: 10, y: 3 });
    const to = screenPointForCell(ui.container, { x: 10, y: 2 });
    pointer(handle, "pointerdown", from, 31);
    pointer(required(ui.container, ".circuit-board__surface"), "pointermove", to, 31);
    expect(ui.editor.document).not.toEqual(initial);

    if (cancelType === "Escape") {
      keyDown(required(ui.container, ".circuit-board__viewport"), "Escape");
    } else {
      pointer(required(ui.container, ".circuit-board__surface"), cancelType, to, 31);
    }

    expect(ui.editor.document).toEqual(initial);
  });

  it("rolls back an active wire route edit when a touch pinch begins", () => {
    const initial = fixture([{ x: 5, y: 3 }, { x: 15, y: 3 }]);
    const ui = mount(initial);
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const handle = required(
      ui.container,
      '.circuit-board__wire-segment-handle[data-wire-id="wire-1"][data-segment-index="1"]',
    );
    const surface = required(ui.container, ".circuit-board__surface");
    const from = screenPointForCell(ui.container, { x: 10, y: 3 });
    const to = screenPointForCell(ui.container, { x: 10, y: 2 });
    pointer(handle, "pointerdown", from, 41, "touch");
    pointer(surface, "pointermove", to, 41, "touch");
    expect(ui.editor.document).not.toEqual(initial);

    pointer(surface, "pointerdown", { x: from.x - 30, y: from.y }, 42, "touch");

    expect(ui.editor.document).toEqual(initial);
  });

  it("hides route handles while the editor is in preview", () => {
    const ui = mount(fixture([{ x: 5, y: 3 }, { x: 15, y: 3 }]));
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    expect(ui.container.querySelector(".circuit-board__wire-segment-handle")).not.toBeNull();

    click(required(ui.container, ".circuit-editor__preview-toggle"));

    expect(ui.container.querySelector(".circuit-board__wire-segment-handle")).toBeNull();
    expect(required(ui.container, '[data-wire-id="wire-1"]').getAttribute("data-route-editable")).toBe("false");
  });

  it("does not start a route edit while Space temporarily activates pan", () => {
    const initial = fixture([{ x: 5, y: 3 }, { x: 15, y: 3 }]);
    const ui = mount(initial);
    click(required(ui.container, '[data-wire-id="wire-1"]'));
    const viewport = required(ui.container, ".circuit-board__viewport");
    const handle = required(
      ui.container,
      '.circuit-board__wire-segment-handle[data-wire-id="wire-1"][data-segment-index="1"]',
    );
    keyDown(viewport, " ");
    pointerDrag(ui.container, handle, { x: 10, y: 3 }, { x: 10, y: 2 }, 51);

    expect(ui.editor.document).toEqual(initial);
  });
});
