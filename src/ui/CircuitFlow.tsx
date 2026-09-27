import { useEffect, useId, useMemo, useRef } from "react";
import { GRID, type Point } from "../circuit-geometry.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import type { CircuitBoardSlotProps } from "./CircuitBoard.js";
import { circuitSlot } from "./style-props.js";
import { createFlowPath, flowArrowPath } from "./flow-geometry.js";

type FlowKind = "current" | "electron";
export type FlowDisplay = FlowKind | "both";

const flowDisplayOptions = [
  { value: "current", label: "電流のみ" },
  { value: "electron", label: "電子のみ" },
  { value: "both", label: "両方" },
] as const;

/** Unsolved circuits must never suggest that their numerical readings are a valid flow. */
export function wireFlowCurrent(analysis: CircuitAnalysis | undefined, wireId: string, enabled = true) {
  const current = analysis?.wireCurrents[wireId];
  return enabled && analysis?.status === "closed" && current !== undefined && Number.isFinite(current) ? current : 0;
}

export function wireFlowLabel(current: number, from: string, to: string, display: FlowDisplay = "both") {
  if (current === 0) { return ""; }
  const source = current > 0 ? from : to;
  const destination = current > 0 ? to : from;
  if (display === "current") { return `。電流は${source}から${destination}へ流れます`; }
  if (display === "electron") { return `。電子は${destination}から${source}へ流れます`; }
  return `。電流は${source}から${destination}へ、電子はその逆向きに流れます`;
}

function FlowGlyph({ kind, arrowPath }: { kind: FlowKind; arrowPath?: string }) {
  return kind === "current" ? (
    <path className="circuit-board__current-arrow" d={arrowPath ?? "M -8 -8 H -1 V -11 L 6 -6 L -1 -1 V -4 H -8 Z"} />
  ) : (
    <>
      <circle className="circuit-board__electron" cx="-3" cy="-6" r="4" />
      <path className="circuit-board__electron-minus" d="M -5 -6 H -1" />
      <path className="circuit-board__electron-arrow" d="M 4 -9 L 7 -6 L 4 -3" />
    </>
  );
}

/** Use the CSS motion clock so bending also respects pause and reduced-motion styles. */
function useFlowArrowShape(kind: FlowKind, path: ReturnType<typeof createFlowPath>) {
  const trackRef = useRef<SVGGElement>(null);
  useEffect(() => {
    const track = trackRef.current;
    if (kind !== "current" || !track || typeof requestAnimationFrame === "undefined") { return; }
    const particles = Array.from(track.querySelectorAll<SVGGElement>(".circuit-board__flow-particle")).map((particle) => ({
      particle,
      arrow: particle.querySelector<SVGPathElement>(".circuit-board__current-arrow"),
      previousDistance: Number.NaN,
      previousScale: Number.NaN,
    }));
    let frame = 0;
    const update = () => {
      const scaleValue = Number.parseFloat(getComputedStyle(track).getPropertyValue("--circuit-board-flow-scale"));
      const scale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1;
      // Read all motion positions before writing SVG geometry to avoid layout thrashing.
      const distances = particles.map(({ particle }) => {
        const offset = getComputedStyle(particle).offsetDistance;
        const value = Number.parseFloat(offset);
        return offset.endsWith("%") ? path.length * value / 100 : value;
      });
      for (const [index, state] of particles.entries()) {
        const distance = distances[index];
        if (!state.arrow || !Number.isFinite(distance)) { continue; }
        if (distance === state.previousDistance && scale === state.previousScale) { continue; }
        state.arrow.setAttribute("d", flowArrowPath(path, distance, scale));
        state.previousDistance = distance;
        state.previousScale = scale;
      }
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [kind, path]);
  return trackRef;
}

function FlowTrack({
  kind,
  route,
  forward,
  length,
  slotProps,
}: {
  kind: FlowKind;
  route: readonly Point[];
  forward: boolean;
  length: number;
  slotProps?: CircuitBoardSlotProps;
}) {
  const path = useMemo(() => createFlowPath(forward ? route : [...route].reverse()), [route, forward]);
  const trackRef = useFlowArrowShape(kind, path);
  const count = Math.min(48, Math.max(1, Math.ceil(length / 64)));
  // A fixed illustrative speed keeps direction legible; it is not electron drift velocity.
  const duration = length / 40;
  const offsets = Array.from({ length: count }, (_, index) => (index + 0.5) / count);
  return (
    <g ref={trackRef} {...circuitSlot("circuit-board__flow", slotProps?.flow)} data-flow={kind} data-direction={forward ? "forward" : "reverse"}>
      {offsets.map((offset) => (
        <g
          key={offset}
          {...circuitSlot("circuit-board__flow-particle", slotProps?.flowParticle, {
            offsetPath: `path('${path.data}')`,
            offsetDistance: `${offset * 100}%`,
            animationDuration: `${duration}s`,
            animationDelay: `${-offset * duration}s`,
          })}
        >
          <g className="circuit-board__flow-glyph"><FlowGlyph kind={kind} arrowPath={kind === "current" ? flowArrowPath(path, offset * path.length) : undefined} /></g>
        </g>
      ))}
    </g>
  );
}

export function CircuitWireFlow({ route, current, display, slotProps }: {
  route: readonly Point[];
  current: number;
  display: FlowDisplay;
  slotProps?: CircuitBoardSlotProps;
}) {
  const length = route.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x - route[index].x, point.y - route[index].y) * GRID, 0);
  if (!Number.isFinite(current) || current === 0 || !Number.isFinite(length) || length <= 0) { return null; }
  return <g pointerEvents="none">
    {display !== "electron" && <FlowTrack kind="current" route={route} forward={current > 0} length={length} slotProps={slotProps} />}
    {display !== "current" && <FlowTrack kind="electron" route={route} forward={current < 0} length={length} slotProps={slotProps} />}
  </g>;
}

function flowStatus(analysis: CircuitAnalysis | undefined, hasFlow: boolean) {
  if (!analysis) { return "解析結果がないため、流れを表示できません。"; }
  if (analysis.status === "invalid" || analysis.status === "short") { return "回路を確認してください。流れの表示を停止しています。"; }
  if (Object.keys(analysis.wireCurrents).length === 0) {
    return analysis.mode === "ac"
      ? "交流解析では導線電流を算出していないため、方向表示はありません。"
      : "導線電流が未計算のため、方向表示はありません。";
  }
  return hasFlow ? "導線上の向きを表示しています。速さ・粒の数は模式的です。" : "電流・電子は流れていません。";
}

export function CircuitFlowLegend({ analysis, hasFlow, display, onDisplayChange, paused, onTogglePause, slotProps }: {
  analysis?: CircuitAnalysis;
  hasFlow: boolean;
  display: FlowDisplay;
  onDisplayChange: (display: FlowDisplay) => void;
  paused: boolean;
  onTogglePause: () => void;
  slotProps?: CircuitBoardSlotProps;
}) {
  const displayName = useId();
  return (
    <section {...circuitSlot("circuit-board__flow-legend", slotProps?.flowLegend)} aria-label="電流と電子の流れ">
      <fieldset {...circuitSlot("circuit-board__flow-display", slotProps?.flowDisplayControl)}>
        <legend>表示する向き</legend>
        <div className="circuit-board__flow-display-options">
          {flowDisplayOptions.map((option) => (
            <label
              key={option.value}
              {...circuitSlot("circuit-board__flow-display-option", slotProps?.flowDisplayOption)}
              data-selected={display === option.value}
            >
              <input
                type="radio"
                name={displayName}
                value={option.value}
                checked={display === option.value}
                onChange={() => onDisplayChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="circuit-board__flow-keys">
        {display !== "electron" && <span {...circuitSlot("circuit-board__flow-key", slotProps?.flowKey)} data-flow="current">
          <svg width="28" height="18" viewBox="-14 -15 28 18" aria-hidden="true"><FlowGlyph kind="current" /></svg>
          電流
        </span>}
        {display !== "current" && <span {...circuitSlot("circuit-board__flow-key", slotProps?.flowKey)} data-flow="electron">
          <svg width="28" height="18" viewBox="-14 -15 28 18" aria-hidden="true"><g transform="rotate(180 0 -6)"><FlowGlyph kind="electron" /></g></svg>
          電子
        </span>}
        {display === "both" && <span className="circuit-board__flow-explanation">電子は電流と逆向き</span>}
      </div>
      <button
        {...circuitSlot("circuit-board__flow-pause", slotProps?.flowPauseButton)}
        type="button"
        aria-label={`流れのアニメーションを${paused ? "再生" : "一時停止"}`}
        aria-pressed={paused}
        disabled={!hasFlow}
        onClick={onTogglePause}
      >
        {paused ? "動きを再生" : "動きを一時停止"}
      </button>
      <p {...circuitSlot("circuit-board__flow-note", slotProps?.flowNote)} role="status">{flowStatus(analysis, hasFlow)}</p>
    </section>
  );
}
