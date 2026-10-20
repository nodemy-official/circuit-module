import { circuitPartCatalog, type CircuitPart, type CircuitPartNumericField, type CircuitPartNumericKey } from "../circuit-model.js";
import { simulationNumericField, simulationRecordField } from "../simulation-input.js";

/** Only omitted values use defaults; malformed own values must remain repairable. */
export function partNumericValue(part: CircuitPart, key: CircuitPartNumericKey): number | undefined {
  return simulationNumericField(part, key) ?? circuitPartCatalog[part.kind].defaults[key] as number | undefined;
}

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
