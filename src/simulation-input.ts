import { circuitPartCatalog, type CircuitPartKind, type CircuitTerminal } from "./circuit-model.js";

export function isSimulationRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) { return false; }
  try {
    if (Array.isArray(value)) { return false; }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) { return false; }
    // Simulation input is data, so reject accessors before later validators or
    // catalog defaulting read fields and invoke caller-provided code.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (descriptor.get || descriptor.set || Reflect.get(value, key) !== descriptor.value) { return false; }
    }
    return true;
  } catch {
    // A Proxy can throw from prototype, descriptor, or property read traps.
    // Treat it as malformed so public entry points can return `invalid`.
    return false;
  }
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

function usesNativeArrayMethods(value: unknown[]) {
  for (const key of Reflect.ownKeys(Array.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      continue;
    }
    if (Reflect.get(value, key) !== descriptor.value) { return false; }
  }
  return true;
}

function arrayIndexesMatchDescriptors(
  value: unknown[],
  descriptors: object,
  length: number,
) {
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
    if (!descriptor || !Object.hasOwn(descriptor, "value") || Reflect.get(value, key) !== descriptor.value) {
      return false;
    }
  }
  return true;
}

function hasValidSimulationArrayShape(value: unknown[]) {
  if (Object.getPrototypeOf(value) !== Array.prototype) { return false; }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Reflect.get(descriptors, "length") as PropertyDescriptor | undefined;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number") { return false; }
  const length = lengthDescriptor.value as number;
  return arrayOwnKeysAreIndexes(descriptors, length) &&
    Reflect.get(value, "length") === length &&
    usesNativeArrayMethods(value) &&
    arrayIndexesMatchDescriptors(value, descriptors, length);
}

export function isSimulationArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) { return false; }
  try {
    return hasValidSimulationArrayShape(value);
  } catch {
    return false;
  }
}

/** Reads a record's own data property without invoking a Proxy `get` trap. */
export function simulationRecordField(record: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

/** Checks the object shape used before the numeric validators run. */
export function circuitDocumentShapeIssue(input: unknown): string | null {
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
