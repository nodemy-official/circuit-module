import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type Dispatch, type SetStateAction } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import type { CircuitTransientFrame } from "../circuit-visualization.js";
import { simulateTransient, type TransientAnalysis, type TransientSample } from "../transient-solver.js";
import { measurementLabels } from "./measurement-labels.js";

const format = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? "—" : Number(value.toPrecision(4)).toString();
const MAX_WAVEFORM_PARTS = 3;
const PLAYBACK_INTERVAL_MS = 50;
type ValidTransientAnalysis = TransientAnalysis & { status: "valid" };

type Quantity = "voltageVolts" | "currentAmps";
type WaveformPart = CircuitDocument["parts"][number];
interface TransientResult {
  document: CircuitDocument;
  baselineDocument?: CircuitDocument;
  analysis: TransientAnalysis;
  baselineAnalysis?: TransientAnalysis;
}

function defaultPartIds(parts: readonly WaveformPart[]) {
  const storage = parts.filter((part) => part.kind === "capacitor" || part.kind === "inductor");
  const resistive = parts.filter((part) => part.kind === "resistor" || part.kind === "bulb" || part.kind === "potentiometer");
  const remaining = parts.filter((part) => !storage.includes(part) && !resistive.includes(part));
  return [...storage, ...resistive, ...remaining].slice(0, MAX_WAVEFORM_PARTS).map((part) => part.id);
}

function canPlayTransient(active: boolean, playing: boolean, analysis: TransientAnalysis | null): analysis is ValidTransientAnalysis {
  return active && playing && analysis?.status === "valid" && analysis.samples.length > 1;
}

function useStopPlaybackWhenInactive(
  active: boolean,
  analysis: TransientAnalysis | null,
  setPlaying: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!active || analysis?.status !== "valid") { setPlaying(false); }
  }, [active, analysis, setPlaying]);
}

function valuesFor(samples: readonly TransientSample[], partId: string, quantity: Quantity) {
  return samples.map((sample) => sample.parts[partId]?.[quantity]);
}

function lineSegments(samples: readonly TransientSample[], values: readonly (number | undefined)[], x: (time: number) => number, y: (value: number) => number) {
  return samples.reduce<string[][]>((segments, sample, index) => {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      if (segments.at(-1)?.length) { segments.push([]); }
      return segments;
    }
    if (!segments.length) { segments.push([]); }
    segments.at(-1)!.push(`${x(sample.timeSeconds)},${y(value)}`);
    return segments;
  }, []).filter((segment) => segment.length > 0);
}

function Waveform({
  analysis,
  baselineAnalysis,
  baselineDocument,
  parts,
  quantity,
  sampleIndex,
}: {
  analysis: TransientAnalysis;
  baselineAnalysis?: TransientAnalysis;
  baselineDocument?: CircuitDocument;
  parts: readonly WaveformPart[];
  quantity: Quantity;
  sampleIndex: number;
}) {
  const id = useId();
  const samples = analysis.samples;
  const baselineSamples = baselineAnalysis?.status === "valid" ? baselineAnalysis.samples : [];
  const duration = samples.at(-1)?.timeSeconds ?? 1;
  const series = parts.map((part) => ({
    part,
    current: valuesFor(samples, part.id, quantity),
    baseline: baselineDocument?.parts.some((candidate) => candidate.id === part.id && candidate.kind === part.kind)
      ? valuesFor(baselineSamples, part.id, quantity)
      : [],
  }));
  const scaleValues = series.flatMap(({ current, baseline }) => [...current, ...baseline])
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const low = Math.min(0, ...scaleValues);
  const high = Math.max(0, ...scaleValues);
  const span = high - low || 1;
  const x = (time: number) => 48 + time / (duration || 1) * 298;
  const y = (value: number) => 16 + (high - value) / span * 112;
  const cursorSample = samples[sampleIndex];
  const unit = quantity === "voltageVolts" ? "V" : "A";
  const title = quantity === "voltageVolts" ? "電圧" : "電流";

  return <section className="circuit-waveform" data-quantity={quantity} aria-label={`${title}の時間波形`}>
    <h3 className="circuit-waveform__heading">{title} ({unit})</h3>
    <svg viewBox="0 0 360 155" role="img" aria-labelledby={`${id}-title`}>
      <title id={`${id}-title`}>{title}の時間波形。選択した部品を同じ時間軸と数値尺度で表示します。</title>
      <path d="M48 16V128H346" className="circuit-waveform__axis" />
      <path d={`M48 ${y(0)}H346`} className="circuit-waveform__grid" />
      <text x="44" y="20" textAnchor="end">{format(high)}</text>
      <text x="44" y="130" textAnchor="end">{format(low)}</text>
      <text x="48" y="147">0 s</text>
      <text x="346" y="147" textAnchor="end">{format(duration)} s</text>
      <text x="48" y="10">{unit}</text>
      {series.map(({ part, current, baseline }, seriesIndex) => {
        const currentSegments = lineSegments(samples, current, x, y);
        const baselineSegments = lineSegments(baselineSamples, baseline, x, y);
        const currentValue = current[sampleIndex];
        const baselineValue = baseline[sampleIndex];
        return <g key={part.id} data-series-index={seriesIndex}>
          {baselineSegments.map((points) => <polyline key={`baseline-${points[0]}`} points={points.join(" ")} className="circuit-waveform__trace" data-source="baseline" strokeDasharray="5 4" />)}
          {currentSegments.map((points) => <polyline key={`current-${points[0]}`} points={points.join(" ")} className="circuit-waveform__trace" data-source="current" />)}
          {cursorSample && currentValue !== undefined && Number.isFinite(currentValue) && <circle
            cx={x(cursorSample.timeSeconds)} cy={y(currentValue)} r="3" className="circuit-waveform__series-dot" data-source="current"
          />}
          {cursorSample && baselineValue !== undefined && Number.isFinite(baselineValue) && baselineSamples[sampleIndex] && <circle
            cx={x(cursorSample.timeSeconds)} cy={y(baselineValue)} r="2.5" className="circuit-waveform__series-dot" data-source="baseline"
          />}
        </g>;
      })}
      {cursorSample && <path d={`M${x(cursorSample.timeSeconds)} 16V128`} className="circuit-waveform__cursor" />}
    </svg>
  </section>;
}

function readingAt(analysis: TransientAnalysis | undefined, partId: string, sampleIndex: number) {
  return analysis?.status === "valid" ? analysis.samples[sampleIndex]?.parts[partId] : undefined;
}

function PartSelection({
  choices,
  selectedPartIds,
  onToggle,
}: {
  choices: readonly WaveformPart[];
  selectedPartIds: readonly string[];
  onToggle: (partId: string, checked: boolean) => void;
}) {
  if (choices.length === 0) { return null; }
  return <fieldset className="circuit-transient__parts">
    <legend>グラフに表示する部品（最大{MAX_WAVEFORM_PARTS}個）</legend>
    <div className="circuit-transient__part-options">
      {choices.map((part) => {
        const checked = selectedPartIds.includes(part.id);
        const disabled = !checked && selectedPartIds.length >= MAX_WAVEFORM_PARTS;
        return <label key={part.id} className="circuit-transient__part-option" data-selected={checked}>
          <input type="checkbox" checked={checked} disabled={disabled} aria-label={`${part.label}の電圧・電流波形を表示`} onChange={(event) => onToggle(part.id, event.target.checked)} />
          <span>{part.label}</span>
        </label>;
      })}
    </div>
    {selectedPartIds.length > 0 && <p className="circuit-transient__selection-note">電圧と電流を別のグラフに表示します。選択した部品の線色は両方のグラフで共通です。</p>}
  </fieldset>;
}

function TimeControls({
  id,
  sampleIndex,
  maxSampleIndex,
  timeSeconds,
  playing,
  onFirst,
  onTogglePlayback,
  onSeek,
}: {
  id: string;
  sampleIndex: number;
  maxSampleIndex: number;
  timeSeconds: number;
  playing: boolean;
  onFirst: () => void;
  onTogglePlayback: () => void;
  onSeek: (index: number) => void;
}) {
  return <fieldset className="circuit-transient__time-controls">
    <legend>時間波形の再生操作</legend>
    <button type="button" className="circuit-button" onClick={onFirst} disabled={sampleIndex === 0}>先頭へ</button>
    <button type="button" className="circuit-button" aria-pressed={playing} onClick={onTogglePlayback} disabled={maxSampleIndex === 0}>{playing ? "一時停止" : "再生"}</button>
    <label htmlFor={`${id}-time`}>時間カーソル</label>
    <input id={`${id}-time`} type="range" min="0" max={maxSampleIndex} value={sampleIndex} data-sample-index={sampleIndex} onChange={(event) => onSeek(event.target.valueAsNumber)} />
    <output className="circuit-transient__time-output" aria-live="polite" data-sample-index={sampleIndex}>
      {format(timeSeconds)} s
    </output>
  </fieldset>;
}

function TransientReadings({
  analysis,
  baselineAnalysis,
  baselineDocument,
  parts,
  sampleIndex,
  baselineSampleIndex,
  timeSeconds,
}: {
  analysis: TransientAnalysis;
  baselineAnalysis?: TransientAnalysis;
  baselineDocument?: CircuitDocument;
  parts: readonly WaveformPart[];
  sampleIndex: number;
  baselineSampleIndex: number;
  timeSeconds: number;
}) {
  const compatibleBaselinePart = (part: WaveformPart) => baselineDocument?.parts.some((candidate) => candidate.id === part.id && candidate.kind === part.kind);
  return <table className="circuit-transient__readings">
    <caption>{format(timeSeconds)} s の電圧・電流</caption>
    <thead><tr>
      <th scope="col" rowSpan={2}>部品</th>
      <th scope="colgroup" colSpan={2}>{baselineAnalysis ? "変更後" : "現在"}</th>
      {baselineAnalysis && <th scope="colgroup" colSpan={2}>変更前</th>}
    </tr><tr>
      <th scope="col">電圧 (V)</th><th scope="col">電流 (A)</th>
      {baselineAnalysis && <><th scope="col">電圧 (V)</th><th scope="col">電流 (A)</th></>}
    </tr></thead>
    <tbody>
      {parts.map((part) => {
        const reading = readingAt(analysis, part.id, sampleIndex);
        const before = compatibleBaselinePart(part) ? readingAt(baselineAnalysis, part.id, baselineSampleIndex) : undefined;
        const labels = measurementLabels(part.kind);
        return <tr key={part.id} data-part-id={part.id}>
          <th scope="row"><span>{part.label}</span><small className="circuit-transient__reading-reference">{labels.voltage} / {labels.current}</small></th>
          <td>{format(reading?.voltageVolts)}</td><td>{format(reading?.currentAmps)}</td>
          {baselineAnalysis && <><td>{format(before?.voltageVolts)}</td><td>{format(before?.currentAmps)}</td></>}
        </tr>;
      })}
    </tbody>
  </table>;
}

function TransientVisualizations({
  id,
  analysis,
  baselineAnalysis,
  baselineDocument,
  parts,
  sampleIndex,
  maxSampleIndex,
  baselineSampleIndex,
  playing,
  onFirst,
  onTogglePlayback,
  onSeek,
}: {
  id: string;
  analysis: TransientAnalysis;
  baselineAnalysis?: TransientAnalysis;
  baselineDocument?: CircuitDocument;
  parts: readonly WaveformPart[];
  sampleIndex: number;
  maxSampleIndex: number;
  baselineSampleIndex: number;
  playing: boolean;
  onFirst: () => void;
  onTogglePlayback: () => void;
  onSeek: (index: number) => void;
}) {
  const cursorSample = analysis.samples[sampleIndex];
  if (!cursorSample) { return null; }
  if (parts.length === 0) { return <p role="status">波形に表示する部品を選んでください。</p>; }
  const baselineIsAvailable = baselineAnalysis?.status === "valid";
  return <>
    {baselineIsAvailable && <p className="circuit-transient__comparison-key"><span data-source="current">実線: 変更後</span><span data-source="baseline">破線: 変更前</span></p>}
    <ul className="circuit-transient__legend" aria-label="波形の部品">
      {parts.map((part, index) => <li key={part.id} data-series-index={index}><span className="circuit-transient__swatch" aria-hidden="true" />{part.label}</li>)}
    </ul>
    <div className="circuit-transient__plots">
      <Waveform analysis={analysis} baselineAnalysis={baselineAnalysis} baselineDocument={baselineDocument} parts={parts} quantity="voltageVolts" sampleIndex={sampleIndex} />
      <Waveform analysis={analysis} baselineAnalysis={baselineAnalysis} baselineDocument={baselineDocument} parts={parts} quantity="currentAmps" sampleIndex={sampleIndex} />
    </div>
    <TimeControls
      id={id}
      sampleIndex={sampleIndex}
      maxSampleIndex={maxSampleIndex}
      timeSeconds={cursorSample.timeSeconds}
      playing={playing}
      onFirst={onFirst}
      onTogglePlayback={onTogglePlayback}
      onSeek={onSeek}
    />
    <TransientReadings
      analysis={analysis}
      baselineAnalysis={baselineAnalysis}
      baselineDocument={baselineDocument}
      parts={parts}
      sampleIndex={sampleIndex}
      baselineSampleIndex={baselineSampleIndex}
      timeSeconds={cursorSample.timeSeconds}
    />
  </>;
}

export interface CircuitTransientPanelProps extends Omit<ComponentPropsWithoutRef<"details">, "children"> {
  document: CircuitDocument;
  baselineDocument?: CircuitDocument;
  onFrameChange?: (frame: CircuitTransientFrame | null) => void;
  /** Pause playback while a containing tab is inactive, retaining the current result and cursor. */
  active?: boolean;
  /** Initial open state used when this panel is shown without its surrounding settings. */
  defaultOpen?: boolean;
}

/** Bounded transient analysis with synchronized multi-part waveforms and an optional baseline comparison. */
export function CircuitTransientPanel({
  document,
  baselineDocument,
  onFrameChange,
  active = true,
  defaultOpen = false,
  open: openProp = defaultOpen,
  className = "",
  ...props
}: CircuitTransientPanelProps) {
  const id = useId();
  const [duration, setDuration] = useState(0.01);
  const [steps, setSteps] = useState(400);
  const [startFromOperatingPoint, setStartFromOperatingPoint] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [result, setResult] = useState<TransientResult | null>(null);
  const [requestedSampleIndex, setRequestedSampleIndex] = useState(0);
  const sampleIndexRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const onFrameChangeRef = useRef(onFrameChange);
  onFrameChangeRef.current = onFrameChange;

  const choices = document.parts.filter((part) => part.kind !== "junction" && part.kind !== "ground");
  const selectedPartIds = (selectionTouched ? selectedIds : defaultPartIds(choices))
    .filter((partId) => choices.some((part) => part.id === partId))
    .slice(0, MAX_WAVEFORM_PARTS);
  const selectedParts = selectedPartIds.flatMap((partId) => {
    const part = choices.find((candidate) => candidate.id === partId);
    return part ? [part] : [];
  });
  const resultMatches = result?.document === document && result.baselineDocument === baselineDocument;
  const current = resultMatches && result ? result.analysis : null;
  const baseline = current ? result?.baselineAnalysis : undefined;
  const sampleIndex = current?.status === "valid" && current.samples.length > 0
    ? Math.min(requestedSampleIndex, current.samples.length - 1)
    : 0;
  const maxSampleIndex = current?.status === "valid" ? Math.max(0, current.samples.length - 1) : 0;
  const cursorSample = current?.status === "valid" ? current.samples[sampleIndex] : undefined;
  const baselineSampleIndex = cursorSample && baseline?.status === "valid"
    ? baseline.samples.findIndex((sample) => sample.timeSeconds >= cursorSample.timeSeconds)
    : -1;
  const comparableBaselineIndex = baselineSampleIndex >= 0 ? baselineSampleIndex : sampleIndex;

  const setSampleIndex = (nextIndex: number) => {
    const boundedIndex = Math.min(maxSampleIndex, Math.max(0, nextIndex));
    sampleIndexRef.current = boundedIndex;
    setRequestedSampleIndex(boundedIndex);
  };

  const run = () => {
    const options = {
      durationSeconds: duration,
      timeStepSeconds: duration / steps,
      startFromOperatingPoint,
    };
    const analysis = simulateTransient(document, options);
    const compareDocument = baselineDocument && baselineDocument !== document ? baselineDocument : undefined;
    const baselineAnalysis = compareDocument ? simulateTransient(compareDocument, options) : undefined;
    sampleIndexRef.current = 0;
    setRequestedSampleIndex(0);
    setPlaying(false);
    setResult({ document, baselineDocument, analysis, baselineAnalysis });
  };

  const numberChange = (value: number, change: (value: number) => void) => {
    if (Number.isFinite(value) && value > 0) {
      change(value);
      setPlaying(false);
      setResult(null);
    }
  };

  const togglePart = (partId: string, checked: boolean) => {
    const currentIds = selectionTouched ? selectedIds : selectedPartIds;
    setSelectionTouched(true);
    setSelectedIds(checked
      ? [...currentIds.filter((selectedId) => selectedId !== partId), partId].slice(0, MAX_WAVEFORM_PARTS)
      : currentIds.filter((selectedId) => selectedId !== partId));
  };

  const goToFirstSample = () => {
    setPlaying(false);
    setSampleIndex(0);
  };

  const togglePlayback = () => {
    if (sampleIndex >= maxSampleIndex) { setSampleIndex(0); }
    setPlaying((value) => !value);
  };

  const seek = (index: number) => {
    setPlaying(false);
    setSampleIndex(index);
  };

  useStopPlaybackWhenInactive(active, current, setPlaying);

  useEffect(() => {
    if (current?.status !== "valid" || !cursorSample) {
      onFrameChangeRef.current?.(null);
      return;
    }
    onFrameChangeRef.current?.({ analysis: current, sampleIndex });
  }, [current, cursorSample, sampleIndex]);

  useEffect(() => () => { onFrameChangeRef.current?.(null); }, []);

  useEffect(() => {
    if (!canPlayTransient(active, playing, current)) { return; }
    const finalIndex = current.samples.length - 1;
    const increment = Math.max(1, Math.ceil(finalIndex / 200));
    const timer = window.setInterval(() => {
      const nextIndex = Math.min(finalIndex, sampleIndexRef.current + increment);
      sampleIndexRef.current = nextIndex;
      setRequestedSampleIndex(nextIndex);
      if (nextIndex >= finalIndex) { setPlaying(false); }
    }, PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, playing, current]);

  const stale = Boolean(result && !resultMatches);
  return <details {...props} open={openProp} className={`circuit-transient ${className}`}>
    <summary>時間波形・過渡解析</summary>
    <label htmlFor={`${id}-duration`}>解析時間 (s)</label>
    <input id={`${id}-duration`} type="number" min="0" step="any" value={duration} onChange={(event) => numberChange(event.target.valueAsNumber, setDuration)} />
    <label htmlFor={`${id}-steps`}>時間分割数</label>
    <input id={`${id}-steps`} type="number" min="1" max="2000" step="1" value={steps} onChange={(event) => numberChange(event.target.valueAsNumber, (value) => setSteps(Math.min(2000, Math.max(1, Math.round(value)))))} />
    <label className="circuit-transient__initial"><input type="checkbox" checked={startFromOperatingPoint} onChange={(event) => {
      setStartFromOperatingPoint(event.target.checked);
      setPlaying(false);
      setResult(null);
    }} />直流動作点から開始</label>
    <p>{startFromOperatingPoint ? "定常状態の蓄積電荷・電流から計算を始めます。" : "コンデンサの初期電圧・コイルの初期電流から計算を始めます。"}交流電源の時間波形は、設定した実効値の√2倍をピークとする正弦波です。</p>
    <PartSelection choices={choices} selectedPartIds={selectedPartIds} onToggle={togglePart} />
    <button type="button" className="circuit-button" onClick={run} disabled={choices.length === 0}>波形を計算</button>
    {stale && <p role="status">回路が変更されました。波形を再計算してください。</p>}
    {current && <p role={current.status === "invalid" ? "alert" : "status"}>{current.message}</p>}
    {baseline && baseline.status === "invalid" && <p role="status">変更前の回路は解析できません: {baseline.message}</p>}
    {current?.status === "valid" && <TransientVisualizations
      id={id}
      analysis={current}
      baselineAnalysis={baseline}
      baselineDocument={baselineDocument}
      parts={selectedParts}
      sampleIndex={sampleIndex}
      maxSampleIndex={maxSampleIndex}
      baselineSampleIndex={comparableBaselineIndex}
      playing={playing}
      onFirst={goToFirstSample}
      onTogglePlayback={togglePlayback}
      onSeek={seek}
    />}
    {current?.status === "valid" && current.issues.length > 0 && <ul>{current.issues.map((issue) => <li key={`${issue.partId ?? "circuit"}:${issue.message}`}>{issue.message}</li>)}</ul>}
  </details>;
}
