import {
  MAX_WIRE_COORDINATE,
  nextRotation,
  partsConflict,
  routeDocumentWires,
  terminalPoint,
  type Point,
} from "./circuit-geometry.js";
import {
  circuitPartCatalog,
  MAX_CIRCUIT_WIRE_WAYPOINTS,
  sameEndpoint,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitWire,
} from "./circuit-model.js";

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

function waypointError(waypoints?: readonly Point[]): string | null {
  if (waypoints && waypoints.length > MAX_CIRCUIT_WIRE_WAYPOINTS) {
    return `導線の経由点は${MAX_CIRCUIT_WIRE_WAYPOINTS}個以下にしてください。`;
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
  }
  return null;
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
  const probe = (x: number, y: number): CircuitPart => ({
    id: "\u0000probe",
    kind,
    x,
    y,
    label: "",
  });
  for (let ring = 0; ring < 60; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) { continue; }
        const candidate = probe(near.x + dx * 2, near.y + dy * 2);
        if (canPlace(document, [candidate])) { return { x: candidate.x, y: candidate.y }; }
      }
    }
  }
  return near;
}

export function addPart(
  document: CircuitDocument,
  kind: CircuitPartKind,
  at: Point,
): EditResult<{ id: string }> {
  if (!validCoordinate(at)) { return { ok: false, reason: coordinateError }; }
  const id = nextId(
    "part",
    document.parts.map((existingPart) => existingPart.id),
  );
  const part: CircuitPart = {
    id,
    kind,
    ...at,
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
  return {
    ...document,
    parts: document.parts.map((part) =>
      moving.has(part.id) ? { ...part, x: part.x + dx, y: part.y + dy } : part,
    ),
    wires: document.wires.map((wire) => {
      if (!wire.waypoints ||
        (!moving.has(wire.from.partId) && !moving.has(wire.to.partId)) ||
        (dx === 0 && dy === 0)) {
        return wire;
      }
      return {
        ...wire,
        waypoints: wire.waypoints.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      };
    }),
  };
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
  return { ok: true, document: next };
}

export function rotateParts(document: CircuitDocument, ids: readonly string[]): EditResult {
  const rotating = new Set(ids);
  const next = {
    ...document,
    parts: document.parts.map((part) =>
      rotating.has(part.id) && part.kind !== "junction"
        ? { ...part, rotation: nextRotation(part.rotation) }
        : part,
    ),
  };
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
  return {
    parts: document.parts.filter((part) => ids.has(part.id)).map((part) => ({ ...part })),
    wires: document.wires.filter((wire) => ids.has(wire.from.partId) && ids.has(wire.to.partId))
      .map((wire) => ({
        ...wire,
        from: { ...wire.from },
        to: { ...wire.to },
        ...(wire.waypoints ? { waypoints: wire.waypoints.map((point) => ({ ...point })) } : {}),
      })),
  };
}

function uniqueCopyLabel(label: string, labels: Set<string>) {
  let next = label;
  let suffix = 2;
  while (labels.has(next)) { next = `${label} (${suffix++})`; }
  labels.add(next);
  return next;
}

function renumber(document: CircuitDocument, fragment: CircuitFragment, dx: number, dy: number) {
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
    };
  });
  return { parts, wires };
}

/** Pastes a fragment at the first free diagonal offset, selecting the copies. */
export function pasteFragment(
  document: CircuitDocument,
  fragment: CircuitFragment,
): EditResult<{ selection: CircuitSelection }> {
  if (fragment.parts.length === 0) { return { ok: false, reason: "コピーした部品がありません。" }; }
  if (fragment.parts.some((part) => !validCoordinate(part))) { return { ok: false, reason: coordinateError }; }
  const waypointIssue = wireWaypointError(fragment.wires);
  if (waypointIssue) { return { ok: false, reason: waypointIssue }; }
  const sourceParts = new Map(fragment.parts.map((part) => [part.id, part]));
  if (sourceParts.size !== fragment.parts.length) { return { ok: false, reason: "コピーした部品の ID が重複しています。" }; }
  const validEndpoint = (endpoint: CircuitEndpoint) => {
    const part = sourceParts.get(endpoint.partId);
    return part !== undefined && terminalsOf(part.kind).includes(endpoint.terminal);
  };
  if (fragment.wires.some((wire) => !validEndpoint(wire.from) || !validEndpoint(wire.to))) {
    return { ok: false, reason: "コピーした導線の接続先がコピー内に見つかりません。" };
  }
  for (let step = 1; step <= 12; step += 1) {
    const copy = renumber(document, fragment, step * 2, step * 2);
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
) {
  const crossedIds = new Set(crossed.map((wire) => wire.id));
  const wireIds = document.wires.map((wire) => wire.id);
  const junctionPart = document.parts.find((part) => part.id === junction.partId);
  const junctionPoint = junctionPart ? terminalPoint(junctionPart, junction.terminal) : undefined;
  const routes = routeDocumentWires(document);
  const splitWires = crossed.flatMap((wire) => {
    const id = nextId("wire", wireIds);
    wireIds.push(id);
    const route = routes.get(wire.id);
    const divided = route && junctionPoint ? splitRouteAtPoint(route, junctionPoint) : undefined;
    const first = withWireWaypoints(
      { ...wire, to: junction },
      divided ? routeWaypoints(divided[0]) : undefined,
    );
    const second = withWireWaypoints(
      { id, from: junction, to: wire.to },
      divided ? routeWaypoints(divided[1]) : undefined,
    );
    return [
      first,
      second,
    ];
  });
  return {
    document: {
      ...document,
      wires: [...document.wires.filter((wire) => !crossedIds.has(wire.id)), ...splitWires],
    },
    splitWires,
  };
}

export function connect(
  document: CircuitDocument,
  from: CircuitEndpoint,
  to: CircuitEndpoint,
): EditResult<{ id: string }> {
  const reason = connectionError(document, from, to);
  if (reason) { return { ok: false, reason }; }
  const id = nextId(
    "wire",
    document.wires.map((wire) => wire.id),
  );
  return { ok: true, id, document: { ...document, wires: [...document.wires, { id, from, to }] } };
}

export type CircuitWireEnd = "from" | "to";

function withWireWaypoints(wire: CircuitWire, waypoints?: readonly Point[]): CircuitWire {
  if (waypoints && waypoints.length > 0) {
    return { ...wire, waypoints: waypoints.map((point) => ({ x: point.x, y: point.y })) };
  }
  return { id: wire.id, from: wire.from, to: wire.to };
}

/** Replaces a wire's intermediate route points, or clears them to restore automatic routing. */
export function setWireWaypoints(
  document: CircuitDocument,
  wireId: string,
  waypoints?: readonly Point[],
): EditResult {
  const wire = document.wires.find((item) => item.id === wireId);
  if (!wire) { return { ok: false, reason: "導線が見つかりません。" }; }
  const reason = waypointError(waypoints);
  if (reason) { return { ok: false, reason }; }
  const nextPoints = waypoints && waypoints.length > 0 ? waypoints : undefined;
  const unchanged = (wire.waypoints?.length ?? 0) === (nextPoints?.length ?? 0) &&
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
  if (!hasTerminal(document, target)) {
    return { ok: false, reason: "接続先の端子が見つかりません。" };
  }
  if (sameEndpoint(current, target)) { return { ok: true, id: wireId, document }; }
  const from = end === "from" ? target : wire.from;
  const to = end === "to" ? target : wire.to;
  const reason = connectionError(document, from, to, wireId);
  if (reason) { return { ok: false, reason }; }

  const wires = document.wires.map((item) => item.id === wireId
    ? { ...item, [end]: target }
    : item);
  return {
    ok: true,
    id: wireId,
    document: pruneOrphanJunction({ ...document, wires }, current.partId),
  };
}

/** Terminal whose position is exactly this cell, if any. */
export function terminalAt(document: CircuitDocument, point: Point): CircuitEndpoint | null {
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      const position = terminalPoint(part, terminal);
      if (position.x === point.x && position.y === point.y) { return { partId: part.id, terminal }; }
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
  const prepared = preparePointConnection(document, point, terminalAt(document, point));
  if (!prepared.ok) { return prepared; }
  const { document: baseDocument, endpoint, crossedWires } = prepared;
  if (crossedWires.length === 0) { return connect(baseDocument, from, endpoint); }
  if (from.partId === endpoint.partId) {
    return connect(document, from, endpoint);
  }

  const { document: splitDocument, splitWires } = splitWiresAtJunction(baseDocument, crossedWires, endpoint);
  const attached = splitWires.find(
    (wire) => sameEndpoint(wire.from, from) || sameEndpoint(wire.to, from),
  );
  if (attached) { return { ok: true, id: attached.id, document: splitDocument }; }
  return connect(splitDocument, from, endpoint);
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

  const current = wire[end];
  const existing = terminalAt(document, point);
  if (existing && sameEndpoint(current, existing)) { return { ok: true, id: wireId, document }; }

  const prepared = preparePointConnection(document, point, existing, wireId);
  if (!prepared.ok) { return prepared; }
  const { document: baseDocument, endpoint, crossedWires } = prepared;
  const splitDocument = crossedWires.length === 0
    ? baseDocument
    : splitWiresAtJunction(baseDocument, crossedWires, endpoint).document;
  return reconnectWire(splitDocument, wireId, end, endpoint);
}

/** Number of wires attached to a terminal. */
export function wireCount(document: CircuitDocument, endpoint: CircuitEndpoint) {
  return document.wires.filter(
    (wire) => sameEndpoint(wire.from, endpoint) || sameEndpoint(wire.to, endpoint),
  ).length;
}
