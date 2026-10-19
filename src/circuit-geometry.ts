import {
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitRotation,
  type CircuitRouteAnchor,
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
/** Coordinate limit used by serialized circuits, leaving headroom for pixel scaling. */
export const MAX_WIRE_COORDINATE = Number.MAX_SAFE_INTEGER / (GRID * 4);
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

/** Terminal position relative to the part centre before applying rotation. */
export function localTerminalOffset(kind: CircuitPartKind, terminal: CircuitTerminal): Point {
  const partKind = String(kind);
  const pin = String(terminal);
  if (partKind === "junction") { return { x: 0, y: 0 }; }
  if (partKind === "ground") { return { x: 0, y: -PART_REACH }; }
  if (partKind === "potentiometer") {
    if (pin === "c") { return { x: 0, y: -PART_REACH }; }
    return { x: pin === "a" ? -PART_REACH : PART_REACH, y: 0 };
  }
  if (["npn-transistor", "pnp-transistor", "nmos", "pmos"].includes(partKind)) {
    if (pin === "a") { return { x: 0, y: -PART_REACH }; }
    if (pin === "c") { return { x: 0, y: PART_REACH }; }
    return { x: -PART_REACH, y: 0 };
  }
  if (partKind === "op-amp") {
    if (pin === "a") { return { x: -PART_REACH, y: -1 }; }
    if (pin === "b") { return { x: -PART_REACH, y: 1 }; }
    return { x: PART_REACH, y: 0 };
  }
  return { x: pin === "a" ? -PART_REACH : PART_REACH, y: 0 };
}

/** Terminal position in cells. */
export function terminalPoint(part: CircuitPart, terminal: CircuitTerminal): Point {
  const offset = rotate(localTerminalOffset(part.kind, terminal), part.rotation);
  return { x: part.x + offset.x, y: part.y + offset.y };
}

/** Unit vector pointing away from the part at a terminal; null where wires may leave any way. */
export function terminalDirection(part: CircuitPart, terminal: CircuitTerminal): Point | null {
  const offset = localTerminalOffset(part.kind, terminal);
  if (offset.x === 0 && offset.y === 0) { return null; }
  const direction = Math.abs(offset.x) >= Math.abs(offset.y)
    ? { x: Math.sign(offset.x), y: 0 }
    : { x: 0, y: Math.sign(offset.y) };
  const rotated = rotate(direction, part.rotation);
  return { x: rotated.x || 0, y: rotated.y || 0 };
}

function boundsOfPoints(points: readonly Point[]): GridRect {
  const bounds = {
    minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY,
  };
  for (const { x, y } of points) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}

/** Cells a part occupies, including its terminals. */
export function footprint(part: CircuitPart): GridRect {
  const kind = String(part.kind);
  if (kind === "junction") { return { minX: part.x, minY: part.y, maxX: part.x, maxY: part.y }; }
  if (kind === "ground") {
    const localCorners = [
      { x: -1, y: -PART_REACH },
      { x: 1, y: -PART_REACH },
      { x: -1, y: 1 },
      { x: 1, y: 1 },
    ];
    return boundsOfPoints(localCorners.map((point) => {
      const offset = rotate(point, part.rotation);
      return { x: part.x + offset.x, y: part.y + offset.y };
    }));
  }
  if (["potentiometer", "npn-transistor", "pnp-transistor", "nmos", "pmos", "op-amp"].includes(kind)) {
    return {
      minX: part.x - PART_REACH,
      minY: part.y - PART_REACH,
      maxX: part.x + PART_REACH,
      maxY: part.y + PART_REACH,
    };
  }
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
  if (interiorsOverlap(firstRect, secondRect)) { return true; }
  if (first.kind === "junction" && strictlyInside(first, secondRect)) { return true; }
  if (second.kind === "junction" && strictlyInside(second, firstRect)) { return true; }
  const occupied = terminalPoints(first);
  return terminalPoints(second).some((point) =>
    occupied.some((other) => other.x === point.x && other.y === point.y),
  );
}

export interface RouteEnd {
  point: Point;
  direction: Point | null;
}

function stub({ point, direction }: RouteEnd, target?: Point): Point {
  if (direction && target) {
    const dx = target.x - point.x;
    const dy = target.y - point.y;
    const progress = dx * direction.x + dy * direction.y;
    // A nearby junction can terminate a lead before its normal one-cell length.
    if (progress > 0 && progress < 1 && dx * direction.y === dy * direction.x) { return target; }
  }
  return direction ? { x: point.x + direction.x, y: point.y + direction.y } : point;
}

function simplify(points: Point[]) {
  return simplifyManualRoute(points);
}

function leavesHorizontally(start: RouteEnd, end: RouteEnd) {
  if (start.direction) { return start.direction.x !== 0; }
  if (end.direction) { return end.direction.x !== 0; }
  return Math.abs(end.point.x - start.point.x) >= Math.abs(end.point.y - start.point.y);
}

/**
 * Orthogonal route in cells. Without occupied routes, use a middle dog-leg; otherwise prefer that
 * route when clear and search for a short detour when it shares an edge with an existing wire.
 * Crossings at a point are allowed. Terminal stubs keep their fixed outward direction.
 */
export function routeWire(start: RouteEnd, end: RouteEnd, occupied: readonly (readonly Point[])[] = []): Point[] {
  return routeAvoidingTerminalPoints(start, end, occupied, []);
}

function facingLeads(start: RouteEnd, end: RouteEnd): { first: Point; last: Point } | undefined {
  if (!start.direction || !end.direction ||
      start.direction.x !== -end.direction.x || start.direction.y !== -end.direction.y) { return; }
  const dx = end.point.x - start.point.x;
  const dy = end.point.y - start.point.y;
  const progress = dx * start.direction.x + dy * start.direction.y;
  if (progress <= 0 || progress >= 2 || dx * start.direction.y !== dy * start.direction.x) { return; }
  return {
    first: { x: start.point.x + dx / 4, y: start.point.y + dy / 4 },
    last: { x: end.point.x - dx / 4, y: end.point.y - dy / 4 },
  };
}

function leadBeforeOtherPin(start: RouteEnd, end: RouteEnd, fallback: Point): Point {
  if (!start.direction || !end.direction) { return fallback; }
  const dx = end.point.x - start.point.x;
  const dy = end.point.y - start.point.y;
  const progress = dx * start.direction.x + dy * start.direction.y;
  // A perpendicular pin can sit exactly at the normal one-cell stub. Leave room
  // to turn before reaching it, rather than visiting the pin midway through a route.
  if (progress > 0 && progress <= 1 && dx * start.direction.y === dy * start.direction.x) {
    return { x: start.point.x + dx / 2, y: start.point.y + dy / 2 };
  }
  return fallback;
}

function routeAvoidingTerminalPoints(start: RouteEnd, end: RouteEnd, occupied: readonly (readonly Point[])[], protectedPins: readonly Point[]): Point[] {
  // Facing pins closer than two cells share their lead corridor without
  // passing through either pin or retracing a full one-cell stub.
  const facing = facingLeads(start, end);
  const first = facing?.first ?? leadBeforeOtherPin(start, end, stub(start, end.direction ? undefined : end.point));
  const last = facing?.last ?? leadBeforeOtherPin(end, start, stub(end, start.direction ? undefined : start.point));
  return routeAroundWires(start, end, first, last, occupied, protectedPins);
}

function directWireRoute(start: RouteEnd, end: RouteEnd, first: Point, last: Point): Point[] {
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

/** Moves one orthogonal segment to an absolute grid coordinate, keeping wire endpoints fixed. */
export function moveWireSegment(
  route: readonly Point[],
  segmentIndex: number,
  coordinate: number,
  start?: RouteEnd,
  end?: RouteEnd,
): Point[] {
  const unchanged = () => route.map((point) => ({ ...point }));
  if (!Number.isFinite(coordinate) || !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 || segmentIndex >= route.length - 1) {
    return unchanged();
  }

  const first = route[segmentIndex];
  const last = route[segmentIndex + 1];
  if (!first || !last) { return unchanged(); }
  const horizontal = first.y === last.y;
  const vertical = first.x === last.x;
  if ((!horizontal && !vertical) || (first.x === last.x && first.y === last.y) ||
    coordinate === (horizontal ? first.y : first.x)) { return unchanged(); }

  const moveToLane = (point: Point): Point => horizontal
    ? { x: point.x, y: coordinate }
    : { x: coordinate, y: point.y };
  const laneConnector = (point: Point, neighbor: Point | undefined): Point[] => {
    const shifted = moveToLane(point);
    // Fold-backs leave adjacent segments on the same line. Retain their original corner
    // and add a perpendicular connector instead of joining the shifted corner diagonally.
    const collinear = neighbor && (horizontal ? neighbor.y === point.y : neighbor.x === point.x);
    return collinear ? [{ ...point }, shifted] : [shifted];
  };
  const isFirstSegment = segmentIndex === 0;
  const isLastSegment = segmentIndex + 1 === route.length - 1;
  const moved: Point[] = route.slice(0, segmentIndex).map((point) => ({ ...point }));

  if (isFirstSegment) {
    moved.push({ ...first });
    if (start?.direction) {
      const firstStub = stub(start);
      moved.push(firstStub, moveToLane(firstStub));
    } else {
      moved.push(moveToLane(first));
    }
  } else {
    moved.push(...laneConnector(first, route[segmentIndex - 1]));
  }

  if (isLastSegment) {
    if (end?.direction) {
      const lastStub = stub(end);
      moved.push(moveToLane(lastStub), lastStub, { ...last });
    } else {
      moved.push(moveToLane(last), { ...last });
    }
  } else {
    moved.push(...laneConnector(last, route[segmentIndex + 2]).reverse());
  }

  moved.push(...route.slice(segmentIndex + 2).map((point) => ({ ...point })));
  return restoreMovedTerminalLeads(moved, start, end);
}

function restoreMovedTerminalLeads(route: readonly Point[], start?: RouteEnd, end?: RouteEnd): Point[] {
  const simplified = simplifyManualRoute(route);
  if (!start?.direction && !end?.direction) { return simplified; }
  // Moving the bend next to a simplified terminal lead can pull that lead backwards. Use the
  // same terminal-aware routing as persisted waypoints so the preview keeps its outward stubs
  // and does not change shape when the edited route is saved.
  return routeThroughWaypoints(
    start ?? { point: route[0] as Point, direction: null },
    end ?? { point: route.at(-1) as Point, direction: null },
    simplified.slice(1, -1),
  );
}

interface RouteNode {
  point: Point;
  xIndex: number;
  yIndex: number;
  direction: number;
  cost: number;
  score: number;
  previous?: RouteNode;
}

interface RouteGrid {
  x: number[];
  y: number[];
}

interface RouteInterval {
  min: number;
  max: number;
}

interface RouteSpan extends RouteInterval {
  horizontal: boolean;
  lane: number;
}

interface UsedSegments {
  horizontal: Map<number, RouteInterval[]>;
  vertical: Map<number, RouteInterval[]>;
  blockedPoints: readonly Point[];
}

const ROUTE_DIRECTIONS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1}];
/** Bound synchronous work independently of coordinate magnitude and compressed grid size. */
const MAX_ROUTE_SEARCH_NODES = 20_000;

function routeSpan(from: Point, to: Point): RouteSpan | undefined {
  if (from.y === to.y && from.x !== to.x) {
    return { horizontal: true, lane: from.y, min: Math.min(from.x, to.x), max: Math.max(from.x, to.x) };
  }
  if (from.x === to.x && from.y !== to.y) {
    return { horizontal: false, lane: from.x, min: Math.min(from.y, to.y), max: Math.max(from.y, to.y) };
  }
  return undefined;
}

function mergeIntervals(lanes: Map<number, RouteInterval[]>) {
  for (const [lane, intervals] of lanes) {
    intervals.sort((a, b) => a.min - b.min);
    const merged: RouteInterval[] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.min <= previous.max) { previous.max = Math.max(previous.max, interval.max); }
      else { merged.push({ ...interval }); }
    }
    lanes.set(lane, merged);
  }
}

function collectUsedSegments(occupied: readonly (readonly Point[])[], blockedPoints: readonly Point[] = []): UsedSegments {
  const used: UsedSegments = { horizontal: new Map(), vertical: new Map(), blockedPoints };
  for (const route of occupied) {
    for (let index = 0; index < route.length - 1; index += 1) {
      const a = route[index];
      const b = route[index + 1];
      if (!a || !b) { continue; }
      const span = routeSpan(a, b);
      if (!span) { continue; }
      const lanes = span.horizontal ? used.horizontal : used.vertical;
      const intervals = lanes.get(span.lane) ?? [];
      intervals.push({ min: span.min, max: span.max });
      lanes.set(span.lane, intervals);
    }
  }
  mergeIntervals(used.horizontal);
  mergeIntervals(used.vertical);
  return used;
}

function intervalOverlaps(intervals: readonly RouteInterval[], interval: RouteInterval): boolean {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((intervals[middle]?.max ?? Number.POSITIVE_INFINITY) <= interval.min) { low = middle + 1; }
    else { high = middle; }
  }
  return (intervals[low]?.min ?? Number.POSITIVE_INFINITY) < interval.max;
}

function spansOverlap(first: RouteSpan | undefined, second: RouteSpan | undefined): boolean {
  return !!first && !!second && first.horizontal === second.horizontal && first.lane === second.lane &&
    Math.max(first.min, second.min) < Math.min(first.max, second.max);
}

function outsideInterval(interval: RouteInterval, excluded: RouteInterval): RouteInterval[] {
  if (interval.max <= excluded.min || interval.min >= excluded.max) { return [interval]; }
  const remaining: RouteInterval[] = [];
  if (interval.min < excluded.min) { remaining.push({ min: interval.min, max: excluded.min }); }
  if (interval.max > excluded.max) { remaining.push({ min: excluded.max, max: interval.max }); }
  return remaining;
}

function edgeConflicts(
  start: RouteEnd,
  end: RouteEnd,
  first: Point,
  last: Point,
  used: UsedSegments,
  from: Point,
  to: Point,
) {
  if (used.blockedPoints.some((point) => pointOnSegment(point, from, to))) { return true; }
  const span = routeSpan(from, to);
  if (!span) { return false; }
  let intervals: RouteInterval[] = [span];
  const stubs = [
    start.direction ? routeSpan(start.point, first) : undefined,
    end.direction ? routeSpan(last, end.point) : undefined,
  ];
  for (const lead of stubs) {
    if (spansOverlap(span, lead) && lead) {
      intervals = intervals.flatMap((interval) => outsideInterval(interval, lead));
    }
  }
  const occupied = (span.horizontal ? used.horizontal : used.vertical).get(span.lane) ?? [];
  return intervals.some((interval) => intervalOverlaps(occupied, interval));
}

function routeHasConflict(
  route: readonly Point[],
  start: RouteEnd,
  end: RouteEnd,
  first: Point,
  last: Point,
  used: UsedSegments,
) {
  return route.some((from, index) => {
    const to = route[index + 1];
    return to ? edgeConflicts(start, end, first, last, used, from, to) : false;
  });
}

function routeGrid(points: readonly Point[]): RouteGrid {
  const x = new Set<number>();
  const y = new Set<number>();
  for (const point of points) {
    for (const offset of [-1, 0, 1]) {
      x.add(point.x + offset);
      y.add(point.y + offset);
    }
  }
  return { x: [...x].sort((a, b) => a - b), y: [...y].sort((a, b) => a - b) };
}

function pointOnSegment(point: Point, from: Point, to: Point) {
  return from.x === to.x
    ? point.x === from.x && point.y >= Math.min(from.y, to.y) && point.y <= Math.max(from.y, to.y)
    : point.y === from.y && point.x >= Math.min(from.x, to.x) && point.x <= Math.max(from.x, to.x);
}

function terminalBlocksSegment(end: RouteEnd, from: Point, to: Point) {
  return !!end.direction && (pointOnSegment(end.point, from, to) ||
    spansOverlap(routeSpan(end.point, stub(end)), routeSpan(from, to)));
}

function outwardLead(end: RouteEnd, next: Point | undefined) {
  return !end.direction || !!next &&
    (next.x - end.point.x) * end.direction.x + (next.y - end.point.y) * end.direction.y > 0;
}

function routePreservesTerminals(route: readonly Point[], start: RouteEnd, end: RouteEnd) {
  if (!outwardLead(start, route[1]) || !outwardLead(end, route.at(-2))) { return false; }
  return route.every((from, index) => {
    const to = route[index + 1];
    return !to || (index === 0 || !terminalBlocksSegment(start, from, to)) &&
      (index === route.length - 2 || !terminalBlocksSegment(end, from, to));
  });
}

function pushRouteNode(heap: RouteNode[], node: RouteNode) {
  heap.push(node);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if ((heap[parent]?.score ?? Number.POSITIVE_INFINITY) <= node.score) { break; }
    heap[child] = heap[parent] as RouteNode;
    child = parent;
  }
  heap[child] = node;
}

function popRouteNode(heap: RouteNode[]): RouteNode | undefined {
  const root = heap[0];
  const tail = heap.pop();
  if (heap.length && tail) {
    let parent = 0;
    while (parent * 2 + 1 < heap.length) {
      let child = parent * 2 + 1;
      if ((heap[child + 1]?.score ?? Number.POSITIVE_INFINITY) < (heap[child]?.score ?? Number.POSITIVE_INFINITY)) { child += 1; }
      if ((heap[child]?.score ?? Number.POSITIVE_INFINITY) >= tail.score) { break; }
      heap[parent] = heap[child] as RouteNode;
      parent = child;
    }
    heap[parent] = tail;
  }
  return root;
}

function heuristic(point: Point, target: Point) {
  return 10 * (Math.abs(point.x - target.x) + Math.abs(point.y - target.y));
}

function routeKey(point: Point, direction: number) {
  return `${point.x},${point.y},${direction}`;
}

function createNextRouteNode(
  current: RouteNode,
  direction: number,
  start: RouteEnd,
  end: RouteEnd,
  grid: RouteGrid,
  used: UsedSegments,
  best: Map<string, number>,
): RouteNode | undefined {
  const vector = ROUTE_DIRECTIONS[direction] as Point;
  const xIndex = current.xIndex + vector.x;
  const yIndex = current.yIndex + vector.y;
  const x = grid.x[xIndex];
  const y = grid.y[yIndex];
  if (x === undefined || y === undefined) { return undefined; }
  const point = { x, y };
  if (terminalBlocksSegment(start, current.point, point) || terminalBlocksSegment(end, current.point, point) ||
      used.blockedPoints.some((blocked) => pointOnSegment(blocked, current.point, point))) { return undefined; }
  const span = routeSpan(current.point, point);
  const intervals = span ? (span.horizontal ? used.horizontal : used.vertical).get(span.lane) ?? [] : [];
  const conflict = span && intervalOverlaps(intervals, span);
  const cost = current.cost + heuristic(current.point, point) + (current.direction >= 0 && current.direction !== direction ? 8 : 0)
    + (conflict ? 10_000 : 0);
  if (cost >= (best.get(routeKey(point, direction)) ?? Number.POSITIVE_INFINITY)) { return undefined; }
  best.set(routeKey(point, direction), cost);
  return { point, xIndex, yIndex, direction, cost, score: cost + heuristic(point, stub(end)), previous: current };
}

function restoreRoute(current: RouteNode, start: RouteEnd, end: RouteEnd) {
  const middle: Point[] = [];
  for (let node: RouteNode | undefined = current; node; node = node.previous) { middle.push(node.point); }
  middle.reverse();
  return simplify([start.point, ...middle, end.point]);
}

function findDetour(
  start: RouteEnd,
  end: RouteEnd,
  first: Point,
  last: Point,
  grid: RouteGrid,
  used: UsedSegments,
): Point[] | undefined {
  const heap: RouteNode[] = [];
  const best = new Map<string, number>();
  const initialDirection = start.direction
    ? ROUTE_DIRECTIONS.findIndex((direction) => direction.x === start.direction?.x && direction.y === start.direction?.y)
    : -1;
  pushRouteNode(heap, {
    point: first, xIndex: grid.x.indexOf(first.x), yIndex: grid.y.indexOf(first.y),
    direction: initialDirection, cost: 0, score: heuristic(first, last),
  });

  let expanded = 0;
  while (heap.length && expanded < MAX_ROUTE_SEARCH_NODES) {
    expanded += 1;
    const current = popRouteNode(heap);
    if (!current) { break; }
    if (current.cost > (best.get(routeKey(current.point, current.direction)) ?? Number.POSITIVE_INFINITY)) { continue; }
    if (current.point.x === last.x && current.point.y === last.y) { return restoreRoute(current, start, end); }
    for (let direction = 0; direction < ROUTE_DIRECTIONS.length; direction += 1) {
      const next = createNextRouteNode(current, direction, start, end, grid, used, best);
      if (next) { pushRouteNode(heap, next); }
    }
  }
  return undefined;
}

function routeAroundWires(
  start: RouteEnd,
  end: RouteEnd,
  first: Point,
  last: Point,
  occupied: readonly (readonly Point[])[],
  protectedPins: readonly Point[] = [],
): Point[] {
  // Explicit waypoint endpoints remain reachable. Other component pins are
  // forbidden interior points, even though ordinary wire crossings are allowed.
  const blockedPoints = protectedPins.filter((point) =>
    (point.x !== start.point.x || point.y !== start.point.y) &&
    (point.x !== end.point.x || point.y !== end.point.y));
  const used = collectUsedSegments(occupied, blockedPoints);
  const direct = directWireRoute(start, end, first, last);
  if (routePreservesTerminals(direct, start, end) && !routeHasConflict(direct, start, end, first, last, used)) { return direct; }

  const points = [start.point, end.point, first, last, ...direct];
  for (const route of occupied) {
    for (const point of route) { points.push(point); }
  }
  const detour = findDetour(start, end, first, last, routeGrid(points), used);
  if (detour) { return detour; }
  const bounds = boundsOfPoints(points);
  return routeAroundBounds(start, end, {
    minX: bounds.minX - 2, minY: bounds.minY - 2,
    maxX: bounds.maxX + 2, maxY: bounds.maxY + 2,
  }, used);
}

function perimeterDistance(point: Point, rect: GridRect) {
  const width = rect.maxX - rect.minX;
  const height = rect.maxY - rect.minY;
  if (point.y === rect.minY) { return point.x - rect.minX; }
  if (point.x === rect.maxX) { return width + point.y - rect.minY; }
  if (point.y === rect.maxY) { return width + height + rect.maxX - point.x; }
  return 2 * width + height + rect.maxY - point.y;
}

function outwardBoundary(end: RouteEnd, rect: GridRect): Point {
  const direction = end.direction;
  if (direction?.x) { return { x: direction.x > 0 ? rect.maxX : rect.minX, y: end.point.y }; }
  return { x: end.point.x, y: (direction?.y ?? 1) > 0 ? rect.maxY : rect.minY };
}

function clockwiseBoundary(from: Point, to: Point, rect: GridRect) {
  const width = rect.maxX - rect.minX;
  const height = rect.maxY - rect.minY;
  const perimeter = 2 * (width + height);
  const first = perimeterDistance(from, rect);
  const distance = (perimeterDistance(to, rect) - first + perimeter) % perimeter;
  const corners = [
    { point: { x: rect.maxX, y: rect.minY }, at: width },
    { point: { x: rect.maxX, y: rect.maxY }, at: width + height },
    { point: { x: rect.minX, y: rect.maxY }, at: 2 * width + height },
    { point: { x: rect.minX, y: rect.minY }, at: perimeter },
  ].map((corner) => ({ ...corner, distance: (corner.at - first + perimeter) % perimeter }))
    .filter((corner) => corner.distance > 0 && corner.distance < distance)
    .sort((a, b) => a.distance - b.distance);
  return [from, ...corners.map((corner) => corner.point), to];
}

/** Feedback and tied pins must remain visibly outside their own component body. */
function routeTiedPins(part: CircuitPart, from: CircuitTerminal, to: CircuitTerminal, occupied: readonly (readonly Point[])[]) {
  const bounds = footprint(part);
  const rect = { minX: bounds.minX - 2, maxX: bounds.maxX + 2, minY: bounds.minY - 2, maxY: bounds.maxY + 2 };
  const start = routeEnd(part, from);
  const end = routeEnd(part, to);
  return routeAroundBounds(start, end, rect, collectUsedSegments(occupied));
}

function routeAroundBounds(start: RouteEnd, end: RouteEnd, rect: GridRect, used: UsedSegments) {
  const first = outwardBoundary(start, rect);
  const last = outwardBoundary(end, rect);
  const clockwise = clockwiseBoundary(first, last, rect);
  const counterclockwise = clockwiseBoundary(last, first, rect).reverse();
  const candidates = [clockwise, counterclockwise].map((middle) => simplify([start.point, ...middle, end.point]));
  const score = (points: Point[]) => points.slice(1).reduce((sum, point, index) =>
    sum + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0)
    + (routeHasConflict(points, start, end, stub(start), stub(end), used) ? 10_000 : 0);
  return score(candidates[0]) <= score(candidates[1]) ? candidates[0] : candidates[1];
}

function continuesStraight(before: Point, middle: Point, point: Point) {
  return before.y === middle.y && middle.y === point.y &&
    (middle.x - before.x) * (point.x - middle.x) > 0 ||
    before.x === middle.x && middle.x === point.x &&
    (middle.y - before.y) * (point.y - middle.y) > 0;
}

function simplifyManualRoute(points: readonly Point[]): Point[] {
  const route: Point[] = [];
  for (const point of points) {
    const previous = route.at(-1);
    if (previous?.x === point.x && previous.y === point.y) { continue; }
    while (route.length >= 2) {
      const before = route.at(-2);
      const middle = route.at(-1);
      if (!before || !middle) { break; }
      if (!continuesStraight(before, middle, point)) { break; }
      route.pop();
    }
    route.push({ ...point });
  }
  return route;
}

function appendRoute(target: Point[], points: readonly Point[]) {
  for (const point of points) {
    const previous = target.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) { target.push({ ...point }); }
  }
}

function samePoint(first: Point, second: Point) {
  return first.x === second.x && first.y === second.y;
}

function withinWireCoordinates(point: Point) {
  return Math.abs(point.x) <= MAX_WIRE_COORDINATE && Math.abs(point.y) <= MAX_WIRE_COORDINATE;
}

/** Encodes generated corners beyond the authored coordinate range as boundary-relative offsets. */
export function encodeWireRouteAnchors(points: readonly Point[]): CircuitRouteAnchor[] {
  return points.map(({ x, y }) => {
    const xBoundary: -1 | 1 | undefined = x > MAX_WIRE_COORDINATE ? 1 : x < -MAX_WIRE_COORDINATE ? -1 : undefined;
    const yBoundary: -1 | 1 | undefined = y > MAX_WIRE_COORDINATE ? 1 : y < -MAX_WIRE_COORDINATE ? -1 : undefined;
    return {
      x: xBoundary ? x - xBoundary * MAX_WIRE_COORDINATE : x,
      y: yBoundary ? y - yBoundary * MAX_WIRE_COORDINATE : y,
      ...(xBoundary ? { xBoundary } : {}),
      ...(yBoundary ? { yBoundary } : {}),
    };
  });
}

/** Restores generated route anchors to grid coordinates for terminal-aware routing. */
export function decodeWireRouteAnchors(anchors: readonly CircuitRouteAnchor[]): Point[] {
  return anchors.map(({ x, y, xBoundary, yBoundary }) => ({
    x: xBoundary ? xBoundary * MAX_WIRE_COORDINATE + x : x,
    y: yBoundary ? yBoundary * MAX_WIRE_COORDINATE + y : y,
  }));
}

function approachStubWaypoint(firstStub: Point, target: Point, continuation: Point, offset: Point): Point[] {
  const sign = (continuation.x - target.x) * offset.x + (continuation.y - target.y) * offset.y > 0 ? -1 : 1;
  const approachOffset = { x: sign * offset.x, y: sign * offset.y };
  return [
    { x: firstStub.x + approachOffset.x, y: firstStub.y + approachOffset.y },
    { x: target.x + approachOffset.x, y: target.y + approachOffset.y },
    target,
  ];
}

function routeLeadAroundOccupied(lead: readonly Point[], occupied: readonly (readonly Point[])[], protectedPins: readonly Point[]) {
  const route = lead.slice(0, 2).map((point) => ({ ...point }));
  // Generated approach corners are movable. Only the final user waypoint may
  // deliberately coincide with a pin; an intermediate corner must avoid it.
  const corners = lead.slice(2).filter((point, index, points) => index === points.length - 1 ||
    !protectedPins.some((pin) => pin.x === point.x && pin.y === point.y));
  for (const point of corners) {
    appendRoute(route, routeAvoidingTerminalPoints(
      { point: route.at(-1) as Point, direction: null },
      { point, direction: null },
      occupied,
      protectedPins,
    ).slice(1));
  }
  return simplifyManualRoute(route);
}

function terminalLead(start: RouteEnd, target: Point, continuation: Point, occupied: readonly (readonly Point[])[], protectedPins: readonly Point[], firstStub = stub(start)): Point[] {
  if (!start.direction) { return routeAvoidingTerminalPoints(start, { point: target, direction: null }, occupied, protectedPins); }
  const lead = [{ ...start.point }, firstStub];
  if (samePoint(target, firstStub)) { return lead; }
  const offset = {
    x: -start.direction.y * 2,
    y: start.direction.x * 2,
  };
  const progress =
    (target.x - start.point.x) * start.direction.x +
    (target.y - start.point.y) * start.direction.y;
  const perpendicularDistance =
    (target.x - start.point.x) * start.direction.y -
    (target.y - start.point.y) * start.direction.x;
  if (progress >= 1) {
    appendRoute(lead, routeAvoidingTerminalPoints(
      { point: firstStub, direction: null },
      { point: target, direction: null },
      occupied,
      protectedPins,
    ).slice(1));
    return simplifyManualRoute(lead);
  }

  if (progress > 0 && perpendicularDistance === 0) {
    if (samePoint(target, continuation)) {
      return [{ ...start.point }, { ...target }];
    }
    // Fractional waypoints may lie within the outward stub. Approach them perpendicular to
    // the stub so the lead is not retraced on the way back to the waypoint.
    appendRoute(lead, approachStubWaypoint(firstStub, target, continuation, offset));
    return routeLeadAroundOccupied(lead, occupied, protectedPins);
  }

  const continuationRoute = routeWire(
    { point: target, direction: null },
    { point: continuation, direction: null },
  );
  const next = continuationRoute.find((point) => point.x !== target.x || point.y !== target.y);
  const continuesHorizontally = next ? next.y === target.y : false;
  const finalLegIsHorizontal = !continuesHorizontally;
  if (perpendicularDistance !== 0) {
    if (start.direction.x !== 0) {
      if (finalLegIsHorizontal) {
        appendRoute(lead, [firstStub, { x: firstStub.x, y: target.y }, target]);
      } else {
        const approachY = target.y + Math.sign(target.y - firstStub.y);
        appendRoute(lead, [
          firstStub,
          { x: firstStub.x, y: approachY },
          { x: target.x, y: approachY },
          target,
        ]);
      }
    } else if (finalLegIsHorizontal) {
      const approachX = target.x + Math.sign(target.x - firstStub.x);
      appendRoute(lead, [
        firstStub,
        { x: approachX, y: firstStub.y },
        { x: approachX, y: target.y },
        target,
      ]);
    } else {
      appendRoute(lead, [firstStub, { x: target.x, y: firstStub.y }, target]);
    }
  } else {
    const stubOffset = { x: firstStub.x + offset.x, y: firstStub.y + offset.y };
    if (finalLegIsHorizontal === (start.direction.y === 0)) {
      const approach = {
        x: target.x - start.direction.x,
        y: target.y - start.direction.y,
      };
      const approachOffset = { x: approach.x + offset.x, y: approach.y + offset.y };
      appendRoute(lead, [stubOffset, approachOffset, approach, target]);
    } else {
      appendRoute(lead, [stubOffset, { x: target.x + offset.x, y: target.y + offset.y }, target]);
    }
  }
  return routeLeadAroundOccupied(lead, occupied, protectedPins);
}

function routeThroughWaypoints(start: RouteEnd, end: RouteEnd, waypoints: readonly Point[], preserveWaypoints = false): Point[] {
  const firstWaypoint = waypoints[0];
  const lastWaypoint = waypoints.at(-1);
  if (!firstWaypoint || !lastWaypoint) { return routeWire(start, end); }
  const terminalLeads: Point[][] = [];
  const protectedPins: Point[] = [];
  const facing = facingLeads(start, end);
  // A persisted first/last anchor may be the bend of a shortened terminal lead.
  // Splitting removes the old peer terminal, so recomputing only from the new
  // endpoints would grow that lead through the old peer pin or component body.
  const anchoredStub = (terminal: RouteEnd, waypoint: Point, fallback: Point) => {
    const anchored = stub(terminal, waypoint);
    const distance = (point: Point) => Math.abs(point.x - terminal.point.x) + Math.abs(point.y - terminal.point.y);
    return distance(anchored) < distance(fallback) ? anchored : fallback;
  };
  const startStub = anchoredStub(start, firstWaypoint, facing?.first ?? leadBeforeOtherPin(start, end, stub(start)));
  const endStub = anchoredStub(end, lastWaypoint, facing?.last ?? leadBeforeOtherPin(end, start, stub(end)));
  for (const [terminal, leadEnd] of [[start, startStub], [end, endStub]] as const) {
    if (terminal.direction) {
      terminalLeads.push([terminal.point, leadEnd]);
      protectedPins.push(terminal.point);
    }
  }
  const startContinuation = waypoints[1] ?? endStub;
  const route = terminalLead(start, firstWaypoint, startContinuation, terminalLeads, protectedPins, startStub);
  let current = firstWaypoint;
  for (const waypoint of waypoints.slice(1)) {
    appendRoute(route, routeAvoidingTerminalPoints(
      { point: current, direction: null },
      { point: waypoint, direction: null },
      terminalLeads,
      protectedPins,
    ).slice(1));
    current = waypoint;
  }
  if (end.direction) {
    const previousWaypoint = waypoints.at(-2) ?? startStub;
    const tail = terminalLead(end, current, previousWaypoint, terminalLeads, protectedPins, endStub).reverse();
    appendRoute(route, tail.slice(1));
  } else {
    appendRoute(route, routeAvoidingTerminalPoints(
      { point: current, direction: null },
      end,
      terminalLeads,
      protectedPins,
    ).slice(1));
  }
  return preserveWaypoints ? route : simplifyManualRoute(route);
}

/** Interprets legacy implicit waypoints and generates their terminal approaches once. */
export function routeWireThroughWaypoints(start: RouteEnd, end: RouteEnd, waypoints: readonly Point[]): Point[] {
  return routeThroughWaypoints(start, end, waypoints);
}

/** Checks a finished orthogonal route; new legacy candidates additionally need outward terminal leads. */
export function isExplicitWireRoute(start: RouteEnd, end: RouteEnd, points: readonly Point[], requireOutwardLeads = true): boolean {
  const route = simplifyManualRoute([start.point, ...points, end.point]);
  return route.every((point, index) => {
    const next = route[index + 1];
    return !next || point.x === next.x || point.y === next.y;
  }) && (!requireOutwardLeads || outwardLead(start, route[1]) && outwardLead(end, route.at(-2)));
}

function literalWireRoute(start: RouteEnd, end: RouteEnd, points: readonly Point[], preserveWaypoints = false): Point[] {
  const route = [start.point, ...points, end.point];
  return preserveWaypoints ? route : simplifyManualRoute(route);
}

function equalRoutes(first: readonly Point[], second: readonly Point[]) {
  return first.length === second.length && first.every((point, index) => samePoint(point, second[index]));
}

/** Checks legacy waypoint storage against the complete finished polyline, including both terminal approaches. */
export function wireRouteMatchesWaypoints(route: readonly Point[], start: RouteEnd, end: RouteEnd, waypoints: readonly Point[]): boolean {
  return equalRoutes(simplifyManualRoute(route), routeThroughWaypoints(start, end, waypoints));
}

/** Long straight runs need only their first and last internal anchors. */
function compactStraightRunAnchors(route: readonly Point[]) {
  const points: Point[] = [];
  const appendRun = (runFirst: number, last: number) => {
    const indexes = last - runFirst > 3 ? [runFirst, runFirst + 1, last - 1, last] :
      Array.from({ length: last - runFirst + 1 }, (_, index) => runFirst + index);
    appendRoute(points, indexes.map((index) => route[index]));
  };
  let first = 0;
  for (let index = 1; index < route.length - 1; index += 1) {
    if (continuesStraight(route[index - 1], route[index], route[index + 1])) { continue; }
    appendRun(first, index);
    first = index;
  }
  appendRun(first, route.length - 1);
  return points;
}

function compactRouteAnchors(route: readonly Point[], first: number, last: number, protectedPins: readonly Point[]) {
  const counts = Array.from({ length: route.length }, () => Number.POSITIVE_INFINITY);
  const previous = Array.from({ length: route.length }, () => -1);
  counts[first] = 0;
  for (let index = first; index < last; index += 1) {
    if (!Number.isFinite(counts[index])) { continue; }
    for (let candidate = index + 1; candidate <= last; candidate += 1) {
      const span = simplifyManualRoute(route.slice(index, candidate + 1));
      // An implicit dog-leg has at most three segments. Collinear source anchors may
      // lie between its bends, so count geometric segments rather than array entries.
      if (span.length > 4) { break; }
      if (counts[index] + 1 >= counts[candidate]) { continue; }
      const implicit = routeAvoidingTerminalPoints(
        { point: route[index], direction: null },
        { point: route[candidate], direction: null },
        [],
        protectedPins,
      );
      if (equalRoutes(implicit, span)) {
        counts[candidate] = counts[index] + 1;
        previous[candidate] = index;
      }
    }
  }
  const anchors: Point[] = [];
  for (let index = last; index >= first; index = previous[index]) { anchors.push({ ...route[index] }); }
  return anchors.reverse();
}

function explicitPinAnchors(route: readonly Point[], start: RouteEnd, end: RouteEnd): Point[] {
  const pins = [start, end].filter((terminal) => terminal.direction).map((terminal) => terminal.point);
  const result: Point[] = [];
  for (let index = 0; index < route.length - 1; index += 1) {
    const from = route[index];
    const to = route[index + 1];
    appendRoute(result, [from]);
    const interior = pins.filter((pin) => pointOnSegment(pin, from, to) &&
      (pin.x !== from.x || pin.y !== from.y) && (pin.x !== to.x || pin.y !== to.y));
    interior.sort((first, second) => Math.abs(first.x - from.x) + Math.abs(first.y - from.y) -
      Math.abs(second.x - from.x) - Math.abs(second.y - from.y));
    appendRoute(result, interior);
  }
  if (route.length) { appendRoute(result, [route.at(-1)!]); }
  return result;
}

function replayBoundedAnchors(anchors: readonly Point[], rendered: readonly Point[], start: RouteEnd, end: RouteEnd): Point[] | undefined {
  if (!anchors.length) { return; }
  const candidates = compactStraightRunAnchors(anchors);
  const protectedPins = [start, end].filter((terminal) => terminal.direction).map((terminal) => terminal.point);
  const compact = compactRouteAnchors(candidates, 0, candidates.length - 1, protectedPins);
  return equalRoutes(routeThroughWaypoints(start, end, compact), rendered) ? compact : undefined;
}

function boundedRouteAnchors(original: readonly Point[], rendered: readonly Point[], start: RouteEnd, end: RouteEnd): Point[] | undefined {
  const bounded = original.filter(withinWireCoordinates);
  if (bounded.length === original.length) { return; }
  // A junction endpoint can anchor an entire terminal approach. Keep generated lead corners
  // beyond the serialized coordinate limit implicit when a boundary part is split.
  const compact = replayBoundedAnchors(bounded, rendered, start, end);
  if (compact) { return compact; }
  for (const terminal of [start, end]) {
    if (terminal.direction) { continue; }
    const anchor = { ...terminal.point };
    const anchors = terminal === start ? [anchor, ...bounded] : [...bounded, anchor];
    const anchored = replayBoundedAnchors(anchors, rendered, start, end);
    if (anchored) { return anchored; }
    if (equalRoutes(routeThroughWaypoints(start, end, [anchor]), rendered)) { return [anchor]; }
  }
}

/** Stores a rendered route with implicit orthogonal bends, preserving its exact geometry. */
export function compactWireRouteWaypoints(route: readonly Point[], start: RouteEnd, end: RouteEnd, authoredWaypoints?: readonly Point[]): Point[] {
  const rendered = simplifyManualRoute(route);
  // Splitting changes the implicit final dog-leg. Try the original authored anchors before
  // replacing them with generated corners, which may exceed an already-full stored route.
  if (authoredWaypoints?.length && equalRoutes(routeThroughWaypoints(start, end, authoredWaypoints), rendered)) {
    return authoredWaypoints.map((point) => ({ ...point }));
  }
  // A user may explicitly route back through a pin. Collinear simplification
  // must retain that intent when the protected interior segments are replayed.
  const original = explicitPinAnchors(rendered, start, end).slice(1, -1);
  // Hidden authored anchors can encode the intervening bends more compactly than their
  // rendered corners. Retain them when removing boundary-only generated lead corners.
  const bounded = boundedRouteAnchors(explicitPinAnchors(route, start, end).slice(1, -1), rendered, start, end);
  if (bounded) { return bounded; }
  if (rendered.length === 2) {
    // An empty list selects automatic routing, which may detour around a wire added before this
    // split segment. Keep one anchor even for a straight segment; use the outward stub where a
    // component terminal needs it, and the endpoint itself where a junction has no fixed lead.
    const anchor = facingLeads(start, end)?.first ?? stub(start, end.direction ? undefined : end.point);
    const restored = routeThroughWaypoints(start, end, [anchor]);
    return equalRoutes(restored, rendered) ? [anchor] : original;
  }
  if (rendered.length < 4) { return original; }
  const protectedPins = [start, end].filter((terminal) => terminal.direction).map((terminal) => terminal.point);
  // Keep intentional pin visits available to the span search. Its protected
  // rerouting checks retain those local anchors without discarding distant compression.
  const candidates = explicitPinAnchors(compactStraightRunAnchors(route), start, end);
  const compact = compactRouteAnchors(candidates, 0, candidates.length - 1, protectedPins).slice(1, -1);
  if (compact.length > 0 && equalRoutes(routeThroughWaypoints(start, end, compact), rendered)) { return compact; }
  // Fixed-direction terminals may need their first and last internal points. Only
  // accept a compaction after re-rendering it with the real terminal directions.
  const waypoints = compactRouteAnchors(candidates, 1, candidates.length - 2, protectedPins);
  return equalRoutes(routeThroughWaypoints(start, end, waypoints), rendered) ? waypoints : original;
}

/** Routes each wire around preceding wires; optionally retains collinear source anchors for edits. */
export function routeDocumentWires(document: CircuitDocument, options: { preserveWaypoints?: boolean } = {}): Map<string, Point[]> {
  const parts = new Map(document.parts.map((part) => [part.id, part]));
  const routes = new Map<string, Point[]>();
  const occupied: Point[][] = [];
  for (const wire of document.wires) {
    const from = parts.get(wire.from.partId);
    const to = parts.get(wire.to.partId);
    if (!from || !to) { continue; }
    const start = routeEnd(from, wire.from.terminal);
    const end = routeEnd(to, wire.to.terminal);
    const route = wire.routeAnchors?.length
      ? literalWireRoute(start, end, decodeWireRouteAnchors(wire.routeAnchors), options.preserveWaypoints)
      : wire.waypoints?.length
      ? routeThroughWaypoints(start, end, wire.waypoints, options.preserveWaypoints)
      : from.id === to.id && terminalsOf(from.kind).length >= 2
        ? routeTiedPins(from, wire.from.terminal, wire.to.terminal, occupied)
        : routeWire(start, end, occupied);
    routes.set(wire.id, route);
    // Collinear editing anchors must not change the grid used to route later wires.
    occupied.push(options.preserveWaypoints ? simplifyManualRoute(route) : route);
  }
  return routes;
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

/** Bounds of every part footprint and wire route, or null for an empty document. */
export function contentBounds(document: CircuitDocument): GridRect | null {
  if (document.parts.length === 0) { return null; }
  const rects = document.parts.map(footprint);
  let minX = Math.min(...rects.map((rect) => rect.minX));
  let minY = Math.min(...rects.map((rect) => rect.minY));
  let maxX = Math.max(...rects.map((rect) => rect.maxX));
  let maxY = Math.max(...rects.map((rect) => rect.maxY));
  for (const wire of document.wires) {
    for (const point of wire.routeAnchors?.length ? decodeWireRouteAnchors(wire.routeAnchors) : wire.waypoints ?? []) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  // Automatic detours and terminal approaches can extend beyond both the parts
  // and the authored waypoints. Fit the actual paths that are shown on the board.
  for (const route of routeDocumentWires(document).values()) {
    for (const point of route) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
  };
}

/**
 * Sheet dimensions in cells, enclosing the origin and content bounds with the existing
 * total padding of 8 columns and 6 rows, and at least MIN_BOARD. These dimensions do
 * not set a viewport origin; use contentBounds to position content at negative coordinates.
 */
export function boardSize(document: CircuitDocument) {
  const bounds = contentBounds(document);
  const width = bounds ? Math.max(0, bounds.maxX) - Math.min(0, bounds.minX) : 0;
  const height = bounds ? Math.max(0, bounds.maxY) - Math.min(0, bounds.minY) : 0;
  return {
    columns: Math.max(MIN_BOARD.columns, width + 8),
    rows: Math.max(MIN_BOARD.rows, height + 6),
  };
}

export function snapToGrid(point: Point): Point {
  return {
    x: Math.round(point.x / GRID),
    y: Math.round(point.y / GRID),
  };
}
