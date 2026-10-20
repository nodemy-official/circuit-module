import { circuitPartCatalog, type CircuitPart } from "../circuit-model.js";

/** Distinguish malformed own switch values from omitted settings without running accessors. */
export function partSwitchValue(part: CircuitPart): boolean | null {
  const descriptor = Object.getOwnPropertyDescriptor(part, "initiallyClosed");
  if (descriptor && !Object.hasOwn(descriptor, "value")) { return null; }
  const value = descriptor?.value;
  if (value === undefined) { return circuitPartCatalog.switch.defaults.initiallyClosed ?? false; }
  return typeof value === "boolean" ? value : null;
}
