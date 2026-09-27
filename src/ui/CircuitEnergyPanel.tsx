import { useMemo } from "react";
import type { CircuitDocument, CircuitPart } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { formatCircuitQuantity, type CircuitTransientFrame } from "../circuit-visualization.js";
import type { TransientPartReading, TransientSample } from "../transient-solver.js";

const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const reactiveKinds = new Set(["capacitor", "inductor"]);
const resistiveKinds = new Set(["resistor", "bulb"]);

function finite(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) { return "—"; }
  if (value === 0) { return "0"; }
  return Number(value.toPrecision(4)).toString();
}

function storedEnergy(part: CircuitPart, voltageVolts: number, currentAmps: number): number | null {
  if (part.kind === "capacitor") {
    const capacitance = part.capacitanceFarads ?? 1e-6;
    return finite(capacitance) && capacitance >= 0 ? 0.5 * capacitance * voltageVolts ** 2 : null;
  }
  if (part.kind === "inductor") {
    const inductance = part.inductanceHenries ?? 0.01;
    return finite(inductance) && inductance >= 0 ? 0.5 * inductance * currentAmps ** 2 : null;
  }
  return null;
}

function resistorEnergySeries(samples: readonly TransientSample[], partId: string): Array<number | null> {
  const series: Array<number | null> = [0];
  let accumulated: number | null = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const previousPower = previous?.parts[partId]?.powerWatts;
    const currentPower = current?.parts[partId]?.powerWatts;
    if (accumulated === null || !previous || !current || !finite(previousPower) || !finite(currentPower)) {
      accumulated = null;
      series.push(null);
      continue;
    }
    const duration = current.timeSeconds - previous.timeSeconds;
    if (!(duration > 0) || !Number.isFinite(duration)) {
      accumulated = null;
      series.push(null);
      continue;
    }
    // Integrate sampled resistor power with the trapezoidal rule; do not infer a circuit-wide balance.
    accumulated += (Math.max(0, previousPower) + Math.max(0, currentPower)) * 0.5 * duration;
    series.push(accumulated);
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
): EnergyEntry[] {
  return document.parts.flatMap((part) => {
    if (!reactiveKinds.has(part.kind)) { return []; }
    const reading = transient ? sample?.parts[part.id] : analysis.parts[part.id];
    if (!reading || !finite(reading.voltageVolts) || !finite(reading.currentAmps)) { return []; }
    const joules = storedEnergy(part, reading.voltageVolts, reading.currentAmps);
    return finite(joules) ? [{ part, joules }] : [];
  });
}

function maximumStoredEnergy(document: CircuitDocument, transient: CircuitTransientFrame["analysis"] | null): number {
  if (!transient) { return 0; }
  return Math.max(0, ...transient.samples.flatMap((sample) => document.parts.flatMap((part) => {
    if (!reactiveKinds.has(part.kind)) { return []; }
    const reading = sample.parts[part.id];
    if (!reading || !finite(reading.voltageVolts) || !finite(reading.currentAmps)) { return []; }
    const joules = storedEnergy(part, reading.voltageVolts, reading.currentAmps);
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
  const canShowSteady = analysis.status !== "invalid" && analysis.status !== "empty" && analysis.status !== "short";
  const maximumStoredJoules = useMemo(() => maximumStoredEnergy(document, transient), [document, transient]);
  const resistiveParts = useMemo(() => document.parts.filter((part) => resistiveKinds.has(part.kind)), [document]);
  const dissipatedByPart = useMemo(() => transient
    ? new Map(resistiveParts.map((part) => [part.id, resistorEnergySeries(transient.samples, part.id)]))
    : new Map<string, Array<number | null>>(), [resistiveParts, transient]);
  const maximumDissipatedJoules = useMemo(() => maximumDissipation(dissipatedByPart), [dissipatedByPart]);

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
  const energies = energyEntries(document, analysis, sample, usingTransient);
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
