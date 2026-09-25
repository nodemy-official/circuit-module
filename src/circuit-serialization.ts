import {
  circuitPartKinds,
  circuitPartNumericFields,
  MAX_CIRCUIT_WIRE_WAYPOINTS,
  terminalsOf,
  type CircuitPartNumericKey,
} from "./circuit-model.js";
import { MAX_WIRE_COORDINATE } from "./circuit-geometry.js";
import type {
  CircuitDocument,
  CircuitEndpoint,
  CircuitPart,
  CircuitPartKind,
  CircuitRotation,
  CircuitTerminal,
  CircuitWire,
} from "./circuit-model.js";

const DOCUMENT_FORMAT = "circuit-module";
const DOCUMENT_VERSION = 1;
export const MAX_CIRCUIT_DOCUMENT_COORDINATE = MAX_WIRE_COORDINATE;

/** JSON text limit for saving or loading a circuit document, measured in JavaScript string characters. */
export const MAX_CIRCUIT_DOCUMENT_JSON_LENGTH = 1_000_000;
/** Maximum number of parts accepted in one circuit document. */
export const MAX_CIRCUIT_DOCUMENT_PARTS = 10_000;
/** Maximum number of wires accepted in one circuit document. */
export const MAX_CIRCUIT_DOCUMENT_WIRES = 20_000;
/** Maximum number of stored route points on a single wire. */
export const MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS = MAX_CIRCUIT_WIRE_WAYPOINTS;

const rotations: readonly CircuitRotation[] = [0, 90, 180, 270];
const knownKinds = new Set<string>(circuitPartKinds);

type ValidationResult =
  | { ok: true; document: CircuitDocument }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

function checkString(value: unknown, description: string, allowEmpty: boolean): string | null {
  if (typeof value !== "string") { return `${description}は文字列で指定してください。`; }
  if (!allowEmpty && value.trim().length === 0) { return `${description}を空にできません。`; }
  return null;
}

const allNumericKeys = new Set<CircuitPartNumericKey>(
  circuitPartKinds.flatMap((kind) => circuitPartNumericFields(kind).map(({ key }) => key)),
);
const fallbackNumericFields = new Map<CircuitPartNumericKey, ReturnType<typeof circuitPartNumericFields>[number]>();
for (const kind of circuitPartKinds) {
  for (const field of circuitPartNumericFields(kind)) {
    if (!fallbackNumericFields.has(field.key)) { fallbackNumericFields.set(field.key, field); }
  }
}

function fieldForPart(kind: CircuitPartKind, key: CircuitPartNumericKey) {
  return circuitPartNumericFields(kind).find((item) => item.key === key) ?? fallbackNumericFields.get(key);
}

function validateNumericValue(value: unknown, field: ReturnType<typeof circuitPartNumericFields>[number] | undefined, key: CircuitPartNumericKey, label: string) {
  const fieldLabel = field?.label ?? key;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${label}の${fieldLabel}は有限な数値で指定してください。`;
  }
  if (field?.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) {
    const comparison = field.exclusiveMin ? "より大きい" : "以上";
    return `${label}の${fieldLabel}は${field.min}${field.unit} ${comparison}で指定してください。`;
  }
  if (field?.max !== undefined && value > field.max) {
    return `${label}の${fieldLabel}は${field.max}${field.unit}以下で指定してください。`;
  }
  return null;
}

function validateNumericPartFields(candidate: Record<string, unknown>, kind: CircuitPartKind, label: string) {
  for (const key of allNumericKeys) {
    const value = candidate[key];
    if (value === undefined) { continue; }
    const issue = validateNumericValue(value, fieldForPart(kind, key), key, label);
    if (issue) { return issue; }
  }
  return null;
}

function validateEndpoint(
  value: unknown,
  side: string,
  partsById: ReadonlyMap<string, CircuitPart>,
): { endpoint?: CircuitEndpoint; reason?: string } {
  if (!isRecord(value)) { return { reason: `${side}の接続先の形式が正しくありません。` }; }
  const { partId, terminal } = value;
  if (typeof partId !== "string" || partId.trim().length === 0) {
    return { reason: `${side}の接続先部品 ID が正しくありません。` };
  }
  if (terminal !== "a" && terminal !== "b" && terminal !== "c") {
    return { reason: `${side}の端子は「a」「b」「c」のいずれかで指定してください。` };
  }
  const part = partsById.get(partId);
  if (!part) { return { reason: `${side}の接続先部品「${partId}」が見つかりません。` }; }
  if (!terminalsOf(part.kind).includes(terminal as CircuitTerminal)) {
    return { reason: `${part.label || part.id}には端子「${terminal}」がありません。` };
  }
  return { endpoint: { partId, terminal: terminal as CircuitTerminal } };
}

function endpointKey(endpoint: CircuitEndpoint) {
  return JSON.stringify([endpoint.partId, endpoint.terminal]);
}

function unorderedWireKey(from: CircuitEndpoint, to: CircuitEndpoint) {
  const keys = [endpointKey(from), endpointKey(to)].sort();
  return JSON.stringify(keys);
}

function validateOptionalPartValues(candidate: Record<string, unknown>, kind: CircuitPartKind, label: string): string | null {
  const numberIssue = validateNumericPartFields(candidate, kind, label);
  if (numberIssue) { return numberIssue; }
  if (candidate.initiallyClosed !== undefined && typeof candidate.initiallyClosed !== "boolean") {
    return `${label}のスイッチ状態は真偽値で指定してください。`;
  }
  if (kind === "op-amp") {
    const positive = typeof candidate.positiveRailVolts === "number" ? candidate.positiveRailVolts : 15;
    const negative = typeof candidate.negativeRailVolts === "number" ? candidate.negativeRailVolts : -15;
    if (negative >= positive) { return `${label}の負側電源は正側電源より低くしてください。`; }
  }
  return null;
}

function validatePartShape(candidate: Record<string, unknown>, label: string): string | null {
  if (typeof candidate.kind !== "string" || !knownKinds.has(candidate.kind)) {
    return `${label}の種類が不明です。`;
  }
  if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x)) {
    return `${label}の x 座標は有限な数値で指定してください。`;
  }
  if (Math.abs(candidate.x) > MAX_CIRCUIT_DOCUMENT_COORDINATE) {
    return `${label}の x 座標は±${MAX_CIRCUIT_DOCUMENT_COORDINATE}セル以内で指定してください。`;
  }
  if (typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) {
    return `${label}の y 座標は有限な数値で指定してください。`;
  }
  if (Math.abs(candidate.y) > MAX_CIRCUIT_DOCUMENT_COORDINATE) {
    return `${label}の y 座標は±${MAX_CIRCUIT_DOCUMENT_COORDINATE}セル以内で指定してください。`;
  }
  const labelIssue = checkString(candidate.label, `${label}のラベル`, true);
  if (labelIssue) { return labelIssue; }
  if (candidate.rotation !== undefined &&
    (typeof candidate.rotation !== "number" || !rotations.includes(candidate.rotation as CircuitRotation))) {
    return `${label}の回転角度は0、90、180、270のいずれかで指定してください。`;
  }
  return validateOptionalPartValues(candidate, candidate.kind as CircuitPartKind, label);
}

function normalizePart(
  candidate: unknown,
  index: number,
  ids: Set<string>,
): { part?: CircuitPart; reason?: string } {
  const label = `部品${index + 1}`;
  if (!isRecord(candidate)) { return { reason: `${label}の形式が正しくありません。` }; }
  const idIssue = checkString(candidate.id, `${label}の ID`, false);
  if (idIssue) { return { reason: idIssue }; }
  const id = candidate.id as string;
  if (ids.has(id)) { return { reason: `部品 ID「${id}」が重複しています。` }; }
  ids.add(id);
  const shapeIssue = validatePartShape(candidate, label);
  if (shapeIssue) { return { reason: shapeIssue }; }

  const part: CircuitPart = {
    id,
    kind: candidate.kind as CircuitPartKind,
    x: candidate.x as number,
    y: candidate.y as number,
    label: candidate.label as string,
  };
  if (candidate.rotation !== undefined) { part.rotation = candidate.rotation as CircuitRotation; }
  const normalizedValues = part as unknown as Record<string, unknown>;
  for (const key of allNumericKeys) {
    if (candidate[key] !== undefined) { normalizedValues[key] = candidate[key]; }
  }
  if (candidate.initiallyClosed !== undefined) { part.initiallyClosed = candidate.initiallyClosed as boolean; }
  return { part };
}

function normalizeParts(value: unknown): { parts?: CircuitPart[]; reason?: string } {
  if (!Array.isArray(value)) { return { reason: "部品一覧は配列で指定してください。" }; }
  if (value.length > MAX_CIRCUIT_DOCUMENT_PARTS) {
    return { reason: `部品数は${MAX_CIRCUIT_DOCUMENT_PARTS}個以下にしてください。` };
  }
  const ids = new Set<string>();
  const parts: CircuitPart[] = [];
  for (const [index, candidate] of value.entries()) {
    const result = normalizePart(candidate, index, ids);
    if (result.reason) { return { reason: result.reason }; }
    if (result.part) { parts.push(result.part); }
  }
  return { parts };
}

function normalizeWireWaypoints(value: unknown, label: string): { waypoints?: { x: number; y: number }[]; reason?: string } {
  if (value === undefined) { return {}; }
  if (!Array.isArray(value)) { return { reason: `${label}の経由点は配列で指定してください。` }; }
  if (value.length > MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS) {
    return { reason: `${label}の経由点は${MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS}個以下にしてください。` };
  }
  const waypoints: { x: number; y: number }[] = [];
  for (const [index, candidate] of value.entries()) {
    const waypointLabel = `${label}の経由点${index + 1}`;
    if (!isRecord(candidate)) { return { reason: `${waypointLabel}の形式が正しくありません。` }; }
    const point: { x: number; y: number } = { x: 0, y: 0 };
    for (const axis of ["x", "y"] as const) {
      const coordinate = candidate[axis];
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        return { reason: `${waypointLabel}の${axis}座標は有限な数値で指定してください。` };
      }
      if (Math.abs(coordinate) > MAX_CIRCUIT_DOCUMENT_COORDINATE) {
        return { reason: `${waypointLabel}の${axis}座標は±${MAX_CIRCUIT_DOCUMENT_COORDINATE}セル以内で指定してください。` };
      }
      point[axis] = coordinate;
    }
    waypoints.push(point);
  }
  return waypoints.length > 0 ? { waypoints } : {};
}

function normalizeWire(
  candidate: unknown,
  index: number,
  partsById: ReadonlyMap<string, CircuitPart>,
  wireIds: Set<string>,
  seenWireKeys: Set<string>,
): { wire?: CircuitWire; reason?: string } {
  const label = `導線${index + 1}`;
  if (!isRecord(candidate)) { return { reason: `${label}の形式が正しくありません。` }; }
  const idIssue = checkString(candidate.id, `${label}の ID`, false);
  if (idIssue) { return { reason: idIssue }; }
  const id = candidate.id as string;
  if (wireIds.has(id)) { return { reason: `導線 ID「${id}」が重複しています。` }; }
  wireIds.add(id);

  const fromResult = validateEndpoint(candidate.from, `${label}の始点`, partsById);
  if (fromResult.reason || !fromResult.endpoint) {
    return { reason: fromResult.reason ?? `${label}の始点が不正です。` };
  }
  const toResult = validateEndpoint(candidate.to, `${label}の終点`, partsById);
  if (toResult.reason || !toResult.endpoint) {
    return { reason: toResult.reason ?? `${label}の終点が不正です。` };
  }
  const { endpoint: from } = fromResult;
  const { endpoint: to } = toResult;
  if (from.partId === to.partId) {
    const part = partsById.get(from.partId);
    if (!part || terminalsOf(part.kind).length < 3) {
      return { reason: `${label}は同じ部品の端子同士を接続しています。` };
    }
  }
  const wireKey = unorderedWireKey(from, to);
  if (seenWireKeys.has(wireKey)) { return { reason: `${label}は既存の導線と同じ端子間を接続しています。` }; }
  seenWireKeys.add(wireKey);
  const waypointResult = normalizeWireWaypoints(candidate.waypoints, label);
  if (waypointResult.reason) { return { reason: waypointResult.reason }; }
  const wire: CircuitWire = { id, from, to };
  if (waypointResult.waypoints) { wire.waypoints = waypointResult.waypoints; }
  return { wire };
}

function normalizeWires(value: unknown, parts: readonly CircuitPart[]): { wires?: CircuitWire[]; reason?: string } {
  if (!Array.isArray(value)) { return { reason: "導線一覧は配列で指定してください。" }; }
  if (value.length > MAX_CIRCUIT_DOCUMENT_WIRES) {
    return { reason: `導線数は${MAX_CIRCUIT_DOCUMENT_WIRES}本以下にしてください。` };
  }
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const ids = new Set<string>();
  const seenWireKeys = new Set<string>();
  const wires: CircuitWire[] = [];
  for (const [index, candidate] of value.entries()) {
    const result = normalizeWire(candidate, index, partsById, ids, seenWireKeys);
    if (result.reason) { return { reason: result.reason }; }
    if (result.wire) { wires.push(result.wire); }
  }
  return { wires };
}

function validateDocument(value: unknown): ValidationResult {
  if (!isRecord(value)) { return fail("回路データはオブジェクトで指定してください。"); }
  const titleIssue = checkString(value.title, "回路名", true);
  if (titleIssue) { return fail(titleIssue); }
  const partsResult = normalizeParts(value.parts);
  if (partsResult.reason || !partsResult.parts) { return fail(partsResult.reason ?? "部品一覧が不正です。"); }
  const wiresResult = normalizeWires(value.wires, partsResult.parts);
  if (wiresResult.reason || !wiresResult.wires) { return fail(wiresResult.reason ?? "導線一覧が不正です。"); }
  return { ok: true, document: { title: value.title as string, parts: partsResult.parts, wires: wiresResult.wires } };
}

/**
 * Encodes a validated circuit as a versioned JSON document. Unknown object properties are dropped.
 * Throws when the input is invalid or the encoded document exceeds the public text limit.
 */
export function serializeCircuitDocument(document: CircuitDocument): string {
  const validation = validateDocument(document as unknown);
  if (!validation.ok) { throw new TypeError(`回路を保存できません。${validation.reason}`); }
  const json = JSON.stringify({
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    document: validation.document,
  }, null, 2);
  if (json.length > MAX_CIRCUIT_DOCUMENT_JSON_LENGTH) {
    throw new RangeError(`保存データは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`);
  }
  return json;
}

/** Reads a versioned circuit JSON document or a legacy raw CircuitDocument JSON object. */
export function parseCircuitDocument(
  json: string,
): { ok: true; document: CircuitDocument } | { ok: false; reason: string } {
  if (typeof json !== "string") { return { ok: false, reason: "JSONデータは文字列で指定してください。" }; }
  if (json.length > MAX_CIRCUIT_DOCUMENT_JSON_LENGTH) {
    return {
      ok: false,
      reason: `読み込みデータは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, reason: "JSONの形式が正しくありません。" };
  }
  if (!isRecord(parsed)) { return { ok: false, reason: "回路ファイルの形式が正しくありません。" }; }

  let documentValue: unknown = parsed;
  if ("format" in parsed) {
    if (parsed.format !== DOCUMENT_FORMAT) {
      return { ok: false, reason: "回路ファイルの形式が対応していません。" };
    }
    if (parsed.version !== DOCUMENT_VERSION) {
      return { ok: false, reason: `回路ファイルのバージョン${DOCUMENT_VERSION}に対応しています。` };
    }
    if (!("document" in parsed)) {
      return { ok: false, reason: "回路ファイルに回路データがありません。" };
    }
    documentValue = parsed.document;
  }

  const validation = validateDocument(documentValue);
  if (!validation.ok) { return validation; }
  return { ok: true, document: validation.document };
}
