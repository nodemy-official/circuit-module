import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { CircuitIcon } from "./CircuitIcon.js";
import { CircuitPotentialControls, CircuitPotentialOverlay, useCircuitPotentialView } from "./CircuitPotentialView.js";
import { getMeterDisplay } from "./CircuitMeterReadout.js";
import { useWireRouteDrag } from "./useWireRouteDrag.js";
import { CircuitFlowLegend, CircuitWireFlow, wireFlowCurrent, wireFlowLabel, type FlowDisplay } from "./CircuitFlow.js";
import { closestWirePoint, connectionTargetAt, wireMidpoint, type ConnectionTarget } from "./connection-target.js";
import { circuitSlot, type CircuitStyleProps } from "./style-props.js";
import {
  cameraLabelSizes,
  createCameraFrame,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomCameraAt,
  type BoardCamera as Camera,
} from "./board-camera.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import {
  GRID,
  contentBounds,
  isVertical,
  localTerminalOffset,
  pathData,
  routeDocumentWires,
  routeEnd,
  routeWire,
  snapToGrid,
  terminalPoint,
  type Point,
} from "../circuit-geometry.js";
import type { CircuitSelection, CircuitWireEnd } from "../circuit-edit.js";
import {
  circuitPartCatalog,
  circuitPartNumericFields,
  endpointName,
  terminalName,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitPartNumericKey,
  type CircuitTerminal,
} from "../circuit-model.js";

export type CircuitBoardSlot =
  | "root"
  | "chrome" | "controls" | "controlDivider" | "gridButton" | "zoomOutButton" | "zoomResetButton" | "zoomInButton" | "fitButton" | "zoomOutput"
  | "viewport" | "surface" | "minorGrid" | "grid" | "background" | "paper" | "connectionPreview" | "connectionTarget" | "selectionRect"
  | "wires" | "wire" | "wireHit" | "wireLine" | "wireHandle" | "wireHandleHit" | "wireHandleDot"
  | "wireSegmentHandle" | "wireSegmentHit" | "wireSegmentDot"
  | "flow" | "flowParticle" | "flowLegend" | "flowKey" | "flowNote" | "flowPauseButton" | "flowDisplayControl" | "flowDisplayOption"
  | "parts" | "part" | "partHit" | "selectionHalo" | "partLeads" | "partLabel" | "partDetail"
  | "symbol" | "polarity" | "bulbGlass" | "contact" | "meterLetter" | "meterReading" | "junction"
  | "terminals" | "terminal" | "terminalHit" | "terminalDot" | "terminalRing" | "terminalLabel";

export type CircuitBoardSlotProps = Partial<Record<CircuitBoardSlot, CircuitStyleProps>>;

/** Camera actions exposed to a host-defined toolbar, including one rendered through a portal. */
export interface CircuitBoardControls {
  zoom: number;
  showGrid: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  setShowGrid: (visible: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  fit: () => void;
}

export interface CircuitBoardProps extends Omit<ComponentPropsWithoutRef<"div">, "children" | "style"> {
  style?: CircuitStyleProps["style"];
  document: CircuitDocument;
  selection?: CircuitSelection;
  pendingEndpoint?: CircuitEndpoint | null;
  /** Wire endpoint being replaced; the original wire stays intact until a target is chosen. */
  pendingWire?: { wireId: string; end: CircuitWireEnd } | null;
  /** Open part details on double click or Enter (Shift+Enter for switches). */
  onInspectPart?: (id: string) => void;
  onSelectPart?: (id: string, additive?: boolean) => void;
  onSelectWire?: (id: string, additive?: boolean) => void;
  onSelectRange?: (selection: CircuitSelection, additive?: boolean) => void;
  onTerminalClick?: (endpoint: CircuitEndpoint) => void;
  /** Begins a connection when dragging from a terminal. */
  onConnectionStart?: (endpoint: CircuitEndpoint) => void;
  onReconnectStart?: (wireId: string, end: CircuitWireEnd) => void;
  /** Update a wire's intermediate route points in grid cells, keeping its electrical endpoints. */
  onWireRouteChange?: (id: string, waypoints: Point[] | undefined) => void;
  /** Restore the route from before the current drag, including its undo/redo history. */
  onWireRouteCancel?: (id: string) => void;
  /** Finish one route edit so a complete drag becomes a single undo step. */
  onWireRouteEnd?: () => void;
  onConnectionCancel?: () => void;
  onBoardClick?: (point: Point) => void;
  /** Movement is reported in grid cells and can be applied with the headless edit functions. */
  onMovePart?: (id: string, dx: number, dy: number) => void;
  /** Ends one drag, allowing hosts to group movement into a single undo step. */
  onMoveEnd?: () => void;
  /** Cancels a tentative touch drag when a second finger starts a pinch gesture. */
  onMoveCancel?: (id: string) => void;
  /** Operate switches in read-only mode without enabling structural edits. */
  onSwitchToggle?: (id: string) => void;
  /** The hand tool pans even when dragging over parts and terminals. */
  panMode?: boolean;
  /** Show the circuit without selection, connection, or editing controls. Panning and zooming remain available. */
  readOnly?: boolean;
  /** Refit the camera when the viewport resizes and when this option is enabled. */
  fitOnResize?: boolean;
  /** Allow wheel panning. Disable in document blocks to preserve page scrolling; Ctrl/⌘ + wheel still zooms. */
  panOnScroll?: boolean;
  analysis?: CircuitAnalysis;
  /** Show current, electron flow, or both on wires, with a display selector, legend, and pause control. Requires analysis. */
  showFlow?: boolean;
  /** Offer node potential colors, voltage probes, and terminal-current conservation. */
  showPotentials?: boolean;
  /** Collapse flow and potential settings into a disclosure for inline previews. */
  compactControls?: boolean;
  /** Visible center in grid cells, useful when choosing where to add new parts. */
  onViewportCenterChange?: (point: Point) => void;
  /** Custom SVG art centered at (0, 0). The standard symbol is used when omitted. */
  renderPart?: (part: CircuitPart, selected: boolean) => ReactNode;
  /** Class names and inline styles for internal HTML and SVG elements. */
  slotProps?: CircuitBoardSlotProps;
  /** Replace the built-in controls, or pass null to omit them. */
  renderControls?: ((controls: CircuitBoardControls) => ReactNode) | null;
}

interface DragState {
  id: string;
  pointerId: number;
  last: { x: number; y: number };
  origin: Point;
}

interface ConnectionDrag {
  pointerId: number;
  origin: Point;
  endpoint: CircuitEndpoint;
  wire?: { wireId: string; end: CircuitWireEnd };
  moved: boolean;
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

interface PinchState {
  distance: number;
  worldX: number;
  worldY: number;
  zoom: number;
}

interface RangeState {
  pointerId: number;
  start: Point;
  current: Point;
  additive: boolean;
  moved: boolean;
  target: SVGElement;
}

function fitCamera(document: CircuitDocument, width: number, height: number): Camera {
  const bounds = contentBounds(document);
  if (!bounds) { return { x: -width / 2, y: -height / 2, zoom: 1 }; }
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
  "ac-source": "交流電源",
  "current-source": "電流源",
  resistor: "抵抗",
  bulb: "電球",
  switch: "スイッチ",
  capacitor: "コンデンサ",
  inductor: "コイル",
  potentiometer: "可変抵抗",
  diode: "ダイオード",
  led: "発光ダイオード",
  "npn-transistor": "NPNトランジスタ",
  "pnp-transistor": "PNPトランジスタ",
  nmos: "NチャネルMOSFET",
  pmos: "PチャネルMOSFET",
  "op-amp": "オペアンプ",
  ammeter: "電流計",
  voltmeter: "電圧計",
  ground: "グラウンド",
  junction: "接続点",
};

function engineeringValue(value: number, unit: string) {
  const magnitude = Math.abs(value);
  if (magnitude === 0) { return `0 ${unit}`; }
  const prefixes: [number, string][] = [[1e-12, "p"], [1e-9, "n"], [1e-6, "μ"], [1e-3, "m"], [1, ""], [1e3, "k"], [1e6, "M"]];
  const [scale, prefix] = prefixes.find(([threshold]) => magnitude < threshold * 1000) ?? prefixes.at(-1)!;
  const scaled = value / scale;
  return `${Number(scaled.toPrecision(3))} ${prefix}${unit}`;
}

const partDetailKeys: Partial<Record<CircuitPartKind, readonly CircuitPartNumericKey[]>> = {
  battery: ["voltageVolts"],
  "ac-source": ["voltageVolts", "frequencyHz"],
  "current-source": ["currentAmps"],
  resistor: ["resistanceOhms"],
  bulb: ["resistanceOhms", "ratedPowerWatts"],
  capacitor: ["capacitanceFarads"],
  inductor: ["inductanceHenries"],
  potentiometer: ["resistanceOhms", "wiperPosition"],
  led: ["ratedCurrentAmps"],
  "npn-transistor": ["currentGain"],
  "pnp-transistor": ["currentGain"],
  nmos: ["thresholdVolts"],
  pmos: ["thresholdVolts"],
  "op-amp": ["openLoopGain"],
};

function formatPartDetail(part: CircuitPart, key: CircuitPartNumericKey, unit: string) {
  const value = part[key] ?? circuitPartCatalog[part.kind].defaults[key];
  if (value === undefined) { return ""; }
  if (key === "wiperPosition") { return `${Math.round(value * 100)}%`; }
  const prefix = key === "currentGain" ? "β " : key === "thresholdVolts" ? "Vth " : key === "openLoopGain" ? "A₀ " : "";
  const suffix = key === "voltageVolts" && part.kind === "ac-source" ? " RMS" : key === "ratedCurrentAmps" ? " 定格" : "";
  return `${prefix}${engineeringValue(value, unit)}${suffix}`;
}

function partDetail(part: CircuitPart) {
  const fields = circuitPartNumericFields(part.kind);
  return (partDetailKeys[part.kind] ?? []).map((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    return field ? formatPartDetail(part, key, field.unit) : "";
  }).filter(Boolean).join(" · ");
}

function StandardPartArt({ part, brightness = 0, switchClosed, slotProps }: { part: CircuitPart; brightness?: number; switchClosed?: boolean; slotProps?: CircuitBoardSlotProps }) {
  const symbol = circuitSlot("circuit-board__symbol", slotProps?.symbol);

  switch (part.kind) {
    case "battery":
      return (
        <g {...symbol}>
          <line x1="-20" y1="0" x2="-9" y2="0" />
          <line x1="-9" y1="-15" x2="-9" y2="15" />
          <line x1="9" y1="-8" x2="9" y2="8" />
          <line x1="9" y1="0" x2="20" y2="0" />
          <text {...circuitSlot("circuit-board__polarity", slotProps?.polarity)} x="-9" y="-19" textAnchor="middle">+</text>
          <text {...circuitSlot("circuit-board__polarity", slotProps?.polarity)} x="9" y="-12" textAnchor="middle">−</text>
        </g>
      );
    case "ac-source":
      return (
        <g {...symbol}>
          <path d="M -20 0 H -14 M 14 0 H 20" />
          <circle r="14" />
          <path d="M -7 0 C -5 -7 -2 -7 0 0 S 5 7 7 0" />
        </g>
      );
    case "current-source":
      return (
        <g {...symbol}>
          <path d="M -20 0 H -14 M 14 0 H 20" />
          <circle r="14" />
          <path d="M -8 0 H 8 M 3 -5 L 8 0 L 3 5" />
        </g>
      );
    case "resistor":
      return (
        <g {...symbol}>
          <path fill="none" d="M -20 0 H -14 L -9 -8 L -2 8 L 5 -8 L 12 8 L 17 0 H 20" />
        </g>
      );
    case "bulb":
      return (
        <g {...symbol}>
          <path d="M -20 0 H -14 M 14 0 H 20" />
          <circle r="14" data-lit={brightness > 0} {...circuitSlot("circuit-board__bulb-glass", slotProps?.bulbGlass, { "--circuit-board-bulb-opacity": 0.15 + Math.min(1, brightness) * 0.6 })} />
          <path d="M -7 -7 L 7 7 M 7 -7 L -7 7" />
        </g>
      );
    case "switch": {
      const closed = switchClosed ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
      return (
        <g {...symbol}>
          <path d="M -20 0 H -9 M 9 0 H 20" />
          <circle {...circuitSlot("circuit-board__contact", slotProps?.contact)} cx="-9" cy="0" r="2.7" />
          <circle {...circuitSlot("circuit-board__contact", slotProps?.contact)} cx="9" cy="0" r="2.7" />
          <path d={closed ? "M -9 0 L 9 0" : "M -9 0 L 7 -10"} />
        </g>
      );
    }
    case "capacitor":
      return <g {...symbol}><path d="M -20 0 H -4 M -4 -12 V 12 M 4 -12 V 12 M 4 0 H 20" /></g>;
    case "inductor":
      return <g {...symbol}><path d="M -20 0 H -15 C -15 -10 -5 -10 -5 0 S 5 10 5 0 S 15 -10 15 0 H 20" /></g>;
    case "potentiometer":
      return (
        <g {...symbol}>
          <path d="M -20 0 H -15 L -10 -8 L -4 8 L 2 -8 L 8 8 L 14 -8 L 18 0 H 20" />
          <path d="M 0 -20 V -8 L 6 -14 M 0 -8 L -3 -12" />
        </g>
      );
    case "diode":
    case "led":
      return (
        <g {...symbol}>
          {part.kind === "led" && <circle r="7" data-lit={brightness > 0} {...circuitSlot("circuit-board__bulb-glass", slotProps?.bulbGlass, { "--circuit-board-bulb-opacity": 0.15 + Math.min(1, brightness) * 0.6 })} />}
          <path d="M -20 0 H -10 M 10 0 H 20 M -10 -12 L 8 0 L -10 12 Z M 10 -12 V 12" />
          {part.kind === "led" && <path d="M -2 -15 L 7 -24 M 4 -24 H 7 V -21 M 5 -8 L 14 -17 M 11 -17 H 14 V -14" />}
        </g>
      );
    case "npn-transistor":
    case "pnp-transistor":
      return (
        <g {...symbol}>
          <circle r="16" />
          <path d="M -8 -12 V 12 M -20 0 H -8 M 0 -16 V -8 M 0 8 V 16 M 0 -8 L 10 -18 M 0 8 L 10 18" />
          {part.kind === "npn-transistor"
            ? <path d="M 6 13 L 10 18 L 3 17 M 6 13 L 7 20" />
            : <path d="M 6 -13 L 10 -18 L 3 -17 M 6 -13 L 7 -20" />}
        </g>
      );
    case "nmos":
    case "pmos":
      return (
        <g {...symbol}>
          <path d="M 0 -20 V -14 M 0 14 V 20 M -6 -14 V 14 M 0 -10 H 11 M 0 10 H 11" />
          {part.kind === "nmos" ? <path d="M 4 7 L 10 10 L 4 13" /> : <path d="M -2 -13 L -8 -10 L -2 -7" />}
        </g>
      );
    case "op-amp":
      return (
        <g {...symbol}>
          <path d="M -20 -26 V 26 L 20 0 Z M 20 0 H 40" />
          <text x="-12" y="-12" fontSize="10" textAnchor="middle">+</text>
          <text x="-12" y="17" fontSize="10" textAnchor="middle">−</text>
        </g>
      );
    case "ammeter":
    case "voltmeter":
      return (
        <g {...symbol}>
          <path d="M -20 0 H -14 M 14 0 H 20" />
          <circle r="14" />
          <text {...circuitSlot("circuit-board__meter-letter", slotProps?.meterLetter)} transform={`rotate(${-(part.rotation ?? 0)})`} textAnchor="middle" dominantBaseline="central">
            {part.kind === "ammeter" ? "A" : "V"}
          </text>
          <text {...circuitSlot("circuit-board__polarity", slotProps?.polarity)} transform={`rotate(${-(part.rotation ?? 0)} -25 -8)`} x="-25" y="-8" textAnchor="middle">+</text>
          <text {...circuitSlot("circuit-board__polarity", slotProps?.polarity)} transform={`rotate(${-(part.rotation ?? 0)} 25 -8)`} x="25" y="-8" textAnchor="middle">−</text>
        </g>
      );
    case "junction":
      return <circle {...circuitSlot("circuit-board__junction", slotProps?.junction)} r="5" />;
    case "ground":
      return <g {...symbol}><path d="M 0 -20 V -4 M -12 0 H 12 M -8 6 H 8 M -4 12 H 4" /></g>;
  }
}

function endpointKey(endpoint: CircuitEndpoint) {
  return `${endpoint.partId}:${endpoint.terminal}`;
}

function connectionPreviewEnd(parts: Map<string, CircuitPart>, target: ConnectionTarget | null, pointer: Point | null) {
  const part = target?.endpoint ? parts.get(target.endpoint.partId) : undefined;
  return part && target?.endpoint
    ? routeEnd(part, target.endpoint.terminal)
    : { point: pointer ?? { x: 0, y: 0 }, direction: null };
}

function rangeBounds(start: Point, current: Point) {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    right: Math.max(start.x, current.x),
    bottom: Math.max(start.y, current.y),
  };
}

function pointInRange(point: Point, bounds: ReturnType<typeof rangeBounds>) {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

function isTextEntryTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(target.tagName));
}

function shouldStartSpacePan(event: globalThis.KeyboardEvent, pointerInside: boolean, viewport: HTMLDivElement | null) {
  if (event.code !== "Space" || event.repeat) { return false; }
  const target = event.target;
  if (isTextEntryTarget(target)) { return false; }
  if (target instanceof SVGElement && target.closest('[role="button"]')) { return false; }
  const targetIsInViewport = target instanceof Node && viewport?.contains(target);
  return pointerInside || Boolean(targetIsInViewport);
}

function isPreviewPartGesture(event: PointerEvent<SVGSVGElement>, readOnly: boolean, onInspectPart: CircuitBoardProps["onInspectPart"], onSwitchToggle: CircuitBoardProps["onSwitchToggle"], spacePressed: boolean) {
  if (!readOnly || !(event.target instanceof Element)) { return false; }
  if (onSwitchToggle && event.target.closest('[data-kind="switch"]')) { return true; }
  return Boolean(onInspectPart) && event.button === 0 && !spacePressed && Boolean(event.target.closest('.circuit-board__part'));
}

function clickCircuitPart(
  event: MouseEvent<SVGGElement>,
  part: CircuitPart,
  readOnly: boolean,
  onSelectPart?: (id: string, additive?: boolean) => void,
  onSwitchToggle?: (id: string) => void,
  onPointerClick?: (event: MouseEvent<SVGGElement>, part: CircuitPart) => void,
) {
  if (readOnly && part.kind === "switch" && onSwitchToggle) {
    event.stopPropagation();
    onSwitchToggle(part.id);
  } else if (!readOnly) {
    if (onPointerClick) { onPointerClick(event, part); }
    else { onSelectPart?.(part.id, event.shiftKey || event.ctrlKey || event.metaKey); }
  }
}

function keyDownOnCircuitPart(
  event: KeyboardEvent<SVGGElement>,
  part: CircuitPart,
  readOnly: boolean,
  onSwitchToggle: ((id: string) => void) | undefined,
  handlePartKeyDown: (event: KeyboardEvent<SVGGElement>, part: CircuitPart) => void,
) {
  if (readOnly && part.kind === "switch" && onSwitchToggle && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    event.stopPropagation();
    onSwitchToggle(part.id);
    return;
  }
  handlePartKeyDown(event, part);
}

function cancelDragForPinch(
  drag: DragState | null,
  partsById: Map<string, CircuitPart>,
  onMoveCancel?: (id: string) => void,
  onMovePart?: (id: string, dx: number, dy: number) => void,
  onMoveEnd?: () => void,
) {
  if (!drag) { return; }
  const part = partsById.get(drag.id);
  if (onMoveCancel) { onMoveCancel(drag.id); }
  else if (part) { onMovePart?.(part.id, drag.origin.x - part.x, drag.origin.y - part.y); }
  onMoveEnd?.();
}

function circuitPartAccessibility(part: CircuitPart, isSelected: boolean, readOnly: boolean, onSwitchToggle?: (id: string) => void, switchClosed?: boolean) {
  const canToggleSwitch = readOnly && part.kind === "switch" && onSwitchToggle !== undefined;
  const closed = switchClosed ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
  return {
    canToggleSwitch,
    role: readOnly ? canToggleSwitch ? "button" : undefined : "button",
    tabIndex: readOnly ? canToggleSwitch ? 0 : undefined : 0,
    ariaLabel: canToggleSwitch
      ? `${part.label}を${closed ? "開く" : "閉じる"}`
      : `${part.label}、${partDescriptions[part.kind]}`,
    ariaPressed: readOnly ? canToggleSwitch ? closed : undefined : isSelected,
  };
}

function circuitPartLabelLayout(part: CircuitPart) {
  const vertical = isVertical(part);
  return {
    x: vertical ? 31 : 0,
    labelY: vertical ? -2 : 35,
    detailY: vertical ? 13 : 49,
    textAnchor: vertical ? "start" : "middle",
  } as const;
}

function CircuitPartSymbol({
  part,
  selected,
  renderPart,
  analysis,
  slotProps,
}: {
  part: CircuitPart;
  selected: boolean;
  renderPart?: (part: CircuitPart, selected: boolean) => ReactNode;
  analysis?: CircuitAnalysis;
  slotProps?: CircuitBoardSlotProps;
}) {
  return (
    <g transform={`rotate(${part.rotation ?? 0})`}>
      {part.kind !== "junction" && (
        <g {...circuitSlot("circuit-board__part-leads", slotProps?.partLeads)}>
          {terminalsOf(part.kind).map((terminal) => {
            const terminalOffset = localTerminalOffset(part.kind, terminal);
            const inner = innerPartLeadEnd(part.kind, terminal);
            return <line key={terminal} x1={terminalOffset.x * GRID} y1={terminalOffset.y * GRID} x2={inner.x} y2={inner.y} />;
          })}
        </g>
      )}
      {renderPart ? renderPart(part, selected) : <StandardPartArt
        part={part}
        brightness={analysis?.parts[part.id]?.brightness}
        switchClosed={analysis?.parts[part.id]?.switchClosed}
        slotProps={slotProps}
      />}
    </g>
  );
}

const specialLeadEnds: Partial<Record<CircuitPartKind, (terminal: CircuitTerminal) => Point>> = {
  ground: () => ({ x: 0, y: -GRID }),
  potentiometer: (terminal) => terminal === "c"
    ? { x: 0, y: -8 }
    : { x: terminal === "a" ? -GRID : GRID, y: 0 },
  "npn-transistor": (terminal) => terminal === "a"
    ? { x: 0, y: -16 }
    : terminal === "b" ? { x: -16, y: 0 } : { x: 0, y: 16 },
  "pnp-transistor": (terminal) => terminal === "a"
    ? { x: 0, y: -16 }
    : terminal === "b" ? { x: -16, y: 0 } : { x: 0, y: 16 },
  nmos: (terminal) => terminal === "a"
    ? { x: 0, y: -14 }
    : terminal === "b" ? { x: -6, y: 0 } : { x: 0, y: 14 },
  pmos: (terminal) => terminal === "a"
    ? { x: 0, y: -14 }
    : terminal === "b" ? { x: -6, y: 0 } : { x: 0, y: 14 },
  "op-amp": (terminal) => terminal === "a"
    ? { x: -20, y: -GRID }
    : terminal === "b" ? { x: -20, y: GRID } : { x: 20, y: 0 },
};

function innerPartLeadEnd(kind: CircuitPartKind, terminal: CircuitTerminal): Point {
  return specialLeadEnds[kind]?.(terminal) ?? { x: terminal === "a" ? -GRID : GRID, y: 0 };
}

function CircuitPartDetail({ part, meter, slotProps }: {
  part: CircuitPart;
  meter: ReturnType<typeof getMeterDisplay>;
  slotProps?: CircuitBoardSlotProps;
}) {
  const detail = meter?.text ?? partDetail(part);
  if (!detail) { return null; }
  const labelLayout = circuitPartLabelLayout(part);
  return (
    <text
      {...circuitSlot(meter ? "circuit-board__part-detail circuit-board__meter-reading" : "circuit-board__part-detail", meter ? slotProps?.meterReading : slotProps?.partDetail)}
      fontSize={meter ? "var(--circuit-board-label-size, 10px)" : "var(--circuit-board-detail-size, 9px)"}
      x={labelLayout.x}
      y={labelLayout.detailY}
      textAnchor={labelLayout.textAnchor}
      data-measurement={meter ? part.kind === "ammeter" ? "current" : "voltage" : undefined}
      data-meter-status={meter?.status}
    >
      {detail}
    </text>
  );
}

function CircuitPartArtwork({
  part,
  isSelected,
  isDragging,
  readOnly,
  onSwitchToggle,
  onInspectPart,
  onSelectPart,
  onPointerClick,
  onPointerDown,
  onKeyDown,
  renderPart,
  analysis,
  slotProps,
}: {
  part: CircuitPart;
  isSelected: boolean;
  isDragging: boolean;
  readOnly: boolean;
  onSwitchToggle?: (id: string) => void;
  onInspectPart?: (id: string) => void;
  onSelectPart?: (id: string, additive?: boolean) => void;
  onPointerClick?: (event: MouseEvent<SVGGElement>, part: CircuitPart) => void;
  onPointerDown: (event: PointerEvent<SVGGElement>, part: CircuitPart) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, part: CircuitPart) => void;
  renderPart?: (part: CircuitPart, selected: boolean) => ReactNode;
  analysis?: CircuitAnalysis;
  slotProps?: CircuitBoardSlotProps;
}) {
  const pendingClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pendingClick.current !== null) { clearTimeout(pendingClick.current); } }, []);
  const inspect = (element: SVGGElement) => {
    if (!onInspectPart) { return; }
    if (pendingClick.current !== null) { clearTimeout(pendingClick.current); pendingClick.current = null; }
    element.focus({ preventScroll: true });
    onInspectPart(part.id);
  };
  const meter = getMeterDisplay(part.kind, analysis?.parts[part.id], analysis?.status);
  const accessibility = circuitPartAccessibility(part, isSelected, readOnly, onSwitchToggle, analysis?.parts[part.id]?.switchClosed);
  const labelLayout = circuitPartLabelLayout(part);

  return (
    <g
      {...circuitSlot(`circuit-board__part${isSelected ? " circuit-board__part--selected" : ""}${isDragging ? " circuit-board__part--dragging" : ""}`, slotProps?.part)}
      data-part-id={part.id}
      data-kind={part.kind}
      data-selected={isSelected}
      data-dragging={isDragging}
      transform={`translate(${part.x * GRID} ${part.y * GRID})`}
      role={onInspectPart ? "button" : accessibility.role ?? (meter ? "img" : undefined)}
      tabIndex={onInspectPart ? 0 : accessibility.tabIndex}
      aria-label={meter ? `${accessibility.ariaLabel}、${meter.text}` : accessibility.ariaLabel}
      aria-pressed={accessibility.ariaPressed}
      aria-haspopup={onInspectPart ? "dialog" : undefined}
      aria-keyshortcuts={onInspectPart ? part.kind === "switch" ? "Shift+Enter" : "Enter" : undefined}
      onPointerDown={(event) => onPointerDown(event, part)}
      onClick={(event) => {
        if (readOnly && onInspectPart && part.kind === "switch" && onSwitchToggle && event.detail > 0) {
          event.stopPropagation();
          if (pendingClick.current !== null) { clearTimeout(pendingClick.current); }
          if (event.detail === 1) { pendingClick.current = setTimeout(() => { pendingClick.current = null; onSwitchToggle(part.id); }, 350); }
          return;
        }
        clickCircuitPart(event, part, readOnly, onSelectPart, onSwitchToggle, onPointerClick);
      }}
      onDoubleClick={onInspectPart ? (event) => { event.preventDefault(); event.stopPropagation(); inspect(event.currentTarget); } : undefined}
      onKeyDown={(event) => {
        if (onInspectPart && event.key === "Enter" && (part.kind !== "switch" || event.shiftKey)) {
          event.preventDefault(); event.stopPropagation(); inspect(event.currentTarget); return;
        }
        onKeyDown(event, part);
      }}
    >
      <title>{`${part.label}（${partDescriptions[part.kind]}）${meter ? `：${meter.text}${meter.phaseText ? ` · ${meter.phaseText}` : ""}\n${meter.note}` : ""}${onInspectPart ? "：ダブルクリックで値を調整・計測" : ""}`}</title>
      <circle {...circuitSlot("circuit-board__part-hit", slotProps?.partHit)} r="23" />
      <rect {...circuitSlot("circuit-board__selection-halo", slotProps?.selectionHalo)} x="-25" y="-24" width="50" height="48" rx="5" />
      <CircuitPartSymbol part={part} selected={isSelected} renderPart={renderPart} analysis={analysis} slotProps={slotProps} />
      <text {...circuitSlot("circuit-board__part-label", slotProps?.partLabel)} fontSize="var(--circuit-board-label-size, 10px)" x={labelLayout.x} y={labelLayout.labelY} textAnchor={labelLayout.textAnchor}>
        {part.label}
      </text>
      <CircuitPartDetail part={part} meter={meter} slotProps={slotProps} />
    </g>
  );
}

function CircuitTerminalArtwork({
  part,
  terminal,
  pending,
  connected,
  selected,
  readOnly,
  onSelectPart,
  onTerminalClick,
  onPointerDown,
  slotProps,
}: {
  part: CircuitPart;
  terminal: CircuitTerminal;
  pending: boolean;
  connected: boolean;
  selected: boolean;
  readOnly: boolean;
  onSelectPart?: (id: string, additive?: boolean) => void;
  onTerminalClick?: (endpoint: CircuitEndpoint) => void;
  onPointerDown: (event: PointerEvent<SVGGElement>, endpoint: CircuitEndpoint) => void;
  slotProps?: CircuitBoardSlotProps;
}) {
  const keyboardClickRef = useRef(false);
  const endpoint = { partId: part.id, terminal };
  const point = terminalPoint(part, terminal);
  return (
    <g
      key={endpointKey(endpoint)}
      {...circuitSlot(`circuit-board__terminal${pending ? " circuit-board__terminal--pending" : ""}${connected ? " circuit-board__terminal--connected" : ""}`, slotProps?.terminal)}
      data-part-id={part.id}
      data-terminal={terminal}
      data-connected={connected}
      data-pending={pending}
      data-selected={selected}
      transform={`translate(${point.x * GRID} ${point.y * GRID})`}
      role={readOnly ? undefined : "button"}
      tabIndex={readOnly ? undefined : 0}
      aria-label={endpointName(part, terminal)}
      onPointerDown={(event) => {
        if (part.kind === "junction" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
          event.stopPropagation();
          return;
        }
        onPointerDown(event, endpoint);
      }}
      onClick={(event) => {
        if (readOnly) { return; }
        event.stopPropagation();
        if (event.detail === 0 && keyboardClickRef.current) {
          keyboardClickRef.current = false;
          return;
        }
        if (part.kind === "junction" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
          onSelectPart?.(part.id, true);
        } else {
          onTerminalClick?.(endpoint);
        }
      }}
      onKeyDown={(event) => {
        if (readOnly || (event.key !== "Enter" && event.key !== " ")) { return; }
        event.preventDefault();
        event.stopPropagation();
        keyboardClickRef.current = true;
        setTimeout(() => { keyboardClickRef.current = false; }, 0);
        if (part.kind === "junction" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
          onSelectPart?.(part.id, true);
        } else {
          onTerminalClick?.(endpoint);
        }
      }}
    >
      <title>{`${endpointName(part, terminal)}からドラッグ、またはクリックして接続`}</title>
      <circle {...circuitSlot("circuit-board__terminal-hit", slotProps?.terminalHit)} r="12" />
      <circle {...circuitSlot("circuit-board__terminal-dot", slotProps?.terminalDot)} r={part.kind === "junction" ? 0 : connected ? 2.5 : 3.5} />
      {pending && <circle {...circuitSlot("circuit-board__terminal-ring", slotProps?.terminalRing)} r="8" />}
      <text {...circuitSlot("circuit-board__terminal-label", slotProps?.terminalLabel)} x="0" y="-9" textAnchor="middle">
        {part.kind === "junction" ? "" : terminalName(part, terminal).replace("端子", "")}
      </text>
    </g>
  );
}

function CircuitWireSegmentHandles({
  enabled,
  document,
  routes,
  selected,
  scale,
  onStart,
  onKeyDown,
  slotProps,
}: {
  enabled: boolean;
  document: CircuitDocument;
  routes: ReadonlyMap<string, readonly Point[]>;
  selected: ReadonlySet<string>;
  scale: number;
  onStart: (event: PointerEvent<SVGGElement>, id: string, index: number) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, id: string, index: number) => void;
  slotProps?: CircuitBoardSlotProps;
}) {
  if (!enabled) { return null; }
  return document.wires.filter((wire) => selected.has(wire.id)).flatMap((wire) => {
    const route = routes.get(wire.id) ?? [];
    return route.slice(0, -1).map((from, index) => {
      const to = route[index + 1];
      if (from.x === to.x && from.y === to.y) { return null; }
      const horizontal = from.y === to.y;
      const direction = horizontal ? "上下" : "左右";
      const label = `導線 ${wire.id} の区間${index + 1}を${direction}に移動`;
      return (
        <g
          {...circuitSlot("circuit-board__wire-segment-handle", slotProps?.wireSegmentHandle)}
          key={`${wire.id}:${from.x},${from.y}:${to.x},${to.y}`}
          data-wire-id={wire.id}
          data-segment-index={index}
          data-orientation={horizontal ? "horizontal" : "vertical"}
          transform={`translate(${(from.x + to.x) * GRID / 2} ${(from.y + to.y) * GRID / 2})`}
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-keyshortcuts={horizontal ? "ArrowUp ArrowDown" : "ArrowLeft ArrowRight"}
          onPointerDown={(event) => onStart(event, wire.id, index)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => onKeyDown(event, wire.id, index)}
        >
          <title>{`${label}。ドラッグまたは矢印キーで調整、Shiftで5マス移動。`}</title>
          <rect {...circuitSlot("circuit-board__wire-segment-hit", slotProps?.wireSegmentHit)} x={-13 * scale} y={-13 * scale} width={26 * scale} height={26 * scale} rx={4 * scale} />
          <rect {...circuitSlot("circuit-board__wire-segment-dot", slotProps?.wireSegmentDot)} x={-4 * scale} y={-4 * scale} width={8 * scale} height={8 * scale} rx={1.5 * scale} />
        </g>
      );
    });
  });
}

function wireRouteEditingEnabled(props: Pick<CircuitBoardProps, "readOnly" | "panMode" | "pendingEndpoint" | "onWireRouteChange">, spacePressed: boolean) {
  return Boolean(props.onWireRouteChange) && !props.readOnly && !props.panMode && !props.pendingEndpoint && !spacePressed;
}

function wireTitle(from: string, to: string, editable: boolean) {
  return `${from} と ${to} をつなぐ導線${editable ? "。区間をドラッグして経路を移動できます。" : ""}`;
}

function shouldHandleWheel(event: WheelEvent, panOnScroll: boolean) {
  return panOnScroll || event.ctrlKey || event.metaKey;
}

function BoardDisplaySettings({ compact, showFlow, showPotentials, children }: {
  compact: boolean;
  showFlow: boolean;
  showPotentials: boolean;
  children: ReactNode;
}) {
  if (!compact || !(showFlow || showPotentials)) { return children; }
  return (
    <details className="circuit-board__display-settings">
      <summary><CircuitIcon name="sliders" size={14} />表示設定<CircuitIcon name="chevron" size={12} /></summary>
      <div className="circuit-board__display-settings-content">{children}</div>
    </details>
  );
}

export function CircuitBoard({
  document,
  selection,
  pendingEndpoint,
  pendingWire,
  onSelectPart,
  onSelectWire,
  onSelectRange,
  onTerminalClick,
  onConnectionStart,
  onReconnectStart,
  onWireRouteChange,
  onWireRouteCancel,
  onWireRouteEnd,
  onConnectionCancel,
  onBoardClick,
  onMovePart,
  onMoveEnd,
  onMoveCancel,
  onSwitchToggle,
  onInspectPart,
  panMode = false,
  readOnly = false,
  fitOnResize = false,
  panOnScroll = true,
  analysis,
  showFlow = false,
  showPotentials = false,
  compactControls = false,
  onViewportCenterChange,
  renderPart,
  slotProps,
  renderControls,
  className,
  style,
  ...rootProps
}: CircuitBoardProps) {
  const generatedId = useId().replaceAll(":", "");
  const smallGridId = `circuit-board-grid-${generatedId}`;
  const majorGridId = `circuit-board-major-${generatedId}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [range, setRange] = useState<RangeState | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [flowDisplay, setFlowDisplay] = useState<FlowDisplay>("current");
  const [flowPaused, setFlowPaused] = useState(false);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget | null>(null);
  const connectionDragRef = useRef<ConnectionDrag | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [cameraFrame] = useState(() => createCameraFrame(setCamera));
  const cameraRef = useRef(camera);
  const documentRef = useRef(document);
  documentRef.current = document;
  const fitOnResizeRef = useRef(fitOnResize);
  fitOnResizeRef.current = fitOnResize;
  const previousFitOnResizeRef = useRef(fitOnResize);
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
  const rangeRef = useRef<RangeState | null>(null);
  const modifierPartClickRef = useRef<{ id: string; additive: boolean } | null>(null);
  const suppressPointerClickRef = useRef(false);
  const keyboardPartClickRef = useRef<string | null>(null);
  const keyboardWireClickRef = useRef<string | null>(null);
  const draggedRef = useRef(false);
  const clearDragClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedParts = useMemo(() => new Set(readOnly ? [] : selection?.parts ?? []), [readOnly, selection?.parts]);
  const selectedWires = useMemo(() => new Set(readOnly ? [] : selection?.wires ?? []), [readOnly, selection?.wires]);
  const connectedTerminals = useMemo(() => new Set(document.wires.flatMap((wire) => [endpointKey(wire.from), endpointKey(wire.to)])), [document.wires]);
  const partsById = useMemo(() => new Map(document.parts.map((part) => [part.id, part])), [document.parts]);
  const wireRoutes = useMemo(() => routeDocumentWires(document), [document.parts, document.wires]);
  const hasFlow = showFlow && document.wires.some((wire) => wireFlowCurrent(analysis, wire.id) !== 0 && wireRoutes.has(wire.id));
  const potentialView = useCircuitPotentialView(document, analysis, showPotentials);
  const pendingPart = !readOnly && pendingEndpoint ? partsById.get(pendingEndpoint.partId) : undefined;
  const selectedPartId = readOnly ? undefined : selection?.parts[0];
  const canEditWireRoute = wireRouteEditingEnabled({ onWireRouteChange, readOnly, panMode, pendingEndpoint }, spacePressed);

  useEffect(() => {
    onViewportCenterChange?.({
      x: Math.round((camera.x + size.width / (2 * camera.zoom)) / GRID),
      y: Math.round((camera.y + size.height / (2 * camera.zoom)) / GRID),
    });
  }, [camera, size, onViewportCenterChange]);

  useEffect(() => {
    const part = document.parts.find((item) => item.id === selectedPartId);
    if (!part || !initializedRef.current) { return; }
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
    if (!pendingEndpoint) {
      setPointer(null);
      setConnectionTarget(null);
      if (connectionDragRef.current?.moved) { connectionDragRef.current = null; }
    }
  }, [pendingEndpoint]);

  useEffect(() => {
    if (readOnly || panMode) { cancelConnectionDrag(); }
  }, [readOnly, panMode]);

  useEffect(() => () => cameraFrame.cancel(), [cameraFrame]);

  function updateCamera(next: Camera, continuous = false) {
    // Accumulate every input immediately; only the visible update waits for a frame.
    cameraRef.current = next;
    if (continuous) { cameraFrame.queue(next); }
    else {
      cameraFrame.cancel();
      setCamera(next);
    }
  }

  function zoomAt(nextZoom: number, clientX: number, clientY: number, continuous = false) {
    const viewport = viewportRef.current;
    if (!viewport) { return; }
    const current = cameraRef.current;
    const rect = viewport.getBoundingClientRect();
    updateCamera(zoomCameraAt(current, nextZoom, { x: clientX - rect.left, y: clientY - rect.top }), continuous);
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) { return; }
    const hasInitialized = (): boolean => initializedRef.current;
    const measure = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (!width || !height) { return; }
      const previous = measuredSizeRef.current;
      if (previous.width === width && previous.height === height) { return; }
      measuredSizeRef.current = { width, height };
      setSize({ width, height });
      if (!hasInitialized()) {
        initializedRef.current = true;
        updateCamera(fitCamera(documentRef.current, width, height));
      } else if (fitOnResizeRef.current) {
        updateCamera(fitCamera(documentRef.current, width, height));
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
    if (fitOnResize && !previousFitOnResizeRef.current) {
      const { width, height } = measuredSizeRef.current;
      if (width > 0 && height > 0) { updateCamera(fitCamera(documentRef.current, width, height)); }
    }
    previousFitOnResizeRef.current = fitOnResize;
  }, [fitOnResize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) { return; }
    const onWheel = (event: WheelEvent) => {
      if (!shouldHandleWheel(event, panOnScroll)) { return; }
      event.preventDefault();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        zoomAt(cameraRef.current.zoom * Math.exp(-event.deltaY * factor * 0.002), event.clientX, event.clientY, true);
      } else {
        const current = cameraRef.current;
        updateCamera({
          ...current,
          x: current.x + event.deltaX * factor / current.zoom,
          y: current.y + event.deltaY * factor / current.zoom,
        }, true);
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [panOnScroll]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!shouldStartSpacePan(event, pointerInsideRef.current, viewportRef.current)) { return; }
      // Space activates focused SVG controls; it only starts panning on the canvas itself.
      if (pointerInsideRef.current) { event.preventDefault(); }
      spacePressedRef.current = true;
      setSpacePressed(true);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space") { return; }
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

  const pointAtPointer = useCallback((event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) { return { x: 0, y: 0 }; }
    const rect = viewport.getBoundingClientRect();
    const current = cameraRef.current;
    return {
      x: (current.x + (event.clientX - rect.left) / current.zoom) / GRID,
      y: (current.y + (event.clientY - rect.top) / current.zoom) / GRID,
    };
  }, []);

  const gridAtPointer = useCallback((event: { clientX: number; clientY: number }) => {
    const point = pointAtPointer(event);
    return snapToGrid({ x: point.x * GRID, y: point.y * GRID });
  }, [pointAtPointer]);

  const finishWireRoutePointer = useCallback(() => {
    draggedRef.current = true;
    suppressPointerClickRef.current = true;
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      suppressPointerClickRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
  }, []);
  const wireRouteDrag = useWireRouteDrag({
    document,
    routes: wireRoutes,
    enabled: canEditWireRoute,
    svgRef,
    pointAtPointer,
    onSelect: onSelectWire,
    onChange: onWireRouteChange,
    onCancel: onWireRouteCancel,
    onEnd: onWireRouteEnd,
    onDrag: () => { draggedRef.current = true; },
    onFinish: finishWireRoutePointer,
  });

  function cancelWireRouteForPinch() {
    if (!wireRouteDrag.cancel(undefined, false)) { return; }
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    clearDragClickTimer.current = null;
    suppressPointerClickRef.current = false;
  }

  function targetAtPointer(event: { clientX: number; clientY: number; pointerType?: string }) {
    const radius = (event.pointerType === "touch" ? 24 : 16) / (GRID * cameraRef.current.zoom);
    return connectionTargetAt(document, wireRoutes, pointAtPointer(event), radius, pendingWire?.wireId);
  }

  const beginReconnect = useCallback((wireId: string, end: CircuitWireEnd) => {
    if (readOnly || panMode || spacePressedRef.current) { return; }
    onReconnectStart?.(wireId, end);
    // The handle disappears during reconnection; keep keyboard cancellation on the board.
    viewportRef.current?.focus({ preventScroll: true });
  }, [onReconnectStart, readOnly, panMode]);

  const startConnectionDrag = useCallback((event: PointerEvent<SVGGElement>, endpoint: CircuitEndpoint, wire?: ConnectionDrag["wire"]) => {
    event.stopPropagation();
    if (readOnly || panMode || event.button !== 0 || (wire ? !onReconnectStart : !onConnectionStart)) { return; }
    event.preventDefault();
    event.currentTarget.focus?.({ preventScroll: true });
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    draggedRef.current = false;
    connectionDragRef.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, endpoint, wire, moved: false };
    try { svgRef.current?.setPointerCapture(event.pointerId); } catch { /* Unsupported capture. */ }
  }, [readOnly, panMode, onConnectionStart, onReconnectStart]);

  function releaseConnectionPointer(pointerId: number) {
    try {
      if (svgRef.current?.hasPointerCapture(pointerId)) { svgRef.current.releasePointerCapture(pointerId); }
    } catch { /* Unsupported capture. */ }
  }

  function cancelConnectionDrag(releaseCapture = true) {
    const connectionDrag = connectionDragRef.current;
    if (!connectionDrag) { return; }
    connectionDragRef.current = null;
    draggedRef.current = true;
    setPointer(null);
    setConnectionTarget(null);
    onConnectionCancel?.();
    if (releaseCapture) { releaseConnectionPointer(connectionDrag.pointerId); }
  }

  function moveConnectionDrag(event: PointerEvent<SVGSVGElement>) {
    const connectionDrag = connectionDragRef.current;
    if (!connectionDrag || connectionDrag.pointerId !== event.pointerId) { return false; }
    if (!connectionDrag.moved && Math.hypot(event.clientX - connectionDrag.origin.x, event.clientY - connectionDrag.origin.y) < 4) { return true; }
    if (!connectionDrag.moved) {
      connectionDrag.moved = true;
      if (connectionDrag.wire) { beginReconnect(connectionDrag.wire.wireId, connectionDrag.wire.end); }
      else { onConnectionStart?.(connectionDrag.endpoint); }
    }
    draggedRef.current = true;
    const target = targetAtPointer(event);
    setPointer(target.point);
    setConnectionTarget(target);
    return true;
  }

  function finishConnectionDrag(event: PointerEvent<SVGSVGElement>) {
    const connectionDrag = connectionDragRef.current;
    if (!connectionDrag || connectionDrag.pointerId !== event.pointerId) { return false; }
    connectionDragRef.current = null;
    releaseConnectionPointer(event.pointerId);
    if (!connectionDrag.moved) {
      if (connectionDrag.wire) { beginReconnect(connectionDrag.wire.wireId, connectionDrag.wire.end); }
      else { chooseTerminal(connectionDrag.endpoint); }
      draggedRef.current = true;
      clearDragClickTimer.current = setTimeout(() => {
        draggedRef.current = false;
        clearDragClickTimer.current = null;
      }, 0);
      return true;
    }
    const rect = viewportRef.current?.getBoundingClientRect();
    const outside = rect && rect.width > 0 && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    if (outside || readOnly || panMode) { onConnectionCancel?.(); }
    else {
      const target = targetAtPointer(event);
      if (target.endpoint) { onTerminalClick?.(target.endpoint); }
      else { onBoardClick?.(target.point); }
    }
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
    return true;
  }

  const chooseTerminal = useCallback((endpoint: CircuitEndpoint) => {
    if (!readOnly && !panMode && !spacePressedRef.current) { onTerminalClick?.(endpoint); }
  }, [readOnly, panMode, onTerminalClick]);

  const chooseWire = useCallback((wireId: string, event?: MouseEvent<SVGGElement>, additive = false) => {
    if (readOnly || panMode || spacePressedRef.current) { return; }
    if (event?.detail === 0 && keyboardWireClickRef.current === wireId) {
      keyboardWireClickRef.current = null;
      return;
    }
    const route = wireRoutes.get(wireId);
    if (pendingEndpoint && onBoardClick && route) {
      const point = event && event.detail > 0 ? closestWirePoint(route, pointAtPointer(event)) : wireMidpoint(route);
      if (point) { onBoardClick(point); }
    } else { onSelectWire?.(wireId, additive || Boolean(event && (event.shiftKey || event.ctrlKey || event.metaKey))); }
  }, [readOnly, panMode, wireRoutes, pendingEndpoint, onBoardClick, pointAtPointer, onSelectWire]);

  const startDrag = useCallback((event: PointerEvent<SVGGElement>, part: CircuitPart) => {
    if (readOnly || event.button !== 0) { return; }
    event.currentTarget.focus({ preventScroll: true });
    modifierPartClickRef.current = null;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (selectedParts.has(part.id)) {
      if (additive) { modifierPartClickRef.current = { id: part.id, additive }; }
    } else {
      onSelectPart?.(part.id, additive);
    }
    if (!onMovePart) { return; }
    event.preventDefault();
    event.stopPropagation();
    const point = gridAtPointer(event);
    draggedRef.current = false;
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    setDrag({ id: part.id, pointerId: event.pointerId, last: point, origin: { x: part.x, y: part.y } });
    try {
      svgRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some server-rendering and test environments.
    }
  }, [readOnly, onSelectPart, onMovePart, gridAtPointer, selectedParts]);

  const handlePartPointerClick = useCallback((event: MouseEvent<SVGGElement>, part: CircuitPart) => {
    if (event.detail === 0) {
      if (keyboardPartClickRef.current === part.id) {
        keyboardPartClickRef.current = null;
        return;
      }
      onSelectPart?.(part.id, event.shiftKey || event.ctrlKey || event.metaKey);
      return;
    }
    const pending = modifierPartClickRef.current;
    if (!pending || pending.id !== part.id) { return; }
    modifierPartClickRef.current = null;
    if (!draggedRef.current) { onSelectPart?.(part.id, pending.additive); }
    event.stopPropagation();
  }, [onSelectPart]);

  function startPan(event: PointerEvent<SVGElement>) {
    if (event.button !== 0 && event.button !== 1) { return; }
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
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

  function startRange(event: PointerEvent<SVGSVGElement>) {
    const point = pointAtPointer(event);
    const next: RangeState = {
      pointerId: event.pointerId,
      start: point,
      current: point,
      additive: true,
      moved: false,
      target: event.currentTarget,
    };
    rangeRef.current = next;
    setRange(next);
    draggedRef.current = false;
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Unsupported capture. */ }
  }

  function moveRange(event: PointerEvent<SVGSVGElement>) {
    const current = rangeRef.current;
    if (!current || current.pointerId !== event.pointerId) { return false; }
    const point = pointAtPointer(event);
    const moved = current.moved || Math.hypot(
      (point.x - current.start.x) * GRID * cameraRef.current.zoom,
      (point.y - current.start.y) * GRID * cameraRef.current.zoom,
    ) > 4;
    const next = { ...current, current: point, moved };
    rangeRef.current = next;
    setRange(next);
    if (moved) { draggedRef.current = true; }
    return true;
  }

  function finishRange(event: PointerEvent<SVGSVGElement>) {
    const current = rangeRef.current;
    if (!current || current.pointerId !== event.pointerId) { return false; }
    rangeRef.current = null;
    setRange(null);
    if (current.moved && event.type !== "pointercancel") {
      const bounds = rangeBounds(current.start, current.current);
      onSelectRange?.({
        parts: document.parts.filter((part) => pointInRange({ x: part.x, y: part.y }, bounds)).map((part) => part.id),
        wires: document.wires.filter((wire) => {
          const route = wireRoutes.get(wire.id);
          return Boolean(route?.length && route.every((point) => pointInRange(point, bounds)));
        }).map((wire) => wire.id),
      }, current.additive);
    }
    // Suppress the background click emitted after pointerup, including Shift-clicks without a drag.
    draggedRef.current = true;
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
    try {
      if (current.target.hasPointerCapture(event.pointerId)) { current.target.releasePointerCapture(event.pointerId); }
    } catch { /* Pointer capture can be absent in older browsers. */ }
    return true;
  }

  function movePan(event: PointerEvent<SVGSVGElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) { return false; }
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { pan.moved = true; }
    if (pan.moved) {
      const current = cameraRef.current;
      updateCamera({ ...current, x: pan.cameraX - dx / current.zoom, y: pan.cameraY - dy / current.zoom }, true);
      draggedRef.current = true;
    }
    return true;
  }

  function finishPan(event: PointerEvent<SVGSVGElement>) {
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) { return false; }
    panRef.current = null;
    setIsPanning(false);
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
    try {
      if (pan.target.hasPointerCapture(event.pointerId)) { pan.target.releasePointerCapture(event.pointerId); }
    } catch {
      // Pointer capture can be absent in older browsers.
    }
    return true;
  }

  function trackTouchStart(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "touch") { return false; }
    touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchesRef.current.size !== 2) { return false; }
    if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
    clearDragClickTimer.current = null;
    const [first, second] = [...touchesRef.current.entries()];
    if (!first || !second) { return false; }
    const centerX = (first[1].x + second[1].x) / 2;
    const centerY = (first[1].y + second[1].y) / 2;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) { return false; }
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
    rangeRef.current = null;
    setRange(null);
    cancelDragForPinch(drag, partsById, onMoveCancel, onMovePart, onMoveEnd);
    setDrag(null);
    cancelWireRouteForPinch();
    cancelConnectionDrag(false);
    onConnectionCancel?.();
    setPointer(null);
    setConnectionTarget(null);
    draggedRef.current = true;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Unsupported capture. */ }
    return true;
  }

  function movePinch(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "touch" || !touchesRef.current.has(event.pointerId)) { return false; }
    touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (!pinch || touchesRef.current.size < 2) { return false; }
    const [first, second] = [...touchesRef.current.values()];
    if (!first || !second) { return false; }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) { return false; }
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance));
    updateCamera({
      x: pinch.worldX - ((first.x + second.x) / 2 - rect.left) / zoom,
      y: pinch.worldY - ((first.y + second.y) / 2 - rect.top) / zoom,
      zoom,
    }, true);
    return true;
  }

  function finishTouch(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "touch") { return false; }
    touchesRef.current.delete(event.pointerId);
    if (!gesturePointersRef.current.has(event.pointerId)) { return false; }
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
    if (!viewport) { return; }
    const rect = viewport.getBoundingClientRect();
    zoomAt(nextZoom, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function panBy(dx: number, dy: number) {
    const current = cameraRef.current;
    updateCamera({ ...current, x: current.x + dx / current.zoom, y: current.y + dy / current.zoom });
  }

  function moveDrag(event: PointerEvent<SVGSVGElement>) {
    if (movePinch(event)) { return; }
    if (gesturePointersRef.current.has(event.pointerId)) { return; }
    if (movePan(event)) { return; }
    if (moveRange(event)) { return; }
    if (moveConnectionDrag(event)) { return; }
    if (wireRouteDrag.move(event)) { return; }
    if (!drag || drag.pointerId !== event.pointerId) { return; }
    const next = gridAtPointer(event);
    const dx = next.x - drag.last.x;
    const dy = next.y - drag.last.y;
    if (dx === 0 && dy === 0) { return; }
    draggedRef.current = true;
    onMovePart?.(drag.id, dx, dy);
    setDrag({ ...drag, last: next });
  }

  function finishDrag(event: PointerEvent<SVGSVGElement>) {
    if (finishTouch(event)) { return; }
    if (finishRange(event)) { return; }
    if (finishPan(event)) { return; }
    if (finishConnectionDrag(event)) { return; }
    if (wireRouteDrag.finish(event)) { return; }
    if (drag?.pointerId !== event.pointerId) { return; }
    const modifierClick = modifierPartClickRef.current;
    modifierPartClickRef.current = null;
    if (event.type !== "pointercancel" && !draggedRef.current && modifierClick?.id === drag.id) {
      onSelectPart?.(drag.id, modifierClick.additive);
    }
    // Pointer capture can retarget the click following pointerup to the SVG surface.
    suppressPointerClickRef.current = true;
    setDrag(null);
    onMoveEnd?.();
    clearDragClickTimer.current = setTimeout(() => {
      draggedRef.current = false;
      suppressPointerClickRef.current = false;
      clearDragClickTimer.current = null;
    }, 0);
    try {
      if (svgRef.current?.hasPointerCapture(event.pointerId)) { svgRef.current.releasePointerCapture(event.pointerId); }
    } catch {
      // Pointer capture can be absent in older browsers.
    }
  }

  const handlePartKeyDown = useCallback((event: KeyboardEvent<SVGGElement>, part: CircuitPart) => {
    if (readOnly) { return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectPart?.(part.id, event.shiftKey || event.ctrlKey || event.metaKey);
      keyboardPartClickRef.current = part.id;
      setTimeout(() => {
        if (keyboardPartClickRef.current === part.id) { keyboardPartClickRef.current = null; }
      }, 0);
      return;
    }
    const distance = event.shiftKey ? 5 : 1;
    const movement = {
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
      ArrowUp: [0, -distance],
      ArrowDown: [0, distance],
    }[event.key];
    if (!movement) { return; }
    event.preventDefault();
    if (!selectedParts.has(part.id)) { onSelectPart?.(part.id); }
    onMovePart?.(part.id, movement[0] ?? 0, movement[1] ?? 0);
    onMoveEnd?.();
  }, [readOnly, onSelectPart, onMovePart, onMoveEnd, selectedParts]);

  // Viewport changes do not alter the circuit. Retain its SVG tree across pan/zoom frames.
  const artwork = useMemo(() => (
    <>
        <g {...circuitSlot("circuit-board__wires", slotProps?.wires)}>
          {document.wires.map((wire) => {
            const from = partsById.get(wire.from.partId);
            const to = partsById.get(wire.to.partId);
            if (!from || !to) { return null; }
            const route = wireRoutes.get(wire.id);
            if (!route) { return null; }
            const d = pathData(route);
            const isSelected = selectedWires.has(wire.id);
            const current = wireFlowCurrent(analysis, wire.id, showFlow);
            const fromName = endpointName(from, wire.from.terminal);
            const toName = endpointName(to, wire.to.terminal);
            return (
              <g
                key={wire.id}
                {...circuitSlot(`circuit-board__wire${isSelected ? " circuit-board__wire--selected" : ""}`, slotProps?.wire)}
                data-wire-id={wire.id}
                data-selected={isSelected}
                data-reconnecting={pendingWire?.wireId === wire.id}
                data-route-editable={canEditWireRoute}
                data-route-dragging={wireRouteDrag.draggingWireId === wire.id}
                role={readOnly ? "img" : "button"}
                tabIndex={readOnly ? undefined : 0}
                aria-label={`${fromName} と ${toName} をつなぐ導線${wireFlowLabel(current, fromName, toName, flowDisplay)}`}
                aria-pressed={readOnly ? undefined : isSelected}
                onPointerDown={(event) => wireRouteDrag.start(event, wire.id)}
                onClick={(event) => {
                  if (readOnly) { return; }
                  event.stopPropagation();
                  chooseWire(wire.id, event);
                }}
                onKeyDown={(event) => {
                  if (readOnly) { return; }
                  if (event.key !== "Enter" && event.key !== " ") { return; }
                  event.preventDefault();
                  event.stopPropagation();
                  keyboardWireClickRef.current = wire.id;
                  setTimeout(() => {
                    if (keyboardWireClickRef.current === wire.id) { keyboardWireClickRef.current = null; }
                  }, 0);
                  chooseWire(wire.id, undefined, event.shiftKey || event.ctrlKey || event.metaKey);
                }}
              >
                <title>{wireTitle(fromName, toName, canEditWireRoute)}</title>
                <path {...circuitSlot("circuit-board__wire-hit", slotProps?.wireHit)} d={d} />
                <path {...circuitSlot("circuit-board__wire-line", slotProps?.wireLine)} d={d} />
                {showFlow && <CircuitWireFlow route={route} current={current} display={flowDisplay} slotProps={slotProps} />}
              </g>
            );
          })}
        </g>

        <g {...circuitSlot("circuit-board__parts", slotProps?.parts)}>
          {document.parts.map((part) => (
            <CircuitPartArtwork
              key={part.id}
              part={part}
              isSelected={selectedParts.has(part.id)}
              isDragging={drag?.id === part.id}
              readOnly={readOnly}
              onSwitchToggle={onSwitchToggle}
              onInspectPart={onInspectPart}
              onSelectPart={onSelectPart}
              onPointerClick={handlePartPointerClick}
              onPointerDown={startDrag}
              onKeyDown={(event, selectedPart) => keyDownOnCircuitPart(
                event,
                selectedPart,
                readOnly,
                onSwitchToggle,
                handlePartKeyDown,
              )}
              renderPart={renderPart}
              analysis={analysis}
              slotProps={slotProps}
            />
          ))}
        </g>

        <g {...circuitSlot("circuit-board__terminals", slotProps?.terminals)}>
          {document.parts.flatMap((part) =>
            terminalsOf(part.kind).map((terminal: CircuitTerminal) => {
              const endpoint = { partId: part.id, terminal };
              const pending = !readOnly && pendingEndpoint !== undefined && pendingEndpoint !== null && endpointKey(pendingEndpoint) === endpointKey(endpoint);
              const connected = connectedTerminals.has(endpointKey(endpoint));
              return <CircuitTerminalArtwork
                key={endpointKey(endpoint)}
                part={part}
                terminal={terminal}
                pending={pending}
                connected={connected}
                selected={selectedParts.has(part.id)}
                readOnly={readOnly}
                onSelectPart={onSelectPart}
                onTerminalClick={chooseTerminal}
                onPointerDown={startConnectionDrag}
                slotProps={slotProps}
              />;
            }),
          )}
        </g>
    </>
  ), [analysis, showFlow, flowDisplay, connectedTerminals, document.parts, document.wires, drag?.id, handlePartKeyDown, handlePartPointerClick, onSwitchToggle, readOnly,
    onSelectPart, onInspectPart, chooseWire, chooseTerminal, pendingEndpoint, pendingWire, partsById, renderPart,
    selectedParts, selectedWires, slotProps, startDrag, startConnectionDrag, wireRoutes,
    canEditWireRoute, wireRouteDrag.start, wireRouteDrag.draggingWireId]);
  const labelSizes = cameraLabelSizes(camera.zoom);
  const previewEnd = connectionPreviewEnd(partsById, connectionTarget, pointer);

  const controls: CircuitBoardControls = {
    zoom: camera.zoom,
    showGrid,
    canZoomIn: camera.zoom < MAX_ZOOM,
    canZoomOut: camera.zoom > MIN_ZOOM,
    setShowGrid,
    zoomIn: () => changeZoom(cameraRef.current.zoom * 1.25),
    zoomOut: () => changeZoom(cameraRef.current.zoom / 1.25),
    resetZoom: () => changeZoom(1),
    fit: () => updateCamera(fitCamera(document, size.width, size.height)),
  };
  const wasDragged = (): boolean => draggedRef.current;
  const visualControls = <>
    {showFlow && <CircuitFlowLegend analysis={analysis} hasFlow={hasFlow} display={flowDisplay} onDisplayChange={setFlowDisplay} paused={flowPaused} onTogglePause={() => setFlowPaused((paused) => !paused)} slotProps={slotProps} />}
    <CircuitPotentialControls visible={showPotentials} view={potentialView} timeSeconds={analysis?.timeSeconds} />
  </>;

  return (
    <section aria-label={`${document.title} 回路基板`} {...rootProps} {...circuitSlot(["circuit-board", className].filter(Boolean).join(" "), slotProps?.root, style)} data-read-only={readOnly} data-switch-interactive={readOnly && Boolean(onSwitchToggle)} data-show-flow={showFlow} data-flow-display={flowDisplay} data-flow-paused={flowPaused}>
      <BoardDisplaySettings compact={compactControls} showFlow={showFlow} showPotentials={showPotentials}>{visualControls}</BoardDisplaySettings>
      {renderControls === undefined ? (
        <div {...circuitSlot("circuit-board__chrome", slotProps?.chrome)}>
          <div {...circuitSlot("circuit-board__controls", slotProps?.controls)} role="group" aria-label="キャンバス表示操作">
            <button {...circuitSlot("circuit-board__grid-toggle", slotProps?.gridButton)} type="button" onClick={() => setShowGrid((visible) => !visible)} aria-label="グリッドを表示" aria-pressed={showGrid} title="グリッドを表示 / 非表示"><CircuitIcon name="grid" /></button>
            <span {...circuitSlot("circuit-board__control-divider", slotProps?.controlDivider)} />
            <button {...circuitSlot("circuit-board__zoom-out", slotProps?.zoomOutButton)} type="button" onClick={controls.zoomOut} disabled={!controls.canZoomOut} aria-label="縮小" title="縮小"><CircuitIcon name="minus" /></button>
            <button {...circuitSlot("circuit-board__zoom-reset", slotProps?.zoomResetButton)} type="button" onClick={controls.resetZoom} aria-label="拡大率を100%に戻す" title="100%で表示"><output {...circuitSlot("circuit-board__zoom-output", slotProps?.zoomOutput)} aria-label="拡大率">{Math.round(camera.zoom * 100)}%</output></button>
            <button {...circuitSlot("circuit-board__zoom-in", slotProps?.zoomInButton)} type="button" onClick={controls.zoomIn} disabled={!controls.canZoomIn} aria-label="拡大" title="拡大"><CircuitIcon name="plus" /></button>
            <span {...circuitSlot("circuit-board__control-divider", slotProps?.controlDivider)} />
            <button {...circuitSlot("circuit-board__fit", slotProps?.fitButton)} type="button" onClick={controls.fit} aria-label="回路全体を表示" title="回路全体を表示"><CircuitIcon name="fit" /></button>
          </div>
        </div>
      ) : renderControls?.(controls)}
      <div
        ref={viewportRef}
        {...circuitSlot("circuit-board__viewport", slotProps?.viewport)}
        role="application"
        tabIndex={0}
        aria-label="回路基板。余白またはスペースキーを押しながらドラッグして移動し、Shiftを押しながら余白をドラッグして範囲選択できます"
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") { return; }
          if (wireRouteDrag.cancel()) {
            event.preventDefault();
            event.stopPropagation();
          }
          cancelConnectionDrag();
          onConnectionCancel?.();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) { return; }
          const movement = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }[event.key];
          if (!movement) { return; }
          event.preventDefault();
          panBy(movement[0] ?? 0, movement[1] ?? 0);
        }}
      >
      <svg
        ref={svgRef}
        {...circuitSlot(
          `circuit-board__surface${spacePressed || panMode || readOnly ? " circuit-board__surface--pan-ready" : ""}${isPanning ? " circuit-board__surface--panning" : ""}${pendingEndpoint && !readOnly ? " circuit-board__surface--connecting" : ""}`,
          slotProps?.surface,
          {
            "--circuit-board-label-size": `${labelSizes.label}px`,
            "--circuit-board-detail-size": `${labelSizes.detail}px`,
            "--circuit-board-flow-scale": Math.max(1, Math.min(3, 1 / camera.zoom)),
          },
        )}
        data-panning={isPanning}
        data-connecting={Boolean(pendingEndpoint && !readOnly)}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`${camera.x} ${camera.y} ${size.width / camera.zoom} ${size.height / camera.zoom}`}
        width={size.width}
        height={size.height}
        role="group"
        aria-label={readOnly ? `${document.title}。ドラッグして表示位置を移動できます。` : `${document.title}。部品をドラッグして移動できます。`}
        onPointerDown={(event) => {
          const target = event.target;
          if (target instanceof SVGElement && target.hasAttribute("data-circuit-board-background")) { startPan(event); }
        }}
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof SVGElement) || !target.hasAttribute("data-circuit-board-background")) { return; }
          if (!wasDragged() && !panMode && !readOnly && !spacePressedRef.current) {
            const destination: ConnectionTarget = pendingEndpoint ? targetAtPointer(event) : { point: gridAtPointer(event) };
            if (destination.endpoint) { onTerminalClick?.(destination.endpoint); }
            else { onBoardClick?.(destination.point); }
          }
        }}
        onPointerEnter={() => { pointerInsideRef.current = true; }}
        onPointerLeave={() => { pointerInsideRef.current = false; setPointer(null); setConnectionTarget(null); }}
        onPointerDownCapture={(event) => {
          if (!connectionDragRef.current && gesturePointersRef.current.size === 0) {
            draggedRef.current = false;
            if (clearDragClickTimer.current !== null) { clearTimeout(clearDragClickTimer.current); }
            clearDragClickTimer.current = null;
          }
          if (trackTouchStart(event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const isBackground = event.target instanceof SVGElement && event.target.hasAttribute("data-circuit-board-background");
          if (!readOnly && !panMode && !pendingEndpoint && !spacePressedRef.current && event.button === 0 && event.shiftKey && isBackground) {
            event.preventDefault();
            event.stopPropagation();
            modifierPartClickRef.current = null;
            startRange(event);
            return;
          }
          if (isPreviewPartGesture(event, readOnly, onInspectPart, onSwitchToggle, spacePressedRef.current)) { return; }
          if (event.button !== 1 && !spacePressedRef.current && !panMode && !readOnly) { return; }
          event.preventDefault();
          event.stopPropagation();
          startPan(event);
        }}
        onPointerMove={(event) => {
          moveDrag(event);
          if (pendingEndpoint && !panMode && !readOnly && !panRef.current && !pinchRef.current) {
            const target = targetAtPointer(event);
            setPointer(target.point);
            setConnectionTarget(target);
          }
        }}
        onPointerUp={finishDrag}
        onPointerCancel={(event) => {
          cancelConnectionDrag();
          finishDrag(event);
        }}
        onLostPointerCapture={(event) => {
          wireRouteDrag.cancel(event.pointerId, false);
          if (connectionDragRef.current?.pointerId === event.pointerId) { cancelConnectionDrag(); }
        }}
        onClickCapture={(event) => {
          if (suppressPointerClickRef.current) {
            suppressPointerClickRef.current = false;
            draggedRef.current = false;
            event.preventDefault();
            event.stopPropagation();
            if (clearDragClickTimer.current !== null) {
              clearTimeout(clearDragClickTimer.current);
              clearDragClickTimer.current = null;
            }
            return;
          }
          if (!wasDragged()) { return; }
          draggedRef.current = false;
          modifierPartClickRef.current = null;
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
            <circle cx={GRID / 2} cy={GRID / 2} r="0.8" {...circuitSlot("circuit-board__minor-grid", slotProps?.minorGrid)} />
          </pattern>
          <pattern id={majorGridId} width={GRID * 5} height={GRID * 5} patternUnits="userSpaceOnUse">
            <rect width={GRID * 5} height={GRID * 5} fill={`url(#${smallGridId})`} />
          </pattern>
        </defs>
        <g
          {...circuitSlot("circuit-board__background", slotProps?.background)}
        >
          <rect {...circuitSlot("circuit-board__paper", slotProps?.paper)} data-circuit-board-background="true" x={camera.x} y={camera.y} width={size.width / camera.zoom} height={size.height / camera.zoom} />
          {showGrid && <rect {...circuitSlot("circuit-board__grid", slotProps?.grid)} data-circuit-board-background="true" x={camera.x} y={camera.y} width={size.width / camera.zoom} height={size.height / camera.zoom} fill={`url(#${majorGridId})`} />}
        </g>

        {pendingPart && pendingEndpoint && pointer && <path {...circuitSlot("circuit-board__connection-preview", slotProps?.connectionPreview)} d={pathData(routeWire(routeEnd(pendingPart, pendingEndpoint.terminal), previewEnd, [...wireRoutes].filter(([id]) => id !== pendingWire?.wireId).map(([, route]) => route)))} />}

        {artwork}
        <CircuitPotentialOverlay visible={showPotentials} document={document} routes={wireRoutes} view={potentialView} />
        <CircuitWireSegmentHandles
          enabled={canEditWireRoute}
          document={document}
          routes={wireRoutes}
          selected={selectedWires}
          scale={Math.max(1, Math.min(3, 1 / camera.zoom))}
          onStart={wireRouteDrag.start}
          onKeyDown={wireRouteDrag.keyDown}
          slotProps={slotProps}
        />
        {range?.moved && (() => {
          const bounds = rangeBounds(range.start, range.current);
          return <rect
            {...circuitSlot("circuit-board__selection-rect", slotProps?.selectionRect)}
            data-selection-rect="true"
            x={bounds.left * GRID}
            y={bounds.top * GRID}
            width={(bounds.right - bounds.left) * GRID}
            height={(bounds.bottom - bounds.top) * GRID}
          />;
        })()}
        {!readOnly && !panMode && !pendingEndpoint && onReconnectStart && document.wires.filter((wire) => selectedWires.has(wire.id)).flatMap((wire) =>
          (["from", "to"] as const).map((end) => {
            const endpoint = wire[end];
            const part = partsById.get(endpoint.partId);
            if (!part) { return null; }
            const point = terminalPoint(part, endpoint.terminal);
            const label = `${endpointName(part, endpoint.terminal)}の接続をつなぎ替え`;
            return (
              <g
                key={`${wire.id}:${end}`}
                {...circuitSlot("circuit-board__wire-handle", slotProps?.wireHandle)}
                data-wire-id={wire.id}
                data-wire-handle={end}
                transform={`translate(${point.x * GRID} ${point.y * GRID})`}
                role="button"
                tabIndex={0}
                aria-label={label}
                onPointerDown={(event) => startConnectionDrag(event, endpoint, { wireId: wire.id, end })}
                onClick={(event) => {
                  event.stopPropagation();
                  beginReconnect(wire.id, end);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") { return; }
                  event.preventDefault();
                  event.stopPropagation();
                  beginReconnect(wire.id, end);
                }}
              >
                <title>{`${label}：ドラッグ、またはクリックして接続先を選択`}</title>
                <circle {...circuitSlot("circuit-board__wire-handle-hit", slotProps?.wireHandleHit)} r="13" />
                <circle {...circuitSlot("circuit-board__wire-handle-dot", slotProps?.wireHandleDot)} r="6" />
              </g>
            );
          }),
        )}
        {!readOnly && pendingEndpoint && connectionTarget && (connectionTarget.endpoint || connectionTarget.wireId) && (
          <circle
            {...circuitSlot("circuit-board__connection-target", slotProps?.connectionTarget)}
            cx={connectionTarget.point.x * GRID}
            cy={connectionTarget.point.y * GRID}
            r={10 / camera.zoom}
          />
        )}
      </svg>
      </div>
    </section>
  );
}
