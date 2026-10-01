import { complexMagnitudeNormalization, scaledProduct } from "../analog-math.js";
import type { CircuitDocument, CircuitPart } from "../circuit-model.js";
import { restoredReadingComplex } from "../circuit-reading.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { snapshotExactExpressions, type ExactExpressionNode } from "../exact-expression.js";
import { addExactRational, exactRationalToNumber, multiplyExactRational, numberToExactRational, subtractExactRational, type ExactRational } from "../exact-linear-algebra.js";
import { exactComplexValue } from "../exact-numeric-state.js";
import { formatCircuitNumber } from "../number-format.js";
import { formatCircuitQuantity, type CircuitTransientFrame } from "../circuit-visualization.js";
import type { TransientPartReading, TransientSample } from "../transient-solver.js";
import { matchingTransientEnergy, type TransientEnergySample } from "../transient-energy.js";

const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const reactiveKinds = new Set(["capacitor", "inductor"]);
const resistiveKinds = new Set(["resistor", "bulb"]);

function finite(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value);
}

function formatNumber(value: number): string {
  return formatCircuitNumber(value);
}

function storedEnergy(
  part: CircuitPart,
  reading: CircuitAnalysis["parts"][string] | TransientPartReading,
  ac: boolean,
  expressions?: readonly ExactExpressionNode[],
): number | null {
  if (part.kind !== "capacitor" && part.kind !== "inductor") { return null; }
  const capacitive = part.kind === "capacitor";
  const coefficient = capacitive ? part.capacitanceFarads ?? 1e-6 : part.inductanceHenries ?? 0.01;
  const scalar = capacitive ? reading.voltageVolts : reading.currentAmps;
  if (!finite(coefficient) || coefficient < 0 || !finite(scalar)) { return null; }
  const phase = capacitive ? "voltagePhaseDegrees" in reading ? reading.voltagePhaseDegrees : undefined
    : "currentPhaseDegrees" in reading ? reading.currentPhaseDegrees : undefined;
  const retained = restoredReadingComplex(capacitive ? reading.exactVoltage : reading.exactTerminalCurrents?.a, scalar, phase, ac, expressions);
  const exact = retained && exactComplexValue(retained);
  if (!retained || !exact) { return scaledProduct([0.5, coefficient, scalar, scalar]); }
  const squaredMagnitude = multiplyExactRational(addExactRational(
    multiplyExactRational(exact.real, exact.real), multiplyExactRational(exact.imaginary, exact.imaginary),
  ), complexMagnitudeNormalization(retained));
  return exactRationalToNumber(multiplyExactRational(
    multiplyExactRational(numberToExactRational(0.5)!, numberToExactRational(coefficient)!), squaredMagnitude,
  ));
}

function resistivePower(reading: TransientPartReading, expressions?: readonly ExactExpressionNode[]): ExactRational {
  const fallback = numberToExactRational(Math.max(0, reading.powerWatts))!;
  if (!finite(reading.voltageVolts) || !finite(reading.currentAmps) || reading.powerWatts < 0) { return fallback; }
  const voltage = restoredReadingComplex(reading.exactVoltage, reading.voltageVolts, undefined, false, expressions);
  const current = restoredReadingComplex(reading.exactTerminalCurrents?.a, reading.currentAmps, undefined, false, expressions);
  const power = multiplyExactRational(
    voltage ? exactComplexValue(voltage)!.real : numberToExactRational(reading.voltageVolts)!,
    current ? exactComplexValue(current)!.real : numberToExactRational(reading.currentAmps)!,
  );
  // Preserve the solver's unrounded V*I, including power below MIN_VALUE.
  // A caller's independently replaced scalar power remains authoritative.
  return power.numerator >= 0n && exactRationalToNumber(power) === reading.powerWatts ? power : fallback;
}

function resistorEnergySeries(samples: readonly TransientSample[], partId: string, expressions?: readonly ExactExpressionNode[]): Array<number | null> {
  const series: Array<number | null> = [0];
  let accumulated: ExactRational | null = numberToExactRational(0)!;
  const half = numberToExactRational(0.5)!;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const previousReading = previous?.parts[partId];
    const currentReading = current?.parts[partId];
    if (accumulated === null || !previous || !current || !previousReading || !currentReading ||
      !finite(previousReading.powerWatts) || !finite(currentReading.powerWatts)) {
      accumulated = null;
      series.push(null);
      continue;
    }
    const previousTime = numberToExactRational(previous.timeSeconds);
    const currentTime = numberToExactRational(current.timeSeconds);
    const duration = previousTime && currentTime && subtractExactRational(currentTime, previousTime);
    if (!duration || duration.numerator <= 0n) {
      accumulated = null;
      series.push(null);
      continue;
    }
    const powerSum = addExactRational(resistivePower(previousReading, expressions), resistivePower(currentReading, expressions));
    const intervalEnergy = multiplyExactRational(multiplyExactRational(powerSum, half), duration);
    accumulated = addExactRational(accumulated, intervalEnergy);
    const displayed = exactRationalToNumber(accumulated);
    if (!Number.isFinite(displayed)) {
      accumulated = null;
      series.push(null);
      continue;
    }
    series.push(displayed);
  }
  return series;
}

interface PowerEntry {
  part: CircuitPart;
  watts: number;
}

interface EnergyEntry {
  part: CircuitPart;
  joules: number;
}

interface DissipationEntry {
  part: CircuitPart;
  joules: number | null;
}

function powerForPart(
  part: CircuitPart,
  reading: CircuitAnalysis["parts"][string] | TransientPartReading | undefined,
  transient: boolean,
): number | null {
  if (!reading || part.kind === "ground" || part.kind === "junction" || !finite(reading.powerWatts)) { return null; }
  const watts = transient && sourceKinds.has(part.kind) ? -reading.powerWatts : reading.powerWatts;
  return watts;
}

function isPowerSource(part: CircuitPart, ac: boolean, transient: boolean): boolean {
  if (transient) { return sourceKinds.has(part.kind); }
  return ac ? part.kind === "ac-source" : sourceKinds.has(part.kind);
}

function powerEntries(
  document: CircuitDocument,
  analysis: CircuitAnalysis,
  sample: TransientSample | undefined,
  transient: boolean,
): PowerEntry[] {
  return document.parts.flatMap((part) => {
    const reading = transient ? sample?.parts[part.id] : analysis.parts[part.id];
    const watts = powerForPart(part, reading, transient);
    return watts === null ? [] : [{ part, watts }];
  });
}

function energyEntries(
  document: CircuitDocument,
  analysis: CircuitAnalysis,
  sample: TransientSample | undefined,
  transient: boolean,
  expressions?: readonly ExactExpressionNode[],
  precomputed?: Map<string, readonly TransientEnergySample[]>,
  sampleIndex = -1,
): EnergyEntry[] {
  return document.parts.flatMap((part) => {
    if (!reactiveKinds.has(part.kind)) { return []; }
    const reading = transient ? sample?.parts[part.id] : analysis.parts[part.id];
    if (!reading || !finite(reading.voltageVolts) || !finite(reading.currentAmps)) { return []; }
    const cached = precomputed?.get(part.id)?.[sampleIndex];
    const joules = cached ? cached.storedJoules : storedEnergy(part, reading, analysis.mode === "ac" && !transient, expressions);
    return finite(joules) ? [{ part, joules }] : [];
  });
}

function maximumStoredEnergy(document: CircuitDocument, transient: CircuitTransientFrame["analysis"] | null, precomputed: Map<string, readonly TransientEnergySample[]>, expressions?: readonly ExactExpressionNode[]): number {
  if (!transient) { return 0; }
  return Math.max(0, ...transient.samples.flatMap((sample, sampleIndex) => document.parts.flatMap((part) => {
    if (!reactiveKinds.has(part.kind)) { return []; }
    const reading = sample.parts[part.id];
    if (!reading || !finite(reading.voltageVolts) || !finite(reading.currentAmps)) { return []; }
    const cached = precomputed.get(part.id)?.[sampleIndex];
    const joules = cached ? cached.storedJoules : storedEnergy(part, reading, false, expressions);
    return finite(joules) ? [joules] : [];
  })));
}

function powerGroupMaximum(entries: PowerEntry[]): number {
  return Math.max(0, ...entries.map(({ watts }) => Math.abs(watts)));
}

function maximumDissipation(seriesByPart: Map<string, Array<number | null>>): number {
  const maxima = Array.from(seriesByPart.values(), (series) =>
    Math.max(0, ...series.filter((value): value is number => value !== null && Number.isFinite(value))),
  );
  return Math.max(0, ...maxima);
}

function QuantityBar({ value, maximum }: { value: number | null; maximum: number }) {
  const width = value !== null && maximum > 0 ? Math.min(100, Math.max(0, value / maximum * 100)) : 0;
  return <span className="circuit-energy__quantity-bar" aria-hidden="true" data-scale-max={maximum}>
    <span className="circuit-energy__quantity-bar-fill" style={{ width: `${width}%` }} />
  </span>;
}

function PowerBar({ partId, label, watts, maximum }: { partId: string; label: string; watts: number; maximum: number }) {
  const width = maximum > 0 ? Math.min(50, Math.abs(watts) / maximum * 50) : 0;
  const positive = watts >= 0;
  return <div className="circuit-energy__power-row" data-part-id={partId} data-watts={watts} data-sign={positive ? "positive" : "negative"}>
    <span className="circuit-energy__part-label">{label}</span>
    <span className="circuit-energy__bar" aria-hidden="true">
      <span
        className={`circuit-energy__bar-fill circuit-energy__bar-fill--${positive ? "positive" : "negative"}`}
        style={{ left: positive ? "50%" : `${50 - width}%`, width: `${width}%` }}
      />
    </span>
    <output>{formatNumber(watts)} W</output>
  </div>;
}

function PowerGroup({
  entries,
  kind,
  ac,
  maximum,
}: {
  entries: PowerEntry[];
  kind: "source" | "component";
  ac: boolean;
  maximum: number;
}) {
  const title = kind === "source"
    ? ac ? "電源の平均供給電力" : "電源の供給電力"
    : ac ? "部品の平均電力" : "部品の電力";
  const positiveNote = kind === "source" ? "供給＋ / 吸収−" : "吸収＋ / 放出−";
  const nonzeroEntries = entries.filter(({ watts }) => watts !== 0);
  return <div className="circuit-energy__power-group" data-power-group={kind}>
    <h3>{title} <small>{positiveNote}</small></h3>
    {nonzeroEntries.length === 0
      ? <p className="circuit-energy__empty">{entries.length > 0 ? "表示対象の電力はすべて 0 W です。" : kind === "source" ? "電源の電力データがありません。" : "部品の電力データがありません。"}</p>
      : nonzeroEntries.map(({ part, watts }) => <PowerBar key={part.id} partId={part.id} label={part.label} watts={watts} maximum={maximum} />)}
  </div>;
}

function StoredEnergyGroup({
  entries,
  ac,
  transient,
  maximum,
}: {
  entries: EnergyEntry[];
  ac: boolean;
  transient: boolean;
  maximum: number;
}) {
  return <div className="circuit-energy__energy-group" data-energy-kind={ac ? "period-average" : transient ? "instantaneous" : "steady"}>
    <h3>コンデンサ・コイルの蓄積エネルギー</h3>
    {ac && <p className="circuit-energy__note">交流成分の周期平均です。瞬時値ではありません。</p>}
    {transient && <p className="circuit-energy__note">バーはこの過渡解析全体の最大蓄積量を固定尺度にしています。</p>}
    {entries.length === 0
      ? <p className="circuit-energy__empty">蓄積エネルギーを表示できる部品はありません。</p>
      : entries.map(({ part, joules }) => <div className="circuit-energy__energy-row" key={part.id} data-part-id={part.id} data-energy-joules={joules}>
        <span>{part.label}</span>
        {transient
          ? <QuantityBar value={joules} maximum={maximum} />
          : <span className="circuit-energy__quantity-bar circuit-energy__quantity-bar--empty" aria-hidden="true" />}
        <output>{formatCircuitQuantity(joules, "J")}</output>
      </div>)}
  </div>;
}

function DissipationGroup({ entries, maximum }: { entries: DissipationEntry[]; maximum: number }) {
  if (entries.length === 0) { return null; }
  return <div className="circuit-energy__energy-group" data-energy-kind="resistive-dissipation">
    <h3>抵抗・電球の累積消費エネルギー</h3>
    <p className="circuit-energy__note">表示時刻までの過渡サンプルの瞬時電力を積分しています。</p>
    {entries.map(({ part, joules }) => <div className="circuit-energy__energy-row" key={part.id} data-part-id={part.id} data-dissipated-joules={joules ?? undefined} data-dissipation-valid={joules === null ? "false" : "true"}>
      <span>{part.label}</span>
      <QuantityBar value={joules} maximum={maximum} />
      <output>{joules === null ? "—" : formatCircuitQuantity(joules, "J")}</output>
    </div>)}
  </div>;
}

function transientEnergy(document: CircuitDocument, transient: CircuitTransientFrame["analysis"] | null) {
  return new Map(document.parts.flatMap((part) => {
    const energy = transient && matchingTransientEnergy(part, transient.samples, transient.energyReadings,
      transient.precisionExpressions, transient.energyPrecisionExpressions);
    return energy ? [[part.id, energy] as const] : [];
  }));
}

function energyExpressions(table: readonly ExactExpressionNode[] | undefined) {
  if (!table) { return; }
  try { return snapshotExactExpressions(table); }
  catch { /* Malformed optional precision metadata uses scalar readouts. */ }
}

function dissipatedEnergy(parts: CircuitPart[], transient: CircuitTransientFrame["analysis"] | null,
  precomputed: Map<string, readonly TransientEnergySample[]>, expressions?: readonly ExactExpressionNode[]) {
  return transient
    ? new Map(parts.map((part) => [part.id, precomputed.get(part.id)?.map((entry) => entry.dissipatedJoules ?? null)
      ?? resistorEnergySeries(transient.samples, part.id, expressions)]))
    : new Map<string, Array<number | null>>();
}

export interface CircuitEnergyPanelProps {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  frame?: CircuitTransientFrame | null;
}

/** Shows signed power and stored energy using the solver's respective sign conventions. */
export function CircuitEnergyPanel({ document, analysis, frame }: CircuitEnergyPanelProps) {
  const transient = frame?.analysis.status === "valid" ? frame.analysis : null;
  const requestedSampleIndex = frame?.sampleIndex;
  const sampleIndex: number = transient && typeof requestedSampleIndex === "number" && Number.isInteger(requestedSampleIndex) && requestedSampleIndex >= 0 && requestedSampleIndex < transient.samples.length
    ? requestedSampleIndex
    : -1;
  const sample = sampleIndex >= 0 ? transient?.samples[sampleIndex] : undefined;
  const usingTransient = Boolean(sample);
  const canShowSteady = !["invalid", "empty", "short"].includes(analysis.status);
  // Revalidate on every render: callers may edit samples or the document in place.
  const precomputed = transientEnergy(document, transient);
  const expressions = energyExpressions(transient?.precisionExpressions);
  const maximumStoredJoules = maximumStoredEnergy(document, transient, precomputed, expressions);
  const resistiveParts = document.parts.filter((part) => resistiveKinds.has(part.kind));
  const dissipatedByPart = dissipatedEnergy(resistiveParts, transient, precomputed, expressions);
  const maximumDissipatedJoules = maximumDissipation(dissipatedByPart);

  if ((!usingTransient && !canShowSteady) || (frame && !sample)) {
    const message = frame?.analysis.status === "valid"
      ? "選択した時刻の過渡サンプルがありません。波形を再計算してください。"
      : frame ? frame.analysis.message : analysis.message || "解析結果が有効になると、電力と蓄積エネルギーを表示します。";
    return <section className="circuit-panel circuit-energy" aria-label="電力とエネルギー" data-state="empty">
      <div className="circuit-panel__heading"><h2>電力とエネルギー</h2></div>
      <p className="circuit-energy__empty" role="status">{message}</p>
    </section>;
  }

  const ac = analysis.mode === "ac" && !usingTransient;
  const powers = powerEntries(document, analysis, sample, usingTransient);
  const sources = powers.filter(({ part }) => isPowerSource(part, ac, usingTransient));
  const components = powers.filter(({ part }) => !isPowerSource(part, ac, usingTransient));
  const maximumPower = powerGroupMaximum(powers);
  const energies = energyEntries(document, analysis, sample, usingTransient, transient ? expressions : analysis.precisionExpressions, precomputed, sampleIndex);
  const dissipation = usingTransient
    ? resistiveParts.map((part) => ({ part, joules: dissipatedByPart.get(part.id)?.[sampleIndex] ?? null }))
    : [];
  return <section className="circuit-panel circuit-energy" aria-label="電力とエネルギー" data-state={usingTransient ? "transient" : analysis.mode ?? "steady"}>
    <div className="circuit-panel__heading"><h2>電力とエネルギー</h2></div>
    {usingTransient && sample && <p className="circuit-energy__time" data-time-seconds={sample.timeSeconds}>
      過渡解析 · t = {formatNumber(sample.timeSeconds)} s
    </p>}
    <PowerGroup entries={sources} kind="source" ac={ac} maximum={maximumPower} />
    <PowerGroup entries={components} kind="component" ac={ac} maximum={maximumPower} />
    <StoredEnergyGroup entries={energies} ac={ac} transient={usingTransient} maximum={maximumStoredJoules} />
    <DissipationGroup entries={dissipation} maximum={maximumDissipatedJoules} />
    <p className="circuit-energy__note">符号は電源・部品ごとの値です。簡略化されたオペアンプや数値丸めを含むため、総和を保存則の検査値としては表示しません。</p>
  </section>;
}
