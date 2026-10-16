// @vitest-environment jsdom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(initialDocument: CircuitDocument) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let updateDocument: Dispatch<SetStateAction<CircuitDocument>> | undefined;
  function Harness() {
    const [document, setDocument] = useState(initialDocument);
    updateDocument = setDocument;
    return <CircuitPreviewPanel
      document={document}
      initialDocument={initialDocument}
      analysis={analyzeCircuit(document)}
      onChange={(id, patch) => setDocument((current) => ({
        ...current,
        parts: current.parts.map((part) => part.id === id ? { ...part, ...patch } : part),
      }))}
      onReset={() => setDocument(initialDocument)}
      showReadings={false}
    />;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  return {
    container,
    replace(document: CircuitDocument) {
      if (!updateDocument) { throw new Error("Missing document state setter"); }
      act(() => updateDocument!(document));
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

describe("preview panel inputs and readings", () => {
  it.each(["", "1e2"])("updates the displayed value after an external edit while the draft is %j", (draft) => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
    ], "外部からの値変更");
    const ui = mount(document);
    const input = ui.container.querySelector<HTMLInputElement>('[data-part-id="load"] input')!;
    act(() => input.focus());
    inputValue(input, draft);
    expect(input.value).toBe(draft);

    ui.replace({
      ...document,
      parts: document.parts.map((part) => part.id === "load" ? { ...part, resistanceOhms: 20 } : part),
    });

    expect(input.value).toBe("20");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("shows the same default battery voltage as the circuit analysis", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"]],
      ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
      ["ground", "ground", ["0"]],
    ], "既定の電池電圧");
    Reflect.deleteProperty(document.parts[0]!, "voltageVolts");
    expect(analyzeCircuit(document).parts.source!.voltageVolts).toBe(9);
    const ui = mount(document);
    expect(ui.container.querySelector<HTMLInputElement>('[data-part-id="source"] input')!.value).toBe("9");
  });

  it("compares the analyzed own data values instead of virtual Proxy values", () => {
    const initialDocument = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
    ], "プレビューの変更判定");
    const document = {
      ...initialDocument,
      parts: initialDocument.parts.map((part) => new Proxy(part, {
        get(target, key, receiver) {
          return key === "resistanceOhms" ? 1000 : Reflect.get(target, key, receiver);
        },
      })),
    };
    const markup = renderToStaticMarkup(<CircuitPreviewPanel
      document={document}
      initialDocument={initialDocument}
      analysis={analyzeCircuit(document)}
      onChange={() => {}}
      onReset={() => {}}
      showReadings={false}
    />);

    expect(markup).toContain("変更なし");
    expect(markup).not.toContain("変更あり");
    expect(markup).not.toContain('data-changed="true"');
  });

  it("hides measurements for a scoped part when readings are disabled", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
    ], "部品の値だけを表示");
    const markup = renderToStaticMarkup(<CircuitPreviewPanel
      document={document}
      analysis={analyzeCircuit(document)}
      onChange={() => {}}
      onReset={() => {}}
      partId="load"
      showReadings={false}
    />);

    expect(markup).toContain('data-part-id="load"');
    expect(markup).toContain('type="number"');
    expect(markup).not.toContain('data-part-id="source"');
    expect(markup).not.toContain('data-measurement="voltage"');
    expect(markup).not.toContain('aria-label="部品の計測値"');
  });

  it("labels transient readings as instantaneous values at the selected time", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "0"], { resistanceOhms: 10 }],
    ], "過渡解析の計測");
    const markup = renderToStaticMarkup(<CircuitPreviewPanel
      document={document}
      analysis={{ ...analyzeCircuit(document), timeSeconds: 0.004 }}
      onChange={() => {}}
      onReset={() => {}}
      partId="load"
    />);

    expect(markup).toContain("時間カーソル 0.004 s の瞬時値です。");
    expect(markup).not.toContain("直流の電圧・電流は端子の向きに対する符号付き値です。");
  });
});
