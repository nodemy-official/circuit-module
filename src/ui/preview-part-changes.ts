import { circuitPartCatalog, circuitPartNumericFields, type CircuitPart } from "../circuit-model.js";
import { simulationRecordField } from "../simulation-input.js";

/** Only the settings exposed by the preview determine whether a reset is needed. */
export function previewPartChanged(part: CircuitPart, initial?: CircuitPart) {
  if (!initial) { return true; }
  const defaults = circuitPartCatalog[part.kind].defaults;
  const numericChanged = circuitPartNumericFields(part.kind).some(({ key }) =>
    !Object.is(simulationRecordField(part, key) ?? defaults[key], simulationRecordField(initial, key) ?? defaults[key]));
  return numericChanged || (part.kind === "switch" &&
    (simulationRecordField(part, "initiallyClosed") ?? defaults.initiallyClosed) !== (simulationRecordField(initial, "initiallyClosed") ?? defaults.initiallyClosed));
}
