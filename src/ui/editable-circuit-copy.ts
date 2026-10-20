import { circuitPartCatalog, circuitPartNumericFields, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../circuit-model.js";
import { simulationRecordField, snapshotSimulationArray } from "../simulation-input.js";

function editableFields(kind: CircuitPartKind): string[] {
  const fields: string[] = circuitPartNumericFields(kind).map(({ key }) => key);
  if (kind === "switch") { fields.push("initiallyClosed"); }
  return fields;
}

/** Copy editable settings without evaluating caller-owned numeric or switch accessors. */
export function copyEditablePart(part: CircuitPart, patch: Partial<CircuitPart> = {}): CircuitPart {
  const descriptors = Object.getOwnPropertyDescriptors(part);
  const kind = descriptors.kind?.value;
  for (const key of kind === undefined ? [] : editableFields(kind)) {
    const descriptor = descriptors[key];
    if (!descriptor) { continue; }
    descriptors[key] = {
      value: Object.hasOwn(descriptor, "value") ? descriptor.value : key === "initiallyClosed" ? null : Number.NaN,
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    };
  }
  for (const [key, value] of Object.entries(patch)) {
    descriptors[key] = { value, enumerable: true, configurable: true, writable: true };
  }
  return Object.defineProperties({}, descriptors) as CircuitPart;
}

export function copyEditableDocument(document: CircuitDocument, parts = document.parts.map((part) => copyEditablePart(part))): CircuitDocument {
  const descriptors = Object.getOwnPropertyDescriptors(document);
  descriptors.parts = { value: parts, enumerable: descriptors.parts?.enumerable ?? true, configurable: true, writable: true };
  return Object.defineProperties({}, descriptors) as CircuitDocument;
}

/** Preserve invalid settings as data so ordinary editor commands never evaluate their getters. */
export function normalizeEditableAccessors(document: CircuitDocument): CircuitDocument {
  try {
    const parts = snapshotSimulationArray(simulationRecordField(document, "parts"));
    if (!parts) { return document; }
    let changed = false;
    const normalized = parts.map((part) => {
      if (typeof part !== "object" || part === null) { return part; }
      const prototype = Object.getPrototypeOf(part);
      if (prototype !== Object.prototype && prototype !== null) { return part; }
      const kind = simulationRecordField(part, "kind");
      if (typeof kind !== "string" || !Object.hasOwn(circuitPartCatalog, kind)) { return part; }
      const hasAccessor = editableFields(kind as CircuitPartKind).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(part, key);
        return descriptor !== undefined && !Object.hasOwn(descriptor, "value");
      });
      if (!hasAccessor) { return part; }
      changed = true;
      return copyEditablePart(part as CircuitPart);
    });
    return changed ? copyEditableDocument(document, normalized as CircuitPart[]) : document;
  } catch {
    return document;
  }
}
