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
  complexSubtract,
  exactComponentSum,
  exactDotProductRational,
  exactProductSumQuotient,
  exactProductSumRatio,
  solveComplexLinearSystem,
  solveRealLinearSystem,
  type ComplexValue,
} from "./analog-math.js";
import {
  addExactRational,
  divideExactRational,
  exactRationalProductToNumber,
  exactRationalToNumber,
  multiplyExactRational,
  numberToExactRational,
  subtractExactRational,
  sumExactRationals,
  type ExactRational,
} from "./exact-linear-algebra.js";
import {
  addRealStateValue,
  addScaledRealState,
  clearRealStateRange,
  cloneRealState,
  complexFromExact,
  exactComplexValue,
  exactRealStateValue,
  realStateFromExact,
  setRealStateValue,
} from "./exact-numeric-state.js";
import { solveRealLinearSystemWithExactInverseCache } from "./exact-linear-cache.js";
import { acAnalysisFrequency, acReactiveAdmittance, acReactiveImpedance, acReactiveReactance, frequencyMatches } from "./ac-reactive.js";
import { meterStatuses, type MeterStatus } from "./meter-status.js";
import { circuitDocumentShapeIssue, isSimulationRecord, simulationRecordField } from "./simulation-input.js";

export type { ComplexValue } from "./analog-math.js";

export type AnalogAnalysisMode = "dc" | "ac";
export type AnalogAnalysisStatus = "empty" | "valid" | "invalid";
export type AnalogIssueSeverity = "error" | "warning" | "info";

/** Backward-Euler constraint retained with its original numerator and denominator. */
export interface TransientCompanionConstraint {
  kind: "capacitor" | "inductor";
  numerator: number;
  denominator: number;
  historyValue: number;
  exactHistoryValue?: ExactRational;
}

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
  /** MOS channel has current or a nonzero incremental response at its bias point. */
  channelConducting?: boolean;
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

/** Internal initial-time data for capacitor and ideal voltage-source branches. */
export interface InitialVoltageConstraint {
  capacitanceFarads?: number;
  voltageDerivative?: ExactRational;
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
const MAX_NEWTON_ITERATIONS = 100;
const NEWTON_CURRENT_TOLERANCE_AMPS = Number.MIN_VALUE;
const NEWTON_VOLTAGE_TOLERANCE_VOLTS = 1e-12;
const NEWTON_RELATIVE_TOLERANCE = 1e-10;
const PHYSICAL_CURRENT_TOLERANCE_AMPS = 1e-9;
const PHYSICAL_VOLTAGE_TOLERANCE_VOLTS = 1e-9;
const PHYSICAL_RELATIVE_TOLERANCE = 1e-10;
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
  exactSeriesResistance?: ExactRational;
  seriesReactanceOhms?: number;
  exactSeriesReactance?: ExactRational;
  sourceVoltage: ComplexValue;
  /** Exact backward-Euler companion coefficients for transient DC steps. */
  transientCompanion?: TransientCompanionConstraint;
  /** Componentwise allowance for rounding while deriving this source phasor. */
  sourceVoltageUncertainty?: ComplexValue;
  unknownIndex: number;
  /** Redundant compatible ideal voltage constraint; its current is fixed to zero. */
  redundantIdealSource?: boolean;
  initialCapacitanceFarads?: number;
  initialVoltageDerivative?: ExactRational;
  /** Differentiated KVL fixes capacitor currents in an initial voltage loop. */
  initialDerivativeEquation?: {
    terms: Array<{ unknownIndex: number; coefficient: ExactRational }>;
    rhs: ExactRational;
  };
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
  /** Preserve algebraic combinations after each device's approximation boundary. */
  exactCurrents?: readonly ExactRational[];
  exactJacobian?: readonly (readonly ExactRational[])[];
}

interface DcAssembly {
  matrix: Float64Array;
  residual: Float64Array;
  exactResidual: ExactRational[] | null;
}

/** Keep each KCL contribution until cancellation is complete, then round once. */
type ResidualTerms = (number | ExactRational)[][];
type ResidualTerm = number | ExactRational;

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
  exactSeriesReactance?: ExactRational;
  sourceVoltage: ComplexValue;
  transientCompanion?: TransientCompanionConstraint;
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

function transientCompanionForPart(
  part: CircuitPart,
  mode: AnalogAnalysisMode,
  transientCompanions?: ReadonlyMap<string, TransientCompanionConstraint>,
) {
  return part.kind === "battery" && mode === "dc"
    ? transientCompanions?.get(part.id)
    : undefined;
}

function branchSpecForPart(
  part: CircuitPart,
  topology: Topology,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  voltageOverrides: Record<string, number>,
  switchStates: Record<string, boolean>,
  initialInductorCurrents: boolean,
  transientCompanions?: ReadonlyMap<string, TransientCompanionConstraint>,
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
    const impedance = acReactiveImpedance(part, frequencyHz ?? 0);
    const reactance = impedance.imaginary;
    // An impedance beyond floating-point range is an open branch at this
    // analysis frequency. Its voltage still follows from the adjacent nodes.
    if (!Number.isFinite(reactance)) { return null; }
    return {
      part,
      positiveNode,
      negativeNode,
      seriesResistanceOhms: 0,
      seriesReactanceOhms: reactance,
      exactSeriesReactance: exactComplexValue(impedance)?.imaginary,
      sourceVoltage: complex(),
    };
  }
  if (part.kind === "battery") {
    const transientCompanion = transientCompanionForPart(part, mode, transientCompanions);
    return {
      part,
      positiveNode,
      negativeNode,
      seriesResistanceOhms: part.internalResistanceOhms ?? 0,
      sourceVoltage: complex(mode === "dc" ? sourceVoltageForDc(part, voltageOverrides) : 0),
      ...(transientCompanion ? { transientCompanion } : {}),
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
  const exact = exactComplexValue(admittance);
  return Number.isFinite(admittance.real) && Number.isFinite(admittance.imaginary) &&
    exact !== null && (exact.real.numerator !== 0n || exact.imaginary.numerator !== 0n)
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
  if (positiveNode === negativeNode && seriesResistanceOhms === 0 && seriesReactanceOhms === 0 &&
      (spec.exactSeriesReactance?.numerator ?? 0n) === 0n &&
      !spec.transientCompanion) {
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
    exactSeriesReactance: spec.exactSeriesReactance,
    sourceVoltage,
    ...(spec.transientCompanion ? { transientCompanion: spec.transientCompanion } : {}),
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
  branch: Branch;
  orientation: 1 | -1;
  /** V(current node) − V(neighbor node). */
  voltageDifference: ComplexValue;
  voltageUncertainty: ComplexValue;
}

interface IdealVoltageConstraintPath {
  voltageDifference: ComplexValue;
  voltageUncertainty: ComplexValue;
  partIds: string[];
  edges: IdealVoltageConstraintNeighbor[];
}

function isIdealVoltageConstraint(branch: Branch) {
  return !branch.transientCompanion &&
    (branch.exactSeriesResistance
      ? branch.exactSeriesResistance.numerator === 0n
      : branch.seriesResistanceOhms === 0) &&
    (branch.seriesReactanceOhms ?? 0) === 0 &&
    (branch.exactSeriesReactance?.numerator ?? 0n) === 0n;
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
  const edges: IdealVoltageConstraintNeighbor[] = [];
  for (let node = to; node !== from; node = parent[node] ?? -1) {
    const edge = parentEdge[node];
    if (!edge) { return undefined; }
    realTerms.push(edge.voltageDifference.real);
    imaginaryTerms.push(edge.voltageDifference.imaginary);
    realUncertaintyTerms.push(edge.voltageUncertainty.real);
    imaginaryUncertaintyTerms.push(edge.voltageUncertainty.imaginary);
    partIds.push(edge.partId);
    edges.push(edge);
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
    edges,
  };
}

function addIdealVoltageConstraint(
  adjacency: IdealVoltageConstraintNeighbor[][],
  branch: Branch,
) {
  adjacency[branch.positiveNode]?.push({
    node: branch.negativeNode,
    partId: branch.partId,
    branch,
    orientation: 1,
    voltageDifference: branch.sourceVoltage,
    voltageUncertainty: branch.sourceVoltageUncertainty ?? complex(),
  });
  adjacency[branch.negativeNode]?.push({
    node: branch.positiveNode,
    partId: branch.partId,
    branch,
    orientation: -1,
    voltageDifference: complexSubtract(complex(), branch.sourceVoltage),
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

function initialCapacitorLoopEquation(branch: Branch, path: IdealVoltageConstraintPath) {
  const terms: Array<{ unknownIndex: number; coefficient: ExactRational }> = [];
  const derivatives: ExactRational[] = [];
  const cycle = [
    { branch, orientation: 1 as const },
    ...path.edges.map((edge) => ({ branch: edge.branch, orientation: -edge.orientation })),
  ];
  for (const edge of cycle) {
    const capacitance = edge.branch.initialCapacitanceFarads;
    if (capacitance !== undefined) {
      const coefficient = exactProductSumRatio([{ factors: [edge.orientation] }], capacitance);
      if (!coefficient) { return; }
      terms.push({ unknownIndex: edge.branch.unknownIndex, coefficient });
    } else if (edge.branch.initialVoltageDerivative) {
      derivatives.push(edge.orientation === 1
        ? edge.branch.initialVoltageDerivative
        : negativeExact(edge.branch.initialVoltageDerivative));
    }
  }
  return { terms, rhs: negativeExact(sumExactRationals(derivatives)) };
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
  // Build the source-only forest first. Otherwise two source loops sharing
  // a capacitor can produce the same derivative equation and leave source
  // currents underdetermined instead of choosing their usual zero gauge.
  const orderedBranches = branches.toSorted((left, right) =>
    Number(left.initialCapacitanceFarads !== undefined) - Number(right.initialCapacitanceFarads !== undefined));
  for (const branch of orderedBranches) {
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

    if (branch.initialCapacitanceFarads !== undefined) {
      branch.initialDerivativeEquation = initialCapacitorLoopEquation(branch, path);
      continue;
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
  const specs: Array<{
    terminal: "a" | "b";
    resistance: number;
    exactResistance: ExactRational;
    positiveNode: number;
    negativeNode: number;
  }> = [
    { terminal: "a", resistance: segments.ac, exactResistance: segments.exactAc, positiveNode, negativeNode },
    {
      terminal: "b",
      resistance: segments.cb,
      exactResistance: segments.exactCb,
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
      exactSeriesResistance: spec.exactResistance,
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

function buildLayout(
  document: CircuitDocument,
  topology: Topology,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  voltageOverrides: Record<string, number>,
  switchStates: Record<string, boolean>,
  initialInductorCurrents = false,
  transientCompanions?: ReadonlyMap<string, TransientCompanionConstraint>,
  initialVoltageConstraints?: ReadonlyMap<string, InitialVoltageConstraint>,
): { layout?: MnaLayout; issue?: AnalogCircuitIssue } {
  const branches: Branch[] = [];
  const branchByPartId = new Map<string, Branch>();
  const unboundedReactiveAdmittances = new Map<string, ComplexValue>();
  const internalBranches: Branch[] = [];
  const internalBranchesByPartId = new Map<string, Branch[]>();
  for (const part of document.parts) {
    const spec = branchSpecForPart(
      part,
      topology,
      mode,
      frequencyHz,
      voltageOverrides,
      switchStates,
      initialInductorCurrents,
      transientCompanions,
    );
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

  for (const branch of branches) {
    const initialConstraint = initialVoltageConstraints?.get(branch.partId);
    branch.initialCapacitanceFarads = initialConstraint?.capacitanceFarads;
    branch.initialVoltageDerivative = initialConstraint?.voltageDerivative;
  }
  const idealVoltageCycleIssue = markRedundantIdealVoltageCycles(
    document, [...branches, ...internalBranches], topology.nodeCount,
  );
  if (idealVoltageCycleIssue) { return { issue: idealVoltageCycleIssue }; }

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
  // Divide in stages when forming n * Vt would round a subnormal value or zero.
  const subnormalScale = scale < 2 ** -1022;
  const rawExponent = subnormalScale ? (voltage / ideality) / THERMAL_VOLTAGE : voltage / scale;
  const exponential = Math.exp(Math.min(EXPONENT_MAX, rawExponent));
  const exponentialCurrent = saturationCurrent * exponential;
  const scaledSaturation = subnormalScale
    ? (saturationCurrent / ideality) / THERMAL_VOLTAGE
    : saturationCurrent / scale;
  const exponentialSlope = subnormalScale
    ? (exponentialCurrent / ideality) / THERMAL_VOLTAGE
    : exponentialCurrent / scale;
  // Prefer a normal intermediate; if both are subnormal, use the larger one
  // so division by a small thermal scale does not amplify avoidable rounding.
  let slope = Number.isFinite(exponentialCurrent) &&
    (exponentialCurrent >= 2 ** -1022 || !Number.isFinite(scaledSaturation) || exponentialCurrent >= scaledSaturation)
    ? exponentialSlope
    : scaledSaturation * exponential;
  if (rawExponent < 0 && (exponential < 2 ** -1022 || !Number.isFinite(slope))) {
    // Reverse bias has no conductance floor. Evaluate the combined exponent
    // when exp(V/nVt) underflows before multiplication by Is or division by nVt.
    slope = Math.exp(Math.log(saturationCurrent) - Math.log(ideality) - Math.log(THERMAL_VOLTAGE) + rawExponent);
  }
  if (rawExponent > EXPONENT_MAX) {
    return {
      // Scale the exponential before the continuation factor. The current at
      // the knee stays normal even for subnormal saturation, unlike the slope.
      current: Number.isFinite(rawExponent)
        ? exponentialCurrent * (1 + rawExponent - EXPONENT_MAX) - saturationCurrent
        : slope * (voltage - scale * (EXPONENT_MAX - 1)) - saturationCurrent,
      slope,
    };
  }
  return {
    // In the subnormal exponent range expm1(x) = x to binary64 accuracy, but
    // rounding V / (n * Vt) first can erase a representable Is * x current.
    current: voltage === 0 ? 0 : Math.abs(rawExponent) < 2 ** -1022
      ? slope * voltage
      : saturationCurrent * Math.expm1(rawExponent),
    slope,
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
  const saturation = part.saturationCurrentAmps ?? 1e-14;
  const vbe = sign * (base - emitter);
  const vbc = sign * (base - collector);
  // Express Ebers–Moll in transport and base currents. Computing 1 - alpha
  // loses the base current when beta / (beta + 1) rounds to one, and scaling
  // saturation by 1 / alpha can overflow before a zero bias is evaluated.
  const forward = diodeCurrentAndSlope(vbe, saturation, 1);
  const reverse = diodeCurrentAndSlope(vbc, saturation, 1);
  const baseSaturation = saturation / beta;
  // For beta < 1, scale saturation up before the transport current can
  // underflow. For beta >= 1, divide last to avoid rounding saturation down.
  const scaledForwardBase = beta < 1 && Number.isFinite(baseSaturation)
    ? diodeCurrentAndSlope(vbe, baseSaturation, 1)
    : undefined;
  const exactBeta = numberToExactRational(beta);
  const exactForward = numberToExactRational(forward.current);
  const exactReverse = numberToExactRational(reverse.current);
  const exactForwardSlope = numberToExactRational(forward.slope);
  const exactReverseSlope = numberToExactRational(reverse.slope);
  if (
    !exactBeta || exactBeta.numerator === 0n || !exactForward || !exactReverse ||
    !exactForwardSlope || !exactReverseSlope
  ) {
    return {
      currents: [Number.NaN, Number.NaN, Number.NaN],
      jacobian: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => Number.NaN)),
    };
  }

  const exactForwardBase = scaledForwardBase
    ? numberToExactRational(scaledForwardBase.current)
    : divideExactRational(exactForward, exactBeta);
  const exactForwardBaseSlope = scaledForwardBase
    ? numberToExactRational(scaledForwardBase.slope)
    : divideExactRational(exactForwardSlope, exactBeta);
  if (!exactForwardBase || !exactForwardBaseSlope) {
    return {
      currents: [Number.NaN, Number.NaN, Number.NaN],
      jacobian: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => Number.NaN)),
    };
  }

  const exactSum = (terms: Parameters<typeof exactProductSumRatio>[0]) =>
    exactProductSumRatio(terms, 1);
  const exactCurrents = [
    exactSum([
      { factors: [sign, exactForward] },
      { factors: [sign, 2, exactReverse], sign: -1 },
    ]),
    exactSum([
      { factors: [sign, exactForwardBase] },
      { factors: [sign, exactReverse] },
    ]),
    exactSum([
      { factors: [sign, exactForward], sign: -1 },
      { factors: [sign, exactForwardBase], sign: -1 },
      { factors: [sign, exactReverse] },
    ]),
  ];
  const exactJacobianEntries = [
    exactSum([{ factors: [2, exactReverseSlope] }]),
    exactSum([
      { factors: [exactForwardSlope] },
      { factors: [2, exactReverseSlope], sign: -1 },
    ]),
    exactSum([{ factors: [exactForwardSlope], sign: -1 }]),
    exactSum([{ factors: [exactReverseSlope], sign: -1 }]),
    exactSum([
      { factors: [exactForwardBaseSlope] },
      { factors: [exactReverseSlope] },
    ]),
    exactSum([{ factors: [exactForwardBaseSlope], sign: -1 }]),
    exactSum([{ factors: [exactReverseSlope], sign: -1 }]),
    exactSum([
      { factors: [exactForwardSlope], sign: -1 },
      { factors: [exactForwardBaseSlope], sign: -1 },
      { factors: [exactReverseSlope] },
    ]),
    exactSum([
      { factors: [exactForwardSlope] },
      { factors: [exactForwardBaseSlope] },
    ]),
  ];
  const exactValues = (values: readonly (ExactRational | null)[]) => {
    const resolved: ExactRational[] = [];
    for (const value of values) {
      if (!value) { return null; }
      resolved.push(value);
    }
    return resolved;
  };
  const resolvedCurrents = exactValues(exactCurrents);
  const resolvedJacobian = exactValues(exactJacobianEntries);
  if (!resolvedCurrents || !resolvedJacobian) {
    return {
      currents: [Number.NaN, Number.NaN, Number.NaN],
      jacobian: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => Number.NaN)),
    };
  }

  const jacobianExact = [
    resolvedJacobian.slice(0, 3),
    resolvedJacobian.slice(3, 6),
    resolvedJacobian.slice(6, 9),
  ];
  return {
    currents: resolvedCurrents.map(exactRationalToNumber),
    jacobian: jacobianExact.map((row) => row.map(exactRationalToNumber)),
    exactCurrents: resolvedCurrents,
    exactJacobian: jacobianExact,
  };
}

function mosChannel(vgs: number, vds: number, threshold: number, beta: number, lambda: number) {
  const overdrive = vgs - threshold;
  if (overdrive <= 0) { return { current: 0, gm: 0, gds: 0 }; }
  // Expand the square-law and channel modulation before evaluating products.
  // The unscaled square or modulation can overflow (or the base current can
  // underflow) even when the final current and its derivatives are finite.
  if (vds < overdrive) {
    return {
      current: exactProductSumQuotient([
        { factors: [beta, overdrive, vds] },
        { factors: [0.5, beta, vds, vds], sign: -1 },
        { factors: [lambda, beta, overdrive, vds, vds] },
        { factors: [0.5, lambda, beta, vds, vds, vds], sign: -1 },
      ], 1),
      gm: exactProductSumQuotient([
        { factors: [beta, vds] },
        { factors: [lambda, beta, vds, vds] },
      ], 1),
      gds: exactProductSumQuotient([
        { factors: [beta, overdrive] },
        { factors: [beta, vds], sign: -1 },
        { factors: [2, lambda, beta, overdrive, vds] },
        { factors: [1.5, lambda, beta, vds, vds], sign: -1 },
      ], 1),
    };
  }
  return {
    current: exactProductSumQuotient([
      { factors: [0.5, beta, overdrive, overdrive] },
      { factors: [0.5, lambda, beta, overdrive, overdrive, vds] },
    ], 1),
    gm: exactProductSumQuotient([
      { factors: [beta, overdrive] },
      { factors: [lambda, beta, overdrive, vds] },
    ], 1),
    gds: exactProductSumQuotient([
      { factors: [0.5, lambda, beta, overdrive, overdrive] },
    ], 1),
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

  const drainCurrent = normalizedCurrent === 0 ? 0 : sign * normalizedCurrent;
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

function isNonlinearPart(part: CircuitPart) {
  return part.kind === "diode" || part.kind === "led" || part.kind === "npn-transistor" ||
    part.kind === "pnp-transistor" || part.kind === "nmos" || part.kind === "pmos" ||
    part.kind === "op-amp";
}

function hasNonlinearParts(document: CircuitDocument) {
  return document.parts.some(isNonlinearPart);
}

function mosChannelConductingByPartId(
  document: CircuitDocument,
  biasLayout: MnaLayout,
  dcState: Float64Array,
) {
  const states: Record<string, boolean> = Object.create(null);
  for (const part of document.parts) {
    if (part.kind !== "nmos" && part.kind !== "pmos") { continue; }
    const model = nonlinearModel(part, nonlinearTerminalVoltages(part, biasLayout, dcState));
    const channelConducting = Boolean(model && (
      model.currents.some((current) => current !== 0) ||
      model.jacobian.some((row) => row.some((derivative) => derivative !== 0))
    ));
    setRecordValue(states, part.id, channelConducting);
  }
  return states;
}

function nodeRealValue(layout: MnaLayout, node: number, state: Float64Array) {
  const unknown = layout.topology.nodeUnknowns[node] ?? -1;
  return unknown < 0 ? 0 : (state[unknown] ?? 0);
}

function addMatrix(matrix: Float64Array, size: number, row: number, column: number, value: number | ExactRational) {
  if (row < 0 || column < 0 || row >= size || column >= size) { return; }
  const index = row * size + column;
  addRealStateValue(matrix, index, value);
}

function addExactMatrixValue(
  matrix: Float64Array,
  size: number,
  row: number,
  column: number,
  value: ExactRational,
) {
  if (row < 0 || column < 0 || row >= size || column >= size) { return; }
  addRealStateValue(matrix, row * size + column, value);
}

function exactNumberSum(values: readonly number[]) {
  let sum = numberToExactRational(0);
  if (!sum) { return null; }
  for (const value of values) {
    const exactValue = numberToExactRational(value);
    if (!exactValue) { return null; }
    sum = addExactRational(sum, exactValue);
  }
  return sum;
}

function negativeExact(value: ExactRational): ExactRational {
  const zero = numberToExactRational(0);
  return zero ? subtractExactRational(zero, value) : value;
}

function addResidual(residual: ResidualTerms, row: number, value: ResidualTerm) {
  if (row < 0 || row >= residual.length) { return; }
  if (typeof value === "number" ? value !== 0 : value.numerator !== 0n) {
    residual[row]?.push(value);
  }
}

function exactResidualSum(terms: readonly ResidualTerm[]) {
  const exactTerms: ExactRational[] = [];
  for (const term of terms) {
    const exactTerm = typeof term === "number" ? numberToExactRational(term) : term;
    if (!exactTerm) { return null; }
    exactTerms.push(exactTerm);
  }
  return sumExactRationals(exactTerms);
}

function negatedExactResidual(values: readonly ExactRational[]) {
  return values.map(negativeExact);
}

function exactStateValue(state: Float64Array, index: number): number | ExactRational {
  if (index < 0) { return numberToExactRational(0) ?? 0; }
  return exactRealStateValue(state, index) ?? state[index] ?? 0;
}

function negatedResidualTerm(value: number | ExactRational): number | ExactRational {
  return typeof value === "number" ? -value : negativeExact(value);
}

function exactRhsFromResidualTerms(residual: ResidualTerms) {
  const exactValues = residual.map(exactResidualSum);
  return exactValues.every((value): value is ExactRational => value !== null)
    ? negatedExactResidual(exactValues)
    : null;
}

function exactRealStateDifference(left: Float64Array, right: Float64Array) {
  if (left.length !== right.length) { return null; }
  const difference: ExactRational[] = [];
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = exactRealStateValue(left, index);
    const rightValue = exactRealStateValue(right, index);
    if (!leftValue || !rightValue) { return null; }
    difference.push(subtractExactRational(leftValue, rightValue));
  }
  return realStateFromExact(difference);
}

function stampConductance(
  matrix: Float64Array,
  residual: ResidualTerms,
  layout: MnaLayout,
  state: Float64Array,
  positiveNode: number,
  negativeNode: number,
  conductance: number,
) {
  const positiveUnknown = layout.topology.nodeUnknowns[positiveNode] ?? -1;
  const negativeUnknown = layout.topology.nodeUnknowns[negativeNode] ?? -1;
  const positiveVoltage = exactStateValue(state, positiveUnknown);
  const negativeVoltage = exactStateValue(state, negativeUnknown);
  const current = exactDotProductRational(
    [conductance, -conductance],
    [positiveVoltage, negativeVoltage],
  );
  const fallbackCurrent = conductance * (
    nodeRealValue(layout, positiveNode, state) - nodeRealValue(layout, negativeNode, state)
  );
  const currentTerm = current ?? fallbackCurrent;
  addResidual(residual, positiveUnknown, currentTerm);
  addResidual(residual, negativeUnknown, negatedResidualTerm(currentTerm));
  addMatrix(matrix, layout.size, positiveUnknown, positiveUnknown, conductance);
  addMatrix(matrix, layout.size, positiveUnknown, negativeUnknown, -conductance);
  addMatrix(matrix, layout.size, negativeUnknown, positiveUnknown, -conductance);
  addMatrix(matrix, layout.size, negativeUnknown, negativeUnknown, conductance);
}

function stampCurrentSource(
  residual: ResidualTerms,
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
  residual: ResidualTerms,
  layout: MnaLayout,
  state: Float64Array,
  branch: Branch,
) {
  if (branch.redundantIdealSource) {
    addResidual(residual, branch.unknownIndex, exactStateValue(state, branch.unknownIndex));
    addMatrix(matrix, layout.size, branch.unknownIndex, branch.unknownIndex, 1);
    return;
  }
  const positiveUnknown = layout.topology.nodeUnknowns[branch.positiveNode] ?? -1;
  const negativeUnknown = layout.topology.nodeUnknowns[branch.negativeNode] ?? -1;
  const branchCurrent = state[branch.unknownIndex] ?? 0;
  const positiveVoltage = nodeRealValue(layout, branch.positiveNode, state);
  const negativeVoltage = nodeRealValue(layout, branch.negativeNode, state);
  const exactBranchCurrent = exactStateValue(state, branch.unknownIndex);
  addResidual(residual, positiveUnknown, exactBranchCurrent);
  addResidual(residual, negativeUnknown, negatedResidualTerm(exactBranchCurrent));
  addMatrix(matrix, layout.size, positiveUnknown, branch.unknownIndex, 1);
  addMatrix(matrix, layout.size, negativeUnknown, branch.unknownIndex, -1);
  if (branch.initialDerivativeEquation) {
    const equation = branch.initialDerivativeEquation;
    addResidual(residual, branch.unknownIndex, negativeExact(equation.rhs));
    for (const term of equation.terms) {
      addExactMatrixValue(matrix, layout.size, branch.unknownIndex, term.unknownIndex, term.coefficient);
      const value = exactProductSumRatio([{
        factors: [term.coefficient, exactStateValue(state, term.unknownIndex)],
      }], 1);
      addResidual(residual, branch.unknownIndex, value ?? Number.NaN);
    }
    return;
  }
  if (branch.transientCompanion) {
    const companion = branch.transientCompanion;
    const coefficients = companion.kind === "capacitor"
      ? [companion.denominator, -companion.denominator, -companion.numerator, -companion.denominator]
      : [companion.denominator, -companion.denominator, -companion.numerator, companion.numerator];
    const values = [
      exactStateValue(state, positiveUnknown),
      exactStateValue(state, negativeUnknown),
      exactBranchCurrent,
      companion.exactHistoryValue ?? companion.historyValue,
    ];
    const exactResidual = exactDotProductRational(coefficients, values);
    if (exactResidual) { addResidual(residual, branch.unknownIndex, exactResidual); }
    addMatrix(matrix, layout.size, branch.unknownIndex, positiveUnknown, companion.denominator);
    addMatrix(matrix, layout.size, branch.unknownIndex, negativeUnknown, -companion.denominator);
    addMatrix(matrix, layout.size, branch.unknownIndex, branch.unknownIndex, -companion.numerator);
    return;
  }
  const exactSourceVoltage = exactComplexValue(branch.sourceVoltage)?.real ?? branch.sourceVoltage.real;
  const resistanceCoefficient = branch.exactSeriesResistance
    ? negativeExact(branch.exactSeriesResistance)
    : -branch.seriesResistanceOhms;
  const branchEquation = exactProductSumRatio([
    { factors: [exactStateValue(state, positiveUnknown)] },
    { factors: [exactStateValue(state, negativeUnknown)], sign: -1 },
    { factors: [resistanceCoefficient, exactBranchCurrent] },
    { factors: [exactSourceVoltage], sign: -1 },
  ], 1);
  addResidual(residual, branch.unknownIndex, branchEquation ?? (
    positiveVoltage - negativeVoltage - branch.seriesResistanceOhms * branchCurrent - branch.sourceVoltage.real
  ));
  addMatrix(matrix, layout.size, branch.unknownIndex, positiveUnknown, 1);
  addMatrix(matrix, layout.size, branch.unknownIndex, negativeUnknown, -1);
  if (branch.exactSeriesResistance) {
    addExactMatrixValue(
      matrix,
      layout.size,
      branch.unknownIndex,
      branch.unknownIndex,
      negativeExact(branch.exactSeriesResistance),
    );
  } else {
    addMatrix(
      matrix,
      layout.size,
      branch.unknownIndex,
      branch.unknownIndex,
      -branch.seriesResistanceOhms,
    );
  }
}

function nonlinearModelCurrent(model: NonlinearModel, row: number): ResidualTerm {
  return model.exactCurrents?.[row] ?? model.currents[row] ?? 0;
}

function nonlinearModelCoefficients(model: NonlinearModel, row: number): readonly ResidualTerm[] {
  return model.exactJacobian?.[row] ?? model.jacobian[row] ?? [];
}

function stampNonlinear(
  matrix: Float64Array,
  residual: ResidualTerms,
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
    addResidual(residual, rowUnknown, nonlinearModelCurrent(model, row));
    const coefficients = nonlinearModelCoefficients(model, row);
    for (let column = 0; column < terminals.length - 1; column += 1) {
      const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
      addMatrix(
        matrix,
        layout.size,
        rowUnknown,
        columnUnknown,
        coefficients[column] ?? 0,
      );
    }
    // The model's terminal voltages are expressed relative to its final
    // terminal. Make that gauge relation exact in the stamped MNA row.
    const referenceCoefficient = exactResidualSum(coefficients.slice(0, terminals.length - 1));
    const referenceUnknown = layout.topology.nodeUnknowns[nodes.at(-1) ?? -1] ?? -1;
    if (referenceCoefficient) {
      addExactMatrixValue(matrix, layout.size, rowUnknown, referenceUnknown, negativeExact(referenceCoefficient));
    }
  }
}

function nonlinearTerminalVoltages(
  part: CircuitPart,
  layout: MnaLayout,
  state: Float64Array,
) {
  const values = terminalsOf(part.kind).map((terminal) => {
    const node = nodeForTerminal(layout.topology, part, terminal);
    const unknown = layout.topology.nodeUnknowns[node] ?? -1;
    return unknown < 0 ? complex() : complexFromRealState(state, unknown);
  });
  if (part.kind !== "op-amp") {
    const reference = values.at(-1) ?? complex();
    return values.map((value) => voltageDifference(value, reference).real);
  }
  const referenceUnknown = layout.topology.nodeUnknowns[layout.physicalReferenceNode] ?? -1;
  const reference = referenceUnknown < 0 ? complex() : complexFromRealState(state, referenceUnknown);
  return [
    voltageDifference(values[0] ?? complex(), values[1] ?? complex()).real,
    0,
    voltageDifference(values[2] ?? complex(), reference).real,
  ];
}

function stampDcOpAmp(
  matrix: Float64Array,
  residual: ResidualTerms,
  layout: MnaLayout,
  part: CircuitPart,
  model: NonlinearModel,
) {
  const nodes = terminalsOf(part.kind).map((terminal) => nodeForTerminal(layout.topology, part, terminal));
  const outputNode = nodes[2] ?? layout.topology.referenceNode;
  const outputUnknown = layout.topology.nodeUnknowns[outputNode] ?? -1;
  const referenceUnknown = layout.topology.nodeUnknowns[layout.physicalReferenceNode] ?? -1;
  const outputCurrent = model.currents[2] ?? 0;
  const outputCoefficients = model.jacobian[2] ?? [];
  const referenceSlopeSum = exactNumberSum(outputCoefficients);
  const referenceSlope = referenceSlopeSum ? negativeExact(referenceSlopeSum) : null;

  addResidual(residual, outputUnknown, outputCurrent);
  for (let column = 0; column < nodes.length; column += 1) {
    const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
    addMatrix(matrix, layout.size, outputUnknown, columnUnknown, model.jacobian[2]?.[column] ?? 0);
  }
  if (referenceSlope) {
    addExactMatrixValue(matrix, layout.size, outputUnknown, referenceUnknown, referenceSlope);
  }

  // The op-amp output stage returns its current to the physical reference node.
  addResidual(residual, referenceUnknown, -outputCurrent);
  for (let column = 0; column < nodes.length; column += 1) {
    const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
    addMatrix(matrix, layout.size, referenceUnknown, columnUnknown, -(model.jacobian[2]?.[column] ?? 0));
  }
  if (referenceSlope) {
    addExactMatrixValue(matrix, layout.size, referenceUnknown, referenceUnknown, negativeExact(referenceSlope));
  }
}

function resistorValue(part: CircuitPart) {
  return part.resistanceOhms ?? 1;
}

function potentiometerSegments(part: CircuitPart) {
  const total = part.resistanceOhms ?? 1000;
  const position = part.wiperPosition ?? 0.5;
  const smallerPosition = Math.min(position, 1 - position);
  const exactTotal = numberToExactRational(total);
  const exactSmallerPosition = numberToExactRational(smallerPosition);
  if (!exactTotal || !exactSmallerPosition) {
    throw new Error("可変抵抗の値を正確な有理数へ変換できません。");
  }
  const exactSmallerResistance = multiplyExactRational(exactTotal, exactSmallerPosition);
  const exactLargerResistance = subtractExactRational(exactTotal, exactSmallerResistance);
  const smallerResistance = exactRationalToNumber(exactSmallerResistance);
  const largerResistance = exactRationalToNumber(exactLargerResistance);
  return position <= 0.5
    ? {
      ac: smallerResistance,
      cb: largerResistance,
      exactAc: exactSmallerResistance,
      exactCb: exactLargerResistance,
    }
    : {
      ac: largerResistance,
      cb: smallerResistance,
      exactAc: exactLargerResistance,
      exactCb: exactSmallerResistance,
    };
}

function isSwitchClosed(part: CircuitPart, switchStates: Record<string, boolean>) {
  return (Object.hasOwn(switchStates, part.id) ? switchStates[part.id] : undefined) ?? part.initiallyClosed ?? false;
}

function stampDcPassivePart(
  residual: ResidualTerms,
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
  residual: ResidualTerms,
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

function logPositiveExactRational(value: ExactRational) {
  if (value.numerator <= 0n || value.denominator <= 0n) { return Number.NaN; }
  const logPositiveInteger = (integer: bigint) => {
    const shift = Math.max(0, integer.toString(2).length - 53);
    const leadingBits = Number.parseInt(integer.toString(2).slice(0, 53), 2);
    return Math.log(leadingBits) + shift * Math.LN2;
  };
  return logPositiveInteger(value.numerator) - logPositiveInteger(value.denominator);
}

function appendImpedanceReferenceEdge(edges: ReferenceConductanceEdge[], branch: Branch) {
  const scale = Math.max(Math.abs(branch.seriesResistanceOhms), Math.abs(branch.seriesReactanceOhms ?? 0));
  if (scale === 0) {
    const exactResistance = branch.exactSeriesResistance;
    const exactReactanceIsZero = (branch.exactSeriesReactance?.numerator ?? 0n) === 0n;
    if (exactResistance && exactResistance.numerator > 0n && exactReactanceIsZero) {
      const logConductance = -logPositiveExactRational(exactResistance);
      if (Number.isFinite(logConductance)) {
        edges.push({ a: branch.positiveNode, b: branch.negativeNode, logConductance });
        return;
      }
    }
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

function unbalancedCurrentSourceRoots(
  document: CircuitDocument,
  topology: Topology,
  parent: number[],
  includeInitialInductors: boolean,
) {
  const currentTermsByRoot = new Map<number, number[]>();
  const addCurrent = (part: CircuitPart, current: number) => {
    const positiveRoot = findRoot(parent, nodeForTerminal(topology, part, "a"));
    const negativeRoot = findRoot(parent, nodeForTerminal(topology, part, "b"));
    if (positiveRoot === negativeRoot) { return; }
    const positiveTerms = currentTermsByRoot.get(positiveRoot) ?? [];
    positiveTerms.push(current);
    currentTermsByRoot.set(positiveRoot, positiveTerms);
    const negativeTerms = currentTermsByRoot.get(negativeRoot) ?? [];
    negativeTerms.push(-current);
    currentTermsByRoot.set(negativeRoot, negativeTerms);
  };
  for (const part of document.parts) {
    if (part.kind === "current-source") {
      addCurrent(part, part.currentAmps ?? 0);
    } else if (includeInitialInductors && part.kind === "inductor") {
      addCurrent(part, part.initialCurrentAmps ?? 0);
    }
  }
  return new Set(
    [...currentTermsByRoot]
      .filter(([, terms]) => exactComponentSum(terms) !== 0)
      .map(([root]) => root),
  );
}

function referenceConnectivityParents(
  document: CircuitDocument,
  layout: MnaLayout,
  mode: AnalogAnalysisMode,
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  const parent = Array.from({ length: layout.topology.nodeCount }, (_, node) => node);
  const switchStates = Object.fromEntries(document.parts
    .filter((part) => part.kind === "switch")
    .map((part) => [part.id, layout.branchByPartId.has(part.id)]));
  for (const part of document.parts) {
    const reactiveBranchIsModeled = layout.branchByPartId.has(part.id) ||
      layout.unboundedReactiveAdmittances.has(part.id);
    if (mode === "ac" && part.kind === "inductor" && !reactiveBranchIsModeled) { continue; }
    if ((part.kind === "nmos" || part.kind === "pmos") && channelConducting?.[part.id] === false) {
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
  return parent;
}

function referenceConstraints(
  document: CircuitDocument,
  layout: MnaLayout,
  mode: AnalogAnalysisMode,
  channelConducting?: Readonly<Record<string, boolean>>,
): ReferenceConstraint[] {
  // Each disconnected conductive network has an arbitrary common-mode voltage.
  const parent = referenceConnectivityParents(document, layout, mode, channelConducting);

  const referenceRoot = findRoot(parent, layout.topology.referenceNode);
  const unbalancedCurrentRoots = mode === "dc"
    ? unbalancedCurrentSourceRoots(
      document,
      layout.topology,
      parent,
      layout.initialInductorCurrents,
    )
    : new Set<number>();
  const strengths = referenceNodeStrengths(document, layout);
  const anchorByRoot = new Map<number, { node: number; strength: number }>();
  for (let node = 0; node < layout.topology.nodeCount; node += 1) {
    const root = findRoot(parent, node);
    if (unbalancedCurrentRoots.has(root)) { continue; }
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
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  const parent = referenceConnectivityParents(document, layout, mode, channelConducting);
  return Array.from({ length: layout.topology.nodeCount }, (_, node) => findRoot(parent, node));
}

function referenceComponentNodes(
  document: CircuitDocument,
  layout: MnaLayout,
  seedNode: number,
  mode: AnalogAnalysisMode,
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  const componentIds = referenceComponentIds(document, layout, mode, channelConducting);
  const seedRoot = componentIds[seedNode];
  return componentIds.map((root) => root === seedRoot);
}

function preferredReferenceNodes(
  document: CircuitDocument,
  layout: MnaLayout,
  mode: AnalogAnalysisMode,
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  const component = referenceComponentNodes(
    document,
    layout,
    layout.topology.referenceNode,
    mode,
    channelConducting,
  );
  const strengths = referenceNodeStrengths(document, layout);
  return Array.from({ length: layout.topology.nodeCount }, (_, node) => node)
    .filter((node) => component[node] && node !== layout.topology.referenceNode)
    .sort((left, right) =>
      (strengths[right] ?? 0) - (strengths[left] ?? 0) || left - right,
    );
}

function canAdjustDcReference(
  document: CircuitDocument,
  layout: MnaLayout,
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  if (!layout.initialInductorCurrents) { return true; }
  const referenceComponent = referenceComponentNodes(
    document,
    layout,
    layout.physicalReferenceNode,
    "dc",
    channelConducting,
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
  residual: ResidualTerms,
  channelConductingOverride?: Readonly<Record<string, boolean>>,
) {
  const channelConducting = channelConductingOverride ??
    mosChannelConductingByPartId(document, layout, state);
  for (const { node, derivatives } of referenceConstraints(document, layout, "dc", channelConducting)) {
    const unknown = layout.topology.nodeUnknowns[node] ?? -1;
    if (unknown < 0) { continue; }
    // Replace a redundant KCL row with an exact reference. Adding a tiny
    // conductance here loses that reference next to low-resistance branches.
    clearRealStateRange(matrix, unknown * layout.size, (unknown + 1) * layout.size);
    residual[unknown] = [];
    if (derivatives.length === 0) {
      setRealStateValue(matrix, unknown * layout.size + unknown, 1);
      addResidual(residual, unknown, exactStateValue(state, unknown));
      continue;
    }
    // Across an inductor cutset, the prescribed currents already satisfy KCL.
    // Its time derivative fixes the otherwise arbitrary relative potential:
    // sum of outward V_L / L = 0, since independent current sources are constant.
    for (const branch of derivatives) {
      const conductance = exactProductSumRatio([{ factors: [1] }], branch.inductance);
      if (!conductance) { continue; }
      const inside = layout.topology.nodeUnknowns[branch.inside] ?? -1;
      const outside = layout.topology.nodeUnknowns[branch.outside] ?? -1;
      addExactMatrixValue(matrix, layout.size, unknown, inside, conductance);
      addExactMatrixValue(matrix, layout.size, unknown, outside, negativeExact(conductance));
      const derivativeResidual = exactProductSumRatio([
        { factors: [conductance, exactStateValue(state, inside)] },
        { factors: [conductance, exactStateValue(state, outside)], sign: -1 },
      ], 1);
      addResidual(residual, unknown, derivativeResidual ?? Number.NaN);
    }
  }
}

function assembleDc(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  includeReferences = true,
  channelConductingForReferences?: Readonly<Record<string, boolean>>,
): DcAssembly {
  const matrix = new Float64Array(layout.size * layout.size);
  const residual: ResidualTerms = Array.from({ length: layout.size }, () => []);

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
    stampDcReferences(document, layout, state, matrix, residual, channelConductingForReferences);
  }
  const exactResidualTerms = residual.map(exactResidualSum);
  const exactResidual = exactResidualTerms.every((value): value is ExactRational => value !== null)
    ? exactResidualTerms
    : null;
  return {
    matrix,
    residual: Float64Array.from(exactResidualTerms, (value) => value ? exactRationalToNumber(value) : Number.NaN),
    exactResidual,
  };
}

function addCurrentSourceAbsoluteRhs(
  rhs: ResidualTerms,
  layout: MnaLayout,
  positiveNode: number,
  negativeNode: number,
  current: number,
) {
  addResidual(rhs, layout.topology.nodeUnknowns[positiveNode] ?? -1, -current);
  addResidual(rhs, layout.topology.nodeUnknowns[negativeNode] ?? -1, current);
}

function addBranchAbsoluteRhs(rhs: ResidualTerms, branch: Branch) {
  if (branch.redundantIdealSource) { return true; }
  if (branch.initialDerivativeEquation) {
    addResidual(rhs, branch.unknownIndex, branch.initialDerivativeEquation.rhs);
    return true;
  }
  if (branch.transientCompanion) {
    const companion = branch.transientCompanion;
    const history = companion.exactHistoryValue ?? companion.historyValue;
    const coefficient = companion.kind === "capacitor" ? companion.denominator : companion.numerator;
    const source = exactProductSumRatio([{
      factors: [coefficient, history],
      sign: companion.kind === "capacitor" ? 1 : -1,
    }], 1);
    if (!source) { return false; }
    addResidual(rhs, branch.unknownIndex, source);
    return true;
  }
  const source = exactComplexValue(branch.sourceVoltage)?.real ??
    numberToExactRational(branch.sourceVoltage.real);
  if (!source) { return false; }
  addResidual(rhs, branch.unknownIndex, source);
  return true;
}

function nonlinearAbsoluteRhs(
  rhs: ResidualTerms,
  layout: MnaLayout,
  part: CircuitPart,
  center: readonly number[],
  model: NonlinearModel,
) {
  if (part.kind === "op-amp") {
    const row = 2;
    const coefficients = model.jacobian[row] ?? [];
    const linearizedCurrent = exactDotProductRational(coefficients, center);
    const current = numberToExactRational(model.currents[row] ?? 0);
    if (!linearizedCurrent || !current) { return false; }
    const offset = subtractExactRational(linearizedCurrent, current);
    const outputNode = nodeForTerminal(layout.topology, part, "c");
    const outputUnknown = layout.topology.nodeUnknowns[outputNode] ?? -1;
    const referenceUnknown = layout.topology.nodeUnknowns[layout.physicalReferenceNode] ?? -1;
    addResidual(rhs, outputUnknown, offset);
    addResidual(rhs, referenceUnknown, negativeExact(offset));
    return true;
  }

  const terminals = terminalsOf(part.kind);
  for (let row = 0; row < terminals.length; row += 1) {
    const coefficients = nonlinearModelCoefficients(model, row);
    const linearizedCurrent = exactDotProductRational(
      center.slice(0, terminals.length - 1),
      coefficients.slice(0, terminals.length - 1),
    );
    const current = model.exactCurrents?.[row] ?? numberToExactRational(model.currents[row] ?? 0);
    if (!linearizedCurrent || !current) { return false; }
    const offset = subtractExactRational(linearizedCurrent, current);
    const node = nodeForTerminal(layout.topology, part, terminals[row] ?? terminals.at(-1)!);
    addResidual(rhs, layout.topology.nodeUnknowns[node] ?? -1, offset);
  }
  return true;
}

function addPartAbsoluteRhs(
  rhs: ResidualTerms,
  layout: MnaLayout,
  state: Float64Array,
  part: CircuitPart,
) {
  const branch = layout.branchByPartId.get(part.id);
  if (branch && !addBranchAbsoluteRhs(rhs, branch)) { return false; }
  const positiveNode = nodeForTerminal(layout.topology, part, "a");
  const negativeNode = nodeForTerminal(layout.topology, part, "b");
  if (part.kind === "current-source") {
    addCurrentSourceAbsoluteRhs(rhs, layout, positiveNode, negativeNode, part.currentAmps ?? 0);
  } else if (part.kind === "inductor" && layout.initialInductorCurrents) {
    addCurrentSourceAbsoluteRhs(rhs, layout, positiveNode, negativeNode, part.initialCurrentAmps ?? 0);
  }
  if (!isNonlinearPart(part)) { return true; }
  const center = nonlinearTerminalVoltages(part, layout, state);
  const model = nonlinearModel(part, center);
  return !model || nonlinearAbsoluteRhs(rhs, layout, part, center, model);
}

function clearReferenceAbsoluteRhs(
  rhs: ResidualTerms,
  document: CircuitDocument,
  layout: MnaLayout,
  channelConductingForReferences: Readonly<Record<string, boolean>>,
) {
  for (const { node } of referenceConstraints(document, layout, "dc", channelConductingForReferences)) {
    const unknown = layout.topology.nodeUnknowns[node] ?? -1;
    if (unknown >= 0) { rhs[unknown] = []; }
  }
}

function absoluteDcRhs(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  channelConductingForReferences: Readonly<Record<string, boolean>>,
) {
  const rhs: ResidualTerms = Array.from({ length: layout.size }, () => []);
  for (const part of document.parts) {
    if (!addPartAbsoluteRhs(rhs, layout, state, part)) { return null; }
  }
  for (const branch of layout.internalBranches) {
    if (!addBranchAbsoluteRhs(rhs, branch)) { return null; }
  }
  clearReferenceAbsoluteRhs(rhs, document, layout, channelConductingForReferences);
  const exactRhs = rhs.map(exactResidualSum);
  return exactRhs.every((value): value is ExactRational => value !== null) ? exactRhs : null;
}

function absoluteExactRational(value: ExactRational): ExactRational {
  return value.numerator < 0n ? negativeExact(value) : value;
}

function largerNonnegativeRational(left: ExactRational, right: ExactRational) {
  return left.numerator * right.denominator >= right.numerator * left.denominator ? left : right;
}

function exactRowTolerance(
  layout: MnaLayout,
  assembly: DcAssembly,
  state: Float64Array,
  row: number,
  relative: ExactRational,
  absoluteTolerance: number,
) {
  const exactAbsoluteTolerance = numberToExactRational(absoluteTolerance);
  const equationTerms: ExactRational[] = [];
  const residual = assembly.exactResidual?.[row];
  if (!exactAbsoluteTolerance || !residual) { return null; }
  for (let column = 0; column < layout.size; column += 1) {
    const matrixIndex = row * layout.size + column;
    const coefficient = exactRealStateValue(assembly.matrix, matrixIndex);
    const value = exactStateValue(state, column);
    const exactCoefficient = coefficient ?? numberToExactRational(assembly.matrix[matrixIndex] ?? Number.NaN);
    const exactValue = typeof value === "number" ? numberToExactRational(value) : value;
    if (!exactCoefficient || !exactValue) { return null; }
    if (exactCoefficient.numerator === 0n || exactValue.numerator === 0n) { continue; }
    const term = multiplyExactRational(exactCoefficient, exactValue);
    equationTerms.push(absoluteExactRational(term));
  }
  const equationScale = sumExactRationals(equationTerms);
  const absoluteResidual = absoluteExactRational(residual);
  const relativeEquationScale = multiplyExactRational(relative, equationScale);
  const relativeResidualScale = multiplyExactRational(relative, absoluteResidual);
  const dominantScale = largerNonnegativeRational(relativeEquationScale, relativeResidualScale);
  const tolerance = addExactRational(exactAbsoluteTolerance, dominantScale);
  return tolerance.numerator > 0n ? tolerance : null;
}

function residualTolerances(
  layout: MnaLayout,
  assembly: DcAssembly,
  state: Float64Array,
  currentTolerance = NEWTON_CURRENT_TOLERANCE_AMPS,
  voltageTolerance = NEWTON_VOLTAGE_TOLERANCE_VOLTS,
  relativeTolerance = NEWTON_RELATIVE_TOLERANCE,
): ExactRational[] | null {
  if (!assembly.exactResidual) { return null; }
  const relative = numberToExactRational(relativeTolerance);
  const tolerances: ExactRational[] = [];
  if (!relative) { return null; }
  for (let row = 0; row < layout.size; row += 1) {
    const absoluteTolerance = row < layout.topology.nodeUnknownCount
      ? currentTolerance
      : voltageTolerance;
    const tolerance = exactRowTolerance(layout, assembly, state, row, relative, absoluteTolerance);
    if (!tolerance) { return null; }
    tolerances.push(tolerance);
  }
  return tolerances;
}

function residualScore(layout: MnaLayout, assembly: DcAssembly, tolerances: ExactRational[] | null) {
  if (!tolerances || !assembly.exactResidual) { return Number.POSITIVE_INFINITY; }
  let score = 0;
  for (let row = 0; row < layout.size; row += 1) {
    const residual = assembly.exactResidual[row];
    const tolerance = tolerances[row];
    if (!residual || !tolerance) { return Number.POSITIVE_INFINITY; }
    const normalized = divideExactRational(absoluteExactRational(residual), tolerance);
    if (!normalized) { return Number.POSITIVE_INFINITY; }
    score = Math.max(score, exactRationalToNumber(normalized));
    if (!Number.isFinite(score)) { return Number.POSITIVE_INFINITY; }
  }
  return score;
}

function currentBiasedDcSeed(document: CircuitDocument, layout: MnaLayout, state: Float64Array) {
  const biasedAssembly = assembleDc(document, layout, state);
  const biasedRhs = biasedAssembly.exactResidual
    ? negatedExactResidual(biasedAssembly.exactResidual)
    : null;
  if (biasedRhs && solveRealLinearSystem(layout.size, biasedAssembly.matrix, biasedRhs)) { return state; }

  // Independent voltage biases can already turn a MOS channel on. Preserve
  // their device slopes before seeding a remaining current-driven zero row;
  // I/GMIN alone can push a responsive channel into flat saturation instead.
  const unbiasedAssembly = assembleDc(document, layout, state, false);
  const { matrix } = unbiasedAssembly;
  const residual: ResidualTerms = (unbiasedAssembly.exactResidual ?? []).map((value) => [value]);
  for (let node = 0; node < layout.topology.nodeCount; node += 1) {
    if (node !== layout.topology.referenceNode) {
      stampConductance(matrix, residual, layout, state, node, layout.topology.referenceNode, GMIN_SIEMENS);
    }
  }
  stampDcReferences(document, layout, state, matrix, residual);
  const rhs = exactRhsFromResidualTerms(residual);
  const correction = rhs ? solveRealLinearSystem(layout.size, matrix, rhs) : null;
  return correction ? addScaledRealState(state, correction, 1) : state;
}

function linearDcSeed(document: CircuitDocument, layout: MnaLayout) {
  // Seed independent voltage biases before retrying a singular off-state nonlinear Jacobian.
  const state = new Float64Array(layout.size);
  const matrix = new Float64Array(layout.size * layout.size);
  const residual: ResidualTerms = Array.from({ length: layout.size }, () => []);
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
  const rhs = exactRhsFromResidualTerms(residual);
  const voltageSeed = rhs ? solveRealLinearSystem(layout.size, matrix, rhs) : null;
  return voltageSeed ? currentBiasedDcSeed(document, layout, voltageSeed) : null;
}

function solveDcNewtonStep(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  assembly: DcAssembly,
  tolerances: ExactRational[] | null,
  score: number,
) {
  // Keep this iteration's floating-node constraints fixed while comparing
  // line-search candidates. The next Newton iteration recalculates them from
  // its new bias point, so a cutoff MOS can turn on without its candidate KCL
  // residual being rejected against a different equation set.
  const channelConductingForReferences = mosChannelConductingByPartId(document, layout, state);
  const rhs = absoluteDcRhs(document, layout, state, channelConductingForReferences);
  const targetState = rhs ? solveRealLinearSystem(layout.size, assembly.matrix, rhs) : null;
  if (!targetState) { return { nextState: undefined, singular: true }; }

  let step = 1;
  let nextState: Float64Array | undefined;
  let delta: Float64Array | null = null;
  for (let search = 0; search < 14; search += 1) {
    let candidate: Float64Array;
    if (step === 1) {
      candidate = cloneRealState(targetState);
    } else {
      delta ??= exactRealStateDifference(targetState, state);
      if (!delta) { return { nextState: undefined, singular: true }; }
      candidate = addScaledRealState(state, delta, step);
    }
    const candidateAssembly = assembleDc(
      document,
      layout,
      candidate,
      true,
      channelConductingForReferences,
    );
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

function hasNonzeroExactResidual(assembly: DcAssembly) {
  return assembly.exactResidual?.some(({ numerator }) => numerator !== 0n) ?? true;
}

function exactZeroPhysicalSolution(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  assembly: DcAssembly,
) {
  return hasNonzeroExactResidual(assembly)
    ? null
    : validatePhysicalDcSolution(document, layout, state);
}

function solveLinearTargetState(
  size: number,
  matrix: Float64Array,
  rhs: readonly ExactRational[],
) {
  const cached = solveRealLinearSystemWithExactInverseCache(size, matrix, rhs);
  if (cached.status === "solved") { return cached.solution; }
  if (cached.status === "singular") { return null; }
  return solveRealLinearSystem(size, matrix, rhs);
}

function nonlinearCenters(document: CircuitDocument, layout: MnaLayout, state: Float64Array) {
  const centers: number[][] = [];
  for (const part of document.parts) {
    if (isNonlinearPart(part)) {
      centers.push(nonlinearTerminalVoltages(part, layout, state));
    }
  }
  return centers;
}

function nonlinearCentersMatch(left: readonly number[][], right: readonly number[][]) {
  return left.length === right.length && left.every((center, partIndex) => {
    const other = right[partIndex];
    return other !== undefined && center.length === other.length &&
      center.every((value, index) => Object.is(value, other[index]));
  });
}

function polishConvergedDcState(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  tolerances: ExactRational[],
  score: number,
) {
  if (score === 0 || !hasNonlinearParts(document)) { return state; }
  let polished = state;
  let polishedScore = score;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const channelConducting = mosChannelConductingByPartId(document, layout, polished);
    const assembly = assembleDc(document, layout, polished, true, channelConducting);
    const rhs = absoluteDcRhs(document, layout, polished, channelConducting);
    const target = rhs ? solveRealLinearSystem(layout.size, assembly.matrix, rhs) : null;
    if (!target) { break; }
    const candidateAssembly = assembleDc(document, layout, target, true, channelConducting);
    const candidateScore = residualScore(layout, candidateAssembly, tolerances);
    if (!(candidateScore < polishedScore)) { break; }
    const centersUnchanged = nonlinearCentersMatch(
      nonlinearCenters(document, layout, polished),
      nonlinearCenters(document, layout, target),
    );
    polished = target;
    polishedScore = candidateScore;
    if (centersUnchanged) { break; }
  }
  return polished;
}

function initialDcState(document: CircuitDocument, layout: MnaLayout, initialState?: Float64Array) {
  if (initialState) { return { state: cloneRealState(initialState), usedLinearSeed: true }; }
  if (!hasNonlinearParts(document)) {
    return { state: new Float64Array(layout.size), usedLinearSeed: false };
  }
  const seed = linearDcSeed(document, layout);
  return seed
    ? { state: cloneRealState(seed), usedLinearSeed: true }
    : { state: new Float64Array(layout.size), usedLinearSeed: false };
}

function validatePolishedDcSolution(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  tolerances: ExactRational[] | null,
  score: number,
) {
  const polished = tolerances
    ? polishConvergedDcState(document, layout, state, tolerances, score)
    : state;
  return validatePhysicalDcSolution(document, layout, polished);
}

function solveLinearDcAtReference(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
) {
  const assembly = assembleDc(document, layout, state);
  if (!assembly.exactResidual) { return { converged: false, singular: false }; }
  const exactSolution = exactZeroPhysicalSolution(document, layout, state, assembly);
  if (exactSolution) { return exactSolution; }
  const rhs = absoluteDcRhs(document, layout, state, {});
  if (!rhs) { return { converged: false, singular: false }; }
  const targetState = solveLinearTargetState(layout.size, assembly.matrix, rhs);
  return targetState
    ? validatePhysicalDcSolution(document, layout, targetState)
    : { converged: false, singular: true };
}

function linearSeedAfterFailedStep(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  usedLinearSeed: boolean,
  singular: boolean,
) {
  if (!singular || usedLinearSeed) { return null; }
  const seed = linearDcSeed(document, layout);
  return seed?.some((value, index) => value !== (state[index] ?? 0))
    ? cloneRealState(seed)
    : null;
}

function finishDcAtReference(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  usedLinearSeed: boolean,
): { state?: Float64Array; converged: boolean; singular: boolean; invalidPhysicalSolution?: boolean } {
  const finalAssembly = assembleDc(document, layout, state);
  const exactSolution = exactZeroPhysicalSolution(document, layout, state, finalAssembly);
  if (exactSolution) { return exactSolution; }
  const tolerances = residualTolerances(layout, finalAssembly, state);
  const score = residualScore(layout, finalAssembly, tolerances);
  if (score <= 1) {
    return validatePolishedDcSolution(document, layout, state, tolerances, score);
  }
  // A nearly zero device slope can stall line search before an independent
  // bias is reached. Retry once with those linear voltage biases established.
  const seed = usedLinearSeed ? null : linearDcSeed(document, layout);
  return seed
    ? solveDcAtReference(document, layout, seed)
    : { converged: false, singular: false };
}

function solveDcAtReference(
  document: CircuitDocument,
  layout: MnaLayout,
  initialState?: Float64Array,
): { state?: Float64Array; converged: boolean; singular: boolean; invalidPhysicalSolution?: boolean } {
  const initial = initialDcState(document, layout, initialState);
  let state: Float64Array = initial.state;
  let usedLinearSeed = initial.usedLinearSeed;
  if (layout.size === 0) { return { state, converged: true, singular: false }; }
  if (!hasNonlinearParts(document)) { return solveLinearDcAtReference(document, layout, state); }

  for (let iteration = 0; iteration < MAX_NEWTON_ITERATIONS; iteration += 1) {
    const assembled = assembleDc(document, layout, state);
    const exactSolution = exactZeroPhysicalSolution(document, layout, state, assembled);
    if (exactSolution) { return exactSolution; }
    const tolerances = residualTolerances(layout, assembled, state);
    const score = residualScore(layout, assembled, tolerances);
    const hasInitialResidual = iteration === 0 && hasNonzeroExactResidual(assembled);
    if (score <= 1 && !hasInitialResidual) {
      return validatePolishedDcSolution(document, layout, state, tolerances, score);
    }
    const step = solveDcNewtonStep(document, layout, state, assembled, tolerances, score);
    if (!step.nextState) {
      const seed = iteration === 0
        ? linearSeedAfterFailedStep(document, layout, state, usedLinearSeed, step.singular)
        : null;
      if (seed) {
        state = seed;
        usedLinearSeed = true;
        continue;
      }
      return { converged: false, singular: step.singular };
    }
    state = step.nextState;
  }
  return finishDcAtReference(document, layout, state, usedLinearSeed);
}

function validatePhysicalDcSolution(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
): { state?: Float64Array; converged: boolean; singular: boolean; invalidPhysicalSolution?: boolean } {
  const physicalAssembly = assembleDc(document, layout, state, false);
  if (!hasNonzeroExactResidual(physicalAssembly)) {
    return { state, converged: true, singular: false };
  }
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
    return "直流回路を計算できません。電流の戻り道や回路の接続、部品の値を確認してください。";
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

function complexFromScalar(value: number | ExactRational) {
  return typeof value === "number"
    ? complex(value)
    : complexFromExact({ real: value, imaginary: { numerator: 0n, denominator: 1n } });
}

function complexFromRealState(state: Float64Array, index: number) {
  const real = exactRealStateValue(state, index);
  const imaginary = numberToExactRational(0);
  return real && imaginary
    ? complexFromExact({ real, imaginary })
    : complex(state[index] ?? 0);
}

function addComplexMatrix(
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  size: number,
  row: number,
  column: number,
  valueReal: number | ExactRational,
  valueImaginary: number | ExactRational,
) {
  if (row < 0 || column < 0 || row >= size || column >= size) { return; }
  const index = row * size + column;
  addRealStateValue(matrixReal, index, valueReal);
  addRealStateValue(matrixImaginary, index, valueImaginary);
}

function stampAcReferences(
  document: CircuitDocument,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  layout: MnaLayout,
  channelConducting: Readonly<Record<string, boolean>>,
) {
  for (const { node } of referenceConstraints(document, layout, "ac", channelConducting)) {
    const unknown = layout.topology.nodeUnknowns[node] ?? -1;
    if (unknown < 0) { continue; }
    clearRealStateRange(matrixReal, unknown * layout.size, (unknown + 1) * layout.size);
    clearRealStateRange(matrixImaginary, unknown * layout.size, (unknown + 1) * layout.size);
    setRealStateValue(matrixReal, unknown * layout.size + unknown, 1);
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
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, positiveUnknown, branch.unknownIndex,
    1, 0,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, negativeUnknown, branch.unknownIndex,
    -1, 0,
  );
  addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, positiveUnknown, 1, 0);
  addComplexMatrix(matrixReal, matrixImaginary, layout.size, branch.unknownIndex, negativeUnknown, -1, 0);
  addComplexMatrix(
    matrixReal,
    matrixImaginary,
    layout.size,
    branch.unknownIndex,
    branch.unknownIndex,
    branch.exactSeriesResistance
      ? negativeExact(branch.exactSeriesResistance)
      : -branch.seriesResistanceOhms,
    branch.exactSeriesReactance ? negatedResidualTerm(branch.exactSeriesReactance) : -reactance,
  );
  const exactSource = exactComplexValue(branch.sourceVoltage);
  setRealStateValue(rhsReal, branch.unknownIndex, exactSource?.real ?? branch.sourceVoltage.real);
  setRealStateValue(rhsImaginary, branch.unknownIndex, exactSource?.imaginary ?? branch.sourceVoltage.imaginary);
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
  const exact = exactComplexValue(admittance);
  const negative = exactComplexValue(complexSubtract(complex(), admittance));
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, positiveUnknown, positiveUnknown,
    exact?.real ?? admittance.real, exact?.imaginary ?? admittance.imaginary,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, positiveUnknown, negativeUnknown,
    negative?.real ?? -admittance.real, negative?.imaginary ?? -admittance.imaginary,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, negativeUnknown, positiveUnknown,
    negative?.real ?? -admittance.real, negative?.imaginary ?? -admittance.imaginary,
  );
  addComplexMatrix(
    matrixReal, matrixImaginary, layout.size, negativeUnknown, negativeUnknown,
    exact?.real ?? admittance.real, exact?.imaginary ?? admittance.imaginary,
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
    const coefficients = nonlinearModelCoefficients(model, row);
    const columnCount = part.kind === "op-amp" ? terminals.length : terminals.length - 1;
    for (let column = 0; column < columnCount; column += 1) {
      const columnUnknown = layout.topology.nodeUnknowns[nodes[column] ?? -1] ?? -1;
      addComplexMatrix(
        matrixReal,
        matrixImaginary,
        layout.size,
        rowUnknown,
        columnUnknown,
        coefficients[column] ?? 0,
        0,
      );
    }
    if (part.kind !== "op-amp") {
      const sum = exactResidualSum(coefficients.slice(0, columnCount));
      const referenceUnknown = layout.topology.nodeUnknowns[nodes.at(-1) ?? -1] ?? -1;
      addComplexMatrix(
        matrixReal,
        matrixImaginary,
        layout.size,
        rowUnknown,
        referenceUnknown,
        sum ? negativeExact(sum) : Number.NaN,
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
  const channelConducting = mosChannelConductingByPartId(document, dcLayout, dcState);

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
  stampAcReferences(document, matrixReal, matrixImaginary, layout, channelConducting);

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
    addSourceEdge(branch.positiveNode, branch.negativeNode, complexSubtract(complex(), branch.sourceVoltage));
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
  channelConducting: Readonly<Record<string, boolean>>,
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
  const componentIds = acReferenceComponentIds(document, layout, channelConducting);
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

function acReferenceComponentIds(
  document: CircuitDocument,
  layout: MnaLayout,
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  const parent = Array.from({ length: layout.topology.nodeCount }, (_, index) => index);
  const switchStates = Object.fromEntries(document.parts
    .filter((part) => part.kind === "switch")
    .map((part) => [part.id, layout.branchByPartId.has(part.id)]));
  for (const part of document.parts) {
    const reactiveBranchIsModeled = layout.branchByPartId.has(part.id) ||
      layout.unboundedReactiveAdmittances.has(part.id);
    if (part.kind === "inductor" && !reactiveBranchIsModeled) { continue; }
    if ((part.kind === "nmos" || part.kind === "pmos") && channelConducting?.[part.id] === false) {
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
  channelConducting: Readonly<Record<string, boolean>>,
) {
  return referenceComponentNodes(document, layout, seedNode, "ac", channelConducting);
}

function nonlinearModelIsCommonModeInvariant(part: CircuitPart, model: NonlinearModel) {
  if (model.exactJacobian) {
    return model.exactJacobian.every((row) => sumExactRationals(row).numerator === 0n);
  }
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
  return true;
}

function nonlinearAcModelIsCommonModeInvariant(
  document: CircuitDocument,
  layout: MnaLayout,
  dcState: Float64Array,
) {
  for (const part of document.parts) {
    const model = nonlinearModel(part, nonlinearTerminalVoltages(part, layout, dcState));
    if (model && !nonlinearModelIsCommonModeInvariant(part, model)) { return false; }
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
  channelConducting: Readonly<Record<string, boolean>>,
): AcSolution | null {
  let bestSolution: AcSolution | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const referenceNode of preferredReferenceNodes(document, layout, "ac", channelConducting).slice(0, 8)) {
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
      const offset = complexSubtract(complex(), originalReferenceVoltage);
      const component = acReferenceComponent(document, rebasedLayout, referenceNode, channelConducting);
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
  const channelConducting = mosChannelConductingByPartId(document, layout, dcState);
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
      channelConducting,
    );
    if (rebasedSolution) { return rebasedSolution; }
  }

  if (originalResidual <= 1e-10) { return solution; }
  for (const candidate of acReferenceCandidates(document, layout, values, channelConducting)) {
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
    const offset = complexSubtract(complex(), originalReferenceVoltage);
    const component = acReferenceComponent(document, rebasedLayout, candidate.node, channelConducting);
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
  return complexSubtract(left, right);
}

function currentsFromVoltageBranch(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
): ComplexValue[] | null {
  const branch = layout.branchByPartId.get(part.id);
  if (!branch) { return null; }
  const value = branchCurrentValue(branch, solution);
  return [value, complexSubtract(complex(), value)];
}

function branchCurrentValue(branch: Branch, solution: ComplexValue[]) {
  return solution[branch.unknownIndex] ?? complex();
}

function reactiveCurrent(part: CircuitPart, frequencyHz: number | undefined, voltage: ComplexValue) {
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
    const current = complexDivide(vdiff, complex(resistorValue(part)));
    return [current, complexSubtract(complex(), current)];
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
      return complexDivide(voltageDifference(outerVoltage, vc), complex(resistance));
    };
    const currentA = currentForSegment("a", va, segments.ac);
    const currentB = currentForSegment("b", vb, segments.cb);
    return [
      currentA,
      currentB,
      complexSubtract(complex(), complexAdd(currentA, currentB)),
    ];
  }
  if (part.kind === "current-source") {
    const current = mode === "dc" ? (part.currentAmps ?? 0) : 0;
    return [complex(current), complex(-current)];
  }
  if ((part.kind === "capacitor" || part.kind === "inductor") && mode === "ac") {
    // A reactance beyond binary64 range uses exact Norton admittance, even
    // when that admittance's displayed number rounds to zero.
    if (
      !layout.branchByPartId.has(part.id) &&
      !layout.unboundedReactiveAdmittances.has(part.id)
    ) {
      return [complex(), complex()];
    }
    const current = reactiveCurrent(part, frequencyHz, vdiff);
    return [current, complexSubtract(complex(), current)];
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
  if (mode === "dc") {
    return terminals.map((_, row) => complexFromScalar(nonlinearModelCurrent(model, row)));
  }

  const phasors = terminalComplexValues(part, layout, solution);
  return terminals.map((_, row) => {
    let current = complex();
    const columnCount = part.kind === "op-amp" ? terminals.length : terminals.length - 1;
    const deviceReference = part.kind === "op-amp" ? complex() : phasors.at(-1) ?? complex();
    for (let column = 0; column < columnCount; column += 1) {
      const delta = complexSubtract(phasors[column] ?? complex(), deviceReference);
      const slope = nonlinearModelCoefficients(model, row)[column] ?? 0;
      current = complexAdd(current, complexMultiply(complexFromScalar(slope), delta));
    }
    const referenceSlope = nonlinearReferenceDerivative(part, model, row);
    if (referenceSlope !== 0) {
      const reference = nodeComplexValue(layout, layout.physicalReferenceNode, solution);
      current = complexAdd(current, complexMultiply(complex(referenceSlope), reference));
    }
    return current;
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
      currentsByNode[layout.physicalReferenceNode]?.push(complexSubtract(complex(), outputCurrent));
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
  const values = Array.from({ length: layout.size }, (_, index) => complexFromRealState(state, index));
  const currentsByNode = Array.from({ length: layout.topology.nodeCount }, () => [] as ComplexValue[]);
  for (const part of document.parts) {
    const currents = terminalCurrentsForPart(part, layout, layout, values, "dc", undefined, state);
    const terminals = terminalsOf(part.kind);
    for (let index = 0; index < terminals.length; index += 1) {
      const node = nodeForTerminal(layout.topology, part, terminals[index] ?? "a");
      currentsByNode[node]?.push(currents[index] ?? complex());
    }
    if (part.kind === "op-amp") {
      currentsByNode[layout.physicalReferenceNode]?.push(complexSubtract(complex(), currents[2] ?? complex()));
    }
  }

  return Math.max(0, ...currentsByNode.map(relativeRealResidual));
}

/** Measures conservation before public number rounding changes the terms. */
function relativeRealResidual(terms: ComplexValue[]) {
  const values: ExactRational[] = [];
  for (const term of terms) {
    const value = exactComplexValue(term)?.real;
    if (!value) { return Number.POSITIVE_INFINITY; }
    values.push(value);
  }
  const residual = sumExactRationals(values);
  if (residual.numerator === 0n) { return 0; }
  const scale = sumExactRationals(values.map(absoluteExactRational));
  if (scale.numerator === 0n) { return 0; }
  const ratio = divideExactRational(residual, scale);
  return ratio ? Math.abs(exactRationalToNumber(ratio)) : Number.POSITIVE_INFINITY;
}

function dcBranchVoltageQuality(layout: MnaLayout, state: Float64Array) {
  const values = Array.from({ length: layout.size }, (_, index) => complexFromRealState(state, index));
  let quality = 0;
  for (const branch of [...layout.branches, ...layout.internalBranches]) {
    if (branch.redundantIdealSource) { continue; }
    const nodeVoltage = voltageDifference(
      nodeComplexValue(layout, branch.positiveNode, values),
      nodeComplexValue(layout, branch.negativeNode, values),
    );
    const expectedVoltage = voltageFromBranch(branch, values);
    quality = Math.max(quality, relativeRealResidual([
      nodeVoltage,
      complexSubtract(complex(), expectedVoltage),
    ]));
  }
  return quality;
}

function dcSolutionQuality(document: CircuitDocument, layout: MnaLayout, state: Float64Array) {
  return { current: dcKclQuality(document, layout, state), voltage: dcBranchVoltageQuality(layout, state) };
}

function acceptableDcQuality(quality: ReturnType<typeof dcSolutionQuality>) {
  return quality.current <= 1e-12 && quality.voltage <= 1e-12;
}

function improvesDcQuality(
  candidate: ReturnType<typeof dcSolutionQuality>,
  previous: ReturnType<typeof dcSolutionQuality>,
  factor = 1,
) {
  // A better voltage coordinate must never sacrifice an already balanced
  // junction. First establish KCL, then improve KVL within that constraint.
  if (previous.current <= 1e-12) {
    return candidate.current <= 1e-12 && candidate.voltage < previous.voltage * factor;
  }
  return candidate.current < previous.current * factor;
}

function dcReferenceOffsets(
  document: CircuitDocument,
  layout: MnaLayout,
  state: Float64Array,
  channelConducting: Readonly<Record<string, boolean>>,
) {
  const referenceNode = layout.physicalReferenceNode;
  const unknown = layout.topology.nodeUnknowns[referenceNode] ?? -1;
  const offset = complexSubtract(complex(), unknown < 0 ? complex() : complexFromRealState(state, unknown));
  const component = referenceComponentNodes(document, layout, referenceNode, "dc", channelConducting);
  return component.map((isReferenceComponent) => isReferenceComponent ? offset : complex());
}

function restoreFloatingReferenceOffsets(
  document: CircuitDocument,
  layout: MnaLayout,
  solution: ComplexValue[],
  initialOffsets: ComplexValue[],
  mode: AnalogAnalysisMode,
  channelConducting?: Readonly<Record<string, boolean>>,
) {
  if (layout.initialInductorCurrents) { return initialOffsets; }
  const componentIds = referenceComponentIds(document, layout, mode, channelConducting);
  const physicalReferenceRoot = componentIds[layout.physicalReferenceNode];
  const firstNodeByRoot = new Map<number, number>();
  for (let node = 0; node < componentIds.length; node += 1) {
    const root = componentIds[node];
    if (root !== undefined && !firstNodeByRoot.has(root)) { firstNodeByRoot.set(root, node); }
  }

  const offsets = Array.from({ length: layout.topology.nodeCount }, (_, node) => initialOffsets[node] ?? complex());
  for (const [root, anchor] of firstNodeByRoot) {
    if (root === physicalReferenceRoot) { continue; }
    const potential = nodeComplexValue(layout, anchor, solution);
    const offset = complexSubtract(complex(), potential);
    for (let node = 0; node < componentIds.length; node += 1) {
      if (componentIds[node] !== root) { continue; }
      offsets[node] = offset;
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
  const baselineChannelConducting = baseline.state
    ? mosChannelConductingByPartId(document, layout, baseline.state)
    : undefined;
  const baselineResult: DcSolution = {
    ...baseline,
    layout,
    nodeVoltageOffsets: Array.from({ length: layout.topology.nodeCount }, () => complex()),
  };
  // An exact linear solution already satisfies its branch equations. A
  // coordinate change cannot improve it, and has no Newton stopping scale.
  if (baseline.converged && !hasNonlinearParts(document)) { return baselineResult; }
  if (!adjustReference || !canAdjustDcReference(document, layout, baselineChannelConducting)) { return baselineResult; }
  const baselineQuality = baseline.converged && baseline.state
    ? dcSolutionQuality(document, layout, baseline.state)
    : { current: Number.POSITIVE_INFINITY, voltage: Number.POSITIVE_INFINITY };
  if (acceptableDcQuality(baselineQuality)) { return baselineResult; }
  let best = baselineResult;
  let bestQuality = baselineQuality;
  // A second- or third-strongest node can yield a much better-scaled KCL row
    // when the strongest candidate shares another badly conditioned branch.
  for (const referenceNode of preferredReferenceNodes(document, layout, "dc", baselineChannelConducting).slice(0, 8)) {
    const candidateLayout = layoutWithReferenceNode(layout, referenceNode);
    const candidate = solveDcAtReference(document, candidateLayout);
    if (!candidate.converged || !candidate.state) { continue; }
    const candidateQuality = dcSolutionQuality(document, candidateLayout, candidate.state);
    if (improvesDcQuality(candidateQuality, bestQuality)) {
      best = {
        ...candidate,
        layout: candidateLayout,
        nodeVoltageOffsets: dcReferenceOffsets(
          document,
          candidateLayout,
          candidate.state,
          mosChannelConductingByPartId(document, candidateLayout, candidate.state),
        ),
      };
      bestQuality = candidateQuality;
    }
    if (acceptableDcQuality(bestQuality)) { return best; }
  }
  if (best === baselineResult || !improvesDcQuality(bestQuality, baselineQuality, 0.5)) { return baselineResult; }
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
    power = complexAdd(
      power,
      complexMultiply(relativeVoltage, complexConjugate(currentValues[index] ?? complex())),
    );
  }
  return power;
}

function exactImpedance(
  resistance: number,
  reactance: number,
  exactReactance?: ExactRational,
  exactResistance?: ExactRational,
) {
  const real = exactResistance ?? numberToExactRational(resistance);
  const imaginary = exactReactance ?? numberToExactRational(reactance);
  return (exactResistance || exactReactance) && real && imaginary
    ? complexFromExact({ real, imaginary })
    : complex(resistance, reactance);
}

function measuredPower(voltage: ComplexValue, current: ComplexValue) {
  const exactVoltage = exactComplexValue(voltage);
  const exactCurrent = exactComplexValue(current);
  if (
    exactVoltage?.imaginary.numerator === 0n &&
    exactCurrent?.imaginary.numerator === 0n
  ) {
    return complex(exactRationalProductToNumber(exactVoltage.real, exactCurrent.real));
  }
  return complexMultiply(voltage, complexConjugate(current));
}

function impedanceMeasurements(
  resistance: number,
  reactance: number,
  current: ComplexValue,
  exactReactance?: ExactRational,
  retainExactPower = false,
  exactResistance?: ExactRational,
) {
  const voltage = complexMultiply(
    exactImpedance(resistance, reactance, exactReactance, exactResistance),
    current,
  );
  const power = retainExactPower
    ? complexMultiply(voltage, complexConjugate(current))
    : measuredPower(voltage, current);
  return {
    voltage,
    power: retainExactPower
      ? power
      : complex(
        resistance === 0 && (exactResistance?.numerator ?? 0n) === 0n ? 0 : power.real,
        reactance === 0 && (exactReactance?.numerator ?? 0n) === 0n ? 0 : power.imaginary),
  };
}

function transientCompanionBranchVoltage(
  branch: Branch,
  current: number | ComplexValue,
  exactCurrentValue?: ExactRational,
) {
  const companion = branch.transientCompanion;
  if (!companion) { return { voltage: Number.NaN, exactVoltage: null }; }
  const currentNumber = typeof current === "number" ? current : current.real;
  const exactCurrent = exactCurrentValue ??
    (typeof current === "number" ? null : exactComplexValue(current)?.real) ??
    numberToExactRational(currentNumber);
  const exactHistory = companion.exactHistoryValue ?? numberToExactRational(companion.historyValue);
  if (!exactCurrent || !exactHistory) {
    return { voltage: Number.NaN, exactVoltage: null };
  }
  if (companion.kind === "capacitor") {
    const exactVoltage = exactProductSumRatio([
      { factors: [exactHistory, companion.denominator] },
      { factors: [companion.numerator, exactCurrent] },
    ], companion.denominator);
    return {
      voltage: exactVoltage ? exactRationalToNumber(exactVoltage) : Number.NaN,
      exactVoltage,
    };
  }
  const exactVoltage = exactProductSumRatio([
    { factors: [companion.numerator, exactCurrent] },
    { factors: [companion.numerator, exactHistory], sign: -1 },
  ], companion.denominator);
  return {
    voltage: exactVoltage ? exactRationalToNumber(exactVoltage) : Number.NaN,
    exactVoltage,
  };
}

function voltageFromBranch(branch: Branch, solution: ComplexValue[]) {
  const current = solution[branch.unknownIndex] ?? complex();
  if (branch.transientCompanion) {
    const exact = exactComplexValue(current);
    const companionVoltage = transientCompanionBranchVoltage(
      branch,
      current,
      exact?.real,
    );
    const zero = numberToExactRational(0);
    return companionVoltage.exactVoltage && zero
      ? complexFromExact({ real: companionVoltage.exactVoltage, imaginary: zero })
      : complex(companionVoltage.voltage);
  }
  return complexAdd(
    branch.sourceVoltage,
    complexMultiply(
      exactImpedance(
        branch.seriesResistanceOhms,
        branch.seriesReactanceOhms ?? 0,
        branch.exactSeriesReactance,
        branch.exactSeriesResistance,
      ),
      current,
    ),
  );
}

function branchVoltageMeasurement(branch: Branch, layout: MnaLayout, solution: ComplexValue[]) {
  if (branch.transientCompanion) {
    // The solved node values retain their exact fractions, including hidden
    // subnormal differences. Reconstructing the same voltage from history
    // would repeat expensive cancellations as that history grows.
    const voltage = voltageDifference(
      nodeComplexValue(layout, branch.positiveNode, solution),
      nodeComplexValue(layout, branch.negativeNode, solution),
    );
    return { voltage, roundingScale: 0, cancellation: false };
  }
  let voltage = voltageFromBranch(branch, solution);
  const sourceScale = Math.max(Math.abs(branch.sourceVoltage.real), Math.abs(branch.sourceVoltage.imaginary));
  const voltageScale = Math.max(Math.abs(voltage.real), Math.abs(voltage.imaginary));
  const exactVoltage = exactComplexValue(voltage);
  const underflowedVoltageScale = voltageScale === 0 && exactVoltage &&
    (exactVoltage.real.numerator !== 0n || exactVoltage.imaginary.numerator !== 0n)
    ? Number.MIN_VALUE
    : 0;
  const ideal = isIdealVoltageConstraint(branch);
  let roundingScale = ideal ? 0 : Math.max(sourceScale, voltageScale, underflowedVoltageScale);
  const cancellation = !ideal && sourceScale > 0 && voltageScale < sourceScale / 2;
  if (cancellation) {
    const positiveVoltage = nodeComplexValue(layout, branch.positiveNode, solution);
    const negativeVoltage = nodeComplexValue(layout, branch.negativeNode, solution);
    const coordinateScale = Math.max(
      Math.abs(positiveVoltage.real), Math.abs(positiveVoltage.imaginary),
      Math.abs(negativeVoltage.real), Math.abs(negativeVoltage.imaginary),
    );
    if (coordinateScale < roundingScale) {
      voltage = voltageDifference(positiveVoltage, negativeVoltage);
      roundingScale = coordinateScale;
    }
  }
  return { voltage, roundingScale, cancellation };
}

interface BranchVoltagePathEdge {
  node: number;
  voltage: ComplexValue;
  cost: number;
}

interface BranchVoltagePair {
  branches: Branch[];
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
    const isIdeal = isIdealVoltageConstraint(branch);
    if (!pair) {
      directBranches.set(pairKey, { branches: [branch], ...(isIdeal ? { ideal: branch } : {}) });
    } else {
      pair.branches.push(branch);
      if (isIdeal && !pair.ideal) { pair.ideal = branch; }
    }
  }
  return { branches, directBranches, paths: new Map() };
}

function branchVoltageAdjacency(
  context: BranchVoltagePathContext,
  layout: MnaLayout,
  solution: ComplexValue[],
) {
  const values: Array<{ branch: Branch; voltage: ComplexValue; roundingScale: number }> = [];
  for (const branch of context.branches) {
    if (branch.positiveNode === branch.negativeNode) { continue; }
    const { voltage, roundingScale } = branchVoltageMeasurement(branch, layout, solution);
    if (Number.isFinite(voltage.real) && Number.isFinite(voltage.imaginary) && Number.isFinite(roundingScale)) {
      values.push({ branch, voltage, roundingScale });
    }
  }
  if (values.length === 0) { return null; }

  const adjacency: BranchVoltagePathEdge[][] = Array.from(
    { length: layout.topology.nodeCount },
    () => [],
  );
  for (const { branch, voltage, roundingScale } of values) {
    // Logarithmic costs preserve ordering across the entire binary64 range.
    // A voltage formed by cancelling a source and a resistor drop carries the
    // scale of those terms, even when its computed value is spuriously zero.
    const cost = Math.log(roundingScale);
    adjacency[branch.positiveNode]?.push({ node: branch.negativeNode, voltage, cost });
    adjacency[branch.negativeNode]?.push({
      node: branch.positiveNode,
      voltage: complexSubtract(complex(), voltage),
      cost,
    });
  }
  return adjacency;
}

function leastCostUnvisitedNode(costs: number[], hops: number[], visited: Uint8Array) {
  let node = -1;
  for (let candidate = 0; candidate < costs.length; candidate += 1) {
    if (visited[candidate] || costs[candidate] === Number.POSITIVE_INFINITY) { continue; }
    if (
      node < 0 || costs[candidate]! < costs[node]! ||
      (costs[candidate] === costs[node] && hops[candidate]! < hops[node]!)
    ) {
      node = candidate;
    }
  }
  return node;
}

function addBranchPathCosts(first: number, second: number) {
  if (first === Number.NEGATIVE_INFINITY) { return second; }
  if (second === Number.NEGATIVE_INFINITY) { return first; }
  const larger = Math.max(first, second);
  return larger + Math.log1p(Math.exp(Math.min(first, second) - larger));
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
  costs[positiveNode] = Number.NEGATIVE_INFINITY;
  hops[positiveNode] = 0;

  let remaining = adjacency.length;
  while (remaining > 0) {
    const node = leastCostUnvisitedNode(costs, hops, visited);
    if (node < 0 || node === negativeNode) { break; }
    visited[node] = 1;
    remaining -= 1;

    for (const edge of adjacency[node] ?? []) {
      if (visited[edge.node]) { continue; }
      const candidateCost = addBranchPathCosts(costs[node]!, edge.cost);
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

  if (costs[negativeNode] === Number.POSITIVE_INFINITY) { return null; }
  return sumBranchVoltagePath(positiveNode, negativeNode, previousNodes, previousVoltages);
}

function sumBranchVoltagePath(
  positiveNode: number,
  negativeNode: number,
  previousNodes: number[],
  previousVoltages: Array<ComplexValue | undefined>,
) {
  let voltage = complex();
  for (let node = negativeNode; node !== positiveNode;) {
    const edgeVoltage = previousVoltages[node];
    const previous = previousNodes[node] ?? -1;
    if (edgeVoltage === undefined || previous < 0) { return null; }
    voltage = complexAdd(voltage, edgeVoltage);
    node = previous;
  }
  return voltage;
}

function voltageFromBranchPath(
  part: CircuitPart,
  layout: MnaLayout,
  solution: ComplexValue[],
  context: BranchVoltagePathContext | null,
  includeSourceBranch = false,
): ComplexValue | null {
  if (part.kind !== "voltmeter" && !includeSourceBranch) { return null; }
  const positiveNode = nodeForTerminal(layout.topology, part, "a");
  const negativeNode = nodeForTerminal(layout.topology, part, "b");
  if (positiveNode === negativeNode) { return complex(); }
  if (!context) { return null; }
  const lowNode = Math.min(positiveNode, negativeNode);
  const highNode = Math.max(positiveNode, negativeNode);
  const pairKey = lowNode * layout.topology.nodeCount + highNode;
  const pair = context.directBranches.get(pairKey);
  const direct = bestDirectBranchVoltage(pair, positiveNode, layout, solution);
  if (direct && !direct.cancellation) { return direct.voltage; }
  // Also inspect alternate paths for a source branch whose two large terms
  // nearly cancel. A parallel or series load can retain its tiny terminal
  // voltage even when both node potentials round to the same common mode.
  if (context.adjacency === undefined) {
    context.adjacency = branchVoltageAdjacency(context, layout, solution);
  }
  // A voltmeter can span several elements. Sum their branch-equation voltages
  // instead of subtracting two large node phasors, which can discard small drops.
  // Among alternate routes, prefer the smallest accumulated rounding scale;
  // exact ideal-source constraints contribute no branch-evaluation roundoff.
  const pathKey = positiveNode * layout.topology.nodeCount + negativeNode;
  if (context.paths.has(pathKey)) { return context.paths.get(pathKey) ?? null; }
  const voltage = context.adjacency
    ? shortestBranchVoltagePath(positiveNode, negativeNode, context.adjacency)
    : null;
  context.paths.set(pathKey, voltage);
  context.paths.set(
    negativeNode * layout.topology.nodeCount + positiveNode,
    voltage ? complexSubtract(complex(), voltage) : null,
  );
  return voltage;
}

function bestDirectBranchVoltage(
  pair: BranchVoltagePair | undefined,
  positiveNode: number,
  layout: MnaLayout,
  solution: ComplexValue[],
) {
  let best: ReturnType<typeof branchVoltageMeasurement> | undefined;
  for (const branch of pair?.ideal ? [pair.ideal] : (pair?.branches ?? [])) {
    const measurement = branchVoltageMeasurement(branch, layout, solution);
    if (best && measurement.roundingScale >= best.roundingScale) { continue; }
    best = {
      ...measurement,
      voltage: branch.positiveNode === positiveNode
        ? measurement.voltage
        : complexSubtract(complex(), measurement.voltage),
    };
  }
  return best;
}

function resolvedBranchVoltage(
  part: CircuitPart,
  branch: Branch | undefined,
  layout: MnaLayout,
  solution: ComplexValue[],
  context: BranchVoltagePathContext | null,
) {
  if (!branch) { return null; }
  const measurement = branchVoltageMeasurement(branch, layout, solution);
  return measurement.cancellation
    ? voltageFromBranchPath(part, layout, solution, context, true) ?? measurement.voltage
    : measurement.voltage;
}

function resistiveMeasurements(part: CircuitPart, currents: ComplexValue[]) {
  if (part.kind === "resistor" || part.kind === "bulb") {
    return impedanceMeasurements(resistorValue(part), 0, currents[0] ?? complex());
  }
  if (part.kind !== "potentiometer") { return null; }
  const segments = potentiometerSegments(part);
  const ac = impedanceMeasurements(
    segments.ac,
    0,
    currents[0] ?? complex(),
    undefined,
    true,
    segments.exactAc,
  );
  const bc = impedanceMeasurements(
    segments.cb,
    0,
    currents[1] ?? complex(),
    undefined,
    true,
    segments.exactCb,
  );
  return {
    voltage: voltageDifference(ac.voltage, bc.voltage),
    power: complexAdd(ac.power, bc.power),
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
      ? impedanceMeasurements(0, reactiveBranch.seriesReactanceOhms ?? 0, current, reactiveBranch.exactSeriesReactance)
      : unboundedReactiveAdmittance
        ? (() => {
          // Norton currents are derived from these node voltages. Inverting a
          // rounded subnormal current loses the original voltage (even to zero).
          const voltage = primaryVoltage(part, terminalVoltages);
          const power = measuredPower(voltage, current);
          return { voltage, power: complex(0, power.imaginary) };
        })()
        : null
    : null;
  const branch = layout.branchByPartId.get(part.id);
  const branchVoltage = resolvedBranchVoltage(part, branch, layout, solution, branchVoltagePaths);
  const physicalReferenceVoltage = nodeComplexValue(layout, layout.physicalReferenceNode, solution);
  const opAmpVoltage = part.kind === "op-amp"
    ? voltageDifference(terminalVoltages[2] ?? complex(), physicalReferenceVoltage)
    : null;
  const voltage = resistive?.voltage ?? reactive?.voltage ?? branchVoltage ??
    voltageFromBranchPath(part, layout, solution, branchVoltagePaths) ?? opAmpVoltage ?? primaryVoltage(part, terminalVoltages);
  const powerVoltages = part.kind === "op-amp"
    ? terminalVoltages.map((value) => voltageDifference(value, physicalReferenceVoltage))
    : terminalVoltages;
  const power = resistive?.power ?? reactive?.power ??
    (branchVoltage ? measuredPower(voltage, current) : componentPower(part, powerVoltages, terminalCurrents));
  return { voltage, power };
}

function layoutMeterStatuses(
  document: CircuitDocument,
  layout: MnaLayout,
  mode: AnalogAnalysisMode,
  frequencyHz: number | undefined,
  switchStates: Record<string, boolean>,
  channelConducting: Readonly<Record<string, boolean>>,
) {
  const statuses = meterStatuses(document, {
    mode,
    frequencyHz,
    switchStates,
    channelConducting,
    initialInductorCurrents: layout.initialInductorCurrents,
  });
  // Capacitor loop derivatives determine their currents at initialization;
  // only cycles made entirely of ideal sources leave meter currents free.
  const idealBranches = [...layout.branches, ...layout.internalBranches].filter((branch) =>
    isIdealVoltageConstraint(branch) && branch.initialCapacitanceFarads === undefined);
  for (const meter of idealBranches) {
    if (meter.kind !== "ammeter" || statuses[meter.partId] !== "connected") { continue; }
    // Every ideal voltage branch fixes a voltage difference, even when that
    // difference is nonzero. A cycle leaves all its branch currents nonunique,
    // including branches retained in the solver's chosen spanning tree.
    const parent = Array.from({ length: layout.topology.nodeCount }, (_, node) => node);
    for (const branch of idealBranches) {
      if (branch !== meter) { unionNodes(parent, branch.positiveNode, branch.negativeNode); }
    }
    if (findRoot(parent, meter.positiveNode) === findRoot(parent, meter.negativeNode)) {
      statuses[meter.partId] = "floating";
    }
  }
  return statuses;
}

function mosChannelReading(
  part: CircuitPart,
  channelConducting: Readonly<Record<string, boolean>>,
): Pick<AnalogCircuitPartReading, "channelConducting"> {
  return Object.hasOwn(channelConducting, part.id)
    ? { channelConducting: channelConducting[part.id] }
    : {};
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
  const channelConducting = mosChannelConductingByPartId(document, biasLayout, dcState);
  const meterStatusByPart = layoutMeterStatuses(
    document,
    layout,
    mode,
    frequencyHz,
    switchStates,
    channelConducting,
  );
  const branchVoltagePaths = document.parts.some((part) => part.kind === "voltmeter") ||
    layout.branches.some((branch) => branch.seriesResistanceOhms > 0 &&
      (branch.sourceVoltage.real !== 0 || branch.sourceVoltage.imaginary !== 0))
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
      ...mosChannelReading(part, channelConducting),
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
  transientCompanions?: ReadonlyMap<string, TransientCompanionConstraint>,
  initialVoltageConstraints?: ReadonlyMap<string, InitialVoltageConstraint>,
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
    transientCompanions,
    initialVoltageConstraints,
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
    solution.state ? complexFromRealState(solution.state, index) : complex(),
  );
  const nodeVoltageOffsets = restoreFloatingReferenceOffsets(
    document,
    solvedLayout,
    values,
    solution.nodeVoltageOffsets ?? [],
    "dc",
    mosChannelConductingByPartId(document, solvedLayout, solution.state),
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
      ? "交流解析に使う直流動作点を計算できません。電流の戻り道や回路の接続、部品の値を確認してください。"
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
    mosChannelConductingByPartId(document, solution.biasLayout, bias.state),
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
  transientCompanions?: ReadonlyMap<string, TransientCompanionConstraint>,
  initialVoltageConstraints?: ReadonlyMap<string, InitialVoltageConstraint>,
): AnalogCircuitAnalysis {
  let mode: AnalogAnalysisMode = "dc";
  try {
    if (isSimulationRecord(options) && simulationRecordField(options, "mode") === "ac") { mode = "ac"; }
  } catch {
    const message = "解析条件はオブジェクトで指定してください。";
    return result("invalid", mode, message, { issues: [{ severity: "error", message }] });
  }
  try {
    return solveAnalogStepFromInput(inputDocument, options, mode, transientCompanions, initialVoltageConstraints);
  } catch {
    // A caller-owned Proxy can change behavior after shape validation. Keep
    // failures at the public API boundary, as in transient analysis.
    const message = "回路データまたは解析条件を読み取れません。";
    return result("invalid", mode, message, { issues: [{ severity: "error", message }] });
  }
}

function solveAnalogStepFromInput(
  inputDocument: CircuitDocument,
  options: AnalogStepOptions,
  mode: AnalogAnalysisMode,
  transientCompanions?: ReadonlyMap<string, TransientCompanionConstraint>,
  initialVoltageConstraints?: ReadonlyMap<string, InitialVoltageConstraint>,
): AnalogCircuitAnalysis {
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
  return validatedOptions.mode === "dc"
    ? dcResult(document, validatedOptions, [], transientCompanions, initialVoltageConstraints)
    : acResult(document, validatedOptions);
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
