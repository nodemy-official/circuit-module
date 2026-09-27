// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID } from "../circuit-geometry.js";
import { createExampleCircuit, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { CircuitBoard, type CircuitBoardControls, type CircuitBoardProps } from "./CircuitBoard.js";

class MockResizeObserver implements ResizeObserver {
  static observers: MockResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.observers.push(this);
  }

  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() {}

  trigger() {
    this.callback([], this);
  }
}

const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
const cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
const mountedBoards: Array<{ root: Root; container: HTMLElement }> = [];
let pendingFrame: FrameRequestCallback | null = null;

beforeEach(() => {
  MockResizeObserver.observers = [];
  pendingFrame = null;
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: MockResizeObserver });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { pendingFrame = callback; return 1; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => { pendingFrame = null; } });
});

afterEach(() => {
  for (const { root, container } of mountedBoards.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  if (resizeObserverDescriptor) { Object.defineProperty(globalThis, "ResizeObserver", resizeObserverDescriptor); }
  else { Reflect.deleteProperty(globalThis, "ResizeObserver"); }
  if (actEnvironmentDescriptor) { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor); }
  else { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); }
  if (requestAnimationFrameDescriptor) { Object.defineProperty(globalThis, "requestAnimationFrame", requestAnimationFrameDescriptor); }
  else { Reflect.deleteProperty(globalThis, "requestAnimationFrame"); }
  if (cancelAnimationFrameDescriptor) { Object.defineProperty(globalThis, "cancelAnimationFrame", cancelAnimationFrameDescriptor); }
  else { Reflect.deleteProperty(globalThis, "cancelAnimationFrame"); }
});

const cameraDocument: CircuitDocument = {
  title: "カメラ確認",
  parts: [{ id: "battery", kind: "battery", x: 0, y: 0, label: "電池", voltageVolts: 9, internalResistanceOhms: 0 }],
  wires: [],
};

const widerCameraDocument: CircuitDocument = {
  ...cameraDocument,
  parts: [...cameraDocument.parts, { id: "far-junction", kind: "junction", x: 22, y: 0, label: "接続点" }],
};

const selectionDocument: CircuitDocument = {
  title: "複数選択確認",
  parts: [
    { id: "part-a", kind: "resistor", x: 0, y: 0, label: "抵抗A", resistanceOhms: 10 },
    { id: "part-b", kind: "resistor", x: 6, y: 0, label: "抵抗B", resistanceOhms: 10 },
    { id: "part-c", kind: "resistor", x: 12, y: 0, label: "抵抗C", resistanceOhms: 10 },
  ],
  wires: [
    { id: "wire-ab", from: { partId: "part-a", terminal: "b" }, to: { partId: "part-b", terminal: "a" } },
    { id: "wire-bc", from: { partId: "part-b", terminal: "b" }, to: { partId: "part-c", terminal: "a" } },
  ],
};

const junctionDocument: CircuitDocument = {
  ...selectionDocument,
  parts: [...selectionDocument.parts, { id: "junction", kind: "junction", x: 18, y: 5, label: "分岐" }],
};

function mountCameraBoard(initialDocument: CircuitDocument, initialFitOnResize?: boolean) {
  let viewportSize = { width: 200, height: 200 };
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  const renderBoard = (nextDocument: CircuitDocument, fitOnResize = initialFitOnResize) => root.render(
    <CircuitBoard document={nextDocument} {...(fitOnResize === undefined ? {} : { fitOnResize })} />,
  );
  act(() => renderBoard(initialDocument));
  const viewport = container.querySelector<HTMLElement>(".circuit-board__viewport");
  if (!viewport) { throw new Error("CircuitBoard viewport is missing"); }
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => viewportSize.width },
    clientHeight: { configurable: true, get: () => viewportSize.height },
  });
  const observer = MockResizeObserver.observers.at(-1);
  if (!observer) { throw new Error("ResizeObserver was not created"); }
  act(() => observer.trigger());
  mountedBoards.push({ root, container });

  return {
    container,
    render(nextDocument: CircuitDocument, fitOnResize?: boolean) {
      act(() => renderBoard(nextDocument, fitOnResize));
    },
    resize(width: number, height: number) {
      viewportSize = { width, height };
      act(() => observer.trigger());
    },
  };
}

function mountBoard(initialDocument: CircuitDocument, props: Omit<CircuitBoardProps, "document"> = {}) {
  const viewportSize = { width: 200, height: 200 };
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  const currentProps = { ...props };
  const render = () => root.render(<CircuitBoard document={initialDocument} renderControls={null} {...currentProps} />);
  act(() => render());
  const viewport = container.querySelector<HTMLElement>(".circuit-board__viewport");
  if (!viewport) { throw new Error("CircuitBoard viewport is missing"); }
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => viewportSize.width },
    clientHeight: { configurable: true, get: () => viewportSize.height },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ x: 40, y: 30, left: 40, top: 30, right: 240, bottom: 230, width: 200, height: 200, toJSON() {} }),
    },
  });
  const observer = MockResizeObserver.observers.at(-1);
  if (!observer) { throw new Error("ResizeObserver was not created"); }
  act(() => observer.trigger());
  mountedBoards.push({ root, container });
  return {
    container,
    viewport,
    update(nextProps: Partial<Omit<CircuitBoardProps, "document">>) {
      Object.assign(currentProps, nextProps);
      act(() => render());
    },
  };
}

function requiredElement(container: ParentNode, selector: string): Element {
  const target = container.querySelector(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function zoomLabel(container: ParentNode) {
  return requiredElement(container, 'output[aria-label="拡大率"]').textContent;
}

function cameraViewBox(container: ParentNode) {
  const value = requiredElement(container, ".circuit-board__surface").getAttribute("viewBox");
  if (!value) { throw new Error("Camera viewBox is missing"); }
  const values = value.split(/\s+/).map(Number);
  if (values.length !== 4 || values.some((entry) => !Number.isFinite(entry))) { throw new Error("Camera viewBox is invalid"); }
  return { x: values[0] ?? 0, y: values[1] ?? 0, width: values[2] ?? 0, height: values[3] ?? 0 };
}

function clientAtGrid(container: ParentNode, point: { x: number; y: number }) {
  const viewport = requiredElement(container, ".circuit-board__viewport");
  const rect = viewport.getBoundingClientRect();
  const viewBox = cameraViewBox(container);
  const zoom = rect.width / viewBox.width;
  return {
    clientX: rect.left + (point.x * GRID - viewBox.x) * zoom,
    clientY: rect.top + (point.y * GRID - viewBox.y) * zoom,
  };
}

function dispatchPointer(target: EventTarget, type: string, options: MouseEventInit & { pointerId?: number; pointerType?: string }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...options });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: options.pointerId ?? 1 },
    pointerType: { configurable: true, value: options.pointerType ?? "mouse" },
  });
  act(() => target.dispatchEvent(event));
}

function dispatchClick(target: EventTarget, options: MouseEventInit = {}) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...options })));
}

function flushFrame() {
  const callback = pendingFrame;
  pendingFrame = null;
  if (callback) { act(() => callback(0)); }
}

function clickButton(container: ParentNode, selector: string) {
  act(() => requiredElement(container, selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function panRight(container: ParentNode) {
  act(() => requiredElement(container, ".circuit-board__viewport").dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    cancelable: true,
  })));
}

const document = createExampleCircuit();

describe("CircuitBoard appearance and composition", () => {
  it("renders an omitted switch state as the solver's closed catalog default", () => {
    const switchDocument: CircuitDocument = {
      title: "既定値のスイッチ",
      parts: [{ id: "switch", kind: "switch", x: 0, y: 0, label: "スイッチ" }],
      wires: [],
    };
    const analysis = analyzeCircuit(switchDocument);
    const markup = renderToStaticMarkup(
      <CircuitBoard document={switchDocument} analysis={analysis} readOnly onSwitchToggle={() => {}} />,
    );

    expect(analysis.parts.switch.switchClosed).toBe(true);
    expect(markup).toContain('aria-label="スイッチを開く"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('d="M -9 0 L 9 0"');
    expect(markup).not.toContain('d="M -9 0 L 7 -10"');
  });

  it("forwards host attributes and styles to the root and internal SVG/HTML elements", () => {
    const markup = renderToStaticMarkup(
      <CircuitBoard
        document={document}
        id="host-board"
        aria-label="My canvas"
        data-testid="canvas"
        className="host-root"
        style={{ width: "100%", color: "navy", "--circuit-board-accent": "purple" }}
        selection={{ parts: [document.parts[0].id], wires: [] }}
        slotProps={{
          root: { className: "host-root-slot", style: { color: "purple" } },
          viewport: { className: "host-viewport", style: { height: 420 } },
          surface: { style: { touchAction: "none" } },
          partLabel: { className: "host-label", style: { fontSize: 24, fill: "purple" } },
          symbol: { style: { stroke: "red", strokeWidth: 4 } },
          bulbGlass: { style: { fill: "pink", "--circuit-board-bulb-opacity": 0.8 } },
        }}
      />,
    );

    expect(markup).toContain('id="host-board"');
    expect(markup).toContain('aria-label="My canvas"');
    expect(markup).toContain('data-testid="canvas"');
    expect(markup).toContain('class="circuit-board host-root host-root-slot"');
    expect(markup).toContain('style="width:100%;color:purple;--circuit-board-accent:purple"');
    expect(markup).toContain('class="circuit-board__viewport host-viewport" style="height:420px"');
    expect(markup).toMatch(/style="[^"]*touch-action:none/);
    expect(markup).toContain('class="circuit-board__part-label host-label" style="font-size:24px;fill:purple"');
    expect(markup).toContain('style="stroke:red;stroke-width:4"');
    expect(markup).toContain('--circuit-board-bulb-opacity:0.8;fill:pink');
    expect(markup).toContain(`data-part-id="${document.parts[0].id}" data-kind="battery" data-selected="true"`);
  });

  it("allows hosts to supply or omit the entire toolbar without a fixed wrapper", () => {
    const toolbar = vi.fn((controls: CircuitBoardControls) => (
      <nav data-host-toolbar="true">
        <button type="button" onClick={controls.zoomIn} disabled={!controls.canZoomIn}>Zoom {controls.zoom}</button>
      </nav>
    ));
    const markup = renderToStaticMarkup(<CircuitBoard document={document} renderControls={toolbar} />);

    expect(markup).toContain('<nav data-host-toolbar="true">');
    expect(markup).not.toContain("circuit-board__chrome");
    expect(toolbar).toHaveBeenCalledWith(expect.objectContaining({
      zoom: 1,
      showGrid: true,
      setShowGrid: expect.any(Function),
      resetZoom: expect.any(Function),
      fit: expect.any(Function),
    }));
    const withoutToolbar = renderToStaticMarkup(<CircuitBoard document={document} renderControls={null} />);
    expect(withoutToolbar).not.toContain("circuit-board__controls");
    expect(withoutToolbar).toContain("circuit-board__viewport");
  });

  it("accepts host-rendered part art while preserving selection and terminal controls", () => {
    const renderPart = vi.fn((part: CircuitPart, selected: boolean) => <rect data-host-part={part.id} data-active={selected} width={20} height={20} />);
    const markup = renderToStaticMarkup(
      <CircuitBoard document={document} selection={{ parts: [document.parts[0].id], wires: [] }} renderPart={renderPart} />,
    );

    expect(renderPart).toHaveBeenCalledWith(document.parts[0], true);
    expect(markup).toContain(`data-host-part="${document.parts[0].id}" data-active="true"`);
    expect(markup).not.toContain('class="circuit-board__symbol"');
    expect(markup).toContain('class="circuit-board__terminal');
  });
});

describe("CircuitBoard fitOnResize", () => {
  it("refits to the latest circuit on resize while preserving manual camera changes until then", () => {
    const ui = mountCameraBoard(cameraDocument, true);
    expect(zoomLabel(ui.container)).toBe("77%");

    clickButton(ui.container, '[aria-label="拡大"]');
    panRight(ui.container);
    expect(zoomLabel(ui.container)).toBe("96%");
    const manuallyAdjustedCamera = cameraViewBox(ui.container);

    ui.render(widerCameraDocument);
    expect(cameraViewBox(ui.container)).toEqual(manuallyAdjustedCamera);

    ui.resize(400, 200);
    expect(zoomLabel(ui.container)).toBe("61%");
  });

  it("fits immediately when enabled after mount", () => {
    const ui = mountCameraBoard(cameraDocument);
    clickButton(ui.container, '[aria-label="拡大"]');
    ui.render(widerCameraDocument);
    expect(zoomLabel(ui.container)).toBe("96%");

    ui.render(widerCameraDocument, true);
    expect(zoomLabel(ui.container)).toBe("30%");
  });

  it("keeps the existing centered zoom behavior when fitOnResize is omitted", () => {
    const ui = mountCameraBoard(cameraDocument);
    clickButton(ui.container, '[aria-label="拡大"]');
    panRight(ui.container);
    const before = cameraViewBox(ui.container);

    ui.resize(400, 250);
    const after = cameraViewBox(ui.container);

    expect(zoomLabel(ui.container)).toBe("96%");
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2);
  });
});

describe("CircuitBoard selection and board gestures", () => {
  it("passes additive modifiers once for part clicks and preserves an existing selection during drag", () => {
    const onSelectPart = vi.fn();
    const onMovePart = vi.fn();
    const ui = mountBoard(selectionDocument, {
      selection: { parts: ["part-a"], wires: [] },
      onSelectPart,
      onMovePart,
    });
    const partB = requiredElement(ui.container, '[data-part-id="part-b"]');
    const partA = requiredElement(ui.container, '[data-part-id="part-a"]');
    const pointB = clientAtGrid(ui.container, { x: 6, y: 0 });
    dispatchPointer(partB, "pointerdown", { ...pointB, button: 0, ctrlKey: true });
    dispatchPointer(requiredElement(ui.container, ".circuit-board__surface"), "pointerup", { ...pointB, button: 0 });
    dispatchClick(requiredElement(ui.container, ".circuit-board__surface"), { ctrlKey: true });
    expect(onSelectPart.mock.calls).toEqual([["part-b", true]]);

    ui.update({ selection: { parts: ["part-a", "part-b"], wires: [] } });
    const selectedPartB = requiredElement(ui.container, '[data-part-id="part-b"]');
    dispatchPointer(selectedPartB, "pointerdown", { ...pointB, button: 0, shiftKey: true });
    dispatchPointer(requiredElement(ui.container, ".circuit-board__surface"), "pointerup", { ...pointB, button: 0 });
    dispatchClick(requiredElement(ui.container, ".circuit-board__surface"), { shiftKey: true });
    expect(onSelectPart.mock.calls).toEqual([["part-b", true], ["part-b", true]]);
    ui.update({ selection: { parts: ["part-a"], wires: [] } });

    const startA = clientAtGrid(ui.container, { x: 0, y: 0 });
    const endA = clientAtGrid(ui.container, { x: 1, y: 0 });
    dispatchPointer(partA, "pointerdown", { ...startA, button: 0, shiftKey: true });
    dispatchPointer(requiredElement(ui.container, ".circuit-board__surface"), "pointerup", { ...startA, button: 0 });
    dispatchClick(requiredElement(ui.container, ".circuit-board__surface"), { shiftKey: true });
    expect(onSelectPart.mock.calls).toEqual([["part-b", true], ["part-b", true], ["part-a", true]]);

    dispatchPointer(partA, "pointerdown", { ...startA, button: 0 });
    dispatchPointer(requiredElement(ui.container, ".circuit-board__surface"), "pointermove", { ...endA, button: 0 });
    dispatchPointer(requiredElement(ui.container, ".circuit-board__surface"), "pointerup", { ...endA, button: 0 });
    expect(onSelectPart.mock.calls).toEqual([["part-b", true], ["part-b", true], ["part-a", true]]);
    expect(onMovePart).toHaveBeenCalledWith("part-a", 1, 0);
  });

  it("selects enclosed part centers and only wires whose complete routes fit, as an additive Shift range", () => {
    const onSelectRange = vi.fn();
    const onBoardClick = vi.fn();
    const ui = mountBoard(selectionDocument, {
      onSelectRange,
      onBoardClick,
      slotProps: { selectionRect: { className: "host-selection-rect" } },
    });
    const background = requiredElement(ui.container, "[data-circuit-board-background]");
    const surface = requiredElement(ui.container, ".circuit-board__surface");
    const before = cameraViewBox(ui.container);
    const start = clientAtGrid(ui.container, { x: -1, y: -1 });
    const end = clientAtGrid(ui.container, { x: 7, y: 1 });

    dispatchPointer(background, "pointerdown", { ...start, button: 0, shiftKey: true });
    dispatchPointer(surface, "pointermove", { ...end, button: 0 });
    const rectangle = ui.container.querySelector<SVGRectElement>("[data-selection-rect]");
    expect(rectangle).not.toBeNull();
    expect(rectangle?.classList.contains("host-selection-rect")).toBe(true);
    expect(rectangle?.getAttribute("width")).toBe(String(8 * GRID));
    dispatchPointer(surface, "pointerup", { ...end, button: 0 });
    dispatchClick(background, { shiftKey: true });

    expect(onSelectRange).toHaveBeenCalledOnce();
    expect(onSelectRange).toHaveBeenCalledWith({ parts: ["part-a", "part-b"], wires: ["wire-ab"] }, true);
    expect(onBoardClick).not.toHaveBeenCalled();
    expect(cameraViewBox(ui.container)).toEqual(before);
  });

  it("keeps plain blank-area dragging as pan and does not turn it into a range selection", () => {
    const onSelectRange = vi.fn();
    const onBoardClick = vi.fn();
    const ui = mountBoard(selectionDocument, { onSelectRange, onBoardClick });
    const background = requiredElement(ui.container, "[data-circuit-board-background]");
    const surface = requiredElement(ui.container, ".circuit-board__surface");
    const before = cameraViewBox(ui.container);
    const point = clientAtGrid(ui.container, { x: 5, y: 5 });

    dispatchPointer(background, "pointerdown", { ...point, button: 0 });
    dispatchPointer(surface, "pointermove", { ...point, clientX: point.clientX + 40, clientY: point.clientY + 12, button: 0 });
    flushFrame();
    dispatchPointer(surface, "pointerup", { ...point, clientX: point.clientX + 40, clientY: point.clientY + 12, button: 0 });
    dispatchClick(background);

    expect(cameraViewBox(ui.container).x).toBeLessThan(before.x);
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(onBoardClick).not.toHaveBeenCalled();
  });

  it.each([
    ["hand tool", { panMode: true }],
    ["read-only mode", { readOnly: true }],
  ])("keeps Shift-drag panning in %s", (_label, mode) => {
    const onSelectRange = vi.fn();
    const ui = mountBoard(selectionDocument, { ...mode, onSelectRange });
    const background = requiredElement(ui.container, "[data-circuit-board-background]");
    const surface = requiredElement(ui.container, ".circuit-board__surface");
    const before = cameraViewBox(ui.container);
    const point = clientAtGrid(ui.container, { x: 5, y: 5 });

    dispatchPointer(background, "pointerdown", { ...point, button: 0, shiftKey: true });
    dispatchPointer(surface, "pointermove", { ...point, clientX: point.clientX + 40, button: 0, shiftKey: true });
    flushFrame();
    dispatchPointer(surface, "pointerup", { ...point, clientX: point.clientX + 40, button: 0, shiftKey: true });

    expect(cameraViewBox(ui.container).x).toBeLessThan(before.x);
    expect(onSelectRange).not.toHaveBeenCalled();
  });

  it("keeps Space and middle-button gestures as pan", () => {
    const onSelectRange = vi.fn();
    const ui = mountBoard(selectionDocument, { onSelectRange });
    const background = requiredElement(ui.container, "[data-circuit-board-background]");
    const surface = requiredElement(ui.container, ".circuit-board__surface");
    const viewport = requiredElement(ui.container, ".circuit-board__viewport");
    const before = cameraViewBox(ui.container);
    const point = clientAtGrid(ui.container, { x: 5, y: 5 });

    act(() => viewport.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })));
    dispatchPointer(background, "pointerdown", { ...point, button: 0, shiftKey: true });
    dispatchPointer(surface, "pointermove", { ...point, clientX: point.clientX + 30, button: 0, shiftKey: true });
    flushFrame();
    dispatchPointer(surface, "pointerup", { ...point, clientX: point.clientX + 30, button: 0, shiftKey: true });
    act(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true })));
    expect(cameraViewBox(ui.container).x).toBeLessThan(before.x);

    const beforeMiddle = cameraViewBox(ui.container);
    dispatchPointer(background, "pointerdown", { ...point, button: 1, shiftKey: true });
    dispatchPointer(surface, "pointermove", { ...point, clientX: point.clientX + 30, button: 1, shiftKey: true });
    flushFrame();
    dispatchPointer(surface, "pointerup", { ...point, clientX: point.clientX + 30, button: 1, shiftKey: true });

    expect(cameraViewBox(ui.container).x).toBeLessThan(beforeMiddle.x);
    expect(onSelectRange).not.toHaveBeenCalled();
  });

  it("cancels an in-progress board gesture when a second touch starts a pinch", () => {
    const onSelectRange = vi.fn();
    const ui = mountBoard(selectionDocument, { onSelectRange });
    const background = requiredElement(ui.container, "[data-circuit-board-background]");
    const surface = requiredElement(ui.container, ".circuit-board__surface");
    const before = cameraViewBox(ui.container);
    const first = clientAtGrid(ui.container, { x: 5, y: 5 });
    const second = clientAtGrid(ui.container, { x: 7, y: 5 });

    dispatchPointer(background, "pointerdown", { ...first, pointerId: 1, pointerType: "touch", button: 0 });
    dispatchPointer(background, "pointerdown", { ...second, pointerId: 2, pointerType: "touch", button: 0, shiftKey: true });
    dispatchPointer(surface, "pointermove", { ...second, clientX: second.clientX + 30, pointerId: 2, pointerType: "touch", button: 0 });
    flushFrame();
    dispatchPointer(surface, "pointerup", { ...first, pointerId: 1, pointerType: "touch", button: 0 });
    dispatchPointer(surface, "pointerup", { ...second, clientX: second.clientX + 30, pointerId: 2, pointerType: "touch", button: 0 });

    expect(cameraViewBox(ui.container).width).toBeLessThan(before.width);
    expect(onSelectRange).not.toHaveBeenCalled();
  });

  it("keeps all selected parts selected when an arrow key moves one of them", () => {
    const onSelectPart = vi.fn();
    const onMovePart = vi.fn();
    const ui = mountBoard(selectionDocument, {
      selection: { parts: ["part-a", "part-b"], wires: [] },
      onSelectPart,
      onMovePart,
    });
    const partA = requiredElement(ui.container, '[data-part-id="part-a"]');

    act(() => partA.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));

    expect(onSelectPart).not.toHaveBeenCalled();
    expect(onMovePart).toHaveBeenCalledWith("part-a", 1, 0);
  });

  it("routes a wire click to its nearest route point while a connection is pending", () => {
    const onBoardClick = vi.fn();
    const onSelectWire = vi.fn();
    const ui = mountBoard(selectionDocument, {
      pendingEndpoint: { partId: "part-c", terminal: "b" },
      onBoardClick,
      onSelectWire,
    });
    const wire = requiredElement(ui.container, '[data-wire-id="wire-ab"]');
    const point = clientAtGrid(ui.container, { x: 3, y: 0 });

    dispatchClick(wire, point);

    expect(onBoardClick).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(onSelectWire).not.toHaveBeenCalled();
  });

  it("passes Ctrl/Meta selection modifiers to the wire callback", () => {
    const onSelectWire = vi.fn();
    const ui = mountBoard(selectionDocument, { onSelectWire });
    const wire = requiredElement(ui.container, '[data-wire-id="wire-ab"]');

    dispatchClick(wire, { metaKey: true });

    expect(onSelectWire).toHaveBeenCalledWith("wire-ab", true);
  });

  it("selects a junction through its center terminal on modifier click and keyboard activation", () => {
    const onSelectPart = vi.fn();
    const onTerminalClick = vi.fn();
    const ui = mountBoard(junctionDocument, { onSelectPart, onTerminalClick });
    const terminal = requiredElement(ui.container, '[data-part-id="junction"][data-terminal="a"]');
    const surface = requiredElement(ui.container, ".circuit-board__surface");
    const point = clientAtGrid(ui.container, { x: 18, y: 5 });

    dispatchPointer(terminal, "pointerdown", { ...point, button: 0, shiftKey: true });
    dispatchPointer(surface, "pointerup", { ...point, button: 0, shiftKey: true });
    dispatchClick(terminal, { shiftKey: true });
    act(() => terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    dispatchClick(terminal, { detail: 0 });

    expect(onSelectPart.mock.calls).toEqual([["junction", true], ["junction", true]]);
    expect(onTerminalClick).not.toHaveBeenCalled();

    dispatchClick(terminal);
    act(() => terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    dispatchClick(terminal, { detail: 0 });
    expect(onTerminalClick).toHaveBeenCalledWith({ partId: "junction", terminal: "a" });
    expect(onTerminalClick).toHaveBeenCalledTimes(2);
  });
});
