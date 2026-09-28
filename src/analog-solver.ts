import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import {
  complex,
  complexAdd,
  complexConjugate,
  complexDivide,
  complexMagnitude,
  complexMultiply,
  complexPhaseDegrees,
  exactComponentSum,
  solveComplexLinearSystem,
  solveRealLinearSystem,
  type ComplexValue,
} from "./analog-math.js";
import { acAnalysisFrequency, acReactiveAdmittance, acReactiveReactance, frequencyMatches } from "./ac-reactive.js";
import { meterStatuses, type MeterStatus } from "./meter-status.js";
import { circuitDocumentShapeIssue, isSimulationRecord, simulationRecordField } from "./simulation-input.js";

export type { ComplexValue } from "./analog-math.js";

export type AnalogAnalysisMode = "dc" | "ac";
export type AnalogAnalysisStatus = "empty" | "valid" | "invalid";
export type AnalogIssueSeverity = "error" | "warning" | "info";

export interface AnalogCircuitIssue {
  severity: AnalogIssueSeverity;
  message: string;
  partId?: string;
  /** Stable discriminator for a missing current return path. */
  code?: "current-source-no-return-path";
}

export interface AnalogCircuitPartReading {
  /** Component voltage; AC values are RMS phasors. */
  voltage: ComplexValue;
  /** Current entering the component at its primary terminal; AC values are RMS phasors. */
  current: ComplexValue;
  /** Complex power absorbed by the component, V × conjugate(I), in volt-amperes. */
  power: ComplexValue;
  /** Voltage of each physical terminal relative to the circuit reference. */
  terminalVoltages: Partial<Record<CircuitTerminal, ComplexValue>>;
  /** Current entering each physical terminal from the external circuit. */
  terminalCurrents: Partial<Record<CircuitTerminal, ComplexValue>>;
  /** 0–1 brightness for bulbs, relative to the part's rated power. */
  brightness?: number;
  /**
   * Measurement validity for ammeters and voltmeters. `unconnected` means a lead lacks a wire;
   * `floating` means the voltage reference is indeterminate or an ammeter current is bypassed.
   */
  meterStatus?: MeterStatus;
}

export interface AnalogCircuitAnalysis {
  status: AnalogAnalysisStatus;
  mode: AnalogAnalysisMode;
  message: string;
  /** Frequency for AC analysis, in hertz. */
  frequencyHz?: number;
  parts: Record<string, AnalogCircuitPartReading>;
  /** One entry per electrical net, keyed by its first `partId:terminal` endpoint. */
  nodeVoltages: Record<string, ComplexValue>;
  issues: AnalogCircuitIssue[];
}

export interface AnalogStepOptions {
  mode: AnalogAnalysisMode;
  /** AC analysis frequency. If omitted, the first AC source's frequency is used. */
  frequencyHz?: number;
  switchStates?: Record<string, boolean>;
  /** DC source overrides for a moving source, keyed by part ID. Negative values are allowed. */
  voltageOverrides?: Record<string, number>;
  /** Transient initialization: fix inductor currents and solve their initial voltage derivatives. */
  initialInductorCurrents?: boolean;
}

/** Maximum terminal count accepted by this dense MNA solver. */
export const MAX_ANALOG_ANALYSIS_TERMINALS = 512;
/** Maximum number of MNA unknowns, including ideal-source branch currents. */
export const MAX_ANALOG_ANALYSIS_UNKNOWNS = 512;

const THERMAL_VOLTAGE = 0.025_85;
const GMIN_SIEMENS = 1e-12;
// Existing high-common-mode regressions cover 1e16 Ω. Keep that MNA basis
// unchanged, and rescale only after another binary64 precision interval (53
// bits, 1 / EPSILON) beyond it, where branch-current units can lose meaningful
// voltage components when multiplied back by extreme impedances.
const AC_BRANCH_CURRENT_SCALE_THRESHOLD_OHMS = 1e16 / Number.EPSILON;
const MAX_NEWTON_ITERATIONS = 100;
const NEWTON_CURRENT_TOLERANCE_AMPS = Number.MIN_VALUE;
const NEWTON_VOLTAGE_TOLERANCE_VOLTS = 1e-12;
const NEWTON_RELATIVE_TOLERANCE = 1e-10;
const PHYSICAL_CURRENT_TOLERANCE_AMPS = 1e-9;
const PHYSICAL_VOLTAGE_TOLERANCE_VOLTS = 1e-9;
const PHYSICAL_RELATIVE_TOLERANCE = 1e-10;
const EXPONENT_MIN = -60;
const EXPONENT_MAX = 80;
const OP_AMP_OUTPUT_RESISTANCE_OHMS = 20;

interface Topology {
  terminalNodes: Map<string, number>;
  nodeUnknowns: number[];
  nodeLabels: Map<number, string>;
  referenceNode: number;
  nodeCount: number;
  nodeUnknownCount: number;
}

interface Branch {
  partId: string;
  kind: CircuitPartKind;
  positiveNode: number;
  negativeNode: number;
  seriesResistanceOhms: number;
  seriesReactanceOhms?: number;
  sourceVoltage: ComplexValue;
  /** Componentwise allowance for rounding while deriving this source phasor. */
  sourceVoltageUncertainty?: ComplexValue;
  unknownIndex: number;
  /** Redundant compatible ideal voltage constraint; its current is fixed to zero. */
  redundantIdealSource?: boolean;
  /** AC MNA stores branch current multiplied by this scale to retain tiny voltage drops. */
  acCurrentScale?: number;
  /** Outer terminal tied to the wiper by an ideal internal potentiometer segment. */
  internalPotentiometerTerminal?: "a" | "b";
}

interface MnaLayout {
  topology: Topology;
  /** Physical GND node, retained when AC coordinates are re-referenced. */
  physicalReferenceNode: number;
  branches: Branch[];
  branchByPartId: Map<string, Branch>;
  unboundedReactiveAdmittances: Map<string, ComplexValue>;
  internalBranches: Branch[];
  internalBranchesByPartId: Map<string, Branch[]>;
  size: number;
  initialInductorCurrents: boolean;
}

interface AcSolution {
  layout: MnaLayout;
  /** Original node indexing used by the DC operating-point state. */
  biasLayout: MnaLayout;
  values: ComplexValue[];
  nodeVoltageOffsets: ComplexValue[];
}

interface NonlinearModel {
  currents: number[];
  jacobian: number[][];
}

interface DcAssembly {
  matrix: Float64Array;
  residual: Float64Array;
}

const endpointKey = (partId: string, terminal: CircuitTerminal) => `${partId}:${terminal}`;
const positive = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0;
const nonnegative = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value >= 0;

function result(
  status: AnalogAnalysisStatus,
  mode: AnalogAnalysisMode,
  message: string,
  extra: Partial<AnalogCircuitAnalysis> = {},
): AnalogCircuitAnalysis {
  return {
    status,
    mode,
    message,
    parts: {},
    nodeVoltages: {},
    issues: [],
    ...extra,
  };
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function documentWithCatalogDefaults(document: CircuitDocument): CircuitDocument {
  return {
    ...document,
    parts: document.parts.map((part) => {
      if (!Object.hasOwn(circuitPartCatalog, part.kind)) { return part; }
      const values: Record<string, unknown> = {
        ...circuitPartCatalog[part.kind].defaults,
        ...part,
      };
      for (const [field, value] of Object.entries(circuitPartCatalog[part.kind].defaults)) {
        if (values[field] === undefined) { values[field] = value; }
      }
      return values as unknown as CircuitPart;
    }),
  };
}

function fieldIssue(part: CircuitPart, invalid: boolean, field: string, expectation: string) {
  return invalid ? `${part.label}の${field}は${expectation}にしてください。` : null;
}

type PartValidator = (part: CircuitPart) => string | null;

const partValidators: Partial<Record<CircuitPartKind, PartValidator>> = {
  battery: (part) =>
    fieldIssue(part, !positive(part.voltageVolts), "電圧", "0より大きい数値") ??
    fieldIssue(part, !nonnegative(part.internalResistanceOhms ?? 0), "内部抵抗", "0以上の数値"),
  switch: (part) =>
    fieldIssue(
      part,
      part.initiallyClosed !== undefined && typeof part.initiallyClosed !== "boolean",
      "初期状態",
      "真偽値",
    ),
  "ac-source": (part) =>
    fieldIssue(part, !nonnegative(part.voltageVolts), "実効電圧", "0以上の数値") ??
    fieldIssue(part, !positive(part.frequencyHz), "周波数", "0より大きい数値") ??
    fieldIssue(part, !Number.isFinite(part.phaseDegrees ?? 0), "位相", "有限の数値") ??
    fieldIssue(part, !Number.isFinite(part.offsetVolts ?? 0), "直流オフセット", "有限の数値"),
  resistor: (part) => fieldIssue(part, !positive(part.resistanceOhms), "抵抗値", "0より大きい数値"),
  bulb: (part) =>
    fieldIssue(part, !positive(part.resistanceOhms), "抵抗値", "0より大きい数値") ??
    fieldIssue(
      part,
      part.ratedPowerWatts !== undefined && !positive(part.ratedPowerWatts),
      "定格電力",
      "0より大きい数値",
    ),
  capacitor: (part) => fieldIssue(part, !positive(part.capacitanceFarads), "静電容量", "0より大きい数値"),
  inductor: (part) => fieldIssue(part, !positive(part.inductanceHenries), "インダクタンス", "0より大きい数値"),
  "current-source": (part) =>
    fieldIssue(part, !Number.isFinite(part.currentAmps), "電流", "有限の数値"),
  potentiometer: (part) =>
    fieldIssue(part, !positive(part.resistanceOhms), "抵抗値", "0より大きい数値") ??
    fieldIssue(
      part,
      !Number.isFinite(part.wiperPosition) || (part.wiperPosition ?? -1) < 0 || (part.wiperPosition ?? 2) > 1,
      "摺動位置",
      "0から1の数値",
    ),
  diode: (part) =>
    fieldIssue(part, !positive(part.saturationCurrentAmps), "飽和電流", "0より大きい数値") ??
    fieldIssue(part, !positive(part.emissionCoefficient), "理想係数", "0より大きい数値"),
  led: (part) =>
    fieldIssue(part, !positive(part.saturationCurrentAmps), "飽和電流", "0より大きい数値") ??
    fieldIssue(part, !positive(part.emissionCoefficient), "理想係数", "0より大きい数値") ??
    fieldIssue(part, !positive(part.ratedCurrentAmps), "定格電流", "0より大きい数値"),
  "npn-transistor": (part) =>
    fieldIssue(part, !positive(part.currentGain), "電流増幅率", "0より大きい数値") ??
    fieldIssue(part, !positive(part.saturationCurrentAmps), "飽和電流", "0より大きい数値"),
  "pnp-transistor": (part) =>
    fieldIssue(part, !positive(part.currentGain), "電流増幅率", "0より大きい数値") ??
    fieldIssue(part, !positive(part.saturationCurrentAmps), "飽和電流", "0より大きい数値"),
  nmos: validateMos,
  pmos: validateMos,
  "op-amp": (part) =>
    fieldIssue(part, !positive(part.openLoopGain), "開ループ利得", "0より大きい数値") ??
    fieldIssue(
      part,
      !Number.isFinite(part.positiveRailVolts) || !Number.isFinite(part.negativeRailVolts),
      "電源レール",
      "有限の数値",
    ) ??
    fieldIssue(
      part,
      (part.negativeRailVolts ?? 0) >= (part.positiveRailVolts ?? 0),
      "電源レール",
      "負側が正側より小さい値",
    ),
};

function validateMos(part: CircuitPart) {
  return fieldIssue(
    part,
    !Number.isFinite(part.thresholdVolts) || (part.thresholdVolts ?? -1) < 0,
    "しきい値",
    "0以上の数値",
  ) ??
  fieldIssue(
    part,
    !positive(part.transconductanceAmpsPerVoltSquared),
    "相互コンダクタンス係数",
    "0より大きい数値",
  ) ??
  fieldIssue(
    part,
    !nonnegative(part.channelLengthModulation ?? 0),
    "チャネル長変調係数",
    "0以上の数値",
  );
}

function validationIssue(part: CircuitPart) {
  return partValidators[part.kind]?.(part) ?? null;
}

function documentIssue(
  document: CircuitDocument,
  voltageOverrides: Record<string, number>,
  switchStates: unknown,
) {
  const ids = new Set(document.parts.map((part) => part.id));
  if (ids.size !== document.parts.length) { return "部品 ID が重複しています。"; }

  const partById = new Map(document.parts.map((part) => [part.id, part]));
  const partsIssue = validateParts(document);
  if (partsIssue) { return partsIssue; }
  const overrideIssue = validateVoltageOverrides(voltageOverrides, partById);
  if (overrideIssue) { return overrideIssue; }
  const switchIssue = validateSwitchStates(switchStates, partById);
  if (switchIssue) { return switchIssue; }
  return validateWires(document, partById);
}

function validateParts(document: CircuitDocument) {
  let terminalCount = 0;
  for (const part of document.parts) {
    if (!Object.hasOwn(circuitPartCatalog, part.kind)) { return `${part.label}の部品種類を認識できません。`; }
    terminalCount += terminalsOf(part.kind).length;
    const issue = validationIssue(part);
    if (issue) { return issue; }
  }
  if (terminalCount > MAX_ANALOG_ANALYSIS_TERMINALS) {
    return `端子数が解析上限の${MAX_ANALOG_ANALYSIS_TERMINALS}端子を超えています。`;
  }
  return null;
}

function validateVoltageOverrides(
  voltageOverrides: Record<string, number>,
  partById: Map<string, CircuitPart>,
) {
  for (const [partId, voltage] of Object.entries(voltageOverrides)) {
    const part = partById.get(partId);
    if (!part || (part.kind !== "battery" && part.kind !== "ac-source")) {
      return `電圧上書きの対象「${partId}」は電圧源ではありません。`;
    }
    if (!Number.isFinite(voltage)) { return `${part.label}の電圧上書きは有限の数値にしてください。`; }
  }
  return null;
}

function validateSwitchStates(
  switchStates: unknown,
  partById: Map<string, CircuitPart>,
) {
  if (
    switchStates === null ||
    typeof switchStates !== "object" ||
    Array.isArray(switchStates) ||
    switchStates instanceof Map ||
    switchStates instanceof Set
  ) {
    return "スイッチ状態は部品 ID ごとの真偽値オブジェクトにしてください。";
  }
  for (const [partId, state] of Object.entries(switchStates as Record<string, unknown>)) {
    const part = partById.get(partId);
    if (part?.kind !== "switch") {
      return `スイッチ状態の対象「${partId}」はスイッチ部品ではありません。`;
    }
    if (typeof state !== "boolean") {
      return `${part.label}のスイッチ状態は真偽値にしてください。`;
    }
  }
  return null;
}

function validateWires(document: CircuitDocument, partById: Map<string, CircuitPart>) {
  const validEndpoint = (value: { partId: string; terminal: CircuitTerminal }) => {
    const part = partById.get(value.partId);
    return part !== undefined && terminalsOf(part.kind).includes(value.terminal);
  };
  const wireIds = new Set<string>();
  for (const wire of document.wires) {
    if (wireIds.has(wire.id)) { return "導線 ID が重複しています。"; }
    wireIds.add(wire.id);
    if (!validEndpoint(wire.from) || !validEndpoint(wire.to)) {
      return "導線の接続先を確認してください。";
    }
    if (
      wire.from.partId === wire.to.partId &&
      wire.from.terminal === wire.to.terminal
    ) {
      return "同じ端子同士をつなぐ導線があります。";
    }
  }
  return null;
}

function findRoot(parent: number[], node: number): number {
  let root = node;
  while (parent[root] !== root) { root = parent[root] ?? root; }
  parent[node] = root;
  return root;
}

function terminalIndices(document: CircuitDocument) {
  const terminalIndex = new Map<string, number>();
  let terminalCount = 0;
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      terminalIndex.set(endpointKey(part.id, terminal), terminalCount);
      terminalCount += 1;
    }
  }
  return { terminalIndex, terminalCount };
}

function unionNodes(parent: number[], left: number, right: number) {
  const leftRoot = findRoot(parent, left);
  const rightRoot = findRoot(parent, right);
  if (leftRoot !== rightRoot) { parent[leftRoot] = rightRoot; }
}

function unionWireEndpoints(
  document: CircuitDocument,
  terminalIndex: Map<string, number>,
  parent: number[],
) {
  for (const wire of document.wires) {
    const from = terminalIndex.get(endpointKey(wire.from.partId, wire.from.terminal));
    const to = terminalIndex.get(endpointKey(wire.to.partId, wire.to.terminal));
    if (from !== undefined && to !== undefined) { unionNodes(parent, from, to); }
  }
}

function unionGroundTerminals(
  document: CircuitDocument,
  terminalIndex: Map<string, number>,
  parent: number[],
) {
  let firstGroundIndex: number | undefined;
  for (const part of document.parts) {
    if (part.kind !== "ground") { continue; }
    const groundIndex = terminalIndex.get(endpointKey(part.id, "a"));
    if (groundIndex === undefined) { continue; }
    if (firstGroundIndex === undefined) { firstGroundIndex = groundIndex; }
    else { unionNodes(parent, firstGroundIndex, groundIndex); }
  }
  return firstGroundIndex;
}

function mapTopologyNodes(
  document: CircuitDocument,
  terminalIndex: Map<string, number>,
  parent: number[],
) {
  const rootToNode = new Map<number, number>();
  const terminalNodes = new Map<string, number>();
  const nodeLabels = new Map<number, string>();
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      const key = endpointKey(part.id, terminal);
      const index = terminalIndex.get(key);
      if (index === undefined) { continue; }
      const root = findRoot(parent, index);
      let node = rootToNode.get(root);
      if (node === undefined) {
        node = rootToNode.size;
        rootToNode.set(root, node);
        nodeLabels.set(node, key);
      }
      terminalNodes.set(key, node);
    }
  }
  return { rootToNode, terminalNodes, nodeLabels };
}

function buildNodeUnknowns(nodeCount: number, referenceNode: number) {
  const nodeUnknowns = Array.from({ length: nodeCount }, () => -1);
  let nodeUnknownCount = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    if (node === referenceNode) { continue; }
    nodeUnknowns[node] = nodeUnknownCount;
    nodeUnknownCount += 1;
  }
  return { nodeUnknowns, nodeUnknownCount };
}

function buildTopology(document: CircuitDocument): Topology {
  const { terminalIndex, terminalCount } = terminalIndices(document);
  const parent = Array.from({ length: terminalCount }, (_, index) => index);
  unionWireEndpoints(document, terminalIndex, parent);
  const firstGroundIndex = unionGroundTerminals(document, terminalIndex, parent);
  const { rootToNode, terminalNodes, nodeLabels } = mapTopologyNodes(
    document,
    terminalIndex,
    parent,
  );
  const nodeCount = rootToNode.size;
  const referenceNode =
    firstGroundIndex === undefined
      ? 0
      : (rootToNode.get(findRoot(parent, firstGroundIndex)) ?? 0);
  const { nodeUnknowns, nodeUnknownCount } = buildNodeUnknowns(nodeCount, referenceNode);
  return { terminalNodes, nodeUnknowns, nodeLabels, referenceNode, nodeCount, nodeUnknownCount };
}

function joinConductiveNodes(parent: number[], left: number, right: number) {
  const leftRoot = findRoot(parent, left);
  const rightRoot = findRoot(parent, right);
  if (leftRoot !== rightRoot) { parent[leftRoot] = rightRoot; }
}

function unionPartConduction(
  part: CircuitPart,
  topology: Topology,
  parent: number[],
  switchStates: Record<string, boolean>,
  initialInductorCurrents = false,
  physicalReferenceNode = topology.referenceNode,
) {
  const nodeFor = (terminal: CircuitTerminal) =>
    topology.terminalNodes.get(endpointKey(part.id, terminal)) ?? topology.referenceNode;
  const join = (left: CircuitTerminal, right: CircuitTerminal) =>
    joinConductiveNodes(parent, nodeFor(left), nodeFor(right));
  switch (part.kind) {
    case "battery":
    case "ac-source":
    case "resistor":
    case "bulb":
    case "ammeter":
    case "diode":
    case "led":
      join("a", "b");
      return;
    case "inductor":
      if (!initialInductorCurrents) { join("a", "b"); }
      return;
    case "switch":
      if (isSwitchClosed(part, switchStates)) { join("a", "b"); }
      return;
    case "potentiometer":
      join("a", "c");
      join("b", "c");
      return;
    case "npn-transistor":
    case "pnp-transistor":
      join("a", "b");
      join("b", "c");
      return;
    case "nmos":
    case "pmos":
      join("a", "c");
      return;
    case "op-amp":
      joinConductiveNodes(parent, nodeFor("c"), physicalReferenceNode);
      return;
    default:
      return;
  }
}

function currentSourcePathIssues(
  document: CircuitDocument,
  topology: Topology,
  switchStates: Record<string, boolean>,
): AnalogCircuitIssue[] {
  const parent = Array.from({ length: topology.nodeCount }, (_, index) => index);
  for (const part of document.parts) {
    unionPartConduction(part, topology, parent, switchStates);
  }
  const nodeFor = (part: CircuitPart, terminal: CircuitTerminal) =>
    topology.terminalNodes.get(endpointKey(part.id, terminal)) ?? topology.referenceNode;

  const issues: AnalogCircuitIssue[] = [];
  for (const source of document.parts) {
    if (source.kind !== "current-source" || Math.abs(source.currentAmps ?? 0) === 0) { continue; }
    const positiveRoot = findRoot(parent, nodeFor(source, "a"));
    const negativeRoot = findRoot(parent, nodeFor(source, "b"));
    if (positiveRoot !== negativeRoot) {
      issues.push({
        severity: "error" as const,
        partId: source.id,
        code: "current-source-no-return-path",
        message: `${source.label}に直流の戻り道がありません。抵抗などをつないで電流経路を作ってください。`,
      });
    }
  }
  return issues;
}

function initialCurrentsAreBalanced(currents: readonly number[]) {
  let maxAbs = 0;
  for (const current of currents) { maxAbs = Math.max(maxAbs, Math.abs(current)); }
  if (maxAbs === 0) { return true; }

  let sum = 0;
  let correction = 0;
  let scale = 0;
  for (const current of currents) {
    const normalized = current / maxAbs;
    const next = sum + normalized;
    correction += Math.abs(sum) >= Math.abs(normalized)
      ? (sum - next) + normalized
      : (normalized - next) + sum;
    sum = next;
    scale += Math.abs(normalized);
  }

  const normalizedBalance = sum + correction;
  const tolerance = 64 * Number.EPSILON * scale + Number.MIN_VALUE / maxAbs;
  return Number.isFinite(normalizedBalance) && Math.abs(normalizedBalance) <= tolerance;
}

function initialInductorIssues(
  document: CircuitDocument,
  topology: Topology,
  switchStates: Record<string, boolean>,
): AnalogCircuitIssue[] {
  const parent = Array.from({ length: topology.nodeCount }, (_, index) => index);
  for (const part of document.parts) {
    unionPartConduction(part, topology, parent, switchStates, true);
  }
  const balances = new Map<number, { currents: number[]; partId: string }>();
  const add = (node: number, current: number, partId: string) => {
    const root = findRoot(parent, node);
    const balance = balances.get(root) ?? { currents: [], partId };
    balance.currents.push(current);
    balances.set(root, balance);
  };
  for (const part of document.parts) {
    if (part.kind !== "inductor" && part.kind !== "current-source") { continue; }
    const current = part.kind === "inductor" ? (part.initialCurrentAmps ?? 0) : (part.currentAmps ?? 0);
    if (!Number.isFinite(current)) {
      return [{ severity: "error", partId: part.id, message: `${part.label}の初期電流は有限の数値にしてください。` }];
    }
    const nodeA = nodeForTerminal(topology, part, "a");
    const nodeB = nodeForTerminal(topology, part, "b");
    if (findRoot(parent, nodeA) === findRoot(parent, nodeB)) { continue; }
    add(nodeA, current, part.id);
    add(nodeB, -current, part.id);
  }
  const issues: AnalogCircuitIssue[] = [];
  for (const balance of balances.values()) {
    if (!initialCurrentsAreBalanced(balance.currents)) {
      issues.push({
        severity: "error",
        partId: balance.partId,
        message: "コイルの初期電流と電流源の指定値が接続点の電流のつり合いを満たしません。初期電流と極性を確認してください。",
      });
    }
  }
  return issues;
}

function sourceVoltageForDc(part: CircuitPart, overrides: Record<string, number>) {
  if (Object.hasOwn(overrides, part.id)) { return overrides[part.id] ?? 0; }
  return part.kind === "battery" ? (part.voltageVolts ?? 0) : (part.offsetVolts ?? 0);
}

interface BranchSpec {
  part: CircuitPart;
  positiveNode: number;
  negativeNode: number;
  seriesResistanceOhms: number;
  seriesReactanceOhms?: number;
  sourceVoltage: ComplexValue;
  sourceVoltageUncertainty?: ComplexValue;
}

function nodeForTerminal(topology: Topology, part: CircuitPart, terminal: CircuitTerminal) {
  return topology.terminalNodes.get(endpointKey(part.id, terminal)) ?? topology.referenceNode;
}

function acSourceBranchSpec(
  part: CircuitPart,
  positiveNode: number,
  negativeNode: number,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  voltageOverrides: Record<string, number>,
): BranchSpec {
  const sourceVoltage = mode === "dc"
    ? complex(sourceVoltageForDc(part, voltageOverrides))
    : acSourcePhasor(part, frequencyHz);
  return {
    part,
    positiveNode,
    negativeNode,
    seriesResistanceOhms: 0,
    sourceVoltage,
    sourceVoltageUncertainty: mode === "ac"
      ? acSourcePhasorUncertainty(part, frequencyHz, sourceVoltage)
      : complex(),
  };
}

function branchSpecForPart(
  part: CircuitPart,
  topology: Topology,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  voltageOverrides: Record<string, number>,
  switchStates: Record<string, boolean>,
  initialInductorCurrents: boolean,
): BranchSpec | null {
  const positiveNode = nodeForTerminal(topology, part, "a");
  const negativeNode = nodeForTerminal(topology, part, "b");
  if (part.kind === "resistor" || part.kind === "bulb") {
    return {
      part,
      positiveNode,
      negativeNode,
      seriesResistanceOhms: resistorValue(part),
      sourceVoltage: complex(),
    };
  }
  if (mode === "ac" && (part.kind === "capacitor" || part.kind === "inductor")) {
    const reactance = acReactiveReactance(part, frequencyHz ?? 0);
    // An impedance beyond floating-point range is an open branch at this
    // analysis frequency. Its voltage still follows from the adjacent nodes.
    if (!Number.isFinite(reactance)) { return null; }
    return {
      part,
      positiveNode,
      negativeNode,
      seriesResistanceOhms: 0,
      seriesReactanceOhms: reactance,
      sourceVoltage: complex(),
    };
  }
  if (part.kind === "battery") {
    return {
      part,
      positiveNode,
      negativeNode,
      seriesResistanceOhms: part.internalResistanceOhms ?? 0,
      sourceVoltage: complex(mode === "dc" ? sourceVoltageForDc(part, voltageOverrides) : 0),
    };
  }
  if (part.kind === "ac-source") {
    return acSourceBranchSpec(part, positiveNode, negativeNode, mode, frequencyHz, voltageOverrides);
  }
  if (part.kind === "ammeter" || (part.kind === "switch" && isSwitchClosed(part, switchStates))) {
    return { part, positiveNode, negativeNode, seriesResistanceOhms: 0, sourceVoltage: complex() };
  }
  if (part.kind === "inductor" && mode === "dc" && !initialInductorCurrents) {
    return { part, positiveNode, negativeNode, seriesResistanceOhms: 0, sourceVoltage: complex() };
  }
  return null;
}

function unboundedReactiveAdmittanceForPart(
  part: CircuitPart,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
) {
  if (
    mode !== "ac" || (part.kind !== "capacitor" && part.kind !== "inductor") ||
    Number.isFinite(acReactiveReactance(part, frequencyHz ?? 0))
  ) {
    return;
  }
  const admittance = acReactiveAdmittance(part, frequencyHz ?? 0);
  return Number.isFinite(admittance.real) && Number.isFinite(admittance.imaginary) &&
    (admittance.real !== 0 || admittance.imaginary !== 0)
    ? admittance
    : undefined;
}

function acSourcePhasor(part: CircuitPart, frequencyHz: number | undefined) {
  if (frequencyHz === undefined || !frequencyMatches(part.frequencyHz ?? 0, frequencyHz)) {
    return complex();
  }
  const wrappedPhaseDegrees = (part.phaseDegrees ?? 0) % 360;
  const magnitude = part.voltageVolts ?? 0;
  switch (wrappedPhaseDegrees) {
    case 0: return complex(magnitude, 0);
    case 90:
    case -270: return complex(0, magnitude);
    case 180:
    case -180: return complex(-magnitude, 0);
    case 270:
    case -90: return complex(0, -magnitude);
  }
  // Reduce around the nearest quadrantal axis. Computing sin(2π − ε) or
  // cos(π/2 + ε) loses the precision of ε before the voltage is scaled.
  const quadrant = Math.round(wrappedPhaseDegrees / 90);
  const offsetDegrees = wrappedPhaseDegrees - quadrant * 90;
  // The radian offset can itself underflow while the voltage component is
  // representable. For this range sin(ε) rounds to ε and cos(ε) to one.
  const nearAxis = Math.abs(offsetDegrees) < 1e-7;
  const offsetRadians = nearAxis ? 0 : (offsetDegrees * Math.PI) / 180;
  const alongAxis = nearAxis ? magnitude : magnitude * Math.cos(offsetRadians);
  const acrossAxis = nearAxis
    ? (magnitude * (Math.PI / 180)) * offsetDegrees
    : magnitude * Math.sin(offsetRadians);
  switch (((quadrant % 4) + 4) % 4) {
    case 0: return complex(alongAxis, acrossAxis);
    case 1: return complex(-acrossAxis, alongAxis);
    case 2: return complex(-alongAxis, -acrossAxis);
    default: return complex(acrossAxis, -alongAxis);
  }
}

function acSourcePhasorUncertainty(part: CircuitPart, frequencyHz: number | undefined, phasor: ComplexValue) {
  if (frequencyHz === undefined || !frequencyMatches(part.frequencyHz ?? 0, frequencyHz)) { return complex(); }
  const phaseDegrees = (part.phaseDegrees ?? 0) % 360;
  if ([0, 90, -90, 180, -180, 270, -270].includes(phaseDegrees)) { return complex(); }
  const roundoffScale = 64 * Number.EPSILON;
  return complex(
    roundoffScale * Math.abs(phasor.real),
    roundoffScale * Math.abs(phasor.imaginary),
  );
}

function addMnaBranch(
  spec: BranchSpec,
  topology: Topology,
  branches: Branch[],
  branchByPartId: Map<string, Branch>,
): AnalogCircuitIssue | undefined {
  const { part, positiveNode, negativeNode, seriesResistanceOhms, sourceVoltage } = spec;
  const seriesReactanceOhms = spec.seriesReactanceOhms ?? 0;
  if (positiveNode === negativeNode && seriesResistanceOhms === 0 && seriesReactanceOhms === 0) {
    if (sourceVoltage.real === 0 && sourceVoltage.imaginary === 0) { return undefined; }
    return {
      severity: "error",
      partId: part.id,
      message: `${part.label}の理想電圧源が同じノードに短絡され、指定電圧を保てません。導線と電源の接続を確認してください。`,
    };
  }
  const branch: Branch = {
    partId: part.id,
    kind: part.kind,
    positiveNode,
    negativeNode,
    seriesResistanceOhms,
    seriesReactanceOhms,
    sourceVoltage,
    sourceVoltageUncertainty: spec.sourceVoltageUncertainty ?? complex(),
    unknownIndex: topology.nodeUnknownCount + branches.length,
  };
  branches.push(branch);
  branchByPartId.set(part.id, branch);
  return undefined;
}

function compatibleIdealVoltageConstraint(
  left: ComplexValue,
  right: ComplexValue,
  leftUncertainty: ComplexValue,
  rightUncertainty: ComplexValue,
) {
  if (![left.real, left.imaginary, right.real, right.imaginary].every(Number.isFinite)) { return false; }
  const componentsCompatible = (first: number, second: number, firstError: number, secondError: number) => {
    const tolerance = exactComponentSum([firstError, secondError]);
    return Number.isFinite(tolerance) && Math.abs(first - second) <= tolerance;
  };
  return componentsCompatible(left.real, right.real, leftUncertainty.real, rightUncertainty.real) &&
    componentsCompatible(left.imaginary, right.imaginary, leftUncertainty.imaginary, rightUncertainty.imaginary);
}

interface IdealVoltageConstraintNeighbor {
  node: number;
  partId: string;
  /** V(current node) − V(neighbor node). */
  voltageDifference: ComplexValue;
  voltageUncertainty: ComplexValue;
}

interface IdealVoltageConstraintPath {
  voltageDifference: ComplexValue;
  voltageUncertainty: ComplexValue;
  partIds: string[];
}

function isIdealVoltageConstraint(branch: Branch) {
  return branch.seriesResistanceOhms === 0 && (branch.seriesReactanceOhms ?? 0) === 0;
}

function idealVoltageConstraintPath(
  adjacency: readonly IdealVoltageConstraintNeighbor[][],
  from: number,
  to: number,
): IdealVoltageConstraintPath | undefined {
  const parent = Array.from({ length: adjacency.length }, () => -1);
  const parentEdge = Array.from({ length: adjacency.length }, () => undefined as IdealVoltageConstraintNeighbor | undefined);
  const pending = [from];
  parent[from] = from;
  for (let cursor = 0; cursor < pending.length && parent[to] === -1; cursor += 1) {
    const node = pending[cursor] ?? -1;
    for (const edge of adjacency[node] ?? []) {
      if (parent[edge.node] !== -1) { continue; }
      parent[edge.node] = node;
      parentEdge[edge.node] = edge;
      pending.push(edge.node);
    }
  }
  if (parent[to] === -1) { return undefined; }

  const realTerms: number[] = [];
  const imaginaryTerms: number[] = [];
  const realUncertaintyTerms: number[] = [];
  const imaginaryUncertaintyTerms: number[] = [];
  const partIds: string[] = [];
  for (let node = to; node !== from; node = parent[node] ?? -1) {
    const edge = parentEdge[node];
    if (!edge) { return undefined; }
    realTerms.push(edge.voltageDifference.real);
    imaginaryTerms.push(edge.voltageDifference.imaginary);
    realUncertaintyTerms.push(edge.voltageUncertainty.real);
    imaginaryUncertaintyTerms.push(edge.voltageUncertainty.imaginary);
    partIds.push(edge.partId);
  }
  return {
    voltageDifference: {
      real: exactComponentSum(realTerms),
      imaginary: exactComponentSum(imaginaryTerms),
    },
    voltageUncertainty: {
      real: exactComponentSum(realUncertaintyTerms),
      imaginary: exactComponentSum(imaginaryUncertaintyTerms),
    },
    partIds,
  };
}

function addIdealVoltageConstraint(
  adjacency: IdealVoltageConstraintNeighbor[][],
  branch: Branch,
) {
  adjacency[branch.positiveNode]?.push({
    node: branch.negativeNode,
    partId: branch.partId,
    voltageDifference: branch.sourceVoltage,
    voltageUncertainty: branch.sourceVoltageUncertainty ?? complex(),
  });
  adjacency[branch.negativeNode]?.push({
    node: branch.positiveNode,
    partId: branch.partId,
    voltageDifference: complex(-branch.sourceVoltage.real, -branch.sourceVoltage.imaginary),
    voltageUncertainty: branch.sourceVoltageUncertainty ?? complex(),
  });
}

function idealVoltageConstraintIssue(
  branch: Branch,
  path: IdealVoltageConstraintPath,
  partById: Map<string, CircuitPart>,
): AnalogCircuitIssue {
  const part = partById.get(branch.partId);
  const previousSource = path.partIds.length === 1
    ? partById.get(path.partIds[0] ?? "")
    : undefined;
  const isParallelSourcePair = path.partIds.length === 1 &&
    (part?.kind === "ac-source" || part?.kind === "battery") &&
    (previousSource?.kind === "ac-source" || previousSource?.kind === "battery");
  return {
    severity: "error",
    partId: branch.partId,
    message: isParallelSourcePair
      ? `${previousSource?.label ?? "理想電圧源"}と${part?.label ?? "理想電圧源"}が並列接続されていますが、電圧が一致しません。電源の電圧と位相、極性を確認してください。`
      : `${part?.label ?? "理想電圧源"}を含む理想電圧源のループで電圧の和が一致しません。電源の電圧と位相、極性を確認してください。`,
  };
}

function markRedundantIdealVoltageCycles(
  document: CircuitDocument,
  branches: Branch[],
  nodeCount: number,
): AnalogCircuitIssue | undefined {
  const partById = new Map(document.parts.map((part) => [part.id, part]));
  const adjacency = Array.from(
    { length: nodeCount },
    () => [] as IdealVoltageConstraintNeighbor[],
  );
  for (const branch of branches) {
    if (!isIdealVoltageConstraint(branch)) { continue; }
    if (branch.positiveNode === branch.negativeNode) { continue; }

    const path = idealVoltageConstraintPath(adjacency, branch.positiveNode, branch.negativeNode);
    if (!path) {
      addIdealVoltageConstraint(adjacency, branch);
      continue;
    }

    if (!compatibleIdealVoltageConstraint(
      path.voltageDifference,
      branch.sourceVoltage,
      path.voltageUncertainty,
      branch.sourceVoltageUncertainty ?? complex(),
    )) {
      return idealVoltageConstraintIssue(branch, path, partById);
    }

    // A source edge that closes a compatible cycle adds no new node-voltage
    // constraint. Its branch current is underdetermined, so choose zero and
    // retain the spanning-tree constraints as a deterministic solution.
    branch.redundantIdealSource = true;
  }
  return undefined;
}

function addPotentiometerBranches(
  part: CircuitPart,
  topology: Topology,
  internalBranches: Branch[],
  internalBranchesByPartId: Map<string, Branch[]>,
) {
  if (part.kind !== "potentiometer") { return; }
  const segments = potentiometerSegments(part);
  const positiveNode = nodeForTerminal(topology, part, "a");
  const negativeNode = nodeForTerminal(topology, part, "c");
  const specs: Array<{ terminal: "a" | "b"; resistance: number; positiveNode: number; negativeNode: number }> = [
    { terminal: "a", resistance: segments.ac, positiveNode, negativeNode },
    {
      terminal: "b",
      resistance: segments.cb,
      positiveNode: nodeForTerminal(topology, part, "b"),
      negativeNode: nodeForTerminal(topology, part, "c"),
    },
  ];
  for (const spec of specs) {
    if (spec.positiveNode === spec.negativeNode) { continue; }
    const branch: Branch = {
      partId: part.id,
      kind: part.kind,
      positiveNode: spec.positiveNode,
      negativeNode: spec.negativeNode,
      seriesResistanceOhms: spec.resistance,
      sourceVoltage: complex(),
      unknownIndex: 0,
      internalPotentiometerTerminal: spec.terminal,
    };
    internalBranches.push(branch);
    const partBranches = internalBranchesByPartId.get(part.id) ?? [];
    partBranches.push(branch);
    internalBranchesByPartId.set(part.id, partBranches);
  }
}

function assignAcBranchCurrentScales(
  document: CircuitDocument,
  topology: Topology,
  branches: Branch[],
) {
  const parent = Array.from({ length: topology.nodeCount }, (_, node) => node);
  for (const part of document.parts) {
    const nodes = terminalsOf(part.kind).map((terminal) => nodeForTerminal(topology, part, terminal));
    const firstNode = nodes[0];
    if (firstNode === undefined) { continue; }
    for (const node of nodes.slice(1)) { unionNodes(parent, firstNode, node); }
  }

  const impedanceScaleByComponent = new Map<number, number>();
  for (const branch of branches) {
    const component = findRoot(parent, branch.positiveNode);
    const impedanceScale = Math.max(
      Math.abs(branch.seriesResistanceOhms),
      Math.abs(branch.seriesReactanceOhms ?? 0),
    );
    impedanceScaleByComponent.set(
      component,
      Math.max(impedanceScaleByComponent.get(component) ?? 0, impedanceScale),
    );
  }

  for (const branch of branches) {
    const component = findRoot(parent, branch.positiveNode);
    const componentScale = impedanceScaleByComponent.get(component) ?? 0;
    const impedanceScale = Math.max(
      1,
      Math.abs(branch.seriesResistanceOhms),
      Math.abs(branch.seriesReactanceOhms ?? 0),
    );
    // Keep current units coordinated throughout an extreme component. Scaling
    // only its largest-impedance branch can underflow smaller branch currents
    // in KCL before their own representable voltage drops are reconstructed.
    branch.acCurrentScale = componentScale >= AC_BRANCH_CURRENT_SCALE_THRESHOLD_OHMS
      ? impedanceScale
      : 1;
  }
}

function buildLayout(
  document: CircuitDocument,
  topology: Topology,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  voltageOverrides: Record<string, number>,
  switchStates: Record<string, boolean>,
  initialInductorCurrents = false,
): { layout?: MnaLayout; issue?: AnalogCircuitIssue } {
  const branches: Branch[] = [];
  const branchByPartId = new Map<string, Branch>();
  const unboundedReactiveAdmittances = new Map<string, ComplexValue>();
  const internalBranches: Branch[] = [];
  const internalBranchesByPartId = new Map<string, Branch[]>();
  for (const part of document.parts) {
    const spec = branchSpecForPart(part, topology, mode, frequencyHz, voltageOverrides, switchStates, initialInductorCurrents);
    if (spec) {
      const issue = addMnaBranch(spec, topology, branches, branchByPartId);
      if (issue) { return { issue }; }
    } else {
      const admittance = unboundedReactiveAdmittanceForPart(part, mode, frequencyHz);
      if (admittance) { unboundedReactiveAdmittances.set(part.id, admittance); }
    }
    addPotentiometerBranches(part, topology, internalBranches, internalBranchesByPartId);
  }
  for (let index = 0; index < internalBranches.length; index += 1) {
    const branch = internalBranches[index];
    if (branch) {
      branch.unknownIndex = topology.nodeUnknownCount + branches.length + index;
    }
  }

  const idealVoltageCycleIssue = markRedundantIdealVoltageCycles(document, branches, topology.nodeCount);
  if (idealVoltageCycleIssue) { return { issue: idealVoltageCycleIssue }; }

  if (mode === "ac") {
    assignAcBranchCurrentScales(document, topology, [...branches, ...internalBranches]);
  }

  const size = topology.nodeUnknownCount + branches.length + internalBranches.length;
  if (size > MAX_ANALOG_ANALYSIS_UNKNOWNS) {
    return {
      issue: {
        severity: "error",
        message: `未知数が解析上限の${MAX_ANALOG_ANALYSIS_UNKNOWNS}個を超えています。部品を減らすか、回路を分けて解析してください。`,
      },
    };
  }
  return {
    layout: {
      topology,
      physicalReferenceNode: topology.referenceNode,
      branches,
      branchByPartId,
      unboundedReactiveAdmittances,
      internalBranches,
      internalBranchesByPartId,
      size,
      initialInductorCurrents,
    },
  };
}

function diodeCurrentAndSlope(voltage: number, saturationCurrent: number, ideality: number) {
  const scale = ideality * THERMAL_VOLTAGE;
  const rawExponent = voltage / scale;
  if (rawExponent > EXPONENT_MAX) {
    const exponential = Math.exp(EXPONENT_MAX);
    return {
      current: saturationCurrent * (exponential * (1 + rawExponent - EXPONENT_MAX) - 1),
      slope: (saturationCurrent * exponential) / scale,
    };
  }
  if (rawExponent < EXPONENT_MIN) {
    const exponential = Math.exp(EXPONENT_MIN);
    return {
      current: saturationCurrent * Math.expm1(EXPONENT_MIN),
      slope: (saturationCurrent * exponential) / scale,
    };
  }
  const exponential = Math.exp(rawExponent);
  return {
    current: saturationCurrent * Math.expm1(rawExponent),
    slope: (saturationCurrent * exponential) / scale,
  };
}

function bjtModel(
  part: CircuitPart,
  voltages: number[],
): NonlinearModel {
  const sign = part.kind === "pnp-transistor" ? -1 : 1;
  const collector = voltages[0] ?? 0;
  const base = voltages[1] ?? 0;
  const emitter = voltages[2] ?? 0;
  const beta = part.currentGain ?? 100;
  const alphaForward = beta / (beta + 1);
  const alphaReverse = 0.5;
  const saturation = part.saturationCurrentAmps ?? 1e-14;
  const forwardSaturation = saturation / alphaForward;
  const reverseSaturation = saturation / alphaReverse;
  const vbe = sign * (base - emitter);
  const vbc = sign * (base - collector);
  const forward = diodeCurrentAndSlope(vbe, forwardSaturation, 1);
  const reverse = diodeCurrentAndSlope(vbc, reverseSaturation, 1);

  const canonicalCurrents = [
    alphaForward * forward.current - reverse.current,
    (1 - alphaForward) * forward.current + (1 - alphaReverse) * reverse.current,
    -forward.current + alphaReverse * reverse.current,
  ];
  const currents = canonicalCurrents.map((current) => sign * current);
  const jacobian = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => 0));
  const addBranchSlope = (
    positiveTerminal: number,
    negativeTerminal: number,
    slopes: [number, number, number],
    conductance: number,
  ) => {
    for (let row = 0; row < 3; row += 1) {
      const branchCurrentDerivative = slopes[row] * conductance;
      jacobian[row]![positiveTerminal] += branchCurrentDerivative;
      jacobian[row]![negativeTerminal] -= branchCurrentDerivative;
    }
  };
  addBranchSlope(1, 2, [alphaForward, 1 - alphaForward, -1], forward.slope);
  addBranchSlope(1, 0, [-1, 1 - alphaReverse, alphaReverse], reverse.slope);
  return { currents, jacobian };
}

function mosChannel(vgs: number, vds: number, threshold: number, beta: number, lambda: number) {
  const overdrive = vgs - threshold;
  if (overdrive <= 0) { return { current: 0, gm: 0, gds: 0 }; }
  if (vds < overdrive) {
    const base = beta * (overdrive * vds - (vds * vds) / 2);
    const baseGm = beta * vds;
    const baseGds = beta * (overdrive - vds);
    const modulation = 1 + lambda * vds;
    return {
      current: base * modulation,
      gm: baseGm * modulation,
      gds: baseGds * modulation + lambda * base,
    };
  }
  const base = (beta * overdrive * overdrive) / 2;
  const modulation = 1 + lambda * vds;
  return {
    current: base * modulation,
    gm: beta * overdrive * modulation,
    gds: lambda * base,
  };
}

function mosfetModel(part: CircuitPart, voltages: number[]): NonlinearModel {
  const sign = part.kind === "pmos" ? -1 : 1;
  const drain = voltages[0] ?? 0;
  const gate = voltages[1] ?? 0;
  const source = voltages[2] ?? 0;
  const normalizedVgs = sign * (gate - source);
  const normalizedVds = sign * (drain - source);
  const threshold = part.thresholdVolts ?? 2;
  const beta = part.transconductanceAmpsPerVoltSquared ?? 0.02;
  const lambda = part.channelLengthModulation ?? 0.01;

  let normalizedCurrent: number;
  let gm: number;
  let gds: number;
  if (normalizedVds >= 0) {
    const channel = mosChannel(normalizedVgs, normalizedVds, threshold, beta, lambda);
    normalizedCurrent = channel.current;
    gm = channel.gm;
    gds = channel.gds;
  } else {
    const channel = mosChannel(
      normalizedVgs - normalizedVds,
      -normalizedVds,
      threshold,
      beta,
      lambda,
    );
    normalizedCurrent = -channel.current;
    gm = -channel.gm;
    gds = channel.gm + channel.gds;
  }

  const drainCurrent = sign * normalizedCurrent;
  const jacobian = [
    [gds, gm, -gm - gds],
    [0, 0, 0],
    [-gds, -gm, gm + gds],
  ];
  return { currents: [drainCurrent, 0, -drainCurrent], jacobian };
}

function diodeModel(part: CircuitPart, voltages: number[]): NonlinearModel {
  const value = diodeCurrentAndSlope(
    (voltages[0] ?? 0) - (voltages[1] ?? 0),
    part.saturationCurrentAmps ?? (part.kind === "led" ? 1e-20 : 1e-12),
    part.emissionCoefficient ?? (part.kind === "led" ? 2 : 1),
  );
  return {
    currents: [value.current, -value.current],
    jacobian: [
      [value.slope, -value.slope],
      [-value.slope, value.slope],
    ],
  };
}

function opAmpModel(part: CircuitPart, voltages: number[]): NonlinearModel {
  const gain = part.openLoopGain ?? 100_000;
  const positiveRail = part.positiveRailVolts ?? 15;
  const negativeRail = part.negativeRailVolts ?? -15;
  const differential = (voltages[0] ?? 0) - (voltages[1] ?? 0);
  const rawTarget = gain * differential;
  const target = Math.min(positiveRail, Math.max(negativeRail, rawTarget));
  const slope = rawTarget > negativeRail && rawTarget < positiveRail ? gain : 0;
  const output = voltages[2] ?? 0;
  return {
    currents: [0, 0, (output - target) / OP_AMP_OUTPUT_RESISTANCE_OHMS],
    jacobian: [
      [0, 0, 0],
      [0, 0, 0],
      [
        -slope / OP_AMP_OUTPUT_RESISTANCE_OHMS,
        slope / OP_AMP_OUTPUT_RESISTANCE_OHMS,
        1 / OP_AMP_OUTPUT_RESISTANCE_OHMS,
      ],
    ],
  };
}

function nonlinearReferenceDerivative(part: CircuitPart, model: NonlinearModel, row: number) {
  if (part.kind !== "op-amp" || row !== 2) { return 0; }
  return -(model.jacobian[row] ?? []).reduce((sum, value) => sum + value, 0);
}

function nonlinearModel(part: CircuitPart, voltages: number[]): NonlinearModel | null {
  if (part.kind === "diode" || part.kind === "led") { return diodeModel(part, voltages); }
  if (part.kind === "npn-transistor" || part.kind === "pnp-transistor") {
    return bjtModel(part, voltages);
  }
  if (part.kind === "nmos" || part.kind === "pmos") { return mosfetModel(part, voltages); }
  if (part.kind === "op-amp") { return opAmpModel(part, voltages); }
  return null;
}

function nodeRealValue(layout: MnaLayout, node: number, state: Float64Array) {
  const unknown = layout.topology.nodeUnknowns[node] ?? -1;
  return unknown < 0 ? 0 : (state[unknown] ?? 0);
}

function terminalRealValues(part: CircuitPart, layout: MnaLayout, state: Float64Array) {
  return terminalsOf(part.kind).map((terminal) => {
    const node = layout.topology.terminalNodes.get(endpointKey(part.id, terminal));
    return node === undefined ? 0 : nodeRealValue(layout, node, state);
  });
}

function addMatrix(matrix: Float64Array, size: number, row: number, column: number, value: number) {
  if (row < 0 || column < 0 || row >= size || column >= size) { return; }
  const index = row * size + column;
  matrix[index] = (matrix[index] ?? 0) + value;
}

function addResidual(residual: Float64Array, row: number, value: number) {
  if (row < 0 || row >= residual.length) { return; }
  residual[row] = (residual[row] ?? 0) + value;
}

function stampConductance(
  matrix: Float64Array,
  residual: Float64Array,
  layout: MnaLayout,
  state: Float64Array,
  positiveNode: number,
  negativeNode: number,
  conductance: number,
) {
  const positiveUnknown = layout.topology.nodeUnknowns[positiveNode] ?? -1;
  const negativeUnknown = layout.topology.nodeUnknowns[negativeNode] ?? -1;
  const voltage = nodeRealValue(layout, positiveNode, state) - nodeRealValue(layout, negativeNode, state);
  const current = conductance * voltage;
  addResidual(residual, positiveUnknown, current);
  addResidual(residual, negativeUnknown, -current);
  addMatrix(matrix, layout.size, positiveUnknown, positiveUnknown, conductance);
  addMatrix(matrix, layout.size, positiveUnknown, negativeUnknown, -conductance);
  addMatrix(matrix, layout.size, negativeUnknown, positiveUnknown, -conductance);
  addMatrix(matrix, layout.size, negativeUnknown, negativeUnknown, conductance);
}

function stampCurrentSource(
  residual: Float64Array,
  layout: MnaLayout,
  positiveNode: number,
  negativeNode: number,
  current: number,
) {
  addResidual(residual, layout.topology.nodeUnknowns[positiveNode] ?? -1, current);
  addResidual(residual, layout.topology.nodeUnknowns[negativeNode] ?? -1, -current);
}

function addVoltageBranch(
  matrix: Float64Array,
  residual: Float64Array,
  layout: MnaLayout,
  state: Float64Array,
  branch: Branch,
) {
  if (branch.redundantIdealSource) {
    const branchCurrent = state[branch.unknownIndex] ?? 0;
    addResidual(residual, branch.unknownIndex, branchCurrent);
    addMatrix(matrix, layout.size, branch.unknownIndex, branch.unknownIndex, 1);
    return;
  }
  const positiveUnknown = layout.topology.nodeUnknowns[branch.positiveNode] ?? -1;
  const negativeUnknown = layout.topology.nodeUnknowns[branch.negativeNode] ?? -1;
  const branchCurrent = state[branch.unknownIndex] ?? 0;
  const positiveVoltage = nodeRealValue(layout, branch.positiveNode, state);
  const negativeVoltage = nodeRealValue(layout, branch.negativeNode, state);
  addResidual(residual, positiveUnknown, branchCurrent);
  addResidual(residual, negativeUnknown, -branchCurrent);
  addMatrix(matrix, layout.size, positiveUnknown, branch.unknownIndex, 1);
  addMatrix(matrix, layout.size, negativeUnknown, branch.unknownIndex, -1);
  addResidual(
    residual,
    branch.unknownIndex,
    positiveVoltage -
      negativeVoltage -
      branch.seriesResistanceOhms * branchCurrent -
      branch.sourceVoltage.real,
  );
  addMatrix(matrix, layout.size, branch.unknownIndex, positiveUnknown, 1);
  addMatrix(matrix, layout.size, branch.unknownIndex, negativeUnknown, -1);
  addMatrix(
    matrix,
    layout.size,
    branch.unknownIndex,
    branch.unknownIndex,
    -branch.seriesResistanceOhms,
  );
}

function stampNonlinear(
  matrix: Float64Array,
  residual: Float64Array,
  layout: MnaLayout,
  part: CircuitPart,
  model: NonlinearModel,
) {
  const terminals = terminalsOf(part.kind);
  const nodes = terminals.map(
    (terminal) => layout.topology.terminalNodes.get(endpointKey(part.id, terminal)) ?? layout.topology.referenceNode,
  );
  for (let row = 0; row < terminals.length; row += 1) {
    const rowUnknown = layout.topology.nodeUnknowns[nodes[row] ?? -1] ?? -1;
    addResidual(residual, rowUnknown, model.currents[row] ?? 0);
    for (let column = 0; column < terminals.length; column += 1) {
      const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
      addMatrix(
        matrix,
        layout.size,
        rowUnknown,
        columnUnknown,
        model.jacobian[row]?.[column] ?? 0,
      );
    }
  }
}

function nonlinearTerminalVoltages(
  part: CircuitPart,
  layout: MnaLayout,
  state: Float64Array,
) {
  const values = terminalRealValues(part, layout, state);
  if (part.kind !== "op-amp") { return values; }
  const reference = nodeRealValue(layout, layout.physicalReferenceNode, state);
  return values.map((value) => value - reference);
}

function stampDcOpAmp(
  matrix: Float64Array,
  residual: Float64Array,
  layout: MnaLayout,
  part: CircuitPart,
  model: NonlinearModel,
) {
  const nodes = terminalsOf(part.kind).map((terminal) => nodeForTerminal(layout.topology, part, terminal));
  const outputNode = nodes[2] ?? layout.topology.referenceNode;
  const outputUnknown = layout.topology.nodeUnknowns[outputNode] ?? -1;
  const referenceUnknown = layout.topology.nodeUnknowns[layout.physicalReferenceNode] ?? -1;
  const outputCurrent = model.currents[2] ?? 0;
  const referenceSlope = nonlinearReferenceDerivative(part, model, 2);

  addResidual(residual, outputUnknown, outputCurrent);
  for (let column = 0; column < nodes.length; column += 1) {
    const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
    addMatrix(matrix, layout.size, outputUnknown, columnUnknown, model.jacobian[2]?.[column] ?? 0);
  }
  addMatrix(matrix, layout.size, outputUnknown, referenceUnknown, referenceSlope);

  // The op-amp output stage returns its current to the physical reference node.
  addResidual(residual, referenceUnknown, -outputCurrent);
  for (let column = 0; column < nodes.length; column += 1) {
    const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
    addMatrix(matrix, layout.size, referenceUnknown, columnUnknown, -(model.jacobian[2]?.[column] ?? 0));
  }
  addMatrix(matrix, layout.size, referenceUnknown, referenceUnknown, -referenceSlope);
}

function resistorValue(part: CircuitPart) {
  return part.resistanceOhms ?? 1;
}

function potentiometerSegments(part: CircuitPart) {
  const total = part.resistanceOhms ?? 1000;
  const position = part.wiperPosition ?? 0.5;
  return {
    ac: total * position,
    cb: total * (1 - position),
  };
}

function isSwitchClosed(part: CircuitPart, switchStates: Record<string, boolean>) {
  return (Object.hasOwn(switchStates, part.id) ? switchStates[part.id] : undefined) ?? part.initiallyClosed ?? false;
}

function stampDcPassivePart(
  residual: Float64Array,
  layout: MnaLayout,
  part: CircuitPart,
) {
  const nodeA = layout.topology.terminalNodes.get(endpointKey(part.id, "a")) ?? layout.topology.referenceNode;
  const nodeB = layout.topology.terminalNodes.get(endpointKey(part.id, "b")) ?? layout.topology.referenceNode;
  if (part.kind === "current-source") {
    stampCurrentSource(residual, layout, nodeA, nodeB, part.currentAmps ?? 0);
  } else if (part.kind === "inductor" && layout.initialInductorCurrents) {
    stampCurrentSource(residual, layout, nodeA, nodeB, part.initialCurrentAmps ?? 0);
  }
}

function stampDcNonlinearPart(
  matrix: Float64Array,
  residual: Float64Array,
  layout: MnaLayout,
  state: Float64Array,
  part: CircuitPart,
) {
  const model = nonlinearModel(part, nonlinearTerminalVoltages(part, layout, state));
  if (!model) { return; }
  if (part.kind === "op-amp") {
    stampDcOpAmp(matrix, residual, layout, part, model);
    return;
  }
  stampNonlinear(matrix, residual, layout, part, model);
}

interface ReferenceConstraint {
  node: number;
  derivatives: { inside: number; outside: number; inductance: number }[];
}

function inductorCutset(
  inductors: { a: number; b: number; inductance: number }[],
  parent: number[],
  root: number,
): ReferenceConstraint["derivatives"] {
  const derivatives: ReferenceConstraint["derivatives"] = [];
  for (const branch of inductors) {
    const aInside = findRoot(parent, branch.a) === root;
    const bInside = findRoot(parent, branch.b) === root;
    if (aInside === bInside) { continue; }
    derivatives.push({
      inside: aInside ? branch.a : branch.b,
      outside: aInside ? branch.b : branch.a,
      inductance: branch.inductance,
    });
  }
  return derivatives;
}

interface ReferenceConductanceEdge {
  a: number;
  b: number;
  logConductance?: number;
  ideal?: boolean;
}

function appendImpedanceReferenceEdge(edges: ReferenceConductanceEdge[], branch: Branch) {
  const scale = Math.max(Math.abs(branch.seriesResistanceOhms), Math.abs(branch.seriesReactanceOhms ?? 0));
  if (scale === 0) {
    if (branch.positiveNode !== branch.negativeNode) {
      edges.push({ a: branch.positiveNode, b: branch.negativeNode, ideal: true });
    }
    return;
  }
  const normalizedMagnitude = Math.hypot(
    branch.seriesResistanceOhms / scale,
    (branch.seriesReactanceOhms ?? 0) / scale,
  );
  const logConductance = -Math.log(scale) - Math.log(normalizedMagnitude);
  if (Number.isFinite(logConductance)) {
    edges.push({ a: branch.positiveNode, b: branch.negativeNode, logConductance });
  }
}

function appendAdmittanceReferenceEdge(
  edges: ReferenceConductanceEdge[],
  layout: MnaLayout,
  part: CircuitPart | undefined,
  admittance: ComplexValue,
) {
  if (!part) { return; }
  const scale = Math.max(Math.abs(admittance.real), Math.abs(admittance.imaginary));
  if (scale === 0 || !Number.isFinite(scale)) { return; }
  const logConductance = Math.log(scale) + Math.log(Math.hypot(admittance.real / scale, admittance.imaginary / scale));
  const a = nodeForTerminal(layout.topology, part, "a");
  const b = nodeForTerminal(layout.topology, part, "b");
  if (Number.isFinite(logConductance) && a !== b) { edges.push({ a, b, logConductance }); }
}

function strengthsFromReferenceEdges(layout: MnaLayout, edges: ReferenceConductanceEdge[]) {
  const parent = Array.from({ length: layout.topology.nodeCount }, (_, node) => node);
  for (const edge of edges) { unionNodes(parent, edge.a, edge.b); }
  const maximumLogByComponent = new Map<number, number>();
  for (const edge of edges) {
    if (edge.logConductance === undefined) { continue; }
    const component = findRoot(parent, edge.a);
    maximumLogByComponent.set(component, Math.max(maximumLogByComponent.get(component) ?? Number.NEGATIVE_INFINITY, edge.logConductance));
  }

  const strengths = Array.from({ length: layout.topology.nodeCount }, () => 0);
  for (const edge of edges) {
    const component = findRoot(parent, edge.a);
    const maximumLog = maximumLogByComponent.get(component) ?? 0;
    const weight = edge.ideal || edge.logConductance === undefined
      ? 1
      : Math.exp(edge.logConductance - maximumLog);
    strengths[edge.a] = (strengths[edge.a] ?? 0) + weight;
    strengths[edge.b] = (strengths[edge.b] ?? 0) + weight;
  }
  return strengths;
}

function referenceNodeStrengths(document: CircuitDocument, layout: MnaLayout) {
  const edges: ReferenceConductanceEdge[] = [];
  for (const branch of [...layout.branches, ...layout.internalBranches]) {
    appendImpedanceReferenceEdge(edges, branch);
  }
  const partById = new Map(document.parts.map((part) => [part.id, part]));
  for (const [partId, admittance] of layout.unboundedReactiveAdmittances) {
    appendAdmittanceReferenceEdge(edges, layout, partById.get(partId), admittance);
  }
  return strengthsFromReferenceEdges(layout, edges);
}

function referenceConstraints(document: CircuitDocument, layout: MnaLayout, mode: AnalogAnalysisMode): ReferenceConstraint[] {
  // Each disconnected conductive network has an arbitrary common-mode voltage.
  const parent = Array.from({ length: layout.topology.nodeCount }, (_, index) => index);
  const switchStates = Object.fromEntries(document.parts
    .filter((part) => part.kind === "switch")
    .map((part) => [part.id, layout.branchByPartId.has(part.id)]));
  for (const part of document.parts) {
    const reactiveBranchIsModeled = layout.branchByPartId.has(part.id) ||
      layout.unboundedReactiveAdmittances.has(part.id);
    if (mode === "ac" && part.kind === "inductor" && !reactiveBranchIsModeled) {
      continue;
    }
    unionPartConduction(
      part,
      layout.topology,
      parent,
      switchStates,
      layout.initialInductorCurrents,
      layout.physicalReferenceNode,
    );
    if (mode === "ac" && part.kind === "capacitor" && reactiveBranchIsModeled) {
      joinConductiveNodes(
        parent,
        nodeForTerminal(layout.topology, part, "a"),
        nodeForTerminal(layout.topology, part, "b"),
      );
    }
  }

  const referenceRoot = findRoot(parent, layout.topology.referenceNode);
  const strengths = referenceNodeStrengths(document, layout);
  const anchorByRoot = new Map<number, { node: number; strength: number }>();
  for (let node = 0; node < layout.topology.nodeCount; node += 1) {
    const root = findRoot(parent, node);
    const strength = strengths[node] ?? 0;
    const current = anchorByRoot.get(root);
    if (
      !current ||
      (!layout.initialInductorCurrents && strength > current.strength)
    ) {
      anchorByRoot.set(root, { node, strength });
    }
  }
  if (!layout.initialInductorCurrents) {
    return [...anchorByRoot]
      .filter(([root]) => root !== referenceRoot)
      .map(([, anchor]) => ({ node: anchor.node, derivatives: [] }));
  }

  return initialInductorReferences(
    document,
    layout,
    parent,
    new Map([...anchorByRoot].map(([root, anchor]) => [root, anchor.node])),
    referenceRoot,
  );
}

function referenceComponentIds(
  document: CircuitDocument,
  layout: MnaLayout,
  mode: AnalogAnalysisMode,
) {
  const parent = Array.from({ length: layout.topology.nodeCount }, (_, node) => node);
  const switchStates = Object.fromEntries(document.parts
    .filter((part) => part.kind === "switch")
    .map((part) => [part.id, layout.branchByPartId.has(part.id)]));
  for (const part of document.parts) {
    const reactiveBranchIsModeled = layout.branchByPartId.has(part.id) ||
      layout.unboundedReactiveAdmittances.has(part.id);
    if (mode === "ac" && part.kind === "inductor" && !reactiveBranchIsModeled) { continue; }
    unionPartConduction(
      part,
      layout.topology,
      parent,
      switchStates,
      layout.initialInductorCurrents,
      layout.physicalReferenceNode,
    );
    if (mode === "ac" && part.kind === "capacitor" && reactiveBranchIsModeled) {
      joinConductiveNodes(
        parent,
        nodeForTerminal(layout.topology, part, "a"),
        nodeForTerminal(layout.topology, part, "b"),
      );
    }
  }
  return Array.from({ length: layout.topology.nodeCount }, (_, node) => findRoot(parent, node));
}

function referenceComponentNodes(
  document: CircuitDocument,
  layout: MnaLayout,
  seedNode: number,
  mode: AnalogAnalysisMode,
) {
  const componentIds = referenceComponentIds(document, layout, mode);
  const seedRoot = componentIds[seedNode];
  return componentIds.map((root) => root === seedRoot);
}

function preferredReferenceNodes(
  document: CircuitDocument,
  layout: MnaLayout,
  mode: AnalogAnalysisMode,
) {
  const component = referenceComponentNodes(document, layout, layout.topology.referenceNode, mode);
  const strengths = referenceNodeStrengths(document, layout);
  return Array.from({ length: layout.topology.nodeCount }, (_, node) => node)
    .filter((node) => component[node] && node !== layout.topology.referenceNode)
    .sort((left, right) =>
      (strengths[right] ?? 0) - (strengths[left] ?? 0) || left - right,
    );
}

function canAdjustDcReference(document: CircuitDocument, layout: MnaLayout) {
  if (!layout.initialInductorCurrents) { return true; }
  const referenceComponent = referenceComponentNodes(
    document,
    layout,
    layout.physicalReferenceNode,
    "dc",
  );
  return !document.parts.some((part) =>
    part.kind === "inductor" &&
    Boolean(referenceComponent[nodeForTerminal(layout.topology, part, "a")]) !==
      Boolean(referenceComponent[nodeForTerminal(layout.topology, part, "b")]),
  );
}

function initialInductorReferences(
  document: CircuitDocument,
  layout: MnaLayout,
  parent: number[],
  anchorByRoot: Map<number, number>,
  referenceRoot: number,
): ReferenceConstraint[] {
  const inductors = document.parts.filter((part) => part.kind === "inductor").map((part) => ({
    a: nodeForTerminal(layout.topology, part, "a"),
    b: nodeForTerminal(layout.topology, part, "b"),
    inductance: part.inductanceHenries ?? 0,
  }));
  const inductiveParent = [...parent];
  for (const branch of inductors) { joinConductiveNodes(inductiveParent, branch.a, branch.b); }
  const referenceByGroup = new Map<number, number>([[findRoot(inductiveParent, referenceRoot), referenceRoot]]);
  const constraints: ReferenceConstraint[] = [];
  for (const [root, node] of anchorByRoot) {
    const group = findRoot(inductiveParent, root);
    if (!referenceByGroup.has(group)) { referenceByGroup.set(group, root); }
    if (root === referenceRoot) { continue; }
    const derivatives = referenceByGroup.get(group) === root ? [] : inductorCutset(inductors, parent, root);
    constraints.push({ node, derivatives });
  }
  return constraints;
}

function stampDcReferences(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  matrix: Float64Array,
  residual: Float64Array,
) {
  for (const { node, derivatives } of referenceConstraints(document, layout, "dc")) {
    const unknown = layout.topology.nodeUnknowns[node] ?? -1;
    if (unknown < 0) { continue; }
    // Replace a redundant KCL row with an exact reference. Adding a tiny
    // conductance here loses that reference next to low-resistance branches.
    matrix.fill(0, unknown * layout.size, (unknown + 1) * layout.size);
    residual[unknown] = 0;
    if (derivatives.length === 0) {
      matrix[unknown * layout.size + unknown] = 1;
      residual[unknown] = state[unknown] ?? 0;
      continue;
    }
    // Across an inductor cutset, the prescribed currents already satisfy KCL.
    // Its time derivative fixes the otherwise arbitrary relative potential:
    // sum of outward V_L / L = 0, since independent current sources are constant.
    for (const branch of derivatives) {
      const conductance = 1 / branch.inductance;
      const inside = layout.topology.nodeUnknowns[branch.inside] ?? -1;
      const outside = layout.topology.nodeUnknowns[branch.outside] ?? -1;
      addMatrix(matrix, layout.size, unknown, inside, conductance);
      addMatrix(matrix, layout.size, unknown, outside, -conductance);
      residual[unknown] += conductance * (nodeRealValue(layout, branch.inside, state) - nodeRealValue(layout, branch.outside, state));
    }
  }
}

function assembleDc(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  includeReferences = true,
): DcAssembly {
  const matrix = new Float64Array(layout.size * layout.size);
  const residual = new Float64Array(layout.size);

  for (const part of document.parts) {
    stampDcPassivePart(residual, layout, part);
    const branch = layout.branchByPartId.get(part.id);
    if (branch) { addVoltageBranch(matrix, residual, layout, state, branch); }
    stampDcNonlinearPart(matrix, residual, layout, state, part);
  }
  for (const branch of layout.internalBranches) {
    addVoltageBranch(matrix, residual, layout, state, branch);
  }
  if (includeReferences) {
    stampDcReferences(document, layout, state, matrix, residual);
  }
  return { matrix, residual };
}

function residualTolerances(
  layout: MnaLayout,
  assembly: DcAssembly,
  state: Float64Array,
  currentTolerance = NEWTON_CURRENT_TOLERANCE_AMPS,
  voltageTolerance = NEWTON_VOLTAGE_TOLERANCE_VOLTS,
  relativeTolerance = NEWTON_RELATIVE_TOLERANCE,
): number[] | null {
  const tolerances: number[] = [];
  for (let row = 0; row < layout.size; row += 1) {
    let equationScale = 0;
    for (let column = 0; column < layout.size; column += 1) {
      const term = (assembly.matrix[row * layout.size + column] ?? 0) * (state[column] ?? 0);
      if (!Number.isFinite(term)) { return null; }
      equationScale += Math.abs(term);
      if (!Number.isFinite(equationScale)) { return null; }
    }
    // Keep an initially zero state relative to the source current or voltage that drives it.
    const residualScale = Math.abs(assembly.residual[row] ?? 0);
    if (!Number.isFinite(residualScale)) { return null; }
    equationScale = Math.max(equationScale, residualScale);
    const absoluteTolerance = row < layout.topology.nodeUnknownCount
      ? currentTolerance
      : voltageTolerance;
    const tolerance = absoluteTolerance + relativeTolerance * equationScale;
    if (!Number.isFinite(tolerance) || tolerance <= 0) { return null; }
    tolerances.push(tolerance);
  }
  return tolerances;
}

function residualScore(layout: MnaLayout, assembly: DcAssembly, tolerances: number[] | null) {
  if (!tolerances) { return Number.POSITIVE_INFINITY; }
  let score = 0;
  for (let row = 0; row < layout.size; row += 1) {
    const residual = Math.abs(assembly.residual[row] ?? 0);
    if (!Number.isFinite(residual)) { return Number.POSITIVE_INFINITY; }
    score = Math.max(score, residual / (tolerances[row] ?? 0));
  }
  return score;
}

function linearDcSeed(document: CircuitDocument, layout: MnaLayout) {
  // Seed independent voltage biases before retrying a singular off-state nonlinear Jacobian.
  const state = new Float64Array(layout.size);
  const matrix = new Float64Array(layout.size * layout.size);
  const residual = new Float64Array(layout.size);
  for (let node = 0; node < layout.topology.nodeCount; node += 1) {
    if (node !== layout.topology.referenceNode) {
      stampConductance(matrix, residual, layout, state, node, layout.topology.referenceNode, GMIN_SIEMENS);
    }
  }
  for (const part of document.parts) {
    const branch = layout.branchByPartId.get(part.id);
    if (branch) { addVoltageBranch(matrix, residual, layout, state, branch); }
  }
  for (const branch of layout.internalBranches) {
    addVoltageBranch(matrix, residual, layout, state, branch);
  }
  stampDcReferences(document, layout, state, matrix, residual);
  const rhs = Float64Array.from(residual, (value) => -value);
  return solveRealLinearSystem(layout.size, matrix, rhs);
}

function solveDcNewtonStep(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  assembly: DcAssembly,
  tolerances: number[] | null,
  score: number,
) {
  const rhs = Float64Array.from(assembly.residual, (value) => -value);
  const delta = solveRealLinearSystem(layout.size, assembly.matrix, rhs);
  if (!delta) { return { nextState: undefined, singular: true }; }

  let step = 1;
  let nextState: Float64Array<ArrayBuffer> | undefined;
  for (let search = 0; search < 14; search += 1) {
    const candidate = state.slice();
    for (let index = 0; index < layout.size; index += 1) {
      candidate[index] = (state[index] ?? 0) + step * (delta[index] ?? 0);
    }
    const candidateAssembly = assembleDc(document, layout, candidate);
    // Compare candidates using this iteration's scale so an exponential current cannot
    // increase its own tolerance and make a divergent step appear better.
    const candidateScore = residualScore(layout, candidateAssembly, tolerances);
    if (candidateScore < score || candidateScore <= 1 || step <= 1 / 8192) {
      nextState = candidate;
      break;
    }
    step *= 0.5;
  }
  return { nextState, singular: false };
}

function solveDcAtReference(
  document: CircuitDocument,
  layout: MnaLayout,
): { state?: Float64Array; converged: boolean; singular: boolean; invalidPhysicalSolution?: boolean } {
  let state = new Float64Array(layout.size);
  let usedLinearSeed = false;
  if (layout.size === 0) { return { state, converged: true, singular: false }; }

  for (let iteration = 0; iteration < MAX_NEWTON_ITERATIONS; iteration += 1) {
    const assembled = assembleDc(document, layout, state);
    const tolerances = residualTolerances(layout, assembled, state);
    const score = residualScore(layout, assembled, tolerances);
    const hasInitialResidual = iteration === 0 && assembled.residual.some((value) => value !== 0);
    if (score <= 1 && !hasInitialResidual) {
      return validatePhysicalDcSolution(document, layout, state);
    }
    const step = solveDcNewtonStep(document, layout, state, assembled, tolerances, score);
    if (!step.nextState) {
      if (step.singular && iteration === 0 && !usedLinearSeed) {
        const seed = linearDcSeed(document, layout);
        if (seed?.some((value, index) => value !== (state[index] ?? 0))) {
          state.set(seed);
          usedLinearSeed = true;
          continue;
        }
      }
      return { converged: false, singular: step.singular };
    }
    state = step.nextState;
  }
  const finalAssembly = assembleDc(document, layout, state);
  const finalTolerances = residualTolerances(layout, finalAssembly, state);
  const finalScore = residualScore(layout, finalAssembly, finalTolerances);
  return finalScore <= 1
    ? validatePhysicalDcSolution(document, layout, state)
    : { converged: false, singular: false };
}

function validatePhysicalDcSolution(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
): { state?: Float64Array; converged: boolean; singular: boolean; invalidPhysicalSolution?: boolean } {
  const physicalAssembly = assembleDc(document, layout, state, false);
  const physicalScore = residualScore(
    layout,
    physicalAssembly,
    residualTolerances(
      layout,
      physicalAssembly,
      state,
      PHYSICAL_CURRENT_TOLERANCE_AMPS,
      PHYSICAL_VOLTAGE_TOLERANCE_VOLTS,
      PHYSICAL_RELATIVE_TOLERANCE,
    ),
  );
  if (physicalScore > 1) {
    return { converged: false, singular: false, invalidPhysicalSolution: true };
  }
  return { state, converged: true, singular: false };
}

function dcSolutionFailureMessage(solution: ReturnType<typeof solveDc>) {
  if (solution.singular) {
    return "直流回路を計算できません。理想電圧源のループや接続を確認してください。";
  }
  if (solution.invalidPhysicalSolution) {
    return "実部品の電流・電圧のつり合いを満たす直流動作点を計算できません。導通する戻り道と部品の値を確認してください。";
  }
  return "非線形部品の直流動作点が収束しませんでした。値や接続を確認してください。";
}

function nodeComplexValue(layout: MnaLayout, node: number, solution: ComplexValue[]) {
  const unknown = layout.topology.nodeUnknowns[node] ?? -1;
  return unknown < 0 ? complex() : (solution[unknown] ?? complex());
}

function addComplexMatrix(
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  size: number,
  row: number,
  column: number,
  valueReal: number,
  valueImaginary: number,
) {
  if (row < 0 || column < 0 || row >= size || column >= size) { return; }
  const index = row * size + column;
  matrixReal[index] = (matrixReal[index] ?? 0) + valueReal;
  matrixImaginary[index] = (matrixImaginary[index] ?? 0) + valueImaginary;
}

function stampAcReferences(
  document: CircuitDocument,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  layout: MnaLayout,
) {
  for (const { node } of referenceConstraints(document, layout, "ac")) {
    const unknown = layout.topology.nodeUnknowns[node] ?? -1;
    if (unknown < 0) { continue; }
    matrixReal.fill(0, unknown * layout.size, (unknown + 1) * layout.size);
    matrixImaginary.fill(0, unknown * layout.size, (unknown + 1) * layout.size);
    matrixReal[unknown * layout.size + unknown] = 1;
  }
}

function stampAcVoltageBranch(
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
  layout: MnaLayout,
  branch: Branch,
) {
  if (branch.redundantIdealSource) {
    addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, branch.unknownIndex, 1, 0);
    return;
  }
  const positiveUnknown = layout.topology.nodeUnknowns[branch.positiveNode] ?? -1;
  const negativeUnknown = layout.topology.nodeUnknowns[branch.negativeNode] ?? -1;
  const reactance = branch.seriesReactanceOhms ?? 0;
  const currentScale = branch.acCurrentScale ?? 1;
  if (currentScale === 1) {
    // Keep the established stamping for ordinary circuit values.
    const rowScale = Math.max(1, Math.abs(branch.seriesResistanceOhms), Math.abs(reactance));
    addComplexMatrix(matrixReal, matrixImaginary, layout.size, positiveUnknown, branch.unknownIndex, 1, 0);
    addComplexMatrix(matrixReal, matrixImaginary, layout.size, negativeUnknown, branch.unknownIndex, -1, 0);
    addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, positiveUnknown, 1 / rowScale, 0);
    addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, negativeUnknown, -1 / rowScale, 0);
    addComplexMatrix(
      matrixReal, matrixImaginary, layout.size, branch.unknownIndex, branch.unknownIndex,
      -branch.seriesResistanceOhms / rowScale, -reactance / rowScale,
    );
    rhsReal[branch.unknownIndex] = branch.sourceVoltage.real / rowScale;
    rhsImaginary[branch.unknownIndex] = branch.sourceVoltage.imaginary / rowScale;
    return;
  }
  // Store J = Zscale × I. This keeps voltage drops representable even when a
  // component of I itself is below binary64 range; KCL converts J back with
  // 1/Zscale, while the branch equation uses the normalized impedance.
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, positiveUnknown, branch.unknownIndex,
    1 / currentScale, 0,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, negativeUnknown, branch.unknownIndex,
    -1 / currentScale, 0,
  );
  addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, positiveUnknown, 1, 0);
  addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, negativeUnknown, -1, 0);
  addComplexMatrix(
    matrixReal,
    matrixImaginary,
    layout.size,
    branch.unknownIndex,
    branch.unknownIndex,
    -branch.seriesResistanceOhms / currentScale,
    -reactance / currentScale,
  );
  rhsReal[branch.unknownIndex] = branch.sourceVoltage.real;
  rhsImaginary[branch.unknownIndex] = branch.sourceVoltage.imaginary;
}

function stampAcAdmittance(
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  layout: MnaLayout,
  positiveNode: number,
  negativeNode: number,
  admittance: ComplexValue,
) {
  const positiveUnknown = layout.topology.nodeUnknowns[positiveNode] ?? -1;
  const negativeUnknown = layout.topology.nodeUnknowns[negativeNode] ?? -1;
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, positiveUnknown, positiveUnknown,
    admittance.real, admittance.imaginary,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, positiveUnknown, negativeUnknown,
    -admittance.real, -admittance.imaginary,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, negativeUnknown, positiveUnknown,
    -admittance.real, -admittance.imaginary,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, negativeUnknown, negativeUnknown,
    admittance.real, admittance.imaginary,
  );
}

function stampAcOpAmpReferenceReturn(
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  layout: MnaLayout,
  part: CircuitPart,
  model: NonlinearModel,
  terminals: readonly CircuitTerminal[],
  nodes: readonly number[],
) {
  // The output model returns current to physical GND. Keep that node explicit
  // when it is no longer the numerical reference so re-referencing stays a
  // coordinate change instead of changing the op-amp circuit.
  const outputRow = terminals.indexOf("c");
  const outputUnknown = layout.topology.nodeUnknowns[nodes[outputRow] ?? -1] ?? -1;
  const referenceUnknown = layout.topology.nodeUnknowns[layout.physicalReferenceNode] ?? -1;
  const referenceSlope = nonlinearReferenceDerivative(part, model, outputRow);
  addComplexMatrix(
    matrixReal,
    matrixImaginary,
    layout.size,
    outputUnknown,
    referenceUnknown,
    referenceSlope,
    0,
  );
  if (referenceUnknown < 0) { return; }
  for (let column = 0; column < terminals.length; column += 1) {
    const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
    addComplexMatrix(
      matrixReal,
      matrixImaginary,
      layout.size,
      referenceUnknown,
      columnUnknown,
      -(model.jacobian[outputRow]?.[column] ?? 0),
      0,
    );
  }
  addComplexMatrix(
    matrixReal,
    matrixImaginary,
    layout.size,
    referenceUnknown,
    referenceUnknown,
    -referenceSlope,
    0,
  );
}

function stampAcSmallSignalPart(
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  layout: MnaLayout,
  dcLayout: MnaLayout,
  part: CircuitPart,
  dcState: Float64Array,
) {
  const model = nonlinearModel(part, nonlinearTerminalVoltages(part, dcLayout, dcState));
  if (!model) { return; }
  const terminals = terminalsOf(part.kind);
  const nodes = terminals.map((terminal) => nodeForTerminal(layout.topology, part, terminal));
  for (let row = 0; row < terminals.length; row += 1) {
    const rowUnknown = layout.topology.nodeUnknowns[nodes[row] ?? -1] ?? -1;
    for (let column = 0; column < terminals.length; column += 1) {
      const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
      addComplexMatrix(
        matrixReal,
        matrixImaginary,
        layout.size,
        rowUnknown,
        columnUnknown,
        model.jacobian[row]?.[column] ?? 0,
        0,
      );
    }
  }

  if (part.kind === "op-amp") {
    stampAcOpAmpReferenceReturn(
      matrixReal,
      matrixImaginary,
      layout,
      part,
      model,
      terminals,
      nodes,
    );
  }
}

function solveAcForLayout(
  document: CircuitDocument,
  layout: MnaLayout,
  dcLayout: MnaLayout,
  dcState: Float64Array,
): ComplexValue[] | null {
  const matrixReal = new Float64Array(layout.size * layout.size);
  const matrixImaginary = new Float64Array(layout.size * layout.size);
  const rhsReal = new Float64Array(layout.size);
  const rhsImaginary = new Float64Array(layout.size);

  for (const part of document.parts) {
    const branch = layout.branchByPartId.get(part.id);
    if (branch) {
      stampAcVoltageBranch(matrixReal, matrixImaginary, rhsReal, rhsImaginary, layout, branch);
    }
    const unboundedReactiveAdmittance = layout.unboundedReactiveAdmittances.get(part.id);
    if (unboundedReactiveAdmittance) {
      stampAcAdmittance(
        matrixReal,
        matrixImaginary,
        layout,
        nodeForTerminal(layout.topology, part, "a"),
        nodeForTerminal(layout.topology, part, "b"),
        unboundedReactiveAdmittance,
      );
    }
    stampAcSmallSignalPart(matrixReal, matrixImaginary, layout, dcLayout, part, dcState);
  }
  for (const branch of layout.internalBranches) {
    stampAcVoltageBranch(matrixReal, matrixImaginary, rhsReal, rhsImaginary, layout, branch);
  }
  stampAcReferences(document, matrixReal, matrixImaginary, layout);

  return solveComplexLinearSystem(
    layout.size,
    matrixReal,
    matrixImaginary,
    rhsReal,
    rhsImaginary,
  );
}

interface AcReferenceCandidate {
  node: number;
  estimatedOffset: ComplexValue;
  logMagnitude: number;
}

function acReferenceCandidate(node: number, referenceNode: number, estimatedOffset: ComplexValue) {
  if (
    node === referenceNode ||
    !Number.isFinite(estimatedOffset.real) ||
    !Number.isFinite(estimatedOffset.imaginary)
  ) {
    return null;
  }
  const scale = Math.max(Math.abs(estimatedOffset.real), Math.abs(estimatedOffset.imaginary));
  if (scale === 0) { return null; }
  // Math.hypot can overflow even though both phasor components are finite.
  // Use a logarithmic, scaled magnitude only for ordering re-reference candidates.
  const logMagnitude = Math.log(scale) + Math.log(
    Math.hypot(estimatedOffset.real / scale, estimatedOffset.imaginary / scale),
  );
  return { node, estimatedOffset, logMagnitude };
}

function acReferenceCandidatesFromSources(layout: MnaLayout) {
  const referenceNode = layout.topology.referenceNode;
  const sourceEdges = new Map<number, Array<{ node: number; voltage: ComplexValue }>>();
  const addSourceEdge = (from: number, to: number, voltage: ComplexValue) => {
    const edges = sourceEdges.get(from) ?? [];
    edges.push({ node: to, voltage });
    sourceEdges.set(from, edges);
  };
  for (const branch of layout.branches) {
    if (branch.kind !== "ac-source" || branch.positiveNode === branch.negativeNode) { continue; }
    addSourceEdge(branch.negativeNode, branch.positiveNode, branch.sourceVoltage);
    addSourceEdge(branch.positiveNode, branch.negativeNode, complex(-branch.sourceVoltage.real, -branch.sourceVoltage.imaginary));
  }

  // Follow series AC sources away from the original reference. Accumulating
  // their phasors finds a useful re-reference even when no large source is
  // directly connected to GND.
  const estimatedOffsets = new Map<number, ComplexValue>([[referenceNode, complex()]]);
  const pending = [referenceNode];
  for (const from of pending) {
    const fromOffset = estimatedOffsets.get(from)!;
    for (const edge of sourceEdges.get(from) ?? []) {
      if (estimatedOffsets.has(edge.node)) { continue; }
      const estimatedOffset = complexAdd(fromOffset, edge.voltage);
      if (!Number.isFinite(estimatedOffset.real) || !Number.isFinite(estimatedOffset.imaginary)) { continue; }
      estimatedOffsets.set(edge.node, estimatedOffset);
      pending.push(edge.node);
    }
  }
  return estimatedOffsets;
}

function acReferenceCandidates(
  document: CircuitDocument,
  layout: MnaLayout,
  values: ComplexValue[],
): AcReferenceCandidate[] {
  const referenceNode = layout.topology.referenceNode;
  const candidatesByNode = new Map<number, AcReferenceCandidate>();
  const addCandidate = (candidate: AcReferenceCandidate | null) => {
    if (candidate) {
      const previous = candidatesByNode.get(candidate.node);
      if (!previous || candidate.logMagnitude > previous.logMagnitude) {
        candidatesByNode.set(candidate.node, candidate);
      }
    }
  };

  // Resonant networks can create a large AC node voltage without a large
  // voltage source on the path from GND. Include the highest solved node in
  // each connected component so it can become a numerical reference when
  // branch equations show that subtraction has lost a smaller voltage.
  const solvedCandidateByComponent = new Map<number, AcReferenceCandidate>();
  const componentIds = acReferenceComponentIds(document, layout);
  for (let node = 0; node < layout.topology.nodeCount; node += 1) {
    const candidate = acReferenceCandidate(node, referenceNode, nodeComplexValue(layout, node, values));
    if (!candidate) { continue; }
    const component = componentIds[node] ?? node;
    const previous = solvedCandidateByComponent.get(component);
    if (!previous || candidate.logMagnitude > previous.logMagnitude) {
      solvedCandidateByComponent.set(component, candidate);
    }
  }
  for (const candidate of solvedCandidateByComponent.values()) { addCandidate(candidate); }

  for (const [node, estimatedOffset] of acReferenceCandidatesFromSources(layout)) {
    addCandidate(acReferenceCandidate(node, referenceNode, estimatedOffset));
  }

  return [...candidatesByNode.values()]
    .sort((left, right) => right.logMagnitude - left.logMagnitude);
}

function acBranchEquationResidual(layout: MnaLayout, solution: ComplexValue[]) {
  let maximum = 0;
  for (const branch of [...layout.branches, ...layout.internalBranches]) {
    const nodeVoltage = voltageDifference(
      nodeComplexValue(layout, branch.positiveNode, solution),
      nodeComplexValue(layout, branch.negativeNode, solution),
    );
    const branchVoltage = voltageFromBranch(branch, solution);
    const scale = Math.max(
      Math.abs(nodeVoltage.real),
      Math.abs(nodeVoltage.imaginary),
      Math.abs(branchVoltage.real),
      Math.abs(branchVoltage.imaginary),
      Number.MIN_VALUE,
    );
    const normalizedResidual = Math.hypot(
      (nodeVoltage.real - branchVoltage.real) / scale,
      (nodeVoltage.imaginary - branchVoltage.imaginary) / scale,
    );
    if (!Number.isFinite(normalizedResidual)) { return Number.POSITIVE_INFINITY; }
    maximum = Math.max(maximum, normalizedResidual);
  }
  return maximum;
}

function layoutWithReferenceNode(layout: MnaLayout, referenceNode: number): MnaLayout {
  const nodeUnknowns = buildNodeUnknowns(layout.topology.nodeCount, referenceNode);
  return {
    ...layout,
    topology: {
      ...layout.topology,
      referenceNode,
      nodeUnknowns: nodeUnknowns.nodeUnknowns,
      nodeUnknownCount: nodeUnknowns.nodeUnknownCount,
    },
  };
}

function acReferenceComponentIds(document: CircuitDocument, layout: MnaLayout) {
  const parent = Array.from({ length: layout.topology.nodeCount }, (_, index) => index);
  const switchStates = Object.fromEntries(document.parts
    .filter((part) => part.kind === "switch")
    .map((part) => [part.id, layout.branchByPartId.has(part.id)]));
  for (const part of document.parts) {
    const reactiveBranchIsModeled = layout.branchByPartId.has(part.id) ||
      layout.unboundedReactiveAdmittances.has(part.id);
    if (part.kind === "inductor" && !reactiveBranchIsModeled) { continue; }
    unionPartConduction(
      part,
      layout.topology,
      parent,
      switchStates,
      layout.initialInductorCurrents,
      layout.physicalReferenceNode,
    );
    if (part.kind === "capacitor" && reactiveBranchIsModeled) {
      joinConductiveNodes(
        parent,
        nodeForTerminal(layout.topology, part, "a"),
        nodeForTerminal(layout.topology, part, "b"),
      );
    }
  }
  return Array.from({ length: layout.topology.nodeCount }, (_, node) => findRoot(parent, node));
}

function acReferenceComponent(
  document: CircuitDocument,
  layout: MnaLayout,
  seedNode: number,
) {
  return referenceComponentNodes(document, layout, seedNode, "ac");
}

function nonlinearAcModelIsCommonModeInvariant(
  document: CircuitDocument,
  layout: MnaLayout,
  dcState: Float64Array,
) {
  for (const part of document.parts) {
    const model = nonlinearModel(part, nonlinearTerminalVoltages(part, layout, dcState));
    if (!model) { continue; }
    for (let rowIndex = 0; rowIndex < model.jacobian.length; rowIndex += 1) {
      let sum = nonlinearReferenceDerivative(part, model, rowIndex);
      let scale = Math.abs(sum);
      const row = model.jacobian[rowIndex] ?? [];
      for (const value of row) {
        if (!Number.isFinite(value)) { return false; }
        sum += value;
        scale += Math.abs(value);
      }
      if (!Number.isFinite(sum) || !Number.isFinite(scale) || Math.abs(sum) > 32 * Number.EPSILON * scale) {
        return false;
      }
    }
  }
  return true;
}

function rebasedAcSolutionForQuality(
  document: CircuitDocument,
  layout: MnaLayout,
  dcState: Float64Array,
  frequencyHz: number,
  originalKclQuality: number,
  originalResidual: number,
): AcSolution | null {
  let bestSolution: AcSolution | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const referenceNode of preferredReferenceNodes(document, layout, "ac").slice(0, 8)) {
    const rebasedLayout = layoutWithReferenceNode(layout, referenceNode);
    const rebasedValues = solveAcForLayout(document, rebasedLayout, layout, dcState);
    if (!rebasedValues) { continue; }
    const rebasedResidual = acBranchEquationResidual(rebasedLayout, rebasedValues);
    if (rebasedResidual > 1e-10) { continue; }
    const rebasedKclQuality = acKclQuality(
      document,
      rebasedLayout,
      layout,
      rebasedValues,
      frequencyHz,
      dcState,
    );
    const improvesKcl = rebasedKclQuality < originalKclQuality * 0.5;
    const improvesBranchEquations = originalResidual > 1e-10 &&
      rebasedResidual < originalResidual * 0.1 &&
      rebasedKclQuality <= Math.max(originalKclQuality, 1e-12);
    if (!improvesKcl && !improvesBranchEquations) { continue; }

    const score = Math.max(rebasedKclQuality, rebasedResidual);
    if (score < bestScore) {
      const originalReferenceVoltage = nodeComplexValue(
        rebasedLayout,
        layout.topology.referenceNode,
        rebasedValues,
      );
      const offset = complex(-originalReferenceVoltage.real, -originalReferenceVoltage.imaginary);
      const component = acReferenceComponent(document, rebasedLayout, referenceNode);
      bestSolution = {
        layout: rebasedLayout,
        biasLayout: layout,
        values: rebasedValues,
        nodeVoltageOffsets: component.map((isInReferenceComponent) =>
          isInReferenceComponent ? offset : complex()),
      };
      bestScore = score;
    }
    if (rebasedKclQuality <= 1e-12) { return bestSolution; }
  }
  return bestSolution;
}

function solveAc(
  document: CircuitDocument,
  layout: MnaLayout,
  dcState: Float64Array,
  frequencyHz: number,
): AcSolution | null {
  const values = solveAcForLayout(document, layout, layout, dcState);
  if (!values) { return null; }
  const noOffsets = Array.from({ length: layout.topology.nodeCount }, () => complex());
  const solution: AcSolution = { layout, biasLayout: layout, values, nodeVoltageOffsets: noOffsets };

  // Re-referencing is safe only when every nonlinear small-signal stamp is
  // common-mode invariant. The op-amp stamp includes its physical GND return.
  if (!nonlinearAcModelIsCommonModeInvariant(document, layout, dcState)) { return solution; }

  const originalKclQuality = acKclQuality(document, layout, layout, values, frequencyHz, dcState);
  const originalResidual = acBranchEquationResidual(layout, values);
  if (originalKclQuality > 1e-12 || originalResidual > 1e-10) {
    const rebasedSolution = rebasedAcSolutionForQuality(
      document,
      layout,
      dcState,
      frequencyHz,
      originalKclQuality,
      originalResidual,
    );
    if (rebasedSolution) { return rebasedSolution; }
  }

  if (originalResidual <= 1e-10) { return solution; }
  for (const candidate of acReferenceCandidates(document, layout, values)) {
    const rebasedLayout = layoutWithReferenceNode(layout, candidate.node);
    const rebasedValues = solveAcForLayout(document, rebasedLayout, layout, dcState);
    if (!rebasedValues) { continue; }
    const rebasedResidual = acBranchEquationResidual(rebasedLayout, rebasedValues);
    if (rebasedResidual > 1e-10 || rebasedResidual >= originalResidual * 0.1) { continue; }

    // Restore the original public reference from the solved re-based value.
    // This remains exact at GND even when the source path has series impedance.
    const originalReferenceVoltage = nodeComplexValue(
      rebasedLayout,
      layout.topology.referenceNode,
      rebasedValues,
    );
    const offset = complex(-originalReferenceVoltage.real, -originalReferenceVoltage.imaginary);
    const component = acReferenceComponent(document, rebasedLayout, candidate.node);
    return {
      layout: rebasedLayout,
      biasLayout: layout,
      values: rebasedValues,
      nodeVoltageOffsets: component.map((isInReferenceComponent) =>
        isInReferenceComponent ? offset : complex()),
    };
  }
  return solution;
}

function terminalComplexValues(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
) {
  return terminalsOf(part.kind).map((terminal) => {
    const node = layout.topology.terminalNodes.get(endpointKey(part.id, terminal));
    return node === undefined ? complex() : nodeComplexValue(layout, node, solution);
  });
}

function voltageDifference(left: ComplexValue, right: ComplexValue) {
  return complex(left.real - right.real, left.imaginary - right.imaginary);
}

function currentsFromVoltageBranch(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
): ComplexValue[] | null {
  const branch = layout.branchByPartId.get(part.id);
  if (!branch) { return null; }
  const value = branchCurrentValue(branch, solution);
  if (value.real === 0 && value.imaginary === 0) { return [complex(), complex()]; }
  return [value, complex(-value.real, -value.imaginary)];
}

function branchCurrentValue(branch: Branch, solution: ComplexValue[]) {
  const scaledCurrent = solution[branch.unknownIndex] ?? complex();
  const scale = branch.acCurrentScale ?? 1;
  return scale === 1
    ? scaledCurrent
    : complex(scaledCurrent.real / scale, scaledCurrent.imaginary / scale);
}

function reactiveCurrent(part: CircuitPart, frequencyHz: number | undefined, voltage: ComplexValue) {
  if (voltage.real === 0 && voltage.imaginary === 0) { return complex(); }
  return complexMultiply(acReactiveAdmittance(part, frequencyHz ?? 0), voltage);
}

function passiveTerminalCurrents(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
): ComplexValue[] | null {
  const voltages = terminalComplexValues(part, layout, solution);
  const va = voltages[0] ?? complex();
  const vb = voltages[1] ?? complex();
  const vdiff = voltageDifference(va, vb);
  const terminalCount = terminalsOf(part.kind).length;
  if (part.kind === "resistor" || part.kind === "bulb") {
    const current = complex(vdiff.real / resistorValue(part), vdiff.imaginary / resistorValue(part));
    return [current, complex(-current.real, -current.imaginary)];
  }
  if (part.kind === "potentiometer") {
    const vc = voltages[2] ?? complex();
    const segments = potentiometerSegments(part);
    const segmentBranches = layout.internalBranchesByPartId.get(part.id) ?? [];
    const currentForSegment = (
      terminal: "a" | "b",
      outerVoltage: ComplexValue,
      resistance: number,
    ) => {
      const branch = segmentBranches.find(
        (candidate) => candidate.internalPotentiometerTerminal === terminal,
      );
      if (branch) { return branchCurrentValue(branch, solution); }
      if (resistance === 0) { return complex(); }
      return complex(
        (outerVoltage.real - vc.real) / resistance,
        (outerVoltage.imaginary - vc.imaginary) / resistance,
      );
    };
    const currentA = currentForSegment("a", va, segments.ac);
    const currentB = currentForSegment("b", vb, segments.cb);
    return [
      currentA,
      currentB,
      complex(-currentA.real - currentB.real, -currentA.imaginary - currentB.imaginary),
    ];
  }
  if (part.kind === "current-source") {
    const current = mode === "dc" ? (part.currentAmps ?? 0) : 0;
    return [complex(current), complex(-current)];
  }
  if ((part.kind === "capacitor" || part.kind === "inductor") && mode === "ac") {
    // A reactance outside the representable range is stamped as a Norton
    // admittance when that admittance remains representable; only a zero or
    // unrepresentable admittance is an open branch.
    if (
      !layout.branchByPartId.has(part.id) &&
      !layout.unboundedReactiveAdmittances.has(part.id)
    ) {
      return [complex(), complex()];
    }
    const current = reactiveCurrent(part, frequencyHz, vdiff);
    return [current, complex(-current.real, -current.imaginary)];
  }
  return Array.from({ length: terminalCount }, () => complex());
}

function nonlinearTerminalCurrents(
  part: CircuitPart,
  layout: MnaLayout,
  biasLayout: MnaLayout,
  solution: ComplexValue[],
  mode: AnalogAnalysisMode,
  dcState: Float64Array,
): ComplexValue[] {
  const terminals = terminalsOf(part.kind);
  const model = nonlinearModel(part, nonlinearTerminalVoltages(part, biasLayout, dcState));
  if (!model) { return terminals.map(() => complex()); }
  if (mode === "dc") { return model.currents.map((current) => complex(current)); }

  const phasors = terminalComplexValues(part, layout, solution);
  return terminals.map((_, row) => {
    let real = 0;
    let imaginary = 0;
    for (let column = 0; column < terminals.length; column += 1) {
      const delta = phasors[column] ?? complex();
      const slope = model.jacobian[row]?.[column] ?? 0;
      real += slope * delta.real;
      imaginary += slope * delta.imaginary;
    }
    const referenceSlope = nonlinearReferenceDerivative(part, model, row);
    if (referenceSlope !== 0) {
      const reference = nodeComplexValue(layout, layout.physicalReferenceNode, solution);
      real += referenceSlope * reference.real;
      imaginary += referenceSlope * reference.imaginary;
    }
    return complex(real, imaginary);
  });
}

function terminalCurrentsForPart(
  part: CircuitPart,
  layout: MnaLayout,
  biasLayout: MnaLayout,
  solution: ComplexValue[],
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  dcState: Float64Array,
): ComplexValue[] {
  if (part.kind === "inductor" && layout.initialInductorCurrents) {
    const current = part.initialCurrentAmps ?? 0;
    return [complex(current), complex(-current)];
  }
  const branchCurrents = currentsFromVoltageBranch(part, layout, solution);
  if (branchCurrents) { return branchCurrents; }
  if (
    part.kind === "resistor" || part.kind === "bulb" || part.kind === "potentiometer" ||
    part.kind === "current-source" || part.kind === "capacitor" || part.kind === "inductor"
  ) {
    return passiveTerminalCurrents(part, layout, solution, mode, frequencyHz) ?? [];
  }
  return nonlinearTerminalCurrents(part, layout, biasLayout, solution, mode, dcState);
}

function acKclQuality(
  document: CircuitDocument,
  layout: MnaLayout,
  biasLayout: MnaLayout,
  solution: ComplexValue[],
  frequencyHz: number,
  dcState: Float64Array,
) {
  const currentsByNode = Array.from({ length: layout.topology.nodeCount }, () => [] as ComplexValue[]);
  for (const part of document.parts) {
    const currents = terminalCurrentsForPart(part, layout, biasLayout, solution, "ac", frequencyHz, dcState);
    const terminals = terminalsOf(part.kind);
    for (let index = 0; index < terminals.length; index += 1) {
      const node = nodeForTerminal(layout.topology, part, terminals[index] ?? "a");
      currentsByNode[node]?.push(currents[index] ?? complex());
    }
    if (part.kind === "op-amp") {
      const outputCurrent = currents[2] ?? complex();
      currentsByNode[layout.physicalReferenceNode]?.push(complex(-outputCurrent.real, -outputCurrent.imaginary));
    }
  }

  let quality = 0;
  for (const currents of currentsByNode) {
    const scale = Math.max(
      0,
      ...currents.flatMap((current) => [Math.abs(current.real), Math.abs(current.imaginary)]),
    );
    if (scale === 0) { continue; }
    const normalizedReal = currents.map((current) => current.real / scale);
    const normalizedImaginary = currents.map((current) => current.imaginary / scale);
    const residualReal = exactComponentSum(normalizedReal);
    const residualImaginary = exactComponentSum(normalizedImaginary);
    const residual = Math.hypot(residualReal, residualImaginary);
    const equationScale = currents.reduce(
      (sum, current) => sum + Math.hypot(current.real / scale, current.imaginary / scale),
      0,
    );
    if (equationScale > 0) { quality = Math.max(quality, residual / equationScale); }
  }
  return quality;
}

interface DcSolution {
  state?: Float64Array;
  converged: boolean;
  singular: boolean;
  invalidPhysicalSolution?: boolean;
  layout?: MnaLayout;
  nodeVoltageOffsets?: ComplexValue[];
}

function dcKclQuality(document: CircuitDocument, layout: MnaLayout, state: Float64Array) {
  const values = Array.from({ length: layout.size }, (_, index) => complex(state[index] ?? 0));
  const currentsByNode = Array.from({ length: layout.topology.nodeCount }, () => [] as number[]);
  for (const part of document.parts) {
    const currents = terminalCurrentsForPart(part, layout, layout, values, "dc", undefined, state);
    const terminals = terminalsOf(part.kind);
    for (let index = 0; index < terminals.length; index += 1) {
      const node = nodeForTerminal(layout.topology, part, terminals[index] ?? "a");
      currentsByNode[node]?.push(currents[index]?.real ?? 0);
    }
    if (part.kind === "op-amp") {
      currentsByNode[layout.physicalReferenceNode]?.push(-(currents[2]?.real ?? 0));
    }
  }

  let quality = 0;
  for (const currents of currentsByNode) {
    const scale = Math.max(0, ...currents.map(Math.abs));
    if (scale === 0) { continue; }
    const normalized = currents.map((current) => current / scale);
    const residual = Math.abs(exactComponentSum(normalized));
    const equationScale = normalized.reduce((sum, current) => sum + Math.abs(current), 0);
    if (equationScale > 0) { quality = Math.max(quality, residual / equationScale); }
  }
  return quality;
}

function dcReferenceOffsets(document: CircuitDocument, layout: MnaLayout, state: Float64Array) {
  const referenceNode = layout.physicalReferenceNode;
  const offset = -nodeRealValue(layout, referenceNode, state);
  const component = referenceComponentNodes(document, layout, referenceNode, "dc");
  return component.map((isReferenceComponent) => complex(isReferenceComponent ? offset : 0));
}

function restoreFloatingReferenceOffsets(
  document: CircuitDocument,
  layout: MnaLayout,
  solution: ComplexValue[],
  initialOffsets: ComplexValue[],
  mode: AnalogAnalysisMode,
) {
  if (layout.initialInductorCurrents) { return initialOffsets; }
  const componentIds = referenceComponentIds(document, layout, mode);
  const physicalReferenceRoot = componentIds[layout.physicalReferenceNode];
  const firstNodeByRoot = new Map<number, number>();
  for (let node = 0; node < componentIds.length; node += 1) {
    const root = componentIds[node];
    if (root !== undefined && !firstNodeByRoot.has(root)) { firstNodeByRoot.set(root, node); }
  }

  const offsets = Array.from({ length: layout.topology.nodeCount }, (_, node) => {
    const offset = initialOffsets[node] ?? complex();
    return complex(offset.real, offset.imaginary);
  });
  for (const [root, anchor] of firstNodeByRoot) {
    if (root === physicalReferenceRoot) { continue; }
    const potential = nodeComplexValue(layout, anchor, solution);
    const offset = complex(-potential.real, -potential.imaginary);
    for (let node = 0; node < componentIds.length; node += 1) {
      if (componentIds[node] !== root) { continue; }
      offsets[node] = complex(offset.real, offset.imaginary);
    }
  }
  return offsets;
}

function solveDc(
  document: CircuitDocument,
  layout: MnaLayout,
  adjustReference = false,
): DcSolution {
  const baseline = solveDcAtReference(document, layout);
  const baselineResult: DcSolution = {
    ...baseline,
    layout,
    nodeVoltageOffsets: Array.from({ length: layout.topology.nodeCount }, () => complex()),
  };
  if (!adjustReference || !canAdjustDcReference(document, layout)) { return baselineResult; }
  if (baseline.converged && baseline.state && dcKclQuality(document, layout, baseline.state) <= 1e-12) {
    return baselineResult;
  }

  const baselineQuality = baseline.converged && baseline.state
    ? dcKclQuality(document, layout, baseline.state)
    : Number.POSITIVE_INFINITY;
  let best = baselineResult;
  let bestQuality = baselineQuality;
  // A second- or third-strongest node can yield a much better-scaled KCL row
    // when the strongest candidate shares another badly conditioned branch.
  for (const referenceNode of preferredReferenceNodes(document, layout, "dc").slice(0, 8)) {
    const candidateLayout = layoutWithReferenceNode(layout, referenceNode);
    const candidate = solveDcAtReference(document, candidateLayout);
    if (!candidate.converged || !candidate.state) { continue; }
    const candidateQuality = dcKclQuality(document, candidateLayout, candidate.state);
    if (candidateQuality < bestQuality) {
      best = {
        ...candidate,
        layout: candidateLayout,
        nodeVoltageOffsets: dcReferenceOffsets(document, candidateLayout, candidate.state),
      };
      bestQuality = candidateQuality;
    }
    if (candidateQuality <= 1e-12) { return best; }
  }
  if (best === baselineResult || !(bestQuality < baselineQuality * 0.5)) { return baselineResult; }
  return best;
}

function primaryVoltage(part: CircuitPart, values: ComplexValue[]) {
  if (
    part.kind === "npn-transistor" ||
    part.kind === "pnp-transistor" ||
    part.kind === "nmos" ||
    part.kind === "pmos"
  ) {
    return voltageDifference(values[0] ?? complex(), values[2] ?? complex());
  }
  if (part.kind === "op-amp") { return values[2] ?? complex(); }
  if (part.kind === "ground" || part.kind === "junction") { return complex(); }
  return voltageDifference(values[0] ?? complex(), values[1] ?? complex());
}

function primaryCurrent(part: CircuitPart, values: ComplexValue[]) {
  return part.kind === "op-amp" ? (values[2] ?? complex()) : (values[0] ?? complex());
}

function componentPower(
  part: CircuitPart,
  voltageValues: ComplexValue[],
  currentValues: ComplexValue[],
) {
  let power = complex();
  const reference = part.kind === "op-amp"
    ? complex()
    : (voltageValues.at(-1) ?? complex());
  for (let index = 0; index < voltageValues.length; index += 1) {
    const voltage = voltageValues[index] ?? complex();
    const relativeVoltage = part.kind === "op-amp"
      ? voltage
      : voltageDifference(voltage, reference);
    power = {
      real:
        power.real +
        complexMultiply(relativeVoltage, complexConjugate(currentValues[index] ?? complex())).real,
      imaginary:
        power.imaginary +
        complexMultiply(relativeVoltage, complexConjugate(currentValues[index] ?? complex())).imaginary,
    };
  }
  return power;
}

function impedanceMeasurements(resistance: number, reactance: number, current: ComplexValue) {
  const voltage = complexMultiply(complex(resistance, reactance), current);
  const power = complexMultiply(voltage, complexConjugate(current));
  return {
    voltage,
    power: complex(resistance === 0 ? 0 : power.real, reactance === 0 ? 0 : power.imaginary),
  };
}

function voltageFromBranch(branch: Branch, solution: ComplexValue[]) {
  const current = solution[branch.unknownIndex] ?? complex();
  const scale = branch.acCurrentScale ?? 1;
  if (scale === 1) {
    return complexAdd(
      branch.sourceVoltage,
      complexMultiply(complex(branch.seriesResistanceOhms, branch.seriesReactanceOhms ?? 0), current),
    );
  }
  return complexAdd(
    branch.sourceVoltage,
    complexMultiply(
      complex(branch.seriesResistanceOhms / scale, (branch.seriesReactanceOhms ?? 0) / scale),
      current,
    ),
  );
}

function recoverResolvedBranchVoltageComponents(
  branchVoltage: ComplexValue,
  terminalVoltages: ComplexValue[],
) {
  const positiveNodeVoltage = terminalVoltages[0] ?? complex();
  const negativeNodeVoltage = terminalVoltages[1] ?? complex();
  const nodeVoltage = voltageDifference(positiveNodeVoltage, negativeNodeVoltage);
  const resolvedComponent = (
    branchValue: number,
    nodeValue: number,
    positiveValue: number,
    negativeValue: number,
  ) => {
    if (branchValue !== 0 || nodeValue === 0) { return branchValue; }
    // A node difference is useful only when it is clearly above the rounding
    // interval of its own coordinates. This rescues orthogonal tiny drops that
    // the scaled branch-current product can underflow, while retaining the
    // branch equation when common-mode subtraction cannot resolve a voltage.
    const coordinateScale = Math.max(Math.abs(positiveValue), Math.abs(negativeValue));
    const roundingInterval = 2 * Number.EPSILON * coordinateScale;
    return Math.abs(nodeValue) > roundingInterval ? nodeValue : branchValue;
  };
  return complex(
    resolvedComponent(
      branchVoltage.real,
      nodeVoltage.real,
      positiveNodeVoltage.real,
      negativeNodeVoltage.real,
    ),
    resolvedComponent(
      branchVoltage.imaginary,
      nodeVoltage.imaginary,
      positiveNodeVoltage.imaginary,
      negativeNodeVoltage.imaginary,
    ),
  );
}

interface BranchVoltagePathEdge {
  node: number;
  voltage: ComplexValue;
  cost: number;
}

interface BranchVoltagePair {
  first: Branch;
  ideal?: Branch;
}

interface BranchVoltagePathContext {
  branches: Branch[];
  directBranches: Map<number, BranchVoltagePair>;
  adjacency?: BranchVoltagePathEdge[][] | null;
  paths: Map<number, ComplexValue | null>;
}

function branchVoltagePathContext(layout: MnaLayout): BranchVoltagePathContext {
  const branches = [...layout.branches, ...layout.internalBranches];
  const directBranches = new Map<number, BranchVoltagePair>();
  for (const branch of branches) {
    if (branch.positiveNode === branch.negativeNode) { continue; }
    const lowNode = Math.min(branch.positiveNode, branch.negativeNode);
    const highNode = Math.max(branch.positiveNode, branch.negativeNode);
    const pairKey = lowNode * layout.topology.nodeCount + highNode;
    const pair = directBranches.get(pairKey);
    const isIdeal = branch.seriesResistanceOhms === 0 && (branch.seriesReactanceOhms ?? 0) === 0;
    if (!pair) {
      directBranches.set(pairKey, { first: branch, ...(isIdeal ? { ideal: branch } : {}) });
    } else if (isIdeal && !pair.ideal) {
      pair.ideal = branch;
    }
  }
  return { branches, directBranches, paths: new Map() };
}

function branchVoltageAdjacency(
  context: BranchVoltagePathContext,
  layout: MnaLayout,
  solution: ComplexValue[],
) {
  const values: Array<{ branch: Branch; voltage: ComplexValue; magnitude: number }> = [];
  for (const branch of context.branches) {
    if (branch.positiveNode === branch.negativeNode) { continue; }
    const voltage = voltageFromBranch(branch, solution);
    const magnitude = complexMagnitude(voltage);
    if (Number.isFinite(magnitude)) { values.push({ branch, voltage, magnitude }); }
  }
  if (values.length === 0) { return null; }

  const largestMagnitude = Math.max(...values.map(({ magnitude }) => magnitude));
  const adjacency: BranchVoltagePathEdge[][] = Array.from(
    { length: layout.topology.nodeCount },
    () => [],
  );
  for (const { branch, voltage, magnitude } of values) {
    const cost = largestMagnitude === 0 ? 0 : magnitude / largestMagnitude;
    adjacency[branch.positiveNode]?.push({ node: branch.negativeNode, voltage, cost });
    adjacency[branch.negativeNode]?.push({
      node: branch.positiveNode,
      voltage: complex(-voltage.real, -voltage.imaginary),
      cost,
    });
  }
  return adjacency;
}

function leastCostUnvisitedNode(costs: number[], hops: number[], visited: Uint8Array) {
  let node = -1;
  for (let candidate = 0; candidate < costs.length; candidate += 1) {
    if (visited[candidate] || !Number.isFinite(costs[candidate])) { continue; }
    if (
      node < 0 || costs[candidate]! < costs[node]! ||
      (costs[candidate] === costs[node] && hops[candidate]! < hops[node]!)
    ) {
      node = candidate;
    }
  }
  return node;
}

function shortestBranchVoltagePath(
  positiveNode: number,
  negativeNode: number,
  adjacency: BranchVoltagePathEdge[][],
) {
  const costs = Array.from({ length: adjacency.length }, () => Number.POSITIVE_INFINITY);
  const hops = Array.from({ length: adjacency.length }, () => Number.POSITIVE_INFINITY);
  const previousNodes = Array.from({ length: adjacency.length }, () => -1);
  const previousVoltages: Array<ComplexValue | undefined> = Array.from(
    { length: adjacency.length },
    () => undefined,
  );
  const visited = new Uint8Array(adjacency.length);
  costs[positiveNode] = 0;
  hops[positiveNode] = 0;

  let remaining = adjacency.length;
  while (remaining > 0) {
    const node = leastCostUnvisitedNode(costs, hops, visited);
    if (node < 0 || node === negativeNode) { break; }
    visited[node] = 1;
    remaining -= 1;

    for (const edge of adjacency[node] ?? []) {
      if (visited[edge.node]) { continue; }
      const candidateCost = costs[node]! + edge.cost;
      const candidateHops = hops[node]! + 1;
      if (
        candidateCost < costs[edge.node]! ||
        (candidateCost === costs[edge.node] && candidateHops < hops[edge.node]!)
      ) {
        costs[edge.node] = candidateCost;
        hops[edge.node] = candidateHops;
        previousNodes[edge.node] = node;
        previousVoltages[edge.node] = edge.voltage;
      }
    }
  }

  if (!Number.isFinite(costs[negativeNode])) { return null; }
  return sumBranchVoltagePath(positiveNode, negativeNode, previousNodes, previousVoltages);
}

function sumBranchVoltagePath(
  positiveNode: number,
  negativeNode: number,
  previousNodes: number[],
  previousVoltages: Array<ComplexValue | undefined>,
) {
  const realParts: number[] = [];
  const imaginaryParts: number[] = [];
  for (let node = negativeNode; node !== positiveNode;) {
    const edgeVoltage = previousVoltages[node];
    const previous = previousNodes[node] ?? -1;
    if (edgeVoltage === undefined || previous < 0) { return null; }
    realParts.push(edgeVoltage.real);
    imaginaryParts.push(edgeVoltage.imaginary);
    node = previous;
  }
  // A path can contain individually finite source drops whose intermediate
  // floating-point sum overflows, even though their final difference is small.
  return complex(exactComponentSum(realParts), exactComponentSum(imaginaryParts));
}

function voltageFromBranchPath(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
  context: BranchVoltagePathContext | null,
): ComplexValue | null {
  if (part.kind !== "voltmeter") { return null; }
  const positiveNode = nodeForTerminal(layout.topology, part, "a");
  const negativeNode = nodeForTerminal(layout.topology, part, "b");
  if (positiveNode === negativeNode) { return complex(); }
  if (!context) { return null; }
  const lowNode = Math.min(positiveNode, negativeNode);
  const highNode = Math.max(positiveNode, negativeNode);
  const pairKey = lowNode * layout.topology.nodeCount + highNode;
  const pair = context.directBranches.get(pairKey);
  const directBranch = pair?.ideal ?? pair?.first;
  if (directBranch) {
    const voltage = voltageFromBranch(directBranch, solution);
    return directBranch.positiveNode === positiveNode
      ? voltage
      : complex(-voltage.real, -voltage.imaginary);
  }
  // A voltmeter can span several elements. Sum their branch-equation voltages
  // instead of subtracting two large node phasors, which can discard small drops.
  // Among alternate routes, prefer the one with the least total voltage magnitude
  // to avoid cancellation between a large source and a large load drop.
  if (context.adjacency === undefined) {
    context.adjacency = branchVoltageAdjacency(context, layout, solution);
  }
  const pathKey = positiveNode * layout.topology.nodeCount + negativeNode;
  if (context.paths.has(pathKey)) { return context.paths.get(pathKey) ?? null; }
  const voltage = context.adjacency
    ? shortestBranchVoltagePath(positiveNode, negativeNode, context.adjacency)
    : null;
  context.paths.set(pathKey, voltage);
  context.paths.set(
    negativeNode * layout.topology.nodeCount + positiveNode,
    voltage ? complex(-voltage.real, -voltage.imaginary) : null,
  );
  return voltage;
}

function resistiveMeasurements(part: CircuitPart, currents: ComplexValue[]) {
  if (part.kind === "resistor" || part.kind === "bulb") {
    return impedanceMeasurements(resistorValue(part), 0, currents[0] ?? complex());
  }
  if (part.kind !== "potentiometer") { return null; }
  const segments = potentiometerSegments(part);
  const ac = impedanceMeasurements(segments.ac, 0, currents[0] ?? complex());
  const bc = impedanceMeasurements(segments.cb, 0, currents[1] ?? complex());
  return {
    voltage: voltageDifference(ac.voltage, bc.voltage),
    power: complex(ac.power.real + bc.power.real),
  };
}

function makeNodeVoltages(
  layout: MnaLayout,
  solution: ComplexValue[],
  nodeVoltageOffsets: ComplexValue[] = [],
) {
  const nodes: Record<string, ComplexValue> = {};
  for (let node = 0; node < layout.topology.nodeCount; node += 1) {
    const label = layout.topology.nodeLabels.get(node);
    if (label) {
      nodes[label] = complexAdd(
        nodeComplexValue(layout, node, solution),
        nodeVoltageOffsets[node] ?? complex(),
      );
    }
  }
  return nodes;
}

function componentMeasurements(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
  branchVoltagePaths: BranchVoltagePathContext | null,
  terminalVoltages: ComplexValue[],
  terminalCurrents: ComplexValue[],
  current: ComplexValue,
  mode: AnalogAnalysisMode,
) {
  const resistive = resistiveMeasurements(part, terminalCurrents);
  const reactiveBranch = layout.branchByPartId.get(part.id);
  const unboundedReactiveAdmittance = layout.unboundedReactiveAdmittances.get(part.id);
  const isReactivePart = part.kind === "capacitor" || part.kind === "inductor";
  const reactive = mode === "ac" && isReactivePart
    ? reactiveBranch
      ? impedanceMeasurements(0, reactiveBranch.seriesReactanceOhms ?? 0, current)
      : unboundedReactiveAdmittance
        ? (() => {
          const voltage = complexDivide(current, unboundedReactiveAdmittance);
          const power = complexMultiply(voltage, complexConjugate(current));
          return { voltage, power: complex(0, power.imaginary) };
        })()
        : null
    : null;
  const branch = layout.branchByPartId.get(part.id);
  const branchVoltage = branch ? voltageFromBranch(branch, solution) : null;
  const physicalReferenceVoltage = nodeComplexValue(layout, layout.physicalReferenceNode, solution);
  const opAmpVoltage = part.kind === "op-amp"
    ? voltageDifference(terminalVoltages[2] ?? complex(), physicalReferenceVoltage)
    : null;
  const derivedVoltage = resistive?.voltage ?? reactive?.voltage ?? branchVoltage ??
    voltageFromBranchPath(part, layout, solution, branchVoltagePaths) ?? opAmpVoltage ?? primaryVoltage(part, terminalVoltages);
  const scaledAcBranch = mode === "ac" && branch &&
    (part.kind === "resistor" || part.kind === "bulb" || part.kind === "capacitor" || part.kind === "inductor");
  const voltage = scaledAcBranch && branchVoltage
    ? recoverResolvedBranchVoltageComponents(branchVoltage, terminalVoltages)
    : derivedVoltage;
  const powerVoltages = part.kind === "op-amp"
    ? terminalVoltages.map((value) => voltageDifference(value, physicalReferenceVoltage))
    : terminalVoltages;
  const power = resistive?.power ?? reactive?.power ??
    (branchVoltage ? complexMultiply(voltage, complexConjugate(current)) : componentPower(part, powerVoltages, terminalCurrents));
  return { voltage, power };
}

function makeReadings(
  document: CircuitDocument,
  layout: MnaLayout,
  biasLayout: MnaLayout,
  solution: ComplexValue[],
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  dcState: Float64Array,
  switchStates: Record<string, boolean>,
  nodeVoltageOffsets: ComplexValue[] = [],
): Record<string, AnalogCircuitPartReading> {
  const parts: Record<string, AnalogCircuitPartReading> = {};
  const meterStatusByPart = meterStatuses(document, {
    mode,
    frequencyHz,
    switchStates,
    initialInductorCurrents: layout.initialInductorCurrents,
  });
  const branchVoltagePaths = document.parts.some((part) => part.kind === "voltmeter")
    ? branchVoltagePathContext(layout)
    : null;
  for (const part of document.parts) {
    const terminalVoltages = terminalComplexValues(part, layout, solution);
    const terminalCurrents = terminalCurrentsForPart(
      part,
      layout,
      biasLayout,
      solution,
      mode,
      frequencyHz,
      dcState,
    );
    const current = primaryCurrent(part, terminalCurrents);
    // Branch equations preserve small drops that subtraction of large node
    // potentials would lose to floating-point rounding.
    const { voltage, power } = componentMeasurements(
      part, layout, solution, branchVoltagePaths, terminalVoltages, terminalCurrents, current, mode,
    );
    const terminalVoltageMap: Partial<Record<CircuitTerminal, ComplexValue>> = {};
    const terminalCurrentMap: Partial<Record<CircuitTerminal, ComplexValue>> = {};
    const terminals = terminalsOf(part.kind);
    for (let index = 0; index < terminals.length; index += 1) {
      const terminal = terminals[index];
      if (terminal) {
        const node = layout.topology.terminalNodes.get(endpointKey(part.id, terminal));
        terminalVoltageMap[terminal] = complexAdd(
          terminalVoltages[index] ?? complex(),
          node === undefined ? complex() : (nodeVoltageOffsets[node] ?? complex()),
        );
        terminalCurrentMap[terminal] = terminalCurrents[index] ?? complex();
      }
    }
    const reading: AnalogCircuitPartReading = {
      voltage,
      current,
      power,
      terminalVoltages: terminalVoltageMap,
      terminalCurrents: terminalCurrentMap,
      ...(meterStatusByPart[part.id] ? { meterStatus: meterStatusByPart[part.id] } : {}),
    };
    if (part.kind === "bulb") {
      const rated = part.ratedPowerWatts ?? 2;
      reading.brightness = Math.min(1, Math.max(0, power.real / rated));
    }
    setRecordValue(parts, part.id, reading);
  }
  return parts;
}

function hasOnlyFiniteReadings(
  parts: Record<string, AnalogCircuitPartReading>,
  nodeVoltages: Record<string, ComplexValue>,
) {
  const finiteComplex = (value: ComplexValue) =>
    Number.isFinite(value.real) && Number.isFinite(value.imaginary);
  for (const reading of Object.values(parts)) {
    if (!finiteComplex(reading.voltage) || !finiteComplex(reading.current) || !finiteComplex(reading.power)) {
      return false;
    }
    if (reading.brightness !== undefined && !Number.isFinite(reading.brightness)) { return false; }
    if (Object.values(reading.terminalVoltages).some((value) => !value || !finiteComplex(value))) { return false; }
    if (Object.values(reading.terminalCurrents).some((value) => !value || !finiteComplex(value))) { return false; }
  }
  return Object.values(nodeVoltages).every(finiteComplex);
}

function frequencyFor(document: CircuitDocument, requested: number | undefined) {
  return acAnalysisFrequency(document, requested);
}

function analysisIssuesForAc(document: CircuitDocument, frequencyHz: number) {
  const issues: AnalogCircuitIssue[] = [];
  const sources = document.parts.filter((part) => part.kind === "ac-source");
  if (sources.length === 0) {
    issues.push({ severity: "info", message: "交流電源がないため、交流応答は0として計算しました。" });
  }
  for (const source of sources) {
    if (!frequencyMatches(source.frequencyHz ?? 0, frequencyHz)) {
      issues.push({
        severity: "info",
        partId: source.id,
        message: `${source.label}の周波数は解析周波数と異なるため、この交流解析では励振しません。`,
      });
    }
  }
  if (
    document.parts.some((part) =>
      part.kind === "diode" ||
      part.kind === "led" ||
      part.kind === "npn-transistor" ||
      part.kind === "pnp-transistor" ||
      part.kind === "nmos" ||
      part.kind === "pmos"
    )
  ) {
    issues.push({
      severity: "info",
      message: "半導体の交流応答は直流動作点の微分コンダクタンスで近似します。接合容量や寄生容量は含みません。",
    });
  }
  if (document.parts.some((part) => part.kind === "nmos" || part.kind === "pmos")) {
    issues.push({
      severity: "info",
      message: "MOSFETの簡易モデルではボディダイオードとゲート容量を省略しています。",
    });
  }
  return issues;
}

function dcResult(
  document: CircuitDocument,
  options: AnalogStepOptions,
  initialIssues: AnalogCircuitIssue[] = [],
): AnalogCircuitAnalysis {
  const mode = options.mode;
  const switchStates = options.switchStates === undefined ? {} : options.switchStates;
  const voltageOverrides = options.voltageOverrides ?? {};
  if (document.parts.length === 0) { return result("empty", mode, "部品を配置して回路を作成してください。"); }
  const issue = documentIssue(
    document,
    voltageOverrides,
    switchStates,
  );
  if (issue) {
    return result("invalid", mode, issue, { issues: [{ severity: "error", message: issue }] });
  }

  const topology = buildTopology(document);
  if (options.initialInductorCurrents) {
    const issues = initialInductorIssues(document, topology, switchStates);
    if (issues[0]) { return result("invalid", mode, issues[0].message, { issues }); }
  }
  const returnPathIssues = currentSourcePathIssues(document, topology, switchStates);
  const returnPathIssue = returnPathIssues[0];
  if (returnPathIssue) {
    return result("invalid", mode, returnPathIssue.message, { issues: returnPathIssues });
  }
  const prepared = buildLayout(
    document,
    topology,
    "dc",
    undefined,
    voltageOverrides,
    switchStates,
    options.initialInductorCurrents ?? false,
  );
  if (!prepared.layout) {
    const message = prepared.issue?.message ?? "回路を計算できませんでした。接続を確認してください。";
    return result("invalid", mode, message, { issues: prepared.issue ? [prepared.issue] : [] });
  }
  const solution = solveDc(document, prepared.layout, true);
  if (!solution.converged || !solution.state) {
    const message = dcSolutionFailureMessage(solution);
    return result("invalid", mode, message, {
      issues: [{ severity: "error", message }],
    });
  }

  const solvedLayout = solution.layout ?? prepared.layout;
  const values = Array.from({ length: prepared.layout.size }, (_, index) =>
    complex(solution.state?.[index] ?? 0),
  );
  const nodeVoltageOffsets = restoreFloatingReferenceOffsets(
    document,
    solvedLayout,
    values,
    solution.nodeVoltageOffsets ?? [],
    "dc",
  );
  const readings = makeReadings(
    document,
    solvedLayout,
    solvedLayout,
    values,
    "dc",
    undefined,
    solution.state,
    options.switchStates ?? {},
    nodeVoltageOffsets,
  );
  const nodeVoltages = makeNodeVoltages(solvedLayout, values, nodeVoltageOffsets);
  if (!hasOnlyFiniteReadings(readings, nodeVoltages)) {
    const message = "計算結果に有限でない電圧・電流・電力が含まれています。部品の値を確認してください。";
    return result("invalid", mode, message, { issues: [{ severity: "error", message }] });
  }
  const message = "直流動作点を計算しました。";
  return result("valid", mode, message, {
    parts: readings,
    nodeVoltages,
    issues: initialIssues,
  });
}

interface AcBias {
  topology: Topology;
  state: Float64Array;
}

function prepareAcBias(
  document: CircuitDocument,
  options: AnalogStepOptions,
  frequencyHz: number,
): AcBias | AnalogCircuitAnalysis {
  const topology = buildTopology(document);
  const requiresOperatingPoint = document.parts.some((part) =>
    part.kind === "diode" || part.kind === "led" ||
    part.kind === "npn-transistor" || part.kind === "pnp-transistor" ||
    part.kind === "nmos" || part.kind === "pmos" || part.kind === "op-amp"
  );
  if (!requiresOperatingPoint) {
    // Linear small-signal stamps do not depend on a DC operating point. Avoid rejecting
    // valid AC networks because their unrelated DC model has redundant ideal branches.
    return { topology, state: new Float64Array(0) };
  }
  const returnPathIssues = currentSourcePathIssues(document, topology, options.switchStates ?? {});
  const returnPathIssue = returnPathIssues[0];
  if (returnPathIssue) {
    return result("invalid", "ac", returnPathIssue.message, {
      frequencyHz,
      issues: returnPathIssues,
    });
  }
  const dcLayoutResult = buildLayout(
    document,
    topology,
    "dc",
    undefined,
    options.voltageOverrides ?? {},
    options.switchStates ?? {},
  );
  if (!dcLayoutResult.layout) {
    const message = dcLayoutResult.issue?.message ?? "直流動作点を利用できませんでした。";
    return result("invalid", "ac", message, {
      frequencyHz,
      issues: dcLayoutResult.issue ? [dcLayoutResult.issue] : [],
    });
  }
  const dcSolution = solveDc(document, dcLayoutResult.layout);
  if (!dcSolution.converged || !dcSolution.state) {
    const message = dcSolution.singular
      ? "交流解析の直流動作点を計算できません。理想電圧源のループや接続を確認してください。"
      : dcSolution.invalidPhysicalSolution
        ? "交流解析の直流動作点で実部品の電流・電圧のつり合いを満たせません。導通する戻り道と部品の値を確認してください。"
      : "交流解析に使う直流動作点が収束しませんでした。";
    return result("invalid", "ac", message, {
      frequencyHz,
      issues: [{ severity: "error", message }],
    });
  }
  return { topology, state: dcSolution.state };
}

function prepareAcSolution(
  document: CircuitDocument,
  options: AnalogStepOptions,
  frequencyHz: number,
  bias: AcBias,
): AcSolution | AnalogCircuitAnalysis {
  const prepared = buildLayout(
    document,
    bias.topology,
    "ac",
    frequencyHz,
    options.voltageOverrides ?? {},
    options.switchStates ?? {},
  );
  if (!prepared.layout) {
    const message = prepared.issue?.message ?? "交流回路を計算できませんでした。接続を確認してください。";
    return result("invalid", "ac", message, {
      frequencyHz,
      issues: prepared.issue ? [prepared.issue] : [],
    });
  }
  const solution = solveAc(document, prepared.layout, bias.state, frequencyHz);
  if (!solution) {
    const message = "交流回路を計算できません。理想電圧源のループや接続を確認してください。";
    return result("invalid", "ac", message, {
      frequencyHz,
      issues: [{ severity: "error", message }],
    });
  }
  return solution;
}

function acResult(document: CircuitDocument, options: AnalogStepOptions): AnalogCircuitAnalysis {
  if (document.parts.length === 0) { return result("empty", "ac", "部品を配置して回路を作成してください。"); }
  const requestedFrequency = frequencyFor(document, options.frequencyHz);
  if (requestedFrequency === undefined || !Number.isFinite(requestedFrequency) || requestedFrequency <= 0) {
    const message = "交流解析の周波数は0より大きい数値にしてください。";
    return result("invalid", "ac", message, { issues: [{ severity: "error", message }] });
  }
  const frequencyHz = requestedFrequency;
  const validation = documentIssue(
    document,
    options.voltageOverrides ?? {},
    options.switchStates === undefined ? {} : options.switchStates,
  );
  if (validation) {
    return result("invalid", "ac", validation, { issues: [{ severity: "error", message: validation }] });
  }

  const bias = prepareAcBias(document, options, frequencyHz);
  if ("status" in bias) { return bias; }
  const solution = prepareAcSolution(document, options, frequencyHz, bias);
  if ("status" in solution) { return solution; }

  const issues = analysisIssuesForAc(document, frequencyHz);
  const nodeVoltageOffsets = restoreFloatingReferenceOffsets(
    document,
    solution.layout,
    solution.values,
    solution.nodeVoltageOffsets,
    "ac",
  );
  const readings = makeReadings(
    document,
    solution.layout,
    solution.biasLayout,
    solution.values,
    "ac",
    frequencyHz,
    bias.state,
    options.switchStates ?? {},
    nodeVoltageOffsets,
  );
  const nodeVoltages = makeNodeVoltages(solution.layout, solution.values, nodeVoltageOffsets);
  if (!hasOnlyFiniteReadings(readings, nodeVoltages)) {
    const message = "計算結果に有限でない電圧・電流・電力が含まれています。部品の値を確認してください。";
    return result("invalid", "ac", message, {
      frequencyHz,
      issues: [{ severity: "error", message }],
    });
  }
  return result("valid", "ac", `${frequencyHz} Hz の小信号交流解析を計算しました。`, {
    frequencyHz,
    parts: readings,
    nodeVoltages,
    issues,
  });
}

/**
 * Solves one DC operating point or one small-signal AC frequency using modified nodal analysis.
 * Ideal voltage sources are represented by their branch-current unknowns, never by large conductances.
 */
export function solveAnalogStep(
  inputDocument: CircuitDocument,
  options: AnalogStepOptions,
): AnalogCircuitAnalysis {
  let mode: AnalogAnalysisMode = "dc";
  try {
    if (isSimulationRecord(options) && simulationRecordField(options, "mode") === "ac") { mode = "ac"; }
  } catch {
    const message = "解析条件はオブジェクトで指定してください。";
    return result("invalid", mode, message, { issues: [{ severity: "error", message }] });
  }
  const shapeIssue = circuitDocumentShapeIssue(inputDocument);
  if (shapeIssue) {
    return result("invalid", mode, shapeIssue, { issues: [{ severity: "error", message: shapeIssue }] });
  }
  const optionsIssue = analogOptionsShapeIssue(options);
  if (optionsIssue) {
    return result("invalid", mode, optionsIssue, { issues: [{ severity: "error", message: optionsIssue }] });
  }
  let validatedOptions: AnalogStepOptions;
  try {
    validatedOptions = {
      mode: simulationRecordField(options, "mode") as AnalogAnalysisMode,
      frequencyHz: simulationRecordField(options, "frequencyHz") as number | undefined,
      switchStates: simulationRecordField(options, "switchStates") as Record<string, boolean> | undefined,
      voltageOverrides: simulationRecordField(options, "voltageOverrides") as Record<string, number> | undefined,
      initialInductorCurrents: simulationRecordField(options, "initialInductorCurrents") as boolean | undefined,
    };
  } catch {
    const message = "解析条件を読み取れません。";
    return result("invalid", mode, message, { issues: [{ severity: "error", message }] });
  }
  const document = documentWithCatalogDefaults(inputDocument);
  if (validatedOptions.initialInductorCurrents !== undefined &&
      (typeof validatedOptions.initialInductorCurrents !== "boolean" ||
       (validatedOptions.initialInductorCurrents && validatedOptions.mode !== "dc"))) {
    const message = "コイルの初期電流を使う設定は直流の初期状態解析でのみ真偽値として指定してください。";
    return result("invalid", validatedOptions.mode, message, { issues: [{ severity: "error", message }] });
  }
  return validatedOptions.mode === "dc" ? dcResult(document, validatedOptions) : acResult(document, validatedOptions);
}

function analogOptionsShapeIssue(options: unknown) {
  try {
    if (!isSimulationRecord(options)) { return "解析条件はオブジェクトで指定してください。"; }
    const mode = simulationRecordField(options, "mode");
    const frequencyHz = simulationRecordField(options, "frequencyHz");
    const initialInductorCurrents = simulationRecordField(options, "initialInductorCurrents");
    if (mode !== "dc" && mode !== "ac") {
      return "解析方式は dc または ac で指定してください。";
    }
    if (frequencyHz !== undefined &&
        (typeof frequencyHz !== "number" || !Number.isFinite(frequencyHz) || frequencyHz <= 0)) {
      return "交流解析の周波数は有限な0より大きい数値にしてください。";
    }
    for (const [key, name] of [["switchStates", "スイッチ状態"], ["voltageOverrides", "電圧上書き"]] as const) {
      const field = simulationRecordField(options, key);
      const issue = field === undefined || isSimulationRecord(field)
        ? null
        : `${name}はオブジェクトで指定してください。`;
      if (issue) { return issue; }
    }
    if (initialInductorCurrents !== undefined && typeof initialInductorCurrents !== "boolean") {
      return "コイルの初期電流を使う設定は真偽値で指定してください。";
    }
  } catch {
    return "解析条件を読み取れません。";
  }
  return null;
}

/** Convenience entry point for DC operating-point and AC frequency-domain analysis. */
export function analyzeAnalogCircuit(
  document: CircuitDocument,
  options: AnalogStepOptions = { mode: "dc" },
) {
  return solveAnalogStep(document, options);
}

/** Converts a phasor into its magnitude and phase in degrees. */
export function polarFromComplex(value: ComplexValue) {
  return {
    magnitude: complexMagnitude(value),
    phaseDegrees: complexPhaseDegrees(value),
  };
}
