import { circuitPartCatalog, type CircuitPart, type CircuitPartNumericField } from "../circuit-model.js";
import { simulationRecordField } from "../simulation-input.js";

/** Include the other supply rail in the numeric domain used by both editing views. */
export function partNumericField(part: CircuitPart, field: CircuitPartNumericField): CircuitPartNumericField & { exclusiveMax?: boolean } {
  if (part.kind !== "op-amp") { return field; }
  const defaults = circuitPartCatalog["op-amp"].defaults;
  if (field.key === "positiveRailVolts") {
    return { ...field, min: (simulationRecordField(part, "negativeRailVolts") as number | undefined) ?? defaults.negativeRailVolts, exclusiveMin: true };
  }
  if (field.key === "negativeRailVolts") {
    return { ...field, max: (simulationRecordField(part, "positiveRailVolts") as number | undefined) ?? defaults.positiveRailVolts, exclusiveMax: true };
  }
  return field;
}
