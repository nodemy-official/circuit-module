import {
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeExtendedCircuit } from "./circuit-analog-adapter.js";
import { solveRealLinearSystem } from "./analog-math.js";
import { meterStatuses, type MeterStatus } from "./meter-status.js";

export type CircuitStatus = "empty" | "idle" | "open" | "closed" | "short" | "invalid";
export type CircuitIssueSeverity = "error" | "warning" | "info";

/** Maximum number of part terminals accepted by the dense nodal-analysis solver. */
export const MAX_CIRCUIT_ANALYSIS_TERMINALS = 512;

export interface CircuitIssue {
  severity: CircuitIssueSeverity;
  message: string;
  partId?: string;
}

export interface CircuitPartReading {
  /** A−B voltage; BJT/MOS use A−C, op-amps use output−GND. AC values are RMS magnitudes. */
  voltageVolts: number;
  /** Current entering terminal A (op-amp: output C). Signed in DC; RMS magnitude in AC. */
  currentAmps: number;
  /** Real power absorbed; independent voltage/current sources report delivered power. */
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
  /** Present for the battery's internal resistance so loop checks can omit that source. */
  batteryId?: string;
  /** Open-circuit A−B voltage of a battery branch. */
  voltage?: number;
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

function partValueIssue(part: CircuitPart): string | null {
  if (part.kind === "switch" && part.initiallyClosed !== undefined && typeof part.initiallyClosed !== "boolean") {
    return `${part.label}のスイッチ状態は真偽値にしてください。`;
  }
  if (part.kind === "battery") {
    if (!positive(part.voltageVolts)) { return `${part.label}の電圧は0より大きい数値にしてください。`; }
    const internal = part.internalResistanceOhms ?? 0;
    if (!Number.isFinite(internal) || internal < 0) {
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
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Map || value instanceof Set) {
    return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
  }
  for (const [partId, state] of Object.entries(value)) {
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
  return override ?? part.initiallyClosed ?? false;
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
    });
  }
  for (const part of document.parts) {
    if (part.kind === "battery") {
      // The branch follows I = (Va − Vb − Vsource) / Rinternal.
      const ohms = batteryOhms(part);
      const a = node(part.id, "a");
      const b = node(part.id, "b");
      conductances.push({ a, b, g: 1 / ohms, batteryId: part.id, voltage: part.voltageVolts });
      continue;
    }
    const ohms = partOhms(part, switchStates);
    if (ohms !== null) {
      conductances.push({ a: node(part.id, "a"), b: node(part.id, "b"), g: 1 / ohms });
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

/** One reference node per connected group, so every group has a solvable system. */
function referenceNodes(size: number, conductances: readonly Conductance[]) {
  const parent = Array.from({ length: size }, (_, index) => index);
  for (const { a, b } of conductances) { parent[findRoot(parent, a)] = findRoot(parent, b); }
  const references = new Set<number>();
  for (let node = 0; node < size; node += 1) { references.add(findRoot(parent, node)); }
  return references;
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

interface TreeCoordinate {
  unknown: number;
  sign: number;
}

/** Keep the strongest connections in the tree so weak conductances are not lost
 * when they would otherwise be added to an ideal conductor's large diagonal. */
function voltageTree(size: number, conductances: readonly Conductance[]) {
  const references = referenceNodes(size, conductances);
  const adjacent = Array.from({ length: size }, () => [] as { node: number; g: number; voltage: number }[]);
  for (const { a, b, g, voltage = 0 } of conductances) {
    adjacent[a].push({ node: b, g, voltage });
    adjacent[b].push({ node: a, g, voltage: -voltage });
  }
  const parent = Array.from({ length: size }, () => -1);
  const depth = Array.from({ length: size }, () => 0);
  const offset = Array.from({ length: size }, () => 0);
  const strongest = Array.from({ length: size }, (_, node) =>
    references.has(node) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
  );
  const visited = new Set<number>();
  const unknowns = new Map<number, number>();
  const order: number[] = [];
  while (order.length < size) {
    let next = -1;
    for (let node = 0; node < size; node += 1) {
      if (!visited.has(node) && (next === -1 || strongest[node] > strongest[next])) { next = node; }
    }
    visited.add(next);
    order.push(next);
    if (parent[next] !== -1) {
      unknowns.set(next, unknowns.size);
      depth[next] = depth[parent[next]] + 1;
    }
    for (const edge of adjacent[next]) {
      if (!visited.has(edge.node) && edge.g > strongest[edge.node]) {
        parent[edge.node] = next;
        strongest[edge.node] = edge.g;
        offset[edge.node] = -edge.voltage;
      }
    }
  }
  const baseline = new Float64Array(unknowns.size);
  for (const [node, unknown] of unknowns) { baseline[unknown] = offset[node]; }
  return { parent, depth, unknowns, order, baseline };
}

function treeVoltagePath(
  tree: ReturnType<typeof voltageTree>,
  from: number,
  to: number,
): TreeCoordinate[] {
  const path: TreeCoordinate[] = [];
  let a = from;
  let b = to;
  while (a !== b) {
    // Separate floating groups both end at the implicit -1 reference. Their
    // potential difference is arbitrary and meterStatuses marks it as such.
    if ((tree.depth[a] ?? -1) >= (tree.depth[b] ?? -1)) {
      const unknown = tree.unknowns.get(a);
      if (unknown !== undefined) { path.push({ unknown, sign: 1 }); }
      a = tree.parent[a] ?? -1;
    } else {
      const unknown = tree.unknowns.get(b);
      if (unknown !== undefined) { path.push({ unknown, sign: -1 }); }
      b = tree.parent[b] ?? -1;
    }
  }
  return path;
}

function sumVoltagePath(path: readonly TreeCoordinate[], solution: Float64Array, offset = 0) {
  let value = -offset;
  let correction = 0;
  let scale = 0;
  for (const { unknown, sign } of path) {
    const term = sign * solution[unknown];
    const next = value + term;
    correction += Math.abs(value) >= Math.abs(term) ? (value - next) + term : (term - next) + value;
    value = next;
    scale += Math.abs(term);
  }
  return { value: value + correction, scale };
}

/** Solve nodal analysis in tree-edge voltage coordinates. This is an exact
 * change of variables: each branch contributes g p pᵀ, where p is its signed
 * tree path. Battery voltages on the tree provide a known baseline; solving
 * its corrections avoids subtracting full source voltages to find tiny currents.
 * The 1 μΩ conductor model is unchanged. */
function nodeVoltages(
  size: number,
  conductances: readonly Conductance[],
) {
  if (conductances.some(({ g }) => !Number.isFinite(g))) {
    return null;
  }
  const tree = voltageTree(size, conductances);
  const count = tree.unknowns.size;
  const matrix = new Float64Array(count * count);
  const rhs = new Float64Array(count);
  for (const { a, b, g, voltage = 0 } of conductances) {
    const path = treeVoltagePath(tree, a, b);
    const residualVoltage = sumVoltagePath(path, tree.baseline, voltage).value;
    for (const row of path) {
      rhs[row.unknown] -= g * row.sign * residualVoltage;
      for (const column of path) {
        matrix[row.unknown * count + column.unknown] += g * row.sign * column.sign;
      }
    }
  }
  const solution = solveRealLinearSystem(count, matrix, rhs);
  if (!solution) { return null; }
  const voltages = Array.from({ length: size }, () => 0);
  for (const node of tree.order) {
    const unknown = tree.unknowns.get(node);
    if (unknown !== undefined) {
      voltages[node] = voltages[tree.parent[node]] + tree.baseline[unknown] + solution[unknown];
    }
  }
  if (!voltages.every(Number.isFinite)) { return null; }
  return {
    voltages,
    difference: (from: number, to: number, offset = 0) => {
      const path = treeVoltagePath(tree, from, to);
      const baseline = sumVoltagePath(path, tree.baseline, offset).value;
      const correction = sumVoltagePath(path, solution);
      return { value: baseline + correction.value, scale: Math.abs(baseline) + correction.scale };
    },
  };
}

function readPart(
  part: CircuitPart,
  voltageVolts: number,
  currentVoltage: number,
  switchStates: Record<string, boolean>,
): CircuitPartReading {
  if (part.kind === "battery") {
    const currentAmps = currentVoltage / batteryOhms(part);
    return { voltageVolts, currentAmps, powerWatts: -voltageVolts * currentAmps };
  }
  const ohms = partOhms(part, switchStates);
  const currentAmps = ohms === null ? 0 : voltageVolts / ohms;
  const powerWatts =
    part.kind === "resistor" || part.kind === "bulb" ? voltageVolts * currentAmps : 0;
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
    const reading = readPart(part, drop.value, currentDrop.value, switchStates);
    const voltageUncertainty = ROUNDING_GUARD * drop.scale;
    const currentAmps = tidy(reading.currentAmps, currentUncertainty);
    setRecordValue(parts, part.id, {
      ...reading,
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
    setRecordValue(wireCurrents, wire.id, tidy(drop.value / IDEAL_OHMS, currentUncertainty));
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

function shortedBattery(
  batteries: readonly CircuitPart[],
  parts: Record<string, CircuitPartReading>,
) {
  return batteries.find((battery) => {
    const reading = parts[battery.id];
    if (!reading || reading.currentAmps === 0) { return false; }
    return Math.abs(reading.voltageVolts / reading.currentAmps) < SHORT_OHMS;
  });
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
  const legacyKinds = new Set(["battery", "resistor", "bulb", "switch", "ammeter", "voltmeter", "junction"]);
  if (options.mode === "ac" || document.parts.some((part) => !legacyKinds.has(part.kind))) {
    return analyzeExtendedCircuit(document, switchStates, options);
  }
  if (document.parts.length === 0) { return result("empty", "部品を配置して回路を作成してください。"); }
  const invalid = documentIssue(document, switchStates);
  if (invalid) {
    return result("invalid", invalid, { issues: [{ severity: "error", message: invalid }] });
  }
  const terminalCount = document.parts.reduce(
    (count, part) => count + terminalsOf(part.kind).length,
    0,
  );
  if (terminalCount > MAX_CIRCUIT_ANALYSIS_TERMINALS) {
    const message =
      `端子数が解析上限の${MAX_CIRCUIT_ANALYSIS_TERMINALS}端子を超えています。` +
      "部品を減らすか、回路を分けて解析してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const index = indexTerminals(document.parts);
  const conductances = buildNetwork(document, index, switchStates);
  const solved = nodeVoltages(index.size, conductances);
  if (!solved) {
    const message = "回路を計算できませんでした。接続と部品の数値を確認してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const { parts, wireCurrents } = readAll(document, index, solved, switchStates);
  if (!hasOnlyFiniteReadings(parts, wireCurrents)) {
    const message = "回路の計算結果が数値の範囲を超えました。電圧・電流・抵抗値を確認してください。";
    return result("invalid", message, { issues: [{ severity: "error", message }] });
  }
  const issues = collectIssues(document, parts);
  const batteries = document.parts.filter((part) => part.kind === "battery");
  const readings = { parts, wireCurrents, issues };
  if (batteries.length === 0) { return result("idle", "電池を置くと電流を計算します。", readings); }
  const shorted = shortedBattery(batteries, parts);
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
    document.parts
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
