import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeExtendedCircuit } from "./circuit-analog-adapter.js";
import { solveRealLinearSystem } from "./analog-math.js";
import {
  divideExactRational,
  exactRationalToNumber,
  multiplyExactRational,
  numberToExactRational,
  subtractExactRational,
  type ExactRational,
} from "./exact-linear-algebra.js";
import { addRealStateValue, complexFromExact, exactRealStateValue } from "./exact-numeric-state.js";
import { meterStatuses, type MeterStatus } from "./meter-status.js";
import { circuitDocumentShapeIssue, copySimulationDocument, isSimulationRecord, simulationRecordEntries, simulationRecordField } from "./simulation-input.js";
import { readingPrecision, type CircuitReadingPrecision, type CircuitTerminalVoltageDifference } from "./circuit-reading.js";
import type { ExactExpressionNode } from "./exact-expression.js";

export type { CircuitExactComplex, CircuitExactRational, CircuitReadingPrecision, CircuitTerminalVoltageDifference } from "./circuit-reading.js";
export type { ExactExpressionNode, ExactExpressionReference } from "./exact-expression.js";

export type CircuitStatus = "empty" | "idle" | "open" | "closed" | "short" | "invalid";
export type CircuitIssueSeverity = "error" | "warning" | "info";

/** Maximum number of part terminals accepted by the dense nodal-analysis solver. */
export const MAX_CIRCUIT_ANALYSIS_TERMINALS = 512;

export interface CircuitIssue {
  severity: CircuitIssueSeverity;
  message: string;
  partId?: string;
}

export interface CircuitPartReading extends CircuitReadingPrecision {
  /** A−B voltage; BJT/MOS use A−C, op-amps use output−GND. AC values are RMS magnitudes. */
  voltageVolts: number;
  /** Current entering terminal A (op-amp: output C). Signed in DC; RMS magnitude in AC. */
  currentAmps: number;
  /**
   * Real power absorbed; sources active in the selected analysis mode report delivered power.
   * In AC analysis, a battery contributes only its passive internal resistance.
   */
  powerWatts: number;
  /** 0–1 brightness for bulbs (rated power) and DC LEDs (rated current). */
  brightness?: number;
  /** Present for AC analysis. Voltage/current values are then RMS magnitudes. */
  voltagePhaseDegrees?: number;
  currentPhaseDegrees?: number;
  /** Reactive power; positive means inductive absorption. */
  reactivePowerVars?: number;
  /** Terminal potentials relative to the reference, and currents entering the device. */
  terminalVoltages?: Partial<Record<CircuitTerminal, number>>;
  /** Local voltage differences for three-terminal parts, retained before display rounding. */
  terminalVoltageDifferences?: readonly CircuitTerminalVoltageDifference[];
  terminalCurrents?: Partial<Record<CircuitTerminal, number>>;
  /** AC terminal phasor angles, paired with the RMS terminal magnitudes. */
  terminalVoltagePhasesDegrees?: Partial<Record<CircuitTerminal, number>>;
  terminalCurrentPhasesDegrees?: Partial<Record<CircuitTerminal, number>>;
  /**
   * Measurement validity for ammeters and voltmeters. `unconnected` means a lead lacks a wire;
   * `floating` means the voltage reference is indeterminate or an ammeter current is bypassed.
   */
  meterStatus?: MeterStatus;
  /** Effective switch position used for this result, including analysis overrides. */
  switchClosed?: boolean;
  /** MOS channel has current or a nonzero incremental response; AC uses the DC bias state. */
  channelConducting?: boolean;
  /** AC terminal groups that share a voltage reference through the bias-point small-signal model. */
  acReferenceTerminalGroups?: readonly (readonly CircuitTerminal[])[];
  /** AC terminal groups coupled by nonzero terminal-current Jacobian entries. */
  acCurrentResponseTerminalGroups?: readonly (readonly CircuitTerminal[])[];
}

export interface CircuitAnalysisOptions {
  /** Auto chooses AC when the document contains an AC source, DC otherwise. */
  mode?: "auto" | "dc" | "ac";
  /** AC frequency; defaults to the first AC source's frequency, or 1 kHz. */
  frequencyHz?: number;
}

export interface CircuitAnalysis {
  status: CircuitStatus;
  /** Magnitude of current at the only independent source; null for multiple sources or unsolved circuits. */
  currentAmps: number | null;
  message: string;
  bulbPowerWatts: Record<string, number>;
  parts: Record<string, CircuitPartReading>;
  /** Signed current from → to. Only the legacy DC solver supplies wire-current estimates. */
  wireCurrents: Record<string, number>;
  issues: CircuitIssue[];
  mode?: "dc" | "ac";
  frequencyHz?: number;
  /** Present when these readings represent a transient sample rather than steady state. */
  timeSeconds?: number;
  /** Shared immutable expressions for exact transient readings; replace the whole table when editing. */
  precisionExpressions?: readonly ExactExpressionNode[];
}

/** Resistance used for wires, closed switches and ammeters, which are ideal conductors. */
const IDEAL_OHMS = 1e-6;
/** Below this external resistance a battery counts as short-circuited. */
const SHORT_OHMS = 1e-3;
const ROUNDING_GUARD = 4 * Number.EPSILON;
const OVERLOAD_RATIO = 1.5;

interface Conductance {
  a: number;
  b: number;
  g: number;
  resistanceOhms: number;
  exactResistance?: ExactRational;
  /** Present for the battery's internal resistance so loop checks can omit that source. */
  batteryId?: string;
  /** Open-circuit A−B voltage of a battery branch. */
  voltage?: number;
  exactVoltage?: ExactRational;
}


function result(
  status: CircuitStatus,
  message: string,
  extra: Partial<CircuitAnalysis> = {},
): CircuitAnalysis {
  return {
    status,
    message,
    currentAmps: status === "open" ? 0 : null,
    bulbPowerWatts: {},
    parts: {},
    wireCurrents: {},
    issues: [],
    ...extra,
  };
}

const positive = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0;

function documentWithCatalogDefaults(document: CircuitDocument): CircuitDocument {
  return {
    ...document,
    parts: document.parts.map((part) => {
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

function partValueIssue(part: CircuitPart): string | null {
  if (part.kind === "switch" && part.initiallyClosed !== undefined && typeof part.initiallyClosed !== "boolean") {
    return `${part.label}のスイッチ状態は真偽値にしてください。`;
  }
  if (part.kind === "battery") {
    if (!positive(part.voltageVolts)) { return `${part.label}の電圧は0より大きい数値にしてください。`; }
    const internal = part.internalResistanceOhms;
    if (internal === undefined || !Number.isFinite(internal) || internal < 0) {
      return `${part.label}の内部抵抗は0以上の数値にしてください。`;
    }
  }
  if ((part.kind === "resistor" || part.kind === "bulb") && !positive(part.resistanceOhms)) {
    return `${part.label}の抵抗値は0より大きい数値にしてください。`;
  }
  if (part.kind === "bulb" && part.ratedPowerWatts !== undefined && !positive(part.ratedPowerWatts)) {
    return `${part.label}の定格電力は0より大きい数値にしてください。`;
  }
  return null;
}

function documentIssue(document: CircuitDocument, switchStates: Record<string, boolean>): string | null {
  const ids = new Set(document.parts.map((part) => part.id));
  if (ids.size !== document.parts.length) { return "部品 ID が重複しています。"; }
  for (const part of document.parts) {
    const issue = partValueIssue(part);
    if (issue) { return issue; }
  }
  const kinds = new Map(document.parts.map((part) => [part.id, part.kind]));
  const stateIssue = switchStateIssue(switchStates, kinds);
  if (stateIssue) { return stateIssue; }
  const valid = (endpoint: CircuitEndpoint) => {
    const kind = kinds.get(endpoint.partId);
    return kind !== undefined && terminalsOf(kind).includes(endpoint.terminal);
  };
  const wireIds = new Set<string>();
  for (const wire of document.wires) {
    if (wireIds.has(wire.id)) { return "導線 ID が重複しています。"; }
    wireIds.add(wire.id);
    if (!valid(wire.from) || !valid(wire.to)) { return "導線の接続先を確認してください。"; }
    if (wire.from.partId === wire.to.partId && wire.from.terminal === wire.to.terminal) {
      return "同じ端子同士をつなぐ導線があります。";
    }
  }
  return null;
}

function switchStateIssue(value: unknown, kinds: Map<string, CircuitPart["kind"]>): string | null {
  if (!isSimulationRecord(value, kinds.keys())) {
    return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
  }
  for (const [partId, state] of simulationRecordEntries(value)) {
    if (kinds.get(partId) !== "switch") { return `スイッチ状態の対象「${partId}」はスイッチ部品ではありません。`; }
    if (typeof state !== "boolean") { return "スイッチ状態は部品 ID ごとの真偽値で指定してください。"; }
  }
  return null;
}

const key = ({ partId, terminal }: CircuitEndpoint) => `${partId}:${terminal}`;

function indexTerminals(parts: readonly CircuitPart[]) {
  const index = new Map<string, number>();
  for (const part of parts) {
    for (const terminal of terminalsOf(part.kind)) { index.set(`${part.id}:${terminal}`, index.size); }
  }
  return index;
}

function isClosed(part: CircuitPart, switchStates: Record<string, boolean>) {
  const override = Object.hasOwn(switchStates, part.id)
    ? switchStates[part.id]
    : undefined;
  return override ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
}

/** Ohms between the part's terminals, or null when no current can pass. */
function partOhms(part: CircuitPart, switchStates: Record<string, boolean>) {
  switch (part.kind) {
    case "resistor":
    case "bulb":
      return part.resistanceOhms ?? null;
    case "ammeter":
      return IDEAL_OHMS;
    case "switch":
      return isClosed(part, switchStates) ? IDEAL_OHMS : null;
    default:
      return null;
  }
}

function batteryOhms(part: CircuitPart) {
  return Math.max(part.internalResistanceOhms ?? 0, IDEAL_OHMS);
}

/** Builds the network: every terminal is a node, wires and parts are conductances. */
function buildNetwork(
  document: CircuitDocument,
  index: Map<string, number>,
  switchStates: Record<string, boolean>,
) {
  const conductances: Conductance[] = [];
  const node = (partId: string, terminal: "a" | "b") => index.get(`${partId}:${terminal}`) ?? -1;
  for (const wire of document.wires) {
    conductances.push({
      a: index.get(key(wire.from)) ?? -1,
      b: index.get(key(wire.to)) ?? -1,
      g: 1 / IDEAL_OHMS,
      resistanceOhms: IDEAL_OHMS,
    });
  }
  for (const part of document.parts) {
    if (part.kind === "battery") {
      // The branch follows I = (Va − Vb − Vsource) / Rinternal.
      const ohms = batteryOhms(part);
      const a = node(part.id, "a");
      const b = node(part.id, "b");
      conductances.push({ a, b, g: 1 / ohms, resistanceOhms: ohms, batteryId: part.id, voltage: part.voltageVolts });
      continue;
    }
    const ohms = partOhms(part, switchStates);
    if (ohms !== null) {
      conductances.push({ a: node(part.id, "a"), b: node(part.id, "b"), g: 1 / ohms, resistanceOhms: ohms });
    }
  }
  return conductances;
}

function findRoot(parent: number[], node: number): number {
  let root = node;
  while (parent[root] !== root) { root = parent[root]; }
  parent[node] = root;
  return root;
}

/** Finds the connected group for every terminal in the conductance graph. */
function conductiveComponents(size: number, conductances: readonly Conductance[]) {
  const parent = Array.from({ length: size }, (_, index) => index);
  for (const { a, b } of conductances) { parent[findRoot(parent, a)] = findRoot(parent, b); }
  return parent.map((_, node) => findRoot(parent, node));
}

interface SourceConstraintEdge {
  from: number;
  to: number;
  /** V(to) − V(from) when the ideal source constraints are consistent. */
  voltage: number;
}

interface SourceConstraintTree {
  parent: number[];
  depth: number[];
  offset: number[];
  component: number[];
  inconsistent: Set<number>;
}

function sourceConstraintEdges(
  document: CircuitDocument,
  index: Map<string, number>,
  switchStates: Record<string, boolean>,
): SourceConstraintEdge[] {
  const edges: SourceConstraintEdge[] = document.wires.map((wire) => ({
    from: index.get(key(wire.from)) ?? -1,
    to: index.get(key(wire.to)) ?? -1,
    voltage: 0,
  }));
  for (const part of document.parts) {
    if (part.kind === "battery") {
      edges.push({
        from: index.get(`${part.id}:a`) ?? -1,
        to: index.get(`${part.id}:b`) ?? -1,
        voltage: -(part.voltageVolts ?? 0),
      });
    } else if (part.kind === "ammeter" || (part.kind === "switch" && isClosed(part, switchStates))) {
      edges.push({
        from: index.get(`${part.id}:a`) ?? -1,
        to: index.get(`${part.id}:b`) ?? -1,
        voltage: 0,
      });
    }
  }
  return edges;
}

function sourceVoltageDifference(tree: SourceConstraintTree, from: number, to: number) {
  let a = from;
  let b = to;
  let value = 0;
  let correction = 0;
  let scale = 0;
  const add = (term: number) => {
    const next = value + term;
    correction += Math.abs(value) >= Math.abs(term) ? (value - next) + term : (term - next) + value;
    value = next;
    scale += Math.abs(term);
  };
  while (a !== b) {
    if ((tree.depth[a] ?? -1) >= (tree.depth[b] ?? -1)) {
      if (tree.parent[a] !== -1) { add(tree.offset[a] ?? 0); }
      a = tree.parent[a] ?? -1;
    } else {
      if (tree.parent[b] !== -1) { add(-(tree.offset[b] ?? 0)); }
      b = tree.parent[b] ?? -1;
    }
  }
  return { value: value + correction, scale };
}

function sourceConstraintTree(
  size: number,
  edges: readonly SourceConstraintEdge[],
): SourceConstraintTree {
  const adjacent = Array.from({ length: size }, () => [] as { node: number; voltage: number }[]);
  for (const edge of edges) {
    adjacent[edge.from]?.push({ node: edge.to, voltage: edge.voltage });
    adjacent[edge.to]?.push({ node: edge.from, voltage: -edge.voltage });
  }
  const parent = Array.from({ length: size }, () => -1);
  const depth = Array.from({ length: size }, () => 0);
  const offset = Array.from({ length: size }, () => 0);
  const component = Array.from({ length: size }, () => -1);
  for (let root = 0; root < size; root += 1) {
    if (component[root] !== -1) { continue; }
    component[root] = root;
    const pending = [root];
    for (const node of pending) {
      for (const edge of adjacent[node] ?? []) {
        if (component[edge.node] !== -1) { continue; }
        component[edge.node] = root;
        parent[edge.node] = node;
        depth[edge.node] = depth[node] + 1;
        offset[edge.node] = edge.voltage;
        pending.push(edge.node);
      }
    }
  }
  const tree = { parent, depth, offset, component, inconsistent: new Set<number>() };
  for (const edge of edges) {
    const difference = sourceVoltageDifference(tree, edge.from, edge.to);
    const residual = difference.value + edge.voltage;
    const uncertainty = ROUNDING_GUARD * (difference.scale + Math.abs(edge.voltage));
    if (Math.abs(residual) > uncertainty) {
      const group = component[edge.from];
      if (group !== undefined) { tree.inconsistent.add(group); }
    }
  }
  return tree;
}

/** Groups terminals joined by zero-voltage constraints, excluding battery edges. */
function zeroVoltageSourceRails(size: number, edges: readonly SourceConstraintEdge[]) {
  const parent = Array.from({ length: size }, (_, node) => node);
  for (const edge of edges) {
    if (edge.voltage !== 0) { continue; }
    parent[findRoot(parent, edge.from)] = findRoot(parent, edge.to);
  }
  return parent.map((_, node) => findRoot(parent, node));
}

interface PassiveNeighbor {
  node: number;
  resistance: number;
}

interface DistanceEntry {
  node: number;
  distance: number;
}

function pushDistance(heap: DistanceEntry[], entry: DistanceEntry) {
  let index = heap.length;
  heap.push(entry);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if ((heap[parent]?.distance ?? Number.POSITIVE_INFINITY) <= entry.distance) { break; }
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = entry;
}

function popDistance(heap: DistanceEntry[]) {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last) { return first; }
  if (heap.length === 0) { return first; }
  let index = 0;
  while (index < heap.length) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) { break; }
    const child = right < heap.length &&
      (heap[right]?.distance ?? Number.POSITIVE_INFINITY) <
      (heap[left]?.distance ?? Number.POSITIVE_INFINITY)
      ? right
      : left;
    if ((heap[child]?.distance ?? Number.POSITIVE_INFINITY) >= last.distance) { break; }
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

function passiveAdjacency(size: number, conductances: readonly Conductance[]) {
  const adjacent = Array.from({ length: size }, () => [] as PassiveNeighbor[]);
  for (const { a, b, resistanceOhms: resistance, batteryId } of conductances) {
    if (batteryId !== undefined) { continue; }
    adjacent[a]?.push({ node: b, resistance });
    adjacent[b]?.push({ node: a, resistance });
  }
  return adjacent;
}

function shortestPassiveResistances(adjacent: readonly PassiveNeighbor[][], start: number) {
  const distances = Array.from({ length: adjacent.length }, () => Number.POSITIVE_INFINITY);
  const heap: DistanceEntry[] = [];
  distances[start] = 0;
  pushDistance(heap, { node: start, distance: 0 });
  while (heap.length > 0) {
    const current = popDistance(heap);
    if (!current || current.distance !== distances[current.node]) { continue; }
    for (const edge of adjacent[current.node] ?? []) {
      const distance = current.distance + edge.resistance;
      if (distance >= (distances[edge.node] ?? Number.POSITIVE_INFINITY)) { continue; }
      distances[edge.node] = distance;
      pushDistance(heap, { node: edge.node, distance });
    }
  }
  return distances;
}

/** Whether a battery's terminals are joined by a conductive path outside that battery. */
function hasExternalBatteryPath(
  size: number,
  conductances: readonly Conductance[],
  batteryId: string,
  start: number,
  goal: number,
) {
  const adjacent = Array.from({ length: size }, () => [] as number[]);
  for (const { a, b, batteryId: edgeBatteryId } of conductances) {
    if (edgeBatteryId === batteryId) { continue; }
    adjacent[a]?.push(b);
    adjacent[b]?.push(a);
  }
  const visited = new Set<number>([start]);
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === goal) { return true; }
    for (const next of adjacent[node ?? -1] ?? []) {
      if (visited.has(next)) { continue; }
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}

const EXACT_ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const EXACT_ONE: ExactRational = { numerator: 1n, denominator: 1n };

function exactInput(value: number) {
  return numberToExactRational(value);
}

function negateExact(value: ExactRational): ExactRational {
  return { numerator: -value.numerator, denominator: value.denominator };
}

function nodalUnknownIndices(size: number, conductances: readonly Conductance[]) {
  const components = conductiveComponents(size, conductances);
  const references = new Set(components);
  const unknownByNode = Array.from({ length: size }, () => -1);
  let count = 0;
  for (let node = 0; node < size; node += 1) {
    if (!references.has(node)) { unknownByNode[node] = count++; }
  }
  return { unknownByNode, count };
}

function stampConductanceBranch(
  matrix: Float64Array,
  rhs: Float64Array,
  count: number,
  unknownByNode: readonly number[],
  branch: Conductance,
) {
  const resistance = branch.exactResistance ?? exactInput(branch.resistanceOhms);
  const conductance = resistance && divideExactRational(EXACT_ONE, resistance);
  const sourceVoltage = branch.exactVoltage ?? exactInput(branch.voltage ?? 0);
  if (!conductance || !sourceVoltage) { return false; }

  const a = unknownByNode[branch.a] ?? -1;
  const b = unknownByNode[branch.b] ?? -1;
  if (a >= 0) { addRealStateValue(matrix, a * count + a, conductance); }
  if (b >= 0) { addRealStateValue(matrix, b * count + b, conductance); }
  if (a >= 0 && b >= 0) {
    const offDiagonal = negateExact(conductance);
    addRealStateValue(matrix, a * count + b, offDiagonal);
    addRealStateValue(matrix, b * count + a, offDiagonal);
  }

  if (sourceVoltage.numerator !== 0n) {
    const sourceTerm = multiplyExactRational(conductance, sourceVoltage);
    if (a >= 0) { addRealStateValue(rhs, a, sourceTerm); }
    if (b >= 0) { addRealStateValue(rhs, b, negateExact(sourceTerm)); }
  }
  return true;
}

function stampCurrentSource(
  rhs: Float64Array,
  unknownByNode: readonly number[],
  source: { from: number; to: number; amps: number },
) {
  const amps = exactInput(source.amps);
  if (!amps) { return false; }
  const from = unknownByNode[source.from] ?? -1;
  const to = unknownByNode[source.to] ?? -1;
  if (from >= 0) { addRealStateValue(rhs, from, amps); }
  if (to >= 0) { addRealStateValue(rhs, to, negateExact(amps)); }
  return true;
}

function exactNodeDifference(
  exactVoltages: readonly ExactRational[],
  from: number,
  to: number,
  offset: number,
) {
  const exactOffset = exactInput(offset);
  if (!exactOffset) { return { value: Number.NaN, scale: Number.NaN }; }
  const exactDifference = subtractExactRational(
    subtractExactRational(exactVoltages[from] ?? EXACT_ZERO, exactVoltages[to] ?? EXACT_ZERO),
    exactOffset,
  );
  const value = exactRationalToNumber(exactDifference);
  return { value, scale: Math.abs(value), valueExact: exactDifference };
}

/** Solve conductance nodal equations with one exact reference per component. */
function nodeVoltages(
  size: number,
  conductances: readonly Conductance[],
  currentSource?: { from: number; to: number; amps: number },
) {
  const { unknownByNode, count } = nodalUnknownIndices(size, conductances);
  const matrix = new Float64Array(count * count);
  const rhs = new Float64Array(count);
  for (const branch of conductances) {
    if (!stampConductanceBranch(matrix, rhs, count, unknownByNode, branch)) { return null; }
  }
  if (currentSource && !stampCurrentSource(rhs, unknownByNode, currentSource)) { return null; }
  const solution = solveRealLinearSystem(count, matrix, rhs);
  if (!solution) { return null; }
  const exactVoltages = Array.from({ length: size }, () => EXACT_ZERO);
  for (let node = 0; node < size; node += 1) {
    const unknown = unknownByNode[node] ?? -1;
    if (unknown >= 0) {
      const value = exactRealStateValue(solution, unknown);
      if (!value) { return null; }
      exactVoltages[node] = value;
    }
  }
  const voltages = exactVoltages.map(exactRationalToNumber);
  if (!voltages.every(Number.isFinite)) { return null; }
  return {
    voltages,
    exactVoltages,
    difference: (from: number, to: number, offset = 0) =>
      exactNodeDifference(exactVoltages, from, to, offset),
  };
}

/** Equivalent resistance of the passive network between two terminals. */
function externalResistanceExact(
  nodes: readonly number[],
  conductances: readonly Conductance[],
  from: number,
  to: number,
) {
  const localIndex = new Map(nodes.map((node, local) => [node, local]));
  const localFrom = localIndex.get(from);
  const localTo = localIndex.get(to);
  if (localFrom === undefined || localTo === undefined) { return null; }
  if (localFrom === localTo) { return EXACT_ZERO; }
  const localConductances: Conductance[] = [];
  for (const edge of conductances) {
    const a = localIndex.get(edge.a);
    const b = localIndex.get(edge.b);
    if (a !== undefined && b !== undefined) { localConductances.push({ ...edge, a, b }); }
  }
  const solved = nodeVoltages(nodes.length, localConductances, {
    from: localFrom,
    to: localTo,
    amps: 1,
  });
  if (!solved) { return null; }
  const resistance = exactDifferenceValue(solved.difference(localFrom, localTo));
  return resistance && resistance.numerator >= 0n ? resistance : null;
}

function externalResistance(nodes: readonly number[], conductances: readonly Conductance[], from: number, to: number) {
  const exact = externalResistanceExact(nodes, conductances, from, to);
  if (!exact) { return null; }
  const resistance = exactRationalToNumber(exact);
  return Number.isFinite(resistance) ? resistance : null;
}

interface VoltageDifference {
  value: number;
  scale: number;
  valueExact?: ExactRational;
}

function exactDifferenceValue(difference: VoltageDifference) {
  return difference.valueExact ?? exactInput(difference.value);
}

function exactDifferenceQuotient(difference: VoltageDifference, denominator: number) {
  const numerator = exactDifferenceValue(difference);
  const exactDenominator = exactInput(denominator);
  return numerator && exactDenominator ? divideExactRational(numerator, exactDenominator) : null;
}

function readPart(
  part: CircuitPart,
  voltageDrop: VoltageDifference,
  currentDrop: VoltageDifference,
  switchStates: Record<string, boolean>,
): CircuitPartReading {
  const voltageVolts = voltageDrop.value;
  const ohms = part.kind === "battery" ? batteryOhms(part) : partOhms(part, switchStates);
  const currentExact = ohms === null ? EXACT_ZERO : exactDifferenceQuotient(currentDrop, ohms);
  const currentAmps = ohms === null
    ? 0
    : currentExact
      ? exactRationalToNumber(currentExact)
      : currentDrop.value / ohms;
  const voltageExact = exactDifferenceValue(voltageDrop);
  const absorbsPower = part.kind === "resistor" || part.kind === "bulb";
  const deliversPower = part.kind === "battery";
  let powerWatts = 0;
  if ((absorbsPower || deliversPower) && voltageExact && currentExact) {
    const exactPower = multiplyExactRational(voltageExact, currentExact);
    powerWatts = exactRationalToNumber(deliversPower ? negateExact(exactPower) : exactPower);
  } else if (absorbsPower || deliversPower) {
    powerWatts = voltageVolts * currentAmps * (deliversPower ? -1 : 1);
  }
  if (part.kind !== "bulb") { return { voltageVolts, currentAmps, powerWatts }; }
  const rated = part.ratedPowerWatts ?? 2;
  return { voltageVolts, currentAmps, powerWatts, brightness: Math.min(1, powerWatts / rated) };
}

function tidy(value: number, uncertainty = 0) {
  return value === 0 || (Number.isFinite(value) && Number.isFinite(uncertainty) && Math.abs(value) <= uncertainty)
    ? 0
    : value;
}

function setRecordValue<T>(record: Record<string, T>, property: string, value: T) {
  Object.defineProperty(record, property, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function legacyReadingPrecision(
  part: CircuitPart,
  index: Map<string, number>,
  exactVoltages: readonly ExactRational[],
  drop: VoltageDifference,
  currentDrop: VoltageDifference,
  ohms: number | null,
) {
  const currentExact = ohms === null ? EXACT_ZERO : exactDifferenceQuotient(currentDrop, ohms) ?? EXACT_ZERO;
  const realComplex = (value: ExactRational) => complexFromExact({ real: value, imaginary: EXACT_ZERO });
  return readingPrecision({
    voltage: realComplex(exactDifferenceValue(drop) ?? EXACT_ZERO),
    terminalVoltages: Object.fromEntries(terminalsOf(part.kind).map((terminal) =>
      [terminal, realComplex(exactVoltages[index.get(`${part.id}:${terminal}`)!] ?? EXACT_ZERO)])),
    terminalCurrents: part.kind === "junction" ? { a: realComplex(EXACT_ZERO) }
      : { a: realComplex(currentExact), b: realComplex(negateExact(currentExact)) },
  });
}

function readAll(
  document: CircuitDocument,
  index: Map<string, number>,
  solved: NonNullable<ReturnType<typeof nodeVoltages>>,
  switchStates: Record<string, boolean>,
) {
  const { voltages, difference } = solved;
  const meterStatusByPart = meterStatuses(document, { mode: "dc", switchStates });
  const voltage = (partId: string, terminal: CircuitTerminal) =>
    voltages[index.get(`${partId}:${terminal}`) ?? -1] ?? 0;
  const parts: Record<string, CircuitPartReading> = {};
  for (const part of document.parts) {
    const drop = part.kind === "junction" ? { value: 0, scale: 0 }
      : difference(index.get(`${part.id}:a`)!, index.get(`${part.id}:b`)!);
    const currentDrop = part.kind === "battery"
      ? difference(index.get(`${part.id}:a`)!, index.get(`${part.id}:b`)!, part.voltageVolts) : drop;
    const ohms = part.kind === "battery" ? batteryOhms(part) : partOhms(part, switchStates);
    const currentUncertainty = ohms === null
      ? 0
      : ROUNDING_GUARD * currentDrop.scale / ohms;
    const reading = readPart(part, drop, currentDrop, switchStates);
    const precision = legacyReadingPrecision(part, index, solved.exactVoltages, drop, currentDrop, ohms);
    const voltageUncertainty = ROUNDING_GUARD * drop.scale;
    const currentAmps = tidy(reading.currentAmps, currentUncertainty);
    setRecordValue(parts, part.id, {
      ...reading,
      ...precision,
      terminalVoltages: Object.fromEntries(terminalsOf(part.kind).map((terminal) => [terminal, voltage(part.id, terminal)])),
      terminalCurrents: part.kind === "junction" ? { a: 0 } : { a: currentAmps, b: -currentAmps },
      ...(meterStatusByPart[part.id] ? { meterStatus: meterStatusByPart[part.id] } : {}),
      ...(part.kind === "switch" ? { switchClosed: isClosed(part, switchStates) } : {}),
      voltageVolts: tidy(reading.voltageVolts, voltageUncertainty),
      currentAmps,
      powerWatts: tidy(
        reading.powerWatts,
        Math.abs(reading.voltageVolts) * currentUncertainty +
          Math.abs(reading.currentAmps) * voltageUncertainty,
      ),
    });
  }
  const wireCurrents: Record<string, number> = {};
  for (const wire of document.wires) {
    const drop = difference(index.get(key(wire.from))!, index.get(key(wire.to))!);
    const currentUncertainty = ROUNDING_GUARD * drop.scale / IDEAL_OHMS;
    const current = exactDifferenceQuotient(drop, IDEAL_OHMS);
    setRecordValue(
      wireCurrents,
      wire.id,
      tidy(current ? exactRationalToNumber(current) : drop.value / IDEAL_OHMS, currentUncertainty),
    );
  }
  return { parts, wireCurrents };
}

function hasOnlyFiniteReadings(
  parts: Record<string, CircuitPartReading>,
  wireCurrents: Record<string, number>,
) {
  for (const reading of Object.values(parts)) {
    const values = [
      reading.voltageVolts,
      reading.currentAmps,
      reading.powerWatts,
      reading.brightness,
      reading.voltagePhaseDegrees,
      reading.currentPhaseDegrees,
      reading.reactivePowerVars,
      ...Object.values(reading.terminalVoltages ?? {}),
      ...Object.values(reading.terminalCurrents ?? {}),
      ...Object.values(reading.terminalVoltagePhasesDegrees ?? {}),
      ...Object.values(reading.terminalCurrentPhasesDegrees ?? {}),
    ];
    if (values.some((value) => value !== undefined && !Number.isFinite(value))) { return false; }
  }
  return Object.values(wireCurrents).every(Number.isFinite);
}

function batteriesBySourceGroup(
  batteries: readonly CircuitPart[],
  sourceTree: SourceConstraintTree,
  index: Map<string, number>,
) {
  const groups = new Map<number, CircuitPart[]>();
  for (const battery of batteries) {
    const terminal = index.get(`${battery.id}:a`);
    const group = terminal === undefined ? undefined : sourceTree.component[terminal];
    if (group === undefined) { continue; }
    const groupBatteries = groups.get(group) ?? [];
    groupBatteries.push(battery);
    groups.set(group, groupBatteries);
  }
  return groups;
}

interface ExactBatteryReading {
  voltage: ExactRational;
  current: ExactRational;
}

function exactBatteryReadings(
  batteries: readonly CircuitPart[],
  index: Map<string, number>,
  solved: NonNullable<ReturnType<typeof nodeVoltages>>,
) {
  const readings = new Map<string, ExactBatteryReading>();
  for (const battery of batteries) {
    const a = index.get(`${battery.id}:a`);
    const b = index.get(`${battery.id}:b`);
    if (a === undefined || b === undefined) { continue; }
    const voltage = exactDifferenceValue(solved.difference(a, b));
    const current = exactDifferenceQuotient(
      solved.difference(a, b, battery.voltageVolts), batteryOhms(battery),
    );
    if (voltage && current) { readings.set(battery.id, { voltage, current }); }
  }
  return readings;
}

function shortedBatteryByTerminalRatio(
  batteries: readonly CircuitPart[],
  readings: Map<string, ExactBatteryReading>,
  sourceTree: SourceConstraintTree,
  batteriesByGroup: Map<number, CircuitPart[]>,
  index: Map<string, number>,
  protectedBatteryIds: Set<string>,
) {
  const threshold = exactInput(SHORT_OHMS);
  if (!threshold) { return; }
  return batteries.find((battery) => {
    if (protectedBatteryIds.has(battery.id)) { return false; }
    const terminal = index.get(`${battery.id}:a`);
    const group = terminal === undefined ? undefined : sourceTree.component[terminal];
    const groupBatteries = group === undefined ? undefined : batteriesByGroup.get(group);
    if (group !== undefined && groupBatteries && groupBatteries.length > 1 &&
      !sourceTree.inconsistent.has(group)) {
      return false;
    }
    const reading = readings.get(battery.id);
    if (!reading || reading.current.numerator === 0n) { return false; }
    const voltage = reading.voltage.numerator < 0n ? negateExact(reading.voltage) : reading.voltage;
    const current = reading.current.numerator < 0n ? negateExact(reading.current) : reading.current;
    // Compare |V| < |I| R before rounding either reading for display.
    return subtractExactRational(voltage, multiplyExactRational(current, threshold)).numerator < 0n;
  });
}

function addBatteryTerminalToPassiveGroup(
  battery: CircuitPart,
  sourceGroup: number,
  passiveComponents: number[],
  index: Map<string, number>,
  protectedBatteryIds: Set<string>,
  groups: Map<string, { sourceGroup: number; passiveGroup: number; nodes: number[] }>,
) {
  if (protectedBatteryIds.has(battery.id)) { return; }
  for (const terminal of ["a", "b"] as const) {
    const node = index.get(`${battery.id}:${terminal}`);
    const passiveGroup = node === undefined ? undefined : passiveComponents[node];
    if (node === undefined || passiveGroup === undefined) { continue; }
    const sourcePassiveKey = `${sourceGroup}:${passiveGroup}`;
    const group = groups.get(sourcePassiveKey) ?? { sourceGroup, passiveGroup, nodes: [] };
    group.nodes.push(node);
    groups.set(sourcePassiveKey, group);
  }
}

function sourcePassiveNodeGroups(
  sourceTree: SourceConstraintTree,
  batteriesByGroup: Map<number, CircuitPart[]>,
  passiveComponents: number[],
  index: Map<string, number>,
  protectedBatteryIds: Set<string>,
) {
  const groups = new Map<string, { sourceGroup: number; passiveGroup: number; nodes: number[] }>();
  for (const [sourceGroup, groupBatteries] of batteriesByGroup) {
    if (groupBatteries.length < 2 || sourceTree.inconsistent.has(sourceGroup)) { continue; }
    for (const battery of groupBatteries) {
      addBatteryTerminalToPassiveGroup(
        battery,
        sourceGroup,
        passiveComponents,
        index,
        protectedBatteryIds,
        groups,
      );
    }
  }
  return groups;
}

function passiveComponentsByNode(size: number, passive: readonly Conductance[]) {
  const components = conductiveComponents(size, passive);
  const nodesByComponent = new Map<number, number[]>();
  for (let node = 0; node < size; node += 1) {
    const component = components[node];
    if (component === undefined) { continue; }
    const nodes = nodesByComponent.get(component) ?? [];
    nodes.push(node);
    nodesByComponent.set(component, nodes);
  }
  const conductancesByComponent = new Map<number, Conductance[]>();
  for (const edge of passive) {
    const component = components[edge.a];
    if (component === undefined || component !== components[edge.b]) { continue; }
    const edges = conductancesByComponent.get(component) ?? [];
    edges.push(edge);
    conductancesByComponent.set(component, edges);
  }
  return { components, nodesByComponent, conductancesByComponent };
}

interface PassiveBatteryEdge {
  battery: CircuitPart;
  fromComponent: number;
  toComponent: number;
  fromNode: number;
  toNode: number;
  emf?: ExactRational;
  seriesResistance?: number;
  exactSeriesResistance?: ExactRational;
}

function batteryEdgesByPassiveComponent(
  batteries: readonly CircuitPart[],
  index: Map<string, number>,
  passiveComponents: number[],
) {
  const edges: PassiveBatteryEdge[] = [];
  const incidentEdges = new Map<number, number[]>();
  for (const battery of batteries) {
    const fromNode = index.get(`${battery.id}:a`);
    const toNode = index.get(`${battery.id}:b`);
    const fromComponent = fromNode === undefined ? undefined : passiveComponents[fromNode];
    const toComponent = toNode === undefined ? undefined : passiveComponents[toNode];
    if (fromNode === undefined || toNode === undefined ||
      fromComponent === undefined || toComponent === undefined) {
      continue;
    }
    const edgeIndex = edges.length;
    edges.push({ battery, fromComponent, toComponent, fromNode, toNode });
    for (const component of [fromComponent, toComponent]) {
      const incident = incidentEdges.get(component) ?? [];
      incident.push(edgeIndex);
      incidentEdges.set(component, incident);
    }
  }
  return { edges, incidentEdges };
}

interface BatteryBlockSearch {
  edges: readonly PassiveBatteryEdge[];
  incidentEdges: Map<number, number[]>;
  discovered: Map<number, number>;
  low: Map<number, number>;
  stack: number[];
  cycles: PassiveBatteryEdge[][];
}

function recordBatteryCycle(search: BatteryBlockSearch, lastEdge: number) {
  const loop: PassiveBatteryEdge[] = [];
  while (search.stack.length > 0) {
    const edgeIndex = search.stack.pop();
    const edge = edgeIndex === undefined ? undefined : search.edges[edgeIndex];
    if (!edge) { break; }
    loop.push(edge);
    if (edgeIndex === lastEdge) { break; }
  }
  if (loop.length >= 2) {
    search.cycles.push(loop);
  }
}

function visitBatteryBlocks(search: BatteryBlockSearch, component: number, parentEdge: number) {
  const order = search.discovered.size;
  search.discovered.set(component, order);
  search.low.set(component, order);
  for (const edgeIndex of search.incidentEdges.get(component) ?? []) {
    if (edgeIndex === parentEdge) { continue; }
    const edge = search.edges[edgeIndex];
    if (!edge) { continue; }
    const next = edge.fromComponent === component ? edge.toComponent : edge.fromComponent;
    // A source wholly inside one passive component is handled by the ordinary
    // load test, rather than being part of a multi-source series cycle.
    if (next === component) { continue; }
    const nextOrder = search.discovered.get(next);
    if (nextOrder === undefined) {
      search.stack.push(edgeIndex);
      visitBatteryBlocks(search, next, edgeIndex);
      const nextLow = search.low.get(next) ?? order;
      search.low.set(component, Math.min(search.low.get(component) ?? order, nextLow));
      if (nextLow >= order) { recordBatteryCycle(search, edgeIndex); }
    } else if (nextOrder < order) {
      search.stack.push(edgeIndex);
      search.low.set(component, Math.min(search.low.get(component) ?? order, nextOrder));
    }
  }
}

function batteryCycleGroups(
  edges: readonly PassiveBatteryEdge[],
  incidentEdges: Map<number, number[]>,
) {
  // Biconnected blocks separate cycles at shared junctions and discard open
  // branches. Removing only leaves would miss a figure-eight's two valid loops.
  const search: BatteryBlockSearch = {
    edges,
    incidentEdges,
    discovered: new Map(),
    low: new Map(),
    stack: [],
    cycles: [],
  };
  for (const component of incidentEdges.keys()) {
    if (!search.discovered.has(component)) { visitBatteryBlocks(search, component, -1); }
  }
  return search.cycles;
}

function seriesLoopExternalResistance(
  loop: readonly PassiveBatteryEdge[],
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  const terminalsByComponent = new Map<number, number[]>();
  for (const edge of loop) {
    const fromTerminals = terminalsByComponent.get(edge.fromComponent) ?? [];
    fromTerminals.push(edge.fromNode);
    terminalsByComponent.set(edge.fromComponent, fromTerminals);
    const toTerminals = terminalsByComponent.get(edge.toComponent) ?? [];
    toTerminals.push(edge.toNode);
    terminalsByComponent.set(edge.toComponent, toTerminals);
  }
  let totalResistance = EXACT_ZERO;
  for (const [component, terminals] of terminalsByComponent) {
    if (terminals.length !== 2) { return null; }
    const nodes = nodesByComponent.get(component);
    const conductances = conductancesByComponent.get(component) ?? [];
    const from = terminals[0];
    const to = terminals[1];
    if (!nodes || from === undefined || to === undefined) { return null; }
    const resistance = externalResistanceExact(nodes, conductances, from, to);
    if (resistance === null) { return null; }
    totalResistance = subtractExactRational(totalResistance, negateExact(resistance));
  }
  return totalResistance;
}

interface BatteryCycleNeighbor extends PassiveNeighbor {
  batteryId?: string;
  voltage?: number;
  exactResistance?: ExactRational;
}

interface ParallelBatteryGroup {
  edges: PassiveBatteryEdge[];
  fromNodes: number[];
  toNodes: number[];
}

function parallelBatteryGroups(block: readonly PassiveBatteryEdge[]) {
  const first = block[0];
  if (!first) { return null; }
  const groups = new Map<string, ParallelBatteryGroup>();
  for (const edge of block) {
    const forward = edge.fromComponent === first.fromComponent && edge.toComponent === first.toComponent;
    const reverse = edge.toComponent === first.fromComponent && edge.fromComponent === first.toComponent;
    if (!forward && !reverse) { return null; }
    const emf = edge.emf ?? exactInput(edge.battery.voltageVolts ?? 0)!;
    const voltage = forward ? emf : negateExact(emf);
    const voltageKey = `${voltage.numerator}/${voltage.denominator}`;
    const group = groups.get(voltageKey) ?? { edges: [], fromNodes: [], toNodes: [] };
    group.edges.push(edge);
    group.fromNodes.push(forward ? edge.fromNode : edge.toNode);
    group.toNodes.push(forward ? edge.toNode : edge.fromNode);
    groups.set(voltageKey, group);
  }
  return { groups: [...groups.values()], fromComponent: first.fromComponent, toComponent: first.toComponent };
}

function batteryGroupExternalResistance(
  size: number,
  conductances: readonly Conductance[],
  first: ParallelBatteryGroup,
  second: ParallelBatteryGroup,
) {
  return batteryCycleExternalResistance(size, conductances, [first, second]);
}

function batteryCycleExternalResistance(
  size: number,
  conductances: readonly Conductance[],
  groups: readonly ParallelBatteryGroup[],
) {
  const totalSize = size + groups.reduce((count, group) => count + group.edges.length, 0);
  const parent = Array.from({ length: totalSize }, (_, node) => node);
  const offsets = Array.from({ length: totalSize }, () => 0);
  const branches = [...conductances];
  let virtualNode = size;
  for (const [groupIndex, group] of groups.entries()) {
    for (const [position, edge] of group.edges.entries()) {
      const from = group.fromNodes[position]!;
      const to = group.toNodes[position]!;
      const exactResistance = edge.exactSeriesResistance ?? EXACT_ZERO;
      let positiveNode = from;
      if (exactResistance.numerator > 0n) {
        const resistanceOhms = exactRationalToNumber(exactResistance);
        positiveNode = virtualNode++;
        branches.push({ a: from, b: positiveNode, g: 1 / resistanceOhms, resistanceOhms, exactResistance });
      }
      // Keep each source's two ports paired. A unit EMF difference between
      // groups becomes a fixed offset inside each contracted source branch.
      parent[positiveNode] = to;
      offsets[positiveNode] = groupIndex === 0 ? 1 : 0;
    }
  }
  const collapsed = branches.map((edge) => ({
    ...edge, a: findRoot(parent, edge.a), b: findRoot(parent, edge.b),
    voltage: offsets[edge.b]! - offsets[edge.a]!,
  }));
  const power = passiveNetworkPower(totalSize, collapsed);
  // For a unit drive, dissipated power is the group current, hence R=1/P.
  return power && power.numerator > 0n ? divideExactRational(EXACT_ONE, power) : null;
}

function passiveNetworkPower(size: number, conductances: readonly Conductance[]) {
  const solved = nodeVoltages(size, conductances);
  if (!solved) { return null; }
  let power = EXACT_ZERO;
  for (const edge of conductances) {
    const difference = exactDifferenceValue(solved.difference(edge.a, edge.b));
    const sourceVoltage = edge.exactVoltage ?? exactInput(edge.voltage ?? 0);
    const drop = difference && sourceVoltage && subtractExactRational(difference, sourceVoltage);
    const resistance = edge.exactResistance ?? exactInput(edge.resistanceOhms);
    const current = drop && resistance && divideExactRational(drop, resistance);
    if (!drop || !current) { return null; }
    power = subtractExactRational(power, negateExact(multiplyExactRational(drop, current)));
  }
  return power;
}

function shortedParallelBatteryGroup(
  parallel: NonNullable<ReturnType<typeof parallelBatteryGroups>>,
  readings: Map<string, ExactBatteryReading>,
  size: number,
  conductancesByComponent: Map<number, Conductance[]>,
  physicalConductances?: readonly Conductance[],
) {
  for (const [position, first] of parallel.groups.entries()) {
    for (const second of parallel.groups.slice(position + 1)) {
      const flowing = [...first.edges, ...second.edges].find((edge) =>
        (readings.get(edge.battery.id)?.current.numerator ?? 0n) !== 0n,
      );
      if (!flowing) { continue; }
      const resistance = parallelGroupResistanceBound(size, [
        ...conductancesByComponent.get(parallel.fromComponent) ?? [],
        ...conductancesByComponent.get(parallel.toComponent) ?? [],
      ], first, second, parallel.fromComponent, physicalConductances);
      if (resistance !== null &&
          subtractExactRational(exactInput(SHORT_OHMS)!, resistance).numerator > 0n) {
        return flowing.battery;
      }
    }
  }
}

function parallelGroupResistanceBound(size: number, conductances: readonly Conductance[], first: ParallelBatteryGroup, second: ParallelBatteryGroup, fromComponent: number, physical?: readonly Conductance[]) {
  let resistance = batteryGroupExternalResistance(size, conductances, first, second);
  if (!physical || [...first.edges, ...second.edges].some((edge) => (edge.exactSeriesResistance?.numerator ?? 0n) !== 0n)) { return resistance; }
  const voltage = (group: ParallelBatteryGroup) => {
    const edge = group.edges[0]!;
    const emf = edge.emf ?? exactInput(edge.battery.voltageVolts ?? 0)!;
    return edge.fromComponent === fromComponent ? emf : negateExact(emf);
  };
  // A common load on parallel cells must not erase their circulating short.
  // Series/opposing-source groups retain their existing normalized group test.
  if (voltage(first).numerator * voltage(second).numerator < 0n) { return resistance; }
  for (const [drive, returned] of [[first, second], [second, first]]) {
    const physicalResistance = batteryGroupExternalResistance(size, physical, drive!, returned!);
    if (physicalResistance !== null && (resistance === null || subtractExactRational(physicalResistance, resistance).numerator < 0n)) {
      resistance = physicalResistance;
    }
  }
  return resistance;
}

function seriesBatteryPath(
  edges: readonly PassiveBatteryEdge[],
  incident: Map<number, number[]>,
  startComponent: number,
  firstEdge: number,
  visited: Set<number>,
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  let component = startComponent;
  let edgeIndex = firstEdge;
  let emf = EXACT_ZERO;
  let exactSeriesResistance = EXACT_ZERO;
  const first = edges[firstEdge]!;
  const fromNode = first.fromComponent === startComponent ? first.fromNode : first.toNode;
  while (!visited.has(edgeIndex)) {
    visited.add(edgeIndex);
    const edge = edges[edgeIndex]!;
    const forward = edge.fromComponent === component;
    const leavingNode = forward ? edge.toNode : edge.fromNode;
    emf = subtractExactRational(emf, exactInput((forward ? -1 : 1) * (edge.battery.voltageVolts ?? 0))!);
    component = forward ? edge.toComponent : edge.fromComponent;
    const neighbors = incident.get(component) ?? [];
    if (neighbors.length !== 2) {
      return { ...edges[firstEdge]!, fromComponent: startComponent, toComponent: component, fromNode, toNode: leavingNode, emf,
        exactSeriesResistance, seriesResistance: exactRationalToNumber(exactSeriesResistance) };
    }
    const nextIndex = neighbors.find((candidate) => candidate !== edgeIndex)!;
    const next = edges[nextIndex]!;
    const nextNode = next.fromComponent === component ? next.fromNode : next.toNode;
    const resistance = externalResistanceExact(nodesByComponent.get(component) ?? [], conductancesByComponent.get(component) ?? [], leavingNode, nextNode);
    if (resistance === null) { return null; }
    exactSeriesResistance = subtractExactRational(exactSeriesResistance, negateExact(resistance));
    edgeIndex = nextIndex;
  }
  return null;
}

function reducedBatteryBlock(
  edges: readonly PassiveBatteryEdge[],
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  const incident = new Map<number, number[]>();
  for (const [index, edge] of edges.entries()) {
    for (const component of [edge.fromComponent, edge.toComponent]) {
      const neighbors = incident.get(component) ?? [];
      neighbors.push(index);
      incident.set(component, neighbors);
    }
  }
  const reduced: PassiveBatteryEdge[] = [];
  const visited = new Set<number>();
  for (const [component, neighbors] of incident) {
    if (neighbors.length <= 2) { continue; }
    for (const index of neighbors) {
      if (visited.has(index)) { continue; }
      const path = seriesBatteryPath(edges, incident, component, index, visited, nodesByComponent, conductancesByComponent);
      if (!path) { return []; }
      reduced.push(path);
    }
  }
  return reduced;
}

function batteryPortResistance(nodes: readonly number[], conductances: readonly Conductance[], from: number, to: number) {
  const exactResistance = externalResistanceExact(nodes, conductances, from, to);
  if (exactResistance === null) { return null; }
  const resistance = exactRationalToNumber(exactResistance);
  return Number.isFinite(resistance) ? { resistance, exactResistance } : null;
}

function batteryBlockAdjacency(
  block: readonly PassiveBatteryEdge[],
  size: number,
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  const adjacent = Array.from({ length: size }, () => [] as BatteryCycleNeighbor[]);
  const terminalsByComponent = new Map<number, Set<number>>();
  for (const { battery, fromNode, toNode, fromComponent, toComponent } of block) {
    adjacent[fromNode]?.push({ node: toNode, resistance: 0, batteryId: battery.id, voltage: -(battery.voltageVolts ?? 0) });
    adjacent[toNode]?.push({ node: fromNode, resistance: 0, batteryId: battery.id, voltage: battery.voltageVolts ?? 0 });
    for (const [component, node] of [[fromComponent, fromNode], [toComponent, toNode]] as const) {
      const terminals = terminalsByComponent.get(component) ?? new Set<number>();
      terminals.add(node);
      terminalsByComponent.set(component, terminals);
    }
  }
  for (const [component, terminals] of terminalsByComponent) {
    const nodes = nodesByComponent.get(component) ?? [];
    const conductances = conductancesByComponent.get(component) ?? [];
    const terminalNodes = [...terminals];
    for (const [position, from] of terminalNodes.entries()) {
      for (const to of terminalNodes.slice(position + 1)) {
        const resistance = batteryPortResistance(nodes, conductances, from, to);
        if (!resistance) { continue; }
        adjacent[from]?.push({ node: to, ...resistance });
        adjacent[to]?.push({ node: from, ...resistance });
      }
    }
  }
  return adjacent;
}

interface VoltagePath extends DistanceEntry {
  voltage: ExactRational;
  exactDistance: ExactRational;
}

function keepVoltagePath(labels: VoltagePath[], candidate: VoltagePath) {
  const sameVoltage = labels.findIndex((label) => subtractExactRational(label.voltage, candidate.voltage).numerator === 0n);
  if (sameVoltage >= 0) {
    if (subtractExactRational(labels[sameVoltage]!.exactDistance, candidate.exactDistance).numerator <= 0n) { return false; }
    labels.splice(sameVoltage, 1);
  } else if (labels.length >= 2) {
    const worst = subtractExactRational(labels[0]!.exactDistance, labels[1]!.exactDistance).numerator > 0n ? 0 : 1;
    if (subtractExactRational(labels[worst]!.exactDistance, candidate.exactDistance).numerator <= 0n) { return false; }
    labels.splice(worst, 1);
  }
  labels.push(candidate);
  return true;
}

function drivenBatteryReturnPathIsShort(adjacent: readonly BatteryCycleNeighbor[][], edge: PassiveBatteryEdge) {
  // Two shortest labels with distinct EMFs suffice: for any continuation,
  // at most one label can cancel the tested source's voltage. This excludes
  // zero-EMF loops driven only indirectly by a different, resistive loop.
  const labels = Array.from({ length: adjacent.length }, () => [] as VoltagePath[]);
  const start: VoltagePath = { node: edge.fromNode, distance: 0, voltage: EXACT_ZERO, exactDistance: EXACT_ZERO };
  const states = [start];
  const heap: DistanceEntry[] = [];
  labels[start.node]?.push(start);
  pushDistance(heap, { node: 0, distance: 0 });
  const expected = exactInput(-(edge.battery.voltageVolts ?? 0))!;
  while (heap.length > 0) {
    const current = states[popDistance(heap)!.node]!;
    if (!labels[current.node]!.includes(current)) { continue; }
    if (subtractExactRational(current.exactDistance, exactInput(SHORT_OHMS)!).numerator >= 0n) { continue; }
    if (current.node === edge.toNode && subtractExactRational(current.voltage, expected).numerator !== 0n) { return true; }
    for (const neighbor of adjacent[current.node] ?? []) {
      if (neighbor.batteryId === edge.battery.id) { continue; }
      const exactDistance = subtractExactRational(current.exactDistance, negateExact(neighbor.exactResistance ?? exactInput(neighbor.resistance)!));
      const next: VoltagePath = {
        node: neighbor.node,
        distance: exactRationalToNumber(exactDistance),
        exactDistance,
        voltage: subtractExactRational(current.voltage, exactInput(-(neighbor.voltage ?? 0))!),
      };
      if (!keepVoltagePath(labels[next.node]!, next)) { continue; }
      pushDistance(heap, { node: states.length, distance: next.distance });
      states.push(next);
    }
  }
  return false;
}

function shortedBatteryInBlock(
  block: readonly PassiveBatteryEdge[],
  readings: Map<string, ExactBatteryReading>,
  size: number,
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  // Shortest weighted return paths cover overlapping cycles without an
  // exponential enumeration. Battery internal resistance is excluded, as
  // for the ordinary and simple-series external-load tests.
  const adjacent = batteryBlockAdjacency(block, size, nodesByComponent, conductancesByComponent);
  return block.find((edge) => {
    if ((readings.get(edge.battery.id)?.current.numerator ?? 0n) === 0n) { return false; }
    return drivenBatteryReturnPathIsShort(adjacent, edge);
  })?.battery;
}

function shortedBatteryInConductorGraph(
  batteries: readonly CircuitPart[],
  readings: Map<string, ExactBatteryReading>,
  index: Map<string, number>,
  passive: readonly Conductance[],
  passiveComponents: number[],
) {
  const adjacent = Array.from({ length: index.size }, () => [] as BatteryCycleNeighbor[]);
  for (const edge of passive) {
    const resistance = edge.resistanceOhms;
    const exactResistance = edge.exactResistance ?? exactInput(resistance)!;
    adjacent[edge.a]!.push({ node: edge.b, resistance, exactResistance });
    adjacent[edge.b]!.push({ node: edge.a, resistance, exactResistance });
  }
  const { edges } = batteryEdgesByPassiveComponent(batteries, index, passiveComponents);
  for (const edge of edges) {
    adjacent[edge.fromNode]!.push({ node: edge.toNode, resistance: 0, batteryId: edge.battery.id, voltage: -edge.battery.voltageVolts! });
    adjacent[edge.toNode]!.push({ node: edge.fromNode, resistance: 0, batteryId: edge.battery.id, voltage: edge.battery.voltageVolts! });
  }
  // Weak passive links can merge all battery ports into one component. Walk
  // the original conductors as well, retaining series wires and the exact
  // nonzero EMF of opposing sources even when that EMF is extremely small.
  return edges.find((edge) => (readings.get(edge.battery.id)?.current.numerator ?? 0n) !== 0n &&
    drivenBatteryReturnPathIsShort(adjacent, edge))?.battery;
}

function parallelBatteryPairs(block: readonly PassiveBatteryEdge[]) {
  const pairs = new Map<string, PassiveBatteryEdge[]>();
  for (const edge of block) {
    const pairKey = `${Math.min(edge.fromComponent, edge.toComponent)}:${Math.max(edge.fromComponent, edge.toComponent)}`;
    const pair = pairs.get(pairKey) ?? [];
    pair.push(edge);
    pairs.set(pairKey, pair);
  }
  return [...pairs.values()].flatMap((pair) => {
    const parallel = pair.length > 1 ? parallelBatteryGroups(pair) : null;
    return parallel ? [parallel] : [];
  });
}

function shortedParallelSubset(
  blocks: readonly (readonly PassiveBatteryEdge[])[],
  readings: Map<string, ExactBatteryReading>,
  size: number,
  conductancesByComponent: Map<number, Conductance[]>,
  physicalConductances?: readonly Conductance[],
) {
  for (const parallel of blocks.flatMap(parallelBatteryPairs)) {
    const shorted = shortedParallelBatteryGroup(parallel, readings, size, conductancesByComponent, physicalConductances);
    if (shorted) { return shorted; }
  }
}

interface ComponentBatteryGroup extends ParallelBatteryGroup {
  fromComponent: number;
  toComponent: number;
  emf: ExactRational;
}

function componentBatteryGroups(block: readonly PassiveBatteryEdge[]) {
  const pairs = new Map<string, PassiveBatteryEdge[]>();
  for (const edge of block) {
    const pairKey = `${Math.min(edge.fromComponent, edge.toComponent)}:${Math.max(edge.fromComponent, edge.toComponent)}`;
    const pair = pairs.get(pairKey) ?? [];
    pair.push(edge);
    pairs.set(pairKey, pair);
  }
  return [...pairs.values()].flatMap((pair): ComponentBatteryGroup[] => {
    const parallel = parallelBatteryGroups(pair)!;
    return parallel.groups.map((group) => {
      const edge = group.edges[0]!;
      const emf = edge.emf ?? exactInput(edge.battery.voltageVolts ?? 0)!;
      return { ...group, fromComponent: parallel.fromComponent, toComponent: parallel.toComponent,
        emf: edge.fromComponent === parallel.fromComponent ? emf : negateExact(emf) };
    });
  });
}

function groupedNetworkShort(
  cycle: readonly ComponentBatteryGroup[],
  emf: ExactRational,
  readings: Map<string, ExactBatteryReading>,
  size: number,
  conductancesByComponent: Map<number, Conductance[]>,
  physicalConductances?: readonly Conductance[],
) {
  if (emf.numerator === 0n) { return; }
  const flowing = cycle.flatMap((group) => group.edges).find((edge) =>
    (readings.get(edge.battery.id)?.current.numerator ?? 0n) !== 0n,
  );
  if (!flowing) { return; }
  const components = new Set(cycle.flatMap((group) => [group.fromComponent, group.toComponent]));
  const conductances = [...components].flatMap((component) => conductancesByComponent.get(component) ?? []);
  const resistance = batteryCycleExternalResistance(size, conductances, cycle);
  if (resistance !== null && subtractExactRational(resistance, exactInput(SHORT_OHMS)!).numerator < 0n) { return flowing.battery; }
  const drive = cycle[0]!;
  const returnEmf = subtractExactRational(drive.emf, emf);
  if (!physicalConductances || drive.emf.numerator * returnEmf.numerator < 0n ||
    cycle.some((group) => group.edges.some((edge) => (edge.exactSeriesResistance?.numerator ?? 0n) !== 0n))) { return; }
  const physicalResistance = batteryCycleExternalResistance(size, physicalConductances, cycle);
  return physicalResistance !== null && subtractExactRational(physicalResistance, exactInput(SHORT_OHMS)!).numerator < 0n
    ? flowing.battery : undefined;
}

interface GroupedCycleSearch {
  groups: ComponentBatteryGroup[];
  adjacent: Map<number, number[]>;
  readings: Map<string, ExactBatteryReading>;
  size: number;
  conductancesByComponent: Map<number, Conductance[]>;
  physicalConductances?: readonly Conductance[];
  passiveLinks: Conductance[];
}

function visitConsistentGroup(
  groups: readonly ComponentBatteryGroup[],
  adjacent: Map<number, number[]>,
  potentials: Map<number, ExactRational>,
  start: number,
) {
  potentials.set(start, EXACT_ZERO);
  const pending = [start];
  while (pending.length > 0) {
    const component = pending.pop()!;
    for (const index of adjacent.get(component) ?? []) {
      const group = groups[index]!;
      const forward = group.fromComponent === component;
      const next = forward ? group.toComponent : group.fromComponent;
      const potential = subtractExactRational(potentials.get(component)!, forward ? group.emf : negateExact(group.emf));
      const existing = potentials.get(next);
      if (existing) {
        if (subtractExactRational(existing, potential).numerator !== 0n) { return false; }
      } else {
        potentials.set(next, potential);
        pending.push(next);
      }
    }
  }
  return true;
}

function groupedEmfsAreConsistent(groups: readonly ComponentBatteryGroup[], adjacent: Map<number, number[]>) {
  const potentials = new Map<number, ExactRational>();
  for (const start of adjacent.keys()) {
    if (!potentials.has(start) && !visitConsistentGroup(groups, adjacent, potentials, start)) { return false; }
  }
  return true;
}

function groupedBatteryAdjacency(groups: readonly ComponentBatteryGroup[]) {
  const adjacent = new Map<number, number[]>();
  for (const [index, group] of groups.entries()) {
    for (const component of [group.fromComponent, group.toComponent]) {
      const neighbors = adjacent.get(component) ?? [];
      neighbors.push(index);
      adjacent.set(component, neighbors);
    }
  }
  return adjacent;
}

function shortedConsistentBatteryReturns(search: GroupedCycleSearch) {
  for (const [position, drive] of search.groups.entries()) {
    const returns = search.groups.filter((_, index) => index !== position);
    const adjacent = groupedBatteryAdjacency(returns);
    const potentials = new Map<number, ExactRational>();
    if (!visitConsistentGroup(returns, adjacent, potentials, drive.fromComponent)) { continue; }
    const returnPotential = potentials.get(drive.toComponent);
    if (!returnPotential) { continue; }
    const emf = subtractExactRational(drive.emf, negateExact(returnPotential));
    const connected = returns.filter((group) => potentials.has(group.fromComponent) && potentials.has(group.toComponent));
    const shorted = groupedNetworkShort([drive, ...connected], emf, search.readings, search.size, search.conductancesByComponent, search.physicalConductances);
    if (shorted) { return shorted; }
  }
}


interface SeriesPortNeighbor {
  node: number;
  resistance: ExactRational;
}

function seriesPortResistance(
  start: number,
  adjacent: ReadonlyMap<number, SeriesPortNeighbor[]>,
  terminals: ReadonlySet<number>,
  drivenTerminals: ReadonlySet<number>,
) {
  let resistance = EXACT_ZERO;
  let node = start;
  let previous = -1;
  const visited = new Set<number>();
  while (!visited.has(node)) {
    visited.add(node);
    const neighbors = adjacent.get(node) ?? [];
    if (neighbors.length !== (node === start ? 1 : 2)) { return resistance; }
    const next = neighbors.find((edge) => edge.node !== previous);
    if (!next) { return EXACT_ZERO; }
    resistance = subtractExactRational(resistance, negateExact(next.resistance));
    previous = node;
    node = next.node;
    if (terminals.has(node)) { return drivenTerminals.has(node) ? EXACT_ZERO : resistance; }
  }
  return EXACT_ZERO;
}

function groupedSeriesResistanceBounds(groups: readonly ComponentBatteryGroup[], conductancesByComponent: Map<number, Conductance[]>, physicalConductances?: readonly Conductance[]) {
  const adjacent = new Map<number, SeriesPortNeighbor[]>();
  const components = new Set(groups.flatMap((group) => [group.fromComponent, group.toComponent]));
  for (const edge of physicalConductances ?? [...components].flatMap((component) => conductancesByComponent.get(component) ?? [])) {
    for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      const neighbors = adjacent.get(from!) ?? [];
      neighbors.push({ node: to!, resistance: edge.exactResistance ?? exactInput(edge.resistanceOhms)! });
      adjacent.set(from!, neighbors);
    }
  }
  const terminals = new Set(groups.flatMap((group) => [...group.fromNodes, ...group.toNodes]));
  pruneSeriesPortLeaves(adjacent, terminals);
  return groups.map((group) => {
    const driven = new Set([...group.fromNodes, ...group.toNodes]);
    let conductance = EXACT_ZERO;
    for (const edge of group.edges) {
      const resistance = subtractExactRational(subtractExactRational(edge.exactSeriesResistance ?? EXACT_ZERO,
        negateExact(seriesPortResistance(edge.fromNode, adjacent, terminals, driven))),
      negateExact(seriesPortResistance(edge.toNode, adjacent, terminals, driven)));
      if (resistance.numerator === 0n) { return EXACT_ZERO; }
      conductance = subtractExactRational(conductance, negateExact(divideExactRational(EXACT_ONE, resistance)!));
    }
    return divideExactRational(EXACT_ONE, conductance)!;
  });
}

function pruneSeriesPortLeaves(adjacent: Map<number, SeriesPortNeighbor[]>, terminals: ReadonlySet<number>) {
  const pending = [...adjacent].filter(([node, neighbors]) => neighbors.length === 1 && !terminals.has(node)).map(([node]) => node);
  while (pending.length > 0) {
    const node = pending.pop()!;
    const neighbors = adjacent.get(node);
    if (neighbors?.length !== 1 || terminals.has(node)) { continue; }
    const other = neighbors[0]!.node;
    adjacent.delete(node);
    const remaining = (adjacent.get(other) ?? []).filter((edge) => edge.node !== node);
    adjacent.set(other, remaining);
    if (remaining.length === 1 && !terminals.has(other)) { pending.push(other); }
  }
}

function compatibleGroupPotentials(group: ComponentBatteryGroup, potentials: ReadonlyMap<number, ExactRational>) {
  const from = potentials.get(group.fromComponent);
  const to = potentials.get(group.toComponent);
  return !from || !to || subtractExactRational(subtractExactRational(from, to), group.emf).numerator === 0n;
}

function groupReturnResistanceBound(groups: readonly ComponentBatteryGroup[], bounds: readonly ExactRational[], driveIndex: number, potentials: ReadonlyMap<number, ExactRational>, size: number, passiveLinks: readonly Conductance[]) {
  const drive = groups[driveIndex]!;
  const parent = Array.from({ length: size }, (_, node) => node);
  const available = groups.map((group, index) => ({ group, index }))
    .filter(({ group, index }) => index !== driveIndex && compatibleGroupPotentials(group, potentials));
  for (const { group, index } of available) {
    if (bounds[index]!.numerator === 0n) { parent[findRoot(parent, group.fromComponent)] = findRoot(parent, group.toComponent); }
  }
  const from = findRoot(parent, drive.fromComponent);
  const to = findRoot(parent, drive.toComponent);
  if (from === to) { return bounds[driveIndex]!; }
  const branches = available.flatMap(({ group, index }): Conductance[] => {
    const exactResistance = bounds[index]!;
    const a = findRoot(parent, group.fromComponent);
    const b = findRoot(parent, group.toComponent);
    if (a === b || exactResistance.numerator === 0n) { return []; }
    const resistanceOhms = exactRationalToNumber(exactResistance);
    return [{ a, b, resistanceOhms, g: 1 / resistanceOhms, exactResistance }];
  });
  branches.push(...passiveLinks.map((edge) => ({ ...edge, a: findRoot(parent, edge.a), b: findRoot(parent, edge.b) })));
  const nodes = [...new Set([from, to, ...branches.flatMap((edge) => [edge.a, edge.b])])];
  const returned = externalResistanceExact(nodes, branches, from, to);
  return returned === null ? null : subtractExactRational(bounds[driveIndex]!, negateExact(returned));
}

function groupPotentialStateKey(potentials: ReadonlyMap<number, ExactRational>) {
  return [...potentials].sort(([first], [second]) => first - second)
    .map(([node, value]) => `${node}:${value.numerator}/${value.denominator}`).join(";");
}

function shortedAssignedBatteryReturn(search: GroupedCycleSearch, driveIndex: number, potentials: ReadonlyMap<number, ExactRational>) {
  const drive = search.groups[driveIndex]!;
  const returned = potentials.get(drive.toComponent);
  if (!returned) { return; }
  const emf = subtractExactRational(drive.emf, negateExact(returned));
  if (emf.numerator === 0n) { return; }
  const returns = search.groups.filter((group, index) => index !== driveIndex &&
    potentials.has(group.fromComponent) && potentials.has(group.toComponent) && compatibleGroupPotentials(group, potentials));
  return groupedNetworkShort([drive, ...returns], emf, search.readings, search.size, search.conductancesByComponent, search.physicalConductances);
}

function extendGroupPotentialStates(search: GroupedCycleSearch, driveIndex: number, potentials: ReadonlyMap<number, ExactRational>, pending: Map<number, ExactRational>[]) {
  for (const [index, group] of search.groups.entries()) {
    if (index === driveIndex) { continue; }
    const from = potentials.get(group.fromComponent);
    const to = potentials.get(group.toComponent);
    if (Boolean(from) === Boolean(to)) { continue; }
    const next = new Map(potentials);
    if (from) { next.set(group.toComponent, subtractExactRational(from, group.emf)); }
    else { next.set(group.fromComponent, subtractExactRational(to!, negateExact(group.emf))); }
    pending.push(next);
  }
}

function shortedPotentialBatteryReturns(search: GroupedCycleSearch, bounds: readonly ExactRational[], driveIndex: number) {
  const drive = search.groups[driveIndex]!;
  const pending = [new Map([[drive.fromComponent, EXACT_ZERO]])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const potentials = pending.pop()!;
    const stateKey = groupPotentialStateKey(potentials);
    if (visited.has(stateKey)) { continue; }
    visited.add(stateKey);
    const returned = potentials.get(drive.toComponent);
    if (returned && subtractExactRational(drive.emf, negateExact(returned)).numerator === 0n) { continue; }
    const bound = groupReturnResistanceBound(search.groups, bounds, driveIndex, potentials, search.size, search.passiveLinks);
    if (bound === null || subtractExactRational(bound, exactInput(SHORT_OHMS)!).numerator >= 0n) { continue; }
    const shorted = shortedAssignedBatteryReturn(search, driveIndex, potentials);
    if (shorted) { return shorted; }
    // Every connected consistent return network admits this construction.
    // Memoized potential assignments merge different traversal orders; the
    // resistance lower bound prunes networks that cannot reach the threshold.
    extendGroupPotentialStates(search, driveIndex, potentials, pending);
  }
}

function baselineGroupPotentials(groups: readonly ComponentBatteryGroup[], bounds: readonly ExactRational[], size: number) {
  const parent = Array.from({ length: size }, (_, node) => node);
  const ordered = groups.map((group, index) => ({ group, index })).sort((first, second) => {
    const difference = subtractExactRational(bounds[first.index]!, bounds[second.index]!);
    return difference.numerator < 0n ? -1 : difference.numerator > 0n ? 1 : 0;
  });
  const tree: ComponentBatteryGroup[] = [];
  for (const { group } of ordered) {
    const from = findRoot(parent, group.fromComponent);
    const to = findRoot(parent, group.toComponent);
    if (from === to) { continue; }
    parent[from] = to;
    tree.push(group);
  }
  const potentials = new Map<number, ExactRational>();
  const adjacent = groupedBatteryAdjacency(tree);
  for (const start of adjacent.keys()) {
    if (!potentials.has(start)) { visitConsistentGroup(tree, adjacent, potentials, start); }
  }
  return potentials;
}

function residualGroupResistanceBound(groups: readonly ComponentBatteryGroup[], bounds: readonly ExactRational[], potentials: ReadonlyMap<number, ExactRational>, passiveLinks: readonly Conductance[]) {
  let conductance = EXACT_ZERO;
  for (const [index, group] of groups.entries()) {
    if (compatibleGroupPotentials(group, potentials)) { continue; }
    const resistance = bounds[index]!;
    if (resistance.numerator === 0n) { return null; }
    conductance = subtractExactRational(conductance, negateExact(divideExactRational(EXACT_ONE, resistance)!));
  }
  for (const edge of passiveLinks) {
    const resistance = edge.exactResistance ?? exactInput(edge.resistanceOhms)!;
    conductance = subtractExactRational(conductance, negateExact(divideExactRational(EXACT_ONE, resistance)!));
  }
  return conductance.numerator === 0n ? null : divideExactRational(EXACT_ONE, conductance);
}

function shortedGroupedBatteryCycles(
  block: readonly PassiveBatteryEdge[],
  readings: Map<string, ExactBatteryReading>,
  size: number,
  conductancesByComponent: Map<number, Conductance[]>,
  physicalConductances?: readonly Conductance[],
  passiveComponents?: readonly number[],
) {
  const groups = componentBatteryGroups(block);
  if (groups.length < 3) { return; }
  const adjacent = groupedBatteryAdjacency(groups);
  if (groupedEmfsAreConsistent(groups, adjacent)) { return; }
  const bounds = groupedSeriesResistanceBounds(groups, conductancesByComponent, physicalConductances);
  const passiveLinks = physicalConductances && passiveComponents
    ? physicalConductances.map((edge) => ({ ...edge, a: passiveComponents[edge.a]!, b: passiveComponents[edge.b]! })).filter((edge) => edge.a !== edge.b)
    : [];
  const search = { groups, adjacent, readings, size, conductancesByComponent, physicalConductances, passiveLinks };
  const returnShort = shortedConsistentBatteryReturns(search);
  if (returnShort) { return returnShort; }
  const baseline = baselineGroupPotentials(groups, bounds, size);
  const residualBound = residualGroupResistanceBound(groups, bounds, baseline, passiveLinks);
  for (const position of groups.keys()) {
    if (subtractExactRational(bounds[position]!, exactInput(SHORT_OHMS)!).numerator >= 0n) { continue; }
    // A return with different EMF must cross a source group inconsistent
    // with the baseline potential. Even putting all such groups in parallel
    // cannot exceed their total conductance; this bound prunes dense networks
    // whose only driving inconsistency lies behind a resistive branch.
    if (residualBound && compatibleGroupPotentials(groups[position]!, baseline) &&
      subtractExactRational(subtractExactRational(bounds[position]!, negateExact(residualBound)), exactInput(SHORT_OHMS)!).numerator >= 0n) { continue; }
    const shorted = shortedPotentialBatteryReturns(search, bounds, position);
    if (shorted) { return shorted; }
  }
}

function shortedBatteryCycle(
  loop: readonly PassiveBatteryEdge[],
  readings: Map<string, ExactBatteryReading>,
  size: number,
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
  physicalConductances?: readonly Conductance[],
  passiveComponents?: readonly number[],
) {
  const reduced = reducedBatteryBlock(loop, nodesByComponent, conductancesByComponent);
  const parallel = parallelBatteryGroups(loop) ?? parallelBatteryGroups(reduced);
  if (parallel) {
    const shorted = shortedParallelBatteryGroup(parallel, readings, size, conductancesByComponent, physicalConductances);
    if (shorted || !physicalConductances) { return shorted; }
  }
  // Further source branches must not hide a parallel group's combined return.
  const subsetShort = shortedParallelSubset([loop, reduced], readings, size, conductancesByComponent, physicalConductances);
  if (subsetShort) { return subsetShort; }
  const groupedShort = shortedGroupedBatteryCycles(loop, readings, size, conductancesByComponent, physicalConductances, passiveComponents) ??
    shortedGroupedBatteryCycles(reduced, readings, size, conductancesByComponent);
  if (groupedShort) { return groupedShort; }
  const resistance = seriesLoopExternalResistance(loop, nodesByComponent, conductancesByComponent);
  if (resistance !== null && subtractExactRational(resistance, exactInput(SHORT_OHMS)!).numerator >= 0n) { return; }
  return shortedBatteryInBlock(loop, readings, size, nodesByComponent, conductancesByComponent);
}

function shortedSeriesLoopBattery(
  batteries: readonly CircuitPart[],
  readings: Map<string, ExactBatteryReading>,
  index: Map<string, number>,
  passiveComponents: number[],
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  const graph = batteryEdgesByPassiveComponent(batteries, index, passiveComponents);
  const protectedBatteryIds = new Set<string>();
  for (const loop of batteryCycleGroups(graph.edges, graph.incidentEdges)) {
    for (const edge of loop) { protectedBatteryIds.add(edge.battery.id); }
    const shortedCell = shortedBatteryCycle(loop, readings, index.size, nodesByComponent, conductancesByComponent);
    if (shortedCell) { return { protectedBatteryIds, shortedBattery: shortedCell }; }
  }
  return { protectedBatteryIds, shortedBattery: undefined };
}

function passiveEscapeConductances(
  size: number,
  rails: number[],
  passive: readonly Conductance[],
) {
  const total = Array.from({ length: size }, () => 0);
  for (const { a, b, g } of passive) {
    const fromRail = rails[a];
    const toRail = rails[b];
    if (fromRail === toRail) { continue; }
    if (fromRail !== undefined) { total[fromRail] = (total[fromRail] ?? 0) + g; }
    if (toRail !== undefined) { total[toRail] = (total[toRail] ?? 0) + g; }
  }
  return total;
}

interface PassiveResistanceIndex {
  anchors: Map<number, number>;
  tails: Map<number, number>;
  coreNodes: number[];
  coreConductances: Conductance[];
  coreResistance: Map<string, number | null>;
}

interface LocalPassiveConductance extends Conductance {
  localA: number;
  localB: number;
}

function localPassiveConductances(nodes: readonly number[], conductances: readonly Conductance[]) {
  const localIndex = new Map(nodes.map((node, local) => [node, local]));
  return conductances.flatMap((edge) => {
    const a = localIndex.get(edge.a);
    const b = localIndex.get(edge.b);
    return a === undefined || b === undefined ? [] : [{ ...edge, localA: a, localB: b }];
  });
}

function passiveComponentAdjacency(nodes: readonly number[], localEdges: readonly LocalPassiveConductance[]) {
  const adjacent = nodes.map(() => [] as { edge: number; node: number; resistance: number }[]);
  for (const [edgeIndex, edge] of localEdges.entries()) {
    const resistance = edge.resistanceOhms;
    adjacent[edge.localA]?.push({ edge: edgeIndex, node: edge.localB, resistance });
    adjacent[edge.localB]?.push({ edge: edgeIndex, node: edge.localA, resistance });
  }
  return adjacent;
}

function peelPassiveComponentLeaves(
  adjacent: readonly { edge: number; node: number; resistance: number }[][],
) {
  const degree = adjacent.map((edges) => edges.length);
  const pending = degree.flatMap((value, node) => value <= 1 ? [node] : []);
  const removedEdges = new Set<number>();
  const peeled: { node: number; parent: number; resistance: number }[] = [];
  for (const node of pending) {
    if ((degree[node] ?? 0) > 1) { continue; }
    let remaining: { edge: number; node: number; resistance: number } | undefined;
    for (const edge of adjacent[node] ?? []) {
      if (!removedEdges.has(edge.edge)) { remaining = edge; break; }
    }
    if (remaining) {
      removedEdges.add(remaining.edge);
      peeled.push({ node, parent: remaining.node, resistance: remaining.resistance });
      degree[node] = 0;
      degree[remaining.node] = (degree[remaining.node] ?? 0) - 1;
      if ((degree[remaining.node] ?? 0) <= 1) { pending.push(remaining.node); }
    } else {
      degree[node] = 0;
    }
  }
  return { degree, removedEdges, peeled };
}

function passiveCoreNetwork(
  nodes: readonly number[],
  localEdges: readonly LocalPassiveConductance[],
  degree: readonly number[],
  removedEdges: ReadonlySet<number>,
) {
  const coreLocalNodes = degree.flatMap((value, node) => value > 0 ? [node] : []);
  const coreNodes = coreLocalNodes.map((node) => nodes[node]).filter(
    (node): node is number => node !== undefined,
  );
  const coreConductances = localEdges.flatMap((edge, edgeIndex) => {
    if (removedEdges.has(edgeIndex) || degree[edge.localA] === 0 || degree[edge.localB] === 0) { return []; }
    const a = nodes[edge.localA];
    const b = nodes[edge.localB];
    return a === undefined || b === undefined ? [] : [{ a, b, g: edge.g, resistanceOhms: edge.resistanceOhms }];
  });
  return { coreLocalNodes, coreNodes, coreConductances };
}

function passiveNodeAnchors(
  nodes: readonly number[],
  coreLocalNodes: readonly number[],
  peeled: readonly { node: number; parent: number; resistance: number }[],
) {
  const anchors = new Map<number, number>();
  const tails = new Map<number, number>();
  for (const node of coreLocalNodes) {
    const globalNode = nodes[node];
    if (globalNode !== undefined) {
      anchors.set(globalNode, globalNode);
      tails.set(globalNode, 0);
    }
  }
  for (let cursor = peeled.length - 1; cursor >= 0; cursor -= 1) {
    const leaf = peeled[cursor];
    if (!leaf) { continue; }
    const globalNode = nodes[leaf.node];
    const globalParent = nodes[leaf.parent];
    const anchor = globalParent === undefined ? undefined : anchors.get(globalParent);
    const parentTail = globalParent === undefined ? undefined : tails.get(globalParent);
    if (globalNode !== undefined && anchor !== undefined && parentTail !== undefined) {
      anchors.set(globalNode, anchor);
      tails.set(globalNode, leaf.resistance + parentTail);
    }
  }
  return { anchors, tails };
}

function passiveResistanceIndex(nodes: readonly number[], conductances: readonly Conductance[]) {
  const localEdges = localPassiveConductances(nodes, conductances);
  const adjacent = passiveComponentAdjacency(nodes, localEdges);
  const { degree, removedEdges, peeled } = peelPassiveComponentLeaves(adjacent);
  const { coreLocalNodes, coreNodes, coreConductances } = passiveCoreNetwork(
    nodes,
    localEdges,
    degree,
    removedEdges,
  );
  const { anchors, tails } = passiveNodeAnchors(nodes, coreLocalNodes, peeled);
  return { anchors, tails, coreNodes, coreConductances, coreResistance: new Map<string, number | null>() };
}

function indexedExternalResistance(
  index: PassiveResistanceIndex,
  from: number,
  to: number,
  shortestPathResistance: number,
) {
  const fromAnchor = index.anchors.get(from);
  const toAnchor = index.anchors.get(to);
  const fromTail = index.tails.get(from);
  const toTail = index.tails.get(to);
  if (fromAnchor === undefined || toAnchor === undefined || fromTail === undefined || toTail === undefined) {
    // A tree has no 2-core; its unique path is its exact equivalent resistance.
    return shortestPathResistance;
  }
  if (fromAnchor === toAnchor) { return shortestPathResistance; }

  const pair = fromAnchor < toAnchor ? `${fromAnchor}:${toAnchor}` : `${toAnchor}:${fromAnchor}`;
  let coreResistance = index.coreResistance.get(pair);
  if (coreResistance === undefined) {
    coreResistance = externalResistance(index.coreNodes, index.coreConductances, fromAnchor, toAnchor);
    index.coreResistance.set(pair, coreResistance);
  }
  if (coreResistance === null) { return null; }
  const resistance = fromTail + coreResistance + toTail;
  return Number.isFinite(resistance) && resistance >= 0 ? resistance : null;
}

function externalPairIsShort(
  from: number,
  to: number,
  sourceTree: SourceConstraintTree,
  rails: number[],
  escapeConductance: number[],
  adjacent: readonly PassiveNeighbor[][],
  distancesByNode: Map<number, number[]>,
  resistanceIndex: PassiveResistanceIndex,
) {
  const sourceDifference = sourceVoltageDifference(sourceTree, from, to);
  // Keep compensated nonzero differences even beside much larger voltages.
  if (sourceDifference.value === 0) { return false; }
  const fromRail = rails[from];
  const toRail = rails[to];
  if (fromRail === undefined || toRail === undefined || fromRail === toRail) { return false; }
  // Each route must leave both zero-voltage conductor rails. Their total
  // outgoing conductance bounds the external conductance from above.
  if ((escapeConductance[fromRail] ?? 0) <= 1 / SHORT_OHMS ||
    (escapeConductance[toRail] ?? 0) <= 1 / SHORT_OHMS) {
    return false;
  }

  let distances = distancesByNode.get(from);
  if (!distances) {
    distances = shortestPassiveResistances(adjacent, from);
    distancesByNode.set(from, distances);
  }
  if ((distances[to] ?? Number.POSITIVE_INFINITY) < SHORT_OHMS) { return true; }

  const resistance = indexedExternalResistance(resistanceIndex, from, to, distances[to] ?? Number.POSITIVE_INFINITY);
  return resistance !== null && resistance < SHORT_OHMS;
}

function exactSourcePotential(tree: SourceConstraintTree, node: number) {
  let potential = EXACT_ZERO;
  let current = node;
  while (tree.parent[current] !== -1) {
    potential = subtractExactRational(potential, negateExact(exactInput(tree.offset[current] ?? 0)!));
    current = tree.parent[current]!;
  }
  return potential;
}

function sourceGroupVoltageSpan(tree: SourceConstraintTree, group: number) {
  let low = EXACT_ZERO;
  let high = EXACT_ZERO;
  for (const [node, component] of tree.component.entries()) {
    if (component !== group) { continue; }
    const potential = exactSourcePotential(tree, node);
    if (subtractExactRational(potential, low).numerator < 0n) { low = potential; }
    if (subtractExactRational(potential, high).numerator > 0n) { high = potential; }
  }
  return subtractExactRational(high, low);
}

function sourceGroupExternalResistance(
  group: number,
  batteriesByGroup: Map<number, CircuitPart[]>,
  index: Map<string, number>,
  sourceTree: SourceConstraintTree,
  passive: readonly Conductance[],
) {
  const span = sourceGroupVoltageSpan(sourceTree, group);
  if (span.numerator === 0n) { return null; }
  const parent = Array.from({ length: index.size }, (_, node) => node);
  const offsets = Array.from({ length: index.size }, () => EXACT_ZERO);
  // This test measures this source group's passive load. Other source groups
  // are open here; zeroing their EMF would invent a driven source cycle.
  // Genuine multi-group circulation is checked by the source-cycle search.
  for (const battery of batteriesByGroup.get(group) ?? []) {
    const from = index.get(`${battery.id}:a`)!;
    const to = index.get(`${battery.id}:b`)!;
    parent[from] = to;
    offsets[from] = divideExactRational(exactInput(battery.voltageVolts!)!, span)!;
  }
  // Retain every conductor, including wires between series cells and weak
  // loads that connect their intermediate terminals to the external network.
  const branches = passive.map((edge) => ({
    ...edge, a: findRoot(parent, edge.a), b: findRoot(parent, edge.b),
    exactVoltage: subtractExactRational(offsets[edge.b]!, offsets[edge.a]!),
  }));
  const power = passiveNetworkPower(index.size, branches);
  return power && power.numerator > 0n ? divideExactRational(EXACT_ONE, power) : null;
}

function multiSourceGroupShorts(
  sourceGroups: Set<number>,
  batteriesByGroup: Map<number, CircuitPart[]>,
  index: Map<string, number>,
  sourceTree: SourceConstraintTree,
  passive: readonly Conductance[],
) {
  const results = new Map<number, boolean>();
  for (const group of sourceGroups) {
    if ((batteriesByGroup.get(group)?.length ?? 0) < 2 || sourceTree.inconsistent.has(group)) { continue; }
    const resistance = sourceGroupExternalResistance(group, batteriesByGroup, index, sourceTree, passive);
    results.set(group, resistance !== null && subtractExactRational(resistance, exactInput(SHORT_OHMS)!).numerator < 0n);
  }
  return results;
}

function shortedBatteryByExternalResistance(
  groups: Map<string, { sourceGroup: number; passiveGroup: number; nodes: number[] }>,
  batteriesByGroup: Map<number, CircuitPart[]>,
  index: Map<string, number>,
  sourceTree: SourceConstraintTree,
  rails: number[],
  escapeConductance: number[],
  passive: readonly Conductance[],
  nodesByComponent: Map<number, number[]>,
  conductancesByComponent: Map<number, Conductance[]>,
) {
  const groupedResults = multiSourceGroupShorts(new Set([...groups.values()].map((group) => group.sourceGroup)),
    batteriesByGroup, index, sourceTree, passive);
  const shortedGroup = [...groupedResults].find(([, short]) => short)?.[0];
  if (shortedGroup !== undefined) { return batteriesByGroup.get(shortedGroup)?.[0]; }
  const remainingGroups = [...groups.values()].filter((group) => !groupedResults.has(group.sourceGroup));
  const adjacent = passiveAdjacency(index.size, passive);
  const distancesByNode = new Map<number, number[]>();
  const resistanceIndexes = new Map<number, PassiveResistanceIndex>();
  for (const { sourceGroup, passiveGroup, nodes } of remainingGroups) {
    const battery = batteriesByGroup.get(sourceGroup)?.[0];
    const componentNodes = nodesByComponent.get(passiveGroup);
    const componentConductances = conductancesByComponent.get(passiveGroup) ?? [];
    if (!battery || !componentNodes) { continue; }
    let resistanceIndex = resistanceIndexes.get(passiveGroup);
    if (!resistanceIndex) {
      resistanceIndex = passiveResistanceIndex(componentNodes, componentConductances);
      resistanceIndexes.set(passiveGroup, resistanceIndex);
    }
    for (let fromIndex = 0; fromIndex < nodes.length; fromIndex += 1) {
      const from = nodes[fromIndex]!;
      for (let toIndex = fromIndex + 1; toIndex < nodes.length; toIndex += 1) {
        const to = nodes[toIndex]!;
        if (externalPairIsShort(
          from,
          to,
          sourceTree,
          rails,
          escapeConductance,
          adjacent,
          distancesByNode,
          resistanceIndex,
        )) {
          return battery;
        }
      }
    }
  }
}

function shortedBattery(
  document: CircuitDocument,
  batteries: readonly CircuitPart[],
  solved: NonNullable<ReturnType<typeof nodeVoltages>>,
  index: Map<string, number>,
  conductances: readonly Conductance[],
  switchStates: Record<string, boolean>,
) {
  const readings = exactBatteryReadings(batteries, index, solved);
  const passive = conductances.filter(({ batteryId }) => batteryId === undefined);
  const passiveNetwork = passiveComponentsByNode(index.size, passive);
  const seriesLoop = shortedSeriesLoopBattery(
    batteries,
    readings,
    index,
    passiveNetwork.components,
    passiveNetwork.nodesByComponent,
    passiveNetwork.conductancesByComponent,
  );
  if (seriesLoop.shortedBattery) { return seriesLoop.shortedBattery; }
  const drivenShort = shortedBatteryInConductorGraph(batteries, readings, index, passive, passiveNetwork.components);
  if (drivenShort) { return drivenShort; }
  const subnetworkShort = shortedBatterySubnetworks(batteries, readings, index, passive, passiveNetwork.components);
  if (subnetworkShort) { return subnetworkShort; }

  const sourceEdges = sourceConstraintEdges(document, index, switchStates);
  const sourceTree = sourceConstraintTree(index.size, sourceEdges);
  const batteriesByGroup = batteriesBySourceGroup(batteries, sourceTree, index);
  const byTerminalRatio = shortedBatteryByTerminalRatio(
    batteries,
    readings,
    sourceTree,
    batteriesByGroup,
    index,
    seriesLoop.protectedBatteryIds,
  );
  if (byTerminalRatio) { return byTerminalRatio; }

  const rails = zeroVoltageSourceRails(index.size, sourceEdges);
  const escapeConductance = passiveEscapeConductances(index.size, rails, passive);
  const groups = sourcePassiveNodeGroups(
    sourceTree,
    batteriesByGroup,
    passiveNetwork.components,
    index,
    seriesLoop.protectedBatteryIds,
  );
  return shortedBatteryByExternalResistance(
    groups,
    batteriesByGroup,
    index,
    sourceTree,
    rails,
    escapeConductance,
    passive,
    passiveNetwork.nodesByComponent,
    passiveNetwork.conductancesByComponent,
  );
}

function shortedBatterySubnetworks(
  batteries: readonly CircuitPart[],
  readings: Map<string, ExactBatteryReading>,
  index: Map<string, number>,
  passive: readonly Conductance[],
  components: readonly number[],
) {
  if (batteries.length < 2 || !batteries.some((battery) => {
    const from = index.get(`${battery.id}:a`);
    const to = index.get(`${battery.id}:b`);
    return from !== undefined && to !== undefined && components[from] === components[to];
  })) { return; }
  const resistanceOf = (edge: Conductance) => edge.exactResistance ?? exactInput(edge.resistanceOhms)!;
  const levels = [...new Map(passive.map((edge) => {
    const resistance = resistanceOf(edge);
    return [`${resistance.numerator}/${resistance.denominator}`, resistance] as const;
  })).values()].sort((first, second) => {
    const difference = subtractExactRational(first, second).numerator;
    return difference < 0n ? -1 : Number(difference > 0n);
  });
  // Adding a weak load must not remove a driven low-resistance source cycle.
  // Check every distinct resistance level; individual parallel return branches
  // can exceed SHORT_OHMS even when their combined resistance is below it.
  for (const level of levels.slice(0, -1)) {
    const subset = passive.filter((edge) => subtractExactRational(resistanceOf(edge), level).numerator <= 0n);
    const network = passiveComponentsByNode(index.size, subset);
    const graph = batteryEdgesByPassiveComponent(batteries, index, network.components);
    for (const loop of batteryCycleGroups(graph.edges, graph.incidentEdges)) {
      const parallel = parallelBatteryGroups(loop);
      const shorted = parallel
        ? shortedParallelBatteryGroup(parallel, readings, index.size, network.conductancesByComponent, passive)
        : shortedBatteryCycle(loop, readings, index.size, network.nodesByComponent, network.conductancesByComponent, passive, network.components);
      if (shorted) { return shorted; }
    }
  }
}

function connectedTerminals(document: CircuitDocument) {
  const connected = new Set<string>();
  for (const wire of document.wires) {
    connected.add(key(wire.from));
    connected.add(key(wire.to));
  }
  return connected;
}

/** Warnings that do not stop the calculation but deserve the author's attention. */
function collectIssues(document: CircuitDocument, parts: Record<string, CircuitPartReading>) {
  const issues: CircuitIssue[] = [];
  const connected = connectedTerminals(document);
  for (const part of document.parts) {
    const reading = parts[part.id];
    if (
      part.kind === "bulb" &&
      reading &&
      reading.powerWatts > (part.ratedPowerWatts ?? 2) * OVERLOAD_RATIO
    ) {
      issues.push({
        severity: "warning",
        partId: part.id,
        message: `${part.label}に定格の${OVERLOAD_RATIO}倍を超える電力がかかっています。`,
      });
    }
    if (part.kind === "voltmeter" || part.kind === "ammeter") { continue; }
    const loose = terminalsOf(part.kind).filter(
      (terminal) => !connected.has(`${part.id}:${terminal}`),
    );
    if (loose.length > 0) {
      issues.push({
        severity: "info",
        partId: part.id,
        message: `${part.label}に未接続の端子があります。`,
      });
    }
  }
  return issues;
}

function closedMessage(batteries: readonly CircuitPart[]) {
  return batteries.length === 1
    ? "閉じた回路として計算しています。"
    : `${batteries.length}個の電池を含む回路として計算しています。`;
}

/**
 * Solves a DC operating point or sinusoidal AC steady state. Existing seven-part
 * DC documents retain their original solver and wire-current behavior.
 */
export function analyzeCircuit(
  document: CircuitDocument,
  switchStates: Record<string, boolean> = {},
  options: CircuitAnalysisOptions = {},
): CircuitAnalysis {
  try {
    return analyzeCircuitFromInput(document, switchStates, options);
  } catch {
    return invalidInputResult("回路データまたは解析条件を読み取れません。");
  }
}

function analyzeCircuitFromInput(
  document: CircuitDocument,
  switchStates: Record<string, boolean>,
  options: CircuitAnalysisOptions,
): CircuitAnalysis {
  const inputIssue = circuitAnalysisInputIssue(document, switchStates, options);
  if (inputIssue) { return invalidInputResult(inputIssue); }
  const normalizedDocument = documentWithCatalogDefaults(copySimulationDocument(document));
  let normalizedOptions: CircuitAnalysisOptions;
  try {
    normalizedOptions = {
      mode: simulationRecordField(options, "mode") as CircuitAnalysisOptions["mode"],
      frequencyHz: simulationRecordField(options, "frequencyHz") as number | undefined,
    };
  } catch {
    return invalidInputResult("解析条件を読み取れません。");
  }
  const legacyKinds = new Set(["battery", "resistor", "bulb", "switch", "ammeter", "voltmeter", "junction"]);
  if (normalizedOptions.mode === "ac" || normalizedDocument.parts.some((part) => !legacyKinds.has(part.kind))) {
    return analyzeExtendedCircuit(normalizedDocument, switchStates, normalizedOptions);
  }
  if (normalizedDocument.parts.length === 0) { return result("empty", "部品を配置して回路を作成してください。"); }
  const invalid = documentIssue(normalizedDocument, switchStates);
  if (invalid) {
    return result("invalid", invalid, { issues: [{ severity: "error", message: invalid }] });
  }
  const terminalCount = normalizedDocument.parts.reduce(
    (count, part) => count + terminalsOf(part.kind).length,
    0,
  );
  if (terminalCount > MAX_CIRCUIT_ANALYSIS_TERMINALS) {
    const message =
      `端子数が解析上限の${MAX_CIRCUIT_ANALYSIS_TERMINALS}端子を超えています。` +
      "部品を減らすか、回路を分けて解析してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const index = indexTerminals(normalizedDocument.parts);
  const conductances = buildNetwork(normalizedDocument, index, switchStates);
  const solved = nodeVoltages(index.size, conductances);
  if (!solved) {
    const message = "回路を計算できませんでした。接続と部品の数値を確認してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const { parts, wireCurrents } = readAll(normalizedDocument, index, solved, switchStates);
  if (!hasOnlyFiniteReadings(parts, wireCurrents)) {
    const message = "回路の計算結果が数値の範囲を超えました。電圧・電流・抵抗値を確認してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const issues = collectIssues(normalizedDocument, parts);
  const batteries = normalizedDocument.parts.filter((part) => part.kind === "battery");
  const readings = { parts, wireCurrents, issues };
  if (batteries.length === 0) { return result("idle", "電池を置くと電流を計算します。", readings); }
  const shorted = shortedBattery(normalizedDocument, batteries, solved, index, conductances, switchStates);
  if (shorted) {
    const message = `${shorted.label}が短絡しています。抵抗か電球を直列に入れてください。`;
    return result("short", message, {
      ...readings,
      issues: [{ severity: "error", partId: shorted.id, message }, ...issues],
    });
  }
  const hasClosedLoop = batteries.some((battery) => {
    const a = index.get(`${battery.id}:a`);
    const b = index.get(`${battery.id}:b`);
    return (
      a !== undefined &&
      b !== undefined &&
      hasExternalBatteryPath(index.size, conductances, battery.id, a, b)
    );
  });
  if (!hasClosedLoop) {
    return result("open", "回路が開いています。導線とスイッチを確認してください。", {
      ...readings,
      currentAmps: batteries.length === 1 ? 0 : null,
    });
  }
  const bulbPowerWatts = Object.fromEntries(
    normalizedDocument.parts
      .filter((part) => part.kind === "bulb")
      .map((part) => [part.id, parts[part.id]?.powerWatts ?? 0]),
  );
  const only = batteries.length === 1 ? batteries[0] : undefined;
  return result("closed", closedMessage(batteries), {
    ...readings,
    bulbPowerWatts,
    currentAmps: only ? Math.abs(parts[only.id]?.currentAmps ?? 0) : null,
  });
}

function invalidInputResult(message: string): CircuitAnalysis {
  return result("invalid", message, { issues: [{ severity: "error", message }] });
}

function circuitAnalysisInputIssue(document: unknown, switchStates: unknown, options: unknown) {
  try {
    const shapeIssue = circuitDocumentShapeIssue(document);
    if (shapeIssue) { return shapeIssue; }
    if (!isSimulationRecord(switchStates)) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
    if (!isSimulationRecord(options)) { return "解析条件はオブジェクトで指定してください。"; }
    const mode = simulationRecordField(options, "mode");
    const frequencyHz = simulationRecordField(options, "frequencyHz");
    if (mode !== undefined && mode !== "auto" && mode !== "dc" && mode !== "ac") {
      return "解析方式は auto、dc、または ac で指定してください。";
    }
    if (frequencyHz !== undefined &&
        (typeof frequencyHz !== "number" || !Number.isFinite(frequencyHz) || frequencyHz <= 0)) {
      return "解析周波数は有限な0より大きい数値にしてください。";
    }
    const kinds = new Map((document as CircuitDocument).parts.map((part) => [part.id, part.kind]));
    return switchStateIssue(switchStates, kinds);
  } catch {
    return "解析条件またはスイッチ状態を読み取れません。";
  }
}
