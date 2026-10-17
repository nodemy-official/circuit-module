// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { createExampleCircuit } from "../../circuit-model.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const mount = setupEditorHarness();

function overview(container: HTMLElement) {
  act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click());
  act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-panel-toggle")!.click());
  return [...container.querySelectorAll<HTMLButtonElement>(".circuit-preview-dialog__footer button")]
    .find((button) => button.textContent?.includes("すべてリセット"))!;
}

it.each(["bigint", "cycle", "getter"] as const)("does not inspect unrelated %s part metadata when detecting preview changes", (representation) => {
  const initial = createExampleCircuit();
  const part = initial.parts[0]!;
  const getter = vi.fn(() => { throw new Error("Metadata must not be read"); });
  if (representation === "bigint") { Object.assign(part, { metadata: 1n }); }
  else if (representation === "cycle") {
    const metadata: { self?: unknown } = {};
    metadata.self = metadata;
    Object.assign(part, { metadata });
  } else { Object.assign(part, { metadata: { get value() { return getter(); } } }); }

  const ui = mount(initial);
  const reset = overview(ui.container);

  expect(reset.disabled).toBe(true);
  expect(getter).not.toHaveBeenCalled();
  expect(ui.editor.document.title).toBe(initial.title);
});

it("treats an explicit default setting as unchanged in the preview overview", () => {
  const initial = createExampleCircuit();
  const battery = initial.parts.find((part) => part.kind === "battery")!;
  Reflect.deleteProperty(battery, "internalResistanceOhms");
  const ui = mount(initial);
  overview(ui.container);
  act(() => [...ui.container.querySelectorAll<HTMLButtonElement>(".circuit-preview-dialog__part")]
    .find((button) => button.textContent?.includes(battery.label))!.click());
  const input = ui.container.querySelector<HTMLInputElement>('[aria-label="電池の内部抵抗"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, "1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    setValue.call(input, "0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(ui.container.querySelector(".circuit-preview__change-status")?.textContent).toBe("変更なし");
  act(() => ui.container.querySelector<HTMLButtonElement>('[aria-label="部品一覧に戻る"]')!.click());

  const reset = [...ui.container.querySelectorAll<HTMLButtonElement>(".circuit-preview-dialog__footer button")]
    .find((button) => button.textContent?.includes("すべてリセット"))!;
  expect(reset.disabled).toBe(true);
});
