import { useId, useMemo, useState } from "react";
import { complex, complexAdd, complexDivide, complexFromPolar, complexMagnitude, complexMultiply, complexPhaseDegrees, type ComplexValue } from "../analog-math.js";
import { GRID, pathData, terminalPoint, type Point } from "../circuit-geometry.js";
import type { CircuitDocument } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { circuitEndpointKey, circuitNodes, circuitPotential, circuitPotentialColor, defaultReferenceNode, formatCircuitQuantity, type CircuitNodeCurrent } from "../circuit-visualization.js";
import { NumericInput } from "./NumericInput.js";
import { readOptionalPrecision, restoredReadingComplex } from "../circuit-reading.js";

export function useCircuitPotentialView(document: CircuitDocument, analysis?: CircuitAnalysis, available = true) {
  const [enabled, setEnabled] = useState(false);
  const [referenceId, setReferenceId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [scale, setScale] = useState(10);
  // Documents and transported analyses can be edited in place. Refresh their
  // derived readings and connectivity even when their object identities match.
  const nodes = available && analysis ? circuitNodes(document, analysis) : [];
  const defaultReference = defaultReferenceNode(document, nodes);
  const reference = nodes.find((node) => node.id === referenceId) ?? defaultReference;
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes.find((node) => node.currents.length > 2 && node.id !== defaultReference?.id) ?? nodes.find((node) => node.id !== defaultReference?.id) ?? defaultReference;
  const ac = analysis?.mode === "ac";
  // Keep the context stable so precise path caches survive view-only changes.
  // Their input snapshots rebuild connectivity when mutable input data changes.
  const potentialContext = useMemo(() => analysis ? { document, analysis } : undefined, [document, analysis]);
  const potential = circuitPotential(selected, reference, ac, potentialContext);
  const byEndpoint = new Map(nodes.flatMap((node) => node.endpoints.map((endpoint) => [circuitEndpointKey(endpoint), node] as const)));
  return { enabled, setEnabled, scale, setScale, nodes, reference, selected, setReferenceId, setSelectedId, ac, potential, potentialContext, byEndpoint };
}

type PotentialView = ReturnType<typeof useCircuitPotentialView>;

function negativeCurrent(value: ComplexValue) {
  return Math.abs(complexPhaseDegrees(value)) > 90;
}

function potentialHasPhase(potential: PotentialView["potential"], ac: boolean, expressions?: CircuitAnalysis["precisionExpressions"]) {
  if (!ac || !potential) { return false; }
  if (potential.volts !== 0) { return true; }
  const retained = restoredReadingComplex(readOptionalPrecision(() => potential.exactVoltage), potential.volts, potential.phaseDegrees, true, expressions);
  return Boolean(retained && complexMagnitude(complexDivide(retained, retained)) === 1);
}

function CurrentRow({ entry, value, nonzero, ac, scale }: { entry: CircuitNodeCurrent; value: ComplexValue; nonzero: boolean; ac: boolean; scale: ComplexValue | undefined }) {
  const negative = negativeCurrent(value);
  const path = ac ? "M6 10H58M6 10l6 -5M6 10l6 5M58 10l-6 -5M58 10l-6 5"
    : negative ? "M58 10H6l7 -5M6 10l7 5" : "M6 10H58l-7 -5M58 10l-7 5";
  const direction = ac || !nonzero ? "" : negative ? "← " : "→ ";
  const relative = nonzero && scale ? complexMultiply(complex(4), complexDivide(value, scale)) : undefined;
  // Keep physical currents exact through division. AC magnitude needs a square
  // root at this SVG boundary: its 0–4 px projection and the 1 px base introduce
  // at most a few binary64 ulps (below 2e-15 px), never feedback into the circuit.
  const magnitude = relative && (ac ? complex(complexMagnitude(relative))
    : complexMultiply(relative, complex(negativeCurrent(relative) ? -1 : 1)));
  const width = magnitude ? Math.min(5, complexAdd(complex(1), magnitude).real) : 0;
  return <li>
    <span>{entry.label}</span>
    <svg viewBox="0 0 64 20" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth={width} /></svg>
    <strong>{direction}{formatCircuitQuantity(Math.abs(entry.amps), "A")}{ac && nonzero ? ` ∠${Number((entry.phaseDegrees ?? 0).toFixed(1))}°` : ""}</strong>
  </li>;
}

function PotentialDetails({ view }: { view: PotentialView }) {
  const id = useId();
  const { nodes, reference, selected, potential, ac } = view;
  const expressions = readOptionalPrecision(() => view.potentialContext?.analysis.precisionExpressions);
  const hasPotentialPhase = potentialHasPhase(potential, ac, expressions);
  const currents = (selected?.currents ?? []).map((entry) => {
    const value = restoredReadingComplex(readOptionalPrecision(() => entry.exactCurrent), entry.amps, entry.phaseDegrees, ac, expressions)
      ?? complexFromPolar(entry.amps, entry.phaseDegrees ?? 0);
    // Self-division distinguishes an exact nonzero current whose scalar is 0.
    return { entry, value, nonzero: complexMagnitude(complexDivide(value, value)) === 1 };
  });
  let currentScale: ComplexValue | undefined;
  for (const current of currents) {
    if (current.nonzero && (!currentScale || complexMagnitude(complexDivide(current.value, currentScale)) > 1)) {
      currentScale = current.value;
    }
  }
  if (nodes.length === 0) { return <p>回路を接続して解析できる状態にすると表示されます。</p>; }
  return <>
    <p>{ac ? "交流の色と数値は実効値です。位相を含めて2点の差を計算します。" : "同じ導線でつながる点は同じ電位です。基準点を0 Vとして表示します。"}</p>
    <div className="circuit-potential__fields">
      <label htmlFor={`${id}-reference`}>基準点（黒プローブ）</label>
      <select id={`${id}-reference`} value={reference?.id ?? ""} onChange={(event) => view.setReferenceId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
      <label htmlFor={`${id}-selected`}>測定点（赤プローブ）</label>
      <select id={`${id}-selected`} value={selected?.id ?? ""} onChange={(event) => view.setSelectedId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
      <label htmlFor={`${id}-scale`}>色の上限 (V)</label>
      <NumericInput id={`${id}-scale`} min={0} exclusiveMin step="any" value={view.scale} onValueChange={view.setScale} />
    </div>
    <output className="circuit-potential__difference" aria-live="polite">測定点 − 基準点：{potential ? `${formatCircuitQuantity(potential.volts, "V")}${hasPotentialPhase ? ` ∠${Number(potential.phaseDegrees.toFixed(1))}°` : ""}` : "基準を共有しないため測定できません"}</output>
    <section className="circuit-potential__legend" aria-label="電位の色の凡例">
      {(ac ? [0, 0.5, 1] : [-1, 0, 1]).map((fraction) => {
        const value = fraction * view.scale;
        // The stop already specifies the exact relative color. Round its voltage
        // only for the label, so subnormal scales do not shift the middle stop.
        return <span key={fraction}><i style={{ backgroundColor: circuitPotentialColor(fraction, 1) }} />{formatCircuitQuantity(value, "V")}</span>;
      })}
    </section>
    <p>色の尺度は固定です。上限を超えた値は同じ色になり、数値で確認できます。基準を共有しない部分は着色しません。</p>
    <h3>測定点につながる電流</h3>
    <p>{ac ? "矢印の太さは実効値、角度は位相です。電流の和は位相を含めて計算します。" : "← は部品から測定点へ流入、→ は測定点から部品へ流出。太さは電流の大きさです。"}</p>
    <ul className="circuit-potential__currents">{currents.map(({ entry, value, nonzero }) => <CurrentRow key={circuitEndpointKey(entry.endpoint)} entry={entry} value={value} nonzero={nonzero} ac={ac} scale={currentScale} />)}</ul>
    <output>流入・流出の差{ac ? "（位相を含む）" : ""}：{formatCircuitQuantity(selected?.currentResidualAmps, "A")}</output>
    {selected?.currentBalanceNote && <p>{selected.currentBalanceNote}</p>}
    <p>差がほぼ0なら流入と流出がつり合っています。導線のループ内の電流は推測せず、各部品の端子で計算した電流を表示します。</p>
  </>;
}

export function CircuitPotentialControls({ view, timeSeconds, visible = true }: { view: PotentialView; timeSeconds?: number; visible?: boolean }) {
  if (!visible) { return null; }
  return <section className="circuit-potential" aria-label="電位と電流の可視化">
    <label className="circuit-potential__toggle"><input type="checkbox" checked={view.enabled} onChange={(event) => view.setEnabled(event.target.checked)} />電位を色で表示</label>
    {timeSeconds !== undefined && <output className="circuit-potential__time">時刻 {formatCircuitQuantity(timeSeconds, "s")} · 瞬時値</output>}
    <details><summary>電位差・電流の分配</summary><PotentialDetails view={view} /></details>
  </section>;
}

export function CircuitPotentialOverlay({ document, routes, drawingOrigin = { x: 0, y: 0 }, view, visible = true }: { document: CircuitDocument; routes: Map<string, Point[]>; drawingOrigin?: Point; view: PotentialView; visible?: boolean }) {
  if (!visible || !view.enabled) { return null; }
  const expressions = readOptionalPrecision(() => view.potentialContext?.analysis.precisionExpressions);
  return <g className="circuit-potential-overlay" pointerEvents="none">
    {document.wires.map((wire) => {
      const node = view.byEndpoint.get(circuitEndpointKey(wire.from));
      const value = circuitPotential(node, view.reference, view.ac, view.potentialContext);
      const route = routes.get(wire.id);
      return value && route ? <path key={wire.id} data-potential-wire={wire.id} data-voltage={value.volts} d={pathData(route)} fill="none" stroke={circuitPotentialColor(value, view.scale, view.ac, expressions)} strokeWidth="5" opacity="0.8" /> : null;
    })}
    {view.nodes.flatMap((node) => node.endpoints.map((endpoint) => {
      const part = document.parts.find((item) => item.id === endpoint.partId);
      const value = circuitPotential(node, view.reference, view.ac, view.potentialContext);
      if (!part || !value) { return null; }
      const point = terminalPoint(part, endpoint.terminal);
      const selected = node.id === view.selected?.id;
      const reference = node.id === view.reference?.id;
      return <g key={circuitEndpointKey(endpoint)} data-potential-terminal={circuitEndpointKey(endpoint)} transform={`translate(${(point.x - drawingOrigin.x) * GRID} ${(point.y - drawingOrigin.y) * GRID})`}>
        <circle r="8" fill={circuitPotentialColor(value, view.scale, view.ac, expressions)} opacity="0.8" />
        {(selected || reference) && <circle r="12" fill="none" stroke={reference ? "#303944" : "#c54336"} strokeWidth="2" strokeDasharray={reference ? "3 2" : undefined} />}
        <text y="-17" textAnchor="middle">{formatCircuitQuantity(value.volts, "V")}</text>
      </g>;
    }))}
  </g>;
}
