// @vitest-environment jsdom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitPart, type CircuitPartNumericKey } from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { CircuitInspector } from "../CircuitInspector.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(kind: CircuitPart["kind"]) {
  const initial: CircuitPart = { id: "part", kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest = initial;
  let replacePart: Dispatch<SetStateAction<CircuitPart>> | undefined;
  function Harness() {
    const [part, setPart] = useState(initial);
    latest = part;
    replacePart = setPart;
    return <CircuitInspector part={part} onChange={(_id, patch) => setPart((current) => ({ ...current, ...patch }))} />;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  return {
    container,
    get part() { return latest; },
    field(key: CircuitPartNumericKey) {
      const input = container.querySelector<HTMLInputElement>(`input[data-field="${key}"]`);
      if (!input) { throw new Error(`Missing field ${key}`); }
      act(() => input.focus());
      return input;
    },
    replace(part: CircuitPart) {
      const update = replacePart;
      if (!update) { throw new Error("Missing state setter"); }
      act(() => update(part));
    },
  };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) { throw new Error("Missing input value setter"); }
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Inspector numeric drafts", () => {
  it("shows the analyzed default switch state instead of a phantom Proxy value", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "return"], { resistanceOhms: 100 }],
      ["switch", "switch", ["return", "0"]],
    ], "Inspector and solver switch agreement");
    const part = document.parts[2]!;
    Reflect.deleteProperty(part, "initiallyClosed");
    const proxy = new Proxy(part, {
      get(target, key, receiver) {
        return key === "initiallyClosed" ? false : Reflect.get(target, key, receiver);
      },
    });
    document.parts[2] = proxy;
    const analysis = analyzeCircuit(document);
    const ui = mount("switch");
    ui.replace(proxy);

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.switch!.switchClosed).toBe(true);
    expect(ui.container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    expect(ui.container.querySelector('input[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it.each([undefined, 100])("shows the analyzed own resistance or its default instead of a Proxy get value (%s)", (resistanceOhms) => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "0"]],
      ["ground", "ground", ["0"]],
    ], "Inspector and solver resistance agreement");
    const part = document.parts[1]!;
    if (resistanceOhms === undefined) { Reflect.deleteProperty(part, "resistanceOhms"); }
    else { Object.defineProperty(part, "resistanceOhms", { value: resistanceOhms, enumerable: false }); }
    const proxy = new Proxy(part, {
      get(target, key, receiver) {
        return key === "resistanceOhms" && resistanceOhms === undefined ? 1000 : Reflect.get(target, key, receiver);
      },
    });
    document.parts[1] = proxy;
    const analysis = analyzeAnalogCircuit(document);
    const ui = mount("resistor");
    ui.replace(proxy);

    expect(analysis.status).toBe("valid");
    const expected = resistanceOhms ?? 10;
    expect(analysis.parts.load!.current.real).toBe(9 / expected);
    expect(ui.field("resistanceOhms").value).toBe(String(expected));
  });

  it.each([
    ["ac-source", "offsetVolts"],
    ["capacitor", "initialVoltageVolts"],
    ["current-source", "currentAmps"],
  ] as const)("keeps the native incomplete state before a negative %s.%s value", (kind, key) => {
    const ui = mount(kind);
    const input = ui.field(key);
    const previous = ui.part[key];
    // Native number inputs expose an empty value while '-' is being typed.
    inputValue(input, "");
    expect(input.value).toBe("");
    expect(ui.part[key]).toBe(previous);
    inputValue(input, "-7");
    expect(input.value).toBe("-7");
    expect(ui.part[key]).toBe(-7);
  });

  it("keeps an unfinished exponent and preserves its text until blur", () => {
    const ui = mount("ac-source");
    const input = ui.field("offsetVolts");
    inputValue(input, "1");
    inputValue(input, "");
    expect(input.value).toBe("");
    expect(ui.part.offsetVolts).toBe(1);
    inputValue(input, "1e-3");
    expect(input.value).toBe("1e-3");
    expect(ui.part.offsetVolts).toBe(0.001);
    act(() => input.blur());
    expect(input.value).toBe("0.001");
  });

  it("allows a decimal prefix below the bound without committing an invalid resistance", () => {
    const ui = mount("resistor");
    const input = ui.field("resistanceOhms");
    const previous = ui.part.resistanceOhms;
    inputValue(input, "0");
    expect(input.value).toBe("0");
    expect(ui.part.resistanceOhms).toBe(previous);
    inputValue(input, "0.1");
    expect(ui.part.resistanceOhms).toBe(0.1);
  });

  it("restores an invalid draft on blur and keeps the committed value", () => {
    const ui = mount("resistor");
    const input = ui.field("resistanceOhms");
    const previous = ui.part.resistanceOhms;
    inputValue(input, "-7");
    expect(input.value).toBe("-7");
    expect(ui.part.resistanceOhms).toBe(previous);
    act(() => input.blur());
    expect(input.value).toBe(String(previous));
  });

  it("synchronizes external changes and resets drafts when another part is selected", () => {
    const ui = mount("ac-source");
    const input = ui.field("offsetVolts");
    inputValue(input, "");
    ui.replace({ ...ui.part, offsetVolts: 42 });
    expect(input.value).toBe("42");
    inputValue(input, "");
    ui.replace({ ...ui.part, id: "other", offsetVolts: 42 });
    expect(ui.field("offsetVolts").value).toBe("42");
  });
});
