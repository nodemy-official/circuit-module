import { describe, expect, it, vi } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";
import { simulationDocumentKey } from "../simulation-document-key.js";

function circuit(): CircuitDocument {
  return {
    title: "キーの入力境界",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 1 },
      { id: "load", kind: "resistor", label: "抵抗", x: 4, y: 0, resistanceOhms: 10 },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "b", from: { partId: "load", terminal: "b" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

describe("simulation document keys", () => {
  it("includes non-enumerable own values", () => {
    const document = circuit();
    const before = simulationDocumentKey(document);
    Object.defineProperty(document, "wires", { value: document.wires, enumerable: false });
    Object.defineProperty(document.parts[0], "voltageVolts", { value: 1, enumerable: false, writable: true });
    expect(before).not.toBeNull();
    expect(simulationDocumentKey(document)).toBe(before);
    document.parts[0]!.voltageVolts = 2;
    expect(simulationDocumentKey(document)).not.toBe(before);
  });

  it("never calls Proxy get traps in the input graph", () => {
    const document = circuit();
    const before = simulationDocumentKey(document);
    const get = vi.fn(() => { throw new Error("Unexpected property read"); });
    document.parts = new Proxy(document.parts.map((part) => new Proxy(part, { get })), { get });
    document.wires = new Proxy(document.wires.map((wire) => new Proxy({
      ...wire, from: new Proxy(wire.from, { get }), to: new Proxy(wire.to, { get }),
    }, { get })), { get });
    expect(simulationDocumentKey(new Proxy(document, { get }))).toBe(before);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects accessors without evaluating them", () => {
    const document = circuit();
    const get = vi.fn(() => 1);
    Object.defineProperty(document.parts[0], "voltageVolts", { get });
    expect(simulationDocumentKey(document)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects changes to earlier values made during later input capture", () => {
    const document = circuit();
    const before = simulationDocumentKey(document);
    let mutate = true;
    document.wires[0]!.to = new Proxy(document.wires[0]!.to, {
      ownKeys(target) {
        if (mutate) { document.parts[0]!.voltageVolts = 2; mutate = false; }
        return Reflect.ownKeys(target);
      },
    });
    expect(simulationDocumentKey(document)).toBeNull();
    const after = simulationDocumentKey(document);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it.each(["x", "label"])("rejects a Proxy that hides the known field %s", (field) => {
    const document = circuit();
    document.parts[0] = new Proxy(document.parts[0]!, {
      ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== field),
    });
    expect(simulationDocumentKey(document)).toBeNull();
  });

  it("ignores unused attributes of other component kinds without losing electrical changes", () => {
    const document = circuit();
    Object.assign(document.parts[1]!, { capacitanceFarads: {} });
    expect(simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 }).status).toBe("valid");
    const before = simulationDocumentKey(document);
    expect(before).not.toBeNull();
    document.parts[1]!.resistanceOhms = 20;
    expect(simulationDocumentKey(document)).not.toBe(before);
  });

  it("invalidates a valid result when a solver-validated label becomes invalid", () => {
    const document = circuit();
    const before = simulationDocumentKey(document);
    Object.assign(document.parts[0]!, { label: {} });
    expect(simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 }).status).toBe("invalid");
    expect(simulationDocumentKey(document)).toBeNull();
    expect(before).not.toBeNull();
  });
});
