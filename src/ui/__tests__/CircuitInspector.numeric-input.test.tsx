// @vitest-environment jsdom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPartCatalog, circuitPartNumericFields, type CircuitPart, type CircuitPartNumericKey } from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";
import { serializeCircuitDocument } from "../../circuit-serialization.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(kind: CircuitPart["kind"], view: "inspector" | "preview" = "inspector", initialPatch: Partial<CircuitPart> = {}) {
  const initial: CircuitPart = { id: "part", kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...initialPatch };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest = initial;
  let replacePart: Dispatch<SetStateAction<CircuitPart>> | undefined;
  function Harness() {
    const [part, setPart] = useState(initial);
    latest = part;
    replacePart = setPart;
    const onChange = (_id: string, patch: Partial<CircuitPart>) => setPart((current) => ({ ...current, ...patch }));
    if (view === "inspector") { return <CircuitInspector part={part} onChange={onChange} />; }
    const document = { title: "", parts: [part], wires: [] };
    return <CircuitPreviewPanel document={document} analysis={analyzeCircuit(document)} onChange={onChange} onReset={() => setPart(initial)} showReadings={false} />;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  return {
    container,
    get part() { return latest; },
    field(key: CircuitPartNumericKey) {
      const label = circuitPartNumericFields(kind).find((field) => field.key === key)?.label;
      const input = container.querySelector<HTMLInputElement>(view === "inspector"
        ? `input[data-field="${key}"]`
        : `input[aria-label="${latest.label}の${label}"]`);
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
  describe.each(["inspector", "preview"] as const)("%s op-amp supply rails", (view) => {
    it.each([
      { positiveRailVolts: Number.NEGATIVE_INFINITY, negativeRailVolts: Number.POSITIVE_INFINITY },
      { positiveRailVolts: Number.NaN, negativeRailVolts: Number.NaN },
      { positiveRailVolts: -Number.MAX_VALUE, negativeRailVolts: Number.MAX_VALUE },
    ].flatMap((rails) => (["positiveRailVolts", "negativeRailVolts"] as const).map((firstKey) => ({ rails, firstKey }))))
    ("repairs invalid initial rails starting with $firstKey ($rails)", ({ rails, firstKey }) => {
      const ui = mount("op-amp", view, rails);
      expect(ui.part).toMatchObject(rails);
      expect(analyzeCircuit({ title: "", parts: [ui.part], wires: [] }).status).toBe("invalid");
      const secondKey = firstKey === "positiveRailVolts" ? "negativeRailVolts" : "positiveRailVolts";
      const repaired = { positiveRailVolts: 15, negativeRailVolts: -15 };

      inputValue(ui.field(firstKey), String(repaired[firstKey]));

      expect(ui.part[firstKey]).toBe(repaired[firstKey]);
      expect(ui.part[secondKey]).toBe(rails[secondKey]);
      inputValue(ui.field(secondKey), String(repaired[secondKey]));
      expect(ui.part).toMatchObject(repaired);
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
    });

    it("preserves useful finite bounds while repairing an inverted range", () => {
      const rails = { positiveRailVolts: -10, negativeRailVolts: 10 };
      const ui = mount("op-amp", view, rails);
      inputValue(ui.field("positiveRailVolts"), "0");
      inputValue(ui.field("negativeRailVolts"), "0");
      expect(ui.part).toMatchObject(rails);

      inputValue(ui.field("positiveRailVolts"), "20");

      expect(ui.part).toMatchObject({ positiveRailVolts: 20, negativeRailVolts: 10 });
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
    });

    it("preserves strict bounds at the widest valid finite supply range", () => {
      const rails = { positiveRailVolts: Number.MAX_VALUE, negativeRailVolts: -Number.MAX_VALUE };
      const ui = mount("op-amp", view, rails);
      inputValue(ui.field("positiveRailVolts"), String(-Number.MAX_VALUE));
      inputValue(ui.field("negativeRailVolts"), String(Number.MAX_VALUE));
      expect(ui.part).toMatchObject(rails);
      inputValue(ui.field("positiveRailVolts"), "0");
      inputValue(ui.field("negativeRailVolts"), "0");
      expect(ui.part).toMatchObject({ positiveRailVolts: 0, negativeRailVolts: -Number.MAX_VALUE });
      inputValue(ui.field("negativeRailVolts"), "-1");
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
    });

    it.each([
      ["positiveRailVolts", -15], ["positiveRailVolts", -16],
      ["negativeRailVolts", 15], ["negativeRailVolts", 16],
    ] as const)("keeps %s=%s as a draft without corrupting the supply range", (key, value) => {
      const ui = mount("op-amp", view);
      const input = ui.field(key);
      const previous = ui.part[key];
      inputValue(input, String(value));

      expect(input.value).toBe(String(value));
      expect(ui.part[key]).toBe(previous);
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
      act(() => input.blur());
      expect(input.value).toBe(String(previous));
    });

    it("allows both rails to move across zero in a valid order", () => {
      const ui = mount("op-amp", view);
      inputValue(ui.field("negativeRailVolts"), "-10");
      inputValue(ui.field("positiveRailVolts"), "-5");
      expect(ui.part).toMatchObject({ negativeRailVolts: -10, positiveRailVolts: -5 });
      inputValue(ui.field("positiveRailVolts"), "20");
      inputValue(ui.field("negativeRailVolts"), "10");
      expect(ui.part).toMatchObject({ negativeRailVolts: 10, positiveRailVolts: 20 });
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
    });

    it("uses default bounds when the opposite supply rail is omitted", () => {
      const ui = mount("op-amp", view);
      const part = { ...ui.part };
      Reflect.deleteProperty(part, "positiveRailVolts");
      Reflect.deleteProperty(part, "negativeRailVolts");
      ui.replace(part);
      inputValue(ui.field("positiveRailVolts"), "-15");
      inputValue(ui.field("negativeRailVolts"), "15");
      expect(ui.part.positiveRailVolts).toBeUndefined();
      expect(ui.part.negativeRailVolts).toBeUndefined();
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
    });

    it("accepts distinct subnormal rails without treating their separation as zero", () => {
      const ui = mount("op-amp", view);
      inputValue(ui.field("negativeRailVolts"), String(-Number.MIN_VALUE));
      inputValue(ui.field("positiveRailVolts"), "0");
      expect(ui.part).toMatchObject({ negativeRailVolts: -Number.MIN_VALUE, positiveRailVolts: 0 });
      inputValue(ui.field("positiveRailVolts"), String(Number.MIN_VALUE));
      inputValue(ui.field("negativeRailVolts"), "0");
      expect(ui.part).toMatchObject({ negativeRailVolts: 0, positiveRailVolts: Number.MIN_VALUE });
      expect(() => serializeCircuitDocument({ title: "", parts: [ui.part], wires: [] })).not.toThrow();
    });
  });

  it.each(["inspector", "preview"] as const)("shows the analyzed default switch state instead of a phantom Proxy value in %s", (view) => {
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
    const ui = mount("switch", view);
    ui.replace(proxy);

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.switch!.switchClosed).toBe(true);
    expect(ui.container.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    { view: "inspector", resistanceOhms: undefined },
    { view: "inspector", resistanceOhms: 100 },
    { view: "preview", resistanceOhms: undefined },
    { view: "preview", resistanceOhms: 100 },
  ] as const)("shows the analyzed own resistance or its default in $view ($resistanceOhms)", ({ view, resistanceOhms }) => {
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
        return key === "resistanceOhms" ? 1000 : Reflect.get(target, key, receiver);
      },
    });
    document.parts[1] = proxy;
    const analysis = analyzeAnalogCircuit(document);
    const ui = mount("resistor", view);
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
