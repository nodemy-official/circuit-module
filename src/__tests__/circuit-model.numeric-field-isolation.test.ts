import { describe, expect, it } from "vitest";
import { circuitPartNumericFields, type CircuitDocument } from "../circuit-model.js";
import { parseCircuitDocument } from "../circuit-serialization.js";

describe("numeric field metadata isolation", () => {
  it("keeps form-specific resistance bounds from changing file validation", () => {
    const field = circuitPartNumericFields("resistor").find((item) => item.key === "resistanceOhms")!;
    const original = { ...field };
    const document: CircuitDocument = {
      title: "invalid resistance",
      parts: [{ id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 0 }],
      wires: [],
    };
    try {
      field.min = -10;
      field.exclusiveMin = false;
      expect(parseCircuitDocument(JSON.stringify(document)).ok).toBe(false);
      expect(circuitPartNumericFields("bulb").find((item) => item.key === "resistanceOhms"))
        .toMatchObject({ min: 0, exclusiveMin: true });
    } finally { Object.assign(field, original); }
  });

  it("keeps custom field labels and keys local to the caller", () => {
    const field = circuitPartNumericFields("capacitor").find((item) => item.key === "initialVoltageVolts")!;
    const original = { ...field };
    try {
      field.key = "voltageVolts";
      field.label = "custom voltage";
      expect(circuitPartNumericFields("capacitor").map((item) => [item.key, item.label]))
        .toContainEqual(["initialVoltageVolts", "初期電圧（過渡）"]);
    } finally { Object.assign(field, original); }
  });
});
