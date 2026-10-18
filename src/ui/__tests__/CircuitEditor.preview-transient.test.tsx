// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { createCircuitExample } from "../../circuit-examples.js";
import { setupEditorHarness } from "./helpers/editor-harness.js";

const mount = setupEditorHarness();

function required<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) { throw new Error(`Missing ${selector}`); }
  return element;
}

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function clickButton(container: ParentNode, label: string) {
  const button = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!button) { throw new Error(`Missing ${label}`); }
  click(button);
}

function seek(container: ParentNode, index: number) {
  const input = required<HTMLInputElement>(container, '.circuit-transient__time-controls input[type="range"]');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(index));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function reading(container: ParentNode, quantity: "voltage" | "current") {
  return required(container, `.circuit-preview-dialog [data-measurement="${quantity}"] dd`).textContent;
}

describe("preview transient measurement integration", () => {
  it("keeps the preview component dialog on the same transient frame as the board", () => {
    const ui = mount(createCircuitExample("charging"));
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    clickButton(required(ui.container, ".circuit-editor__learning"), "波形を計算");
    expect(ui.container.querySelector(".circuit-potential__time")?.textContent).toContain("0 s");
    click(required(ui.container, '.circuit-board__part[data-kind="capacitor"]'));

    expect(reading(ui.container, "voltage")).toBe("0 V");
    expect(reading(ui.container, "current")).toBe("5 mA");
    expect(ui.container.querySelector(".circuit-preview__measurement-note")?.textContent).toContain("時間カーソル 0 s");
  });

  it.each([
    ["capacitor", "3.138 V", "1.862 mA"],
    ["resistor", "1.862 V", "1.862 mA"],
    ["battery", "5 V", "-1.862 mA"],
  ])("uses the selected frame for %s voltage and signed current", (kind, voltage, current) => {
    const ui = mount(createCircuitExample("charging"));
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    clickButton(required(ui.container, ".circuit-editor__learning"), "波形を計算");
    seek(ui.container, 40);
    click(required(ui.container, `.circuit-board__part[data-kind="${kind}"]`));

    expect(reading(ui.container, "voltage")).toBe(voltage);
    expect(reading(ui.container, "current")).toBe(current);
    expect(ui.container.querySelector(".circuit-preview__measurement-note")?.textContent).toBe("時間カーソル 0.001 s の瞬時値です。");
    expect(ui.container.querySelector(".circuit-preview__measurement-note")?.textContent).not.toContain("直流の");
  });

  it("drops the sampled dialog readings when a preview value is edited", () => {
    const ui = mount(createCircuitExample("charging"));
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    clickButton(required(ui.container, ".circuit-editor__learning"), "波形を計算");
    click(required(ui.container, '.circuit-board__part[data-kind="resistor"]'));
    expect(reading(ui.container, "current")).toBe("5 mA");
    const input = required<HTMLInputElement>(ui.container, '.circuit-preview-dialog input[type="number"]');

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "2000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(reading(ui.container, "voltage")).toBe("0 V");
    expect(reading(ui.container, "current")).toBe("0 A");
    expect(ui.container.querySelector(".circuit-preview__measurement-note")?.textContent).toContain("直流の電圧・電流");
    expect(ui.container.querySelector(".circuit-potential__time")).toBeNull();
    expect(ui.container.textContent).toContain("波形を再計算してください");
    expect(ui.editor.document.parts.find((part) => part.kind === "resistor")?.resistanceOhms).toBe(1000);
  });

  it("keeps AC settings while showing signed instantaneous readings and returns to RMS values", () => {
    const ui = mount(createCircuitFromSpecs([
      ["source", "ac-source", ["s", "0"], { voltageVolts: 2, frequencyHz: 50, phaseDegrees: 180 }],
      ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
      ["ground", "ground", ["0"]],
    ], "交流の瞬時値"));
    click(required(ui.container, ".circuit-editor__preview-toggle"));
    clickButton(required(ui.container, ".circuit-editor__learning"), "波形を計算");
    click(required(ui.container, '.circuit-board__part[data-kind="resistor"]'));

    expect(reading(ui.container, "voltage")).toBe("-2.828 V");
    expect(reading(ui.container, "current")).toBe("-282.8 mA");
    expect(ui.container.querySelector(".circuit-preview__measurement-note")?.textContent).toContain("時間カーソル 0 s の瞬時値");
    expect(ui.container.querySelector('.circuit-preview-dialog [data-measurement="voltage-phase"]')).toBeNull();

    click(required(ui.container, '[aria-label="部品一覧に戻る"]'));
    expect(ui.container.querySelector(".circuit-preview-dialog__analysis .circuit-analysis__mode")?.textContent).toBe("過渡 0 s · 瞬時値");
    clickButton(ui.container, "解析設定");
    const settings = required(ui.container, '.circuit-preview-dialog .circuit-simulation');
    expect(required<HTMLSelectElement>(settings, "select").value).toBe("auto");
    expect(required<HTMLInputElement>(settings, 'input[type="number"]').value).toBe("50");
    expect(settings.textContent).toContain("計測値は実効値と位相です。");

    click(required(ui.container, '.circuit-preview-dialog [aria-label="閉じる"]'));
    clickButton(required(ui.container, ".circuit-editor__learning"), "回路図を定常表示に戻す");
    click(required(ui.container, '.circuit-board__part[data-kind="resistor"]'));

    expect(reading(ui.container, "voltage")).toBe("2 V");
    expect(reading(ui.container, "current")).toBe("200 mA");
    expect(ui.container.querySelector(".circuit-preview__measurement-note")?.textContent).toContain("交流解析 (50 Hz)");
    expect(ui.container.querySelector('.circuit-preview-dialog [data-measurement="voltage-phase"]')).not.toBeNull();
  });
});
