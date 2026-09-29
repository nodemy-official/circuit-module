import { solveAnalogStep, type InitialVoltageConstraint, type TransientCompanionConstraint } from "./analog-solver.js";
import { exactComponentSum, exactProductQuotient, exactProductSumRatio, scaledProduct } from "./analog-math.js";
import { exactComplexValue } from "./exact-numeric-state.js";
import {
  numberToExactRational,
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
import { isSimulationArray, isSimulationRecord } from "./simulation-input.js";

export const MAX_TRANSIENT_STEPS = 2000;
/** Maximum estimated dense MNA scalar operations across every sample. */
export const MAX_TRANSIENT_SOLVER_WORK = 500_000_000;

export interface TransientPartReading {
  /** Signed primary voltage: A−B, BJT C−E, MOSFET D−S, or op-amp output−GND. */
  voltageVolts: number;
  /** Signed current entering the primary terminal (normally A; op-amp output C). */
  currentAmps: number;
  /** Instantaneous power absorbed by the part; positive is absorbed, negative is delivered. */
  powerWatts: number;
  /** Potentials relative to the solver reference and signed currents entering physical terminals. */
  terminalVoltages?: Partial<Record<CircuitTerminal, number>>;
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
}

export interface TransientAnalysisOptions {
  durationSeconds: number;
  timeStepSeconds: number;
  switchStates?: Record<string, boolean>;
  startFromOperatingPoint?: boolean;
}

interface StoredState {
  capacitorVoltages: Map<string, number>;
  exactCapacitorVoltages: Map<string, ExactRational>;
  inductorCurrents: Map<string, number>;
  exactInductorCurrents: Map<string, ExactRational>;
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

const TWO_PI = 2 * Math.PI;
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
  const ratio = duration / timeStep;
  if (!Number.isFinite(ratio) || ratio <= 0) { return null; }
  const nearest = Math.round(ratio);
  const tolerance = Number.EPSILON * Math.max(1, ratio) * 8;
  const count = Math.max(1, Math.abs(ratio - nearest) <= tolerance ? nearest : Math.ceil(ratio));
  return count <= MAX_TRANSIENT_STEPS ? count : null;
}

function validateOptions(options: unknown, document: CircuitDocument): string | null {
  if (!isSimulationRecord(options)) { return "解析条件はオブジェクトで指定してください。"; }
  const duration = options.durationSeconds;
  const timeStep = options.timeStepSeconds;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 ||
      typeof timeStep !== "number" || !Number.isFinite(timeStep) || timeStep <= 0) {
    return "解析時間と時間刻みは、有限な正の数値で指定してください。";
  }
  if (options.startFromOperatingPoint !== undefined && typeof options.startFromOperatingPoint !== "boolean") {
    return "直流動作点から開始する設定は真偽値で指定してください。";
  }
  if (options.switchStates !== undefined) {
    if (!isSimulationRecord(options.switchStates) || options.switchStates instanceof Map || options.switchStates instanceof Set) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
    const switchIds = new Set(document.parts.filter((part) => part.kind === "switch").map(({ id }) => id));
    for (const [partId, state] of Object.entries(options.switchStates)) {
      if (!switchIds.has(partId)) {
        return `スイッチ状態の対象「${partId}」はスイッチ部品ではありません。`;
      }
      if (typeof state !== "boolean") {
        return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
      }
    }
  }
  return null;
}

function validatePartShape(value: unknown, index: number, parts: Map<string, Record<string, unknown>>) {
  if (!isSimulationRecord(value) || typeof value.id !== "string" || value.id.trim() === "") {
    return `部品${index + 1}の ID が正しくありません。`;
  }
  if (parts.has(value.id)) { return `部品 ID「${value.id}」が重複しています。`; }
  if (typeof value.kind !== "string" || !Object.hasOwn(circuitPartCatalog, value.kind)) {
    return `部品「${value.id}」の種類が不明です。`;
  }
  if (typeof value.label !== "string") { return `部品「${value.id}」のラベルが正しくありません。`; }
  parts.set(value.id, value);
  return null;
}

function validatePartsShape(values: unknown[]): { parts?: Map<string, Record<string, unknown>>; reason?: string } {
  const parts = new Map<string, Record<string, unknown>>();
  for (const [index, value] of values.entries()) {
    const issue = validatePartShape(value, index, parts);
    if (issue) { return { reason: issue }; }
  }
  return { parts };
}

function validateWireShape(
  value: unknown,
  index: number,
  parts: ReadonlyMap<string, Record<string, unknown>>,
  wireIds: Set<string>,
) {
  if (!isSimulationRecord(value) || typeof value.id !== "string" || value.id.trim() === "") {
    return `導線${index + 1}の ID が正しくありません。`;
  }
  if (wireIds.has(value.id)) { return `導線 ID「${value.id}」が重複しています。`; }
  wireIds.add(value.id);
  const fromIssue = validateEndpointShape(value.from, parts, `導線${index + 1}の始点`);
  if (fromIssue) { return fromIssue; }
  const toIssue = validateEndpointShape(value.to, parts, `導線${index + 1}の終点`);
  if (toIssue) { return toIssue; }
  if (sameEndpointValues(value.from, value.to)) {
    return `導線${index + 1}は同じ端子同士を接続しています。`;
  }
  return null;
}

function validateWiresShape(values: unknown[], parts: ReadonlyMap<string, Record<string, unknown>>) {
  const wireIds = new Set<string>();
  for (const [index, value] of values.entries()) {
    const issue = validateWireShape(value, index, parts, wireIds);
    if (issue) { return issue; }
  }
  return null;
}

function validateDocumentShape(input: unknown): string | null {
  if (!isSimulationRecord(input) || !isSimulationArray(input.parts) || !isSimulationArray(input.wires)) {
    return "回路データには部品一覧と導線一覧が必要です。";
  }
  const partResult = validatePartsShape(input.parts);
  if (!partResult.parts) { return partResult.reason ?? "部品一覧が正しくありません。"; }
  return validateWiresShape(input.wires, partResult.parts);
}

function validateEndpointShape(
  value: unknown,
  parts: ReadonlyMap<string, Record<string, unknown>>,
  label: string,
): string | null {
  if (!isSimulationRecord(value) || typeof value.partId !== "string" ||
      (value.terminal !== "a" && value.terminal !== "b" && value.terminal !== "c")) {
    return `${label}の端子指定が正しくありません。`;
  }
  const part = parts.get(value.partId);
  if (!part) { return `${label}の部品「${value.partId}」が見つかりません。`; }
  const kind = part.kind as CircuitPart["kind"];
  if (!circuitPartCatalog[kind].terminals.includes(value.terminal as CircuitTerminal)) {
    return `${label}の端子「${value.terminal}」はこの部品にありません。`;
  }
  return null;
}

function sameEndpointValues(first: unknown, second: unknown) {
  if (!isSimulationRecord(first) || !isSimulationRecord(second)) { return false; }
  return first.partId === second.partId && first.terminal === second.terminal;
}

function validateNumericFieldValue(part: CircuitPart, field: ReturnType<typeof circuitPartNumericFields>[number]) {
  const value = (part as unknown as Record<string, unknown>)[field.key];
  if (value === undefined) { return null; }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${part.label}の${field.label}は有限な数値で指定してください。`;
  }
  if (field.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) {
    const comparator = field.exclusiveMin ? "より大きい" : "以上";
    return `${part.label}の${field.label}は${field.min}${field.unit}${comparator}の数値で指定してください。`;
  }
  if (field.max !== undefined && value > field.max) {
    return `${part.label}の${field.label}は${field.max}${field.unit}以下の数値で指定してください。`;
  }
  return null;
}

function validateReactivePart(part: CircuitPart) {
  for (const field of circuitPartNumericFields(part.kind)) {
    const issue = validateNumericFieldValue(part, field);
    if (issue) { return issue; }
  }
  if (part.kind === "ac-source" && timeVoltage(part, 0) === null) {
    return `${part.label}の交流設定は有限な値で指定してください。`;
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
  };
}

function quadrantalTimeVoltage(rms: number, phaseDegrees: number, timeQuadrant = 0) {
  const phaseQuadrant = Math.round(phaseDegrees / 90);
  return quadrantVoltage(rms, ((timeQuadrant + phaseQuadrant) % 4 + 4) % 4, phaseDegrees - phaseQuadrant * 90);
}

function quadrantVoltage(rms: number, quadrant: number, offsetDegrees: number) {
  const nearAxis = Math.abs(offsetDegrees) < 1e-7;
  const offsetRadians = offsetDegrees * (Math.PI / 180);
  const alongAxis = nearAxis ? rms : rms * Math.cos(offsetRadians);
  const acrossAxis = nearAxis
    ? (rms * (Math.PI / 180)) * offsetDegrees
    : rms * Math.sin(offsetRadians);
  return quadrant === 0 ? alongAxis : quadrant === 1 ? -acrossAxis
    : quadrant === 2 ? -alongAxis : acrossAxis;
}

function offsetPeakVoltage(offset: number, acVoltage: number) {
  const voltage = offset + Math.SQRT2 * acVoltage;
  // The peak can overflow even when the offset leaves a finite voltage.
  return !Number.isFinite(voltage) && Number.isFinite(acVoltage)
    ? Math.SQRT2 * (acVoltage + offset / Math.SQRT2)
    : voltage;
}

function smallTurnVoltage(rms: number, phaseDegrees: number, frequency: number, timeSeconds: number, offset: number) {
  const cosine = quadrantalTimeVoltage(rms, phaseDegrees);
  const sine = quadrantalTimeVoltage(rms, phaseDegrees, 3);
  const turns = frequency * timeSeconds;
  if (Math.abs(turns) >= 2 ** -1022) {
    const halfSine = Math.sin(Math.PI * turns);
    // cos(p+t)-cos(p) = -sin(p)sin(t)-2cos(p)sin(t/2)^2.
    // Apply the offset to the initial value before adding either difference.
    return exactComponentSum([
      offsetPeakVoltage(offset, cosine),
      scaledProduct([-Math.SQRT2, sine, Math.sin(TWO_PI * turns)]),
      scaledProduct([-2, Math.SQRT2, cosine, halfSine, halfSine]),
    ]);
  }
  // Apply the DC offset before tiny time corrections so cancellation of the
  // initial voltage cannot erase a representable derivative. At subnormal
  // turns, all terms beyond the quadratic term underflow even at maximum RMS.
  return exactComponentSum([
    offsetPeakVoltage(offset, cosine),
    scaledProduct([-Math.SQRT2, sine, frequency, timeSeconds, TWO_PI]),
    scaledProduct([-0.5, Math.SQRT2, cosine, frequency, timeSeconds, TWO_PI, frequency, timeSeconds, TWO_PI]),
  ]);
}

function timeVoltage(part: CircuitPart, timeSeconds: number): number | null {
  const rms = part.voltageVolts ?? DEFAULT_AC_RMS;
  const frequency = part.frequencyHz ?? DEFAULT_AC_FREQUENCY;
  const phaseDegrees = (part.phaseDegrees ?? DEFAULT_AC_PHASE) % 360;
  const offset = part.offsetVolts ?? DEFAULT_AC_OFFSET;
  if (!Number.isFinite(rms) || rms < 0 || !Number.isFinite(frequency) || frequency <= 0 ||
      !Number.isFinite(phaseDegrees) || !Number.isFinite(offset) || !Number.isFinite(timeSeconds)) { return null; }
  const turns = frequency * timeSeconds;
  let voltage: number;
  if (timeSeconds !== 0 && (Math.abs(turns) < 2 ** -1022 ||
      (Math.abs(turns) < 1e-8 && offset !== 0))) {
    voltage = smallTurnVoltage(rms, phaseDegrees, frequency, timeSeconds, offset);
  } else {
    const time = exactTimeQuadrant(frequency, timeSeconds, phaseDegrees);
    voltage = offsetPeakVoltage(offset, quadrantVoltage(rms, time.quadrant, time.offsetDegrees));
  }
  return Number.isFinite(voltage) ? voltage : null;
}

function sourceOverrides(document: CircuitDocument, timeSeconds: number): Record<string, number> | null {
  const overrides = Object.create(null) as Record<string, number>;
  for (const part of document.parts) {
    if (part.kind !== "ac-source") { continue; }
    const voltage = timeVoltage(part, timeSeconds);
    if (voltage === null) { return null; }
    overrides[part.id] = voltage;
  }
  return overrides;
}

function initialOverrides(
  document: CircuitDocument,
): Record<string, number> | null {
  const overrides = sourceOverrides(document, 0);
  if (overrides === null) { return null; }
  for (const part of document.parts) {
    if (part.kind === "capacitor") {
      overrides[part.id] = part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE;
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

function acSourceInitialVoltageDerivative(part: CircuitPart) {
  if (part.kind !== "ac-source") { return null; }
  const phase = (part.phaseDegrees ?? DEFAULT_AC_PHASE) % 360;
  const quarter = Math.round(phase / 90);
  const quadrant = ((quarter % 4) + 4) % 4;
  const offsetDegrees = phase - quarter * 90;
  const oddQuadrant = quadrant % 2 !== 0;
  const factors = [
    quadrant < 2 ? -1 : 1,
    Math.SQRT2,
    part.voltageVolts ?? DEFAULT_AC_RMS,
    2,
    Math.PI,
    part.frequencyHz ?? DEFAULT_AC_FREQUENCY,
  ];
  // The trig boundary is approximate. Below 1e-7 degrees, sin(x)=x
  // and cos(x)=1 have errors below binary64 precision; keeping the
  // remaining factors exact also preserves tiny slopes before C scaling.
  const nearAxis = Math.abs(offsetDegrees) < 1e-7;
  return nearAxis && !oddQuadrant
    ? exactProductSumRatio([{ factors: [...factors, offsetDegrees, Math.PI] }], 180)
    : exactProductSumRatio([{
      factors: [...factors, nearAxis ? 1 : oddQuadrant
        ? Math.cos((offsetDegrees * Math.PI) / 180)
        : Math.sin((offsetDegrees * Math.PI) / 180)],
    }], 1);
}

function initialVoltageConstraints(document: CircuitDocument) {
  const constraints = new Map<string, InitialVoltageConstraint>();
  for (const part of document.parts) {
    if (part.kind === "capacitor") {
      constraints.set(part.id, { capacitanceFarads: part.capacitanceFarads ?? DEFAULT_CAPACITANCE });
      continue;
    }
    const voltageDerivative = acSourceInitialVoltageDerivative(part);
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
  if (!Number.isFinite(resistance) || resistance <= 0 || !Number.isFinite(previousVoltage) ||
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
  return { ...part, kind: "battery", voltageVolts: 1, internalResistanceOhms: resistance };
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
  const sourceVoltage = exactPreviousCurrent
    ? -exactProductQuotient([inductance, exactPreviousCurrent], dt)
    : Number.NaN;
  if (!Number.isFinite(resistance) || resistance <= 0 || !Number.isFinite(sourceVoltage) ||
      !exactPreviousCurrent) { return part; }
  voltageOverrides[part.id] = sourceVoltage;
  companionConstraints.set(part.id, {
    kind: "inductor",
    numerator: inductance,
    denominator: dt,
    historyValue: previousCurrent,
    exactHistoryValue: exactPreviousCurrent,
  });
  return { ...part, kind: "battery", voltageVolts: 1, internalResistanceOhms: resistance };
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
  if (!Number.isFinite(currentAmps) || !Number.isFinite(powerWatts) || !exactVoltage || !exactCurrent) {
    return { reason: `${part.label || part.id}の過渡値が数値範囲を超えました。` };
  }
  return {
    reading: {
      voltageVolts, currentAmps, powerWatts,
      ...(reading.meterStatus ? { meterStatus: reading.meterStatus } : {}),
      ...(reading.channelConducting === undefined ? {} : { channelConducting: reading.channelConducting }),
      terminalVoltages: Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, value.real])),
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
  for (const part of document.parts) {
    const result = samplePart(part, analysis.parts[part.id]);
    if ("reason" in result) { return { reason: result.reason }; }
    if (part.kind === "switch") { result.reading.switchClosed = isSwitchClosed(part, switchStates); }
    parts[part.id] = result.reading;
    if (result.capacitorVoltage !== undefined) { capacitorVoltages.set(part.id, result.capacitorVoltage); }
    if (result.exactCapacitorVoltage) { exactCapacitorVoltages.set(part.id, result.exactCapacitorVoltage); }
    if (result.inductorCurrent !== undefined) { inductorCurrents.set(part.id, result.inductorCurrent); }
    if (result.exactInductorCurrent) { exactInductorCurrents.set(part.id, result.exactInductorCurrent); }
  }
  return {
    sample: { timeSeconds: 0, parts },
    state: { capacitorVoltages, exactCapacitorVoltages, inductorCurrents, exactInductorCurrents },
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

function initializeTransient(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
): { result?: InitialResult; reason?: string; issues?: CircuitIssue[] } {
  const useOperatingPoint = options.startFromOperatingPoint ?? false;
  const capacitorGroups = useOperatingPoint
    ? { groups: [] as CapacitorGroup[] }
    : findCapacitorGroups(document, options.switchStates ?? {});
  if (capacitorGroups.reason) { return { reason: capacitorGroups.reason }; }
  const overrides = useOperatingPoint ? {} : initialOverrides(document);
  if (overrides === null) { return { reason: "交流電源の初期値を有限な数値で計算できません。" }; }
  const initialDocumentForSolve = useOperatingPoint ? document : initialDocument(document);
  const analysis = solveAnalogStep(initialDocumentForSolve, {
    mode: "dc",
    switchStates: options.switchStates,
    voltageOverrides: overrides,
    initialInductorCurrents: !useOperatingPoint,
  }, undefined, useOperatingPoint ? undefined : initialVoltageConstraints(document));
  if (analysis.status !== "valid") {
    const context = useOperatingPoint ? "直流動作点" : "初期状態";
    return { reason: `${context}を満たす回路を計算できません。 ${analysis.message}`, issues: analysis.issues };
  }
  const measured = createSample(document, analysis, options.switchStates);
  if (!measured.sample || !measured.state) {
    return { reason: measured.reason ?? "初期波形を作成できませんでした。", issues: analysis.issues };
  }
  return { result: { sample: measured.sample, state: measured.state, issues: analysis.issues } };
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
): NextStepResult {
  const transformed = makeStepDocument(document, state, dt);
  if (!transformed) { return { reason: "部品の値が過渡解析で扱える数値範囲を超えています。" }; }
  const acOverrides = sourceOverrides(document, timeSeconds);
  if (acOverrides === null) { return { reason: `t=${timeSeconds} s の交流電源値を有限な数値で計算できません。` }; }
  const analysis = solveAnalogStep(transformed.document, {
    mode: "dc",
    switchStates: options.switchStates,
    voltageOverrides: { ...acOverrides, ...transformed.voltageOverrides },
  }, transformed.companionConstraints);
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
  let previousTime = 0;
  for (let index = 1; index <= steps; index += 1) {
    const timeSeconds = timeAtStep(index, steps, options);
    const dt = timeSeconds - previousTime;
    if (!Number.isFinite(dt) || dt <= 0) {
      return invalid("時間刻みが数値精度の範囲を下回りました。", issues, samples);
    }
    const result = solveNextStep(document, options, state, timeSeconds, dt);
    if (result.analysis) { appendIssues(issues, result.analysis.issues); }
    if (result.reason || !result.sample || !result.state) {
      return invalid(result.reason ?? `t=${timeSeconds} s の波形を計算できませんでした。`, issues, samples);
    }
    samples.push({ timeSeconds, parts: result.sample.parts });
    state = result.state;
    previousTime = timeSeconds;
  }
  return valid(`過渡解析が完了しました（${steps}ステップ）。`, issues, samples);
}

/** Simulates transient DC/time-domain behavior with backward Euler integration. */
export function simulateTransient(
  document: CircuitDocument,
  options: TransientAnalysisOptions,
): TransientAnalysis {
  try {
    const shapeIssue = validateDocumentShape(document);
    if (shapeIssue) { return invalid(shapeIssue); }
    const reactiveIssue = validateReactiveValues(document);
    if (reactiveIssue) { return invalid(reactiveIssue); }
    const optionsIssue = validateOptions(options, document);
    if (optionsIssue) { return invalid(optionsIssue); }
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
