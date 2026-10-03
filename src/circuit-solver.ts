import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeExtendedCircuit } from "./circuit-analog-adapter.js";
import { exactProductSumRatio } from "./analog-math.js";
import {
  addExactRational,
  divideExactRational,
  exactRationalToNumber,
  multiplyExactRational,
  numberToExactRational,
  solveExactRealLinearSystem,
  subtractExactRational,
  type ExactRational,
} from "./exact-linear-algebra.js";
import { addRealStateValue, complexFromExact, exactComplexValue, exactRealStateInput } from "./exact-numeric-state.js";
import { meterStatuses, type MeterStatus } from "./meter-status.js";
import { circuitDocumentShapeIssue, copySimulationDocument, isSimulationRecord, simulationRecordEntries, simulationRecordField } from "./simulation-input.js";
import { readingPrecision, restoredComplex, type CircuitReadingPrecision, type CircuitTerminalVoltageDifference } from "./circuit-reading.js";
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
  /** Absorbed power for every solved bulb, including open, idle, and shorted circuits. */
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
function conductiveComponents(size: number, conductances: readonly Pick<Conductance, "a" | "b">[]) {
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
  loopBatteryIds: ReadonlySet<string>,
): SourceConstraintEdge[] {
  const edges: SourceConstraintEdge[] = document.wires.map((wire) => ({
    from: index.get(key(wire.from)) ?? -1,
    to: index.get(key(wire.to)) ?? -1,
    voltage: 0,
  }));
  for (const part of document.parts) {
    if (part.kind === "battery") {
      if (!loopBatteryIds.has(part.id)) { continue; }
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
  return { unknownByNode, count, components };
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

interface VoltageReferenceConstraint {
  from: number;
  to: number;
  limit: ExactRational;
}

function realizeStrictReferenceShifts(
  shifts: readonly ExactRational[],
  strictSteps: readonly number[],
  constraints: readonly VoltageReferenceConstraint[],
) {
  // Each symbolic shift is value - strictSteps * epsilon. Choose an exact
  // positive epsilon from the remaining slack, rather than a numerical tolerance.
  let epsilon = EXACT_ONE;
  for (const { from, to, limit } of constraints) {
    const excess = strictSteps[from]! - strictSteps[to]!;
    if (excess < 0) { continue; }
    const slack = subtractExactRational(limit, subtractExactRational(shifts[to]!, shifts[from]!));
    const bound = divideExactRational(slack, exactInput(excess + 1)!)!;
    if (subtractExactRational(bound, epsilon).numerator < 0n) { epsilon = bound; }
  }
  return shifts.map((shift, node) => subtractExactRational(shift,
    multiplyExactRational(epsilon, exactInput(strictSteps[node]!)!)));
}

/** Find shifts satisfying shift[to] - shift[from] < limit, or reject a negative cycle. */
function voltageReferenceShifts(size: number, constraints: readonly VoltageReferenceConstraint[]) {
  const shifts = Array.from({ length: size }, () => EXACT_ZERO);
  const strictSteps = Array.from({ length: size }, () => 0);
  for (let pass = 0; pass < size; pass += 1) {
    let changed = false;
    for (const { from, to, limit } of constraints) {
      const bound = addExactRational(shifts[from]!, limit);
      const order = subtractExactRational(shifts[to]!, bound).numerator;
      const steps = strictSteps[from]! + 1;
      if (order < 0n || (order === 0n && strictSteps[to]! >= steps)) { continue; }
      shifts[to] = bound;
      strictSteps[to] = steps;
      changed = true;
    }
    if (!changed) { return realizeStrictReferenceShifts(shifts, strictSteps, constraints); }
  }
  return null;
}

function fitFloatingVoltageReferences(
  voltages: ExactRational[],
  components: readonly number[],
  pairs: readonly Pick<Conductance, "a" | "b">[],
  affected: ReadonlySet<number>,
) {
  const local = new Map([...affected].map((component, position) => [component, position]));
  const reference = local.size;
  // Round-to-nearest stays finite strictly below MAX_VALUE + half an ULP.
  // The midpoint itself rounds to infinity; strict constraints preserve that
  // boundary while allowing exact values that round back to MAX_VALUE.
  const limit = addExactRational(exactInput(Number.MAX_VALUE)!, exactInput(2 ** 970)!);
  const constraints: VoltageReferenceConstraint[] = [];
  for (const [node, voltage] of voltages.entries()) {
    const component = local.get(components[node]!);
    if (component === undefined) { continue; }
    constraints.push(
      { from: reference, to: component, limit: subtractExactRational(limit, voltage) },
      { from: component, to: reference, limit: addExactRational(limit, voltage) },
    );
  }
  for (const { a, b } of pairs) {
    const from = local.get(components[a]!);
    const to = local.get(components[b]!);
    if (from === undefined || to === undefined || from === to) { continue; }
    const drop = subtractExactRational(voltages[a]!, voltages[b]!);
    constraints.push(
      { from: to, to: from, limit: subtractExactRational(limit, drop) },
      { from, to, limit: addExactRational(limit, drop) },
    );
  }
  const shifts = voltageReferenceShifts(local.size + 1, constraints);
  if (!shifts) { return voltages; }
  return voltages.map((voltage, node) => {
    const component = local.get(components[node]!);
    return component === undefined ? voltage
      : addExactRational(voltage, subtractExactRational(shifts[component]!, shifts[reference]!));
  });
}

function centerOverflowingVoltageComponents(
  voltages: ExactRational[],
  components: readonly number[],
  pairs: readonly Pick<Conductance, "a" | "b">[],
) {
  // A voltmeter or open switch does not conduct, but its displayed voltage
  // couples the arbitrary references. Correct the entire affected group so
  // shifting one island cannot overflow another floating reading.
  const groups = conductiveComponents(voltages.length, [
    ...components.map((a, b) => ({ a, b })), ...pairs,
  ]);
  const overflowing = new Set(groups.filter((_, node) => !Number.isFinite(exactRationalToNumber(voltages[node]!))));
  for (const { a, b } of pairs) {
    if (!Number.isFinite(exactNodeDifference(voltages, a, b, 0).value)) { overflowing.add(groups[a]!); }
  }
  if (overflowing.size === 0) { return voltages; }
  const bounds = new Map<number, { min: ExactRational; max: ExactRational }>();
  for (const [node, voltage] of voltages.entries()) {
    const component = components[node]!;
    if (!overflowing.has(groups[node]!)) { continue; }
    const range = bounds.get(component) ?? { min: voltage, max: voltage };
    if (subtractExactRational(voltage, range.min).numerator < 0n) { range.min = voltage; }
    if (subtractExactRational(voltage, range.max).numerator > 0n) { range.max = voltage; }
    bounds.set(component, range);
  }
  // Only legacy DC output uses this correction; internal resistance probes
  // retain their exact, possibly unbounded potentials. Conductive differences,
  // currents and powers are invariant under every component shift.
  const offsets = new Map([...bounds].map(([component, range]) => [component,
    multiplyExactRational(addExactRational(range.min, range.max), exactInput(0.5)!),
  ]));
  const centered = voltages.map((voltage, node) => {
    const offset = offsets.get(components[node]!);
    return offset ? subtractExactRational(voltage, offset) : voltage;
  });
  const overflowingPairs = pairs.filter(({ a, b }) => !Number.isFinite(exactNodeDifference(centered, a, b, 0).value));
  // A component too wide to center, or a physical voltage outside the range,
  // cannot be repaired by changing its reference. Keep the normal rejection.
  if (centered.some((voltage) => !Number.isFinite(exactRationalToNumber(voltage))) ||
    overflowingPairs.length === 0 || overflowingPairs.some(({ a, b }) => components[a] === components[b])) { return centered; }
  // Centering is usually sufficient. Otherwise solve all terminal and floating
  // difference bounds together, including constraints imposed by other meters.
  return fitFloatingVoltageReferences(centered, components, pairs, new Set(bounds.keys()));
}

function nodeVoltageReadings(exactVoltages: ExactRational[]) {
  return {
    voltages: exactVoltages.map(exactRationalToNumber),
    exactVoltages,
    difference: (from: number, to: number, offset = 0) =>
      exactNodeDifference(exactVoltages, from, to, offset),
  };
}

/** Solve conductance nodal equations with one exact reference per component. */
function nodeVoltages(
  size: number,
  conductances: readonly Conductance[],
  currentSource?: { from: number; to: number; amps: number },
) {
  const { unknownByNode, count, components } = nodalUnknownIndices(size, conductances);
  const matrix = new Float64Array(count * count);
  const rhs = new Float64Array(count);
  for (const branch of conductances) {
    if (!stampConductanceBranch(matrix, rhs, count, unknownByNode, branch)) { return null; }
  }
  if (currentSource && !stampCurrentSource(rhs, unknownByNode, currentSource)) { return null; }
  const solution = solveExactRealLinearSystem(count, exactRealStateInput(matrix), exactRealStateInput(rhs));
  if (!solution) { return null; }
  const unshiftedVoltages = Array.from({ length: size }, () => EXACT_ZERO);
  for (let node = 0; node < size; node += 1) {
    const unknown = unknownByNode[node] ?? -1;
    if (unknown >= 0) {
      const value = solution[unknown];
      if (!value) { return null; }
      unshiftedVoltages[node] = value;
    }
  }
  return { ...nodeVoltageReadings(unshiftedVoltages), components };
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
  const absorbsPower = part.kind !== "battery" && ohms !== null;
  const deliversPower = part.kind === "battery";
  const exactPower = (absorbsPower || deliversPower) && voltageExact && currentExact
    ? multiplyExactRational(voltageExact, currentExact) : null;
  let powerWatts = 0;
  if (exactPower) {
    powerWatts = exactRationalToNumber(deliversPower ? negateExact(exactPower) : exactPower);
  } else if (absorbsPower || deliversPower) {
    powerWatts = voltageVolts * currentAmps * (deliversPower ? -1 : 1);
  }
  if (part.kind !== "bulb") { return { voltageVolts, currentAmps, powerWatts }; }
  const rated = part.ratedPowerWatts ?? 2;
  const relativePower = exactPower ? exactRationalToNumber(divideExactRational(exactPower, exactInput(rated)!)!) : powerWatts / rated;
  return { voltageVolts, currentAmps, powerWatts, brightness: Math.min(1, relativePower) };
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
  solved: ReturnType<typeof nodeVoltageReadings>,
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

function shortedBatteryByPassiveResistance(
  batteries: readonly CircuitPart[],
  readings: Map<string, ExactBatteryReading>,
  index: Map<string, number>,
  protectedBatteryIds: Set<string>,
  passiveNetwork: ReturnType<typeof passiveComponentsByNode>,
  checkedParallelBatteryIds: ReadonlySet<string>,
) {
  const threshold = exactInput(SHORT_OHMS);
  if (!threshold) { return; }
  return batteries.find((battery) => {
    if (protectedBatteryIds.has(battery.id) || checkedParallelBatteryIds.has(battery.id)) { return false; }
    const reading = readings.get(battery.id);
    if (!reading || reading.current.numerator === 0n) { return false; }
    const from = index.get(`${battery.id}:a`)!;
    const to = index.get(`${battery.id}:b`)!;
    const component = passiveNetwork.components[from]!;
    if (component !== passiveNetwork.components[to]) { return false; }
    // Other batteries can cancel this cell's terminal voltage. Measure only
    // its passive return; |Vterminal/Icell| is not a resistance in that case.
    const resistance = externalResistanceExact(
      passiveNetwork.nodesByComponent.get(component) ?? [],
      passiveNetwork.conductancesByComponent.get(component) ?? [],
      from,
      to,
    );
    return resistance !== null && subtractExactRational(resistance, threshold).numerator < 0n;
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
  /** Original paired cell ports of a reduced series branch. */
  sourceEdges?: readonly PassiveBatteryEdge[];
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
  junctions?: ReadonlySet<number>,
) {
  let component = startComponent;
  let edgeIndex = firstEdge;
  let emf = EXACT_ZERO;
  let exactSeriesResistance = EXACT_ZERO;
  const sourceEdges: PassiveBatteryEdge[] = [];
  const first = edges[firstEdge]!;
  const fromNode = first.fromComponent === startComponent ? first.fromNode : first.toNode;
  while (!visited.has(edgeIndex)) {
    visited.add(edgeIndex);
    const edge = edges[edgeIndex]!;
    sourceEdges.push(...edge.sourceEdges ?? [edge]);
    const forward = edge.fromComponent === component;
    const leavingNode = forward ? edge.toNode : edge.fromNode;
    emf = subtractExactRational(emf, exactInput((forward ? -1 : 1) * (edge.battery.voltageVolts ?? 0))!);
    component = forward ? edge.toComponent : edge.fromComponent;
    const neighbors = incident.get(component) ?? [];
    if (neighbors.length !== 2 || junctions?.has(component)) {
      return { ...edges[firstEdge]!, fromComponent: startComponent, toComponent: component, fromNode, toNode: leavingNode, emf,
        exactSeriesResistance, seriesResistance: exactRationalToNumber(exactSeriesResistance), sourceEdges };
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
  junctions?: ReadonlySet<number>,
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
    if (neighbors.length <= 2 && !junctions?.has(component)) { continue; }
    for (const index of neighbors) {
      if (visited.has(index)) { continue; }
      const path = seriesBatteryPath(edges, incident, component, index, visited, nodesByComponent, conductancesByComponent, junctions);
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

interface SourceOutputMacro {
  passive: Conductance[];
  sources: PassiveBatteryEdge[];
  from: boolean;
  to: boolean;
}

interface CommonSourceOutput {
  from: number;
  to: number;
  sources: SourceOutputMacro[];
  load: Conductance[];
  loadResistance?: ExactRational | null;
  minimumSourceResistance?: ExactRational | null;
  responses?: Map<string, { resistance: ExactRational; voltage: ExactRational } | null>;
}

function sourceOutputMacros(
  size: number,
  passive: readonly Conductance[],
  sources: readonly PassiveBatteryEdge[],
  from: number,
  to: number,
) {
  const boundary = (node: number) => node === from || node === to;
  const connections = [
    ...passive,
    ...sources.map((edge) => ({ a: edge.fromNode, b: edge.toNode })),
  ];
  const components = conductiveComponents(size, connections.filter((edge) => !boundary(edge.a) && !boundary(edge.b)));
  const macros = new Map<number, SourceOutputMacro>();
  let direct = size;
  const macroFor = (a: number, b: number) => {
    const component = !boundary(a) ? components[a]! : !boundary(b) ? components[b]! : direct++;
    const macro = macros.get(component) ?? { passive: [], sources: [], from: false, to: false };
    macro.from ||= a === from || b === from;
    macro.to ||= a === to || b === to;
    macros.set(component, macro);
    return macro;
  };
  for (const edge of passive) { macroFor(edge.a, edge.b).passive.push(edge); }
  for (const edge of sources) { macroFor(edge.fromNode, edge.toNode).sources.push(edge); }
  return [...macros.values()].filter((macro) => macro.from && macro.to);
}

function sourceOutputCut(size: number, passive: readonly Conductance[], sources: readonly PassiveBatteryEdge[], from: number, to: number) {
  const branches = sourceOutputMacros(size, passive, sources, from, to);
  const sourceMacros = branches.filter((macro) => macro.sources.length > 0);
  const load = branches.filter((macro) => macro.sources.length === 0).flatMap((macro) => macro.passive);
  return sourceMacros.length > 0 && load.length > 0 ? { from, to, sources: sourceMacros, load } : null;
}

function sourceBoundaryBlock(edges: readonly { a: number; b: number }[], from: number, to: number) {
  const incident = new Map<number, number[]>();
  for (const [index, edge] of edges.entries()) {
    for (const node of [edge.a, edge.b]) {
      const neighbors = incident.get(node) ?? [];
      neighbors.push(index);
      incident.set(node, neighbors);
    }
  }
  const discovered = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  let boundaryBlock: Set<number> | undefined;
  const record = (last: number) => {
    const block = new Set<number>();
    let hasFrom = false;
    let hasTo = false;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const edge = edges[index]!;
      block.add(index);
      hasFrom ||= edge.a === from || edge.b === from;
      hasTo ||= edge.a === to || edge.b === to;
      if (index === last) { break; }
    }
    if (hasFrom && hasTo) { boundaryBlock = block; }
  };
  const visit = (node: number, parent: number) => {
    const order = discovered.size;
    discovered.set(node, order);
    low.set(node, order);
    for (const index of incident.get(node) ?? []) {
      if (index === parent) { continue; }
      const edge = edges[index]!;
      const next = edge.a === node ? edge.b : edge.a;
      const nextOrder = discovered.get(next);
      if (nextOrder === undefined) {
        stack.push(index);
        visit(next, index);
        const nextLow = low.get(next)!;
        low.set(node, Math.min(low.get(node)!, nextLow));
        if (nextLow >= order) { record(index); }
      } else if (nextOrder < order) {
        stack.push(index);
        low.set(node, Math.min(low.get(node)!, nextOrder));
      }
    }
  };
  visit(from, -1);
  return boundaryBlock;
}

interface SourceBoundaryFlowEdge {
  node: number;
  reverse: number;
  capacity: number;
}

function augmentSourceBoundaryPath(adjacent: SourceBoundaryFlowEdge[][], supply: number, sink: number) {
  const parent = new Map<number, { node: number; edge: number }>();
  const queue = [supply];
  for (let head = 0; head < queue.length && !parent.has(sink); head += 1) {
    const node = queue[head]!;
    for (const [edge, next] of adjacent[node]!.entries()) {
      if (next.capacity <= 0 || next.node === supply || parent.has(next.node)) { continue; }
      parent.set(next.node, { node, edge });
      queue.push(next.node);
    }
  }
  if (!parent.has(sink)) { return false; }
  for (let node = sink; node !== supply;) {
    const previous = parent.get(node)!;
    const edge = adjacent[previous.node]![previous.edge]!;
    edge.capacity -= 1;
    adjacent[node]![edge.reverse]!.capacity += 1;
    node = previous.node;
  }
  return true;
}

function sourceBoundaryPaths(passive: readonly Conductance[], ports: ReadonlySet<number>, starts: readonly number[], target: number, other: number, occupied: ReadonlySet<number>) {
  const allowed = (node: number) => node !== other && !occupied.has(node) && (node === target || starts.includes(node) || !ports.has(node));
  if (starts.some((node) => !allowed(node))) { return null; }
  const edges = passive.filter((edge) => allowed(edge.a) && allowed(edge.b));
  const nodes = [...new Set([target, ...starts, ...edges.flatMap((edge) => [edge.a, edge.b])])];
  const local = new Map(nodes.map((node, position) => [node, position]));
  const supply = nodes.length * 2;
  const sink = local.get(target)! * 2 + 1;
  const adjacent = Array.from({ length: supply + 1 }, () => [] as SourceBoundaryFlowEdge[]);
  const connect = (a: number, b: number, capacity: number) => {
    adjacent[a]!.push({ node: b, reverse: adjacent[b]!.length, capacity });
    adjacent[b]!.push({ node: a, reverse: adjacent[a]!.length - 1, capacity: 0 });
  };
  for (const [position, node] of nodes.entries()) { connect(position * 2, position * 2 + 1, node === target ? starts.length : 1); }
  for (const edge of edges) {
    const a = local.get(edge.a)! * 2;
    const b = local.get(edge.b)! * 2;
    if (a === b) { continue; }
    connect(a + 1, b, starts.length);
    connect(b + 1, a, starts.length);
  }
  for (const node of starts) { connect(supply, local.get(node)! * 2, 1); }
  // Integer capacities count paths only; they never approximate resistance.
  // Residual rerouting is essential for diamonds, where a greedy first path
  // can consume the other driver's only outlet.
  if (!starts.every(() => augmentSourceBoundaryPath(adjacent, supply, sink))) { return null; }
  return new Set(nodes.filter((node, position) => node !== target && adjacent[position * 2]![0]!.capacity === 0));
}

function sourceBoundaryPairPaths(passive: readonly Conductance[], ports: ReadonlySet<number>, starts: readonly number[], returns: readonly number[], from: number, to: number) {
  const outgoing = sourceBoundaryPaths(passive, ports, starts, from, to, new Set());
  // The two return paths must also avoid the actual outgoing witnesses.
  // Separate reachability on each side alone can reuse an internal hub on
  // opposite sides and silently place both sources in one serial column.
  return outgoing !== null && sourceBoundaryPaths(passive, ports, returns, to, from, outgoing) !== null;
}

function pairedSourceBoundaryPaths(output: CommonSourceOutput, passive: readonly Conductance[], ports: ReadonlySet<number>, sourceBranches: readonly PassiveBatteryEdge[]) {
  const firstComponent = sourceBranches[0]!.fromComponent;
  const ends = sourceBranches.map((branch) => branch.fromComponent === firstComponent
    ? [branch.fromNode, branch.toNode] as const : [branch.toNode, branch.fromNode] as const);
  // Two cells in the same series column are not two drivers. Require the
  // same pair of original strings to reach each boundary independently,
  // with consistent source orientation and no other selected cell ports.
  // This also prevents an unequal bridge or a partial ballast from being
  // substituted for the actual common load in the physical port response.
  for (const [position, first] of ends.entries()) {
    for (const second of ends.slice(position + 1)) {
      for (const [from, to] of [[output.from, output.to], [output.to, output.from]]) {
        const starts = [first[0], second[0]];
        const returns = [first[1], second[1]];
        if (sourceBoundaryPairPaths(passive, ports, starts, returns, from!, to!) ||
          sourceBoundaryPairPaths(passive, ports, returns, starts, to!, from!)) { return true; }
      }
    }
  }
  return false;
}

function independentSourceOutputBoundary(output: CommonSourceOutput, selected: ReadonlySet<string>, sourceBranches: readonly PassiveBatteryEdge[]) {
  if (sourceBranches.length < 2) { return false; }
  const sources = output.sources.flatMap((macro) => macro.sources).filter((edge) => selected.has(edge.battery.id));
  const passive = output.sources.flatMap((macro) => macro.passive);
  const connections = [...passive, ...sources.map((edge) => ({ a: edge.fromNode, b: edge.toNode }))];
  // Both outputs and every selected cell must belong to the same vertex
  // block on the source side. A common return articulating a partial load
  // cut fails this test; passive hubs and diamonds do not need to be opened.
  const block = sourceBoundaryBlock(connections, output.from, output.to);
  if (!block || sources.some((_, index) => !block.has(passive.length + index))) { return false; }
  const ports = new Set(sources.flatMap((edge) => [edge.fromNode, edge.toNode]));
  const covered = new Set<string>();
  for (const branch of sourceBranches) {
    for (const source of branch.sourceEdges ?? [branch]) { covered.add(source.battery.id); }
    // Keep the original series string paired. Its two ends must lie on a
    // simple output-to-output path without borrowing any other cell's ports
    // or its own series midpoint. Adding a closing output edge makes exactly
    // those paths a vertex block, including degree-two driver conductors.
    const allowed = (node: number) => node === output.from || node === output.to ||
      node === branch.fromNode || node === branch.toNode || !ports.has(node);
    const path = passive.filter((edge) => allowed(edge.a) && allowed(edge.b));
    const branchIndex = path.length;
    const paired = [...path, { a: branch.fromNode, b: branch.toNode }, { a: output.from, b: output.to }];
    if (!sourceBoundaryBlock(paired, output.from, output.to)?.has(branchIndex)) { return false; }
  }
  return [...selected].every((id) => covered.has(id)) && pairedSourceBoundaryPaths(output, passive, ports, sourceBranches);
}

function commonSourceOutputs(
  batteries: readonly CircuitPart[],
  index: Map<string, number>,
  passive: readonly Conductance[],
  components: number[],
) {
  const { edges } = batteryEdgesByPassiveComponent(batteries, index, components);
  const degree = Array.from({ length: index.size }, () => 0);
  for (const edge of passive) { degree[edge.a]! += 1; degree[edge.b]! += 1; }
  for (const edge of edges) { degree[edge.fromNode]! += 1; degree[edge.toNode]! += 1; }
  const junctions = degree.flatMap((count, node) => count >= 3 ? [node] : []);
  const outputs: CommonSourceOutput[] = [];
  // Degree-two nodes cannot separate independent source branches and a load.
  // Only discovery uses this graph. Every physical wire, including shared
  // 1 µΩ output leads, stays in the response measured at the actual cut nodes.
  for (const [position, from] of junctions.entries()) {
    for (const to of junctions.slice(position + 1)) {
      const output = sourceOutputCut(index.size, passive, edges, from, to);
      if (output) { outputs.push(output); }
    }
  }
  return outputs;
}

function sourceOutputResponse(macro: SourceOutputMacro, selected: ReadonlySet<string>, from: number, to: number) {
  const nodes = [...new Set([from, to, ...macro.passive.flatMap((edge) => [edge.a, edge.b]),
    ...macro.sources.flatMap((edge) => [edge.fromNode, edge.toNode])])];
  const local = new Map(nodes.map((node, position) => [node, position]));
  const sourceEdges = macro.sources.filter((edge) => selected.has(edge.battery.id));
  const tree = sourceConstraintTree(nodes.length, sourceEdges.map((edge) => ({
    from: local.get(edge.fromNode)!, to: local.get(edge.toNode)!, voltage: -edge.battery.voltageVolts!,
  })));
  const offsets = nodes.map((_, node) => exactSourcePotential(tree, node));
  const branches = macro.passive.map((edge) => {
    const a = local.get(edge.a)!;
    const b = local.get(edge.b)!;
    return { ...edge, a: tree.component[a]!, b: tree.component[b]!,
      exactVoltage: subtractExactRational(offsets[b]!, offsets[a]!) };
  });
  const a = local.get(from)!;
  const b = local.get(to)!;
  const rootA = tree.component[a]!;
  const rootB = tree.component[b]!;
  const network = reducedSourceResponseNetwork(branches, rootA, rootB);
  const suppressed = network.branches.map((edge) => ({ ...edge, exactVoltage: EXACT_ZERO }));
  const connected = conductiveComponents(network.size, suppressed);
  if (connected[network.from] !== connected[network.to]) { return null; }
  const resistance = externalResistanceExact(Array.from({ length: network.size }, (_, node) => node), suppressed, network.from, network.to);
  const solved = nodeVoltages(network.size, network.branches);
  const voltage = solved && exactDifferenceValue(solved.difference(network.from, network.to));
  if (resistance === null || !voltage) { return null; }
  return { resistance, voltage: subtractExactRational(voltage, subtractExactRational(offsets[b]!, offsets[a]!)) };
}

function sourceResponseSeriesBranch(first: Conductance, second: Conductance, node: number): Conductance {
  const a = first.a === node ? first.b : first.a;
  const b = second.a === node ? second.b : second.a;
  const resistance = subtractExactRational(first.exactResistance ?? exactInput(first.resistanceOhms)!,
    negateExact(second.exactResistance ?? exactInput(second.resistanceOhms)!));
  const firstVoltage = first.exactVoltage ?? exactInput(first.voltage ?? 0)!;
  const secondVoltage = second.exactVoltage ?? exactInput(second.voltage ?? 0)!;
  const voltage = subtractExactRational(first.a === a ? firstVoltage : negateExact(firstVoltage),
    negateExact(second.a === node ? secondVoltage : negateExact(secondVoltage)));
  const resistanceOhms = exactRationalToNumber(resistance);
  return { a, b, resistanceOhms, g: 1 / resistanceOhms, exactResistance: resistance, exactVoltage: voltage };
}

function reducedSourceResponseNetwork(branches: readonly Conductance[], from: number, to: number) {
  const adjacent = new Map<number, Set<Conductance>>();
  const pending: number[] = [];
  const add = (edge: Conductance) => {
    if (edge.a === edge.b) { return; }
    for (const node of [edge.a, edge.b]) {
      const neighbors = adjacent.get(node) ?? new Set<Conductance>();
      neighbors.add(edge);
      adjacent.set(node, neighbors);
    }
  };
  const remove = (edge: Conductance) => {
    for (const node of [edge.a, edge.b]) {
      adjacent.get(node)!.delete(edge);
      pending.push(node);
    }
  };
  for (const edge of branches) { add(edge); }
  pending.push(...adjacent.keys());
  // This network is used only for the two output experiments. No current
  // is injected at an interior node: KCL eliminates a leaf with zero branch
  // current, or combines two series branches with exact R and oriented EMF.
  // Self-loops (including suppressed private returns) have zero net nodal
  // injection. Preserve both output nodes and every hub/parallel route.
  for (const node of pending) {
    if (node === from || node === to) { continue; }
    const neighbors = [...adjacent.get(node) ?? []];
    if (neighbors.length === 1) { remove(neighbors[0]!); }
    if (neighbors.length !== 2) { continue; }
    const first = neighbors[0]!;
    const second = neighbors[1]!;
    const combined = sourceResponseSeriesBranch(first, second, node);
    remove(first);
    remove(second);
    add(combined);
  }
  const edges = [...new Set([...adjacent.values()].flatMap((neighbors) => [...neighbors]))];
  const nodes = [...new Set([from, to, ...edges.flatMap((edge) => [edge.a, edge.b])])];
  const local = new Map(nodes.map((node, position) => [node, position]));
  return { size: nodes.length, from: local.get(from)!, to: local.get(to)!,
    branches: edges.map((edge) => ({ ...edge, a: local.get(edge.a)!, b: local.get(edge.b)! })) };
}

function coveredUntappedBatteryReturns(output: CommonSourceOutput, driven: readonly SourceOutputMacro[], resistance: ExactRational, checkedBatteryIds: Set<string>) {
  if (subtractExactRational(resistance, exactInput(SHORT_OHMS)!).numerator < 0n) { return; }
  // Only untapped single-cell branches are covered by this lower resistance.
  // A tapped macro can have a private passive return even at zero output EMF;
  // its individual return must still be checked by the existing local guard.
  for (const macro of driven) {
    if (macro.sources.length !== 1) { continue; }
    const passiveNodes = [...new Set([output.from, output.to, ...macro.passive.flatMap((edge) => [edge.a, edge.b])])];
    const local = new Map(passiveNodes.map((node, position) => [node, position]));
    const components = conductiveComponents(passiveNodes.length, macro.passive.map((edge) => ({ a: local.get(edge.a)!, b: local.get(edge.b)! })));
    if (components[local.get(output.from)!] !== components[local.get(output.to)!]) {
      checkedBatteryIds.add(macro.sources[0]!.battery.id);
    }
  }
}

function commonSourceOutputResistance(output: CommonSourceOutput, selected: ReadonlySet<string>, checkedBatteryIds: Set<string>, sourceBranches?: readonly PassiveBatteryEdge[]) {
  const driven = output.sources.filter((macro) => macro.sources.some((edge) => selected.has(edge.battery.id)));
  // Passive bridges can join multiple source branches into one component.
  // Its paired-port response still measures the common output, including
  // series strings, without treating private dissipation as load power.
  if (selected.size < 2 || driven.length === 0) { return null; }
  const present = new Set(driven.flatMap((macro) => macro.sources.map((edge) => edge.battery.id)));
  if ([...selected].some((id) => !present.has(id))) { return null; }
  if (driven.length === 1 && !independentSourceOutputBoundary(output, selected,
    sourceBranches ?? driven[0]!.sources.filter((edge) => selected.has(edge.battery.id)))) { return null; }
  const responseKey = JSON.stringify([...selected].sort());
  const responses = output.responses ?? new Map();
  output.responses = responses;
  // The physical response depends on the selected cells, not their
  // discovery partition. Keep the original paired boundary proof above
  // outside this cache: a rejected pairing must never cover a valid one.
  let combined = responses.get(responseKey);
  if (combined === undefined) {
    combined = combinedSourceOutputResponse(output, selected, driven);
    responses.set(responseKey, combined);
  }
  if (!combined) { return null; }
  const loadResistance = commonSourceLoadResistance(output);
  if (loadResistance === null) { return null; }
  const resistance = subtractExactRational(combined.resistance, negateExact(loadResistance));
  coveredUntappedBatteryReturns(output, driven, resistance, checkedBatteryIds);
  return { resistance, voltage: combined.voltage };
}

function commonSourceLoadResistance(output: CommonSourceOutput) {
  if (output.loadResistance === undefined) {
    const nodes = [...new Set([output.from, output.to, ...output.load.flatMap((edge) => [edge.a, edge.b])])];
    output.loadResistance = externalResistanceExact(nodes, output.load, output.from, output.to);
  }
  return output.loadResistance;
}

function commonSourceOutputCanShort(output: CommonSourceOutput) {
  const resistance = commonSourceLoadResistance(output);
  // Suppressed ideal cells and passive source-side branches have Rout >= 0.
  // Measure the entire parallel load before pruning: individual high-R
  // paths can combine below the threshold. Local and circulating shorts
  // remain separate checks and do not use this output-load bound.
  if (resistance === null || subtractExactRational(resistance, exactInput(SHORT_OHMS)!).numerator >= 0n) { return false; }
  const sourceResistance = minimumSourceOutputResistance(output);
  return sourceResistance === null || subtractExactRational(
    subtractExactRational(resistance, negateExact(sourceResistance)), exactInput(SHORT_OHMS)!,
  ).numerator < 0n;
}

function minimumSourceOutputResistance(output: CommonSourceOutput) {
  if (output.minimumSourceResistance !== undefined) { return output.minimumSourceResistance; }
  const passive = output.sources.flatMap((macro) => macro.passive);
  const sources = output.sources.flatMap((macro) => macro.sources);
  const nodes = [...new Set([output.from, output.to, ...passive.flatMap((edge) => [edge.a, edge.b]),
    ...sources.flatMap((edge) => [edge.fromNode, edge.toNode])])];
  const local = new Map(nodes.map((node, position) => [node, position]));
  // Shorting every ideal cell adds connections to any selected-cell Rout
  // experiment, in which unselected cells are open. Rayleigh monotonicity
  // therefore bounds every subset from below, without using its EMF,
  // internal resistance, private dissipation or a discovery partition.
  const components = conductiveComponents(nodes.length, sources.map((edge) => ({
    a: local.get(edge.fromNode)!, b: local.get(edge.toNode)!,
  })));
  const branches = passive.map((edge) => ({ ...edge,
    a: components[local.get(edge.a)!]!, b: components[local.get(edge.b)!]!, exactVoltage: EXACT_ZERO,
  }));
  const network = reducedSourceResponseNetwork(branches, components[local.get(output.from)!]!, components[local.get(output.to)!]!);
  output.minimumSourceResistance = externalResistanceExact(Array.from({ length: network.size }, (_, node) => node),
    network.branches, network.from, network.to);
  return output.minimumSourceResistance;
}

function coveredHighResistanceOutputReturns(size: number, outputs: readonly CommonSourceOutput[], checkedBatteryIds: Set<string>) {
  for (const output of outputs) {
    const resistance = commonSourceLoadResistance(output);
    if (resistance === null || subtractExactRational(resistance, exactInput(SHORT_OHMS)!).numerator < 0n) { continue; }
    const passive = output.sources.flatMap((macro) => macro.passive);
    const components = conductiveComponents(size, passive);
    // With every cell open, a source-side passive return could bypass the
    // load (including a private shunt or an unselected macro's conductors).
    // Only when no such return exists does each untapped single-cell path
    // necessarily include the full common load and inherit its lower bound.
    if (components[output.from] === components[output.to]) { continue; }
    coveredUntappedBatteryReturns(output, output.sources, resistance, checkedBatteryIds);
  }
}

function combinedSourceOutputResponse(output: CommonSourceOutput, selected: ReadonlySet<string>, driven: readonly SourceOutputMacro[]) {
  let conductance = EXACT_ZERO;
  let current = EXACT_ZERO;
  let idealVoltage: ExactRational | undefined;
  for (const macro of output.sources) {
    const response = sourceOutputResponse(macro, selected, output.from, output.to);
    if (!response) {
      if (driven.includes(macro)) { return null; }
      continue; // Unselected cells are open; their real passive branches remain.
    }
    if (response.resistance.numerator === 0n) {
      if (idealVoltage && subtractExactRational(idealVoltage, response.voltage).numerator !== 0n) { return null; }
      idealVoltage = response.voltage;
    } else {
      const g = divideExactRational(EXACT_ONE, response.resistance)!;
      conductance = subtractExactRational(conductance, negateExact(g));
      current = subtractExactRational(current, negateExact(multiplyExactRational(g, response.voltage)));
    }
  }
  const outputResistance = idealVoltage ? EXACT_ZERO : divideExactRational(EXACT_ONE, conductance);
  const outputVoltage = idealVoltage ?? (outputResistance && multiplyExactRational(current, outputResistance));
  if (!outputResistance || !outputVoltage) { return null; }
  return { resistance: outputResistance, voltage: outputVoltage };
}

function pairedBatteryGroupSignature(group: ParallelBatteryGroup) {
  const branches = group.edges.map((edge, position) => ({
    from: group.fromNodes[position]!,
    to: group.toNodes[position]!,
    sources: (edge.sourceEdges ?? [edge]).map((source) => source.battery.id).sort(),
  }));
  const signature = (reversePorts: boolean) => JSON.stringify(branches.map((branch) => JSON.stringify([
    reversePorts ? branch.to : branch.from,
    reversePorts ? branch.from : branch.to,
    branch.sources,
  ])).sort());
  const forward = signature(false);
  const reverse = signature(true);
  return forward < reverse ? forward : reverse;
}

function shortedParallelBatteryLoads(
  block: readonly PassiveBatteryEdge[],
  outputs: readonly CommonSourceOutput[],
  testedGroups: Set<string>,
  checkedBatteryIds: Set<string>,
) {
  for (const group of parallelBatteryPairs(block).flatMap((parallel) => parallel.groups)) {
    const first = group.edges[0]!;
    const emf = first.emf ?? exactInput(first.battery.voltageVolts ?? 0)!;
    if (group.edges.length < 2 || emf.numerator === 0n) { continue; }
    const selected = new Set(group.edges.flatMap((edge) => (edge.sourceEdges ?? [edge]).map((source) => source.battery.id)));
    // Boundary rejection depends on the paired outer ports and original
    // series membership, not just the selected cell IDs. A different split
    // of the same source loop must still reach the strict boundary proof.
    const signature = pairedBatteryGroupSignature(group);
    if (testedGroups.has(signature)) { continue; }
    testedGroups.add(signature);
    for (const output of outputs) {
      if (!commonSourceOutputCanShort(output)) { continue; }
      const response = commonSourceOutputResistance(output, selected, checkedBatteryIds, group.edges);
      // Local source/shunt dissipation and macro current distribution are
      // absent from this metric: suppress paired sources for Rout, then add
      // the common passive load. A zero open-circuit output cannot drive it.
      if (response && response.voltage.numerator !== 0n &&
        subtractExactRational(response.resistance, exactInput(SHORT_OHMS)!).numerator < 0n) {
        return first.battery;
      }
    }
  }
}

function shortedReducedSourceLoads(
  loop: readonly PassiveBatteryEdge[],
  network: ReturnType<typeof passiveComponentsByNode>,
  outputs: readonly CommonSourceOutput[],
  testedGroups: Set<string>,
  testedOutputs: Map<CommonSourceOutput, Set<string>>,
  checkedBatteryIds: Set<string>,
  junctions?: readonly number[],
) {
  const reduced = reducedBatteryBlock(loop, network.nodesByComponent, network.conductancesByComponent,
    subnetworkJunctionComponents(network.components, junctions));
  const reducedShort = shortedParallelBatteryLoads(reduced, outputs, testedGroups, checkedBatteryIds);
  if (reducedShort) { return reducedShort; }
  // Raw parallel cell groups were already checked with these paired ports;
  // only a loop containing series interiors needs alternative restoration.
  if (new Set(loop.flatMap((edge) => [edge.fromComponent, edge.toComponent])).size < 3) { return; }
  for (const output of outputs) {
    if (!commonSourceOutputCanShort(output)) { continue; }
    const [fromRoots, toRoots] = sourceOutputRootComponents(output, loop, network.components);
    const tested = testedOutputs.get(output) ?? new Set<string>();
    testedOutputs.set(output, tested);
    for (const from of fromRoots) {
      for (const to of toRoots) {
        if (from === to) { continue; }
        // Discovery cuts can isolate the actual outputs or mark a private
        // series midpoint as a junction. Restore at physically reachable
        // outer cell ports; the original paired strings must still pass the
        // strict independent boundary proof on the full source-side network.
        const strings = reducedBatteryBlock(loop, network.nodesByComponent, network.conductancesByComponent, new Set([from, to]));
        const shorted = shortedParallelBatteryLoads(strings, [output], tested, checkedBatteryIds);
        if (shorted) { return shorted; }
      }
    }
  }
}

function sourceOutputRootComponents(output: CommonSourceOutput, loop: readonly PassiveBatteryEdge[], components: readonly number[]) {
  const ports = new Set(loop.flatMap((edge) => (edge.sourceEdges ?? [edge]).flatMap((source) => [source.fromNode, source.toNode])));
  const adjacent = new Map<number, number[]>();
  // Use only the physical source side: traversing the common load would
  // leak into the opposite output and turn interior cell ports into roots.
  for (const edge of output.sources.flatMap((macro) => macro.passive)) {
    for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
      const neighbors = adjacent.get(from) ?? [];
      neighbors.push(to);
      adjacent.set(from, neighbors);
    }
  }
  const reachable = (start: number, other: number) => {
    const roots = new Set<number>();
    const visited = new Set([start]);
    const queue = [start];
    for (const node of queue) {
      if (ports.has(node)) {
        roots.add(components[node]!);
        if (node !== start) { continue; }
      }
      for (const next of adjacent.get(node) ?? []) {
        if (next === other || visited.has(next)) { continue; }
        visited.add(next);
        queue.push(next);
      }
    }
    return roots;
  };
  // At most one root per selected port component on each side, followed by
  // a bounded Cartesian product; no source-edge or passive-path enumeration.
  return [reachable(output.from, output.to), reachable(output.to, output.from)] as const;
}

function shortedCommonRailBatteryLoads(
  batteries: readonly CircuitPart[],
  index: Map<string, number>,
  passive: readonly Conductance[],
  outputs: readonly CommonSourceOutput[],
  testedGroups: Set<string>,
  checkedBatteryIds: Set<string>,
) {
  const rails = conductiveComponents(index.size, passive.filter((edge) => edge.resistanceOhms === IDEAL_OHMS));
  const portsByRail = new Map<number, number>();
  for (const battery of batteries) {
    for (const terminal of ["a", "b"] as const) {
      const rail = rails[index.get(`${battery.id}:${terminal}`)!]!;
      portsByRail.set(rail, (portsByRail.get(rail) ?? 0) + 1);
    }
  }
  for (const [rail, ports] of portsByRail) {
    if (ports < 2) { continue; }
    // Removing a shared conductor rail prevents loads and taps from joining
    // the two source sides. The other ports can then be grouped through their
    // real ballasts regardless of how those values compare with the load.
    const remaining = passive.filter((edge) => rails[edge.a] !== rail && rails[edge.b] !== rail);
    const components = conductiveComponents(index.size, remaining);
    for (const [node, component] of rails.entries()) {
      if (component === rail) { components[node] = index.size; }
    }
    const graph = batteryEdgesByPassiveComponent(batteries, index, components);
    const attached = graph.edges.filter((edge) => (edge.fromComponent === index.size) !== (edge.toComponent === index.size));
    const shorted = shortedParallelBatteryLoads(attached, outputs, testedGroups, checkedBatteryIds);
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
  outputs: readonly CommonSourceOutput[],
) {
  const selected = new Set((batteriesByGroup.get(group) ?? []).map((battery) => battery.id));
  let hasOutput = false;
  let outputResistance: ExactRational | null = null;
  for (const output of outputs) {
    const response = commonSourceOutputResistance(output, selected, new Set());
    if (!response) { continue; }
    hasOutput = true;
    if (response.voltage.numerator !== 0n && (outputResistance === null ||
      subtractExactRational(response.resistance, outputResistance).numerator < 0n)) {
      outputResistance = response.resistance;
    }
  }
  // Wires can put tapped cells into the same ideal source-constraint group.
  // That does not turn their private losses into common output load power.
  if (hasOutput) { return outputResistance; }
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
  outputs: readonly CommonSourceOutput[],
) {
  const results = new Map<number, boolean>();
  for (const group of sourceGroups) {
    if ((batteriesByGroup.get(group)?.length ?? 0) < 2 || sourceTree.inconsistent.has(group)) { continue; }
    const resistance = sourceGroupExternalResistance(group, batteriesByGroup, index, sourceTree, passive, outputs);
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
  outputs: readonly CommonSourceOutput[],
) {
  const groupedResults = multiSourceGroupShorts(new Set([...groups.values()].map((group) => group.sourceGroup)),
    batteriesByGroup, index, sourceTree, passive, outputs);
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
  // A bridge source carries no loop current. Its EMF must not enlarge the
  // normalized voltage span or suppress a connected source's load check.
  const loopBatteries = batteries.filter((battery) => hasExternalBatteryPath(
    index.size, conductances, battery.id, index.get(`${battery.id}:a`)!, index.get(`${battery.id}:b`)!,
  ));
  const readings = exactBatteryReadings(loopBatteries, index, solved);
  const passive = conductances.filter(({ batteryId }) => batteryId === undefined);
  const passiveNetwork = passiveComponentsByNode(index.size, passive);
  const seriesLoop = shortedSeriesLoopBattery(
    loopBatteries,
    readings,
    index,
    passiveNetwork.components,
    passiveNetwork.nodesByComponent,
    passiveNetwork.conductancesByComponent,
  );
  if (seriesLoop.shortedBattery) { return seriesLoop.shortedBattery; }
  const drivenShort = shortedBatteryInConductorGraph(loopBatteries, readings, index, passive, passiveNetwork.components);
  if (drivenShort) { return drivenShort; }
  const subnetworks = shortedBatterySubnetworks(loopBatteries, readings, index, passive, passiveNetwork.components);
  if (subnetworks.shortedBattery) { return subnetworks.shortedBattery; }

  const sourceEdges = sourceConstraintEdges(document, index, switchStates, new Set(loopBatteries.map((battery) => battery.id)));
  const sourceTree = sourceConstraintTree(index.size, sourceEdges);
  const batteriesByGroup = batteriesBySourceGroup(loopBatteries, sourceTree, index);
  const byPassiveResistance = shortedBatteryByPassiveResistance(
    loopBatteries,
    readings,
    index,
    seriesLoop.protectedBatteryIds,
    passiveNetwork,
    subnetworks.checkedBatteryIds,
  );
  if (byPassiveResistance) { return byPassiveResistance; }

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
    subnetworks.outputs,
  );
}

function shortedBatterySubnetworks(
  batteries: readonly CircuitPart[],
  readings: Map<string, ExactBatteryReading>,
  index: Map<string, number>,
  passive: readonly Conductance[],
  components: readonly number[],
) {
  const checkedBatteryIds = new Set<string>();
  if (batteries.length < 2) { return { checkedBatteryIds, outputs: [] }; }
  const testedGroups = new Set<string>();
  const testedOutputs = new Map<CommonSourceOutput, Set<string>>();
  const outputs = commonSourceOutputs(batteries, index, passive, [...components]);
  coveredHighResistanceOutputReturns(index.size, outputs, checkedBatteryIds);
  const commonRailShort = shortedCommonRailBatteryLoads(batteries, index, passive, outputs, testedGroups, checkedBatteryIds) ??
    shortedSourceOutputLoads(index, outputs, testedOutputs, checkedBatteryIds);
  if (commonRailShort) { return { checkedBatteryIds, shortedBattery: commonRailShort }; }
  const levels = passiveResistanceLevels(passive);
  for (const { subset, checkCycles, junctions } of passiveBatterySubnetworks(batteries, index, passive, components, levels)) {
    const network = passiveComponentsByNode(index.size, subset);
    const graph = batteryEdgesByPassiveComponent(batteries, index, network.components);
    for (const loop of batteryCycleGroups(graph.edges, graph.incidentEdges)) {
      // A consistent (zero circulating EMF) cycle can still supply a real
      // passive short. This load test has its own nonzero drive and therefore
      // also applies to cells with exactly zero actual current. Protection of
      // series cycles and the flowing-current guard remain in the cycle tests.
      const loadShort = shortedParallelBatteryLoads(loop, outputs, testedGroups, checkedBatteryIds);
      if (loadShort) { return { checkedBatteryIds, shortedBattery: loadShort }; }
      const reducedLoadShort = shortedReducedSourceLoads(loop, network, outputs, testedGroups, testedOutputs, checkedBatteryIds, junctions);
      if (reducedLoadShort) { return { checkedBatteryIds, shortedBattery: reducedLoadShort }; }
      // A load cut can also expose unequal source groups. Their circulation
      // still requires the original low-resistance cycle tests; using a load
      // shunt to lower that return would misclassify a resistive charging path.
      if (!checkCycles) { continue; }
      const shorted = shortedBatterySubnetworkCycle(loop, readings, index.size, network, passive);
      if (shorted) { return { checkedBatteryIds, shortedBattery: shorted }; }
    }
  }
  return { checkedBatteryIds, outputs };
}

function shortedBatterySubnetworkCycle(
  loop: readonly PassiveBatteryEdge[],
  readings: Map<string, ExactBatteryReading>,
  size: number,
  network: ReturnType<typeof passiveComponentsByNode>,
  passive: readonly Conductance[],
) {
  const parallel = parallelBatteryGroups(loop);
  return parallel
    ? shortedParallelBatteryGroup(parallel, readings, size, network.conductancesByComponent, passive)
    : shortedBatteryCycle(loop, readings, size, network.nodesByComponent, network.conductancesByComponent, passive, network.components);
}

function passiveResistanceLevels(passive: readonly Conductance[]) {
  const resistanceOf = (edge: Conductance) => edge.exactResistance ?? exactInput(edge.resistanceOhms)!;
  return [...new Map(passive.map((edge) => {
    const resistance = resistanceOf(edge);
    return [`${resistance.numerator}/${resistance.denominator}`, resistance] as const;
  })).values()].sort((first, second) => {
    const difference = subtractExactRational(first, second).numerator;
    return difference < 0n ? -1 : Number(difference > 0n);
  });
}

function shortedSourceOutputLoads(
  index: Map<string, number>,
  outputs: readonly CommonSourceOutput[],
  testedOutputs: Map<CommonSourceOutput, Set<string>>,
  checkedBatteryIds: Set<string>,
) {
  for (const output of outputs) {
    if (!commonSourceOutputCanShort(output)) { continue; }
    const passive = output.sources.flatMap((macro) => macro.passive);
    const batteries = output.sources.flatMap((macro) => macro.sources.map((edge) => edge.battery));
    const components = conductiveComponents(index.size, passive);
    const tested = testedOutputs.get(output) ?? new Set<string>();
    testedOutputs.set(output, tested);
    // First remove the complete source-free output load, including paths
    // with multiple resistance ranks. Otherwise a load between two ballast
    // ranks and private cell shunts can hide every original series string.
    // Subsequent cuts discover paired strings only; their boundary proof
    // and response still use every physical source-side passive branch,
    // including those attached to an unselected cell's open raw terminals.
    for (const { subset, junctions } of passiveBatterySubnetworks(batteries, index, passive, components, passiveResistanceLevels(passive))) {
      const network = passiveComponentsByNode(index.size, subset);
      const graph = batteryEdgesByPassiveComponent(batteries, index, network.components);
      for (const loop of batteryCycleGroups(graph.edges, graph.incidentEdges)) {
        const shorted = shortedParallelBatteryLoads(loop, [output], tested, checkedBatteryIds) ??
          shortedReducedSourceLoads(loop, network, [output], tested, testedOutputs, checkedBatteryIds, junctions);
        if (shorted) { return shorted; }
      }
    }
  }
}

function hasPassiveBatteryReturn(batteries: readonly CircuitPart[], index: Map<string, number>, components: readonly number[]) {
  return batteries.length > 1 && batteries.some((battery) => {
    const from = index.get(`${battery.id}:a`);
    const to = index.get(`${battery.id}:b`);
    return from !== undefined && to !== undefined && components[from] === components[to];
  });
}

interface PassiveTopologyNeighbor {
  node: number;
  edge: number;
}

interface PassiveBatterySubnetwork {
  subset: Conductance[];
  checkCycles: boolean;
  junctions?: number[];
}

interface PassiveTopologyPath {
  from: number;
  to: number;
  edges: number[];
}

function subnetworkJunctionComponents(components: readonly number[], junctions?: readonly number[]) {
  return junctions && new Set(junctions.map((node) => components[node]!));
}

function passiveTopologyPaths(
  adjacent: ReadonlyMap<number, PassiveTopologyNeighbor[]>,
  ports: ReadonlyMap<number, number>,
) {
  const visited = new Set<number>();
  const paths: PassiveTopologyPath[] = [];
  for (const [from, neighbors] of adjacent) {
    if (neighbors.length === 2 && !ports.has(from)) { continue; }
    for (const first of neighbors) {
      if (visited.has(first.edge)) { continue; }
      const edges = [first.edge];
      visited.add(first.edge);
      let node = first.node;
      let previous = first.edge;
      while (!ports.has(node) && adjacent.get(node)?.length === 2) {
        const next = adjacent.get(node)!.find((edge) => edge.edge !== previous)!;
        if (visited.has(next.edge)) { break; }
        visited.add(next.edge);
        edges.push(next.edge);
        previous = next.edge;
        node = next.node;
      }
      paths.push({ from, to: node, edges });
    }
  }
  return paths;
}

function passiveTopologyAdjacency(passive: readonly Conductance[], rails: readonly number[]) {
  const adjacent = new Map<number, PassiveTopologyNeighbor[]>();
  for (const [edgeIndex, edge] of passive.entries()) {
    const a = rails[edge.a]!;
    const b = rails[edge.b]!;
    if (a === b) { continue; }
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const neighbors = adjacent.get(from) ?? [];
      neighbors.push({ node: to, edge: edgeIndex });
      adjacent.set(from, neighbors);
    }
  }
  return adjacent;
}

function mergeTopologyPolarity(polarities: Map<number, number>, node: number, polarity: number) {
  const previous = polarities.get(node);
  polarities.set(node, previous === undefined || previous === polarity ? polarity : 0);
}

function* passivePolarityAssignments(
  polarities: ReadonlyMap<number, number>,
  adjacent: ReadonlyMap<number, PassiveTopologyNeighbor[]>,
) {
  yield polarities;
  const ambiguous = [...adjacent].filter(([node, neighbors]) => !polarities.has(node) && neighbors.length >= 3)
    .map(([node]) => node);
  // If every cell has crossed taps, no source-port leaf can label the hubs.
  // Try each ambiguous hub on one side and the remaining hubs on the other,
  // in both orientations. This is linear in the number of hubs, not their
  // power set. Conflicting source rails are never assigned a polarity.
  // These are discovery cuts only: connected paired ports must subsequently
  // prove a parallel group before its physical passive network is driven.
  for (const singled of ambiguous) {
    for (const polarity of [1, -1]) {
      const assigned = new Map(polarities);
      for (const node of ambiguous) { assigned.set(node, node === singled ? polarity : -polarity); }
      yield assigned;
    }
  }
}

function passiveTopologyPolarities(
  cells: readonly CircuitPart[],
  index: Map<string, number>,
  rails: readonly number[],
  paths: readonly PassiveTopologyPath[],
  adjacent: ReadonlyMap<number, PassiveTopologyNeighbor[]>,
) {
  const polarities = new Map<number, number>();
  for (const battery of cells) {
    mergeTopologyPolarity(polarities, rails[index.get(`${battery.id}:a`)!]!, 1);
    mergeTopologyPolarity(polarities, rails[index.get(`${battery.id}:b`)!]!, -1);
  }
  const terminals = new Map(polarities);
  // Only a source-port leaf can establish a neighboring hub's polarity.
  // Do not flood through loads/taps or through shared opposite ports of
  // series cells. Mixed polarity at a rail remains an explicit conflict.
  for (const path of paths) {
    for (const [from, to] of [[path.from, path.to], [path.to, path.from]] as const) {
      const polarity = terminals.get(from);
      if (polarity && adjacent.get(from)?.length === 1 && !terminals.has(to)) {
        mergeTopologyPolarity(polarities, to, polarity);
      }
    }
  }
  return polarities;
}

function* passivePolarityCuts(
  batteries: readonly CircuitPart[],
  index: Map<string, number>,
  rails: readonly number[],
  paths: readonly PassiveTopologyPath[],
  adjacent: ReadonlyMap<number, PassiveTopologyNeighbor[]>,
) {
  const groups = new Map<number, CircuitPart[]>();
  for (const battery of batteries) {
    const voltage = battery.voltageVolts!;
    const cells = groups.get(voltage) ?? [];
    cells.push(battery);
    groups.set(voltage, cells);
  }
  for (const cells of groups.values()) {
    if (cells.length < 2) { continue; }
    const polarities = passiveTopologyPolarities(cells, index, rails, paths, adjacent);
    for (const assigned of passivePolarityAssignments(polarities, adjacent)) {
      const cut = paths.filter((path) => (assigned.get(path.from) ?? 0) * (assigned.get(path.to) ?? 0) < 0);
      if (cut.length > 0) { yield new Set(cut.flatMap((path) => path.edges)); }
    }
  }
}

function* passiveTopologyCuts(polarityCuts: Iterable<Set<number>>, junctionCuts: Iterable<Set<number>>) {
  yield* polarityCuts;
  yield* junctionCuts;
}

function* passiveTopologySubnetworks(
  batteries: readonly CircuitPart[],
  index: Map<string, number>,
  passive: readonly Conductance[],
): Generator<PassiveBatterySubnetwork> {
  const rails = conductiveComponents(index.size, passive.filter((edge) => edge.resistanceOhms === IDEAL_OHMS));
  const ports = new Map<number, number>();
  for (const battery of batteries) {
    for (const terminal of ["a", "b"] as const) {
      const rail = rails[index.get(`${battery.id}:${terminal}`)!]!;
      ports.set(rail, (ports.get(rail) ?? 0) + 1);
    }
  }
  const adjacent = passiveTopologyAdjacency(passive, rails);
  const junction = (node: number) => (adjacent.get(node)?.length ?? 0) + (ports.get(node) ?? 0) >= 3;
  const cuts = new Map<number, Set<number>>();
  const paths = passiveTopologyPaths(adjacent, ports);
  // Suppress only source-free degree-two paths. A split load or ballast is
  // still one topological path, regardless of resistor values or segment count.
  // At each junction cut all paths to other junctions together: parallel loads
  // and upstream taps must not keep the source sides in one passive component.
  // Source-port leaves retain their ballast paths. Battery edges never enter
  // this search, so equal cell voltages alone cannot identify a parallel group.
  for (const path of paths) {
    if (path.from === path.to || !junction(path.from) || !junction(path.to)) { continue; }
    for (const node of [path.from, path.to]) {
      const cut = cuts.get(node) ?? new Set<number>();
      for (const edge of path.edges) { cut.add(edge); }
      cuts.set(node, cut);
    }
  }
  const seen = new Set<string>();
  // A bounded number of hub cuts per EMF group, not arbitrary edge subsets.
  // Cuts identify paired ports only; the unit drive keeps the physical network.
  // A pair of crossed upstream taps can make both cell ports junctions.
  // Polarity established by the other source's leaf ports distinguishes
  // the real same-side ballast from those taps even when every R is equal.
  for (const cut of passiveTopologyCuts(passivePolarityCuts(batteries, index, rails, paths, adjacent), cuts.values())) {
    const signature = [...cut].sort((a, b) => a - b).join(",");
    if (seen.has(signature)) { continue; }
    seen.add(signature);
    // Remember the load's junctions even if the cut leaves just two source
    // strings there. Otherwise a degree-two source cycle would be mistaken
    // for one indivisible series ring instead of two parallel series paths.
    yield { subset: passive.filter((_, edge) => !cut.has(edge)), checkCycles: false,
      junctions: [...new Set(paths.filter((path) => path.edges.some((edge) => cut.has(edge)))
        .flatMap((path) => [path.from, path.to]).filter(junction))] };
  }
}

function* passiveBatterySubnetworks(batteries: readonly CircuitPart[], index: Map<string, number>, passive: readonly Conductance[], components: readonly number[], levels: readonly ExactRational[]): Generator<PassiveBatterySubnetwork> {
  // A series string can have a passive return across its outer ports even
  // when none of its individual cells has one. Discover those paired paths
  // before applying the single-cell guard to the resistance-rank search.
  yield* passiveTopologySubnetworks(batteries, index, passive);
  if (hasPassiveBatteryReturn(batteries, index, components)) { yield* passiveResistanceSubnetworks(passive, levels); }
}

function* passiveResistanceSubnetworks(passive: readonly Conductance[], levels: readonly ExactRational[]) {
  const resistanceKey = (value: ExactRational) => `${value.numerator}/${value.denominator}`;
  const ranks = new Map(levels.map((value, rank) => [resistanceKey(value), rank]));
  const ranked = passive.map((edge, index) => ({
    edge, index, rank: ranks.get(resistanceKey(edge.exactResistance ?? exactInput(edge.resistanceOhms)!))!,
  }));
  const seen = new Set<string>();
  const candidate = (entries: typeof ranked, checkCycles: boolean) => {
    const signature = entries.map(({ index }) => index).join(",");
    if (entries.length === passive.length || seen.has(signature)) { return null; }
    seen.add(signature);
    return { subset: entries.map(({ edge }) => edge), checkCycles };
  };
  for (let upper = 0; upper < levels.length - 1; upper += 1) {
    const entries = ranked.filter(({ rank }) => rank <= upper);
    const next = candidate(entries, true);
    if (next) { yield next; }
  }
  // A shared load may sit between unequal ballast ranks on both source
  // sides. Cutting its rank keeps those ballasts together even without a
  // conductor-only common terminal rail or a contiguous resistor band.
  for (let omitted = 0; omitted < levels.length; omitted += 1) {
    const entries = ranked.filter(({ edge, rank }) => edge.resistanceOhms === IDEAL_OHMS || rank !== omitted);
    const next = candidate(entries, false);
    if (next) { yield next; }
  }
  // Keep conductors and each contiguous band of resistor values. Ballasts
  // can lie above a common load and below a weak upstream tap, so neither a
  // prefix nor a suffix alone separates the parallel source ports. The bands
  // identify groups only; unit-drive solves retain the entire physical net.
  // There are quadratically many bands, rather than arbitrary edge subsets.
  for (let lower = 1; lower < levels.length; lower += 1) {
    for (let upper = lower; upper < levels.length; upper += 1) {
      const entries = ranked.filter(({ edge, rank }) => edge.resistanceOhms === IDEAL_OHMS || (rank >= lower && rank <= upper));
      const next = candidate(entries, false);
      if (next) { yield next; }
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

function bulbIsOverloaded(part: CircuitPart, reading: CircuitPartReading) {
  const voltage = restoredComplex(reading.exactVoltage);
  const current = restoredComplex(reading.exactTerminalCurrents?.a);
  const excess = exactProductSumRatio([
    { factors: [voltage ? exactComplexValue(voltage)?.real ?? reading.voltageVolts : reading.voltageVolts,
      current ? exactComplexValue(current)?.real ?? reading.currentAmps : reading.currentAmps] },
    { factors: [part.ratedPowerWatts ?? 2, OVERLOAD_RATIO], sign: -1 },
  ], 1);
  return excess !== null && excess.numerator > 0n;
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
      bulbIsOverloaded(part, reading)
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
  inputSwitchStates: Record<string, boolean>,
  options: CircuitAnalysisOptions,
): CircuitAnalysis {
  const input = circuitAnalysisInput(document, inputSwitchStates, options);
  if (typeof input === "string") { return invalidInputResult(input); }
  const { switchStates, options: normalizedOptions } = input;
  const normalizedDocument = documentWithCatalogDefaults(copySimulationDocument(document));
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
  const voltagePairs = normalizedDocument.parts.filter((part) => part.kind !== "junction")
    .map((part) => ({ a: index.get(`${part.id}:a`)!, b: index.get(`${part.id}:b`)! }));
  const centered = centerOverflowingVoltageComponents(solved.exactVoltages, solved.components, voltagePairs);
  const { parts, wireCurrents } = readAll(normalizedDocument, index, nodeVoltageReadings(centered), switchStates);
  if (!hasOnlyFiniteReadings(parts, wireCurrents)) {
    const message = "回路の計算結果が数値の範囲を超えました。電圧・電流・抵抗値を確認してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const issues = collectIssues(normalizedDocument, parts);
  const batteries = normalizedDocument.parts.filter((part) => part.kind === "battery");
  const only = batteries.length === 1 ? batteries[0] : undefined;
  const readings = {
    parts,
    wireCurrents,
    issues,
    bulbPowerWatts: Object.fromEntries(
      normalizedDocument.parts
        .filter((part) => part.kind === "bulb")
        .map((part) => [part.id, parts[part.id]?.powerWatts ?? 0]),
    ),
    currentAmps: only ? Math.abs(parts[only.id]?.currentAmps ?? 0) : null,
  };
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
  return result("closed", closedMessage(batteries), readings);
}

function invalidInputResult(message: string): CircuitAnalysis {
  return result("invalid", message, { issues: [{ severity: "error", message }] });
}

function circuitAnalysisInput(document: unknown, switchStates: unknown, options: unknown): string | {
  switchStates: Record<string, boolean>;
  options: CircuitAnalysisOptions;
} {
  try {
    const shapeIssue = circuitDocumentShapeIssue(document);
    if (shapeIssue) { return shapeIssue; }
    const kinds = new Map((document as CircuitDocument).parts.map((part) => [part.id, part.kind]));
    if (!isSimulationRecord(switchStates, kinds.keys())) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
    // Capture own data fields once so solving and reporting cannot observe
    // different values through a caller-owned Proxy's later get traps.
    const snapshot = Object.fromEntries(simulationRecordEntries(switchStates));
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
    const stateIssue = switchStateIssue(snapshot, kinds);
    if (stateIssue) { return stateIssue; }
    // Solve with the same values just validated, without rereading caller data.
    return { switchStates: snapshot as Record<string, boolean>, options: { mode, frequencyHz } };
  } catch {
    return "解析条件またはスイッチ状態を読み取れません。";
  }
}
