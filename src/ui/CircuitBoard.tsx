import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import "./ui.css";
import { CircuitIcon } from "./CircuitIcon.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import {
  GRID,
  contentBounds,
  isVertical,
  pathData,
  routeEnd,
  routeWire,
  snapToGrid,
  terminalPoint,
  type Point,
} from "../circuit-geometry.js";
import type { CircuitSelection } from "../circuit-edit.js";
import {
  endpointName,
  terminalName,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

export interface CircuitBoardProps {
  document: CircuitDocument;
  selection?: CircuitSelection;
  pendingEndpoint?: CircuitEndpoint | null;
  onSelectPart?: (id: string) => void;
  onSelectWire?: (id: string) => void;
  onTerminalClick?: (endpoint: CircuitEndpoint) => void;
  onBoardClick?: (point: Point) => void;
  /** Movement is reported in grid cells and can be applied with the headless edit functions. */
  onMovePart?: (id: string, dx: number, dy: number) => void;
  /** Ends one drag, allowing hosts to group movement into a single undo step. */
  onMoveEnd?: () => void;
  /** Cancels a tentative touch drag when a second finger starts a pinch gesture. */
  onMoveCancel?: (id: string) => void;
  /** The hand tool pans even when dragging over parts and terminals. */
  panMode?: boolean;
  analysis?: CircuitAnalysis;
  /** Visible center in grid cells, useful when choosing where to add new parts. */
  onViewportCenterChange?: (point: Point) => void;
  /** Custom SVG art centered at (0, 0). The standard symbol is used when omitted. */
  renderPart?: (part: CircuitPart, selected: boolean) => ReactNode;
}

interface DragState {
  id: string;
  pointerId: number;
  last: { x: number; y: number };
  origin: Point;
}

interface PanState {
  pointerId: number;
  target: SVGElement;
  x: number;
  y: number;
  cameraX: number;
  cameraY: number;
  moved: boolean;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

interface PinchState {
  distance: number;
  worldX: number;
  worldY: number;
  zoom: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

function fitCamera(document: CircuitDocument, width: number, height: number): Camera {
  const bounds = contentBounds(document);
  if (!bounds) return { x: -width / 2, y: -height / 2, zoom: 1 };
  const left = bounds.minX * GRID - 90;
  const right = bounds.maxX * GRID + 90;
  const top = bounds.minY * GRID - 90;
  const bottom = bounds.maxY * GRID + 90;
  const zoom = Math.min(1.5, Math.max(MIN_ZOOM, Math.min(width / (right - left), height / (bottom - top))));
  return {
    x: (left + right) / 2 - width / (2 * zoom),
    y: (top + bottom) / 2 - height / (2 * zoom),
    zoom,
  };
}

const partDescriptions: Record<CircuitPartKind, string> = {
  battery: "電池",
  resistor: "抵抗",
  bulb: "電球",
  switch: "スイッチ",
  ammeter: "電流計",
  voltmeter: "電圧計",
  junction: "接続点",
};

function partDetail(part: CircuitPart) {
  if (part.kind === "battery" && part.voltageVolts !== undefined) return `${part.voltageVolts} V`;
  if ((part.kind === "resistor" || part.kind === "bulb") && part.resistanceOhms !== undefined) {
    return `${part.resistanceOhms} Ω`;
  }
  if (part.kind === "bulb" && part.ratedPowerWatts !== undefined) return `${part.ratedPowerWatts} W`;
  return "";
}

function StandardPartArt({ part, brightness = 0 }: { part: CircuitPart; brightness?: number }) {
  const stroke = "var(--circuit-board-ink, #344c63)";
  const common = {
    fill: "var(--circuit-board-part-fill, #ffffff)",
    stroke,
    strokeWidth: 2.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };

  switch (part.kind) {
    case "battery":
      return (
        <g className="circuit-board__symbol" {...common}>
          <line x1="-20" y1="0" x2="-9" y2="0" />
          <line x1="-9" y1="-15" x2="-9" y2="15" />
          <line x1="9" y1="-8" x2="9" y2="8" />
          <line x1="9" y1="0" x2="20" y2="0" />
          <text className="circuit-board__polarity" x="-9" y="-19" textAnchor="middle">+</text>
          <text className="circuit-board__polarity" x="9" y="-12" textAnchor="middle">−</text>
        </g>
      );
    case "resistor":
      return (
        <g className="circuit-board__symbol" {...common}>
          <path fill="none" d="M -20 0 H -14 L -9 -8 L -2 8 L 5 -8 L 12 8 L 17 0 H 20" />
        </g>
      );
    case "bulb":
      return (
        <g className="circuit-board__symbol" {...common}>
          <path d="M -20 0 H -14 M 14 0 H 20" />
          <circle r="14" style={brightness > 0 ? { fill: `rgba(250, 196, 66, ${0.15 + Math.min(1, brightness) * 0.6})` } : undefined} />
          <path d="M -7 -7 L 7 7 M 7 -7 L -7 7" />
        </g>
      );
    case "switch": {
      const closed = part.initiallyClosed ?? false;
      return (
        <g className="circuit-board__symbol" {...common}>
          <path d="M -20 0 H -9 M 9 0 H 20" />
          <circle className="circuit-board__contact" cx="-9" cy="0" r="2.7" />
          <circle className="circuit-board__contact" cx="9" cy="0" r="2.7" />
          <path d={closed ? "M -9 0 L 9 0" : "M -9 0 L 7 -10"} />
        </g>
      );
    }
    case "ammeter":
    case "voltmeter":
      return (
        <g className="circuit-board__symbol" {...common}>
          <path d="M -20 0 H -14 M 14 0 H 20" />
          <circle r="14" />
          <text className="circuit-board__meter-letter" textAnchor="middle" dominantBaseline="central">
            {part.kind === "ammeter" ? "A" : "V"}
          </text>
        </g>
      );
    case "junction":
      return <circle className="circuit-board__junction" r="5" />;
  }
}

function endpointKey(endpoint: CircuitEndpoint) {
  return `${endpoint.partId}:${endpoint.terminal}`;
}

export function CircuitBoard({
  document,
  selection,
  pendingEndpoint,
  onSelectPart,
  onSelectWire,
  onTerminalClick,
  onBoardClick,
  onMovePart,
  onMoveEnd,
  onMoveCancel,
  panMode = false,
  analysis,
  onViewportCenterChange,
  renderPart,
}: CircuitBoardProps) {
  const generatedId = useId().replaceAll(":", "");
  const smallGridId = `circuit-board-grid-${generatedId}`;
  const majorGridId = `circuit-board-major-${generatedId}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera);
  const [size, setSize] = useState({ width: 960, height: 560 });
  const measuredSizeRef = useRef({ width: 0, height: 0 });
  const initializedRef = useRef(false);
  const spacePressedRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<PanState | null>(null);
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState | null>(null);
  const gesturePointersRef = useRef(new Set<number>());
  const draggedRef = useRef(false);
  const clearDragClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedParts = new Set(selection?.parts ?? []);
  const selectedWires = new Set(selection?.wires ?? []);
  const connectedTerminals = new Set(document.wires.flatMap((wire) => [endpointKey(wire.from), endpointKey(wire.to)]));
  const partsById = new Map(document.parts.map((part) => [part.id, part]));
  const pendingPart = pendingEndpoint ? partsById.get(pendingEndpoint.partId) : undefined;
  const selectedPartId = selection?.parts[0];

  useEffect(() => {
    onViewportCenterChange?.({
      x: Math.round((camera.x + size.width / (2 * camera.zoom)) / GRID),
      y: Math.round((camera.y + size.height / (2 * camera.zoom)) / GRID),
    });
  }, [camera, size, onViewportCenterChange]);

  useEffect(() => {
    const part = document.parts.find((item) => item.id === selectedPartId);
    if (!part || !initializedRef.current) return;
    const current = cameraRef.current;
    const x = part.x * GRID;
    const y = part.y * GRID;
    const margin = 75 / current.zoom;
    if (x < current.x + margin || x > current.x + size.width / current.zoom - margin ||
        y < current.y + margin || y > current.y + size.height / current.zoom - margin) {
      updateCamera({ ...current, x: x - size.width / (2 * current.zoom), y: y - size.height / (2 * current.zoom) });
    }
  }, [selectedPartId, document.parts.length]);

  useEffect(() => {
    if (!pendingEndpoint) setPointer(null);
  }, [pendingEndpoint]);

  function updateCamera(next: Camera) {
    cameraRef.current = next;
    setCamera(next);
  }

  function zoomAt(nextZoom: number, clientX: number, clientY: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = cameraRef.current;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const rect = viewport.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    updateCamera({
      x: current.x + x / current.zoom - x / zoom,
      y: current.y + y / current.zoom - y / zoom,
      zoom,
    });
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (!width || !height) return;
      const previous = measuredSizeRef.current;
      if (previous.width === width && previous.height === height) return;
      measuredSizeRef.current = { width, height };
      setSize({ width, height });
      if (!initializedRef.current) {
        initializedRef.current = true;
        updateCamera(fitCamera(document, width, height));
      } else {
        const current = cameraRef.current;
        updateCamera({
          ...current,
          x: current.x + (previous.width - width) / (2 * current.zoom),
          y: current.y + (previous.height - height) / (2 * current.zoom),
        });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        zoomAt(cameraRef.current.zoom * Math.exp(-event.deltaY * factor * 0.002), event.clientX, event.clientY);
      } else {
        const current = cameraRef.current;
        updateCamera({
          ...current,
          x: current.x + event.deltaX * factor / current.zoom,
          y: current.y + event.deltaY * factor / current.zoom,
        });
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(target.tagName))) return;
      // Space activates focused SVG controls; it only starts panning on the canvas itself.
      if (target instanceof SVGElement && target.closest('[role="button"]')) return;
      if (!pointerInsideRef.current && !(target instanceof Node && viewportRef.current?.contains(target))) return;
      if (pointerInsideRef.current) event.preventDefault();
      spacePressedRef.current = true;
      setSpacePressed(true);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space") return;
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    const onBlur = () => { spacePressedRef.current = false; setSpacePressed(false); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  function gridAtPointer(event: { clientX: number; clientY: number }) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    const current = cameraRef.current;
    return snapToGrid({
      x: current.x + (event.clientX - rect.left) / current.zoom,
      y: current.y + (event.clientY - rect.top) / current.zoom,
    });
  }

  function startDrag(event: PointerEvent<SVGGElement>, part: CircuitPart) {
    if (event.button !== 0) return;
    event.currentTarget.focus({ preventScroll: true });
    onSelectPart?.(part.id);
    if (!onMovePart) return;
    event.preventDefault();
    event.stopPropagation();
    const point = gridAtPointer(event);
    draggedRef.current = false;
    if (clearDragClickTimer.current !== null) clearTimeout(clearDragClickTimer.current);
    setDrag({ id: part.id, pointerId: event.pointerId, last: point, origin: { x: part.x, y: part.y } });
    try {
      svgRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some server-rendering and test environments.
    }
  }

  function startPan(event: PointerEvent<SVGElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    if (clearDragClickTimer.current !== null) clearTimeout(clearDragClickTimer.current);
    clearDragClickTimer.current = null;
    draggedRef.current = false;
    const current = cameraRef.current;
    panRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      cameraX: current.x,
      cameraY: current.y,
      moved: false,
    };
    setIsPanning(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some server-rendering and test environments.
    }
  }

  function movePan(event: PointerEvent<SVGSVGElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return false;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) pan.moved = true;
    if (pan.moved) {
      const current = cameraRef.current;
      updateCamera({ ...current, x: pan.cameraX - dx / current.zoom, y: pan.cameraY - dy / current.zoom });
      draggedRef.current = true;
    }
    return true;
  }

  function finishPan(event: PointerEvent<SVGSVGElement>) {
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return false;
    panRef.current = null;
    setIsPanning(false);
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
    try {
      if (pan.target.hasPointerCapture(event.pointerId)) pan.target.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be absent in older browsers.
    }
    return true;
  }

  function trackTouchStart(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "touch") return false;
    touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchesRef.current.size !== 2) return false;
    if (clearDragClickTimer.current !== null) clearTimeout(clearDragClickTimer.current);
    clearDragClickTimer.current = null;
    const [first, second] = [...touchesRef.current.entries()];
    if (!first || !second) return false;
    const centerX = (first[1].x + second[1].x) / 2;
    const centerY = (first[1].y + second[1].y) / 2;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const current = cameraRef.current;
    pinchRef.current = {
      distance: Math.max(1, Math.hypot(first[1].x - second[1].x, first[1].y - second[1].y)),
      worldX: current.x + (centerX - rect.left) / current.zoom,
      worldY: current.y + (centerY - rect.top) / current.zoom,
      zoom: current.zoom,
    };
    gesturePointersRef.current.add(first[0]);
    gesturePointersRef.current.add(second[0]);
    panRef.current = null;
    setIsPanning(false);
    if (drag) {
      const part = partsById.get(drag.id);
      if (onMoveCancel) onMoveCancel(drag.id);
      else if (part) onMovePart?.(part.id, drag.origin.x - part.x, drag.origin.y - part.y);
      onMoveEnd?.();
    }
    setDrag(null);
    draggedRef.current = true;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Unsupported capture. */ }
    return true;
  }

  function movePinch(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "touch" || !touchesRef.current.has(event.pointerId)) return false;
    touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (!pinch || touchesRef.current.size < 2) return false;
    const [first, second] = [...touchesRef.current.values()];
    if (!first || !second) return false;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance));
    updateCamera({
      x: pinch.worldX - ((first.x + second.x) / 2 - rect.left) / zoom,
      y: pinch.worldY - ((first.y + second.y) / 2 - rect.top) / zoom,
      zoom,
    });
    return true;
  }

  function finishTouch(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "touch") return false;
    touchesRef.current.delete(event.pointerId);
    if (!gesturePointersRef.current.has(event.pointerId)) return false;
    gesturePointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    if (gesturePointersRef.current.size === 0) {
      clearDragClickTimer.current = setTimeout(() => {
        draggedRef.current = false;
        clearDragClickTimer.current = null;
      }, 100);
    }
    return true;
  }

  function changeZoom(nextZoom: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    zoomAt(nextZoom, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function panBy(dx: number, dy: number) {
    const current = cameraRef.current;
    updateCamera({ ...current, x: current.x + dx / current.zoom, y: current.y + dy / current.zoom });
  }

  function moveDrag(event: PointerEvent<SVGSVGElement>) {
    if (movePinch(event)) return;
    if (gesturePointersRef.current.has(event.pointerId)) return;
    if (movePan(event)) return;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = gridAtPointer(event);
    const dx = next.x - drag.last.x;
    const dy = next.y - drag.last.y;
    if (dx === 0 && dy === 0) return;
    draggedRef.current = true;
    onMovePart?.(drag.id, dx, dy);
    setDrag({ ...drag, last: next });
  }

  function finishDrag(event: PointerEvent<SVGSVGElement>) {
    if (finishTouch(event)) return;
    if (finishPan(event)) return;
    if (drag?.pointerId !== event.pointerId) return;
    setDrag(null);
    onMoveEnd?.();
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
    try {
      if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be absent in older browsers.
    }
  }

  function handlePartKeyDown(event: KeyboardEvent<SVGGElement>, part: CircuitPart) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectPart?.(part.id);
      return;
    }
    const distance = event.shiftKey ? 5 : 1;
    const movement = {
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
      ArrowUp: [0, -distance],
      ArrowDown: [0, distance],
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    onSelectPart?.(part.id);
    onMovePart?.(part.id, movement[0] ?? 0, movement[1] ?? 0);
    onMoveEnd?.();
  }

  return (
    <div className="circuit-board" role="region" aria-label={`${document.title} 回路基板`}>
      <div className="circuit-board__chrome">
        <div className="circuit-board__controls" aria-label="キャンバス表示操作">
          <button type="button" onClick={() => setShowGrid((visible) => !visible)} aria-label="グリッドを表示" aria-pressed={showGrid} title="グリッドを表示 / 非表示"><CircuitIcon name="grid" /></button>
          <span className="circuit-board__control-divider" />
          <button type="button" onClick={() => changeZoom(camera.zoom / 1.25)} disabled={camera.zoom <= MIN_ZOOM} aria-label="縮小" title="縮小"><CircuitIcon name="minus" /></button>
          <button type="button" className="circuit-board__zoom-reset" onClick={() => changeZoom(1)} aria-label="拡大率を100%に戻す" title="100%で表示"><output aria-label="拡大率">{Math.round(camera.zoom * 100)}%</output></button>
          <button type="button" onClick={() => changeZoom(camera.zoom * 1.25)} disabled={camera.zoom >= MAX_ZOOM} aria-label="拡大" title="拡大"><CircuitIcon name="plus" /></button>
          <span className="circuit-board__control-divider" />
          <button type="button" className="circuit-board__fit" onClick={() => updateCamera(fitCamera(document, size.width, size.height))} aria-label="回路全体を表示" title="回路全体を表示"><CircuitIcon name="fit" /></button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="circuit-board__viewport"
        tabIndex={0}
        aria-label="回路基板。余白またはスペースキーを押しながらドラッグして自由に移動できます"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const movement = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }[event.key];
          if (!movement) return;
          event.preventDefault();
          panBy(movement[0] ?? 0, movement[1] ?? 0);
        }}
      >
      <svg
        ref={svgRef}
        className={`circuit-board__surface${spacePressed || panMode ? " circuit-board__surface--pan-ready" : ""}${isPanning ? " circuit-board__surface--panning" : ""}${pendingEndpoint ? " circuit-board__surface--connecting" : ""}`}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`${camera.x} ${camera.y} ${size.width / camera.zoom} ${size.height / camera.zoom}`}
        width={size.width}
        height={size.height}
        role="group"
        aria-label={`${document.title}。部品をドラッグして移動できます。`}
        onPointerEnter={() => { pointerInsideRef.current = true; }}
        onPointerLeave={() => { pointerInsideRef.current = false; setPointer(null); }}
        onPointerDownCapture={(event) => {
          if (trackTouchStart(event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.button !== 1 && !spacePressedRef.current && !panMode) return;
          event.preventDefault();
          event.stopPropagation();
          startPan(event);
        }}
        onPointerMove={(event) => {
          moveDrag(event);
          if (pendingEndpoint && !panMode) setPointer(gridAtPointer(event));
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onClickCapture={(event) => {
          if (!draggedRef.current) return;
          draggedRef.current = false;
          if (clearDragClickTimer.current !== null) {
            clearTimeout(clearDragClickTimer.current);
            clearDragClickTimer.current = null;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <title>{document.title}</title>
        <defs>
          <pattern id={smallGridId} x={-GRID / 2} y={-GRID / 2} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={GRID / 2} cy={GRID / 2} r="0.8" className="circuit-board__minor-grid" />
          </pattern>
          <pattern id={majorGridId} width={GRID * 5} height={GRID * 5} patternUnits="userSpaceOnUse">
            <rect width={GRID * 5} height={GRID * 5} fill={`url(#${smallGridId})`} />
          </pattern>
        </defs>
        <g
          className="circuit-board__background"
          onPointerDown={startPan}
          onClick={(event) => {
            if (draggedRef.current) return;
            if (!panMode) onBoardClick?.(gridAtPointer(event));
          }}
        >
          <rect className="circuit-board__paper" x={camera.x} y={camera.y} width={size.width / camera.zoom} height={size.height / camera.zoom} />
          {showGrid && <rect x={camera.x} y={camera.y} width={size.width / camera.zoom} height={size.height / camera.zoom} fill={`url(#${majorGridId})`} />}
        </g>

        {pendingPart && pendingEndpoint && pointer && <path className="circuit-board__connection-preview" d={pathData(routeWire(routeEnd(pendingPart, pendingEndpoint.terminal), { point: pointer, direction: null }))} />}

        <g className="circuit-board__wires">
          {document.wires.map((wire) => {
            const from = partsById.get(wire.from.partId);
            const to = partsById.get(wire.to.partId);
            if (!from || !to) return null;
            const d = pathData(routeWire(routeEnd(from, wire.from.terminal), routeEnd(to, wire.to.terminal)));
            const isSelected = selectedWires.has(wire.id);
            return (
              <g
                key={wire.id}
                className={`circuit-board__wire${isSelected ? " circuit-board__wire--selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${endpointName(from, wire.from.terminal)} と ${endpointName(to, wire.to.terminal)} をつなぐ導線`}
                aria-pressed={isSelected}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectWire?.(wire.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectWire?.(wire.id);
                }}
              >
                <path className="circuit-board__wire-hit" d={d} />
                <path className="circuit-board__wire-line" d={d} />
              </g>
            );
          })}
        </g>

        <g className="circuit-board__parts">
          {document.parts.map((part) => {
            const isSelected = selectedParts.has(part.id);
            const detail = partDetail(part);
            const vertical = isVertical(part);
            return (
              <g
                key={part.id}
                className={`circuit-board__part${isSelected ? " circuit-board__part--selected" : ""}${drag?.id === part.id ? " circuit-board__part--dragging" : ""}`}
                transform={`translate(${part.x * GRID} ${part.y * GRID})`}
                role="button"
                tabIndex={0}
                aria-label={`${part.label}、${partDescriptions[part.kind]}`}
                aria-pressed={isSelected}
                onPointerDown={(event) => startDrag(event, part)}
                onClick={(event) => { if (event.detail === 0) onSelectPart?.(part.id); }}
                onKeyDown={(event) => handlePartKeyDown(event, part)}
              >
                <title>{`${part.label}（${partDescriptions[part.kind]}）`}</title>
                <circle className="circuit-board__part-hit" r="23" />
                <rect className="circuit-board__selection-halo" x="-25" y="-24" width="50" height="48" rx="5" />
                <g transform={`rotate(${part.rotation ?? 0})`}>
                  {part.kind !== "junction" && (
                    <g className="circuit-board__part-leads" aria-hidden="true">
                      <line x1={-2 * GRID} y1="0" x2={-GRID} y2="0" />
                      <line x1={GRID} y1="0" x2={2 * GRID} y2="0" />
                    </g>
                  )}
                  {renderPart ? renderPart(part, isSelected) : <StandardPartArt part={part} brightness={analysis?.parts[part.id]?.brightness} />}
                </g>
                <text className="circuit-board__part-label" style={{ fontSize: camera.zoom >= .55 ? Math.max(10, 11 / camera.zoom) : 10 }} x={vertical ? 31 : 0} y={vertical ? -2 : 35} textAnchor={vertical ? "start" : "middle"}>
                  {part.label}
                </text>
                {detail && (
                  <text className="circuit-board__part-detail" style={{ fontSize: camera.zoom >= .55 ? Math.max(9, 10 / camera.zoom) : 9 }} x={vertical ? 31 : 0} y={vertical ? 13 : 49} textAnchor={vertical ? "start" : "middle"}>
                    {detail}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        <g className="circuit-board__terminals">
          {document.parts.flatMap((part) =>
            terminalsOf(part.kind).map((terminal: CircuitTerminal) => {
              const endpoint = { partId: part.id, terminal };
              const point = terminalPoint(part, terminal);
              const pending = pendingEndpoint !== undefined && pendingEndpoint !== null && endpointKey(pendingEndpoint) === endpointKey(endpoint);
              const connected = connectedTerminals.has(endpointKey(endpoint));
              return (
                <g
                  key={endpointKey(endpoint)}
                  className={`circuit-board__terminal${pending ? " circuit-board__terminal--pending" : ""}${connected ? " circuit-board__terminal--connected" : ""}`}
                  transform={`translate(${point.x * GRID} ${point.y * GRID})`}
                  role="button"
                  tabIndex={0}
                  aria-label={endpointName(part, terminal)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTerminalClick?.(endpoint);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onTerminalClick?.(endpoint);
                  }}
                >
                  <title>{`${endpointName(part, terminal)}を選択`}</title>
                  <circle className="circuit-board__terminal-hit" r="9" />
                  <circle className="circuit-board__terminal-dot" r={part.kind === "junction" ? 0 : connected ? 2.5 : 3.5} />
                  {pending && <circle className="circuit-board__terminal-ring" r="8" />}
                  <text className="circuit-board__terminal-label" x="0" y="-9" textAnchor="middle">
                    {part.kind === "junction" ? "" : terminalName(part, terminal).replace("端子", "")}
                  </text>
                </g>
              );
            }),
          )}
        </g>
      </svg>
      </div>
    </div>
  );
}
