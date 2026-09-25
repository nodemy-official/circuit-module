import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { moveWireSegment, routeEnd, type Point, type RouteEnd } from "../circuit-geometry.js";
import type { CircuitDocument } from "../circuit-model.js";

interface WireRouteDragOptions {
  document: CircuitDocument;
  routes: ReadonlyMap<string, readonly Point[]>;
  enabled: boolean;
  svgRef: RefObject<SVGSVGElement | null>;
  pointAtPointer: (event: { clientX: number; clientY: number }) => Point;
  onSelect?: (id: string) => void;
  onChange?: (id: string, waypoints: Point[] | undefined) => void;
  onCancel?: (id: string) => void;
  onEnd?: () => void;
  onDrag: () => void;
  onFinish: () => void;
}

interface RouteSnapshot {
  id: string;
  route: readonly Point[];
  start: RouteEnd;
  end: RouteEnd;
  originalWaypoints: Point[] | undefined;
}

interface SegmentDrag extends RouteSnapshot {
  pointerId: number;
  segmentIndex: number;
  origin: Point;
  clientOrigin: Point;
  axis: "x" | "y";
  coordinate: number;
  lastCoordinate: number;
  changed: boolean;
}

/** Finds the segment under the pointer, including the two terminal-adjacent segments. */
function closestSegment(route: readonly Point[], point: Point) {
  let closest = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    const from = route[index];
    const to = route[index + 1];
    if (from.x === to.x && from.y === to.y) { continue; }
    const x = Math.max(Math.min(from.x, to.x), Math.min(Math.max(from.x, to.x), point.x));
    const y = Math.max(Math.min(from.y, to.y), Math.min(Math.max(from.y, to.y), point.y));
    const nextDistance = Math.hypot(point.x - x, point.y - y);
    if (nextDistance < distance) { closest = index; distance = nextDistance; }
  }
  return closest;
}

function snapshot(options: WireRouteDragOptions, id: string): RouteSnapshot | undefined {
  const wire = options.document.wires.find((item) => item.id === id);
  const from = options.document.parts.find((part) => part.id === wire?.from.partId);
  const to = options.document.parts.find((part) => part.id === wire?.to.partId);
  const route = options.routes.get(id);
  if (!wire || !from || !to || !route || route.length < 2) { return; }
  return {
    id, route,
    start: routeEnd(from, wire.from.terminal),
    end: routeEnd(to, wire.to.terminal),
    originalWaypoints: wire.waypoints?.map((point) => ({ ...point })),
  };
}

function releasePointer(svg: SVGSVGElement | null, pointerId: number) {
  try {
    if (svg?.hasPointerCapture(pointerId)) { svg.releasePointerCapture(pointerId); }
  } catch { /* Pointer capture is unavailable in some hosts. */ }
}

/** Keeps one drag tied to its original route even when moving a segment adds or removes bends. */
export function useWireRouteDrag(options: WireRouteDragOptions) {
  const latest = useRef(options);
  latest.current = options;
  const dragRef = useRef<SegmentDrag | null>(null);
  const focusAtRef = useRef<{ id: string; point: Point } | null>(null);
  const [draggingWireId, setDraggingWireId] = useState<string | null>(null);

  const cancel = useCallback((pointerId?: number, release = true) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) { return false; }
    dragRef.current = null;
    setDraggingWireId(null);
    const current = latest.current;
    if (drag.changed) {
      if (current.onCancel) { current.onCancel(drag.id); }
      else { current.onChange?.(drag.id, drag.originalWaypoints); }
    }
    current.onEnd?.();
    current.onFinish();
    if (release) { releasePointer(current.svgRef.current, drag.pointerId); }
    return true;
  }, []);

  useEffect(() => {
    if (!options.enabled) { cancel(); }
  }, [options.enabled, cancel]);

  useEffect(() => {
    const focusAt = focusAtRef.current;
    if (!focusAt) { return; }
    focusAtRef.current = null;
    const route = options.routes.get(focusAt.id);
    if (!route) { return; }
    const index = closestSegment(route, focusAt.point);
    const handles = options.svgRef.current?.querySelectorAll<SVGGElement>(".circuit-board__wire-segment-handle");
    const handle = Array.from(handles ?? []).find((item) =>
      item.dataset.wireId === focusAt.id && item.dataset.segmentIndex === String(index));
    handle?.focus({ preventScroll: true });
  }, [options.routes, options.svgRef]);

  const start = useCallback((event: PointerEvent<SVGGElement>, id: string, segmentIndex?: number) => {
    const current = latest.current;
    if (!current.enabled || !current.onChange || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) { return; }
    const initial = snapshot(current, id);
    if (!initial) { return; }
    const origin = current.pointAtPointer(event);
    const index = segmentIndex ?? closestSegment(initial.route, origin);
    const from = initial.route[index];
    const to = initial.route[index + 1];
    if (!from || !to) { return; }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus?.({ preventScroll: true });
    current.onSelect?.(id);
    const axis = from.y === to.y ? "y" : "x";
    dragRef.current = {
      ...initial, pointerId: event.pointerId, segmentIndex: index, origin,
      clientOrigin: { x: event.clientX, y: event.clientY },
      axis, coordinate: from[axis], lastCoordinate: from[axis], changed: false,
    };
    try { current.svgRef.current?.setPointerCapture(event.pointerId); } catch { /* Unsupported capture. */ }
  }, []);

  const move = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) { return false; }
    const current = latest.current;
    if (!current.enabled) { cancel(); return true; }
    if (Math.hypot(event.clientX - drag.clientOrigin.x, event.clientY - drag.clientOrigin.y) < 4 && !drag.changed) { return true; }
    current.onDrag();
    const point = current.pointAtPointer(event);
    const coordinate = Math.round(drag.coordinate + point[drag.axis] - drag.origin[drag.axis]);
    if (coordinate === drag.lastCoordinate) { return true; }
    drag.lastCoordinate = coordinate;
    drag.changed = true;
    setDraggingWireId(drag.id);
    const next = moveWireSegment(drag.route, drag.segmentIndex, coordinate, drag.start, drag.end);
    current.onChange?.(drag.id, coordinate === drag.coordinate ? drag.originalWaypoints : next.slice(1, -1));
    return true;
  }, [cancel]);

  const finish = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) { return false; }
    if (event.type === "pointercancel" || (drag.changed && drag.coordinate === drag.lastCoordinate)) { return cancel(); }
    dragRef.current = null;
    setDraggingWireId(null);
    const current = latest.current;
    current.onEnd?.();
    current.onFinish();
    releasePointer(current.svgRef.current, drag.pointerId);
    return true;
  }, [cancel]);

  const keyDown = useCallback((event: KeyboardEvent<SVGGElement>, id: string, index: number) => {
    const current = latest.current;
    if (!current.enabled || !current.onChange) { return; }
    const initial = snapshot(current, id);
    const from = initial?.route[index];
    const to = initial?.route[index + 1];
    if (!initial || !from || !to) { return; }
    const axis = from.y === to.y ? "y" : "x";
    const direction = axis === "y"
      ? { ArrowUp: -1, ArrowDown: 1 }[event.key]
      : { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (direction === undefined) { return; }
    event.preventDefault();
    event.stopPropagation();
    const delta = direction * (event.shiftKey ? 5 : 1);
    const next = moveWireSegment(initial.route, index, from[axis] + delta, initial.start, initial.end);
    focusAtRef.current = { id, point: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, [axis]: from[axis] + delta } };
    current.onChange(id, next.slice(1, -1));
    current.onEnd?.();
  }, []);

  return { start, move, finish, cancel, keyDown, draggingWireId };
}
