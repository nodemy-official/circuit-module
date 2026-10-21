import { useId, useState } from "react";
import { frequencyMatches } from "../ac-reactive.js";
import { complex, complexDivide, complexFromPolar, complexMagnitude, complexMultiply, complexPhaseDegrees, type ComplexValue } from "../analog-math.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import { readOptionalPrecision, restoredReadingComplex } from "../circuit-reading.js";
import { appendExactComplexSnapshot, appendExpressionTableSnapshot } from "../circuit-reading-snapshot.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitAnalysisOptions, type CircuitPartReading } from "../circuit-solver.js";
import { exactRationalToNumber, numberToExactRational, subtractExactRational } from "../exact-linear-algebra.js";
import { formatCircuitNumber } from "../number-format.js";
import { copySimulationDocument, simulationRecordField } from "../simulation-input.js";
import { NumericInput } from "./NumericInput.js";
import { useSimulationDocumentKey } from "./simulation-document-context.js";
import { simulationDocumentKey } from "./simulation-document-key.js";

const MIN_SWEEP_POINTS = 3;
const MAX_SWEEP_POINTS = 81;
const WAVEFORM_SAMPLES = 96;

function acSourceFrequencyHz(part: CircuitPart): number {
  return part.kind === "ac-source"
    ? (simulationRecordField(part, "frequencyHz") as number | undefined) ?? circuitPartCatalog["ac-source"].defaults.frequencyHz ?? 1000
    : 0;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function formatNumber(value: number): string {
  return formatCircuitNumber(value);
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
  const wrapped = value % 360;
  if (wrapped >= 180) { return wrapped - 360; }
  return wrapped < -180 ? wrapped + 360 : wrapped;
}

interface SweepPoint {
  frequencyHz: number;
  voltageVolts: number | null;
  voltage: ComplexValue | null;
}

interface StoredSweep {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  documentKey: string | null;
  switchStatesKey: string;
  analysisSnapshot: readonly unknown[] | null;
  selectedPartId: string;
  centerFrequencyHz: number;
  decades: number;
  pointCount: number;
  points: SweepPoint[];
}

interface SweepFailure {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  message: string;
}

function analyzedSwitchStatesKey(analysis: CircuitAnalysis): string {
  return JSON.stringify(Object.getOwnPropertyNames(analysis.parts).flatMap((id) => {
    const closed = analysis.parts[id]?.switchClosed;
    return typeof closed === "boolean" ? [[id, closed]] : [];
  }));
}

function sweepAnalysisSnapshot(analysis: CircuitAnalysis): readonly unknown[] | null {
  try {
    const snapshot: unknown[] = [analysis.status, analysis.mode, analysis.frequencyHz, analysis.timeSeconds, analysis.currentAmps, analysis.parts];
    appendExpressionTableSnapshot(snapshot, analysis.precisionExpressions);
    for (const id of Object.getOwnPropertyNames(analysis.parts)) {
      const reading = analysis.parts[id];
      snapshot.push(id, reading, reading?.voltageVolts, reading?.currentAmps, reading?.powerWatts, reading?.brightness,
        reading?.voltagePhaseDegrees, reading?.currentPhaseDegrees, reading?.reactivePowerVars,
        reading?.meterStatus, reading?.switchClosed, reading?.channelConducting);
      for (const values of [reading?.terminalVoltages, reading?.terminalCurrents,
        reading?.terminalVoltagePhasesDegrees, reading?.terminalCurrentPhasesDegrees]) {
        snapshot.push(values, values?.a, values?.b, values?.c);
      }
      appendExactComplexSnapshot(snapshot, reading?.exactVoltage);
      for (const values of [reading?.exactTerminalVoltages, reading?.exactTerminalCurrents]) {
        snapshot.push(values);
        for (const terminal of ["a", "b", "c"] as const) { appendExactComplexSnapshot(snapshot, values?.[terminal]); }
      }
      for (const groups of [reading?.acReferenceTerminalGroups, reading?.acCurrentResponseTerminalGroups]) {
        snapshot.push(groups, groups?.length);
        for (const group of groups ?? []) { snapshot.push(group, group.length, ...group); }
      }
      const differences = reading?.terminalVoltageDifferences;
      snapshot.push(differences, differences?.length);
      for (const difference of differences ?? []) {
        snapshot.push(difference, difference.fromTerminal, difference.toTerminal, difference.voltageVolts, difference.voltagePhaseDegrees);
        appendExactComplexSnapshot(snapshot, difference.exactVoltage);
      }
    }
    return snapshot;
  } catch {
    // A reused analysis with unreadable fields cannot verify an older sweep.
    return null;
  }
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
    (analysis.status === "closed" || analysis.status === "idle" || analysis.status === "open") &&
    document.parts.some((part) => part.kind === "ac-source") && finite(frequencyHz) && frequencyHz > 0 &&
    analysis.frequencyHz === requestedFrequencyHz &&
    Boolean(selectedPart && reading);
}

function createFrequencySweep(
  document: CircuitDocument,
  analysis: CircuitAnalysis,
  partId: string,
  centerFrequencyHz: number,
  decades: number,
  pointCount: number,
): StoredSweep {
  const copiedDocument = copySimulationDocument(document);
  const documentKey = simulationDocumentKey(copiedDocument);
  const switchStatesKey = analyzedSwitchStatesKey(analysis);
  const analysisSnapshot = sweepAnalysisSnapshot(analysis);
  const span = 10 ** (decades / 2);
  const minFrequency = Math.max(Number.MIN_VALUE, centerFrequencyHz / span);
  const maxFrequency = Math.min(Number.MAX_VALUE, centerFrequencyHz * span);
  if (!Number.isFinite(minFrequency) || !Number.isFinite(maxFrequency) || minFrequency <= 0 || maxFrequency <= minFrequency) {
    return { document, analysis, documentKey, switchStatesKey, analysisSnapshot, selectedPartId: partId, centerFrequencyHz, decades, pointCount, points: [] };
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
  const capturedSwitchStates = new Map<string, boolean>(JSON.parse(switchStatesKey));
  const switchStates = Object.fromEntries(copiedDocument.parts.flatMap((part) => {
    const closed = capturedSwitchStates.get(part.id);
    return part.kind === "switch" && closed !== undefined ? [[part.id, closed]] : [];
  }));
  const points: SweepPoint[] = [...frequencies].sort((first, second) => first - second).map((frequencyHz) => {
    // Keep the same excitation set as the displayed analysis. Sources at other
    // frequencies are out of band there, so they must stay out of the whole sweep.
    const sweptDocument: CircuitDocument = {
      ...copiedDocument,
      parts: copiedDocument.parts.map((part) => {
        if (part.kind !== "ac-source") { return part; }
        return frequencyMatches(acSourceFrequencyHz(part), centerFrequencyHz)
          ? { ...part, frequencyHz }
          : { ...part, voltageVolts: 0 };
      }),
    };
    const pointAnalysis = analyzeCircuit(sweptDocument, switchStates, { mode: "ac", frequencyHz });
    const reading = pointAnalysis.parts[partId];
    const voltage = (pointAnalysis.status === "closed" || pointAnalysis.status === "idle" || pointAnalysis.status === "open") &&
      reading?.meterStatus !== "floating" && reading?.meterStatus !== "unconnected"
      ? reading?.voltageVolts
      : undefined;
    // Scalar RMS is a label projection. Retain the physical phasor until the
    // response has been divided by its own scale, including underflowed RMS.
    const value = finite(voltage) ? restoredReadingComplex(readOptionalPrecision(() => reading?.exactVoltage),
      voltage, reading?.voltagePhaseDegrees, true, readOptionalPrecision(() => pointAnalysis.precisionExpressions))
      ?? complex(voltage) : null;
    return { frequencyHz, voltageVolts: finite(voltage) ? voltage : null, voltage: value };
  });
  return { document, analysis, documentKey, switchStatesKey, analysisSnapshot, selectedPartId: partId, centerFrequencyHz, decades, pointCount, points };
}

function matchingSweep(
  sweep: StoredSweep | null,
  document: CircuitDocument,
  documentKey: string | null,
  analysis: CircuitAnalysis,
  partId: string | undefined,
  centerFrequencyHz: number,
  decades: number,
  pointCount: number,
): StoredSweep | null {
  if (!sweep || sweep.document !== document || sweep.analysis !== analysis || sweep.selectedPartId !== partId ||
    sweep.centerFrequencyHz !== centerFrequencyHz || sweep.decades !== decades || sweep.pointCount !== pointCount) { return null; }
  // A host can change circuit values or switch overrides in place.
  try {
    const snapshot = sweepAnalysisSnapshot(analysis);
    return sweep.documentKey !== null && documentKey === sweep.documentKey &&
      analyzedSwitchStatesKey(analysis) === sweep.switchStatesKey && snapshot !== null && sweep.analysisSnapshot !== null &&
      snapshot.length === sweep.analysisSnapshot.length && snapshot.every((value, index) => Object.is(value, sweep.analysisSnapshot![index])) ? sweep : null;
  } catch {
    // If the current inputs cannot be read, the stored response is unverified.
    return null;
  }
}

function emptyMessage(options: CircuitAnalysisOptions, analysis: CircuitAnalysis, hasAcSource: boolean, requestedFrequencyHz: number): string {
  if (options.mode === "dc" || analysis.mode !== "ac") { return "交流解析を選ぶと、正弦波の位相と周波数応答を表示します。"; }
  if (analysis.frequencyHz !== requestedFrequencyHz) { return "解析周波数が変更されました。新しい解析結果を待っています。"; }
  if (!hasAcSource) { return "交流電源を含む回路で利用できます。"; }
  return analysis.status !== "closed"
    ? analysis.message || "有効な交流解析結果を待っています。"
    : "表示できる部品の交流計測値がありません。";
}

export interface CircuitAcPanelProps {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
}

function waveformPath(nonzero: boolean | null, phaseRadians: number | null, centerY: number): string | null {
  if (nonzero === null || (nonzero && phaseRadians === null)) { return null; }
  const xStart = 72;
  const xEnd = 408;
  return Array.from({ length: WAVEFORM_SAMPLES + 1 }, (_, index) => {
    const fraction = index / WAVEFORM_SAMPLES;
    const phase = Math.PI * 2 * fraction + (phaseRadians ?? 0);
    const x = xStart + (xEnd - xStart) * fraction;
    // Each quantity has its own peak scale. Trigonometry is needed only at
    // this SVG boundary; binary64 cosine error stays below a pixel and never
    // changes whether the retained physical amplitude is zero.
    const y = nonzero ? centerY - Math.cos(phase) * 62 : centerY;
    return `${x},${y}`;
  }).join(" ");
}

interface WaveformQuantity {
  rms: number | null;
  peak: number | null;
  nonzero: boolean | null;
  phaseDegrees: number | null;
  phaseRadians: number | null;
  value: ComplexValue | null;
  retained: boolean;
}

function waveformQuantity(
  reading: CircuitPartReading,
  quantity: "voltage" | "current",
  partKind: CircuitPart["kind"],
  measured: boolean,
  expressions: CircuitAnalysis["precisionExpressions"],
): WaveformQuantity {
  const scalar = quantity === "voltage" ? reading.voltageVolts : reading.currentAmps;
  if (!measured || !finite(scalar)) {
    return { rms: null, peak: null, nonzero: null, phaseDegrees: null, phaseRadians: null, value: null, retained: false };
  }
  const degrees = quantity === "voltage" ? reading.voltagePhaseDegrees : reading.currentPhaseDegrees;
  const precision = readOptionalPrecision(() => quantity === "voltage"
    ? reading.exactVoltage : reading.exactTerminalCurrents?.[partKind === "op-amp" ? "c" : "a"]);
  const retained = restoredReadingComplex(precision, scalar, degrees, true, expressions);
  const rms = Math.max(0, scalar);
  const value = retained ?? complexFromPolar(rms, finite(degrees) ? degrees : 0);
  // Self-division preserves exact nonzero amplitudes below the scalar range.
  const nonzero = complexMagnitude(complexDivide(value, value)) === 1;
  const phaseDegrees = retained ? complexPhaseDegrees(retained) : finite(degrees) ? degrees : null;
  // Phase and square-root approximations belong at the drawing/label boundary.
  // Applying binary64 sqrt(2) before magnitude rounding keeps subnormal peaks;
  // its relative error is below 2e-16 and does not feed back into the circuit.
  const peak = complexMagnitude(complexMultiply(value, complex(Math.SQRT2)));
  const phaseRadians = phaseDegrees === null ? null : wrapDegrees(phaseDegrees) * Math.PI / 180;
  return { rms, peak, nonzero, phaseDegrees, phaseRadians, value, retained: retained !== undefined };
}

function phaseDifference(voltage: WaveformQuantity, current: WaveformQuantity): number | null {
  if (!voltage.nonzero || !current.nonzero || voltage.phaseDegrees === null || current.phaseDegrees === null) { return null; }
  if ((voltage.retained || current.retained) && voltage.value && current.value) {
    // Divide before projecting either angle. Two phases near a half turn can
    // round to the same angle while their small relative phase is representable.
    return wrapDegrees(complexPhaseDegrees(complexDivide(current.value, voltage.value)));
  }
  const difference = subtractExactRational(numberToExactRational(current.phaseDegrees)!, numberToExactRational(voltage.phaseDegrees)!);
  const turn = 360n * difference.denominator;
  const halfTurn = 180n * difference.denominator;
  let numerator = difference.numerator % turn;
  if (numerator >= halfTurn) { numerator -= turn; }
  else if (numerator < -halfTurn) { numerator += turn; }
  // Reduce the exact difference before display rounding: normalizing each input
  // first can cancel a tiny difference across the half-turn boundary.
  return exactRationalToNumber({ numerator, denominator: difference.denominator });
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

function missingPhase(voltage: WaveformQuantity, current: WaveformQuantity): boolean {
  return (voltage.nonzero === true && voltage.phaseRadians === null) ||
    (current.nonzero === true && current.phaseRadians === null);
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

function Waveform({ reading, frequencyHz, partLabel, partKind, expressions }: {
  reading: CircuitPartReading;
  frequencyHz: number;
  partLabel: string;
  partKind: CircuitPart["kind"];
  expressions: CircuitAnalysis["precisionExpressions"];
}) {
  const id = useId();
  const measured = reading.meterStatus !== "floating" && reading.meterStatus !== "unconnected";
  const voltage = waveformQuantity(reading, "voltage", partKind, measured, expressions);
  const current = waveformQuantity(reading, "current", partKind, measured, expressions);
  const voltagePoints = waveformPath(voltage.nonzero, voltage.phaseRadians, 104);
  const currentPoints = waveformPath(current.nonzero, current.phaseRadians, 104);
  const difference = phaseDifference(voltage, current);
  const hasUnknownPhase = missingPhase(voltage, current);
  return <div className="circuit-ac__waveform" data-voltage-rms={voltage.rms ?? "undefined"} data-current-rms={current.rms ?? "undefined"}>
    {!measured && <p role="status">{reading.meterStatus === "unconnected" ? "計器の端子が未接続のため、波形を表示できません。" : "計器の値が定まらないため、波形を表示できません。"}</p>}
    <svg viewBox="0 0 480 190" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <title id={`${id}-title`}>{`${partLabel}の電圧と電流の交流波形`}</title>
      <desc id={`${id}-description`}>1周期を表示しています。電圧と電流は実効値から作った正弦波で、縦軸は独立した尺度です。</desc>
      <path d="M72 42V166H408" className="circuit-ac__axis" />
      <path d="M408 42V166" className="circuit-ac__axis" />
      <path d="M72 104H408" className="circuit-ac__grid" />
      <text x="66" y="48" textAnchor="end">{axisPeakLabel(voltage.peak, voltage.rms, "V", 1)}</text>
      <text x="66" y="168" textAnchor="end">{axisPeakLabel(voltage.peak, voltage.rms, "V", -1)}</text>
      <text x="414" y="48">{axisPeakLabel(current.peak, current.rms, "A", 1)}</text>
      <text x="414" y="168">{axisPeakLabel(current.peak, current.rms, "A", -1)}</text>
      <text x="72" y="183">0 s</text>
      <text x="408" y="183" textAnchor="end">T = {formatPeriod(frequencyHz)} s</text>
      {voltagePoints !== null && <polyline points={voltagePoints} className="circuit-ac__trace circuit-ac__trace--voltage" />}
      {currentPoints !== null && <polyline points={currentPoints} className="circuit-ac__trace circuit-ac__trace--current" />}
    </svg>
    <fieldset className="circuit-ac__legend">
      <legend>波形の凡例</legend>
      <span className="circuit-ac__legend-item circuit-ac__legend-item--voltage">電圧（左軸、V、実効値 {formatNumber(voltage.rms ?? Number.NaN)} V）</span>
      <span className="circuit-ac__legend-item circuit-ac__legend-item--current">電流（右軸、A、実効値 {formatNumber(current.rms ?? Number.NaN)} A）</span>
    </fieldset>
    <PhaseSummary difference={difference} hasUnknownPhase={hasUnknownPhase} />
  </div>;
}

function FrequencyResponse({ points, partLabel }: { points: SweepPoint[]; partLabel: string }) {
  const id = useId();
  const validPoints = points.filter((point): point is SweepPoint & { voltageVolts: number; voltage: ComplexValue } =>
    point.voltageVolts !== null && Number.isFinite(point.voltageVolts) && point.voltage !== null,
  );
  if (points.length === 0) { return null; }
  const minFrequency = points[0]?.frequencyHz ?? 1;
  const maxFrequency = points.at(-1)?.frequencyHz ?? minFrequency * 10;
  const logMin = Math.log10(minFrequency);
  const logSpan = Math.log10(maxFrequency) - logMin || 1;
  let voltageScale: ComplexValue | undefined;
  for (const point of validPoints) {
    if (complexMagnitude(complexDivide(point.voltage, point.voltage)) === 1 &&
      (!voltageScale || complexMagnitude(complexDivide(point.voltage, voltageScale)) > 1)) {
      voltageScale = point.voltage;
    }
  }
  const maxVoltage = voltageScale ? complexMagnitude(voltageScale) : 0;
  const x = (frequency: number) => 54 + (Math.log10(frequency) - logMin) / logSpan * 314;
  // Exact phasor division precedes the square root needed for the SVG height.
  // Only the finished 0–116 px magnitude is rounded; the final subtraction
  // introduces at most a few binary64 ulps, with no circuit-value feedback.
  const y = (voltage: ComplexValue | null) => voltage && voltageScale
    ? 146 - Math.min(116, complexMagnitude(complexMultiply(complex(116), complexDivide(voltage, voltageScale)))) : 146;
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
        points={chunk.map((point) => `${x(point.frequencyHz)},${y(point.voltage)}`).join(" ")}
        className="circuit-ac__response-trace"
      />)}
      {validPoints.map((point) => <circle
        key={point.frequencyHz}
        cx={x(point.frequencyHz)}
        cy={y(point.voltage)}
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
export function CircuitAcPanel({ document, analysis, options: inputOptions }: CircuitAcPanelProps) {
  const id = useId();
  const options: CircuitAnalysisOptions = {
    mode: simulationRecordField(inputOptions, "mode") as CircuitAnalysisOptions["mode"],
    frequencyHz: simulationRecordField(inputOptions, "frequencyHz") as number | undefined,
  };
  const source = document.parts.find((part) => part.kind === "ac-source");
  const sourceFrequency = source ? acSourceFrequencyHz(source) : undefined;
  const requestedFrequencyHz = options.frequencyHz ?? sourceFrequency ?? circuitPartCatalog["ac-source"].defaults.frequencyHz ?? 1000;
  const centerFrequencyHz = analysis.frequencyHz ?? requestedFrequencyHz;
  const [selectedPartId, setSelectedPartId] = useState("");
  const [decades, setDecades] = useState(2);
  const [pointCount, setPointCount] = useState(41);
  const [sweep, setSweep] = useState<StoredSweep | null>(null);
  const [failure, setFailure] = useState<SweepFailure | null>(null);
  if (failure && (failure.document !== document || failure.analysis !== analysis)) {
    setFailure(null);
  }
  const choices: CircuitPart[] = document.parts.filter((part) => part.kind !== "ground" && part.kind !== "junction");
  const selectedPart = choices.find((part) => part.id === selectedPartId) ??
    choices.find((part) => part.kind === "capacitor" || part.kind === "inductor") ??
    choices[0];
  const reading = selectedPart ? analysis.parts[selectedPart.id] : undefined;
  const hasAcSource = document.parts.some((part) => part.kind === "ac-source");
  const active = usableAcAnalysis(document, analysis, options, centerFrequencyHz, requestedFrequencyHz, selectedPart, reading);
  const documentKey = useSimulationDocumentKey(document, active && sweep !== null);
  const visibleSweep = matchingSweep(sweep, document, documentKey, analysis, selectedPart?.id, centerFrequencyHz, decades, pointCount);

  const runSweep = () => {
    if (active && selectedPart) {
      try {
        setSweep(createFrequencySweep(document, analysis, selectedPart.id, centerFrequencyHz, decades, pointCount));
        setFailure(null);
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        setSweep(null);
        setFailure({ document, analysis, message: `周波数スイープを計算できませんでした。${detail}` });
      }
    }
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
    <Waveform reading={reading} frequencyHz={centerFrequencyHz} partLabel={selectedPart.label} partKind={selectedPart.kind}
      expressions={readOptionalPrecision(() => analysis.precisionExpressions)} />
    <div className="circuit-ac__sweep-controls">
      <h3>周波数を変えて調べる</h3>
      <p>範囲を広げると、フィルタの境目や共振する周波数を見つけやすくなります。</p>
      <label htmlFor={`${id}-decades`}>範囲（全幅、桁）</label>
      <NumericInput id={`${id}-decades`} min={0.5} max={6} step="0.5" value={decades} onValueChange={setDecades} />
      <label htmlFor={`${id}-points`}>解析点数（最大 {MAX_SWEEP_POINTS}）</label>
      <NumericInput id={`${id}-points`} min={MIN_SWEEP_POINTS} max={MAX_SWEEP_POINTS} step="1" integer value={pointCount} onValueChange={setPointCount} />
      <button type="button" className="circuit-button" onClick={runSweep} disabled={!active}>対数スイープを計算</button>
      <p className="circuit-ac__sweep-note">解析周波数に一致する交流電源を同時にスイープします。実効値と位相は保ち、異なる周波数の電源は解析対象外にします。</p>
    </div>
    {failure && <p className="circuit-ac__empty" role="alert">{failure.message}</p>}
    {showSweepMessage && <p className="circuit-ac__empty" role="status">周波数範囲を解析できませんでした。解析周波数を確認してください。</p>}
    {visibleSweep && visibleSweep.points.length > 0 && <FrequencyResponse points={visibleSweep.points} partLabel={selectedPart.label} />}
  </section>;
}
