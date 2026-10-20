// @vitest-environment jsdom
import { act, useState, type ComponentProps, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";
import { NumericInput, useNumericDraft } from "../NumericInput.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount<T,>(initial: T, render: (value: T, update: Dispatch<SetStateAction<T>>) => ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let setValue: Dispatch<SetStateAction<T>> | undefined;
  let latest = initial;
  function Harness() {
    const [value, update] = useState(initial);
    latest = value;
    setValue = update;
    return render(value, update);
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  return {
    container,
    get value() { return latest; },
    update(patch: Partial<T>) {
      const update = setValue;
      if (!update) { throw new Error("Missing state setter"); }
      act(() => update((value) => ({ ...value, ...patch })));
    },
  };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) { throw new Error("Missing input value setter"); }
  act(() => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("numeric drafts after external domain updates", () => {
  it("notifies a return to the original value while a host defers its controlled update", () => {
    const pending: number[] = [];
    const ui = mount(10, (value) => <NumericInput value={value} onValueChange={(next) => pending.push(next)} />);
    const input = ui.container.querySelector("input")!;

    inputValue(input, "20");
    inputValue(input, "10");

    expect(pending).toEqual([20, 10]);
    expect(input.value).toBe("10");
    expect(ui.value).toBe(10);
  });

  it("commits a return to the original value when changes are batched", () => {
    let change: ((text: string) => void) | undefined;
    function Field({ value, update }: { value: number; update: (value: number) => void }) {
      const draft = useNumericDraft({ value, onValueChange: update });
      change = draft.change;
      return <output>{draft.text}</output>;
    }
    const ui = mount(10, (value, update) => <Field value={value} update={update} />);
    const changeDraft = change;
    if (!changeDraft) { throw new Error("Missing draft callback"); }

    act(() => {
      changeDraft("20");
      changeDraft("10");
    });

    expect(ui.value).toBe(10);
    expect(ui.container.querySelector("output")?.textContent).toBe("10");
  });

  it.each(["inspector", "preview"] as const)("repairs a malformed own numeric value by entering the catalog default in %s", (view) => {
    const initial: CircuitPart = { id: "load", kind: "resistor", x: 0, y: 0, ...circuitPartCatalog.resistor.defaults };
    Object.defineProperty(initial, "resistanceOhms", { value: null, enumerable: true, configurable: true });
    const ui = mount(initial, (part, update) => {
      const onChange = (_id: string, patch: Partial<CircuitPart>) => update((value) => ({ ...value, ...patch }));
      if (view === "inspector") { return <CircuitInspector part={part} onChange={onChange} />; }
      const document = { title: "", parts: [part], wires: [] };
      const initialDocument = { ...document, parts: [{ ...initial, resistanceOhms: 10 }] };
      return <CircuitPreviewPanel document={document} initialDocument={initialDocument} analysis={analyzeCircuit(document)}
        onChange={onChange} onReset={() => {}} showReadings={false} />;
    });
    const input = ui.container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(analyzeCircuit({ title: "", parts: [ui.value], wires: [] }).status).toBe("invalid");
    if (view === "preview") { expect(ui.container.querySelector('[role="status"]')?.textContent).toBe("1項目を変更"); }
    inputValue(input, "");
    inputValue(input, "10");

    expect(ui.value.resistanceOhms).toBe(10);
    expect(analyzeCircuit({ title: "", parts: [ui.value], wires: [] }).status).not.toBe("invalid");
    if (view === "preview") { expect(ui.container.querySelector('[role="status"]')?.textContent).toBe("変更なし"); }
  });

  it("shows the committed rail when an opposite rail update makes an invalid draft valid", () => {
    const initial: CircuitPart = { id: "op", kind: "op-amp", x: 0, y: 0, ...circuitPartCatalog["op-amp"].defaults };
    const ui = mount(initial, (part, update) => <CircuitInspector part={part}
      onChange={(_id, patch) => update((value) => ({ ...value, ...patch }))} />);
    const input = ui.container.querySelector<HTMLInputElement>('input[data-field="positiveRailVolts"]')!;
    inputValue(input, "-20");
    expect(input.value).toBe("-20");
    expect(ui.value.positiveRailVolts).toBe(15);

    ui.update({ negativeRailVolts: -30 });

    expect(ui.value.positiveRailVolts).toBe(15);
    expect(input.value).toBe("15");
    inputValue(input, "-20");
    expect(ui.value.positiveRailVolts).toBe(-20);
  });

  it.each([
    { initial: { min: 0, exclusiveMin: true }, patch: { exclusiveMin: false }, value: 1, draft: "0" },
    { initial: { max: 0, exclusiveMax: true }, patch: { exclusiveMax: false }, value: -1, draft: "0" },
    { initial: { integer: true }, patch: { integer: false }, value: 1, draft: "1.5" },
  ])("resets an uncommitted draft when its domain changes ($initial)", ({ initial, patch, value, draft }) => {
    type Settings = Omit<ComponentProps<typeof NumericInput>, "onValueChange">;
    const ui = mount<Settings>({ ...initial, value, step: "any" }, (settings, update) => <NumericInput {...settings}
      onValueChange={(nextValue) => update((current) => ({ ...current, value: nextValue }))} />);
    const input = ui.container.querySelector("input")!;
    inputValue(input, draft);
    expect(ui.value.value).toBe(value);

    ui.update(patch);

    expect(input.value).toBe(String(value));
    expect(ui.value.value).toBe(value);
  });
});
