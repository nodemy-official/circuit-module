import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import type { CircuitDocument } from "../../../circuit-model.js";
import type { CircuitBoardProps } from "../../CircuitBoard.js";
import { CircuitEditor } from "../../CircuitEditor.js";
import { CircuitEditorLayout } from "../../CircuitEditorLayout.js";
import type { CircuitEditorController } from "../../useCircuitEditor.js";

/** Registers per-file jsdom setup and cleanup for editor interaction suites. */
export function setupEditorHarness() {
  const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const mounted: Array<{ root: Root; container: HTMLElement }> = [];

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (media: string) => ({
        matches: false,
        media,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      }),
    });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    if (matchMediaDescriptor) { Object.defineProperty(window, "matchMedia", matchMediaDescriptor); }
    else { Reflect.deleteProperty(window, "matchMedia"); }
    if (actEnvironmentDescriptor) { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor); }
    else { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); }
  });

  return function mount(initialDocument: CircuitDocument, boardProps?: Partial<CircuitBoardProps>) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latest: CircuitEditorController | null = null;
    act(() => {
      root.render(
        <CircuitEditor initialDocument={initialDocument}>
          {(editor) => {
            latest = editor;
            return <CircuitEditorLayout boardProps={boardProps} />;
          }}
        </CircuitEditor>,
      );
    });
    mounted.push({ root, container });
    return {
      container,
      get editor(): CircuitEditorController {
        if (!latest) { throw new Error("CircuitEditor did not render"); }
        return latest;
      },
    };
  };
}
