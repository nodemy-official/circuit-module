import { solveAnalogStep } from "./analog-solver.js";
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
  inductorCurrents: Map<string, number>;
}

interface CapacitorMember {
  partId: string;
  capacitanceFarads: number;
  initialVoltageVolts: number;
  orientation: 1 | -1;
}

interface CapacitorGroup {
  members: CapacitorMember[];
  representativeId: string;
  representativeVoltageVolts: number;
  totalCapacitanceFarads: number;
  isShorted: boolean;
}

interface TransformedStep {
  document: CircuitDocument;
  voltageOverrides: Record<string, number>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptions(options: unknown): string | null {
  if (!isRecord(options)) { return "解析条件はオブジェクトで指定してください。"; }
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
    if (!isRecord(options.switchStates)) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
    if (Object.values(options.switchStates).some((state) => typeof state !== "boolean")) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
  }
  return null;
}

function validatePartShape(value: unknown, index: number, parts: Map<string, Record<string, unknown>>) {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "") {
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
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "") {
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
  if (!isRecord(input) || !Array.isArray(input.parts) || !Array.isArray(input.wires)) {
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
  if (!isRecord(value) || typeof value.partId !== "string" ||
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
  if (!isRecord(first) || !isRecord(second)) { return false; }
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
    representativeId: part.id,
    representativeVoltageVolts: part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE,
    totalCapacitanceFarads: 0,
    isShorted: nodeA === nodeB,
  };
  const capacitanceFarads = part.capacitanceFarads ?? DEFAULT_CAPACITANCE;
  const initialVoltageVolts = part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE;
  group.members.push({
    partId: part.id,
    capacitanceFarads,
    initialVoltageVolts,
    orientation: nodeA === firstNode ? 1 : -1,
  });
  group.totalCapacitanceFarads += capacitanceFarads;
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
  if (!Number.isFinite(group.totalCapacitanceFarads) || group.totalCapacitanceFarads <= 0) {
    return "並列コンデンサの合成容量が数値範囲を超えています。";
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
  const capacitorCount = document.parts.filter((part) => part.kind === "capacitor").length;
  const potentiometerCount = document.parts.filter((part) => part.kind === "potentiometer").length;
  const dimensionBound = Math.max(1, terminalCount + document.parts.length + capacitorCount * 3 + potentiometerCount);
  if (dimensionBound ** 3 * steps > MAX_TRANSIENT_SOLVER_WORK) {
    return "過渡解析の演算量が上限を超えています。部品数または時間分割数を減らしてください。";
  }
  return null;
}

function uniqueId(base: string, used: Set<string>) {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function timeVoltage(part: CircuitPart, timeSeconds: number): number | null {
  const rms = part.voltageVolts ?? DEFAULT_AC_RMS;
  const frequency = part.frequencyHz ?? DEFAULT_AC_FREQUENCY;
  const phase = (part.phaseDegrees ?? DEFAULT_AC_PHASE) * Math.PI / 180;
  const offset = part.offsetVolts ?? DEFAULT_AC_OFFSET;
  if (!Number.isFinite(rms) || rms < 0 || !Number.isFinite(frequency) || frequency <= 0 ||
      !Number.isFinite(phase) || !Number.isFinite(offset)) { return null; }
  const angle = TWO_PI * frequency * timeSeconds + phase;
  if (!Number.isFinite(angle)) { return null; }
  const voltage = offset + Math.SQRT2 * rms * Math.cos(angle);
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
  groups: readonly CapacitorGroup[],
): Record<string, number> | null {
  const overrides = sourceOverrides(document, 0);
  if (overrides === null) { return null; }
  for (const group of groups) {
    if (!group.isShorted) { overrides[group.representativeId] = group.representativeVoltageVolts; }
  }
  return overrides;
}

function initialDocument(document: CircuitDocument, groups: readonly CapacitorGroup[]): CircuitDocument {
  const capacitorGroupById = new Map<string, CapacitorGroup>();
  for (const group of groups) {
    for (const member of group.members) { capacitorGroupById.set(member.partId, group); }
  }
  return {
    ...document,
    parts: document.parts.map((part): CircuitPart => {
      if (part.kind === "capacitor") {
        const group = capacitorGroupById.get(part.id);
        if (!group || group.isShorted || group.representativeId !== part.id) {
          return { ...part, kind: "current-source", currentAmps: 0 };
        }
        return {
          ...part,
          kind: "battery",
          voltageVolts: 1,
          internalResistanceOhms: 0,
        };
      }
      if (part.kind === "inductor") {
        return {
          ...part,
          kind: "current-source",
          currentAmps: part.initialCurrentAmps ?? DEFAULT_INITIAL_CURRENT,
        };
      }
      return part;
    }),
  };
}

function makeStepDocument(document: CircuitDocument, state: StoredState, dt: number): TransformedStep | null {
  const usedIds = new Set([...document.parts.map(({ id }) => id), ...document.wires.map(({ id }) => id)]);
  const additionalParts: CircuitPart[] = [];
  const additionalWires: CircuitDocument["wires"] = [];
  const voltageOverrides = Object.create(null) as Record<string, number>;
  const parts = document.parts.map((part): CircuitPart => {
    if (part.kind === "capacitor") {
      const capacitance = part.capacitanceFarads ?? DEFAULT_CAPACITANCE;
      const previousVoltage = state.capacitorVoltages.get(part.id) ?? part.initialVoltageVolts ?? DEFAULT_INITIAL_VOLTAGE;
      const conductance = capacitance / dt;
      const resistance = dt / capacitance;
      const historyCurrent = -conductance * previousVoltage;
      if (!Number.isFinite(conductance) || conductance <= 0 || !Number.isFinite(resistance) ||
          resistance <= 0 || !Number.isFinite(historyCurrent)) { return part; }

      const historyPartId = uniqueId(`__transient_${part.id}_history`, usedIds);
      const wireA = uniqueId(`__transient_${part.id}_history_a`, usedIds);
      const wireB = uniqueId(`__transient_${part.id}_history_b`, usedIds);
      additionalParts.push({
        ...part,
        id: historyPartId,
        kind: "current-source",
        label: `${part.label} の履歴電流`,
        currentAmps: historyCurrent,
      });
      additionalWires.push(
        { id: wireA, from: { partId: part.id, terminal: "a" }, to: { partId: historyPartId, terminal: "a" } },
        { id: wireB, from: { partId: part.id, terminal: "b" }, to: { partId: historyPartId, terminal: "b" } },
      );
      return { ...part, kind: "resistor", resistanceOhms: resistance };
    }
    if (part.kind === "inductor") {
      const inductance = part.inductanceHenries ?? DEFAULT_INDUCTANCE;
      const previousCurrent = state.inductorCurrents.get(part.id) ?? part.initialCurrentAmps ?? DEFAULT_INITIAL_CURRENT;
      const resistance = inductance / dt;
      const sourceVoltage = -resistance * previousCurrent;
      if (!Number.isFinite(resistance) || resistance <= 0 || !Number.isFinite(sourceVoltage)) { return part; }
      voltageOverrides[part.id] = sourceVoltage;
      return { ...part, kind: "battery", voltageVolts: 1, internalResistanceOhms: resistance };
    }
    return part;
  });

  if (parts.some((part) => part.kind === "capacitor" || part.kind === "inductor")) { return null; }
  return {
    document: { ...document, parts: [...parts, ...additionalParts], wires: [...document.wires, ...additionalWires] },
    voltageOverrides,
  };
}

function readingFinite(reading: { voltage: { real: number }; current: { real: number }; power: { real: number } }) {
  return Number.isFinite(reading.voltage.real) && Number.isFinite(reading.current.real) &&
    Number.isFinite(reading.power.real);
}

type PartSampleResult =
  | { reading: TransientPartReading; capacitorVoltage?: number; inductorCurrent?: number }
  | { reason: string };

function samplePart(
  part: CircuitPart,
  reading: ReturnType<typeof solveAnalogStep>["parts"][string] | undefined,
  previousState: StoredState | null,
  dt: number,
): PartSampleResult {
  if (!reading || !readingFinite(reading)) {
    return { reason: `${part.label || part.id}の電圧・電流を有限値で計算できません。` };
  }
  const voltageVolts = reading.voltage.real;
  let currentAmps = reading.current.real;
  if (part.kind === "capacitor") {
    const previousVoltage = previousState?.capacitorVoltages.get(part.id);
    if (previousVoltage !== undefined) {
      const capacitance = part.capacitanceFarads ?? DEFAULT_CAPACITANCE;
      currentAmps = capacitance / dt * (voltageVolts - previousVoltage);
    }
  }
  const powerWatts = part.kind === "capacitor" || part.kind === "inductor"
    ? voltageVolts * currentAmps
    : reading.power.real;
  if (!Number.isFinite(currentAmps) || !Number.isFinite(powerWatts)) {
    return { reason: `${part.label || part.id}の過渡値が数値範囲を超えました。` };
  }
  return {
    reading: {
      voltageVolts, currentAmps, powerWatts,
      ...(reading.meterStatus ? { meterStatus: reading.meterStatus } : {}),
      terminalVoltages: Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, value.real])),
      terminalCurrents: part.kind === "capacitor" || part.kind === "inductor"
        ? { a: currentAmps, b: -currentAmps }
        : Object.fromEntries(Object.entries(reading.terminalCurrents).map(([terminal, value]) => [terminal, value.real])),
    },
    ...(part.kind === "capacitor" ? { capacitorVoltage: voltageVolts } : {}),
    ...(part.kind === "inductor" ? { inductorCurrent: currentAmps } : {}),
  };
}

function createSample(
  document: CircuitDocument,
  analysis: ReturnType<typeof solveAnalogStep>,
  previousState: StoredState | null,
  dt: number,
  switchStates: Record<string, boolean> = {},
): { sample?: TransientSample; state?: StoredState; reason?: string } {
  const parts = Object.create(null) as Record<string, TransientPartReading>;
  const capacitorVoltages = new Map<string, number>();
  const inductorCurrents = new Map<string, number>();
  for (const part of document.parts) {
    const result = samplePart(part, analysis.parts[part.id], previousState, dt);
    if ("reason" in result) { return { reason: result.reason }; }
    if (part.kind === "switch") { result.reading.switchClosed = isSwitchClosed(part, switchStates); }
    parts[part.id] = result.reading;
    if (result.capacitorVoltage !== undefined) { capacitorVoltages.set(part.id, result.capacitorVoltage); }
    if (result.inductorCurrent !== undefined) { inductorCurrents.set(part.id, result.inductorCurrent); }
  }
  return {
    sample: { timeSeconds: 0, parts },
    state: { capacitorVoltages, inductorCurrents },
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
  const groups = capacitorGroups.groups ?? [];
  const overrides = useOperatingPoint ? {} : initialOverrides(document, groups);
  if (overrides === null) { return { reason: "交流電源の初期値を有限な数値で計算できません。" }; }
  const solverDocument = useOperatingPoint ? document : initialDocument(document, groups);
  const analysis = solveAnalogStep(solverDocument, {
    mode: "dc",
    switchStates: options.switchStates,
    voltageOverrides: overrides,
  });
  if (analysis.status !== "valid") {
    const context = useOperatingPoint ? "直流動作点" : "初期状態";
    return { reason: `${context}を満たす回路を計算できません。 ${analysis.message}`, issues: analysis.issues };
  }
  const measured = createSample(document, analysis, null, options.timeStepSeconds, options.switchStates);
  if (!measured.sample || !measured.state) {
    return { reason: measured.reason ?? "初期波形を作成できませんでした。", issues: analysis.issues };
  }
  if (!useOperatingPoint) {
    const originalCapacitorCurrents = capacitorTerminalCurrents(document, measured.sample);
    distributeInitialCapacitorCurrents(measured.sample, groups);
    reconstructInitialIdealBranchCurrents(
      document,
      measured.sample,
      options.switchStates ?? {},
      originalCapacitorCurrents,
    );
  }
  return { result: { sample: measured.sample, state: measured.state, issues: analysis.issues } };
}

function distributeInitialCapacitorCurrents(sample: TransientSample, groups: readonly CapacitorGroup[]) {
  for (const group of groups) {
    if (group.isShorted) {
      for (const member of group.members) {
        const reading = sample.parts[member.partId];
        if (reading) {
          reading.currentAmps = 0;
          reading.terminalCurrents = { a: 0, b: 0 };
          reading.powerWatts = reading.voltageVolts * reading.currentAmps;
        }
      }
      continue;
    }
    const representative = group.members.find(({ partId }) => partId === group.representativeId);
    const sourceReading = sample.parts[group.representativeId];
    if (!representative || !sourceReading) { continue; }
    const canonicalCurrent = sourceReading.currentAmps * representative.orientation;
    for (const member of group.members) {
      const reading = sample.parts[member.partId];
      if (!reading) { continue; }
      const currentShare = member.capacitanceFarads / group.totalCapacitanceFarads;
      reading.currentAmps = canonicalCurrent * member.orientation * currentShare;
      reading.terminalCurrents = { a: reading.currentAmps, b: -reading.currentAmps };
      reading.powerWatts = reading.voltageVolts * reading.currentAmps;
    }
  }
}

interface InitialIdealBranch {
  part: CircuitPart;
  nodeA: string;
  nodeB: string;
  currentAmps: number;
}

type CapacitorTerminalCurrents = Partial<Record<CircuitTerminal, number>>;

function capacitorTerminalCurrents(document: CircuitDocument, sample: TransientSample) {
  const currents = new Map<string, CapacitorTerminalCurrents>();
  for (const part of document.parts) {
    if (part.kind !== "capacitor") { continue; }
    const reading = sample.parts[part.id];
    if (reading) { currents.set(part.id, { ...reading.terminalCurrents }); }
  }
  return currents;
}

function initialIdealBranches(
  document: CircuitDocument,
  sample: TransientSample,
  switchStates: Record<string, boolean>,
  wireNodes: EndpointSet,
) {
  const branches: InitialIdealBranch[] = [];
  for (const part of document.parts) {
    if (part.kind !== "ammeter" && !(part.kind === "switch" && isSwitchClosed(part, switchStates))) {
      continue;
    }
    const reading = sample.parts[part.id];
    if (!reading) { continue; }
    const nodeA = wireNodes.find(endpointKey(part.id, "a"));
    const nodeB = wireNodes.find(endpointKey(part.id, "b"));
    if (nodeA === nodeB) { continue; }
    const branch = {
      part,
      nodeA,
      nodeB,
      currentAmps: reading.terminalCurrents?.a ?? reading.currentAmps,
    };
    branches.push(branch);
  }
  return branches;
}

function initialCapacitorCurrentDeltas(
  document: CircuitDocument,
  sample: TransientSample,
  originalCapacitorCurrents: ReadonlyMap<string, CapacitorTerminalCurrents>,
  wireNodes: EndpointSet,
) {
  const residualByNode = new Map<string, number>();
  const addResidual = (node: string, current: number) => {
    residualByNode.set(node, (residualByNode.get(node) ?? 0) + current);
  };
  for (const part of document.parts) {
    if (part.kind !== "capacitor") { continue; }
    const reading = sample.parts[part.id];
    if (!reading) { continue; }
    for (const terminal of circuitPartCatalog[part.kind].terminals) {
      const currentDelta = (reading.terminalCurrents?.[terminal] ?? 0) -
        (originalCapacitorCurrents.get(part.id)?.[terminal] ?? 0);
      if (currentDelta !== 0) { addResidual(wireNodes.find(endpointKey(part.id, terminal)), currentDelta); }
    }
  }
  return residualByNode;
}

function idealBranchAdjacency(branches: readonly InitialIdealBranch[]) {
  const adjacency = new Map<string, InitialIdealBranch[]>();
  for (const branch of branches) {
    const nodeAEdges = adjacency.get(branch.nodeA) ?? [];
    nodeAEdges.push(branch);
    adjacency.set(branch.nodeA, nodeAEdges);
    const nodeBEdges = adjacency.get(branch.nodeB) ?? [];
    nodeBEdges.push(branch);
    adjacency.set(branch.nodeB, nodeBEdges);
  }
  return adjacency;
}

interface IdealBranchForest {
  parentBranches: Map<string, InitialIdealBranch>;
  treeBranches: Set<InitialIdealBranch>;
  roots: string[];
}

function idealBranchForest(adjacency: Map<string, InitialIdealBranch[]>): IdealBranchForest {
  const parentBranches = new Map<string, InitialIdealBranch>();
  const treeBranches = new Set<InitialIdealBranch>();
  const visited = new Set<string>();
  const roots: string[] = [];
  for (const start of adjacency.keys()) {
    if (visited.has(start)) { continue; }
    roots.push(start);
    visited.add(start);
    const pending = [start];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) { continue; }
      for (const branch of adjacency.get(node) ?? []) {
        const other = branch.nodeA === node ? branch.nodeB : branch.nodeA;
        if (visited.has(other)) { continue; }
        visited.add(other);
        parentBranches.set(other, branch);
        treeBranches.add(branch);
        pending.push(other);
      }
    }
  }
  return {
    parentBranches,
    treeBranches,
    roots,
  };
}

function idealBranchCurrentDeltas(
  adjacency: Map<string, InitialIdealBranch[]>,
  residualByNode: ReadonlyMap<string, number>,
  forest: IdealBranchForest,
) {
  const balancedBranches = new Map<InitialIdealBranch, number>();
  const balanceSubtree = (node: string, parentBranch?: InitialIdealBranch): number => {
    let subtreeResidual = residualByNode.get(node) ?? 0;
    for (const branch of adjacency.get(node) ?? []) {
      if (branch === parentBranch || !forest.treeBranches.has(branch)) { continue; }
      const child = branch.nodeA === node ? branch.nodeB : branch.nodeA;
      if (forest.parentBranches.get(child) !== branch) { continue; }
      const childResidual = balanceSubtree(child, branch);
      const childSign = child === branch.nodeA ? 1 : -1;
      balancedBranches.set(branch, -childResidual / childSign);
      subtreeResidual += childResidual;
    }
    return subtreeResidual;
  };
  for (const root of forest.roots) { balanceSubtree(root); }
  return balancedBranches;
}

function applyInitialIdealBranchCurrentDeltas(
  sample: TransientSample,
  branchDeltas: ReadonlyMap<InitialIdealBranch, number>,
) {
  for (const [branch, currentDelta] of branchDeltas) {
    const correctedCurrent = branch.currentAmps + currentDelta;
    if (!Number.isFinite(correctedCurrent)) { continue; }
    const reading = sample.parts[branch.part.id];
    if (!reading) { continue; }
    reading.currentAmps = correctedCurrent;
    reading.terminalCurrents = { a: correctedCurrent, b: -correctedCurrent };
    reading.powerWatts = reading.voltageVolts * correctedCurrent;
  }
}

function reconstructInitialIdealBranchCurrents(
  document: CircuitDocument,
  sample: TransientSample,
  switchStates: Record<string, boolean>,
  originalCapacitorCurrents: ReadonlyMap<string, CapacitorTerminalCurrents>,
) {
  const wireNodes = createWireNodes(document);
  const branches = initialIdealBranches(document, sample, switchStates, wireNodes);
  if (branches.length === 0) { return; }

  // Only capacitor redistribution deltas are balanced. This preserves currents
  // already solved for op-amp reference returns and other implicit branches.
  // Cycle currents are indeterminate, so only tree branch corrections are made.
  const residualByNode = initialCapacitorCurrentDeltas(
    document,
    sample,
    originalCapacitorCurrents,
    wireNodes,
  );
  const adjacency = idealBranchAdjacency(branches);
  const forest = idealBranchForest(adjacency);
  const branchDeltas = idealBranchCurrentDeltas(adjacency, residualByNode, forest);
  applyInitialIdealBranchCurrentDeltas(sample, branchDeltas);
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
  });
  if (analysis.status !== "valid") {
    return { analysis, reason: `t=${timeSeconds} s の解析に失敗しました。${analysis.message}` };
  }
  const measured = createSample(document, analysis, state, dt, options.switchStates);
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
    const optionsIssue = validateOptions(options);
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
