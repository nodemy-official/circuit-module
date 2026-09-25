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
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y)),
  };
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
    if (!before || !after) { return true; }
    return !(
      (before.x === point.x && point.x === after.x) ||
      (before.y === point.y && point.y === after.y)
    );
  });
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
  const first = stub(start);
  const last = stub(end);
  if (occupied.length > 0) { return routeAroundWires(start, end, first, last, occupied); }
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
  if ((!horizontal && !vertical) || (first.x === last.x && first.y === last.y)) { return unchanged(); }

  const moveToLane = (point: Point): Point => horizontal
    ? { x: point.x, y: coordinate }
    : { x: coordinate, y: point.y };
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
    moved.push(moveToLane(first));
  }

  if (isLastSegment) {
    if (end?.direction) {
      const lastStub = stub(end);
      moved.push(moveToLane(lastStub), lastStub, { ...last });
    } else {
      moved.push(moveToLane(last), { ...last });
    }
  } else {
    moved.push(moveToLane(last));
  }

  moved.push(...route.slice(segmentIndex + 2).map((point) => ({ ...point })));
  return simplify(moved);
}

function edgeKey(a: Point, b: Point) {
  return a.x < b.x || (a.x === b.x && a.y < b.y)
    ? `${a.x},${a.y}:${b.x},${b.y}`
    : `${b.x},${b.y}:${a.x},${a.y}`;
}

interface RouteNode {
  point: Point;
  direction: number;
  cost: number;
  score: number;
  previous?: RouteNode;
}

interface RouteBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const ROUTE_DIRECTIONS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1}];

function collectUsedEdges(occupied: readonly (readonly Point[])[]) {
  const usedEdges = new Set<string>();
  for (const route of occupied) {
    for (let index = 0; index < route.length - 1; index += 1) {
      const a = route[index];
      const b = route[index + 1];
      if (!a || !b) { continue; }
      const dx = Math.sign(b.x - a.x);
      const dy = Math.sign(b.y - a.y);
      const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      for (let step = 0; step < length; step += 1) {
        const here = { x: a.x + dx * step, y: a.y + dy * step };
        const next = { x: here.x + dx, y: here.y + dy };
        usedEdges.add(edgeKey(here, next));
      }
    }
  }
  return usedEdges;
}

function edgeConflicts(
  start: RouteEnd,
  end: RouteEnd,
  first: Point,
  last: Point,
  usedEdges: ReadonlySet<string>,
  from: Point,
  to: Point,
) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  for (let step = 0; step < length; step += 1) {
    const here = { x: from.x + dx * step, y: from.y + dy * step };
    const edge = edgeKey(here, { x: here.x + dx, y: here.y + dy });
    const isTerminalStub =
      (start.direction && edge === edgeKey(start.point, first)) ||
      (end.direction && edge === edgeKey(last, end.point));
    if (usedEdges.has(edge) && !isTerminalStub) { return true; }
  }
  return false;
}

function routeHasConflict(
  route: readonly Point[],
  start: RouteEnd,
  end: RouteEnd,
  first: Point,
  last: Point,
  usedEdges: ReadonlySet<string>,
) {
  return route.some((from, index) => {
    const to = route[index + 1];
    return to ? edgeConflicts(start, end, first, last, usedEdges, from, to) : false;
  });
}

function routeBounds(points: readonly Point[]): RouteBounds {
  return {
    minX: Math.min(...points.map((point) => point.x)) - 6,
    maxX: Math.max(...points.map((point) => point.x)) + 6,
    minY: Math.min(...points.map((point) => point.y)) - 6,
    maxY: Math.max(...points.map((point) => point.y)) + 6,
  };
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
  bounds: RouteBounds,
  usedEdges: ReadonlySet<string>,
  best: Map<string, number>,
): RouteNode | undefined {
  const vector = ROUTE_DIRECTIONS[direction] as Point;
  const point = { x: current.point.x + vector.x, y: current.point.y + vector.y };
  if (point.x < bounds.minX || point.x > bounds.maxX || point.y < bounds.minY || point.y > bounds.maxY) { return undefined; }
  if (point.x === start.point.x && point.y === start.point.y && start.direction) { return undefined; }
  if (point.x === end.point.x && point.y === end.point.y && end.direction) { return undefined; }
  const cost = current.cost + 10 + (current.direction >= 0 && current.direction !== direction ? 8 : 0)
    + (usedEdges.has(edgeKey(current.point, point)) ? 10_000 : 0);
  if (cost >= (best.get(routeKey(point, direction)) ?? Number.POSITIVE_INFINITY)) { return undefined; }
  best.set(routeKey(point, direction), cost);
  return { point, direction, cost, score: cost + heuristic(point, end.point), previous: current };
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
  bounds: RouteBounds,
  usedEdges: ReadonlySet<string>,
): Point[] | undefined {
  const heap: RouteNode[] = [];
  const best = new Map<string, number>();
  const initialDirection = start.direction
    ? ROUTE_DIRECTIONS.findIndex((direction) => direction.x === start.direction?.x && direction.y === start.direction?.y)
    : -1;
  pushRouteNode(heap, { point: first, direction: initialDirection, cost: 0, score: heuristic(first, last) });

  while (heap.length) {
    const current = popRouteNode(heap);
    if (!current) { break; }
    if (current.cost > (best.get(routeKey(current.point, current.direction)) ?? Number.POSITIVE_INFINITY)) { continue; }
    if (current.point.x === last.x && current.point.y === last.y) { return restoreRoute(current, start, end); }
    for (let direction = 0; direction < ROUTE_DIRECTIONS.length; direction += 1) {
      const next = createNextRouteNode(current, direction, start, end, bounds, usedEdges, best);
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
): Point[] {
  const usedEdges = collectUsedEdges(occupied);
  const direct = routeWire(start, end);
  if (!routeHasConflict(direct, start, end, first, last, usedEdges)) { return direct; }

  const points = [start.point, end.point, ...occupied.flat()];
  return findDetour(start, end, first, last, routeBounds(points), usedEdges) ?? direct;
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
  const first = outwardBoundary(start, rect);
  const last = outwardBoundary(end, rect);
  const usedEdges = collectUsedEdges(occupied);
  const clockwise = clockwiseBoundary(first, last, rect);
  const counterclockwise = clockwiseBoundary(last, first, rect).reverse();
  const candidates = [clockwise, counterclockwise].map((middle) => simplify([start.point, ...middle, end.point]));
  const score = (points: Point[]) => points.slice(1).reduce((sum, point, index) =>
    sum + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0)
    + (routeHasConflict(points, start, end, stub(start), stub(end), usedEdges) ? 10_000 : 0);
  return score(candidates[0]) <= score(candidates[1]) ? candidates[0] : candidates[1];
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
      const continuesHorizontally = before.y === middle.y && middle.y === point.y &&
        (middle.x - before.x) * (point.x - middle.x) > 0;
      const continuesVertically = before.x === middle.x && middle.x === point.x &&
        (middle.y - before.y) * (point.y - middle.y) > 0;
      if (!continuesHorizontally && !continuesVertically) { break; }
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

function terminalLead(start: RouteEnd, target: Point, continuation: Point): Point[] {
  if (!start.direction) { return routeWire(start, { point: target, direction: null }); }
  const firstStub = stub(start);
  const lead = [{ ...start.point }, firstStub];
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
    appendRoute(lead, routeWire(
      { point: firstStub, direction: null },
      { point: target, direction: null },
    ).slice(1));
    return simplifyManualRoute(lead);
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
  return simplifyManualRoute(lead);
}

function routeThroughWaypoints(start: RouteEnd, end: RouteEnd, waypoints: readonly Point[]): Point[] {
  const firstWaypoint = waypoints[0];
  const lastWaypoint = waypoints.at(-1);
  if (!firstWaypoint || !lastWaypoint) { return routeWire(start, end); }
  const startContinuation = waypoints[1] ?? (end.direction ? stub(end) : end.point);
  const route = terminalLead(start, firstWaypoint, startContinuation);
  let current = firstWaypoint;
  for (const waypoint of waypoints.slice(1)) {
    appendRoute(route, routeWire(
      { point: current, direction: null },
      { point: waypoint, direction: null },
    ).slice(1));
    current = waypoint;
  }
  if (end.direction) {
    const previousWaypoint = waypoints.at(-2) ?? (start.direction ? stub(start) : start.point);
    const tail = terminalLead(end, current, previousWaypoint).reverse();
    appendRoute(route, tail.slice(1));
  } else {
    appendRoute(route, routeWire(
      { point: current, direction: null },
      end,
    ).slice(1));
  }
  return simplifyManualRoute(route);
}

/** Routes each wire around the preceding wires in document order. */
export function routeDocumentWires(document: CircuitDocument): Map<string, Point[]> {
  const parts = new Map(document.parts.map((part) => [part.id, part]));
  const routes = new Map<string, Point[]>();
  for (const wire of document.wires) {
    const from = parts.get(wire.from.partId);
    const to = parts.get(wire.to.partId);
    if (!from || !to) { continue; }
    const start = routeEnd(from, wire.from.terminal);
    const end = routeEnd(to, wire.to.terminal);
    const route = wire.waypoints?.length
      ? routeThroughWaypoints(start, end, wire.waypoints)
      : from.id === to.id && terminalsOf(from.kind).length >= 3
        ? routeTiedPins(from, wire.from.terminal, wire.to.terminal, [...routes.values()])
        : routeWire(start, end, [...routes.values()]);
    routes.set(wire.id, route);
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

/** Bounds of every part footprint, or null for an empty document. */
export function contentBounds(document: CircuitDocument): GridRect | null {
  if (document.parts.length === 0) { return null; }
  const rects = document.parts.map(footprint);
  let minX = Math.min(...rects.map((rect) => rect.minX));
  let minY = Math.min(...rects.map((rect) => rect.minY));
  let maxX = Math.max(...rects.map((rect) => rect.maxX));
  let maxY = Math.max(...rects.map((rect) => rect.maxY));
  for (const wire of document.wires) {
    for (const point of wire.waypoints ?? []) {
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
