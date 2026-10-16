// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitDocument, CircuitPart } from "../../circuit-model.js";
import { CircuitBoard } from "../CircuitBoard.js";

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const root of roots.splice(0)) { act(() => root.unmount()); }
  vi.unstubAllGlobals();
});

function mount(part: CircuitPart) {
  const document: CircuitDocument = { title: "解析に使用する自身のフィールド", parts: [part], wires: [] };
  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const onSwitchToggle = vi.fn();
  const render = () => act(() => root.render(<CircuitBoard document={document} readOnly onSwitchToggle={onSwitchToggle}
    renderControls={null} showFlow={false} showPotentials={false} />));
  render();
  return { container, render };
}

describe("CircuitBoard own input fields", () => {
  it.each([undefined, 100])("shows the own resistance or catalog default (%s)", (resistanceOhms) => {
    const part: CircuitPart = { id: "load", kind: "resistor", label: "抵抗", x: 0, y: 0 };
    if (resistanceOhms !== undefined) {
      Object.defineProperty(part, "resistanceOhms", { value: resistanceOhms, writable: true, enumerable: false });
    }
    const ui = mount(new Proxy(part, {
      get(target, key, receiver) {
        return key === "resistanceOhms" ? 1000 : Reflect.get(target, key, receiver);
      },
    }));

    expect(ui.container.querySelector(".circuit-board__part-detail")?.textContent).toBe(`${resistanceOhms ?? 10} Ω`);
  });

  it("refreshes the label when an own resistance changes behind a stable Proxy value", () => {
    const part: CircuitPart = { id: "load", kind: "resistor", label: "抵抗", x: 0, y: 0, resistanceOhms: 100 };
    const ui = mount(new Proxy(part, {
      get(target, key, receiver) {
        return key === "resistanceOhms" ? 1000 : Reflect.get(target, key, receiver);
      },
    }));
    expect(ui.container.querySelector(".circuit-board__part-detail")?.textContent).toBe("100 Ω");

    part.resistanceOhms = 200;
    ui.render();

    expect(ui.container.querySelector(".circuit-board__part-detail")?.textContent).toBe("200 Ω");
  });

  it("refreshes switch artwork and accessibility from own values while readings are unavailable", () => {
    const part: CircuitPart = { id: "switch", kind: "switch", label: "スイッチ", x: 0, y: 0 };
    const ui = mount(new Proxy(part, {
      get(target, key, receiver) {
        return key === "initiallyClosed" ? false : Reflect.get(target, key, receiver);
      },
    }));
    const switchElement = () => ui.container.querySelector('.circuit-board__part[data-part-id="switch"]')!;
    expect(switchElement().getAttribute("aria-pressed")).toBe("true");
    expect(switchElement().getAttribute("aria-label")).toBe("スイッチを開く");
    expect(switchElement().querySelector('path[d="M -9 0 L 9 0"]')).not.toBeNull();

    part.initiallyClosed = false;
    ui.render();

    expect(switchElement().getAttribute("aria-pressed")).toBe("false");
    expect(switchElement().getAttribute("aria-label")).toBe("スイッチを閉じる");
    expect(switchElement().querySelector('path[d="M -9 0 L 7 -10"]')).not.toBeNull();
  });
});
