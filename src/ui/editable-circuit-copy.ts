import { circuitPartCatalog, circuitPartNumericFields, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../circuit-model.js";
import { simulationRecordField } from "../simulation-input.js";

const editableArrayBuiltins = Reflect.ownKeys(Array.prototype).filter((key) => key !== "length");

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

const editableRecordFields = [...new Set([
  ...Object.values(circuitPartCatalog).flatMap(({ defaults }) => Object.keys(defaults)),
  "id", "kind", "label", "x", "y", "rotation", "title", "parts", "wires",
  "from", "to", "waypoints", "routeAnchors", "xBoundary", "yBoundary", "partId", "terminal",
])];

interface EditableCapture {
  source: object;
  prototype: unknown;
  descriptors: PropertyDescriptorMap;
  missingFields: readonly PropertyKey[];
}

function sameEditableDescriptor(before: PropertyDescriptor, after: PropertyDescriptor | undefined) {
  if (!after || before.enumerable !== after.enumerable || before.configurable !== after.configurable ||
      Object.hasOwn(before, "value") !== Object.hasOwn(after, "value")) { return false; }
  return Object.hasOwn(before, "value")
    ? before.writable === after.writable && Object.is(before.value, after.value)
    : before.get === after.get && before.set === after.set;
}

/** Editing retains accessors as descriptors; solver snapshots intentionally reject them. */
class EditableSnapshotContext {
  private readonly captures: EditableCapture[] = [];

  capture(source: object, fields: readonly PropertyKey[] = editableRecordFields) {
    try {
      const prototype = Object.getPrototypeOf(source);
      const descriptors = Object.getOwnPropertyDescriptors(source);
      const missingFields: PropertyKey[] = [];
      for (const field of fields) {
        if (Object.hasOwn(descriptors, field)) { continue; }
        if (Object.getOwnPropertyDescriptor(source, field)) { return null; }
        missingFields.push(field);
      }
      this.captures.push({ source, prototype, descriptors, missingFields });
      return { prototype, descriptors: { ...descriptors } };
    } catch { return null; }
  }

  isStable() {
    try {
      for (let index = this.captures.length - 1; index >= 0; index -= 1) {
        const { source, prototype, descriptors, missingFields } = this.captures[index]!;
        if (Object.getPrototypeOf(source) !== prototype) { return false; }
        const current = Object.getOwnPropertyDescriptors(source);
        const keys = Reflect.ownKeys(descriptors);
        if (keys.length !== Reflect.ownKeys(current).length ||
            keys.some((key) => !sameEditableDescriptor(Reflect.get(descriptors, key), Reflect.get(current, key))) ||
            missingFields.some((field) => Object.getOwnPropertyDescriptor(source, field))) { return false; }
      }
      return true;
    } catch { return false; }
  }
}

function editableRecordDescriptors(value: unknown, context: EditableSnapshotContext) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { return null; }
    const captured = context.capture(value);
    if (!captured || captured.prototype !== Object.prototype && captured.prototype !== null) { return null; }
    const { descriptors } = captured;
    // Own data must survive later editor spreads, including hidden and frozen
    // input fields. Accessors keep their descriptors without being evaluated.
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (Object.hasOwn(descriptor, "value")) {
        Reflect.set(descriptors, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
      }
    }
    return descriptors;
  } catch { return null; }
}

function snapshotEditableArray(value: unknown, context: EditableSnapshotContext, copy: (entry: unknown) => unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) { return null; }
    const captured = context.capture(value, Reflect.ownKeys(Array.prototype));
    if (!captured || captured.prototype !== Array.prototype) { return null; }
    const { descriptors } = captured;
    const length = descriptors.length?.value;
    if (!Number.isInteger(length) || length < 0 || length > 0xff_ff_ff_ff) { return null; }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") { continue; }
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < 0xff_ff_ff_ff && String(index) === key && index >= length) { return null; }
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) { return null; }
    }
    for (let index = 0; index < length; index += 1) {
      descriptors[index] = { value: copy(descriptors[index]!.value), enumerable: true, configurable: true, writable: true };
    }
    // Caller methods must never become the editor's iteration or lookup code.
    // Ordinary metadata keeps its descriptor and reference; only indexed data
    // is traversed, without invoking caller methods or getters.
    for (const key of editableArrayBuiltins) { Reflect.deleteProperty(descriptors, key); }
    descriptors.length = { value: length, enumerable: false, configurable: false, writable: true };
    return Object.defineProperties([], descriptors);
  } catch { return null; }
}

function replaceEditableData(descriptors: PropertyDescriptorMap, key: string, copy: (value: unknown) => unknown) {
  const descriptor = descriptors[key];
  if (descriptor && Object.hasOwn(descriptor, "value")) {
    descriptors[key] = { ...descriptor, value: copy(descriptor.value) };
  }
}

function snapshotEditableRecord(value: unknown, context: EditableSnapshotContext): unknown {
  const descriptors = editableRecordDescriptors(value, context);
  return descriptors ? Object.defineProperties({}, descriptors) : value;
}

function snapshotEditableRecords(value: unknown, context: EditableSnapshotContext): unknown {
  return snapshotEditableArray(value, context, (entry) => snapshotEditableRecord(entry, context)) ?? value;
}

function snapshotEditableWire(value: unknown, context: EditableSnapshotContext): unknown {
  const descriptors = editableRecordDescriptors(value, context);
  if (!descriptors) { return value; }
  for (const key of ["from", "to"]) {
    replaceEditableData(descriptors, key, (endpoint) => snapshotEditableRecord(endpoint, context));
  }
  for (const key of ["waypoints", "routeAnchors"]) {
    replaceEditableData(descriptors, key, (points) => snapshotEditableRecords(points, context));
  }
  return Object.defineProperties({}, descriptors);
}

/** Copy known own data independently while retaining getters and unknown host metadata. */
export function snapshotEditableDocument(document: CircuitDocument): CircuitDocument {
  const context = new EditableSnapshotContext();
  const descriptors = editableRecordDescriptors(document, context);
  if (!descriptors) { throw new TypeError("回路データは読み取り可能なオブジェクトで指定してください。"); }
  for (const [key, label, copy] of [
    ["parts", "部品一覧", (part: unknown) => snapshotEditableRecord(part, context)],
    ["wires", "導線一覧", (wire: unknown) => snapshotEditableWire(wire, context)],
  ] as const) {
    const descriptor = descriptors[key];
    const values = descriptor && Object.hasOwn(descriptor, "value")
      ? snapshotEditableArray(descriptor.value, context, copy) : null;
    if (!values) { throw new TypeError(`${label}は各要素を own data property で持つ、欠落のない配列で指定してください。`); }
    descriptors[key] = { ...descriptor, value: values };
  }
  // Assemble descriptors before definition so frozen, nonwritable fields can
  // receive independent child copies without ever writing to caller objects.
  if (!context.isStable()) { throw new TypeError("回路データが取得中に変更されました。"); }
  return Object.defineProperties({}, descriptors) as CircuitDocument;
}

/** Preserve invalid settings as data so ordinary editor commands never evaluate their getters. */
export function normalizeEditableAccessors(document: CircuitDocument): CircuitDocument {
  try {
    const inputParts = simulationRecordField(document, "parts");
    const context = new EditableSnapshotContext();
    const parts = snapshotEditableArray(inputParts, context, (part) => part);
    if (!parts) { return document; }
    let changed = editableArrayBuiltins.some((key) => Object.hasOwn(inputParts, key));
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (typeof part !== "object" || part === null) { continue; }
      const prototype = Object.getPrototypeOf(part);
      if (prototype !== Object.prototype && prototype !== null) { continue; }
      const kind = simulationRecordField(part, "kind");
      if (typeof kind !== "string" || !Object.hasOwn(circuitPartCatalog, kind)) { continue; }
      const hasAccessor = editableFields(kind as CircuitPartKind).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(part, key);
        return descriptor !== undefined && !Object.hasOwn(descriptor, "value");
      });
      if (!hasAccessor) { continue; }
      changed = true;
      parts[index] = copyEditablePart(part as CircuitPart);
    }
    if (!context.isStable()) { return document; }
    return changed ? copyEditableDocument(document, parts as CircuitPart[]) : document;
  } catch {
    return document;
  }
}
