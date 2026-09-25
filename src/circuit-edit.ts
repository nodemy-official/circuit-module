import {
  BOARD_MARGIN,
  footprint,
  nextRotation,
  partsConflict,
  routeEnd,
  routeWire,
  terminalPoint,
  type Point,
} from "./circuit-geometry.js";
import {
  circuitPartCatalog,
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
  while (taken.has(`${prefix}-${number}`)) number += 1;
  return `${prefix}-${number}`;
}

/** "抵抗", then "抵抗2", "抵抗3"… so parts of one kind stay distinguishable. */
export function nextLabel(document: CircuitDocument, kind: CircuitPartKind) {
  const base = circuitPartCatalog[kind].defaults.label;
  const labels = new Set(document.parts.map((part) => part.label));
  if (!labels.has(base)) return base;
  let number = 2;
  while (labels.has(`${base}${number}`)) number += 1;
  return `${base}${number}`;
}

function insideBoard(part: CircuitPart) {
  const rect = footprint(part);
  return rect.minX >= BOARD_MARGIN && rect.minY >= BOARD_MARGIN;
}

/** Whether the candidates fit among the document's other parts. */
export function canPlace(document: CircuitDocument, candidates: readonly CircuitPart[]) {
  const moving = new Set(candidates.map((part) => part.id));
  const others = document.parts.filter((part) => !moving.has(part.id));
  return candidates.every(
    (candidate, index) =>
      insideBoard(candidate) &&
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
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const candidate = probe(near.x + dx * 2, near.y + dy * 2);
        if (canPlace(document, [candidate])) return { x: candidate.x, y: candidate.y };
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
  const id = nextId(
    "part",
    document.parts.map((part) => part.id),
  );
  const part: CircuitPart = {
    id,
    kind,
    ...at,
    ...circuitPartCatalog[kind].defaults,
    label: nextLabel(document, kind),
  };
  if (!canPlace(document, [part]))
    return { ok: false, reason: "そこには置けません。ほかの部品と重なります。" };
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
  };
}

export function moveParts(
  document: CircuitDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
): EditResult {
  const next = shiftParts(document, ids, dx, dy);
  const moved = next.parts.filter((part) => ids.includes(part.id));
  if (!canPlace(next, moved)) return { ok: false, reason: "その位置にはほかの部品があります。" };
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
  if (!canPlace(next, rotated)) return { ok: false, reason: "回転するとほかの部品と重なります。" };
  return { ok: true, document: next };
}

export function removeSelection(
  document: CircuitDocument,
  selection: CircuitSelection,
): CircuitDocument {
  const parts = new Set(selection.parts);
  const wires = new Set(selection.wires);
  return {
    ...document,
    parts: document.parts.filter((part) => !parts.has(part.id)),
    wires: document.wires.filter(
      (wire) => !wires.has(wire.id) && !parts.has(wire.from.partId) && !parts.has(wire.to.partId),
    ),
  };
}

export function copyFragment(
  document: CircuitDocument,
  selection: CircuitSelection,
): CircuitFragment {
  const ids = new Set(selection.parts);
  return {
    parts: document.parts.filter((part) => ids.has(part.id)),
    wires: document.wires.filter((wire) => ids.has(wire.from.partId) && ids.has(wire.to.partId)),
  };
}

function renumber(document: CircuitDocument, fragment: CircuitFragment, dx: number, dy: number) {
  const partIds = document.parts.map((part) => part.id);
  const wireIds = document.wires.map((wire) => wire.id);
  const mapping = new Map<string, string>();
  const parts = fragment.parts.map((part) => {
    const id = nextId("part", partIds);
    partIds.push(id);
    mapping.set(part.id, id);
    return { ...part, id, x: part.x + dx, y: part.y + dy };
  });
  const endpoint = (end: CircuitEndpoint) => ({
    ...end,
    partId: mapping.get(end.partId) ?? end.partId,
  });
  const wires = fragment.wires.map((wire) => {
    const id = nextId("wire", wireIds);
    wireIds.push(id);
    return { id, from: endpoint(wire.from), to: endpoint(wire.to) };
  });
  return { parts, wires };
}

/** Pastes a fragment at the first free diagonal offset, selecting the copies. */
export function pasteFragment(
  document: CircuitDocument,
  fragment: CircuitFragment,
): EditResult<{ selection: CircuitSelection }> {
  if (fragment.parts.length === 0) return { ok: false, reason: "コピーした部品がありません。" };
  for (let step = 1; step <= 12; step += 1) {
    const copy = renumber(document, fragment, step * 2, step * 2);
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

function wirePassesThrough(document: CircuitDocument, wire: CircuitWire, point: Point) {
  const parts = new Map(document.parts.map((part) => [part.id, part]));
  const from = parts.get(wire.from.partId);
  const to = parts.get(wire.to.partId);
  if (!from || !to) return false;
  const route = routeWire(routeEnd(from, wire.from.terminal), routeEnd(to, wire.to.terminal));
  return route.some((start, index) => {
    const end = route[index + 1];
    return end ? pointOnSegment(point, start, end) : point.x === start.x && point.y === start.y;
  });
}

export function connect(
  document: CircuitDocument,
  from: CircuitEndpoint,
  to: CircuitEndpoint,
): EditResult<{ id: string }> {
  if (!hasTerminal(document, from) || !hasTerminal(document, to))
    return { ok: false, reason: "接続先の端子が見つかりません。" };
  if (sameEndpoint(from, to)) return { ok: false, reason: "同じ端子同士は接続できません。" };
  if (from.partId === to.partId)
    return { ok: false, reason: "同じ部品の端子同士は接続できません。" };
  const duplicated = document.wires.some(
    (wire) =>
      (sameEndpoint(wire.from, from) && sameEndpoint(wire.to, to)) ||
      (sameEndpoint(wire.from, to) && sameEndpoint(wire.to, from)),
  );
  if (duplicated) return { ok: false, reason: "その端子間にはすでに導線があります。" };
  const id = nextId(
    "wire",
    document.wires.map((wire) => wire.id),
  );
  return { ok: true, id, document: { ...document, wires: [...document.wires, { id, from, to }] } };
}

/** Terminal whose position is exactly this cell, if any. */
export function terminalAt(document: CircuitDocument, point: Point): CircuitEndpoint | null {
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      const position = terminalPoint(part, terminal);
      if (position.x === point.x && position.y === point.y) return { partId: part.id, terminal };
    }
  }
  return null;
}

/** Connects a terminal to a cell, placing a junction there when no terminal is waiting. */
export function connectToPoint(
  document: CircuitDocument,
  from: CircuitEndpoint,
  point: Point,
): EditResult<{ id: string }> {
  const existing = terminalAt(document, point);
  const crossed = document.wires.filter(
    (wire) =>
      wirePassesThrough(document, wire, point) &&
      (!existing || (!sameEndpoint(wire.from, existing) && !sameEndpoint(wire.to, existing))),
  );
  if (crossed.length === 0 && existing) return connect(document, from, existing);

  const placed = existing ? null : addPart(document, "junction", point);
  if (placed && !placed.ok) return placed;
  const junction = placed ? { partId: placed.id, terminal: "a" as const } : existing;
  if (!junction) return { ok: false, reason: "接続先の端子が見つかりません。" };
  const baseDocument = placed?.document ?? document;
  if (crossed.length === 0) return connect(baseDocument, from, junction);
  if (sameEndpoint(from, junction) || from.partId === junction.partId)
    return connect(document, from, junction);

  const crossedIds = new Set(crossed.map((wire) => wire.id));
  const wireIds = document.wires.map((wire) => wire.id);
  const splitWires = crossed.flatMap((wire) => {
    const id = nextId("wire", wireIds);
    wireIds.push(id);
    return [
      { ...wire, to: junction },
      { id, from: junction, to: wire.to },
    ];
  });
  const wires = [...baseDocument.wires.filter((wire) => !crossedIds.has(wire.id)), ...splitWires];
  const splitDocument = { ...baseDocument, wires };
  const attached = splitWires.find(
    (wire) => sameEndpoint(wire.from, from) || sameEndpoint(wire.to, from),
  );
  if (attached) return { ok: true, id: attached.id, document: splitDocument };
  return connect(splitDocument, from, junction);
}

/** Number of wires attached to a terminal. */
export function wireCount(document: CircuitDocument, endpoint: CircuitEndpoint) {
  return document.wires.filter(
    (wire) => sameEndpoint(wire.from, endpoint) || sameEndpoint(wire.to, endpoint),
  ).length;
}
