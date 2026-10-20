import { circuitPartNumericFields, type CircuitPart } from "../circuit-model.js";
import { partNumericValue } from "./part-numeric-field.js";
import { partSwitchValue } from "./part-switch-value.js";

/** Only the settings exposed by the preview determine whether a reset is needed. */
export function previewPartChanged(part: CircuitPart, initial?: CircuitPart) {
  if (!initial) { return true; }
  const numericChanged = circuitPartNumericFields(part.kind).some(({ key }) =>
    !Object.is(partNumericValue(part, key), partNumericValue(initial, key)));
  return numericChanged || (part.kind === "switch" &&
    partSwitchValue(part) !== partSwitchValue(initial));
}
