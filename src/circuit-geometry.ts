import {
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitRotation,
  type CircuitTerminal,
} from "./circuit-model.js";

export interface Point {
  x: number;
  y: number;
}

export interface GridRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Pixels per ruled cell. Part coordinates are in cells. */
export const GRID = 20;
/** Every fifth ruled line is drawn darker, like section paper. */
export const MAJOR_EVERY = 5;
/** Cells from a part's centre to each terminal. */
export const PART_REACH = 2;
/** Legacy minimum sheet margin, retained for compatibility with existing consumers. */
export const BOARD_MARGIN = 1;
export const MIN_BOARD = { columns: 48, rows: 28 };

export const rotations: CircuitRotation[] = [0, 90, 180, 270];

export function nextRotation(rotation: CircuitRotation = 0): CircuitRotation {
  return rotations[(rotations.indexOf(rotation) + 1) % rotations.length] ?? 0;
}

/** Rotates a vector clockwise on screen (y grows downwards). */
export function rotate({ x, y }: Point, rotation: CircuitRotation = 0): Point {
  switch (rotation) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}

export function isVertical(part: Pick<CircuitPart, "rotation">) {
  return part.rotation === 90 || part.rotation === 270;
}

function terminalVector(kind: CircuitPartKind, terminal: CircuitTerminal): Point {
  if (kind === "junction") return { x: 0, y: 0 };
  return { x: terminal === "a" ? -PART_REACH : PART_REACH, y: 0 };
}

/** Terminal position in cells. */
export function terminalPoint(part: CircuitPart, terminal: CircuitTerminal): Point {
  const offset = rotate(terminalVector(part.kind, terminal), part.rotation);
  return { x: part.x + offset.x, y: part.y + offset.y };
}

/** Unit vector pointing away from the part at a terminal; null where wires may leave any way. */
export function terminalDirection(part: CircuitPart, terminal: CircuitTerminal): Point | null {
  if (part.kind === "junction") return null;
  return rotate({ x: terminal === "a" ? -1 : 1, y: 0 }, part.rotation);
}

/** Cells a part occupies, including its terminals. */
export function footprint(part: CircuitPart): GridRect {
  if (part.kind === "junction") return { minX: part.x, minY: part.y, maxX: part.x, maxY: part.y };
  const along = PART_REACH;
  const across = 1;
  const [halfX, halfY] = isVertical(part) ? [across, along] : [along, across];
  return { minX: part.x - halfX, minY: part.y - halfY, maxX: part.x + halfX, maxY: part.y + halfY };
}

function interiorsOverlap(first: GridRect, second: GridRect) {
  return (
    first.minX < second.maxX &&
    second.minX < first.maxX &&
    first.minY < second.maxY &&
    second.minY < first.maxY
  );
}

function strictlyInside(point: Point, rect: GridRect) {
  return point.x > rect.minX && point.x < rect.maxX && point.y > rect.minY && point.y < rect.maxY;
}

function terminalPoints(part: CircuitPart) {
  return terminalsOf(part.kind).map((terminal) => terminalPoint(part, terminal));
}

/**
 * Two parts conflict when their bodies overlap, a junction sits inside a body, or two terminals
 * land on the same point (which would look connected without a wire).
 */
export function partsConflict(first: CircuitPart, second: CircuitPart) {
  const firstRect = footprint(first);
  const secondRect = footprint(second);
  if (interiorsOverlap(firstRect, secondRect)) return true;
  if (first.kind === "junction" && strictlyInside(first, secondRect)) return true;
  if (second.kind === "junction" && strictlyInside(second, firstRect)) return true;
  const occupied = terminalPoints(first);
  return terminalPoints(second).some((point) =>
    occupied.some((other) => other.x === point.x && other.y === point.y),
  );
}

export interface RouteEnd {
  point: Point;
  direction: Point | null;
}

function stub({ point, direction }: RouteEnd): Point {
  return direction ? { x: point.x + direction.x, y: point.y + direction.y } : point;
}

function simplify(points: Point[]) {
  const unique = points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1]?.x || point.y !== points[index - 1]?.y,
  );
  return unique.filter((point, index) => {
    const before = unique[index - 1];
    const after = unique[index + 1];
    if (!before || !after) return true;
    return !(
      (before.x === point.x && point.x === after.x) ||
      (before.y === point.y && point.y === after.y)
    );
  });
}

function leavesHorizontally(start: RouteEnd, end: RouteEnd) {
  if (start.direction) return start.direction.x !== 0;
  if (end.direction) return end.direction.x !== 0;
  return Math.abs(end.point.x - start.point.x) >= Math.abs(end.point.y - start.point.y);
}

/**
 * Orthogonal route in cells: a one-cell stub out of each terminal, then a dog-leg whose middle
 * segment sits on a ruled line halfway between the ends.
 */
export function routeWire(start: RouteEnd, end: RouteEnd): Point[] {
  const first = stub(start);
  const last = stub(end);
  if (first.x === last.x || first.y === last.y) {
    return simplify([start.point, first, last, end.point]);
  }
  if (leavesHorizontally(start, end)) {
    const middle = Math.round((first.x + last.x) / 2);
    return simplify([
      start.point,
      first,
      { x: middle, y: first.y },
      { x: middle, y: last.y },
      last,
      end.point,
    ]);
  }
  const middle = Math.round((first.y + last.y) / 2);
  return simplify([
    start.point,
    first,
    { x: first.x, y: middle },
    { x: last.x, y: middle },
    last,
    end.point,
  ]);
}

export function routeEnd(part: CircuitPart, terminal: CircuitTerminal): RouteEnd {
  return { point: terminalPoint(part, terminal), direction: terminalDirection(part, terminal) };
}

/** SVG path data in pixels for a route given in cells. */
export function pathData(points: readonly Point[]) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x * GRID} ${point.y * GRID}`)
    .join(" ");
}

/** Bounds of every part footprint, or null for an empty document. */
export function contentBounds(document: CircuitDocument): GridRect | null {
  if (document.parts.length === 0) return null;
  const rects = document.parts.map(footprint);
  return {
    minX: Math.min(...rects.map((rect) => rect.minX)),
    minY: Math.min(...rects.map((rect) => rect.minY)),
    maxX: Math.max(...rects.map((rect) => rect.maxX)),
    maxY: Math.max(...rects.map((rect) => rect.maxY)),
  };
}

/** Board size in cells: the minimum sheet, grown to keep room around the content. */
export function boardSize(document: CircuitDocument) {
  const bounds = contentBounds(document);
  return {
    columns: Math.max(MIN_BOARD.columns, (bounds?.maxX ?? 0) + 8),
    rows: Math.max(MIN_BOARD.rows, (bounds?.maxY ?? 0) + 6),
  };
}

export function snapToGrid(point: Point): Point {
  return {
    x: Math.round(point.x / GRID),
    y: Math.round(point.y / GRID),
  };
}
