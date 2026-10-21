import { complex, complexAdd, complexConjugate, complexDivide, complexFromPolar, complexMagnitudeNormalization, complexMultiply, complexNormalizedFraction, complexPhaseDegrees, complexRectangularValue, type ComplexValue } from "../analog-math.js";
import { terminalsOf, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "../circuit-model.js";
import { optionalPrecisionFailureToken, readOptionalPrecision, restoredReadingComplex } from "../circuit-reading.js";
import { appendExactComponentSnapshot, appendExactComplexSnapshot, appendExpressionTableSnapshot } from "../circuit-reading-snapshot.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { exactExpressionsAreImmutable, snapshotExactExpressions, type ExactExpressionNode } from "../exact-expression.js";
import { addExactRational, deferExactRationalReduction, exactRationalToNumber, multiplyExactRational, numberToExactRational, subtractExactRational, type ExactRational } from "../exact-linear-algebra.js";
import { complexFromExact, exactComplexValue } from "../exact-numeric-state.js";
import { formatCircuitNumber } from "../number-format.js";
import { formatCircuitQuantity, type CircuitTransientFrame } from "../circuit-visualization.js";
import type { TransientPartReading, TransientSample } from "../transient-solver.js";
import { matchingTransientEnergy, restoredTransientEnergy, type TransientEnergySample } from "../transient-energy.js";
import { partNumericValue } from "./part-numeric-field.js";

const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const reactiveKinds = new Set(["capacitor", "inductor"]);
const resistiveKinds = new Set(["resistor", "bulb"]);
type EnergyReading = CircuitAnalysis["parts"][string] | TransientPartReading;

function projectedReal(value: ComplexValue) {
  return complexRectangularValue(value).real;
}

function nonzero(value: ComplexValue) {
  return complexDivide(value, value).real === 1;
}

function absolute(value: ComplexValue) {
  return complexMultiply(value, complex(Math.abs(complexPhaseDegrees(value)) > 90 ? -1 : 1));
}

function greaterQuantity(value: ComplexValue, maximum: ComplexValue) {
  if (value === maximum) { return false; }
  const left = exactComplexValue(value);
  const right = exactComplexValue(maximum);
  const leftNormalization = complexMagnitudeNormalization(value);
  const rightNormalization = complexMagnitudeNormalization(maximum);
  if (left && right && !complexNormalizedFraction(value) && !complexNormalizedFraction(maximum) &&
    leftNormalization.numerator * rightNormalization.denominator === rightNormalization.numerator * leftNormalization.denominator) {
    // A sign comparison needs no reduced quotient. Deferring its temporary
    // denominator avoids refactoring long exact histories at every sample.
    return subtractExactRational(deferExactRationalReduction(left.real), deferExactRationalReduction(right.real)).numerator > 0n;
  }
  return nonzero(value) && (!nonzero(maximum) || projectedReal(complexDivide(value, maximum)) > 1);
}

function relativeWidth(value: ComplexValue | null, maximum: ComplexValue, percent: number) {
  return value && nonzero(maximum)
    ? Math.min(percent, Math.max(0, projectedReal(complexDivide(complexMultiply(value, complex(percent)), maximum))))
    : 0;
}

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
): ComplexValue | null {
  if (part.kind !== "capacitor" && part.kind !== "inductor") { return null; }
  const capacitive = part.kind === "capacitor";
  const coefficient = partNumericValue(part, capacitive ? "capacitanceFarads" : "inductanceHenries");
  const scalar = capacitive ? reading.voltageVolts : reading.currentAmps;
  if (!finite(coefficient) || coefficient <= 0 || !finite(scalar)) { return null; }
  const phase = capacitive ? "voltagePhaseDegrees" in reading ? reading.voltagePhaseDegrees : undefined
    : "currentPhaseDegrees" in reading ? reading.currentPhaseDegrees : undefined;
  const retained = restoredReadingComplex(readOptionalPrecision(() => capacitive ? reading.exactVoltage : reading.exactTerminalCurrents?.a), scalar, phase, ac, expressions);
  if (!retained) {
    return complexMultiply(complexMultiply(complex(0.5), complex(coefficient)), complexMultiply(complex(scalar), complex(scalar)));
  }
  // Keep algebraic terms and amplitude corrections through V*conj(V), then
  // project the completed energy only at its readout or relative-bar boundary.
  const factor = multiplyExactRational(numberToExactRational(0.5)!, numberToExactRational(coefficient)!);
  const squared = complexMultiply(retained, complexConjugate(retained));
  return complexMultiply(squared, complexFromExact({ real: factor, imaginary: numberToExactRational(0)! }));
}

function primaryPower(part: CircuitPart, reading: EnergyReading, ac: boolean, expressions?: readonly ExactExpressionNode[]) {
  const voltagePhase = "voltagePhaseDegrees" in reading ? reading.voltagePhaseDegrees : undefined;
  const currentPhase = "currentPhaseDegrees" in reading ? reading.currentPhaseDegrees : undefined;
  const primaryTerminal = part.kind === "op-amp" ? "c" : "a";
  const retainedVoltage = readOptionalPrecision(() => reading.exactVoltage);
  const retainedCurrent = readOptionalPrecision(() => reading.exactTerminalCurrents?.[primaryTerminal]);
  const restoredVoltage = restoredReadingComplex(retainedVoltage, reading.voltageVolts, voltagePhase, ac, expressions);
  const restoredCurrent = restoredReadingComplex(retainedCurrent, reading.currentAmps, currentPhase, ac, expressions);
  if ((retainedVoltage && !restoredVoltage) || (retainedCurrent && !restoredCurrent)) { return; }
  const voltage = restoredVoltage ?? complexFromPolar(reading.voltageVolts, ac ? voltagePhase ?? 0 : 0);
  const current = restoredCurrent ?? complexFromPolar(reading.currentAmps, ac ? currentPhase ?? 0 : 0);
  return complexMultiply(voltage, complexConjugate(current));
}

function precisionUnavailable(metadata: unknown, restored: ComplexValue | undefined) {
  return Boolean(metadata && !restored);
}

function localTerminalDifference(reading: EnergyReading, terminal: CircuitTerminal, reference: CircuitTerminal) {
  return reading.terminalVoltageDifferences?.find((value) => value.fromTerminal === terminal && value.toTerminal === reference)
    ?? reading.terminalVoltageDifferences?.find((value) => value.fromTerminal === reference && value.toTerminal === terminal);
}

function multiTerminalPower(part: CircuitPart, reading: EnergyReading, ac: boolean, expressions?: readonly ExactExpressionNode[]) {
  const terminals = terminalsOf(part.kind);
  let power = complex();
  const reference = terminals.at(-1)!;
  for (const terminal of terminals.slice(0, -1)) {
    const difference = localTerminalDifference(reading, terminal, reference);
    const amps = reading.terminalCurrents?.[terminal];
    if (!difference || !finite(amps)) { return; }
    const phase = "terminalCurrentPhasesDegrees" in reading ? reading.terminalCurrentPhasesDegrees?.[terminal] : undefined;
    const retainedVoltage = readOptionalPrecision(() => difference.exactVoltage);
    const retainedCurrent = readOptionalPrecision(() => reading.exactTerminalCurrents?.[terminal]);
    const restoredVoltage = restoredReadingComplex(retainedVoltage, difference.voltageVolts, difference.voltagePhaseDegrees, ac, expressions);
    const restoredCurrent = restoredReadingComplex(retainedCurrent, amps, phase, ac, expressions);
    if (precisionUnavailable(retainedVoltage, restoredVoltage) || precisionUnavailable(retainedCurrent, restoredCurrent)) { return; }
    const drop = complexMultiply(restoredVoltage ?? complexFromPolar(difference.voltageVolts, ac ? difference.voltagePhaseDegrees ?? 0 : 0),
      complex(difference.fromTerminal === terminal ? 1 : -1));
    const branch = restoredCurrent ?? complexFromPolar(amps, ac ? phase ?? 0 : 0);
    power = complexAdd(power, complexMultiply(drop, complexConjugate(branch)));
  }
  return power;
}

function retainedPower(part: CircuitPart, reading: EnergyReading, watts: number, ac: boolean,
  transient: boolean, expressions?: readonly ExactExpressionNode[]): ComplexValue {
  const fallback = complex(watts);
  // The solver defines ideal AC storage components' average real power as zero.
  if (ac && reactiveKinds.has(part.kind)) { return fallback; }
  if (!finite(reading.voltageVolts) || !finite(reading.currentAmps)) { return fallback; }
  const precisionToken = optionalPrecisionFailureToken();
  let power = terminalsOf(part.kind).length > 2 && part.kind !== "op-amp"
    ? multiTerminalPower(part, reading, ac, expressions)
    : primaryPower(part, reading, ac, expressions);
  if (!power || precisionToken !== optionalPrecisionFailureToken()) { return fallback; }
  // Retain the real component algebraically; projecting power.real here would
  // erase subnormal powers before their common scale is applied.
  power = complexMultiply(complexAdd(power, complexConjugate(power)), complex(0.5));
  if (isPowerSource(part, ac, transient)) { power = complexMultiply(power, complex(-1)); }
  // Independently replaced scalar power remains authoritative, as do malformed
  // or stale optional precision fields that no longer reproduce that readout.
  return projectedReal(power) === watts ? power : fallback;
}

function resistivePower(reading: TransientPartReading, expressions?: readonly ExactExpressionNode[]): ExactRational {
  const fallback = numberToExactRational(Math.max(0, reading.powerWatts))!;
  if (!finite(reading.voltageVolts) || !finite(reading.currentAmps) || reading.powerWatts < 0) { return fallback; }
  const voltage = restoredReadingComplex(readOptionalPrecision(() => reading.exactVoltage), reading.voltageVolts, undefined, false, expressions);
  const current = restoredReadingComplex(readOptionalPrecision(() => reading.exactTerminalCurrents?.a), reading.currentAmps, undefined, false, expressions);
  const power = multiplyExactRational(
    voltage ? exactComplexValue(voltage)!.real : numberToExactRational(reading.voltageVolts)!,
    current ? exactComplexValue(current)!.real : numberToExactRational(reading.currentAmps)!,
  );
  // Preserve the solver's unrounded V*I, including power below MIN_VALUE.
  // A caller's independently replaced scalar power remains authoritative.
  return power.numerator >= 0n && exactRationalToNumber(power) === reading.powerWatts ? power : fallback;
}

interface EnergyQuantity {
  joules: number | null;
  retained: ComplexValue | null;
}

function matchingQuantity(retained: ComplexValue | null, scalar: number | null | undefined) {
  if (!finite(scalar)) { return null; }
  return retained && projectedReal(retained) === scalar ? retained : complex(scalar);
}

function cachedEnergyQuantity(sample: TransientEnergySample | undefined, stored: boolean, expressions?: readonly ExactExpressionNode[]): EnergyQuantity | undefined {
  if (!sample) { return; }
  const joules = stored ? sample.storedJoules : sample.dissipatedJoules;
  if (!finite(joules)) { return joules === null ? { joules, retained: null } : undefined; }
  const token = optionalPrecisionFailureToken();
  const metadata = readOptionalPrecision(() => stored ? sample.exactStoredJoules : sample.exactDissipatedJoules);
  if (!metadata && token === optionalPrecisionFailureToken()) { return; }
  const retained = restoredTransientEnergy(metadata, joules, expressions);
  const exact = retained && exactComplexValue(complexRectangularValue(retained));
  const usable = exact && exact.imaginary.numerator === 0n && exact.real.numerator >= 0n && retained && projectedReal(retained) === joules;
  return { joules, retained: usable ? retained : complex(joules) };
}

function storedEnergyQuantity(part: CircuitPart, reading: EnergyReading, ac: boolean, expressions: readonly ExactExpressionNode[] | undefined,
  cached?: TransientEnergySample, cache?: WeakMap<EnergyReading, ComplexValue | null>): EnergyQuantity {
  const captured = cachedEnergyQuantity(cached, true, expressions);
  if (captured) { return captured; }
  const retained = cache?.has(reading) ? cache.get(reading)! : storedEnergy(part, reading, ac, expressions);
  cache?.set(reading, retained);
  const value = matchingQuantity(retained, cached ? cached.storedJoules : retained && projectedReal(retained));
  return { joules: value ? projectedReal(value) : null, retained: value };
}

function resistorEnergySeries(samples: readonly TransientSample[], partId: string, expressions?: readonly ExactExpressionNode[]): EnergyQuantity[] {
  const series: EnergyQuantity[] = [{ joules: 0, retained: complex() }];
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
      series.push({ joules: null, retained: null });
      continue;
    }
    const previousTime = numberToExactRational(previous.timeSeconds);
    const currentTime = numberToExactRational(current.timeSeconds);
    const duration = previousTime && currentTime && subtractExactRational(currentTime, previousTime);
    if (!duration || duration.numerator <= 0n) {
      accumulated = null;
      series.push({ joules: null, retained: null });
      continue;
    }
    const powerSum = addExactRational(resistivePower(previousReading, expressions), resistivePower(currentReading, expressions));
    const intervalEnergy = multiplyExactRational(multiplyExactRational(powerSum, half), duration);
    accumulated = addExactRational(accumulated, intervalEnergy);
    const displayed = exactRationalToNumber(accumulated);
    if (!Number.isFinite(displayed)) {
      accumulated = null;
      series.push({ joules: null, retained: null });
      continue;
    }
    series.push({ joules: displayed, retained: complexFromExact({ real: accumulated, imaginary: numberToExactRational(0)! }) });
  }
  return series;
}

interface PowerEntry {
  part: CircuitPart;
  watts: number;
  retained: ComplexValue;
}

interface EnergyEntry {
  part: CircuitPart;
  joules: number;
  retained: ComplexValue;
}

interface DissipationEntry extends EnergyQuantity {
  part: CircuitPart;
}

function powerForPart(
  part: CircuitPart,
  reading: CircuitAnalysis["parts"][string] | TransientPartReading | undefined,
  transient: boolean,
): number | null {
  if (!reading || part.kind === "ground" || part.kind === "junction" || !finite(reading.powerWatts)) { return null; }
  if (reading.meterStatus === "floating" || reading.meterStatus === "unconnected") { return null; }
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
  expressions?: readonly ExactExpressionNode[],
): PowerEntry[] {
  return document.parts.flatMap((part) => {
    const reading = transient ? sample?.parts[part.id] : analysis.parts[part.id];
    const watts = powerForPart(part, reading, transient);
    return watts === null || !reading ? [] : [{ part, watts, retained: retainedPower(part, reading, watts, analysis.mode === "ac" && !transient, transient, expressions) }];
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
    const quantity = storedEnergyQuantity(part, reading, analysis.mode === "ac" && !transient, expressions, cached);
    return quantity.joules !== null && quantity.retained ? [{ part, joules: quantity.joules, retained: quantity.retained }] : [];
  });
}

function maximumStoredEnergy(document: CircuitDocument, transient: CircuitTransientFrame["analysis"] | null, precomputed: Map<string, readonly TransientEnergySample[]>, expressions?: readonly ExactExpressionNode[]): ComplexValue {
  if (!transient) { return complex(); }
  const parts = Array.from({ length: document.parts.length }, (_, index) => document.parts[index]!)
    .filter((part) => reactiveKinds.has(part.kind));
  let maximum = complex();
  const retainedByPart = new Map(parts.map((part) => [part.id, new WeakMap<EnergyReading, ComplexValue | null>()]));
  for (let sampleIndex = 0; sampleIndex < transient.samples.length; sampleIndex += 1) {
    const sample = transient.samples[sampleIndex]!;
    for (const part of parts) {
      const reading = sample.parts[part.id];
      if (!reading || !finite(reading.voltageVolts) || !finite(reading.currentAmps)) { continue; }
      const cached = precomputed.get(part.id)?.[sampleIndex];
      const cache = retainedByPart.get(part.id)!;
      const { retained: value } = storedEnergyQuantity(part, reading, false, expressions, cached, cache);
      if (value && greaterQuantity(value, maximum)) { maximum = value; }
    }
  }
  return maximum;
}

function powerGroupMaximum(entries: PowerEntry[]): ComplexValue {
  return entries.reduce((maximum, { retained }) => {
    const magnitude = absolute(retained);
    return greaterQuantity(magnitude, maximum) ? magnitude : maximum;
  }, complex());
}

function maximumDissipation(seriesByPart: Map<string, EnergyQuantity[]>): ComplexValue {
  let maximum = complex();
  for (const series of seriesByPart.values()) {
    for (const { retained } of series) {
      if (retained && greaterQuantity(retained, maximum)) { maximum = retained; }
    }
  }
  return maximum;
}

function QuantityBar({ value, maximum }: { value: ComplexValue | null; maximum: ComplexValue }) {
  const width = relativeWidth(value, maximum, 100);
  return <span className="circuit-energy__quantity-bar" aria-hidden="true" data-scale-max={projectedReal(maximum)}>
    <span className="circuit-energy__quantity-bar-fill" style={{ width: `${width}%` }} />
  </span>;
}

function PowerBar({ partId, label, watts, retained, maximum }: { partId: string; label: string; watts: number; retained: ComplexValue; maximum: ComplexValue }) {
  const width = relativeWidth(absolute(retained), maximum, 50);
  const positive = Math.abs(complexPhaseDegrees(retained)) <= 90;
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
  maximum: ComplexValue;
}) {
  const title = kind === "source"
    ? ac ? "電源の平均供給電力" : "電源の供給電力"
    : ac ? "部品の平均電力" : "部品の電力";
  const positiveNote = kind === "source" ? "供給＋ / 吸収−" : "吸収＋ / 放出−";
  const nonzeroEntries = entries.filter(({ retained }) => nonzero(retained));
  return <div className="circuit-energy__power-group" data-power-group={kind}>
    <h3>{title} <small>{positiveNote}</small></h3>
    {nonzeroEntries.length === 0
      ? <p className="circuit-energy__empty">{entries.length > 0 ? "表示対象の電力はすべて 0 W です。" : kind === "source" ? "電源の電力データがありません。" : "部品の電力データがありません。"}</p>
      : nonzeroEntries.map(({ part, watts, retained }) => <PowerBar key={part.id} partId={part.id} label={part.label} watts={watts} retained={retained} maximum={maximum} />)}
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
  maximum: ComplexValue;
}) {
  return <div className="circuit-energy__energy-group" data-energy-kind={ac ? "period-average" : transient ? "instantaneous" : "steady"}>
    <h3>コンデンサ・コイルの蓄積エネルギー</h3>
    {ac && <p className="circuit-energy__note">交流成分の周期平均です。瞬時値ではありません。</p>}
    {transient && <p className="circuit-energy__note">バーはこの過渡解析全体の最大蓄積量を固定尺度にしています。</p>}
    {entries.length === 0
      ? <p className="circuit-energy__empty">蓄積エネルギーを表示できる部品はありません。</p>
      : entries.map(({ part, joules, retained }) => <div className="circuit-energy__energy-row" key={part.id} data-part-id={part.id} data-energy-joules={joules}>
        <span>{part.label}</span>
        {transient
          ? <QuantityBar value={retained} maximum={maximum} />
          : <span className="circuit-energy__quantity-bar circuit-energy__quantity-bar--empty" aria-hidden="true" />}
        <output>{formatCircuitQuantity(joules, "J")}</output>
      </div>)}
  </div>;
}

function DissipationGroup({ entries, maximum }: { entries: DissipationEntry[]; maximum: ComplexValue }) {
  if (entries.length === 0) { return null; }
  return <div className="circuit-energy__energy-group" data-energy-kind="resistive-dissipation">
    <h3>抵抗・電球の累積消費エネルギー</h3>
    <p className="circuit-energy__note">表示時刻までの過渡サンプルの瞬時電力を積分しています。</p>
    {entries.map(({ part, joules, retained }) => <div className="circuit-energy__energy-row" key={part.id} data-part-id={part.id} data-dissipated-joules={joules ?? undefined} data-dissipation-valid={joules === null ? "false" : "true"}>
      <span>{part.label}</span>
      <QuantityBar value={retained} maximum={maximum} />
      <output>{joules === null ? "—" : formatCircuitQuantity(joules, "J")}</output>
    </div>)}
  </div>;
}

function transientEnergy(document: CircuitDocument, transient: CircuitTransientFrame["analysis"] | null) {
  return new Map(document.parts.flatMap((part) => {
    const energy = transient && matchingTransientEnergy(part, transient.samples, readOptionalPrecision(() => transient.energyReadings),
      readOptionalPrecision(() => transient.precisionExpressions), readOptionalPrecision(() => transient.energyPrecisionExpressions));
    return energy ? [[part.id, energy] as const] : [];
  }));
}

function energyExpressions(table: readonly ExactExpressionNode[] | undefined) {
  if (!table) { return; }
  if (exactExpressionsAreImmutable(table)) { return table; }
  try { return snapshotExactExpressions(table); }
  catch { /* Malformed optional precision metadata uses scalar readouts. */ }
}

function dissipatedEnergy(parts: CircuitPart[], transient: CircuitTransientFrame["analysis"] | null,
  precomputed: Map<string, readonly TransientEnergySample[]>, expressions?: readonly ExactExpressionNode[]) {
  return transient
    ? new Map(parts.map((part) => {
      const energy = precomputed.get(part.id);
      const captured = energy && Array.from({ length: energy.length }, (_, index) => cachedEnergyQuantity(energy[index], false, expressions));
      if (captured?.every((quantity): quantity is EnergyQuantity => quantity !== undefined)) { return [part.id, captured]; }
      const retained = resistorEnergySeries(transient.samples, part.id, expressions);
      // Derived readouts use indexed JSON data, as their validation does.
      const series = energy ? Array.from({ length: energy.length }, (_, index): EnergyQuantity => {
        const joules = energy[index]!.dissipatedJoules ?? null;
        return retained[index]?.joules === joules ? retained[index]!
          : { joules, retained: joules === null ? null : complex(joules) };
      }) : retained;
      return [part.id, series];
    }))
    : new Map<string, EnergyQuantity[]>();
}

interface TransientEnergyProjection {
  snapshot: unknown[];
  maximumStored: ComplexValue;
  dissipatedByPart: Map<string, EnergyQuantity[]>;
}

const transientEnergyProjections = new WeakMap<CircuitTransientFrame["analysis"], TransientEnergyProjection>();

function appendEnergyReading(snapshot: unknown[], reading: EnergyReading | undefined, visited: WeakSet<EnergyReading>) {
  snapshot.push(reading);
  if (!reading || visited.has(reading)) { return; }
  visited.add(reading);
  snapshot.push(reading.voltageVolts, reading.currentAmps, reading.powerWatts);
  appendExactComplexSnapshot(snapshot, readOptionalPrecision(() => reading.exactVoltage));
  appendExactComplexSnapshot(snapshot, readOptionalPrecision(() => reading.exactTerminalCurrents?.a));
}

function transientEnergySnapshot(document: CircuitDocument, transient: CircuitTransientFrame["analysis"], precomputed: Map<string, readonly TransientEnergySample[]>) {
  const snapshot: unknown[] = [transient.samples, transient.samples.length];
  const parts = Array.from({ length: document.parts.length }, (_, index) => document.parts[index]!)
    .filter((part) => reactiveKinds.has(part.kind) || resistiveKinds.has(part.kind));
  for (const part of parts) {
    snapshot.push(part.id, part.kind, partNumericValue(part, "capacitanceFarads"), partNumericValue(part, "inductanceHenries"), precomputed.get(part.id));
  }
  appendExpressionTableSnapshot(snapshot, readOptionalPrecision(() => transient.precisionExpressions));
  const visited = new WeakSet<EnergyReading>();
  for (let index = 0; index < transient.samples.length; index += 1) {
    const sample = transient.samples[index]!;
    snapshot.push(sample, sample.timeSeconds);
    for (const part of parts) {
      appendEnergyReading(snapshot, sample.parts[part.id], visited);
      const cached = precomputed.get(part.id)?.[index];
      if (cached) {
        snapshot.push(cached, cached.storedJoules, cached.dissipatedJoules);
        readOptionalPrecision(() => appendExactComponentSnapshot(snapshot, cached.exactStoredJoules));
        readOptionalPrecision(() => appendExactComponentSnapshot(snapshot, cached.exactDissipatedJoules));
      }
    }
  }
  snapshot.push(optionalPrecisionFailureToken());
  return snapshot;
}

function transientEnergyProjection(document: CircuitDocument, transient: CircuitTransientFrame["analysis"] | null,
  precomputed: Map<string, readonly TransientEnergySample[]>, expressions?: readonly ExactExpressionNode[]) {
  if (!transient) { return { maximumStored: complex(), dissipatedByPart: new Map<string, EnergyQuantity[]>() }; }
  const snapshot = transientEnergySnapshot(document, transient, precomputed);
  const cached = transientEnergyProjections.get(transient);
  if (cached && cached.snapshot.length === snapshot.length && snapshot.every((value, index) => Object.is(value, cached.snapshot[index]))) { return cached; }
  const projection = {
    snapshot,
    maximumStored: maximumStoredEnergy(document, transient, precomputed, expressions),
    dissipatedByPart: dissipatedEnergy(document.parts.filter((part) => resistiveKinds.has(part.kind)), transient, precomputed, expressions),
  };
  const after = transientEnergySnapshot(document, transient, precomputed);
  if (after.length === snapshot.length && after.every((value, index) => Object.is(value, snapshot[index]))) { transientEnergyProjections.set(transient, projection); }
  else { transientEnergyProjections.delete(transient); }
  return projection;
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
  const expressions = energyExpressions(readOptionalPrecision(() => (transient ?? analysis).precisionExpressions));
  const { maximumStored: maximumStoredJoules, dissipatedByPart } = transientEnergyProjection(document, transient, precomputed, expressions);
  const resistiveParts = document.parts.filter((part) => resistiveKinds.has(part.kind));
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
  const powers = powerEntries(document, analysis, sample, usingTransient, expressions);
  const sources = powers.filter(({ part }) => isPowerSource(part, ac, usingTransient));
  const components = powers.filter(({ part }) => !isPowerSource(part, ac, usingTransient));
  const maximumPower = powerGroupMaximum(powers);
  const energies = energyEntries(document, analysis, sample, usingTransient, expressions, precomputed, sampleIndex);
  const dissipation = usingTransient
    ? resistiveParts.map((part) => ({ part, ...dissipatedByPart.get(part.id)?.[sampleIndex] ?? { joules: null, retained: null } }))
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
