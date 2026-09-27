import { useId, useState, type ChangeEvent } from "react";
import { frequencyMatches } from "../ac-reactive.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitAnalysisOptions, type CircuitPartReading } from "../circuit-solver.js";

const MIN_SWEEP_POINTS = 3;
const MAX_SWEEP_POINTS = 81;
const WAVEFORM_SAMPLES = 96;

function acSourceFrequencyHz(part: CircuitPart): number {
  return part.kind === "ac-source"
    ? part.frequencyHz ?? circuitPartCatalog["ac-source"].defaults.frequencyHz ?? 1000
    : 0;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) { return "—"; }
  if (value === 0) { return "0"; }
  return Number(value.toPrecision(4)).toString();
}

function formatFrequency(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6) { return `${formatNumber(value / 1e6)} MHz`; }
  if (magnitude >= 1e3) { return `${formatNumber(value / 1e3)} kHz`; }
  if (magnitude < 1) { return `${formatNumber(value * 1e3)} mHz`; }
  return `${formatNumber(value)} Hz`;
}

function formatPeriod(frequencyHz: number): string {
  const periodSeconds = 1 / frequencyHz;
  if (Number.isFinite(periodSeconds)) { return formatNumber(periodSeconds); }
  const logarithm = -Math.log10(frequencyHz);
  const exponent = Math.floor(logarithm);
  return `${formatNumber(10 ** (logarithm - exponent))}e+${exponent}`;
}

function wrapDegrees(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

interface SweepPoint {
  frequencyHz: number;
  voltageVolts: number | null;
}

interface StoredSweep {
  document: CircuitDocument;
  selectedPartId: string;
  centerFrequencyHz: number;
  decades: number;
  pointCount: number;
  points: SweepPoint[];
}

function usableAcAnalysis(
  document: CircuitDocument,
  analysis: CircuitAnalysis,
  options: CircuitAnalysisOptions,
  frequencyHz: number,
  requestedFrequencyHz: number,
  selectedPart: CircuitPart | undefined,
  reading: CircuitPartReading | undefined,
): boolean {
  return options.mode !== "dc" && analysis.mode === "ac" &&
    (analysis.status === "closed" || analysis.status === "idle") &&
    document.parts.some((part) => part.kind === "ac-source") && finite(frequencyHz) && frequencyHz > 0 &&
    analysis.frequencyHz === requestedFrequencyHz &&
    Boolean(selectedPart && reading);
}

function createFrequencySweep(
  document: CircuitDocument,
  partId: string,
  centerFrequencyHz: number,
  decades: number,
  pointCount: number,
): StoredSweep {
  const span = 10 ** (decades / 2);
  const minFrequency = Math.max(Number.MIN_VALUE, centerFrequencyHz / span);
  const maxFrequency = Math.min(Number.MAX_VALUE, centerFrequencyHz * span);
  if (!Number.isFinite(minFrequency) || !Number.isFinite(maxFrequency) || minFrequency <= 0 || maxFrequency <= minFrequency) {
    return { document, selectedPartId: partId, centerFrequencyHz, decades, pointCount, points: [] };
  }
  const lowerSteps = Math.floor((pointCount - 1) / 2);
  const upperSteps = pointCount - 1 - lowerSteps;
  const logFrequency = (start: number, end: number, index: number, steps: number) => {
    if (index === 0) { return start; }
    if (index === steps) { return end; }
    return Math.exp(Math.log(start) + (Math.log(end) - Math.log(start)) * index / steps);
  };
  const frequencies = new Set<number>();
  for (let index = 0; index <= lowerSteps; index += 1) {
    frequencies.add(logFrequency(minFrequency, centerFrequencyHz, index, lowerSteps));
  }
  for (let index = 1; index <= upperSteps; index += 1) {
    frequencies.add(logFrequency(centerFrequencyHz, maxFrequency, index, upperSteps));
  }
  const points: SweepPoint[] = [...frequencies].sort((first, second) => first - second).map((frequencyHz) => {
    // Keep the same excitation set as the displayed analysis. Sources at other
    // frequencies are out of band there, so they must stay out of the whole sweep.
    const sweptDocument: CircuitDocument = {
      ...document,
      parts: document.parts.map((part) => {
        if (part.kind !== "ac-source") { return part; }
        return frequencyMatches(acSourceFrequencyHz(part), centerFrequencyHz)
          ? { ...part, frequencyHz }
          : { ...part, voltageVolts: 0 };
      }),
    };
    const pointAnalysis = analyzeCircuit(sweptDocument, {}, { mode: "ac", frequencyHz });
    const voltage = pointAnalysis.status === "closed" || pointAnalysis.status === "idle"
      ? pointAnalysis.parts[partId]?.voltageVolts
      : undefined;
    return { frequencyHz, voltageVolts: finite(voltage) ? voltage : null };
  });
  return { document, selectedPartId: partId, centerFrequencyHz, decades, pointCount, points };
}

function matchingSweep(
  sweep: StoredSweep | null,
  document: CircuitDocument,
  partId: string | undefined,
  centerFrequencyHz: number,
  decades: number,
  pointCount: number,
): StoredSweep | null {
  if (!sweep || sweep.document !== document || sweep.selectedPartId !== partId ||
    sweep.centerFrequencyHz !== centerFrequencyHz || sweep.decades !== decades || sweep.pointCount !== pointCount) { return null; }
  return sweep;
}

function emptyMessage(options: CircuitAnalysisOptions, analysis: CircuitAnalysis, hasAcSource: boolean, requestedFrequencyHz: number): string {
  if (options.mode === "dc" || analysis.mode !== "ac") { return "交流解析を選ぶと、正弦波の位相と周波数応答を表示します。"; }
  if (analysis.frequencyHz !== requestedFrequencyHz) { return "解析周波数が変更されました。新しい解析結果を待っています。"; }
  if (!hasAcSource) { return "交流電源を含む回路で利用できます。"; }
  return analysis.status !== "closed"
    ? analysis.message || "有効な交流解析結果を待っています。"
    : "表示できる部品の交流計測値がありません。";
}

function boundedValue(value: number, minimum: number, maximum: number): number | null {
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

export interface CircuitAcPanelProps {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
}

function waveformPath(rms: number | null, phaseRadians: number | null, centerY: number): string | null {
  if (rms === null || (rms > 0 && phaseRadians === null)) { return null; }
  const xStart = 72;
  const xEnd = 408;
  return Array.from({ length: WAVEFORM_SAMPLES + 1 }, (_, index) => {
    const fraction = index / WAVEFORM_SAMPLES;
    const phase = Math.PI * 2 * fraction + (phaseRadians ?? 0);
    const x = xStart + (xEnd - xStart) * fraction;
    const y = rms === 0 ? centerY : centerY - Math.cos(phase) * 62;
    return `${x},${y}`;
  }).join(" ");
}

function phaseDifference(reading: CircuitPartReading, voltageRms: number | null, currentRms: number | null): number | null {
  if ((voltageRms ?? 0) === 0 || (currentRms ?? 0) === 0 ||
    !finite(reading.voltagePhaseDegrees) || !finite(reading.currentPhaseDegrees)) { return null; }
  return wrapDegrees(reading.currentPhaseDegrees - reading.voltagePhaseDegrees);
}

function describePhaseDifference(difference: number | null): string {
  if (difference === null) { return "電圧または電流が0か、位相が不明のため、位相差を定義できません。"; }
  if (Math.abs(difference) < 0.05) { return "電圧と電流はほぼ同位相です。"; }
  return difference > 0
    ? `電流は電圧より${formatNumber(difference)}°進みます。`
    : `電流は電圧より${formatNumber(Math.abs(difference))}°遅れます。`;
}

function axisPeakLabel(peak: number | null, rms: number | null, unit: "V" | "A", sign: 1 | -1): string {
  if (peak === null || rms === null) { return `— ${unit}`; }
  const value = Number.isFinite(peak) ? formatNumber(peak) : `${formatNumber(rms)} × √2`;
  return `${sign < 0 ? "−" : "+"}${value} ${unit}`;
}

function missingPhase(voltageRms: number | null, voltagePhase: number | null, currentRms: number | null, currentPhase: number | null): boolean {
  return ((voltageRms ?? 0) > 0 && voltagePhase === null) ||
    ((currentRms ?? 0) > 0 && currentPhase === null);
}

function PhaseSummary({ difference, hasUnknownPhase }: { difference: number | null; hasUnknownPhase: boolean }) {
  const label = difference === null ? "—" : `${difference > 0 ? "+" : ""}${formatNumber(difference)}°`;
  return <>
    {hasUnknownPhase && <p className="circuit-ac__phase-note">位相が不明な値の波形は表示していません。</p>}
    <p className="circuit-ac__phase" data-phase-difference-degrees={difference ?? "undefined"}>
      位相差：{label}。{describePhaseDifference(difference)}
    </p>
  </>;
}

function Waveform({ reading, frequencyHz, partLabel }: { reading: CircuitPartReading; frequencyHz: number; partLabel: string }) {
  const id = useId();
  const voltageRms = finite(reading.voltageVolts) ? Math.max(0, reading.voltageVolts) : null;
  const currentRms = finite(reading.currentAmps) ? Math.max(0, reading.currentAmps) : null;
  const voltagePeak = voltageRms === null ? null : Math.SQRT2 * voltageRms;
  const currentPeak = currentRms === null ? null : Math.SQRT2 * currentRms;
  const voltagePhase = finite(reading.voltagePhaseDegrees) ? reading.voltagePhaseDegrees * Math.PI / 180 : null;
  const currentPhase = finite(reading.currentPhaseDegrees) ? reading.currentPhaseDegrees * Math.PI / 180 : null;
  const voltagePoints = waveformPath(voltageRms, voltagePhase, 104);
  const currentPoints = waveformPath(currentRms, currentPhase, 104);
  const difference = phaseDifference(reading, voltageRms, currentRms);
  const hasUnknownPhase = missingPhase(voltageRms, voltagePhase, currentRms, currentPhase);
  return <div className="circuit-ac__waveform" data-voltage-rms={voltageRms ?? "undefined"} data-current-rms={currentRms ?? "undefined"}>
    <svg viewBox="0 0 480 190" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <title id={`${id}-title`}>{`${partLabel}の電圧と電流の交流波形`}</title>
      <desc id={`${id}-description`}>1周期を表示しています。電圧と電流は実効値から作った正弦波で、縦軸は独立した尺度です。</desc>
      <path d="M72 42V166H408" className="circuit-ac__axis" />
      <path d="M408 42V166" className="circuit-ac__axis" />
      <path d="M72 104H408" className="circuit-ac__grid" />
      <text x="66" y="48" textAnchor="end">{axisPeakLabel(voltagePeak, voltageRms, "V", 1)}</text>
      <text x="66" y="168" textAnchor="end">{axisPeakLabel(voltagePeak, voltageRms, "V", -1)}</text>
      <text x="414" y="48">{axisPeakLabel(currentPeak, currentRms, "A", 1)}</text>
      <text x="414" y="168">{axisPeakLabel(currentPeak, currentRms, "A", -1)}</text>
      <text x="72" y="183">0 s</text>
      <text x="408" y="183" textAnchor="end">T = {formatPeriod(frequencyHz)} s</text>
      {voltagePoints !== null && <polyline points={voltagePoints} className="circuit-ac__trace circuit-ac__trace--voltage" />}
      {currentPoints !== null && <polyline points={currentPoints} className="circuit-ac__trace circuit-ac__trace--current" />}
    </svg>
    <fieldset className="circuit-ac__legend">
      <legend>波形の凡例</legend>
      <span className="circuit-ac__legend-item circuit-ac__legend-item--voltage">電圧（左軸、V、実効値 {formatNumber(voltageRms ?? Number.NaN)} V）</span>
      <span className="circuit-ac__legend-item circuit-ac__legend-item--current">電流（右軸、A、実効値 {formatNumber(currentRms ?? Number.NaN)} A）</span>
    </fieldset>
    <PhaseSummary difference={difference} hasUnknownPhase={hasUnknownPhase} />
  </div>;
}

function FrequencyResponse({ points, partLabel }: { points: SweepPoint[]; partLabel: string }) {
  const id = useId();
  const validPoints = points.filter((point): point is SweepPoint & { voltageVolts: number } =>
    point.voltageVolts !== null && Number.isFinite(point.voltageVolts),
  );
  if (points.length === 0) { return null; }
  const minFrequency = points[0]?.frequencyHz ?? 1;
  const maxFrequency = points.at(-1)?.frequencyHz ?? minFrequency * 10;
  const logMin = Math.log10(minFrequency);
  const logSpan = Math.log10(maxFrequency) - logMin || 1;
  const maxVoltage = Math.max(0, ...validPoints.map(({ voltageVolts }) => voltageVolts));
  const voltageScale = maxVoltage || 1;
  const x = (frequency: number) => 54 + (Math.log10(frequency) - logMin) / logSpan * 314;
  const y = (voltage: number) => 146 - voltage / voltageScale * 116;
  const chunks: SweepPoint[][] = [];
  let active: SweepPoint[] = [];
  for (const point of points) {
    if (point.voltageVolts === null || !Number.isFinite(point.voltageVolts)) {
      if (active.length > 0) { chunks.push(active); active = []; }
    } else {
      active.push(point);
    }
  }
  if (active.length > 0) { chunks.push(active); }
  return <div className="circuit-ac__response" data-valid-points={validPoints.length}>
    <h3>{partLabel}の周波数応答</h3>
    <p>選んだ部品の電圧実効値を周波数ごとに示します。横軸は対数目盛です。</p>
    <svg viewBox="0 0 390 190" role="img" aria-labelledby={`${id}-title`}>
      <title id={`${id}-title`}>{`${partLabel}の電圧実効値の周波数応答`}</title>
      <path d="M54 22V146H368" className="circuit-ac__axis" />
      <path d="M54 146H368" className="circuit-ac__grid" />
      <text x="48" y="28" textAnchor="end">{formatNumber(maxVoltage)} V</text>
      <text x="48" y="149" textAnchor="end">0 V</text>
      <text x="54" y="166">{formatFrequency(minFrequency)}</text>
      <text x="368" y="166" textAnchor="end">{formatFrequency(maxFrequency)}</text>
      <text x="54" y="14">電圧実効値 (V)</text>
      {chunks.filter((chunk) => chunk.length > 1).map((chunk) => <polyline
        key={`${chunk[0]?.frequencyHz}-${chunk.at(-1)?.frequencyHz}`}
        points={chunk.map((point) => `${x(point.frequencyHz)},${y(point.voltageVolts ?? 0)}`).join(" ")}
        className="circuit-ac__response-trace"
      />)}
      {validPoints.map((point) => <circle
        key={point.frequencyHz}
        cx={x(point.frequencyHz)}
        cy={y(point.voltageVolts)}
        r="2.5"
        className="circuit-ac__response-dot"
        data-frequency-hz={point.frequencyHz}
        data-voltage-rms={point.voltageVolts}
      >
        <title>{`${formatFrequency(point.frequencyHz)}：${formatNumber(point.voltageVolts)} V 実効値`}</title>
      </circle>)}
      {points.filter(({ voltageVolts }) => voltageVolts === null).map((point) => <g
        key={`invalid-${point.frequencyHz}`}
        data-valid="false"
        data-frequency-hz={point.frequencyHz}
      >
        <title>{`${formatFrequency(point.frequencyHz)}：解析できませんでした`}</title>
        <text x={x(point.frequencyHz)} y="141" textAnchor="middle" className="circuit-ac__invalid-point">×</text>
      </g>)}
    </svg>
    <p className="circuit-ac__response-count">{validPoints.length} / {points.length} 点を解析しました。無効点の前後は別の線で表示します。</p>
  </div>;
}

/** Displays AC phasor waveforms and runs an explicit, bounded logarithmic frequency sweep. */
export function CircuitAcPanel({ document, analysis, options }: CircuitAcPanelProps) {
  const id = useId();
  const sourceFrequency = document.parts.find((part) => part.kind === "ac-source")?.frequencyHz;
  const requestedFrequencyHz = options.frequencyHz ?? sourceFrequency ?? circuitPartCatalog["ac-source"].defaults.frequencyHz ?? 1000;
  const centerFrequencyHz = analysis.frequencyHz ?? requestedFrequencyHz;
  const [selectedPartId, setSelectedPartId] = useState("");
  const [decades, setDecades] = useState(2);
  const [pointCount, setPointCount] = useState(41);
  const [sweep, setSweep] = useState<StoredSweep | null>(null);
  const choices: CircuitPart[] = document.parts.filter((part) => part.kind !== "ground" && part.kind !== "junction");
  const selectedPart = choices.find((part) => part.id === selectedPartId) ??
    choices.find((part) => part.kind === "capacitor" || part.kind === "inductor") ??
    choices[0];
  const reading = selectedPart ? analysis.parts[selectedPart.id] : undefined;
  const hasAcSource = document.parts.some((part) => part.kind === "ac-source");
  const active = usableAcAnalysis(document, analysis, options, centerFrequencyHz, requestedFrequencyHz, selectedPart, reading);
  const visibleSweep = matchingSweep(sweep, document, selectedPart?.id, centerFrequencyHz, decades, pointCount);

  const runSweep = () => {
    if (active && selectedPart) {
      setSweep(createFrequencySweep(document, selectedPart.id, centerFrequencyHz, decades, pointCount));
    }
  };

  const changeDecades = (event: ChangeEvent<HTMLInputElement>) => {
    const value = boundedValue(event.currentTarget.valueAsNumber, 0.5, 6);
    if (value !== null) { setDecades(value); }
  };
  const changePointCount = (event: ChangeEvent<HTMLInputElement>) => {
    const value = boundedValue(Math.round(event.currentTarget.valueAsNumber), MIN_SWEEP_POINTS, MAX_SWEEP_POINTS);
    if (value !== null) { setPointCount(value); }
  };

  if (!active || !selectedPart || !reading) {
    return <section className="circuit-panel circuit-ac" aria-label="交流の波形と周波数応答" data-state="empty">
      <div className="circuit-panel__heading"><h2>交流の波形と周波数応答</h2></div>
      <p className="circuit-ac__empty" role={analysis.status === "invalid" ? "alert" : "status"}>{emptyMessage(options, analysis, hasAcSource, requestedFrequencyHz)}</p>
    </section>;
  }

  const showSweepMessage = visibleSweep?.points.length === 0;
  return <section className="circuit-panel circuit-ac" aria-label="交流の波形と周波数応答" data-state="active" data-analysis-frequency={centerFrequencyHz}>
    <div className="circuit-panel__heading"><h2>交流の波形と周波数応答</h2></div>
    <p className="circuit-ac__frequency" data-analysis-frequency={centerFrequencyHz}>解析周波数：{formatFrequency(centerFrequencyHz)} · 電圧・電流は実効値</p>
    <label htmlFor={`${id}-part`}>波形を表示する部品</label>
    <select id={`${id}-part`} value={selectedPart.id} onChange={(event) => setSelectedPartId(event.target.value)}>
      {choices.map((part) => <option value={part.id} key={part.id}>{part.label}</option>)}
    </select>
    <Waveform reading={reading} frequencyHz={centerFrequencyHz} partLabel={selectedPart.label} />
    <div className="circuit-ac__sweep-controls">
      <h3>周波数を変えて調べる</h3>
      <p>範囲を広げると、フィルタの境目や共振する周波数を見つけやすくなります。</p>
      <label htmlFor={`${id}-decades`}>範囲（全幅、桁）</label>
      <input id={`${id}-decades`} type="number" min="0.5" max="6" step="0.5" value={decades} onChange={changeDecades} />
      <label htmlFor={`${id}-points`}>解析点数（最大 {MAX_SWEEP_POINTS}）</label>
      <input id={`${id}-points`} type="number" min={MIN_SWEEP_POINTS} max={MAX_SWEEP_POINTS} step="1" value={pointCount} onChange={changePointCount} />
      <button type="button" className="circuit-button" onClick={runSweep} disabled={!active}>対数スイープを計算</button>
      <p className="circuit-ac__sweep-note">解析周波数に一致する交流電源を同時にスイープします。実効値と位相は保ち、異なる周波数の電源は解析対象外にします。</p>
    </div>
    {showSweepMessage && <p className="circuit-ac__empty" role="status">周波数範囲を解析できませんでした。解析周波数を確認してください。</p>}
    {visibleSweep && visibleSweep.points.length > 0 && <FrequencyResponse points={visibleSweep.points} partLabel={selectedPart.label} />}
  </section>;
}
