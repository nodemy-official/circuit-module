import {
  compactWireRouteWaypoints,
  decodeWireRouteAnchors,
  encodeWireRouteAnchors,
  isExplicitWireRoute,
  MAX_WIRE_COORDINATE,
  nextRotation,
  partsConflict,
  routeDocumentWires,
  routeEnd,
  routeWireThroughWaypoints,
  terminalPoint,
  wireRouteMatchesWaypoints,
  type Point,
  type RouteEnd,
} from "./circuit-geometry.js";
import {
  circuitPartCatalog,
  MAX_CIRCUIT_WIRE_WAYPOINTS,
  MAX_CIRCUIT_WIRE_ROUTE_ANCHORS,
  sameEndpoint,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitRouteAnchor,
  type CircuitWire,
} from "./circuit-model.js";
import { validateCircuitFragment, validateCircuitRouteAnchors } from "./circuit-serialization.js";

export interface CircuitSelection {
  parts: string[];
  wires: string[];
}

export const emptySelection: CircuitSelection = { parts: [], wires: [] };

/** Parts and the wires between them, detached from any document. */
export interface CircuitFragment {
  parts: CircuitPart[];
  wires: CircuitWire[];
}

/** Original stored route values used to cancel a preview without changing its interpretation or boundary offsets. */
export type CircuitWireRouteSnapshot =
  | { readonly kind: "waypoints"; readonly points: readonly Point[] }
  | { readonly kind: "routeAnchors"; readonly points: readonly CircuitRouteAnchor[] };

export interface CircuitWireRouteHint {
  /** Finished geometry, independent of the wire's current storage and compact callback coordinates. */
  readonly generatedRoute?: {
    readonly kind: "generated" | "routeAnchors";
    readonly points: readonly Point[];
  };
  /** A cancellation snapshot. Forward the supplied array directly to setWireRoute to retain this own data property. */
  readonly restoreRoute?: CircuitWireRouteSnapshot;
}

export type CircuitWireRoutePoints = Point[] & CircuitWireRouteHint;

export type EditResult<T = object> =
  | ({ ok: true; document: CircuitDocument } & T)
  | { ok: false; reason: string };

export function nextId(prefix: string, ids: readonly string[]) {
  const taken = new Set(ids);
  let number = 1;
  while (taken.has(`${prefix}-${number}`)) { number += 1; }
  return `${prefix}-${number}`;
}

/** "抵抗", then "抵抗2", "抵抗3"… so parts of one kind stay distinguishable. */
export function nextLabel(document: CircuitDocument, kind: CircuitPartKind) {
  const base = circuitPartCatalog[kind].defaults.label;
  const labels = new Set(document.parts.map((part) => part.label));
  if (!labels.has(base)) { return base; }
  let number = 2;
  while (labels.has(`${base}${number}`)) { number += 1; }
  return `${base}${number}`;
}

function validCoordinate(point: Point | undefined): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Math.abs(point.x) <= MAX_WIRE_COORDINATE && Math.abs(point.y) <= MAX_WIRE_COORDINATE;
}

const coordinateError = `座標は±${MAX_WIRE_COORDINATE}セル以内の有限な値で指定してください。`;
const waypointCountError = `導線の経由点は${MAX_CIRCUIT_WIRE_WAYPOINTS}個以下にしてください。`;

function waypointError(waypoints?: readonly Point[]): string | null {
  if (waypoints && waypoints.length > MAX_CIRCUIT_WIRE_WAYPOINTS) {
    return waypointCountError;
  }
  // Iteration visits sparse array slots, unlike some/every/map.
  for (const point of waypoints ?? []) {
    if (!validCoordinate(point)) { return `導線の経由点: ${coordinateError}`; }
  }
  return null;
}

function wireWaypointError(wires: readonly CircuitWire[]): string | null {
  for (const wire of wires) {
    const reason = waypointError(wire.waypoints);
    if (reason) { return reason; }
    if (wire.routeAnchors) {
      const result = validateCircuitRouteAnchors(wire.routeAnchors);
      if (!result.ok) { return result.reason; }
    }
  }
  return null;
}

function wireConnectionKey(wire: Pick<CircuitWire, "from" | "to">) {
  return JSON.stringify([
    JSON.stringify([wire.from.partId, wire.from.terminal]),
    JSON.stringify([wire.to.partId, wire.to.terminal]),
  ].sort());
}

function copyEndpoint(endpoint: CircuitEndpoint): CircuitEndpoint {
  return { partId: endpoint.partId, terminal: endpoint.terminal };
}

function copyPoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

/** Whether the candidates fit among the document's other parts. */
export function canPlace(document: CircuitDocument, candidates: readonly CircuitPart[]) {
  const moving = new Set(candidates.map((part) => part.id));
  const others = document.parts.filter((part) => !moving.has(part.id));
  return candidates.every(
    (candidate, index) =>
      validCoordinate(candidate) &&
      !others.some((other) => partsConflict(candidate, other)) &&
      !candidates.slice(index + 1).some((other) => partsConflict(candidate, other)),
  );
}

/** Nearest free cell for a new part, searching outwards in rings. */
export function findFreeSpot(document: CircuitDocument, kind: CircuitPartKind, near: Point): Point {
  const center = copyPoint(near);
  const probeId = nextId("part", document.parts.map((part) => part.id));
  const probe = (x: number, y: number): CircuitPart => ({
    id: probeId,
    kind,
    x,
    y,
    label: "",
  });
  for (let ring = 0; ring < 60; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) { continue; }
        const candidate = probe(center.x + dx * 2, center.y + dy * 2);
        if (canPlace(document, [candidate])) { return { x: candidate.x, y: candidate.y }; }
      }
    }
  }
  return center;
}

export function addPart(
  document: CircuitDocument,
  kind: CircuitPartKind,
  at: Point,
): EditResult<{ id: string }> {
  if (!at) { return { ok: false, reason: coordinateError }; }
  const point = copyPoint(at);
  if (!validCoordinate(point)) { return { ok: false, reason: coordinateError }; }
  const id = nextId(
    "part",
    document.parts.map((existingPart) => existingPart.id),
  );
  const part: CircuitPart = {
    id,
    kind,
    x: point.x,
    y: point.y,
    ...circuitPartCatalog[kind].defaults,
    label: nextLabel(document, kind),
  };
  if (!canPlace(document, [part])) {
    return { ok: false, reason: "そこには置けません。ほかの部品と重なります。" };
  }
  return { ok: true, id, document: { ...document, parts: [...document.parts, part] } };
}

/** Moves parts without checking; pair with {@link canPlace} to validate. */
export function shiftParts(
  document: CircuitDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
) {
  const moving = new Set(ids);
  const originalParts = new Map(document.parts.map((part) => [part.id, part]));
  const next = {
    ...document,
    parts: document.parts.map((part) =>
      moving.has(part.id) ? { ...part, x: part.x + dx, y: part.y + dy } : part,
    ),
    wires: document.wires.map((wire) => {
      if ((!wire.waypoints && !wire.routeAnchors) ||
        (!moving.has(wire.from.partId) && !moving.has(wire.to.partId)) ||
        (dx === 0 && dy === 0)) {
        return wire;
      }
      return {
        ...wire,
        ...(wire.waypoints ? {
          waypoints: wire.waypoints.map((point) => ({ x: point.x + dx, y: point.y + dy })),
        } : {}),
        ...(wire.routeAnchors ? {
          routeAnchors: moving.has(wire.from.partId) && moving.has(wire.to.partId)
            ? translatedRouteAnchors(wire, originalParts, dx, dy)
            : encodeWireRouteAnchors(decodeWireRouteAnchors(wire.routeAnchors).map((point) => ({ x: point.x + dx, y: point.y + dy }))),
        } : {}),
      };
    }),
  };
  // Rigid translations preserve intentional inward terminal visits. Still check their
  // orthogonality: (part + delta) + pinOffset can round differently from (part + pinOffset) + delta.
  return repairExplicitRoutes(next,
    (wire) => (dx !== 0 || dy !== 0) && (moving.has(wire.from.partId) || moving.has(wire.to.partId)),
    (wire) => moving.has(wire.from.partId) !== moving.has(wire.to.partId),
  );
}

export function moveParts(
  document: CircuitDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
): EditResult {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) { return { ok: false, reason: coordinateError }; }
  const sourceIssue = wireWaypointError(document.wires);
  if (sourceIssue) { return { ok: false, reason: sourceIssue }; }
  const next = shiftParts(document, ids, dx, dy);
  const moved = next.parts.filter((part) => ids.includes(part.id));
  if (moved.some((part) => !validCoordinate(part))) { return { ok: false, reason: coordinateError }; }
  const waypointIssue = wireWaypointError(next.wires);
  if (waypointIssue) { return { ok: false, reason: waypointIssue }; }
  if (!canPlace(next, moved)) { return { ok: false, reason: "その位置にはほかの部品があります。" }; }
  if (moved.length === 0 || (dx === 0 && dy === 0)) { return { ok: true, document }; }
  return { ok: true, document: next };
}

export function rotateParts(document: CircuitDocument, ids: readonly string[]): EditResult {
  const rotating = new Set(ids);
  if (!document.parts.some((part) => rotating.has(part.id) && part.kind !== "junction")) {
    return { ok: true, document };
  }
  const next = repairExplicitRoutes({
    ...document,
    parts: document.parts.map((part) =>
      rotating.has(part.id) && part.kind !== "junction"
        ? { ...part, rotation: nextRotation(part.rotation) }
        : part,
    ),
  }, (wire) => rotating.has(wire.from.partId) || rotating.has(wire.to.partId));
  const routeIssue = wireWaypointError(next.wires);
  if (routeIssue) { return { ok: false, reason: routeIssue }; }
  const rotated = next.parts.filter((part) => rotating.has(part.id));
  if (!canPlace(next, rotated)) { return { ok: false, reason: "回転するとほかの部品と重なります。" }; }
  return { ok: true, document: next };
}

export function removeSelection(
  document: CircuitDocument,
  selection: CircuitSelection,
): CircuitDocument {
  const parts = new Set(selection.parts);
  const wires = new Set(selection.wires);
  const removedWires = document.wires.filter(
    (wire) => wires.has(wire.id) || parts.has(wire.from.partId) || parts.has(wire.to.partId),
  );
  const remainingWires = document.wires.filter(
    (wire) => !wires.has(wire.id) && !parts.has(wire.from.partId) && !parts.has(wire.to.partId),
  );
  const candidateJunctions = new Set(
    removedWires.flatMap((wire) => [wire.from.partId, wire.to.partId]),
  );
  const connectedParts = new Set(
    remainingWires.flatMap((wire) => [wire.from.partId, wire.to.partId]),
  );
  const orphanedJunctions = new Set(
    document.parts
      .filter(
        (part) =>
          part.kind === "junction" &&
          candidateJunctions.has(part.id) &&
          !connectedParts.has(part.id),
      )
      .map((part) => part.id),
  );
  return {
    ...document,
    parts: document.parts.filter((part) => !parts.has(part.id) && !orphanedJunctions.has(part.id)),
    wires: remainingWires,
  };
}

export function copyFragment(
  document: CircuitDocument,
  selection: CircuitSelection,
): CircuitFragment {
  const ids = new Set(selection.parts);
  // Selection must use the same own IDs and endpoint records as saving. Snapshot
  // before filtering so Proxy get traps cannot hide or substitute a selected part.
  const snapshot = validateCircuitFragment(document);
  const source = snapshot.ok ? snapshot.fragment : document;
  const selected = {
    parts: source.parts.filter((part) => ids.has(part.id)),
    wires: source.wires.filter((wire) => ids.has(wire.from.partId) && ids.has(wire.to.partId)),
  };
  if (snapshot.ok) { return selected; }
  // Use the saved-field snapshot so copying retains every persisted own value,
  // including nonenumerable coordinates, IDs, electrical values and endpoints.
  const captured = validateCircuitFragment(selected);
  if (captured.ok) { return captured.fragment; }
  // Preserve malformed host input for paste validation instead of repairing it.
  return {
    parts: selected.parts.map((part) => ({ ...part })),
    wires: selected.wires
      .map((wire) => ({
        ...wire,
        from: { ...wire.from },
        to: { ...wire.to },
        ...(wire.waypoints ? { waypoints: wire.waypoints.map((point) => ({ ...point })) } : {}),
        ...(wire.routeAnchors ? { routeAnchors: copyRouteAnchors(wire.routeAnchors) } : {}),
      })),
  };
}

function copyRouteAnchors(anchors: readonly CircuitRouteAnchor[]): CircuitRouteAnchor[] {
  const captured = validateCircuitRouteAnchors(anchors);
  // Keep malformed host input available for paste validation, while valid own data
  // retains nonenumerable coordinates and markers in the detached copy.
  return captured.ok ? captured.routeAnchors : anchors.map((point) => ({ ...point }));
}

function uniqueCopyLabel(label: string, labels: Set<string>) {
  let next = label;
  let suffix = 2;
  while (labels.has(next)) { next = `${label} (${suffix++})`; }
  labels.add(next);
  return next;
}

function renumber(document: CircuitDocument, fragment: CircuitFragment, dx: number, dy: number) {
  const originalParts = new Map(fragment.parts.map((part) => [part.id, part]));
  const partIds = document.parts.map((part) => part.id);
  const wireIds = document.wires.map((wire) => wire.id);
  const labels = new Set(document.parts.map((part) => part.label));
  const mapping = new Map<string, string>();
  const parts = fragment.parts.map((part) => {
    const id = nextId("part", partIds);
    partIds.push(id);
    mapping.set(part.id, id);
    return { ...part, id, label: uniqueCopyLabel(part.label, labels), x: part.x + dx, y: part.y + dy };
  });
  const endpoint = (end: CircuitEndpoint) => ({
    ...end,
    partId: mapping.get(end.partId) ?? end.partId,
  });
  const wires = fragment.wires.map((wire) => {
    const id = nextId("wire", wireIds);
    wireIds.push(id);
    return {
      id,
      from: endpoint(wire.from),
      to: endpoint(wire.to),
      ...(wire.waypoints && wire.waypoints.length > 0 ? {
        waypoints: wire.waypoints.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      } : {}),
      ...(wire.routeAnchors?.length ? {
        routeAnchors: translatedRouteAnchors(wire, originalParts, dx, dy),
      } : {}),
    };
  });
  const repaired = repairExplicitRoutes({ ...document, parts, wires }, () => true, () => false);
  return { parts, wires: repaired.wires };
}

/** Pastes a fragment at the first free diagonal offset, selecting the copies. */
export function pasteFragment(
  document: CircuitDocument,
  fragment: CircuitFragment,
): EditResult<{ selection: CircuitSelection }> {
  const validation = validateCircuitFragment(fragment);
  if (!validation.ok) { return validation; }
  const source = validation.fragment;
  if (source.parts.length === 0) { return { ok: false, reason: "コピーした部品がありません。" }; }
  for (let step = 1; step <= 12; step += 1) {
    const copy = renumber(document, source, step * 2, step * 2);
    if (wireWaypointError(copy.wires)) { continue; }
    const next = {
      ...document,
      parts: [...document.parts, ...copy.parts],
      wires: [...document.wires, ...copy.wires],
    };
    if (canPlace(next, copy.parts)) {
      return {
        ok: true,
        document: next,
        selection: {
          parts: copy.parts.map((part) => part.id),
          wires: copy.wires.map((wire) => wire.id),
        },
      };
    }
  }
  return { ok: false, reason: "貼り付ける場所が見つかりません。" };
}

function hasTerminal(document: CircuitDocument, endpoint: CircuitEndpoint) {
  const part = document.parts.find((item) => item.id === endpoint.partId);
  return part !== undefined && terminalsOf(part.kind).includes(endpoint.terminal);
}

function pointOnSegment(point: Point, start: Point, end: Point) {
  if (start.x === end.x) {
    return (
      point.x === start.x &&
      point.y >= Math.min(start.y, end.y) &&
      point.y <= Math.max(start.y, end.y)
    );
  }
  if (start.y === end.y) {
    return (
      point.y === start.y &&
      point.x >= Math.min(start.x, end.x) &&
      point.x <= Math.max(start.x, end.x)
    );
  }
  return false;
}

function wirePassesThrough(route: readonly Point[] | undefined, point: Point) {
  if (!route) { return false; }
  return route.some((start, index) => {
    const end = route[index + 1];
    return end ? pointOnSegment(point, start, end) : point.x === start.x && point.y === start.y;
  });
}

function splitRouteAtPoint(route: readonly Point[], point: Point): [Point[], Point[]] | undefined {
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    if (!start || !end) { continue; }
    if (start.x === point.x && start.y === point.y) {
      return [route.slice(0, index + 1).map((item) => ({ ...item })), route.slice(index).map((item) => ({ ...item }))];
    }
    if (end.x === point.x && end.y === point.y) {
      return [route.slice(0, index + 2).map((item) => ({ ...item })), route.slice(index + 1).map((item) => ({ ...item }))];
    }
    if (pointOnSegment(point, start, end)) {
      return [
        [...route.slice(0, index + 1), point].map((item) => ({ ...item })),
        [point, ...route.slice(index + 1)].map((item) => ({ ...item })),
      ];
    }
  }
  return undefined;
}

function routeWaypoints(route: readonly Point[]) {
  return route.slice(1, -1).map((point) => ({ ...point }));
}

function splitAuthoredWaypoints(route: readonly Point[], divided: [Point[], Point[]], authored: readonly Point[]): [Point[], Point[]] {
  const point = divided[0].at(-1)!;
  const lastIndex = divided[0].length - 1;
  const atVertex = route[lastIndex]?.x === point.x && route[lastIndex]?.y === point.y;
  const splitIndex = atVertex ? lastIndex : lastIndex - 0.5;
  const first: Point[] = [];
  const second: Point[] = [];
  let index = 0;
  for (const anchor of authored) {
    while (index < route.length && (route[index]!.x !== anchor.x || route[index]!.y !== anchor.y)) { index += 1; }
    if (index >= route.length) { return [[], []]; }
    if (index <= splitIndex) { first.push(anchor); }
    if (index >= splitIndex) { second.push(anchor); }
  }
  return [first, second];
}

function wiresCrossingPoint(
  document: CircuitDocument,
  point: Point,
  existing: CircuitEndpoint | null,
  ignoredWireId?: string,
) {
  // Keep every route from the original document so removing one wire from the split candidates
  // cannot reroute the other wires away from the point currently shown on screen.
  const routes = routeDocumentWires(document);
  return document.wires.filter(
    (wire) => wire.id !== ignoredWireId &&
      wirePassesThrough(routes.get(wire.id), point) &&
      (!existing || (!sameEndpoint(wire.from, existing) && !sameEndpoint(wire.to, existing))),
  );
}

function splitWiresAtJunction(
  document: CircuitDocument,
  crossed: readonly CircuitWire[],
  junction: CircuitEndpoint,
  routes = routeDocumentWires(document, { preserveWaypoints: true }),
) {
  const crossedIds = new Set(crossed.map((wire) => wire.id));
  const wireIds = document.wires.map((wire) => wire.id);
  const junctionPart = document.parts.find((part) => part.id === junction.partId);
  const junctionPoint = junctionPart ? terminalPoint(junctionPart, junction.terminal) : undefined;
  const wires = document.wires.filter((wire) => !crossedIds.has(wire.id));
  const connections = new Map(wires.map((wire) => [wireConnectionKey(wire), wire]));
  const replacements = new Map<string, CircuitWire[]>();
  const parts = new Map(document.parts.map((part) => [part.id, part]));
  const storedWaypoints = (route: readonly Point[], wire: CircuitWire, authored?: readonly Point[]) => {
    const waypoints = routeWaypoints(route);
    const from = parts.get(wire.from.partId);
    const to = parts.get(wire.to.partId);
    return from && to
      ? compactWireRouteWaypoints(route, routeEnd(from, wire.from.terminal), routeEnd(to, wire.to.terminal), authored)
      : waypoints;
  };
  const keepUnique = (wire: CircuitWire, replacement: CircuitWire[]) => {
    const key = wireConnectionKey(wire);
    const existing = connections.get(key);
    if (existing) { return existing; }
    connections.set(key, wire);
    replacement.push(wire);
    return wire;
  };
  const splitWires = crossed.flatMap((wire) => {
    const id = nextId("wire", wireIds);
    wireIds.push(id);
    const route = routes.get(wire.id);
    const divided = route && junctionPoint ? splitRouteAtPoint(route, junctionPoint) : undefined;
    const authored = wire.waypoints ?? [];
    const candidates = route && divided ? splitAuthoredWaypoints(route, divided, authored) : undefined;
    const firstWire = { ...wire, to: junction };
    const secondWire = { id, from: junction, to: wire.to };
    const storeHalf = (halfWire: CircuitWire, half: Point[], candidate?: readonly Point[]) => {
      if (wire.routeAnchors?.length) { return withExplicitRoute(halfWire, half); }
      const start = routeEnd(parts.get(halfWire.from.partId)!, halfWire.from.terminal);
      const end = routeEnd(parts.get(halfWire.to.partId)!, halfWire.to.terminal);
      return withStoredRoute(halfWire, storedWaypoints(half, halfWire, candidate), half, start, end);
    };
    const first = divided ? storeHalf(firstWire, divided[0], candidates?.[0]) : withWireWaypoints(firstWire);
    const second = divided ? storeHalf(secondWire, divided[1], candidates?.[1]) : withWireWaypoints(secondWire);
    const replacement: CircuitWire[] = [];
    replacements.set(wire.id, replacement);
    return [
      keepUnique(first, replacement),
      keepUnique(second, replacement),
    ];
  });
  return {
    document: {
      ...document,
      // Routing depends on wire order. Keep each split in its original position so later
      // automatic routes still avoid these segments instead of collapsing on top of them.
      wires: document.wires.flatMap((wire) => replacements.get(wire.id) ?? [wire]),
    },
    splitWires,
  };
}

export function connect(
  document: CircuitDocument,
  from: CircuitEndpoint,
  to: CircuitEndpoint,
): EditResult<{ id: string }> {
  const fromEndpoint = copyEndpoint(from);
  const toEndpoint = from === to ? fromEndpoint : copyEndpoint(to);
  const reason = connectionError(document, fromEndpoint, toEndpoint);
  if (reason) { return { ok: false, reason }; }
  const id = nextId(
    "wire",
    document.wires.map((wire) => wire.id),
  );
  return { ok: true, id, document: { ...document, wires: [...document.wires, { id, from: fromEndpoint, to: toEndpoint }] } };
}

export type CircuitWireEnd = "from" | "to";

function withWireWaypoints(wire: CircuitWire, waypoints?: readonly Point[]): CircuitWire {
  if (waypoints && waypoints.length > 0) {
    return { ...withoutWireRoute(wire), waypoints: waypoints.map((point) => ({ x: point.x, y: point.y })) };
  }
  return withoutWireRoute(wire);
}

function withoutWireRoute(wire: CircuitWire): CircuitWire {
  const { waypoints: _waypoints, routeAnchors: _routeAnchors, ...copy } = wire;
  return copy;
}

function withExplicitRoute(wire: CircuitWire, route: readonly Point[]): CircuitWire {
  const points = routeWaypoints(route);
  // A straight half with no internal vertex still needs one anchor to remain explicit.
  return { ...withoutWireRoute(wire), routeAnchors: encodeWireRouteAnchors(points.length ? points : [route[0]!]) };
}

function alignTranslatedTerminal(points: Point[], original: readonly Point[], before: Point, after: Point, reversed: boolean) {
  let sameX = true;
  let sameY = true;
  for (let step = 0; step < original.length; step += 1) {
    const index = reversed ? original.length - step - 1 : step;
    sameX &&= original[index]!.x === before.x;
    sameY &&= original[index]!.y === before.y;
    if (!sameX && !sameY) { break; }
    if (sameX) { points[index]!.x = after.x; }
    if (sameY) { points[index]!.y = after.y; }
  }
}

function connectTranslatedTerminal(points: Point[], original: readonly Point[], before: Point, after: Point, reversed: boolean) {
  const adjacent = reversed ? points.at(-1)! : points[0]!;
  if (adjacent.x === after.x || adjacent.y === after.y) { return; }
  const first = (reversed ? [...original].reverse() : original).find((point) => point.x !== before.x || point.y !== before.y);
  const corner = first?.x === before.x
    ? { x: after.x, y: adjacent.y }
    : { x: adjacent.x, y: after.y };
  if (reversed) { points.push(corner); } else { points.unshift(corner); }
}

function translatedRouteAnchors(wire: CircuitWire, parts: ReadonlyMap<string, CircuitPart>, dx: number, dy: number): CircuitRouteAnchor[] {
  const original = decodeWireRouteAnchors(wire.routeAnchors!);
  if (!original.length) { return []; }
  const points = original.map((point) => ({ x: point.x + dx, y: point.y + dy }));
  const terminals = [wire.from, wire.to].map((endpoint) => {
    const part = parts.get(endpoint.partId);
    if (!part) { return null; }
    return {
      before: terminalPoint(part, endpoint.terminal),
      after: terminalPoint({ ...part, x: part.x + dx, y: part.y + dy }, endpoint.terminal),
    };
  });
  // Preserve equality of the old connection axes, rather than comparing rounded coordinates
  // with a tolerance or asking the implicit router to invent a new terminal approach.
  for (const [index, terminal] of terminals.entries()) {
    if (terminal) { alignTranslatedTerminal(points, original, terminal.before, terminal.after, index === 1); }
  }
  // If originally aligned pins round to different axes, a small extra corner is unavoidable.
  // Keep the original adjacent segment's orientation instead of growing an outward dog-leg.
  for (const [index, terminal] of terminals.entries()) {
    if (terminal) { connectTranslatedTerminal(points, original, terminal.before, terminal.after, index === 1); }
  }
  return encodeWireRouteAnchors(points);
}

function withStoredRoute(wire: CircuitWire, waypoints: readonly Point[], route: readonly Point[], start: RouteEnd, end: RouteEnd): CircuitWire {
  // Empty storage selects occupied-dependent automatic routing, which this local replay
  // cannot pin to the old geometry. Keep at least one point for every stored manual route.
  if (waypoints.length && !waypointError(waypoints) && wireRouteMatchesWaypoints(route, start, end, waypoints)) {
    return withWireWaypoints(wire, waypoints);
  }
  return withExplicitRoute(wire, route);
}

function repairExplicitRoutes(
  document: CircuitDocument,
  affected: (wire: CircuitWire) => boolean,
  requireOutwardLeads: (wire: CircuitWire) => boolean = () => true,
): CircuitDocument {
  const parts = new Map(document.parts.map((part) => [part.id, part]));
  return {
    ...document,
    wires: document.wires.map((wire) => {
      if (!wire.routeAnchors?.length || !affected(wire)) { return wire; }
      const from = parts.get(wire.from.partId);
      const to = parts.get(wire.to.partId);
      if (!from || !to) { return wire; }
      const start = routeEnd(from, wire.from.terminal);
      const end = routeEnd(to, wire.to.terminal);
      const points = decodeWireRouteAnchors(wire.routeAnchors);
      return isExplicitWireRoute(start, end, points, requireOutwardLeads(wire))
        ? wire
        : withExplicitRoute(wire, routeWireThroughWaypoints(start, end, points));
    }),
  };
}

/** Repairs explicit terminal approaches after changing part geometry, rejecting any route that exceeds its storage limits. */
export function repairWireRoutes(document: CircuitDocument, partIds: readonly string[]): EditResult {
  const changed = new Set(partIds);
  const next = repairExplicitRoutes(document, (wire) => changed.has(wire.from.partId) || changed.has(wire.to.partId));
  const reason = wireWaypointError(next.wires);
  return reason ? { ok: false, reason } : { ok: true, document: next };
}

/** Replaces a wire's intermediate route points, or clears them to restore automatic routing. */
export function setWireWaypoints(
  document: CircuitDocument,
  wireId: string,
  waypoints?: readonly Point[],
): EditResult {
  const wire = document.wires.find((item) => item.id === wireId);
  if (!wire) { return { ok: false, reason: "導線が見つかりません。" }; }
  if (waypoints !== undefined && !Array.isArray(waypoints)) {
    return { ok: false, reason: "導線の経由点は座標の配列で指定してください。" };
  }
  const count = waypoints === undefined ? 0 : waypoints.length;
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, reason: "導線の経由点数は0以上の整数で指定してください。" };
  }
  if (count > MAX_CIRCUIT_WIRE_WAYPOINTS) { return { ok: false, reason: waypointCountError }; }
  // Validate the same captured coordinates that will be compared and stored.
  const snapshots = new Map<Point, Point>();
  const points = Array.from({ length: count }, (_, index) => {
    const point = waypoints![index]!;
    if (!point) { return point; }
    const captured = snapshots.get(point) ?? copyPoint(point);
    snapshots.set(point, captured);
    return captured;
  });
  const reason = waypointError(points);
  if (reason) { return { ok: false, reason }; }
  const nextPoints = points.length > 0 ? points : undefined;
  const unchanged = wire.routeAnchors === undefined && (wire.waypoints?.length ?? 0) === (nextPoints?.length ?? 0) &&
    (wire.waypoints ?? []).every((point, index) =>
      point.x === nextPoints?.[index]?.x && point.y === nextPoints?.[index]?.y,
    );
  if (unchanged) { return { ok: true, document }; }
  return {
    ok: true,
    document: {
      ...document,
      wires: document.wires.map((item) => item.id === wireId ? withWireWaypoints(item, nextPoints) : item),
    },
  };
}

function captureRoutePoints(waypoints: readonly Point[], count: number): { ok: true; points: Point[] } | { ok: false; reason: string } {
  const snapshots = new Map<Point, Point>();
  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const source = waypoints[index];
    if (!source) { return { ok: false, reason: coordinateError }; }
    const point = snapshots.get(source) ?? copyPoint(source);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        Math.abs(point.x) > MAX_WIRE_COORDINATE * 2 || Math.abs(point.y) > MAX_WIRE_COORDINATE * 2) {
      return { ok: false, reason: coordinateError };
    }
    snapshots.set(source, point);
    points.push(point);
  }
  return { ok: true, points };
}

function routeSnapshotRecord(value: unknown): { kind: unknown; points: unknown } | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { return null; }
    const kind = Object.getOwnPropertyDescriptor(value, "kind");
    const points = Object.getOwnPropertyDescriptor(value, "points");
    if (!kind || !points || !Object.hasOwn(kind, "value") || !Object.hasOwn(points, "value")) { return null; }
    return { kind: kind.value, points: points.value };
  } catch { return null; }
}

function restoreStoredWireRoute(document: CircuitDocument, wire: CircuitWire, value: unknown): EditResult {
  const snapshot = routeSnapshotRecord(value);
  if (!snapshot || !Array.isArray(snapshot.points)) { return { ok: false, reason: "導線の復元経路が正しくありません。" }; }
  if (snapshot.kind === "waypoints") { return setWireWaypoints(document, wire.id, snapshot.points); }
  if (snapshot.kind !== "routeAnchors") { return { ok: false, reason: "導線の復元経路が正しくありません。" }; }
  const validated = validateCircuitRouteAnchors(snapshot.points);
  if (!validated.ok) { return validated; }
  const { routeAnchors } = validated;
  if (!routeAnchors.length) { return setWireWaypoints(document, wire.id); }
  const from = document.parts.find((part) => part.id === wire.from.partId);
  const to = document.parts.find((part) => part.id === wire.to.partId);
  if (!from || !to) { return { ok: false, reason: "接続先の端子が見つかりません。" }; }
  if (!isExplicitWireRoute(routeEnd(from, wire.from.terminal), routeEnd(to, wire.to.terminal), decodeWireRouteAnchors(routeAnchors), false)) {
    return { ok: false, reason: "復元する導線の経路は端子まで直交させてください。" };
  }
  return { ok: true, document: { ...document, wires: document.wires.map((item) => item.id === wire.id
    ? { ...withoutWireRoute(item), routeAnchors } : item) } };
}

type GeneratedRouteMode = NonNullable<CircuitWireRouteHint["generatedRoute"]>["kind"];

function captureWireRouteHint(points: readonly Point[]): { ok: true; snapshot: unknown; mode: GeneratedRouteMode | undefined; points: readonly Point[] } | { ok: false; reason: string } {
  try {
    const restore = Object.getOwnPropertyDescriptor(points, "restoreRoute");
    const generated = Object.getOwnPropertyDescriptor(points, "generatedRoute");
    if (restore && !Object.hasOwn(restore, "value") || generated && !Object.hasOwn(generated, "value")) {
      return { ok: false, reason: "導線の復元経路が正しくありません。" };
    }
    if (generated?.value !== undefined) {
      const route = routeSnapshotRecord(generated.value);
      if (!route || !Array.isArray(route.points) || route.kind !== "generated" && route.kind !== "routeAnchors") {
        return { ok: false, reason: "導線の経路形式が正しくありません。" };
      }
      return { ok: true, snapshot: restore?.value, mode: route.kind, points: route.points };
    }
    return { ok: true, snapshot: restore?.value, mode: undefined, points };
  } catch { return { ok: false, reason: "導線の復元経路が正しくありません。" }; }
}

function finishedRouteCandidate(wire: CircuitWire, start: RouteEnd, end: RouteEnd, points: Point[], mode: GeneratedRouteMode | undefined): Point[] | null {
  if (mode !== undefined || wire.routeAnchors?.length) {
    if (isExplicitWireRoute(start, end, points, false)) { return [start.point, ...points, end.point]; }
    if (mode !== undefined) { return null; }
  }
  return routeWireThroughWaypoints(start, end, points);
}

function prefersLegacyRoute(wire: CircuitWire, mode: GeneratedRouteMode | undefined): boolean {
  return mode === "generated" || mode === undefined && !wire.routeAnchors?.length;
}

function validatedRouteWaypoints(route: readonly Point[], start: RouteEnd, end: RouteEnd, authored?: readonly Point[]): Point[] | undefined {
  const compact = compactWireRouteWaypoints(route, start, end, authored);
  return compact.length && !waypointError(compact) && wireRouteMatchesWaypoints(route, start, end, compact) ? compact : undefined;
}

function sameStoredRoute(wire: CircuitWire, routeAnchors: readonly CircuitRouteAnchor[]): boolean {
  return wire.waypoints === undefined && wire.routeAnchors?.length === routeAnchors.length &&
    wire.routeAnchors.every((point, index) => {
      const other = routeAnchors[index]!;
      return point.x === other.x && point.y === other.y && point.xBoundary === other.xBoundary && point.yBoundary === other.yBoundary;
    });
}

/** Saves finished route geometry, or restores the original stored values supplied by a drag cancellation. */
export function setWireRoute(document: CircuitDocument, wireId: string, waypoints?: readonly Point[] & CircuitWireRouteHint): EditResult {
  const wire = document.wires.find((item) => item.id === wireId);
  if (!wire) { return { ok: false, reason: "導線が見つかりません。" }; }
  if (waypoints === undefined) { return setWireWaypoints(document, wireId); }
  if (!Array.isArray(waypoints)) { return { ok: false, reason: "導線の経由点は座標の配列で指定してください。" }; }
  const count = waypoints.length;
  if (!Number.isInteger(count) || count < 0 || count > MAX_CIRCUIT_WIRE_ROUTE_ANCHORS) {
    return { ok: false, reason: `生成経路のアンカーは${MAX_CIRCUIT_WIRE_ROUTE_ANCHORS}個以下にしてください。` };
  }
  const hint = captureWireRouteHint(waypoints);
  if (!hint.ok) { return hint; }
  if (hint.snapshot !== undefined) { return restoreStoredWireRoute(document, wire, hint.snapshot); }
  if (hint.mode === undefined && count === 0) { return setWireWaypoints(document, wireId); }
  const captured = captureRoutePoints(hint.points, hint.points.length);
  if (!captured.ok) { return captured; }
  const { points } = captured;
  const from = document.parts.find((part) => part.id === wire.from.partId);
  const to = document.parts.find((part) => part.id === wire.to.partId);
  if (!from || !to) { return { ok: false, reason: "接続先の端子が見つかりません。" }; }
  const start = routeEnd(from, wire.from.terminal);
  const end = routeEnd(to, wire.to.terminal);
  // Legacy wires keep their implicit waypoint interpretation, even when every supplied
  // segment is orthogonal: implicit routing may still avoid a pin inside those segments.
  // Existing explicit routes keep orthogonal candidates literal, including inward visits;
  // a nonorthogonal candidate is interpreted once as legacy waypoints and then finished.
  // Board-generated candidates supply their complete geometry and storage policy separately,
  // so a synchronous controller update cannot race the rendered wire representation.
  const route = finishedRouteCandidate(wire, start, end, points, hint.mode);
  if (!route) { return { ok: false, reason: "生成された導線の経路は端子まで直交させてください。" }; }
  if (prefersLegacyRoute(wire, hint.mode)) {
    const compact = validatedRouteWaypoints(route, start, end, hint.mode === undefined ? points : undefined);
    if (compact) { return setWireWaypoints(document, wireId, compact); }
  }
  const stored = withExplicitRoute(wire, route);
  const validated = validateCircuitRouteAnchors(stored.routeAnchors);
  if (!validated.ok) { return validated; }
  const { routeAnchors } = validated;
  if (sameStoredRoute(wire, routeAnchors)) { return { ok: true, document }; }
  return {
    ok: true,
    document: {
      ...document,
      wires: document.wires.map((item) => item.id === wireId
        ? { ...withoutWireRoute(item), routeAnchors }
        : item),
    },
  };
}

function connectionError(
  document: CircuitDocument,
  from: CircuitEndpoint,
  to: CircuitEndpoint,
  ignoredWireId?: string,
) {
  if (!hasTerminal(document, from) || !hasTerminal(document, to)) {
    return "接続先の端子が見つかりません。";
  }
  if (sameEndpoint(from, to)) { return "同じ端子同士は接続できません。"; }
  const duplicated = document.wires.some(
    (wire) => wire.id !== ignoredWireId &&
      ((sameEndpoint(wire.from, from) && sameEndpoint(wire.to, to)) ||
        (sameEndpoint(wire.from, to) && sameEndpoint(wire.to, from))),
  );
  if (duplicated) { return "その端子間にはすでに導線があります。"; }
  return null;
}

function pruneOrphanJunction(document: CircuitDocument, partId: string) {
  const part = document.parts.find((item) => item.id === partId);
  if (part?.kind !== "junction" || document.wires.some(
    (wire) => wire.from.partId === partId || wire.to.partId === partId,
  )) {
    return document;
  }
  return { ...document, parts: document.parts.filter((item) => item.id !== partId) };
}

/** Reconnects one end of an existing wire while preserving its ID and position. */
export function reconnectWire(
  document: CircuitDocument,
  wireId: string,
  end: CircuitWireEnd,
  target: CircuitEndpoint,
): EditResult<{ id: string }> {
  const wire = document.wires.find((item) => item.id === wireId);
  if (!wire) { return { ok: false, reason: "導線が見つかりません。" }; }
  const current = wire[end];
  const targetEndpoint = copyEndpoint(target);
  if (!hasTerminal(document, targetEndpoint)) {
    return { ok: false, reason: "接続先の端子が見つかりません。" };
  }
  if (sameEndpoint(current, targetEndpoint)) { return { ok: true, id: wireId, document }; }
  const from = end === "from" ? targetEndpoint : wire.from;
  const to = end === "to" ? targetEndpoint : wire.to;
  const reason = connectionError(document, from, to, wireId);
  if (reason) { return { ok: false, reason }; }

  const wires = document.wires.map((item) => item.id === wireId
    ? { ...item, [end]: targetEndpoint }
    : item);
  const next = repairExplicitRoutes({ ...document, wires }, (item) => item.id === wireId);
  const routeIssue = wireWaypointError(next.wires);
  if (routeIssue) { return { ok: false, reason: routeIssue }; }
  return {
    ok: true,
    id: wireId,
    document: pruneOrphanJunction(next, current.partId),
  };
}

/** Terminal whose position is exactly this cell, if any. */
export function terminalAt(document: CircuitDocument, point: Point): CircuitEndpoint | null {
  const target = copyPoint(point);
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      const position = terminalPoint(part, terminal);
      if (position.x === target.x && position.y === target.y) { return { partId: part.id, terminal }; }
    }
  }
  return null;
}

function preparePointConnection(
  document: CircuitDocument,
  point: Point,
  existing: CircuitEndpoint | null,
  ignoredWireId?: string,
): EditResult<{ endpoint: CircuitEndpoint; crossedWires: CircuitWire[] }> {
  // Find crossings before adding a junction so they match the displayed routes.
  const crossedWires = wiresCrossingPoint(document, point, existing, ignoredWireId);
  if (existing) { return { ok: true, document, endpoint: existing, crossedWires }; }

  const placed = addPart(document, "junction", point);
  if (!placed.ok) { return placed; }
  return {
    ok: true,
    document: placed.document,
    endpoint: { partId: placed.id, terminal: "a" },
    crossedWires,
  };
}

/** Connects a terminal to a cell, placing a junction there when no terminal is waiting. */
export function connectToPoint(
  document: CircuitDocument,
  from: CircuitEndpoint,
  point: Point,
): EditResult<{ id: string }> {
  const fromEndpoint = copyEndpoint(from);
  const target = copyPoint(point);
  const prepared = preparePointConnection(document, target, terminalAt(document, target));
  if (!prepared.ok) { return prepared; }
  const { document: baseDocument, endpoint, crossedWires } = prepared;
  if (crossedWires.length === 0) { return connect(baseDocument, fromEndpoint, endpoint); }
  if (sameEndpoint(fromEndpoint, endpoint)) {
    return connect(document, fromEndpoint, endpoint);
  }

  const { document: splitDocument, splitWires } = splitWiresAtJunction(baseDocument, crossedWires, endpoint);
  const splitIssue = wireWaypointError(splitWires);
  if (splitIssue) { return { ok: false, reason: splitIssue }; }
  const attached = splitWires.find(
    (wire) => sameEndpoint(wire.from, fromEndpoint) || sameEndpoint(wire.to, fromEndpoint),
  );
  if (attached) { return { ok: true, id: attached.id, document: splitDocument }; }
  return connect(splitDocument, fromEndpoint, endpoint);
}

/** Reconnects one wire end to a terminal or point on the board, splitting crossed wires. */
export function reconnectWireToPoint(
  document: CircuitDocument,
  wireId: string,
  end: CircuitWireEnd,
  point: Point,
): EditResult<{ id: string }> {
  const wire = document.wires.find((item) => item.id === wireId);
  if (!wire) { return { ok: false, reason: "導線が見つかりません。" }; }

  const target = copyPoint(point);
  const current = wire[end];
  const existing = terminalAt(document, target);
  if (existing && sameEndpoint(current, existing)) { return { ok: true, id: wireId, document }; }

  const prepared = preparePointConnection(document, target, existing, wireId);
  if (!prepared.ok) { return prepared; }
  const { document: baseDocument, endpoint, crossedWires } = prepared;
  const reconnected = reconnectWire(baseDocument, wireId, end, endpoint);
  if (!reconnected.ok || crossedWires.length === 0) { return reconnected; }
  // Reserve the edited connection before splitting so an identical new segment reuses it.
  // Routes still come from the displayed document, before the reconnect can reroute anything.
  const split = splitWiresAtJunction(reconnected.document, crossedWires, endpoint, routeDocumentWires(baseDocument, { preserveWaypoints: true }));
  const splitIssue = wireWaypointError(split.splitWires);
  if (splitIssue) { return { ok: false, reason: splitIssue }; }
  return { ...reconnected, document: split.document };
}

/** Number of wires attached to a terminal. */
export function wireCount(document: CircuitDocument, endpoint: CircuitEndpoint) {
  return document.wires.filter(
    (wire) => sameEndpoint(wire.from, endpoint) || sameEndpoint(wire.to, endpoint),
  ).length;
}
