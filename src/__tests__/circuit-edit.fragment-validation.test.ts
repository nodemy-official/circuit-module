import { describe, expect, it } from "vitest";

import { pasteFragment, type CircuitFragment } from "../circuit-edit.js";
import { circuitPartKinds, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import { serializeCircuitDocument } from "../circuit-serialization.js";

function targetDocument(): CircuitDocument {
  return {
    title: "貼り付け先",
    parts: [{ id: "existing", kind: "junction", x: -20, y: -20, label: "既存" }],
    wires: [],
  };
}

function fragmentWith(values: Record<string, unknown>): CircuitFragment {
  return {
    parts: [{ id: "r", kind: "resistor", x: 0, y: 0, label: "R", ...values } as CircuitPart],
    wires: [],
  };
}

describe("fragment value validation", () => {
  it.each([
    { name: "NaN resistance", values: { resistanceOhms: Number.NaN } },
    { name: "infinite resistance", values: { resistanceOhms: Number.POSITIVE_INFINITY } },
    { name: "negative resistance", values: { resistanceOhms: -1 } },
    { name: "zero resistance", values: { resistanceOhms: 0 } },
    { name: "invalid rotation", values: { rotation: 45 } },
    { name: "unknown kind", values: { kind: "unknown" } },
    { name: "non-string label", values: { label: null } },
    { name: "non-boolean switch state", values: { kind: "switch", initiallyClosed: "true" } },
    { name: "invalid rail order", values: { kind: "op-amp", positiveRailVolts: 1, negativeRailVolts: 2 } },
    { name: "out-of-range wiper", values: { kind: "potentiometer", wiperPosition: 2 } },
    { name: "non-finite initial voltage", values: { kind: "capacitor", initialVoltageVolts: Number.NaN } },
    { name: "invalid unused saved field", values: { currentGain: -1 } },
  ])("rejects $name without changing either input", ({ values }) => {
    const document = targetDocument();
    const fragment = fragmentWith(values);
    const beforeDocument = structuredClone(document);
    const beforeFragment = structuredClone(fragment);

    expect(pasteFragment(document, fragment).ok).toBe(false);
    expect(document).toEqual(beforeDocument);
    expect(fragment).toEqual(beforeFragment);
  });

  it("accepts disconnected parts of every supported kind with omitted optional values", () => {
    const document = targetDocument();
    const fragment: CircuitFragment = {
      parts: circuitPartKinds.map((kind, index) => ({ id: kind, kind, x: index * 10, y: 0, label: kind })),
      wires: [],
    };
    const result = pasteFragment(document, fragment);
    if (!result.ok) { throw new Error(result.reason); }

    expect(result.selection.parts).toHaveLength(circuitPartKinds.length);
    expect(result.document.parts.map((part) => part.kind).slice(1)).toEqual(circuitPartKinds);
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(targetDocument());
    expect(fragment.parts[0]?.x).toBe(0);
  });

  it("applies the validated snapshot without reading caller getters or Proxy get traps", () => {
    const document = targetDocument();
    const fragment = fragmentWith({ resistanceOhms: 12 });
    let reads = 0;
    const unexpectedRead = () => {
      reads += 1;
      throw new Error("Caller getter must not run");
    };
    Object.defineProperty(fragment.parts[0], "extra", { enumerable: true, get: unexpectedRead });
    const part = new Proxy(fragment.parts[0]!, { get: unexpectedRead });
    const wrapped = new Proxy({
      parts: new Proxy([part], { get: unexpectedRead }),
      wires: new Proxy([], { get: unexpectedRead }),
    }, { get: unexpectedRead });

    const result = pasteFragment(document, wrapped);
    if (!result.ok) { throw new Error(result.reason); }

    expect(reads).toBe(0);
    expect(result.document.parts[1]).toEqual({ id: "part-1", kind: "resistor", x: 2, y: 2, label: "R", resistanceOhms: 12 });
    expect(() => serializeCircuitDocument(result.document)).not.toThrow();
    expect(document).toEqual(targetDocument());
  });

  it("rejects a known accessor without invoking it", () => {
    const document = targetDocument();
    const fragment = fragmentWith({});
    let reads = 0;
    Object.defineProperty(fragment.parts[0], "resistanceOhms", {
      enumerable: true,
      get() {
        reads += 1;
        return 12;
      },
    });

    expect(pasteFragment(document, fragment).ok).toBe(false);
    expect(reads).toBe(0);
    expect(document).toEqual(targetDocument());
  });
});
