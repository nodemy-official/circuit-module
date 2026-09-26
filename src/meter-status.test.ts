import { describe, expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "./circuit-model.js";
import { meterStatuses } from "./meter-status.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
});

describe("meterStatuses", () => {
  it("does not invent meter statuses for inherited names when the circuit has no meters", () => {
    const result = meterStatuses({
      title: "計器なし",
      parts: [part("constructor", "battery"), part("__proto__", "resistor")],
      wires: [],
    });

    for (const id of ["constructor", "__proto__", "toString"]) {
      expect(result[id]).toBeUndefined();
    }
  });

  it.each(["__proto__", "constructor", "toString"])("records the status of a meter named %s as its own property", (id) => {
    const result = meterStatuses({ title: "未接続", parts: [part(id, "voltmeter")], wires: [] });

    expect(Object.hasOwn(result, id)).toBe(true);
    expect(result[id]).toBe("unconnected");
  });

  it.each(["__proto__", "constructor", "toString"])("keeps a floating voltmeter isolated by the open switch %s", (id) => {
    const document: CircuitDocument = {
      title: "開いたスイッチ",
      parts: [part("source", "battery"), part("v", "voltmeter"), part(id, "switch", { initiallyClosed: false })],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "v", terminal: "a" } },
        { id: "w2", from: { partId: "v", terminal: "b" }, to: { partId: id, terminal: "a" } },
        { id: "w3", from: { partId: id, terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };

    expect(meterStatuses(document).v).toBe("floating");
    expect(meterStatuses(document, { switchStates: { [id]: true } }).v).toBe("connected");
    expect(meterStatuses(document, { switchStates: { [id]: false } }).v).toBe("floating");
  });
});
