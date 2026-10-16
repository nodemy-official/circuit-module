// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExampleCircuit } from "../../circuit-model.js";
import { CircuitBoard, type CircuitBoardProps } from "../CircuitBoard.js";

let root: Root;
let container: HTMLDivElement;
let animationFrame: FrameRequestCallback | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animationFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { animationFrame = undefined; });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renderBoard();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  animationFrame = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function required(selector: string) {
  const element = container.querySelector(selector);
  if (!element) { throw new Error(`Missing element: ${selector}`); }
  return element;
}

function renderBoard(props: Partial<CircuitBoardProps> = {}) {
  act(() => root.render(<CircuitBoard document={createExampleCircuit()} {...props} />));
}

function pointer(target: Element, type: string, x: number, pointerId = 1, options: { button?: number; pointerType?: string } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: options.button ?? 0 });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: options.pointerType ?? "mouse" },
  });
  act(() => target.dispatchEvent(event));
}

function flushFrame() {
  const callback = animationFrame;
  animationFrame = undefined;
  if (callback) { act(() => callback(0)); }
}

function capturePan(surface: Element, available: boolean) {
  let captured = false;
  Object.defineProperties(surface, {
    setPointerCapture: { configurable: true, value: () => {
      if (!available) { throw new Error("Pointer capture unavailable"); }
      captured = true;
    } },
    hasPointerCapture: { configurable: true, value: () => captured },
    releasePointerCapture: { configurable: true, value: () => {
      captured = false;
      pointer(surface, "lostpointercapture", 100);
    } },
  });
}

function click(target: Element, x = 100) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: 100 })));
}

describe("CircuitBoard captured background clicks", () => {
  it.each([false, true].flatMap((capture) =>
    ["plain", "connection to empty space", "connection near a terminal"].map((action) => ({ capture, action })),
  ))("handles $action once with pointer capture=$capture", ({ capture, action }) => {
    const onBoardClick = vi.fn();
    const onTerminalClick = vi.fn();
    renderBoard({
      onBoardClick, onTerminalClick,
      pendingEndpoint: action === "plain" ? null : { partId: "part-4", terminal: "a" },
    });
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    capturePan(surface, capture);
    const x = action === "connection near a terminal" ? 105 : 100;
    pointer(background, "pointerdown", x);
    pointer(capture ? surface : background, "pointerup", x);
    click(capture ? surface : background, x);
    if (action === "connection near a terminal") {
      expect(onTerminalClick.mock.calls).toEqual([[{ partId: "part-1", terminal: "a" }]]);
      expect(onBoardClick).not.toHaveBeenCalled();
    } else {
      expect(onBoardClick.mock.calls).toEqual([[{ x: 5, y: 5 }]]);
      expect(onTerminalClick).not.toHaveBeenCalled();
    }
  });

  it.each([false, true].flatMap((capture) =>
    ["drag", "Space", "hand tool", "cancelled"].map((gesture) => ({ capture, gesture })),
  ))("does not activate the background after $gesture with pointer capture=$capture", ({ capture, gesture }) => {
    const onBoardClick = vi.fn();
    const onTerminalClick = vi.fn();
    renderBoard({ onBoardClick, onTerminalClick, pendingEndpoint: { partId: "part-4", terminal: "a" }, panMode: gesture === "hand tool" });
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    capturePan(surface, capture);
    if (gesture === "Space") {
      act(() => surface.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })));
    }
    pointer(background, "pointerdown", 100);
    if (gesture === "drag") { pointer(surface, "pointermove", 140); }
    pointer(capture ? surface : background, gesture === "cancelled" ? "pointercancel" : "pointerup", 100);
    click(capture ? surface : background);
    expect(onBoardClick).not.toHaveBeenCalled();
    expect(onTerminalClick).not.toHaveBeenCalled();
  });
});

describe("CircuitBoard pan pointer capture", () => {
  it("ends panning when its pointer capture is lost", () => {
    const surface = required(".circuit-board__surface");
    pointer(required("[data-circuit-board-background]"), "pointerdown", 100);
    pointer(surface, "pointermove", 120);
    flushFrame();
    expect(surface.getAttribute("data-panning")).toBe("true");
    const viewBox = surface.getAttribute("viewBox");

    pointer(surface, "lostpointercapture", 120);
    expect(surface.getAttribute("data-panning")).toBe("false");
    pointer(surface, "pointermove", 180);
    flushFrame();
    expect(surface.getAttribute("viewBox")).toBe(viewBox);
  });

  it("keeps panning when another pointer loses capture", () => {
    const surface = required(".circuit-board__surface");
    pointer(required("[data-circuit-board-background]"), "pointerdown", 100);
    pointer(surface, "lostpointercapture", 100, 2);
    expect(surface.getAttribute("data-panning")).toBe("true");
    pointer(surface, "pointerup", 100);
    expect(surface.getAttribute("data-panning")).toBe("false");
  });

  it("suppresses a cancelled pan click and accepts a fresh click", () => {
    const onBoardClick = vi.fn();
    renderBoard({ onBoardClick });
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    pointer(background, "pointerdown", 100);
    pointer(surface, "lostpointercapture", 100);
    act(() => background.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onBoardClick).not.toHaveBeenCalled();

    pointer(background, "pointerdown", 100);
    pointer(surface, "pointerup", 100);
    act(() => background.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onBoardClick).toHaveBeenCalledOnce();
  });

  it("ends a pinch after capture loss and removes its lost touch from future gestures", () => {
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    const touch = { pointerType: "touch" };
    pointer(background, "pointerdown", 100, 1, touch);
    pointer(background, "pointerdown", 200, 2, touch);
    pointer(surface, "pointermove", 240, 2, touch);
    flushFrame();
    const viewBox = surface.getAttribute("viewBox");

    pointer(surface, "lostpointercapture", 240, 2, touch);
    pointer(surface, "pointermove", 80, 1, touch);
    flushFrame();
    expect(surface.getAttribute("viewBox")).toBe(viewBox);
    pointer(surface, "pointerup", 80, 1, touch);

    pointer(background, "pointerdown", 100, 3, touch);
    expect(surface.getAttribute("data-panning")).toBe("true");
    pointer(surface, "pointermove", 140, 3, touch);
    flushFrame();
    expect(surface.getAttribute("viewBox")?.split(" ").slice(2)).toEqual(viewBox?.split(" ").slice(2));
  });

  it("keeps pinching when an unrelated pointer loses capture", () => {
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    const touch = { pointerType: "touch" };
    pointer(background, "pointerdown", 100, 1, touch);
    pointer(background, "pointerdown", 200, 2, touch);
    const viewBox = surface.getAttribute("viewBox");
    pointer(surface, "lostpointercapture", 150, 3, touch);
    pointer(surface, "pointermove", 250, 2, touch);
    flushFrame();
    expect(surface.getAttribute("viewBox")).not.toBe(viewBox);
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"])("blocks additional touches until every pinch finger ends after %s", (end) => {
    const onSelectPart = vi.fn();
    const onMovePart = vi.fn();
    renderBoard({ onSelectPart, onMovePart });
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    const part = required('.circuit-board__part[data-kind="resistor"]');
    const touch = { pointerType: "touch" };
    pointer(background, "pointerdown", 100, 1, touch);
    pointer(background, "pointerdown", 200, 2, touch);
    pointer(part, "pointerdown", 150, 3, touch);
    expect(onSelectPart).not.toHaveBeenCalled();

    pointer(surface, end, 100, 1, touch);
    const viewBox = surface.getAttribute("viewBox");
    pointer(surface, "pointermove", 170, 3, touch);
    pointer(surface, "pointerup", 200, 2, touch);
    pointer(surface, "pointermove", 190, 3, touch);
    flushFrame();
    expect(surface.getAttribute("viewBox")).toBe(viewBox);
    expect(onMovePart).not.toHaveBeenCalled();
    pointer(part, "pointerdown", 150, 4, touch);
    pointer(surface, "pointerup", 190, 3, touch);
    pointer(surface, "pointermove", 190, 4, touch);
    expect(onSelectPart).not.toHaveBeenCalled();
    expect(onMovePart).not.toHaveBeenCalled();
    pointer(surface, "pointerup", 190, 4, touch);

    pointer(part, "pointerdown", 150, 5, touch);
    pointer(surface, "pointermove", 190, 5, touch);
    expect(onSelectPart).toHaveBeenCalledOnce();
    expect(onMovePart).toHaveBeenCalledOnce();
    pointer(surface, "pointerup", 190, 5, touch);
  });

  it("suppresses switch activation by an extra pinch finger and accepts a fresh touch", () => {
    const onSwitchToggle = vi.fn();
    renderBoard({ readOnly: true, onSwitchToggle });
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    const part = required('.circuit-board__part[data-kind="switch"]');
    const touch = { pointerType: "touch" };
    pointer(background, "pointerdown", 100, 1, touch);
    pointer(background, "pointerdown", 200, 2, touch);
    pointer(part, "pointerdown", 150, 3, touch);
    pointer(surface, "pointerup", 100, 1, touch);
    pointer(surface, "pointerup", 200, 2, touch);
    pointer(surface, "pointerup", 150, 3, touch);
    click(part, 150);
    expect(onSwitchToggle).not.toHaveBeenCalled();

    pointer(part, "pointerdown", 150, 4, touch);
    pointer(surface, "pointerup", 150, 4, touch);
    click(part, 150);
    expect(onSwitchToggle).toHaveBeenCalledOnce();
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"].flatMap((end) =>
    ["surface", "background"].flatMap((intermediateClick) => ["unsupported", "throws"].map((capture) => ({ end, intermediateClick, capture }))),
  ))("keeps suppressing every pinch click after $end and a click on $intermediateClick (capture=$capture)", ({ end, intermediateClick, capture }) => {
    vi.useFakeTimers();
    const onSwitchToggle = vi.fn();
    renderBoard({ readOnly: true, onSwitchToggle });
    const surface = required(".circuit-board__surface");
    const background = required("[data-circuit-board-background]");
    const part = required('.circuit-board__part[data-kind="switch"]');
    if (capture === "throws") { capturePan(surface, false); }
    const touch = { pointerType: "touch" };
    pointer(background, "pointerdown", 100, 1, touch);
    pointer(background, "pointerdown", 200, 2, touch);
    pointer(part, "pointerdown", 150, 3, touch);
    pointer(surface, end, 100, 1, touch);
    click(intermediateClick === "surface" ? surface : background);
    pointer(surface, "pointerup", 200, 2, touch);
    pointer(surface, end, 150, 3, touch);
    act(() => vi.advanceTimersByTime(100));
    click(part, 150);
    click(part, 150);
    expect(onSwitchToggle).not.toHaveBeenCalled();

    pointer(part, "pointerdown", 150, 4, touch);
    pointer(surface, "pointerup", 150, 4, touch);
    click(part, 150);
    expect(onSwitchToggle).toHaveBeenCalledOnce();
  });
});

describe("CircuitBoard panning over read-only switches", () => {
  it.each(["middle button", "Space", "hand tool"])("allows %s without toggling the switch", (gesture) => {
    const onSwitchToggle = vi.fn();
    renderBoard({ readOnly: true, onSwitchToggle, panMode: gesture === "hand tool" });
    const surface = required(".circuit-board__surface");
    const part = required('.circuit-board__part[data-kind="switch"]');
    const viewBox = surface.getAttribute("viewBox");
    if (gesture === "Space") {
      act(() => surface.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })));
    }
    const options = { button: gesture === "middle button" ? 1 : 0 };
    pointer(part, "pointerdown", 100, 1, options);
    pointer(surface, "pointermove", 140, 1, options);
    flushFrame();
    expect(surface.getAttribute("data-panning")).toBe("true");
    expect(surface.getAttribute("viewBox")).not.toBe(viewBox);
    pointer(surface, "pointerup", 140, 1, options);
    act(() => part.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onSwitchToggle).not.toHaveBeenCalled();
  });

  it.each(["Space", "hand tool"].flatMap((gesture) =>
    ["switch", "inspection", "switch with inspection"].flatMap((control) =>
      [0, 2].map((distance) => ({ gesture, control, distance }))),
  ))("does not activate $control after $gesture pan of $distance pixels", ({ gesture, control, distance }) => {
    vi.useFakeTimers();
    const onSwitchToggle = vi.fn();
    const onInspectPart = vi.fn();
    const controls = {
      onSwitchToggle: control === "inspection" ? undefined : onSwitchToggle,
      onInspectPart: control === "switch" ? undefined : onInspectPart,
    };
    renderBoard({ readOnly: true, ...controls, panMode: gesture === "hand tool" });
    const surface = required(".circuit-board__surface");
    const part = required(`.circuit-board__part[data-kind="${control === "inspection" ? "resistor" : "switch"}"]`);
    if (gesture === "Space") {
      act(() => surface.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })));
    }
    pointer(part, "pointerdown", 100);
    pointer(surface, "pointermove", 100 + distance);
    if (gesture === "Space") {
      // The gesture remains a pan even if Space is released before the pointer.
      act(() => surface.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })));
    }
    pointer(surface, "pointerup", 100 + distance);
    pointer(surface, "lostpointercapture", 100 + distance);
    act(() => part.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    act(() => vi.advanceTimersByTime(400));
    expect(onSwitchToggle).not.toHaveBeenCalled();
    expect(onInspectPart).not.toHaveBeenCalled();

    renderBoard({ readOnly: true, ...controls });
    pointer(part, "pointerdown", 100);
    pointer(surface, "pointerup", 100);
    pointer(surface, "lostpointercapture", 100);
    act(() => part.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    act(() => vi.advanceTimersByTime(400));
    if (control === "inspection") { expect(onInspectPart).toHaveBeenCalledOnce(); }
    else { expect(onSwitchToggle).toHaveBeenCalledOnce(); }
  });

  it.each(["Space", "hand tool"])("does not inspect after a stationary %s double-click", (gesture) => {
    vi.useFakeTimers();
    const onSwitchToggle = vi.fn();
    const onInspectPart = vi.fn();
    renderBoard({ readOnly: true, onSwitchToggle, onInspectPart, panMode: gesture === "hand tool" });
    const surface = required(".circuit-board__surface");
    const part = required('.circuit-board__part[data-kind="switch"]');
    for (const detail of [1, 2]) {
      if (gesture === "Space") {
        act(() => surface.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })));
      }
      pointer(part, "pointerdown", 100);
      if (gesture === "Space") {
        act(() => surface.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })));
      }
      pointer(surface, "pointerup", 100);
      pointer(surface, "lostpointercapture", 100);
      act(() => part.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
    }
    act(() => part.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
    act(() => vi.advanceTimersByTime(400));
    expect(onSwitchToggle).not.toHaveBeenCalled();
    expect(onInspectPart).not.toHaveBeenCalled();
  });
});
