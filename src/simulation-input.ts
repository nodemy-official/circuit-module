import { circuitPartCatalog, type CircuitDocument, type CircuitPartKind, type CircuitTerminal } from "./circuit-model.js";

const simulationRecordFields = new Set([
  ...Object.values(circuitPartCatalog).flatMap(({ defaults }) => Object.keys(defaults)),
  "id", "kind", "label", "x", "y", "rotation", "title", "parts", "wires",
  "from", "to", "waypoints", "partId", "terminal", "mode", "frequencyHz",
  "switchStates", "voltageOverrides", "initialInductorCurrents", "durationSeconds",
  "timeStepSeconds", "startFromOperatingPoint",
]);

interface CapturedSimulationProperties {
  source: object;
  prototype: unknown;
  descriptors: PropertyDescriptorMap;
  expectedFields: readonly PropertyKey[];
}

function expectedFieldsAreListed(source: object, descriptors: PropertyDescriptorMap, expectedFields: readonly PropertyKey[]) {
  // ownKeys may omit configurable fields. Inspect descriptors without using
  // property reads, which could execute a getter installed by this very trap.
  return expectedFields.every((key) => Object.hasOwn(descriptors, key) || !Object.getOwnPropertyDescriptor(source, key));
}

function sameDataDescriptor(first: PropertyDescriptor, second: PropertyDescriptor | undefined) {
  return second !== undefined && Object.hasOwn(second, "value") &&
    Object.is(first.value, second.value) && first.enumerable === second.enumerable &&
    first.configurable === second.configurable && first.writable === second.writable;
}

function capturedPropertiesStillMatch(capture: CapturedSimulationProperties) {
  const { source, prototype, descriptors, expectedFields } = capture;
  if (Object.getPrototypeOf(source) !== prototype) { return false; }
  const current = Object.getOwnPropertyDescriptors(source);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== Reflect.ownKeys(current).length ||
      !expectedFieldsAreListed(source, current, expectedFields)) { return false; }
  return keys.every((key) => sameDataDescriptor(Reflect.get(descriptors, key), Reflect.get(current, key)));
}

/** One public call shares a context across its document, options and controls. */
export class SimulationSnapshotContext {
  private readonly captures: CapturedSimulationProperties[] = [];

  captureProperties(source: object, expectedFields: Iterable<PropertyKey>) {
    const prototype = Object.getPrototypeOf(source);
    const descriptors = Object.getOwnPropertyDescriptors(source);
    const fields = [...expectedFields];
    if (Reflect.ownKeys(descriptors).some((key) => !Object.hasOwn(Reflect.get(descriptors, key), "value")) ||
        !expectedFieldsAreListed(source, descriptors, fields)) { return null; }
    this.captures.push({ source, prototype, descriptors, expectedFields: fields });
    return { prototype, descriptors };
  }

  isStable() {
    try {
      // Recheck the entire input graph after capture, including earlier records
      // that a later record's descriptor/prototype trap could have changed.
      // Reverse order also checks earlier records after later verification traps.
      for (let index = this.captures.length - 1; index >= 0; index -= 1) {
        if (!capturedPropertiesStillMatch(this.captures[index]!)) { return false; }
      }
      return true;
    } catch {
      return false;
    }
  }
}

/** Own data descriptors are the only input values; caller `get` traps never run. */
export function snapshotSimulationRecord(
  value: unknown,
  expectedFields: Iterable<string> = simulationRecordFields,
  context?: SimulationSnapshotContext,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) { return null; }
  try {
    if (Array.isArray(value)) { return null; }
    const captureContext = context ?? new SimulationSnapshotContext();
    const capture = captureContext.captureProperties(value, expectedFields);
    if (!capture) { return null; }
    const { prototype, descriptors } = capture;
    if (prototype !== Object.prototype && prototype !== null) { return null; }
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (typeof key === "string") { entries.push([key, descriptor.value]); }
    }
    if (!context && !captureContext.isStable()) { return null; }
    return Object.fromEntries(entries);
  } catch {
    // A Proxy can throw from prototype or descriptor traps.
    // Treat it as malformed so public entry points can return `invalid`.
    return null;
  }
}

export function isSimulationRecord(value: unknown, expectedFields: Iterable<string> = simulationRecordFields): value is Record<string, unknown> {
  return snapshotSimulationRecord(value, expectedFields) !== null;
}

/** Checks array entries before iteration so indexed accessors are never called. */
function arrayOwnKeysAreIndexes(descriptors: object, length: number) {
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") { continue; }
    if (typeof key !== "string") { return false; }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return false;
    }
  }
  return true;
}

function snapshotArrayIndexes(
  descriptors: object,
  length: number,
) {
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      return null;
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function snapshotSimulationArray(value: unknown, context?: SimulationSnapshotContext): unknown[] | null {
  try {
    if (!Array.isArray(value)) { return null; }
    const captureContext = context ?? new SimulationSnapshotContext();
    const snapshot = snapshotSimulationArrayFromDescriptors(value, captureContext);
    return !context && !captureContext.isStable() ? null : snapshot;
  } catch {
    return null;
  }
}

function snapshotSimulationArrayFromDescriptors(value: unknown[], context: SimulationSnapshotContext) {
  const capture = context.captureProperties(value, Reflect.ownKeys(Array.prototype));
  if (!capture || capture.prototype !== Array.prototype) { return null; }
  const { descriptors } = capture;
  const lengthDescriptor = Reflect.get(descriptors, "length") as PropertyDescriptor | undefined;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number") { return null; }
  const length = lengthDescriptor.value as number;
  if (!Number.isInteger(length) || length < 0 || length > 0xff_ff_ff_ff ||
      !arrayOwnKeysAreIndexes(descriptors, length)) { return null; }
  // Iterate captured descriptors; no caller-owned map, entries or iterator runs.
  return snapshotArrayIndexes(descriptors, length);
}

export function isSimulationArray(value: unknown): value is unknown[] {
  return snapshotSimulationArray(value) !== null;
}

/** Reads a record's own data property without invoking a Proxy `get` trap. */
export function simulationRecordField(record: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

/** Includes non-enumerable own data fields in validation and snapshots. */
export function simulationRecordEntries(record: object): [string, unknown][] {
  return Object.getOwnPropertyNames(record).map((key) => [key, simulationRecordField(record, key)]);
}

/** Captures the simulation graph before any shape or numeric validation reads it. */
export function snapshotSimulationDocument(input: unknown, context?: SimulationSnapshotContext): Record<string, unknown> | null {
  const captureContext = context ?? new SimulationSnapshotContext();
  const document = snapshotSimulationRecord(input, undefined, captureContext);
  if (!document) { return null; }
  const parts = snapshotSimulationArray(document.parts, captureContext);
  const wires = snapshotSimulationArray(document.wires, captureContext);
  const snapshot = {
    ...document,
    parts: parts?.map((part) => snapshotSimulationRecord(part, undefined, captureContext)) ?? null,
    wires: wires?.map((value) => {
      const wire = snapshotSimulationRecord(value, undefined, captureContext);
      return wire ? { ...wire, from: snapshotSimulationRecord(wire.from, undefined, captureContext), to: snapshotSimulationRecord(wire.to, undefined, captureContext) } : null;
    }) ?? null,
  };
  return !context && !captureContext.isStable() ? null : snapshot;
}

/** Returns a fresh validated copy; no caller-owned fields are read after capture. */
export function copySimulationDocument(document: CircuitDocument): CircuitDocument {
  const snapshot = validatedSimulationDocument(document);
  if (typeof snapshot === "string") { throw new Error(snapshot); }
  return snapshot;
}

/** The shape validator and solver share this copy, never the caller's object. */
export function validatedSimulationDocument(input: unknown, context?: SimulationSnapshotContext): CircuitDocument | string {
  const snapshot = snapshotSimulationDocument(input, context);
  const issue = capturedDocumentShapeIssue(snapshot);
  return issue ?? snapshot as unknown as CircuitDocument;
}

/** Checks the object shape used before the numeric validators run. */
export function circuitDocumentShapeIssue(input: unknown): string | null {
  const snapshot = validatedSimulationDocument(input);
  return typeof snapshot === "string" ? snapshot : null;
}

function capturedDocumentShapeIssue(input: unknown): string | null {
  try {
    if (!isSimulationRecord(input) || !isSimulationArray(input.parts) || !isSimulationArray(input.wires)) {
      return "回路データには部品一覧と導線一覧が必要です。";
    }
    const parts = partKindsAndIssue(input.parts);
    return parts.issue ?? wireShapeIssue(input.wires, parts.kinds);
  } catch {
    return "回路データの部品一覧または導線一覧を読み取れません。";
  }
}

function partKindsAndIssue(values: unknown[]): { kinds: Map<string, CircuitPartKind>; issue: string | null } {
  const kinds = new Map<string, CircuitPartKind>();
  for (const [index, value] of values.entries()) {
    if (!isSimulationRecord(value) || typeof value.id !== "string" || value.id.trim() === "") {
      return { kinds, issue: `部品${index + 1}の ID が正しくありません。` };
    }
    if (value.label !== undefined && typeof value.label !== "string") {
      return { kinds, issue: `部品「${value.id}」の名前が正しくありません。` };
    }
    if (kinds.has(value.id)) { return { kinds, issue: "部品 ID が重複しています。" }; }
    if (typeof value.kind !== "string" || !Object.hasOwn(circuitPartCatalog, value.kind)) {
      const label = typeof value.label === "string" ? value.label : value.id;
      return { kinds, issue: `${label}の部品種類を認識できません。` };
    }
    kinds.set(value.id, value.kind as CircuitPartKind);
  }
  return { kinds, issue: null };
}

function wireShapeIssue(values: unknown[], kinds: ReadonlyMap<string, CircuitPartKind>) {
  const wireIds = new Set<string>();
  const wireEndpointPairs = new Set<string>();
  for (const [index, wire] of values.entries()) {
    if (!isSimulationRecord(wire) || typeof wire.id !== "string" || wire.id.trim() === "") {
      return `導線${index + 1}の ID が正しくありません。`;
    }
    if (wireIds.has(wire.id)) { return "導線 ID が重複しています。"; }
    wireIds.add(wire.id);
    const fromIssue = endpointShapeIssue(wire.from, kinds, `導線${index + 1}の始点`);
    if (fromIssue) { return fromIssue; }
    const toIssue = endpointShapeIssue(wire.to, kinds, `導線${index + 1}の終点`);
    if (toIssue) { return toIssue; }
    if (sameEndpoint(wire.from, wire.to)) {
      return `導線${index + 1}は同じ端子同士を接続しています。`;
    }
    const endpointPair = unorderedWireKey(wire.from, wire.to);
    if (wireEndpointPairs.has(endpointPair)) {
      return `導線${index + 1}は既存の導線と同じ端子間を接続しています。`;
    }
    wireEndpointPairs.add(endpointPair);
  }
  return null;
}

function endpointShapeIssue(
  value: unknown,
  kinds: ReadonlyMap<string, CircuitPartKind>,
  description: string,
) {
  if (!isSimulationRecord(value) || typeof value.partId !== "string" ||
      (value.terminal !== "a" && value.terminal !== "b" && value.terminal !== "c")) {
    return `${description}の端子指定が正しくありません。`;
  }
  const kind = kinds.get(value.partId);
  if (!kind) { return `${description}の部品「${value.partId}」が見つかりません。`; }
  if (!circuitPartCatalog[kind].terminals.includes(value.terminal as CircuitTerminal)) {
    return `${description}の端子「${value.terminal}」はこの部品にありません。`;
  }
  return null;
}

function sameEndpoint(first: unknown, second: unknown) {
  return isSimulationRecord(first) && isSimulationRecord(second) &&
    first.partId === second.partId && first.terminal === second.terminal;
}

function unorderedWireKey(first: unknown, second: unknown) {
  const endpoints = [endpointKey(first), endpointKey(second)].sort();
  return JSON.stringify(endpoints);
}

function endpointKey(value: unknown) {
  if (!isSimulationRecord(value)) { return ""; }
  return JSON.stringify([value.partId, value.terminal]);
}
