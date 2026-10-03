import { solveAnalogStep, type InitialVoltageConstraint, type TransientCompanionConstraint } from "./analog-solver.js";
import { exactProductSumRatio, scaledProduct } from "./analog-math.js";
import { exactComplexValue } from "./exact-numeric-state.js";
import {
  numberToExactRational,
  exactRationalToNumber,
  divideExactRational,
  multiplyExactRational,
  type ExactRational,
} from "./exact-linear-algebra.js";
import type { MeterStatus } from "./meter-status.js";
import {
  circuitPartCatalog,
  circuitPartNumericFields,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";
import {
  MAX_CIRCUIT_ANALYSIS_TERMINALS,
  type CircuitIssue,
} from "./circuit-solver.js";
import { SimulationSnapshotContext, simulationRecordField, snapshotSimulationRecord, validatedSimulationDocument } from "./simulation-input.js";
import { circuitNumericValueSchema, simulationBooleanSchema, transientAnalysisOptionsSchema } from "./circuit-validation.js";
import { readingPrecision, terminalVoltageDifferences, type CircuitReadingPrecision, type CircuitTerminalVoltageDifference } from "./circuit-reading.js";
import { createExactExpressionCapture, freezeCapturedExactExpressions, snapshotExactExpressions, withExactExpressionCapture, type ExactExpressionNode } from "./exact-expression.js";
import { createTransientEnergyCollector, type TransientEnergyReadings } from "./transient-energy.js";

export const MAX_TRANSIENT_STEPS = 2000;
/** Maximum estimated dense MNA scalar operations across every sample. */
export const MAX_TRANSIENT_SOLVER_WORK = 500_000_000;

export interface TransientPartReading extends CircuitReadingPrecision {
  /** Signed primary voltage: A−B, BJT C−E, MOSFET D−S, or op-amp output−GND. */
  voltageVolts: number;
  /** Signed current entering the primary terminal (normally A; op-amp output C). */
  currentAmps: number;
  /** Instantaneous power absorbed by the part; positive is absorbed, negative is delivered. */
  powerWatts: number;
  /** Potentials relative to the solver reference and signed currents entering physical terminals. */
  terminalVoltages?: Partial<Record<CircuitTerminal, number>>;
  /** Local three-terminal voltage differences retained before display rounding. */
  terminalVoltageDifferences?: readonly CircuitTerminalVoltageDifference[];
  terminalCurrents?: Partial<Record<CircuitTerminal, number>>;
  meterStatus?: MeterStatus;
  /** Whether the MOSFET channel is conducting at this sampled transient state. */
  channelConducting?: boolean;
  /** Effective switch position used for this sampled transient state. */
  switchClosed?: boolean;
}

export interface TransientSample {
  timeSeconds: number;
  parts: Record<string, TransientPartReading>;
}

export interface TransientAnalysis {
  status: "valid" | "invalid";
  message: string;
  issues: CircuitIssue[];
  samples: TransientSample[];
  /** Shared immutable expressions for exact readings. Preserved by JSON and structuredClone. */
  precisionExpressions?: readonly ExactExpressionNode[];
  /** Precomputed exact-state energy projections, guarded by sampled input snapshots. */
  energyReadings?: TransientEnergyReadings;
  energyPrecisionExpressions?: readonly ExactExpressionNode[];
}

export interface TransientAnalysisOptions {
  durationSeconds: number;
  timeStepSeconds: number;
  switchStates?: Record<string, boolean>;
  startFromOperatingPoint?: boolean;
}

interface StoredState {
  analysis: ReturnType<typeof solveAnalogStep>;
  acSourceVoltages: Map<string, ExactRational>;
  capacitorVoltages: Map<string, number>;
  exactCapacitorVoltages: Map<string, ExactRational>;
  inductorCurrents: Map<string, number>;
  exactInductorCurrents: Map<string, ExactRational>;
  exactResistivePowers: Map<string, ExactRational>;
}

interface CapacitorMember {
  partId: string;
  initialVoltageVolts: number;
  orientation: 1 | -1;
}

interface CapacitorGroup {
  members: CapacitorMember[];
  isShorted: boolean;
}

interface TransformedStep {
  document: CircuitDocument;
  voltageOverrides: Record<string, number>;
  companionConstraints: Map<string, TransientCompanionConstraint>;
}

interface SourceOverrides {
  voltageOverrides: Record<string, number>;
  voltageConstraints: Map<string, InitialVoltageConstraint>;
}

// floor(pi * 2^512), independently checked with Machin and Chudnovsky series.
// A binary64 pi combined with exact quarter-turn reduction leaves a phase
// error that can dominate cancellation among many integer harmonics.
const PHASE_PI_NUMERATOR = 0x3_243f6a88_85a308d3_13198a2e_03707344_a4093822_299f31d0_082efa98_ec4e6c89_452821e6_38d01377_be5466cf_34e90c6c_c0ac29b7_c97c50dd_3f84d5b5_b5470917n;

function phasePiValue(frequencyCount: number): ExactRational {
  const bits = Math.min(512, 128 + 8 * frequencyCount);
  return { numerator: PHASE_PI_NUMERATOR / 2n ** BigInt(512 - bits), denominator: 2n ** BigInt(bits) };
}

const DEFAULT_PHASE_PI = phasePiValue(0);
const DEFAULT_CAPACITANCE = circuitPartCatalog.capacitor.defaults.capacitanceFarads ?? 1e-6;
const DEFAULT_INDUCTANCE = circuitPartCatalog.inductor.defaults.inductanceHenries ?? 0.01;
const DEFAULT_INITIAL_VOLTAGE = circuitPartCatalog.capacitor.defaults.initialVoltageVolts ?? 0;
const DEFAULT_INITIAL_CURRENT = circuitPartCatalog.inductor.defaults.initialCurrentAmps ?? 0;
const DEFAULT_AC_RMS = circuitPartCatalog["ac-source"].defaults.voltageVolts ?? 5;
const DEFAULT_AC_FREQUENCY = circuitPartCatalog["ac-source"].defaults.frequencyHz ?? 1000;
const DEFAULT_AC_PHASE = circuitPartCatalog["ac-source"].defaults.phaseDegrees ?? 0;
const DEFAULT_AC_OFFSET = circuitPartCatalog["ac-source"].defaults.offsetVolts ?? 0;

function invalid(message: string, issues: CircuitIssue[] = [], samples: TransientSample[] = []): TransientAnalysis {
  return { status: "invalid", message, issues: deduplicateIssues(issues), samples };
}

function valid(message: string, issues: CircuitIssue[], samples: TransientSample[]): TransientAnalysis {
  return { status: "valid", message, issues: deduplicateIssues(issues), samples };
}

function deduplicateIssues(issues: readonly CircuitIssue[]): CircuitIssue[] {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.severity}:${item.partId ?? ""}:${item.message}`;
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

function stepCount(duration: number, timeStep: number): number | null {
  if (duration <= timeStep) { return 1; }
  // Count the represented sample times used by timeAtStep. Rounding a ratio
  // to a nearby integer can erase a distinct final interval and replace its
  // capacitor current with an average over a whole source cycle.
  if (MAX_TRANSIENT_STEPS * timeStep < duration) { return null; }
  let first = 1;
  let last = MAX_TRANSIENT_STEPS;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (middle * timeStep < duration) { first = middle + 1; }
    else { last = middle; }
  }
  return first;
}

function validateOptions(options: unknown, document: CircuitDocument, context: SimulationSnapshotContext): string | TransientAnalysisOptions {
  const capturedOptions = snapshotSimulationRecord(options, undefined, context);
  if (!capturedOptions) { return "解析条件はオブジェクトで指定してください。"; }
  const parsed = transientAnalysisOptionsSchema.safeParse(capturedOptions);
  if (!parsed.success) { return parsed.error.issues[0]!.message; }
  const inputSwitchStates = capturedOptions.switchStates;
  let switchStates: Record<string, boolean> | undefined;
  if (inputSwitchStates !== undefined) {
    const snapshot = snapshotSimulationRecord(inputSwitchStates, document.parts.map(({ id }) => id), context);
    if (!snapshot) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
    const switchIds = new Set(document.parts.filter((part) => part.kind === "switch").map(({ id }) => id));
    for (const [partId, state] of Object.entries(snapshot)) {
      if (!switchIds.has(partId)) {
        return `スイッチ状態の対象「${partId}」はスイッチ部品ではありません。`;
      }
      if (!simulationBooleanSchema.safeParse(state).success) {
        return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
      }
    }
    switchStates = snapshot as Record<string, boolean>;
  }
  return { ...parsed.data, switchStates };
}

function validateNumericFieldValue(part: CircuitPart, field: ReturnType<typeof circuitPartNumericFields>[number]) {
  const value = (part as unknown as Record<string, unknown>)[field.key];
  if (value === undefined) { return null; }
  const label = simulationRecordField(part, "label") ?? circuitPartCatalog[part.kind].defaults.label;
  const parsed = circuitNumericValueSchema(field).safeParse(value);
  if (parsed.success) { return null; }
  const issue = parsed.error.issues[0]!;
  if (issue.code === "too_small") {
    const comparator = field.exclusiveMin ? "より大きい" : "以上";
    return `${label}の${field.label}は${field.min}${field.unit}${comparator}の数値で指定してください。`;
  }
  if (issue.code === "too_big") {
    return `${label}の${field.label}は${field.max}${field.unit}以下の数値で指定してください。`;
  }
  return `${label}の${field.label}は有限な数値で指定してください。`;
}

function validateReactivePart(part: CircuitPart) {
  for (const field of circuitPartNumericFields(part.kind)) {
    const issue = validateNumericFieldValue(part, field);
    if (issue) { return issue; }
  }
  if (part.kind === "ac-source" && timeVoltage(part, 0) === null) {
    return `${simulationRecordField(part, "label") ?? circuitPartCatalog[part.kind].defaults.label}の交流設定は有限な値で指定してください。`;
  }
  return null;
}

function validateReactiveValues(document: CircuitDocument): string | null {
  for (const part of document.parts) {
    const issue = validateReactivePart(part);
    if (issue) { return issue; }
  }
  return null;
}

class EndpointSet {
  private readonly parents = new Map<string, string>();

  add(key: string) {
    if (!this.parents.has(key)) { this.parents.set(key, key); }
  }

  find(key: string): string {
    this.add(key);
    const parent = this.parents.get(key);
    if (parent === key) { return key; }
    const root = this.find(parent ?? key);
    this.parents.set(key, root);
    return root;
  }

  union(first: string, second: string) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot !== secondRoot) { this.parents.set(secondRoot, firstRoot); }
  }
}

function endpointKey(partId: string, terminal: CircuitTerminal) {
  return JSON.stringify([partId, terminal]);
}

function createWireNodes(document: CircuitDocument) {
  const nodes = new EndpointSet();
  for (const part of document.parts) {
    for (const terminal of circuitPartCatalog[part.kind].terminals) {
      nodes.add(endpointKey(part.id, terminal));
    }
  }
  for (const wire of document.wires) {
    nodes.union(endpointKey(wire.from.partId, wire.from.terminal), endpointKey(wire.to.partId, wire.to.terminal));
  }
  let firstGround: string | undefined;
  for (const part of document.parts) {
    if (part.kind !== "ground") { continue; }
    const key = endpointKey(part.id, "a");
    if (firstGround) { nodes.union(firstGround, key); }
    else { firstGround = key; }
  }
  return nodes;
}

function isSwitchClosed(part: CircuitPart, switchStates: Record<string, boolean>) {
  const override = Object.hasOwn(switchStates, part.id) ? switchStates[part.id] : undefined;
  return override ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
}

function createElectricalNodes(document: CircuitDocument, switchStates: Record<string, boolean>) {
  const nodes = createWireNodes(document);
  for (const part of document.parts) {
    if (part.kind === "ammeter" || (part.kind === "switch" && isSwitchClosed(part, switchStates))) {
      nodes.union(endpointKey(part.id, "a"), endpointKey(part.id, "b"));
    } else if (part.kind === "potentiometer" && (part.wiperPosition === 0 || part.wiperPosition === 1)) {
      // Only an endpoint position makes a segment exactly ideal. A tiny
      // nonzero segment may round to 0 ohms while retaining resistance in
      // the analog solver, so do not infer connectivity from its product.
      nodes.union(endpointKey(part.id, part.wiperPosition === 0 ? "a" : "b"), endpointKey(part.id, "c"));
    }
  }
  return nodes;
}

function capacitorGroupFor(part: CircuitPart, nodes: EndpointSet, groupsByNodes: Map<string, CapacitorGroup>) {
  if (part.kind !== "capacitor") { return; }
  const nodeA = nodes.find(endpointKey(part.id, "a"));
  const nodeB = nodes.find(endpointKey(part.id, "b"));
  const firstNode = nodeA < nodeB ? nodeA : nodeB;
  const secondNode = nodeA < nodeB ? nodeB : nodeA;
  const pairKey = JSON.stringify([firstNode, secondNode]);
  const group = groupsByNodes.get(pairKey) ?? {
    members: [],
    isShorted: nodeA === nodeB,
  };
  const initialVoltageVolts = part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE;
  group.members.push({
    partId: part.id,
    initialVoltageVolts,
    orientation: nodeA === firstNode ? 1 : -1,
  });
  groupsByNodes.set(pairKey, group);
}

function capacitorGroupIssue(group: CapacitorGroup): string | null {
  const firstMember = group.members[0];
  if (!firstMember) { return null; }
  const canonicalVoltage = firstMember.initialVoltageVolts * firstMember.orientation;
  if (group.members.some((member) => member.initialVoltageVolts * member.orientation !== canonicalVoltage)) {
    return `並列接続されたコンデンサの初期電圧が一致しません（${group.members.map(({ partId }) => partId).join("、")}）。`;
  }
  if (group.isShorted && canonicalVoltage !== 0) {
    return `短絡されたコンデンサの初期電圧は0 Vでなければなりません（${firstMember.partId}）。`;
  }
  return null;
}

function findCapacitorGroups(
  document: CircuitDocument,
  switchStates: Record<string, boolean>,
): { groups?: CapacitorGroup[]; reason?: string } {
  const nodes = createElectricalNodes(document, switchStates);
  const groupsByNodes = new Map<string, CapacitorGroup>();
  for (const part of document.parts) {
    capacitorGroupFor(part, nodes, groupsByNodes);
  }

  const groups = [...groupsByNodes.values()];
  for (const group of groups) {
    const issue = capacitorGroupIssue(group);
    if (issue) { return { reason: issue }; }
  }
  return { groups };
}

function estimateTerminals(document: CircuitDocument) {
  return document.parts.reduce((count, part) => count + (circuitPartCatalog[part.kind]?.terminals.length ?? 0), 0);
}

function exceedsLimits(document: CircuitDocument, steps: number): string | null {
  const terminalCount = estimateTerminals(document);
  if (terminalCount > MAX_CIRCUIT_ANALYSIS_TERMINALS) {
    return `過渡解析の端子数が上限の${MAX_CIRCUIT_ANALYSIS_TERMINALS}端子を超えています。`;
  }
  const potentiometerCount = document.parts.filter((part) => part.kind === "potentiometer").length;
  const dimensionBound = Math.max(1, terminalCount + document.parts.length + potentiometerCount);
  if (dimensionBound ** 3 * steps > MAX_TRANSIENT_SOLVER_WORK) {
    return "過渡解析の演算量が上限を超えています。部品数または時間分割数を減らしてください。";
  }
  return null;
}

function binaryFactor(value: number) {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(value));
  const high = bits.getUint32(0);
  const fraction = BigInt(high % 2 ** 20) * 2n ** 32n + BigInt(bits.getUint32(4));
  const exponentBits = Math.floor(high / 2 ** 20) % 2 ** 11;
  return exponentBits === 0
    ? { mantissa: fraction, exponent: -1074 }
    : { mantissa: fraction + 2n ** 52n, exponent: exponentBits - 1075 };
}

function binaryIntegerValue(value: bigint, exponent: number) {
  const magnitude = value < 0n ? -value : value;
  const shift = Math.max(0, magnitude.toString(2).length - 53);
  const leading = Number(magnitude / 2n ** BigInt(shift));
  const scaledExponent = exponent + shift;
  return scaledProduct([
    value < 0n ? -leading : leading,
    2 ** Math.max(scaledExponent, -1022),
    2 ** Math.min(scaledExponent + 1022, 0),
  ]);
}

function exactTimeQuadrant(frequencyHz: number, timeSeconds: number, phaseDegrees: number) {
  // Form 360*f*t + phase exactly, then reduce at a quarter-cycle before
  // rounding. Separate rounding of either the product or its phase sum can
  // erase a nonzero voltage at a zero crossing.
  const frequency = binaryFactor(frequencyHz);
  const time = binaryFactor(timeSeconds);
  const phase = binaryFactor(phaseDegrees);
  const timeExponent = frequency.exponent + time.exponent;
  const exponent = Math.min(0, timeExponent, phase.exponent);
  const timeDegrees = BigInt(Math.sign(timeSeconds)) * 360n * frequency.mantissa * time.mantissa * 2n ** BigInt(timeExponent - exponent);
  const phaseUnits = BigInt(Math.sign(phaseDegrees)) * phase.mantissa * 2n ** BigInt(phase.exponent - exponent);
  const total = timeDegrees + phaseUnits;
  const sign = total < 0n ? -1 : 1;
  const magnitude = total < 0n ? -total : total;
  const denominator = 2n ** BigInt(-exponent);
  const quarter = (magnitude + 45n * denominator) / (90n * denominator);
  const remainder = magnitude - quarter * 90n * denominator;
  return {
    quadrant: ((sign * Number(quarter % 4n)) + 4) % 4,
    offsetDegrees: sign * binaryIntegerValue(remainder, exponent),
    exactOffsetDegrees: { numerator: BigInt(sign) * remainder, denominator },
  };
}

function quadrantalPeakVoltage(rms: number, phaseDegrees: number, timeQuadrant = 0) {
  const phaseQuadrant = Math.round(phaseDegrees / 90);
  return quadrantPeakVoltage(rms, ((timeQuadrant + phaseQuadrant) % 4 + 4) % 4, phaseDegrees - phaseQuadrant * 90);
}

function quadrantPeakVoltage(rms: number, quadrant: number, offsetDegrees: number): ExactRational {
  const nearAxis = Math.abs(offsetDegrees) < 1e-7;
  const oddQuadrant = quadrant % 2 !== 0;
  const sign = oddQuadrant ? (quadrant === 1 ? -1 : 1) : (quadrant === 0 ? 1 : -1);
  if (nearAxis) {
    // sin(x)=x and cos(x)=1 differ below binary64 precision here. Preserve
    // the tiny slope, RMS and peak scaling until the final voltage rounding.
    return exactProductSumRatio([{
      factors: oddQuadrant ? [sign, rms, Math.SQRT2, offsetDegrees, Math.PI] : [sign, rms, Math.SQRT2],
    }], oddQuadrant ? 180 : 1)!;
  }
  // Trigonometry and the normalized RMS-to-peak coefficient are the only
  // approximate boundary. At 45 degrees that coefficient is exactly +/-1.
  const radians = offsetDegrees * (Math.PI / 180);
  const coefficient = Math.abs(offsetDegrees) === 45
    ? sign * (oddQuadrant ? Math.sign(offsetDegrees) : 1)
    : sign * Math.SQRT2 * (oddQuadrant ? Math.sin(radians) : Math.cos(radians));
  return exactProductSumRatio([{ factors: [rms, coefficient] }], 1)!;
}

function smallAngleVoltageChange(cosine: ExactRational, sine: ExactRational, frequency: number, timeSeconds: number, orderLimit: number, phasePi = DEFAULT_PHASE_PI) {
  return angleVoltageChange(cosine, sine, exactProductSumRatio([{ factors: [frequency, timeSeconds, 2, phasePi] }], 1)!, orderLimit);
}

function angleVoltageChange(cosine: ExactRational, sine: ExactRational, angle: ExactRational, orderLimit: number) {
  if (angle.numerator === 0n || (cosine.numerator === 0n && sine.numerator === 0n)) {
    return numberToExactRational(0)!;
  }
  // Evaluate cos(p+x) from the same initial coefficients as its derivative.
  // Exact powers preserve cancellation between sources with equal slopes.
  // Include enough orders for cancellation among the distinct frequencies.
  let power = angle;
  let factorial = numberToExactRational(1)!;
  let voltage = numberToExactRational(0)!;
  for (let order = 1; order <= orderLimit; order += 1) {
    factorial = exactProductSumRatio([{ factors: [factorial, order] }], 1)!;
    const coefficient = order % 2 === 0 ? cosine : sine;
    const sign = Math.ceil(order / 2) % 2 === 0 ? 1 : -1;
    const term = divideExactRational(exactProductSumRatio([{ factors: [coefficient, power], sign }], 1)!, factorial)!;
    voltage = exactProductSumRatio([{ factors: [voltage] }, { factors: [term] }], 1)!;
    power = exactProductSumRatio([{ factors: [power, angle] }], 1)!;
  }
  return voltage;
}

function smallTurnVoltage(part: CircuitPart, frequency: number, timeSeconds: number, offset: number, orderLimit: number, quadrantOffset: number, phasePi: ExactRational) {
  // Reuse the complete normalized initial coefficients, including tiny
  // phase curvature. Calling at t=0 never enters this small-turn path.
  const initial = { ...part, offsetVolts: 0 };
  const cosine = sourceWaveformValue(initial, 0, orderLimit, 0, quadrantOffset, phasePi)!;
  const sine = sourceWaveformValue(initial, 0, orderLimit, 0, (quadrantOffset + 3) % 4, phasePi)!;
  return exactProductSumRatio([
    { factors: [offset] }, { factors: [cosine] },
    { factors: [smallAngleVoltageChange(cosine, sine, frequency, timeSeconds, orderLimit, phasePi)] },
  ], 1)!;
}

function finiteWaveformSettings(rms: number, frequency: number, phaseDegrees: number, offset: number, timeSeconds: number) {
  return Number.isFinite(rms) && rms >= 0 && Number.isFinite(frequency) && frequency > 0 &&
    Number.isFinite(phaseDegrees) && Number.isFinite(offset) && Number.isFinite(timeSeconds);
}

function waveformAnchorOffset(offsetDegrees: number): number | null {
  // Choose the basis from the phase itself, including at t=0. At this
  // radius the 12-order series remainder is below 1e-70 of the peak;
  // looking ahead must not change the initial waveform representation.
  if (Math.abs(offsetDegrees) < 1e-3) { return 0; }
  return Math.abs(Math.abs(offsetDegrees) - 45) < 1e-3 ? Math.sign(offsetDegrees) * 45 : null;
}

interface WaveformAnchor { quadrant: number; offsetDegrees: number; }

function sourceWaveformAnchor(part: CircuitPart, timeSeconds: number): WaveformAnchor | null {
  const frequency = part.frequencyHz ?? DEFAULT_AC_FREQUENCY;
  const phase = (part.phaseDegrees ?? DEFAULT_AC_PHASE) % 360;
  const initial = exactTimeQuadrant(frequency, 0, phase);
  // The initial phase selects the waveform model, independently of sampling.
  // An ordinary phase uses its binary64 cosine/sine coefficients for the
  // whole transient. Entering an axis/diagonal neighborhood cannot replace
  // those coefficients with a differently normalized absolute phase model:
  // the resulting coefficient error would be amplified by C/dt.
  if (waveformAnchorOffset(initial.offsetDegrees) === null) { return null; }
  const combined = timeSeconds === 0 ? initial : exactTimeQuadrant(frequency, timeSeconds, phase);
  const offsetDegrees = waveformAnchorOffset(combined.offsetDegrees);
  return offsetDegrees === null ? null : { quadrant: combined.quadrant, offsetDegrees };
}

function anchoredSourceVoltage(part: CircuitPart, timeSeconds: number, anchor: WaveformAnchor, orderLimit: number, phasePi: ExactRational, quadrantOffset = 0) {
  const combined = exactTimeQuadrant(part.frequencyHz ?? DEFAULT_AC_FREQUENCY, timeSeconds, (part.phaseDegrees ?? DEFAULT_AC_PHASE) % 360);
  const degrees = exactProductSumRatio([
    { factors: [combined.exactOffsetDegrees] },
    { factors: [90, combined.quadrant - anchor.quadrant] },
    { factors: [anchor.offsetDegrees], sign: -1 },
  ], 1)!;
  const cycle = 360n * degrees.denominator;
  const reduced = ((degrees.numerator + 180n * degrees.denominator) % cycle + cycle) % cycle - 180n * degrees.denominator;
  const angle = exactProductSumRatio([{ factors: [{ numerator: reduced, denominator: degrees.denominator }, phasePi] }], 180)!;
  const rms = part.voltageVolts ?? DEFAULT_AC_RMS;
  const cosine = quadrantalPeakVoltage(rms, 90 * anchor.quadrant + anchor.offsetDegrees, quadrantOffset);
  const sine = quadrantalPeakVoltage(rms, 90 * anchor.quadrant + anchor.offsetDegrees, (quadrantOffset + 3) % 4);
  return exactProductSumRatio([
    { factors: [part.offsetVolts ?? DEFAULT_AC_OFFSET] }, { factors: [cosine] },
    { factors: [angleVoltageChange(cosine, sine, angle, orderLimit)] },
  ], 1)!;
}

function followingWaveformAnchor(part: CircuitPart, timeSeconds: number, followingTimeSeconds: number | undefined): WaveformAnchor | null {
  const frequency = part.frequencyHz ?? DEFAULT_AC_FREQUENCY;
  if (followingTimeSeconds === undefined || Math.abs(frequency * (followingTimeSeconds - timeSeconds)) >= 1e-8) { return null; }
  return sourceWaveformAnchor(part, followingTimeSeconds);
}

function sourceWaveformValue(part: CircuitPart, timeSeconds: number, orderLimit = 12, reducedOrder = 0, quadrantOffset = 0, phasePi = DEFAULT_PHASE_PI): ExactRational | null {
  const rms = part.voltageVolts ?? DEFAULT_AC_RMS;
  const frequency = part.frequencyHz ?? DEFAULT_AC_FREQUENCY;
  const phaseDegrees = (part.phaseDegrees ?? DEFAULT_AC_PHASE) % 360;
  const offset = part.offsetVolts ?? DEFAULT_AC_OFFSET;
  if (!finiteWaveformSettings(rms, frequency, phaseDegrees, offset, timeSeconds)) { return null; }
  if (rms === 0) { return numberToExactRational(offset); }
  const anchor = sourceWaveformAnchor(part, timeSeconds);
  if (anchor !== null) {
    return anchoredSourceVoltage(part, timeSeconds, anchor, orderLimit, phasePi, quadrantOffset);
  }
  const turns = frequency * timeSeconds;
  if (timeSeconds !== 0 && Math.abs(turns) < 1e-8) {
    return smallTurnVoltage(part, frequency, timeSeconds, offset, orderLimit, quadrantOffset, phasePi);
  }
  if (timeSeconds === 0) {
    return exactProductSumRatio([{ factors: [offset] }, {
      factors: [quadrantalPeakVoltage(rms, phaseDegrees, quadrantOffset)],
    }], 1)!;
  }
  const time = exactTimeQuadrant(frequency, timeSeconds, 0);
  const initial = { ...part, offsetVolts: 0 };
  const cosine = sourceWaveformValue(initial, 0, orderLimit, 0, (time.quadrant + quadrantOffset) % 4, phasePi)!;
  const sine = sourceWaveformValue(initial, 0, orderLimit, 0, (time.quadrant + quadrantOffset + 3) % 4, phasePi)!;
  const angle = exactProductSumRatio([{ factors: [time.exactOffsetDegrees, phasePi] }], 180)!;
  let voltage: ExactRational;
  if (reducedOrder > 0 || Math.abs(time.offsetDegrees) < 1e-3) {
    const change = angleVoltageChange(cosine, sine, angle, Math.max(20, reducedOrder));
    voltage = exactProductSumRatio([{ factors: [offset] }, { factors: [cosine] }, { factors: [change] }], 1)!;
  } else {
    // For a single frequency away from a small reduced angle, trig is
    // the binary64 model boundary. Avoid growing every stored state with
    // a high-degree rational denominator over long nonlinear transients.
    const radians = exactRationalToNumber(angle);
    const halfSine = Math.sin(radians / 2);
    // cos(x)-1=-2*sin(x/2)^2 retains the small quadratic response without
    // subtracting two rounded values near one. Equal sine terms can still
    // cancel exactly between sources with the same frequency.
    voltage = exactProductSumRatio([
      { factors: [offset] }, { factors: [cosine] },
      { factors: [2, cosine, halfSine, halfSine], sign: -1 },
      { factors: [sine, Math.sin(radians)], sign: -1 },
    ], 1)!;
  }
  return voltage;
}

function finiteSourceVoltage(voltage: ExactRational | null) {
  return voltage && Number.isFinite(exactRationalToNumber(voltage)) ? voltage : null;
}

function timeVoltage(part: CircuitPart, timeSeconds: number, orderLimit = 12, reducedOrder = 0, phasePi = DEFAULT_PHASE_PI) {
  return finiteSourceVoltage(sourceWaveformValue(part, timeSeconds, orderLimit, reducedOrder, 0, phasePi));
}

function steppedTimeVoltage(part: CircuitPart, timeSeconds: number, orderLimit: number, reducedOrder: number, phasePi: ExactRational, previous?: {
  timeSeconds: number; stepSeconds: number; voltages: ReadonlyMap<string, ExactRational>;
}, followingTimeSeconds?: number) {
  const followingAnchor = followingWaveformAnchor(part, timeSeconds, followingTimeSeconds);
  const frequency = part.frequencyHz ?? DEFAULT_AC_FREQUENCY;
  const previousIsShort = previous && Math.abs(frequency * previous.stepSeconds) < 1e-8;
  const followingIsShort = followingTimeSeconds !== undefined && Math.abs(frequency * (followingTimeSeconds - timeSeconds)) < 1e-8;
  if (followingIsShort && !previousIsShort) {
    // Evaluate both endpoints of a short interval in the same phase basis.
    // Otherwise an ordinary trig error in the earlier stored voltage becomes
    // a false C/dt current when the later endpoint returns to an exact axis.
    if (followingAnchor) {
      return finiteSourceVoltage(anchoredSourceVoltage(part, timeSeconds, followingAnchor, orderLimit, phasePi));
    }
    // Ordinary phases retain their initial coefficients. Only the short
    // interval boundary needs a precise rotation; regular single-frequency
    // steps still use the bounded binary64 trig model below.
    return timeVoltage(part, timeSeconds, orderLimit, Math.max(40, reducedOrder), phasePi);
  }
  const previousVoltage = previous?.voltages.get(part.id);
  if (!previous || !previousVoltage || Math.abs(frequency * previous.stepSeconds) >= 1e-8) {
    return timeVoltage(part, timeSeconds, orderLimit, reducedOrder, phasePi);
  }
  const currentAnchor = sourceWaveformAnchor(part, timeSeconds);
  if (currentAnchor) {
    // Absolute evaluation here retains the exact reduced phase and rational
    // corrections. Reanchor instead of carrying ordinary trig rounding or
    // an increment-series truncation residue into a canceled axis/diagonal.
    const anchoredPrevious = anchoredSourceVoltage(part, previous.timeSeconds, currentAnchor, orderLimit, phasePi);
    if (anchoredPrevious.numerator * previousVoltage.denominator === previousVoltage.numerator * anchoredPrevious.denominator) {
      const voltage = anchoredSourceVoltage(part, timeSeconds, currentAnchor, orderLimit, phasePi);
      return finiteSourceVoltage(voltage);
    }
  }
  // Small final steps use a voltage increment, avoiding a discontinuity
  // between independently rounded absolute waveform evaluations.
  const anchor = currentAnchor ?? followingAnchor;
  const withoutOffset = { ...part, offsetVolts: 0 };
  // At a reduced angle of at most pi/4 the 40-order remainder is <1e-54
  // of the peak. It does not contaminate a short interval's tiny curvature
  // with another rounded trig evaluation of the initial phase coefficients.
  const boundaryOrder = Math.max(40, reducedOrder);
  const cosine = anchor ? anchoredSourceVoltage(withoutOffset, previous.timeSeconds, anchor, orderLimit, phasePi)
    : sourceWaveformValue(withoutOffset, previous.timeSeconds, orderLimit, boundaryOrder, 0, phasePi);
  const sine = anchor ? anchoredSourceVoltage(withoutOffset, previous.timeSeconds, anchor, orderLimit, phasePi, 3)
    : sourceWaveformValue(withoutOffset, previous.timeSeconds, orderLimit, boundaryOrder, 3, phasePi);
  if (!cosine || !sine) { return null; }
  const change = smallAngleVoltageChange(cosine, sine, frequency, previous.stepSeconds, orderLimit, phasePi);
  const voltage = exactProductSumRatio([{ factors: [previousVoltage] }, { factors: [change] }], 1)!;
  return finiteSourceVoltage(voltage);
}

function sourceWaveformSettings(document: CircuitDocument) {
  const sources = document.parts.filter((part) => part.kind === "ac-source" && (part.voltageVolts ?? DEFAULT_AC_RMS) !== 0);
  const frequencies = new Set(sources.map((part) => part.frequencyHz ?? DEFAULT_AC_FREQUENCY));
  // Phase cancellation can retain higher orders even at a single frequency.
  // Use the same complete phase coefficients for the initial derivative.
  return { orderLimit: Math.max(12, 2 * sources.length + 4),
    reducedOrder: frequencies.size > 1 ? Math.max(20, 2 * frequencies.size + 16) : 0,
    phasePi: phasePiValue(sources.length) };
}

function sourceOverrides(document: CircuitDocument, timeSeconds: number, previous?: {
  timeSeconds: number; stepSeconds: number; voltages: ReadonlyMap<string, ExactRational>;
}, followingTimeSeconds?: number): SourceOverrides | null {
  const overrides = Object.create(null) as Record<string, number>;
  const constraints = new Map<string, InitialVoltageConstraint>();
  const { orderLimit, reducedOrder, phasePi } = sourceWaveformSettings(document);
  for (const part of document.parts) {
    if (part.kind !== "ac-source") { continue; }
    const voltage = steppedTimeVoltage(part, timeSeconds, orderLimit, reducedOrder, phasePi, previous, followingTimeSeconds);
    if (voltage === null) { return null; }
    overrides[part.id] = exactRationalToNumber(voltage);
    constraints.set(part.id, { voltageValue: voltage });
  }
  return { voltageOverrides: overrides, voltageConstraints: constraints };
}

function initialOverrides(
  document: CircuitDocument,
): SourceOverrides | null {
  const overrides = sourceOverrides(document, 0);
  if (overrides === null) { return null; }
  for (const part of document.parts) {
    if (part.kind === "capacitor") {
      overrides.voltageOverrides[part.id] = part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE;
    }
  }
  return overrides;
}

function initialDocument(
  document: CircuitDocument,
): CircuitDocument {
  return {
    ...document,
    parts: document.parts.map((part): CircuitPart => {
      if (part.kind === "capacitor") {
        return {
          ...part,
          kind: "battery",
          voltageVolts: 1,
          internalResistanceOhms: 0,
        };
      }
      return part;
    }),
  };
}

function acSourceInitialVoltageDerivative(part: CircuitPart, orderLimit: number, phasePi: ExactRational) {
  if (part.kind !== "ac-source") { return null; }
  // Use the same normalized sine coefficient as the waveform. Separate trig
  // rounding would create a false differential slope between equal sources.
  const sine = sourceWaveformValue({ ...part, offsetVolts: 0 }, 0, orderLimit, 0, 3, phasePi);
  if (!sine) { return null; }
  return exactProductSumRatio([{
    factors: [-1, 2, phasePi, part.frequencyHz ?? DEFAULT_AC_FREQUENCY, sine],
  }], 1);
}

function initialVoltageConstraints(document: CircuitDocument) {
  const { orderLimit, phasePi } = sourceWaveformSettings(document);
  const constraints = new Map<string, InitialVoltageConstraint>();
  for (const part of document.parts) {
    if (part.kind === "capacitor") {
      constraints.set(part.id, { capacitanceFarads: part.capacitanceFarads ?? DEFAULT_CAPACITANCE });
      continue;
    }
    const voltageDerivative = acSourceInitialVoltageDerivative(part, orderLimit, phasePi);
    if (voltageDerivative) { constraints.set(part.id, { voltageDerivative }); }
  }
  return constraints;
}

function capacitorStepPart(
  part: CircuitPart,
  state: StoredState,
  dt: number,
  voltageOverrides: Record<string, number>,
  companionConstraints: Map<string, TransientCompanionConstraint>,
): CircuitPart {
  if (part.kind !== "capacitor") { return part; }
  const capacitance = part.capacitanceFarads ?? DEFAULT_CAPACITANCE;
  const previousVoltage = state.capacitorVoltages.get(part.id) ??
    part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE;
  const exactPreviousVoltage = state.exactCapacitorVoltages.get(part.id) ??
    numberToExactRational(previousVoltage);
  const resistance = dt / capacitance;
  if (!Number.isFinite(previousVoltage) ||
      !exactPreviousVoltage) { return part; }

  // The Thevenin companion keeps the capacitor branch current as an MNA
  // unknown. A Norton conductance plus history source loses small physical
  // currents when two very large currents nearly cancel.
  voltageOverrides[part.id] = previousVoltage;
  companionConstraints.set(part.id, {
    kind: "capacitor",
    numerator: dt,
    denominator: capacitance,
    historyValue: previousVoltage,
    exactHistoryValue: exactPreviousVoltage,
  });
  // The branch equation uses the exact dt and C coefficients above. This
  // finite placeholder is only for the transformed part's numeric shape.
  return { ...part, kind: "battery", voltageVolts: 1,
    internalResistanceOhms: Number.isFinite(resistance) && resistance > 0 ? resistance : 1 };
}

function inductorStepPart(
  part: CircuitPart,
  state: StoredState,
  dt: number,
  voltageOverrides: Record<string, number>,
  companionConstraints: Map<string, TransientCompanionConstraint>,
): CircuitPart {
  if (part.kind !== "inductor") { return part; }
  const inductance = part.inductanceHenries ?? DEFAULT_INDUCTANCE;
  const previousCurrent = state.inductorCurrents.get(part.id) ??
    part.initialCurrentAmps ?? DEFAULT_INITIAL_CURRENT;
  const exactPreviousCurrent = state.exactInductorCurrents.get(part.id) ??
    numberToExactRational(previousCurrent);
  const resistance = inductance / dt;
  if (!Number.isFinite(previousCurrent) ||
      !exactPreviousCurrent) { return part; }
  // The companion stamps L*I_previous exactly. Its unused Thevenin voltage
  // can overflow even though all physical branch readings remain finite.
  voltageOverrides[part.id] = 0;
  companionConstraints.set(part.id, {
    kind: "inductor",
    numerator: inductance,
    denominator: dt,
    historyValue: previousCurrent,
    exactHistoryValue: exactPreviousCurrent,
  });
  return { ...part, kind: "battery", voltageVolts: 1,
    internalResistanceOhms: Number.isFinite(resistance) && resistance > 0 ? resistance : 1 };
}

function makeStepDocument(document: CircuitDocument, state: StoredState, dt: number): TransformedStep | null {
  const voltageOverrides = Object.create(null) as Record<string, number>;
  const companionConstraints = new Map<string, TransientCompanionConstraint>();
  const parts = document.parts.map((part): CircuitPart => {
    if (part.kind === "capacitor") {
      return capacitorStepPart(part, state, dt, voltageOverrides, companionConstraints);
    }
    if (part.kind === "inductor") {
      return inductorStepPart(part, state, dt, voltageOverrides, companionConstraints);
    }
    return part;
  });

  if (parts.some((part) => part.kind === "capacitor" || part.kind === "inductor")) { return null; }
  return {
    document: { ...document, parts, wires: document.wires },
    voltageOverrides,
    companionConstraints,
  };
}

function readingFinite(reading: { voltage: { real: number }; current: { real: number }; power: { real: number } }) {
  return Number.isFinite(reading.voltage.real) && Number.isFinite(reading.current.real) &&
    Number.isFinite(reading.power.real);
}

type PartSampleResult =
  | {
      reading: TransientPartReading;
      capacitorVoltage?: number;
      exactCapacitorVoltage?: ExactRational;
      inductorCurrent?: number;
      exactInductorCurrent?: ExactRational;
    }
  | { reason: string };

function samplePart(
  part: CircuitPart,
  reading: ReturnType<typeof solveAnalogStep>["parts"][string] | undefined,
): PartSampleResult {
  if (!reading || !readingFinite(reading)) {
    return { reason: `${part.label || part.id}の電圧・電流を有限値で計算できません。` };
  }
  const voltageVolts = reading.voltage.real;
  const currentAmps = reading.current.real;
  const exactVoltage = exactComplexValue(reading.voltage)?.real ?? numberToExactRational(voltageVolts);
  const exactCurrent = exactComplexValue(reading.current)?.real ?? numberToExactRational(currentAmps);
  const powerWatts = reading.power.real;
  const localDifferences = terminalVoltageDifferences(reading.terminalVoltages, false, reading.terminalVoltageDifferences);
  if (!Number.isFinite(currentAmps) || !Number.isFinite(powerWatts) || !exactVoltage || !exactCurrent) {
    return { reason: `${part.label || part.id}の過渡値が数値範囲を超えました。` };
  }
  return {
    reading: {
      voltageVolts, currentAmps, powerWatts,
      ...readingPrecision(reading),
      ...(reading.meterStatus ? { meterStatus: reading.meterStatus } : {}),
      ...(reading.channelConducting === undefined ? {} : { channelConducting: reading.channelConducting }),
      terminalVoltages: Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, value.real])),
      ...(localDifferences ? { terminalVoltageDifferences: localDifferences } : {}),
      terminalCurrents: part.kind === "capacitor" || part.kind === "inductor"
        ? { a: currentAmps, b: exactCurrent.numerator === 0n ? 0 : -currentAmps }
        : Object.fromEntries(Object.entries(reading.terminalCurrents).map(([terminal, value]) => [terminal, value.real])),
    },
    ...(part.kind === "capacitor"
      ? { capacitorVoltage: voltageVolts, exactCapacitorVoltage: exactVoltage }
      : {}),
    ...(part.kind === "inductor"
      ? { inductorCurrent: currentAmps, exactInductorCurrent: exactCurrent }
      : {}),
  };
}

function createSample(
  document: CircuitDocument,
  analysis: ReturnType<typeof solveAnalogStep>,
  switchStates: Record<string, boolean> = {},
): { sample?: TransientSample; state?: StoredState; reason?: string } {
  const parts = Object.create(null) as Record<string, TransientPartReading>;
  const capacitorVoltages = new Map<string, number>();
  const exactCapacitorVoltages = new Map<string, ExactRational>();
  const inductorCurrents = new Map<string, number>();
  const exactInductorCurrents = new Map<string, ExactRational>();
  const acSourceVoltages = new Map<string, ExactRational>();
  const exactResistivePowers = new Map<string, ExactRational>();
  for (const part of document.parts) {
    const result = samplePart(part, analysis.parts[part.id]);
    if ("reason" in result) { return { reason: result.reason }; }
    if (part.kind === "switch") { result.reading.switchClosed = isSwitchClosed(part, switchStates); }
    parts[part.id] = result.reading;
    if (result.capacitorVoltage !== undefined) { capacitorVoltages.set(part.id, result.capacitorVoltage); }
    if (result.exactCapacitorVoltage) { exactCapacitorVoltages.set(part.id, result.exactCapacitorVoltage); }
    if (result.inductorCurrent !== undefined) { inductorCurrents.set(part.id, result.inductorCurrent); }
    if (result.exactInductorCurrent) { exactInductorCurrents.set(part.id, result.exactInductorCurrent); }
    if (part.kind === "ac-source") { acSourceVoltages.set(part.id, exactComplexValue(analysis.parts[part.id]!.voltage)!.real); }
    if (part.kind === "resistor" || part.kind === "bulb") {
      const reading = analysis.parts[part.id]!;
      exactResistivePowers.set(part.id, multiplyExactRational(exactComplexValue(reading.voltage)!.real, exactComplexValue(reading.current)!.real));
    }
  }
  return {
    sample: { timeSeconds: 0, parts },
    state: { analysis, capacitorVoltages, exactCapacitorVoltages, inductorCurrents, exactInductorCurrents, acSourceVoltages, exactResistivePowers },
  };
}

function appendIssues(target: CircuitIssue[], incoming: readonly CircuitIssue[]) {
  target.push(...incoming);
}

interface InitialResult {
  sample: TransientSample;
  state: StoredState;
  issues: CircuitIssue[];
}

function documentWithOperatingPointState(document: CircuitDocument, sample: TransientSample): CircuitDocument | null {
  const parts = document.parts.map((part): CircuitPart => {
    const reading = sample.parts[part.id];
    if (part.kind === "capacitor") {
      return reading ? { ...part, initialVoltageVolts: reading.voltageVolts } : part;
    }
    if (part.kind === "inductor") {
      return reading ? { ...part, initialCurrentAmps: reading.currentAmps } : part;
    }
    return part;
  });
  if (parts.some((part) => (part.kind === "capacitor" || part.kind === "inductor") && !sample.parts[part.id])) {
    return null;
  }
  return { ...document, parts };
}

function initialConstraintsWithOperatingPointState(
  document: CircuitDocument,
  state: StoredState,
): Map<string, InitialVoltageConstraint> | null {
  const constraints = initialVoltageConstraints(document);
  for (const part of document.parts) {
    if (part.kind === "capacitor") {
      const voltageValue = state.exactCapacitorVoltages.get(part.id);
      if (!voltageValue) { return null; }
      constraints.set(part.id, { ...constraints.get(part.id), voltageValue });
    } else if (part.kind === "inductor") {
      const currentValue = state.exactInductorCurrents.get(part.id);
      if (!currentValue) { return null; }
      constraints.set(part.id, { ...constraints.get(part.id), currentValue });
    }
  }
  return constraints;
}

type OperatingPointInitialization =
  | { kind: "ready"; document: CircuitDocument; state: StoredState; issues: CircuitIssue[] }
  | { kind: "complete"; result: InitialResult }
  | { kind: "invalid"; reason: string; issues: CircuitIssue[] };

function initializeFromOperatingPoint(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
): OperatingPointInitialization {
  const operatingPoint = solveAnalogStep(document, {
    mode: "dc",
    switchStates: options.switchStates,
  });
  if (operatingPoint.status !== "valid") {
    return {
      kind: "invalid",
      reason: `直流動作点を満たす回路を計算できません。 ${operatingPoint.message}`,
      issues: operatingPoint.issues,
    };
  }
  const measured = createSample(document, operatingPoint, options.switchStates);
  if (!measured.sample || !measured.state) {
    return {
      kind: "invalid",
      reason: measured.reason ?? "直流動作点から蓄積状態を取得できませんでした。",
      issues: operatingPoint.issues,
    };
  }
  const hasTimeVaryingAcSource = document.parts.some(
    (part) => part.kind === "ac-source" && (part.voltageVolts ?? DEFAULT_AC_RMS) !== 0,
  );
  if (!hasTimeVaryingAcSource) {
    return {
      kind: "complete",
      result: { sample: measured.sample, state: measured.state, issues: operatingPoint.issues },
    };
  }
  const documentWithState = documentWithOperatingPointState(document, measured.sample);
  if (!documentWithState) {
    return {
      kind: "invalid",
      reason: "直流動作点からコンデンサ・コイルの状態を取得できませんでした。",
      issues: operatingPoint.issues,
    };
  }
  return {
    kind: "ready",
    document: documentWithState,
    state: measured.state,
    issues: operatingPoint.issues,
  };
}

function initializeTransient(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
): { result?: InitialResult; reason?: string; issues?: CircuitIssue[] } {
  const hasStoredState = document.parts.some((part) => part.kind === "capacitor" || part.kind === "inductor");
  const useOperatingPoint = (options.startFromOperatingPoint ?? false) && hasStoredState;
  let initialConditionDocument = document;
  let operatingPointIssues: CircuitIssue[] = [];
  let operatingPointState: StoredState | undefined;

  if (useOperatingPoint) {
    const operatingPoint = initializeFromOperatingPoint(document, options);
    if (operatingPoint.kind === "invalid") {
      return { reason: operatingPoint.reason, issues: operatingPoint.issues };
    }
    if (operatingPoint.kind === "complete") { return { result: operatingPoint.result }; }
    initialConditionDocument = operatingPoint.document;
    operatingPointIssues = operatingPoint.issues;
    operatingPointState = operatingPoint.state;
  }

  const capacitorGroups = findCapacitorGroups(initialConditionDocument, options.switchStates ?? {});
  if (capacitorGroups.reason) { return { reason: capacitorGroups.reason, issues: operatingPointIssues }; }
  const overrides = initialOverrides(initialConditionDocument);
  if (overrides === null) {
    return { reason: "交流電源の初期値を有限な数値で計算できません。", issues: operatingPointIssues };
  }
  const initialConstraints = operatingPointState
    ? initialConstraintsWithOperatingPointState(initialConditionDocument, operatingPointState)
    : initialVoltageConstraints(initialConditionDocument);
  if (!initialConstraints) {
    return {
      reason: "直流動作点からコンデンサ・コイルの厳密な蓄積状態を取得できませんでした。",
      issues: operatingPointIssues,
    };
  }
  for (const [partId, constraint] of overrides.voltageConstraints) {
    initialConstraints.set(partId, { ...initialConstraints.get(partId), ...constraint });
  }
  const analysis = solveAnalogStep(initialDocument(initialConditionDocument), {
    mode: "dc",
    switchStates: options.switchStates,
    voltageOverrides: overrides.voltageOverrides,
    initialInductorCurrents: true,
  }, undefined, initialConstraints);
  if (analysis.status !== "valid") {
    const context = useOperatingPoint ? "直流動作点からの初期状態" : "初期状態";
    return {
      reason: `${context}を満たす回路を計算できません。 ${analysis.message}`,
      issues: [...operatingPointIssues, ...analysis.issues],
    };
  }
  const measured = createSample(document, analysis, options.switchStates);
  if (!measured.sample || !measured.state) {
    return {
      reason: measured.reason ?? "初期波形を作成できませんでした。",
      issues: [...operatingPointIssues, ...analysis.issues],
    };
  }
  return {
    result: {
      sample: measured.sample,
      state: measured.state,
      issues: [...operatingPointIssues, ...analysis.issues],
    },
  };
}

interface NextStepResult {
  analysis?: ReturnType<typeof solveAnalogStep>;
  sample?: TransientSample;
  state?: StoredState;
  reason?: string;
}

function solveNextStep(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
  state: StoredState,
  timeSeconds: number,
  dt: number,
  previousTime: number,
  followingTimeSeconds?: number,
): NextStepResult {
  const transformed = makeStepDocument(document, state, dt);
  if (!transformed) { return { reason: "部品の値が過渡解析で扱える数値範囲を超えています。" }; }
  const acOverrides = sourceOverrides(document, timeSeconds, { timeSeconds: previousTime, stepSeconds: dt, voltages: state.acSourceVoltages }, followingTimeSeconds);
  if (acOverrides === null) { return { reason: `t=${timeSeconds} s の交流電源値を有限な数値で計算できません。` }; }
  const analysis = solveAnalogStep(transformed.document, {
    mode: "dc",
    switchStates: options.switchStates,
    voltageOverrides: { ...acOverrides.voltageOverrides, ...transformed.voltageOverrides },
  }, transformed.companionConstraints, acOverrides.voltageConstraints, state.analysis);
  if (analysis.status !== "valid") {
    return { analysis, reason: `t=${timeSeconds} s の解析に失敗しました。${analysis.message}` };
  }
  const measured = createSample(document, analysis, options.switchStates);
  if (!measured.sample || !measured.state) {
    return { analysis, reason: `t=${timeSeconds} s の波形を作成できませんでした。${measured.reason ?? ""}` };
  }
  return { analysis, sample: measured.sample, state: measured.state };
}

function timeAtStep(index: number, steps: number, options: TransientAnalysisOptions) {
  return index === steps
    ? options.durationSeconds
    : Math.min(index * options.timeStepSeconds, options.durationSeconds);
}

function runSteps(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
  steps: number,
  initial: InitialResult,
): TransientAnalysis {
  const issues = [...initial.issues];
  const samples: TransientSample[] = [{ timeSeconds: 0, parts: initial.sample.parts }];
  let state = initial.state;
  const energy = createTransientEnergyCollector(document);
  energy.append(samples[0]!, state.exactCapacitorVoltages, state.exactInductorCurrents, state.exactResistivePowers);
  let previousTime = 0;
  for (let index = 1; index <= steps; index += 1) {
    const timeSeconds = timeAtStep(index, steps, options);
    const dt = timeSeconds - previousTime;
    if (!Number.isFinite(dt) || dt <= 0) {
      return invalid("時間刻みが数値精度の範囲を下回りました。", issues, samples);
    }
    const result = solveNextStep(document, options, state, timeSeconds, dt, previousTime,
      index < steps ? timeAtStep(index + 1, steps, options) : undefined);
    if (result.analysis) { appendIssues(issues, result.analysis.issues); }
    if (result.reason || !result.sample || !result.state) {
      return invalid(result.reason ?? `t=${timeSeconds} s の波形を計算できませんでした。`, issues, samples);
    }
    const sample = { timeSeconds, parts: result.sample.parts };
    samples.push(sample);
    state = result.state;
    energy.append(sample, state.exactCapacitorVoltages, state.exactInductorCurrents, state.exactResistivePowers);
    previousTime = timeSeconds;
  }
  return { ...valid(`過渡解析が完了しました（${steps}ステップ）。`, issues, samples), energyReadings: energy.readings };
}

/** Simulates transient DC/time-domain behavior with backward Euler integration. */
export function simulateTransient(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
): TransientAnalysis {
  const capture = createExactExpressionCapture();
  const result = withExactExpressionCapture(capture, () => simulateTransientFromInput(document, options));
  if (capture.nodes.length === 0) { return result; }
  const precisionExpressions = freezeCapturedExactExpressions(capture);
  return { ...result, precisionExpressions,
    ...(result.energyReadings ? { energyPrecisionExpressions: snapshotExactExpressions(precisionExpressions) } : {}),
  };
}

function simulateTransientFromInput(
  inputDocument: CircuitDocument,
  inputOptions: TransientAnalysisOptions,
): TransientAnalysis {
  try {
    const context = new SimulationSnapshotContext();
    const document = validatedSimulationDocument(inputDocument, context);
    if (typeof document === "string") { return invalid(document); }
    const reactiveIssue = validateReactiveValues(document);
    if (reactiveIssue) { return invalid(reactiveIssue); }
    const options = validateOptions(inputOptions, document, context);
    if (typeof options === "string") { return invalid(options); }
    if (!context.isStable()) { return invalid("回路データまたは解析条件が取得中に変更されました。"); }
    if (!document.parts.length) { return invalid("過渡解析には部品が必要です。"); }
    const steps = stepCount(options.durationSeconds, options.timeStepSeconds);
    if (steps === null) {
      return invalid(`時間分割数は${MAX_TRANSIENT_STEPS}以下にしてください。解析時間または時間刻みを調整してください。`);
    }
    const limitIssue = exceedsLimits(document, steps);
    if (limitIssue) { return invalid(limitIssue); }
    const initial = initializeTransient(document, options);
    if (!initial.result) { return invalid(initial.reason ?? "初期値を計算できませんでした。", initial.issues); }
    return runSteps(document, options, steps, initial.result);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    return invalid(`回路データを過渡解析できませんでした。${detail}`);
  }
}
