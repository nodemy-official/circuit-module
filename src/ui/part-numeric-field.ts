import { circuitPartCatalog, type CircuitPart, type CircuitPartNumericField } from "../circuit-model.js";
import { simulationRecordField } from "../simulation-input.js";

/** Include the other supply rail in the numeric domain used by both editing views. */
export function partNumericField(part: CircuitPart, field: CircuitPartNumericField): CircuitPartNumericField & { exclusiveMax?: boolean } {
  if (part.kind !== "op-amp") { return field; }
  const defaults = circuitPartCatalog["op-amp"].defaults;
  if (field.key === "positiveRailVolts") {
    const opposite = simulationRecordField(part, "negativeRailVolts");
    // An invalid source value must not remove every finite repair candidate.
    const min = typeof opposite === "number" && Number.isFinite(opposite) && opposite < Number.MAX_VALUE
      ? opposite : defaults.negativeRailVolts;
    return { ...field, min, exclusiveMin: true };
  }
  if (field.key === "negativeRailVolts") {
    const opposite = simulationRecordField(part, "positiveRailVolts");
    const max = typeof opposite === "number" && Number.isFinite(opposite) && opposite > -Number.MAX_VALUE
      ? opposite : defaults.positiveRailVolts;
    return { ...field, max, exclusiveMax: true };
  }
  return field;
}
