// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { CircuitBoard } from "../CircuitBoard.js";

const circuit: CircuitDocument = {
  title: "activation boundary",
  parts: [
    { id: "j", kind: "junction", label: "J", x: 0, y: 0 },
    { id: "r", kind: "resistor", label: "R", x: 6, y: 0, resistanceOhms: 10 },
  ],
  wires: [{ id: "w", from: { partId: "j", terminal: "a" }, to: { partId: "r", terminal: "a" } }],
};

type Target = "terminal" | "junction" | "wire" | "pending wire" | "reconnect" | "background";
type Activation = "click" | "Enter";
const cases: Array<{ target: Target; activation: Activation }> = [
  ...(["terminal", "junction", "wire", "pending wire", "reconnect"] as const).flatMap((target) =>
    (["click", "Enter"] as const).map((activation) => ({ target, activation }))),
  { target: "background", activation: "click" },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function activate(target: Target, activation: Activation) {
  const selectors: Record<Target, string> = {
    terminal: '.circuit-board__terminal[data-part-id="r"][data-terminal="a"]',
    junction: '.circuit-board__terminal[data-part-id="j"][data-terminal="a"]',
    wire: '.circuit-board__wire[data-wire-id="w"]',
    "pending wire": '.circuit-board__wire[data-wire-id="w"]',
    reconnect: '[data-wire-handle="from"]',
    background: "[data-circuit-board-background]",
  };
  const element = container.querySelector(selectors[target]);
  if (!element) { throw new Error(`Missing ${target}`); }
  act(() => element.dispatchEvent(activation === "Enter"
    ? new KeyboardEvent("keydown", { key: "Enter", shiftKey: target === "junction", bubbles: true, cancelable: true })
    : new MouseEvent("click", {
      detail: 1, shiftKey: target === "junction", bubbles: true, cancelable: true,
      clientX: target === "background" ? 10_000 : 0,
      clientY: target === "background" ? 10_000 : 0,
    })));
}

describe("CircuitBoard stale document activation", () => {
  it.each(cases)("rejects $target $activation until the current document version commits", ({ target, activation }) => {
    let version = 0;
    const callbacks = {
      onSelectPart: vi.fn(),
      onSelectWire: vi.fn(),
      onTerminalClick: vi.fn(),
      onReconnectStart: vi.fn(),
      onBoardClick: vi.fn(),
    };
    const render = (showFlow: boolean) => act(() => root.render(<CircuitBoard
      document={circuit}
      documentVersion={() => version}
      selection={{ parts: [], wires: ["w"] }}
      pendingEndpoint={target === "pending wire" ? { partId: "j", terminal: "a" } : null}
      renderControls={null}
      showFlow={showFlow}
      {...callbacks}
    />));
    render(false);
    version += 1;

    activate(target, activation);

    for (const callback of Object.values(callbacks)) { expect(callback).not.toHaveBeenCalled(); }

    render(true);
    activate(target, activation);

    const expected = target === "terminal" ? { name: "onTerminalClick", args: [{ partId: "r", terminal: "a" }] }
      : target === "junction" ? { name: "onSelectPart", args: ["j", true] }
      : target === "wire" ? { name: "onSelectWire", args: ["w", false] }
      : target === "reconnect" ? { name: "onReconnectStart", args: ["w", "from"] }
      : { name: "onBoardClick", args: [expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })] };
    for (const [name, callback] of Object.entries(callbacks)) {
      if (name === expected.name) { expect(callback).toHaveBeenCalledExactlyOnceWith(...expected.args); }
      else { expect(callback).not.toHaveBeenCalled(); }
    }
  });
});
