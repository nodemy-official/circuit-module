import { terminalPoint, type Point } from "../circuit-geometry.js";
import { terminalsOf, type CircuitDocument, type CircuitEndpoint } from "../circuit-model.js";

export interface ConnectionTarget {
  point: Point;
  endpoint?: CircuitEndpoint;
  wireId?: string;
}

/** Closest grid cell on an orthogonal wire, including its bends and endpoints. */
export function closestWirePoint(route: readonly Point[], point: Point): Point | null {
  let closest: Point | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    if (!from || !to) { continue; }
    const candidate = {
      x: Math.max(Math.min(from.x, to.x), Math.min(Math.max(from.x, to.x), Math.round(point.x))),
      y: Math.max(Math.min(from.y, to.y), Math.min(Math.max(from.y, to.y), Math.round(point.y))),
    };
    const nextDistance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
    if (nextDistance < distance) { closest = candidate; distance = nextDistance; }
  }
  return closest;
}

/** Terminals take priority over wires; the radius is expressed in grid cells. */
export function connectionTargetAt(
  document: CircuitDocument,
  routes: ReadonlyMap<string, readonly Point[]>,
  point: Point,
  radius: number,
  excludedWireId?: string,
): ConnectionTarget {
  let closest: ConnectionTarget | null = null;
  let distance = radius;
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      const position = terminalPoint(part, terminal);
      const nextDistance = Math.hypot(point.x - position.x, point.y - position.y);
      if (nextDistance <= distance) {
        closest = { point: position, endpoint: { partId: part.id, terminal } };
        distance = nextDistance;
      }
    }
  }
  if (closest) { return closest; }
  for (const [wireId, route] of routes) {
    if (wireId === excludedWireId) { continue; }
    const position = closestWirePoint(route, point);
    if (!position) { continue; }
    const nextDistance = Math.hypot(point.x - position.x, point.y - position.y);
    if (nextDistance <= distance) {
      closest = { point: position, wireId };
      distance = nextDistance;
    }
  }
  return closest ?? { point: { x: Math.round(point.x), y: Math.round(point.y) } };
}

/** A predictable landing point when a wire is activated without pointer coordinates. */
export function wireMidpoint(route: readonly Point[]): Point {
  let longest = 0;
  let point = route[0] ?? { x: 0, y: 0 };
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    if (!from || !to) { continue; }
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length > longest) {
      longest = length;
      point = { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
    }
  }
  return point;
}
