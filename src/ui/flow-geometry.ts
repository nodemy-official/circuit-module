import { GRID, type Point } from "../circuit-geometry.js";

const FLOW_CORNER_TRIM = 12;
const QUADRATIC_LUT_STEPS = 32;
const FLOW_ARROW_POINTS = [
  { x: -8, y: -8 },
  { x: -1, y: -8 },
  { x: -1, y: -11 },
  { x: 6, y: -6 },
  { x: -1, y: -1 },
  { x: -1, y: -4 },
  { x: -8, y: -4 },
] as const;

interface Vector {
  x: number;
  y: number;
}

interface ArcLengthEntry {
  t: number;
  distance: number;
}

interface FlowSegment {
  start: Vector;
  end: Vector;
  control?: Vector;
  length: number;
  startDistance: number;
  endDistance: number;
  arcLengthLut?: ArcLengthEntry[];
}

export interface FlowPathSample {
  x: number;
  y: number;
  tangentX: number;
  tangentY: number;
}

interface FlowPath {
  data: string;
  length: number;
  sample: (distance: number) => FlowPathSample;
}

function distanceBetween(first: Vector, second: Vector) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function quadraticPoint(start: Vector, control: Vector, end: Vector, t: number): Vector {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
}

function quadraticTangent(start: Vector, control: Vector, end: Vector, t: number): Vector {
  return {
    x: 2 * ((1 - t) * (control.x - start.x) + t * (end.x - control.x)),
    y: 2 * ((1 - t) * (control.y - start.y) + t * (end.y - control.y)),
  };
}

function normalized(vector: Vector, fallback: Vector = { x: 1, y: 0 }): Vector {
  const length = Math.hypot(vector.x, vector.y);
  return length > 0 && Number.isFinite(length)
    ? { x: vector.x / length, y: vector.y / length }
    : fallback;
}

function quadraticArcLengthLut(start: Vector, control: Vector, end: Vector) {
  const entries: ArcLengthEntry[] = [{ t: 0, distance: 0 }];
  let previous = start;
  let distance = 0;
  for (let step = 1; step <= QUADRATIC_LUT_STEPS; step++) {
    const t = step / QUADRATIC_LUT_STEPS;
    const point = quadraticPoint(start, control, end, t);
    distance += distanceBetween(previous, point);
    entries.push({ t, distance });
    previous = point;
  }
  return { entries, length: distance };
}

function sampleSegment(segment: FlowSegment, distance: number): FlowPathSample {
  const { start, end, control, length, arcLengthLut } = segment;
  if (!control || !arcLengthLut) {
    const tangent = normalized({ x: end.x - start.x, y: end.y - start.y });
    const fraction = length === 0 ? 0 : distance / length;
    return {
      x: start.x + (end.x - start.x) * fraction,
      y: start.y + (end.y - start.y) * fraction,
      tangentX: tangent.x,
      tangentY: tangent.y,
    };
  }

  const target = Math.max(0, Math.min(length, distance));
  let low = 0;
  let high = arcLengthLut.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((arcLengthLut[middle]?.distance ?? 0) < target) { low = middle + 1; }
    else { high = middle; }
  }
  const upper = arcLengthLut[low];
  const lower = arcLengthLut[Math.max(0, low - 1)];
  if (!upper || !lower) {
    const tangent = normalized(quadraticTangent(start, control, end, 0));
    return { x: start.x, y: start.y, tangentX: tangent.x, tangentY: tangent.y };
  }
  const span = upper.distance - lower.distance;
  const fraction = span === 0 ? 0 : (target - lower.distance) / span;
  const t = lower.t + (upper.t - lower.t) * fraction;
  const point = quadraticPoint(start, control, end, t);
  const tangent = normalized(quadraticTangent(start, control, end, t));
  return { x: point.x, y: point.y, tangentX: tangent.x, tangentY: tangent.y };
}

/** Build the rounded wire centerline and an arc-length sampler in pixel coordinates. */
export function createFlowPath(route: readonly Point[]): FlowPath {
  const points: Vector[] = [];
  for (const point of route) {
    const previous = points.at(-1);
    if (!previous || previous.x !== point.x * GRID || previous.y !== point.y * GRID) {
      points.push({ x: point.x * GRID, y: point.y * GRID });
    }
  }

  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) {
    return {
      data: "",
      length: 0,
      sample: () => ({ x: 0, y: 0, tangentX: 1, tangentY: 0 }),
    };
  }

  let data = `M ${first.x} ${first.y}`;
  let cursor = first;
  const segments: FlowSegment[] = [];
  let length = 0;
  const addLine = (end: Vector) => {
    data += ` L ${end.x} ${end.y}`;
    const segmentLength = distanceBetween(cursor, end);
    if (segmentLength > 0) {
      segments.push({
        start: cursor,
        end,
        length: segmentLength,
        startDistance: length,
        endDistance: length + segmentLength,
      });
      length += segmentLength;
    }
    cursor = end;
  };

  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1];
    const corner = points[index];
    const after = points[index + 1];
    if (!before || !corner || !after) { continue; }

    const incoming = { x: corner.x - before.x, y: corner.y - before.y };
    const outgoing = { x: after.x - corner.x, y: after.y - corner.y };
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    if (incomingLength === 0 || outgoingLength === 0 || cross === 0) {
      addLine(corner);
      continue;
    }

    const trim = Math.min(FLOW_CORNER_TRIM, incomingLength / 2, outgoingLength / 2);
    const entry = {
      x: corner.x - (incoming.x / incomingLength) * trim,
      y: corner.y - (incoming.y / incomingLength) * trim,
    };
    const exit = {
      x: corner.x + (outgoing.x / outgoingLength) * trim,
      y: corner.y + (outgoing.y / outgoingLength) * trim,
    };
    addLine(entry);
    data += ` Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
    const arc = quadraticArcLengthLut(entry, corner, exit);
    if (arc.length > 0) {
      segments.push({
        start: entry,
        control: corner,
        end: exit,
        length: arc.length,
        startDistance: length,
        endDistance: length + arc.length,
        arcLengthLut: arc.entries,
      });
      length += arc.length;
    }
    cursor = exit;
  }
  if (cursor.x !== last.x || cursor.y !== last.y) { addLine(last); }

  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);
  if (!firstSegment || !lastSegment) {
    return {
      data,
      length,
      sample: () => ({ x: first.x, y: first.y, tangentX: 1, tangentY: 0 }),
    };
  }
  const firstSample = sampleSegment(firstSegment, 0);
  const lastSample = sampleSegment(lastSegment, lastSegment.length);
  const sample = (distance: number): FlowPathSample => {
    const targetDistance = Number.isFinite(distance) ? distance : 0;
    if (targetDistance < 0) {
      return {
        x: firstSample.x + firstSample.tangentX * targetDistance,
        y: firstSample.y + firstSample.tangentY * targetDistance,
        tangentX: firstSample.tangentX,
        tangentY: firstSample.tangentY,
      };
    }
    if (targetDistance > length) {
      const extra = targetDistance - length;
      return {
        x: lastSample.x + lastSample.tangentX * extra,
        y: lastSample.y + lastSample.tangentY * extra,
        tangentX: lastSample.tangentX,
        tangentY: lastSample.tangentY,
      };
    }

    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((segments[middle]?.endDistance ?? 0) < targetDistance) { low = middle + 1; }
      else { high = middle; }
    }
    const selected = segments[low];
    if (!selected) { return lastSample; }
    return sampleSegment(selected, targetDistance - selected.startDistance);
  };

  return { data, length, sample };
}

/** Warp the current-arrow silhouette onto the local curve around its path-distance anchor. */
export function flowArrowPath(
  path: ReturnType<typeof createFlowPath>,
  distance: number,
  scale = 1,
): string {
  const effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const targetDistance = Number.isFinite(distance) ? distance : 0;
  const anchor = path.sample(targetDistance);
  // A secant keeps the scaled lane shift from reversing inside tight bends.
  const laneBefore = path.sample(targetDistance - 12 * effectiveScale);
  const laneAfter = path.sample(targetDistance + 12 * effectiveScale);
  const laneTangent = normalized(
    { x: laneAfter.x - laneBefore.x, y: laneAfter.y - laneBefore.y },
    { x: anchor.tangentX, y: anchor.tangentY },
  );
  const anchorNormal = { x: -laneTangent.y, y: laneTangent.x };
  const anchorSample = (x: number, y: number) => {
    const sampleDistance = targetDistance + x * effectiveScale;
    const centerline = path.sample(sampleDistance);
    // Smooth the width normal across the glyph so large offsets do not fold its outline.
    const before = path.sample(sampleDistance - 10 * effectiveScale);
    const after = path.sample(sampleDistance + 10 * effectiveScale);
    const widthTangent = normalized(
      { x: after.x - before.x, y: after.y - before.y },
      { x: centerline.tangentX, y: centerline.tangentY },
    );
    const normal = { x: -widthTangent.y, y: widthTangent.x };
    return {
      x: centerline.x - anchorNormal.x * 6 * effectiveScale + normal.x * (y + 6) * effectiveScale,
      y: centerline.y - anchorNormal.y * 6 * effectiveScale + normal.y * (y + 6) * effectiveScale,
    };
  };
  const toLocal = (world: Vector) => {
    const deltaX = world.x - anchor.x;
    const deltaY = world.y - anchor.y;
    return {
      x: (deltaX * anchor.tangentX + deltaY * anchor.tangentY) / effectiveScale,
      y: (-deltaX * anchor.tangentY + deltaY * anchor.tangentX) / effectiveScale,
    };
  };

  const vertices: Vector[] = [];
  for (let index = 0; index < FLOW_ARROW_POINTS.length; index++) {
    const start = FLOW_ARROW_POINTS[index];
    const end = FLOW_ARROW_POINTS[(index + 1) % FLOW_ARROW_POINTS.length];
    if (!start || !end) { continue; }
    const edgeLength = Math.hypot(end.x - start.x, end.y - start.y) * effectiveScale;
    const steps = Math.max(1, Math.ceil(edgeLength));
    for (let step = 0; step < steps; step++) {
      const fraction = step / steps;
      const point = anchorSample(
        start.x + (end.x - start.x) * fraction,
        start.y + (end.y - start.y) * fraction,
      );
      vertices.push(toLocal(point));
    }
  }

  const first = vertices[0];
  if (!first) { return ""; }
  const format = (value: number) => {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  };
  return `M ${format(first.x)} ${format(first.y)}${vertices.slice(1).map((point) => ` L ${format(point.x)} ${format(point.y)}`).join("")} Z`;
}
