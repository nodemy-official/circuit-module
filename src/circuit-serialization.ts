import { z } from "zod";
import { circuitNumericValueSchema, simulationBooleanSchema, simulationIdentifierSchema, simulationPartKindSchema, simulationRecordSchema, simulationTerminalSchema } from "./circuit-validation.js";
import {
  circuitPartKinds,
  circuitPartNumericFields,
  MAX_CIRCUIT_WIRE_ROUTE_ANCHORS,
  MAX_CIRCUIT_WIRE_WAYPOINTS,
  terminalsOf,
  type CircuitPartNumericKey,
} from "./circuit-model.js";
import { MAX_WIRE_COORDINATE, terminalPoint, type Point } from "./circuit-geometry.js";
import type {
  CircuitDocument,
  CircuitEndpoint,
  CircuitPart,
  CircuitPartKind,
  CircuitRotation,
  CircuitRouteAnchor,
  CircuitWire,
} from "./circuit-model.js";

const DOCUMENT_FORMAT = "circuit-module";
const DOCUMENT_VERSION = 1;
const ROUTE_ANCHOR_DOCUMENT_VERSION = 2;
export const MAX_CIRCUIT_DOCUMENT_COORDINATE = MAX_WIRE_COORDINATE;

/** JSON text limit for saving or loading a circuit document, measured in JavaScript string characters. */
export const MAX_CIRCUIT_DOCUMENT_JSON_LENGTH = 1_000_000;
/** Maximum number of parts accepted in one circuit document. */
export const MAX_CIRCUIT_DOCUMENT_PARTS = 10_000;
/** Maximum number of wires accepted in one circuit document. */
export const MAX_CIRCUIT_DOCUMENT_WIRES = 20_000;
/** Maximum number of stored route points on a single wire. */
export const MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS = MAX_CIRCUIT_WIRE_WAYPOINTS;
/** Maximum number of generated route anchors on a single wire. */
export const MAX_CIRCUIT_DOCUMENT_WIRE_ROUTE_ANCHORS = MAX_CIRCUIT_WIRE_ROUTE_ANCHORS;

const rotationSchema = z.literal([0, 90, 180, 270]);

type ValidationResult =
  | { ok: true; document: CircuitDocument }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return simulationRecordSchema.safeParse(value).success;
}

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

function checkString(value: unknown, description: string, allowEmpty: boolean): string | null {
  const schema = z.string({ error: `${description}は文字列で指定してください。` })
    .refine((text) => allowEmpty || text.trim().length > 0, { error: `${description}を空にできません。` });
  const parsed = schema.safeParse(value);
  return parsed.success ? null : parsed.error.issues[0]!.message;
}

const allNumericKeys = new Set<CircuitPartNumericKey>(
  circuitPartKinds.flatMap((kind) => circuitPartNumericFields(kind).map(({ key }) => key)),
);
const savedPartKeys = ["id", "kind", "x", "y", "label", "rotation", "initiallyClosed", ...allNumericKeys];

type SavedSnapshot = WeakMap<object, Map<string, PropertyDescriptor | undefined>>;

/** Shared records and arrays must describe one value throughout a save. */
function savedDescriptor(value: object, key: string, snapshot: SavedSnapshot) {
  let fields = snapshot.get(value);
  if (!fields) { fields = new Map(); snapshot.set(value, fields); }
  if (!fields.has(key)) { fields.set(key, Object.getOwnPropertyDescriptor(value, key)); }
  return fields.get(key);
}

/** Capture only persisted own data fields; unknown getters and Proxy get traps never run. */
function snapshotSavedRecord(value: unknown, keys: readonly string[], snapshot: SavedSnapshot): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { return null; }
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      const descriptor = savedDescriptor(value, key, snapshot);
      if (descriptor && !Object.hasOwn(descriptor, "value")) { return null; }
      // Include missing fields as undefined so inherited values cannot fill them.
      entries.push([key, descriptor?.value]);
    }
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

/** Read array length and indexes directly so caller iterators and indexed accessors cannot run. */
function snapshotSavedArray(value: unknown, max: number, arrayError: string, limitError: string, snapshot: SavedSnapshot): { values?: unknown[]; reason?: string } {
  try {
    if (!Array.isArray(value)) { return { reason: arrayError }; }
    const lengthDescriptor = savedDescriptor(value, "length", snapshot);
    const length: unknown = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value") ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) { return { reason: arrayError }; }
    if (length > max) { return { reason: limitError }; }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = savedDescriptor(value, String(index), snapshot);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) { return { reason: arrayError }; }
      values.push(descriptor.value);
    }
    return { values };
  } catch {
    return { reason: arrayError };
  }
}

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
  const parsed = circuitNumericValueSchema(field ?? {}).safeParse(value);
  if (parsed.success) { return null; }
  const issue = parsed.error.issues[0]!;
  if (field && issue.code === "too_small") {
    const comparison = field.exclusiveMin ? "より大きい" : "以上";
    return `${label}の${fieldLabel}は${field.min}${field.unit} ${comparison}で指定してください。`;
  }
  if (field && issue.code === "too_big") {
    return `${label}の${fieldLabel}は${field.max}${field.unit}以下で指定してください。`;
  }
  return `${label}の${fieldLabel}は有限な数値で指定してください。`;
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
  snapshot: SavedSnapshot,
): { endpoint?: CircuitEndpoint; reason?: string } {
  const candidate = snapshotSavedRecord(value, ["partId", "terminal"], snapshot);
  if (!candidate) { return { reason: `${side}の接続先の形式が正しくありません。` }; }
  const { partId, terminal } = candidate;
  const id = simulationIdentifierSchema.safeParse(partId);
  if (!id.success) {
    return { reason: `${side}の接続先部品 ID が正しくありません。` };
  }
  const pin = simulationTerminalSchema.safeParse(terminal);
  if (!pin.success) {
    return { reason: `${side}の端子は「a」「b」「c」のいずれかで指定してください。` };
  }
  const part = partsById.get(id.data);
  if (!part) { return { reason: `${side}の接続先部品「${partId}」が見つかりません。` }; }
  if (!terminalsOf(part.kind).includes(pin.data)) {
    return { reason: `${part.label || part.id}には端子「${terminal}」がありません。` };
  }
  return { endpoint: { partId: id.data, terminal: pin.data } };
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
  if (candidate.initiallyClosed !== undefined && !simulationBooleanSchema.safeParse(candidate.initiallyClosed).success) {
    return `${label}のスイッチ状態は真偽値で指定してください。`;
  }
  if (kind === "op-amp") {
    const parsed = z.object({ positiveRailVolts: z.number().default(15), negativeRailVolts: z.number().default(-15) })
      .refine((part) => part.negativeRailVolts < part.positiveRailVolts)
      .safeParse(candidate);
    if (!parsed.success) { return `${label}の負側電源は正側電源より低くしてください。`; }
  }
  return null;
}

function coordinateSchema(description: string) {
  const error = `${description}は±${MAX_CIRCUIT_DOCUMENT_COORDINATE}セル以内で指定してください。`;
  return z.number({ error: `${description}は有限な数値で指定してください。` })
    .min(-MAX_CIRCUIT_DOCUMENT_COORDINATE, { error })
    .max(MAX_CIRCUIT_DOCUMENT_COORDINATE, { error });
}

function validatePartShape(candidate: Record<string, unknown>, label: string): string | null {
  const parsed = z.object({
    kind: simulationPartKindSchema,
    x: coordinateSchema(`${label}の x 座標`),
    y: coordinateSchema(`${label}の y 座標`),
    label: z.string({ error: `${label}のラベルは文字列で指定してください。` }),
    rotation: rotationSchema.optional(),
  }).safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.path[0] === "kind") { return `${label}の種類が不明です。`; }
    if (issue.path[0] === "rotation") { return `${label}の回転角度は0、90、180、270のいずれかで指定してください。`; }
    return issue.message;
  }
  return validateOptionalPartValues(candidate, parsed.data.kind, label);
}

function normalizePart(
  value: unknown,
  index: number,
  ids: Set<string>,
  snapshot: SavedSnapshot,
): { part?: CircuitPart; reason?: string } {
  const label = `部品${index + 1}`;
  const candidate = snapshotSavedRecord(value, savedPartKeys, snapshot);
  if (!candidate) { return { reason: `${label}の形式が正しくありません。` }; }
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

function normalizeParts(value: unknown, snapshot: SavedSnapshot): { parts?: CircuitPart[]; reason?: string } {
  const captured = snapshotSavedArray(value, MAX_CIRCUIT_DOCUMENT_PARTS,
    "部品一覧は配列で指定してください。", `部品数は${MAX_CIRCUIT_DOCUMENT_PARTS}個以下にしてください。`, snapshot);
  if (!captured.values) { return { reason: captured.reason }; }
  const ids = new Set<string>();
  const parts: CircuitPart[] = [];
  for (const [index, candidate] of captured.values.entries()) {
    const result = normalizePart(candidate, index, ids, snapshot);
    if (result.reason) { return { reason: result.reason }; }
    if (result.part) { parts.push(result.part); }
  }
  return { parts };
}

function normalizeWireWaypoints(value: unknown, label: string, snapshot: SavedSnapshot): { waypoints?: { x: number; y: number }[]; reason?: string } {
  if (value === undefined) { return {}; }
  const captured = snapshotSavedArray(value, MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS,
    `${label}の経由点は配列で指定してください。`, `${label}の経由点は${MAX_CIRCUIT_DOCUMENT_WIRE_WAYPOINTS}個以下にしてください。`, snapshot);
  if (!captured.values) { return { reason: captured.reason }; }
  const waypoints: { x: number; y: number }[] = [];
  for (const [index, pointValue] of captured.values.entries()) {
    const waypointLabel = `${label}の経由点${index + 1}`;
    const candidate = snapshotSavedRecord(pointValue, ["x", "y"], snapshot);
    if (!candidate) { return { reason: `${waypointLabel}の形式が正しくありません。` }; }
    const point = z.object({
      x: coordinateSchema(`${waypointLabel}のx座標`),
      y: coordinateSchema(`${waypointLabel}のy座標`),
    }).safeParse(candidate);
    if (!point.success) { return { reason: point.error.issues[0]!.message }; }
    waypoints.push(point.data);
  }
  return waypoints.length > 0 ? { waypoints } : {};
}

function routeAnchorBoundaryIssue(anchor: CircuitRouteAnchor, label: string): string | null {
  for (const axis of ["x", "y"] as const) {
    const boundary = axis === "x" ? anchor.xBoundary : anchor.yBoundary;
    if (boundary === undefined) { continue; }
    const decoded = boundary * MAX_WIRE_COORDINATE + anchor[axis];
    if (Math.sign(anchor[axis]) !== boundary || !Number.isFinite(decoded) || boundary * decoded <= MAX_WIRE_COORDINATE) {
      return `${label}の${axis}境界オフセットは境界の外側を表す同符号の有限な値で指定してください。`;
    }
  }
  return null;
}

const routeAnchorSchema = z.object({
  x: coordinateSchema("x座標"),
  y: coordinateSchema("y座標"),
  xBoundary: z.literal([-1, 1], { error: "x境界は-1または1で指定してください。" }).optional(),
  yBoundary: z.literal([-1, 1], { error: "y境界は-1または1で指定してください。" }).optional(),
});

function decodedRouteAnchor(anchor: CircuitRouteAnchor): Point {
  return {
    x: anchor.xBoundary === undefined ? anchor.x : anchor.xBoundary * MAX_WIRE_COORDINATE + anchor.x,
    y: anchor.yBoundary === undefined ? anchor.y : anchor.yBoundary * MAX_WIRE_COORDINATE + anchor.y,
  };
}

function orthogonalRoutePoints(from: Point, to: Point) {
  return from.x === to.x || from.y === to.y;
}

function normalizeRouteAnchors(value: unknown, label: string, snapshot: SavedSnapshot): ReturnType<typeof validateCircuitRouteAnchors> {
  const captured = snapshotSavedArray(value, MAX_CIRCUIT_WIRE_ROUTE_ANCHORS,
    `${label}は配列で指定してください。`, `${label}は${MAX_CIRCUIT_WIRE_ROUTE_ANCHORS}個以下にしてください。`, snapshot);
  if (!captured.values) { return { ok: false, reason: captured.reason! }; }
  const routeAnchors: CircuitRouteAnchor[] = [];
  let previous: Point | undefined;
  for (const [index, anchorValue] of captured.values.entries()) {
    const anchorLabel = `${label}${index + 1}`;
    const candidate = snapshotSavedRecord(anchorValue, ["x", "y", "xBoundary", "yBoundary"], snapshot);
    if (!candidate) { return { ok: false, reason: `${anchorLabel}の形式が正しくありません。` }; }
    const parsed = routeAnchorSchema.safeParse(candidate);
    if (!parsed.success) { return { ok: false, reason: `${anchorLabel}の${parsed.error.issues[0]!.message}` }; }
    const anchor = parsed.data;
    const boundaryIssue = routeAnchorBoundaryIssue(anchor, anchorLabel);
    if (boundaryIssue) { return { ok: false, reason: boundaryIssue }; }
    const point = decodedRouteAnchor(anchor);
    if (previous && !orthogonalRoutePoints(previous, point)) {
      return { ok: false, reason: `${anchorLabel}は直前のルートアンカーと直交するように指定してください。` };
    }
    previous = point;
    // Omitted markers remain omitted in the canonical saved representation.
    routeAnchors.push({ x: anchor.x, y: anchor.y,
      ...(anchor.xBoundary === undefined ? {} : { xBoundary: anchor.xBoundary }),
      ...(anchor.yBoundary === undefined ? {} : { yBoundary: anchor.yBoundary }),
    });
  }
  return { ok: true, routeAnchors };
}

/** Captures orthogonal polyline vertices using the same own-data rules and bounds as saved documents. */
export function validateCircuitRouteAnchors(input: unknown):
  | { ok: true; routeAnchors: CircuitRouteAnchor[] }
  | { ok: false; reason: string } {
  return normalizeRouteAnchors(input, "導線のルートアンカー", new WeakMap());
}

function routeAnchorConnectionIssue(routeAnchors: readonly CircuitRouteAnchor[], from: Point, to: Point, label: string): string | null {
  if (!orthogonalRoutePoints(from, decodedRouteAnchor(routeAnchors[0]!))) {
    return `${label}の始点とルートアンカーは直交するように指定してください。`;
  }
  if (!orthogonalRoutePoints(decodedRouteAnchor(routeAnchors.at(-1)!), to)) {
    return `${label}の終点とルートアンカーは直交するように指定してください。`;
  }
  return null;
}

function normalizeWireRoute(candidate: Record<string, unknown>, label: string, snapshot: SavedSnapshot, from: Point, to: Point):
  { route?: Pick<CircuitWire, "waypoints" | "routeAnchors">; reason?: string } {
  const waypointResult = normalizeWireWaypoints(candidate.waypoints, label, snapshot);
  if (waypointResult.reason) { return { reason: waypointResult.reason }; }
  const anchorResult = candidate.routeAnchors === undefined ? undefined
    : normalizeRouteAnchors(candidate.routeAnchors, `${label}のルートアンカー`, snapshot);
  if (anchorResult && !anchorResult.ok) { return { reason: anchorResult.reason }; }
  const routeAnchors = anchorResult?.ok && anchorResult.routeAnchors.length > 0 ? anchorResult.routeAnchors : undefined;
  if (waypointResult.waypoints && routeAnchors) {
    return { reason: `${label}の経由点とルートアンカーは同時に指定できません。` };
  }
  const connectionIssue = routeAnchors && routeAnchorConnectionIssue(routeAnchors, from, to, label);
  if (connectionIssue) { return { reason: connectionIssue }; }
  return { route: { ...waypointResult, ...(routeAnchors ? { routeAnchors } : {}) } };
}

function normalizeWire(
  value: unknown,
  index: number,
  partsById: ReadonlyMap<string, CircuitPart>,
  wireIds: Set<string>,
  seenWireKeys: Set<string>,
  snapshot: SavedSnapshot,
): { wire?: CircuitWire; reason?: string } {
  const label = `導線${index + 1}`;
  const candidate = snapshotSavedRecord(value, ["id", "from", "to", "waypoints", "routeAnchors"], snapshot);
  if (!candidate) { return { reason: `${label}の形式が正しくありません。` }; }
  const idIssue = checkString(candidate.id, `${label}の ID`, false);
  if (idIssue) { return { reason: idIssue }; }
  const id = candidate.id as string;
  if (wireIds.has(id)) { return { reason: `導線 ID「${id}」が重複しています。` }; }
  wireIds.add(id);

  const fromResult = validateEndpoint(candidate.from, `${label}の始点`, partsById, snapshot);
  if (fromResult.reason || !fromResult.endpoint) {
    return { reason: fromResult.reason ?? `${label}の始点が不正です。` };
  }
  const toResult = validateEndpoint(candidate.to, `${label}の終点`, partsById, snapshot);
  if (toResult.reason || !toResult.endpoint) {
    return { reason: toResult.reason ?? `${label}の終点が不正です。` };
  }
  const { endpoint: from } = fromResult;
  const { endpoint: to } = toResult;
  if (from.partId === to.partId && from.terminal === to.terminal) {
    return { reason: `${label}は同じ端子同士を接続しています。` };
  }
  const wireKey = unorderedWireKey(from, to);
  if (seenWireKeys.has(wireKey)) { return { reason: `${label}は既存の導線と同じ端子間を接続しています。` }; }
  seenWireKeys.add(wireKey);
  const routeResult = normalizeWireRoute(candidate, label, snapshot,
    terminalPoint(partsById.get(from.partId)!, from.terminal), terminalPoint(partsById.get(to.partId)!, to.terminal));
  if (routeResult.reason) { return { reason: routeResult.reason }; }
  return { wire: { id, from, to, ...routeResult.route } };
}

function normalizeWires(value: unknown, parts: readonly CircuitPart[], snapshot: SavedSnapshot): { wires?: CircuitWire[]; reason?: string } {
  const captured = snapshotSavedArray(value, MAX_CIRCUIT_DOCUMENT_WIRES,
    "導線一覧は配列で指定してください。", `導線数は${MAX_CIRCUIT_DOCUMENT_WIRES}本以下にしてください。`, snapshot);
  if (!captured.values) { return { reason: captured.reason }; }
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const ids = new Set<string>();
  const seenWireKeys = new Set<string>();
  const wires: CircuitWire[] = [];
  for (const [index, candidate] of captured.values.entries()) {
    const result = normalizeWire(candidate, index, partsById, ids, seenWireKeys, snapshot);
    if (result.reason) { return { reason: result.reason }; }
    if (result.wire) { wires.push(result.wire); }
  }
  return { wires };
}

/** Validates and snapshots a detached fragment using the same saved-data rules as documents. */
export function validateCircuitFragment(input: unknown):
  | { ok: true; fragment: Pick<CircuitDocument, "parts" | "wires"> }
  | { ok: false; reason: string } {
  return validateFragment(input, new WeakMap());
}

function validateFragment(input: unknown, snapshot: SavedSnapshot): ReturnType<typeof validateCircuitFragment> {
  const value = snapshotSavedRecord(input, ["parts", "wires"], snapshot);
  if (!value) { return { ok: false, reason: "コピーした回路データの形式が正しくありません。" }; }
  const partsResult = normalizeParts(value.parts, snapshot);
  if (partsResult.reason || !partsResult.parts) {
    return { ok: false, reason: partsResult.reason ?? "部品一覧が不正です。" };
  }
  const wiresResult = normalizeWires(value.wires, partsResult.parts, snapshot);
  if (wiresResult.reason || !wiresResult.wires) {
    return { ok: false, reason: wiresResult.reason ?? "導線一覧が不正です。" };
  }
  return { ok: true, fragment: { parts: partsResult.parts, wires: wiresResult.wires } };
}

function validateDocument(input: unknown): ValidationResult {
  const snapshot: SavedSnapshot = new WeakMap();
  const value = snapshotSavedRecord(input, ["title", "parts", "wires"], snapshot);
  if (!value) { return fail("回路データはオブジェクトで指定してください。"); }
  const titleIssue = checkString(value.title, "回路名", true);
  if (titleIssue) { return fail(titleIssue); }
  const fragmentResult = validateFragment(value, snapshot);
  if (!fragmentResult.ok) { return fragmentResult; }
  return { ok: true, document: { title: value.title as string, ...fragmentResult.fragment } };
}

function savedEnvelope(document: CircuitDocument) {
  return {
    format: DOCUMENT_FORMAT,
    version: document.wires.some((wire) => wire.routeAnchors?.length)
      ? ROUTE_ANCHOR_DOCUMENT_VERSION : DOCUMENT_VERSION,
    document,
  };
}

/**
 * Encodes own data fields as a versioned JSON document. Unknown properties are dropped; known accessors are invalid.
 * Throws when the input is invalid or the encoded document exceeds the public text limit.
 */
export function serializeCircuitDocument(document: CircuitDocument): string {
  const validation = validateDocument(document as unknown);
  if (!validation.ok) { throw new TypeError(`回路を保存できません。${validation.reason}`); }
  const envelope = savedEnvelope(validation.document);
  let json = JSON.stringify(envelope, null, 2);
  // Formatting alone must not make a valid compact input impossible to save again.
  if (json.length > MAX_CIRCUIT_DOCUMENT_JSON_LENGTH) { json = JSON.stringify(envelope); }
  if (json.length > MAX_CIRCUIT_DOCUMENT_JSON_LENGTH) {
    throw new RangeError(`保存データは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。`);
  }
  return json;
}

/** Reads a versioned circuit JSON document or a legacy raw CircuitDocument JSON object. */
export function parseCircuitDocument(
  json: string,
): { ok: true; document: CircuitDocument } | { ok: false; reason: string } {
  const text = z.string({ error: "JSONデータは文字列で指定してください。" })
    // The public limit counts UTF-16 units; Zod's string limits count code points.
    .refine((value) => value.length <= MAX_CIRCUIT_DOCUMENT_JSON_LENGTH, { error: `読み込みデータは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。` })
    .safeParse(json);
  if (!text.success) { return { ok: false, reason: text.error.issues[0]!.message }; }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.data) as unknown;
  } catch {
    return { ok: false, reason: "JSONの形式が正しくありません。" };
  }
  if (!isRecord(parsed)) { return { ok: false, reason: "回路ファイルの形式が正しくありません。" }; }

  let documentValue: unknown = parsed;
  let documentVersion: number | undefined;
  if ("format" in parsed) {
    if (!z.literal(DOCUMENT_FORMAT).safeParse(parsed.format).success) {
      return { ok: false, reason: "回路ファイルの形式が対応していません。" };
    }
    if (!z.literal([DOCUMENT_VERSION, ROUTE_ANCHOR_DOCUMENT_VERSION]).safeParse(parsed.version).success) {
      return { ok: false, reason: `回路ファイルのバージョン${DOCUMENT_VERSION}と${ROUTE_ANCHOR_DOCUMENT_VERSION}に対応しています。` };
    }
    if (!("document" in parsed)) {
      return { ok: false, reason: "回路ファイルに回路データがありません。" };
    }
    documentValue = parsed.document;
    documentVersion = parsed.version as number;
  }

  const validation = validateDocument(documentValue);
  if (!validation.ok) { return validation; }
  if (documentVersion === DOCUMENT_VERSION && validation.document.wires.some((wire) => wire.routeAnchors?.length)) {
    return { ok: false, reason: `ルートアンカーを含む回路ファイルはバージョン${ROUTE_ANCHOR_DOCUMENT_VERSION}で保存してください。` };
  }
  // Legacy documents and compact numeric literals can grow during normalization.
  // Only accept documents that can be saved again within the same public limit.
  if (JSON.stringify(savedEnvelope(validation.document)).length > MAX_CIRCUIT_DOCUMENT_JSON_LENGTH) {
    return { ok: false, reason: `正規化後の保存データは${MAX_CIRCUIT_DOCUMENT_JSON_LENGTH}文字以下にしてください。` };
  }
  return { ok: true, document: validation.document };
}
