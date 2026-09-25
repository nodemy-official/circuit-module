import {
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeExtendedCircuit } from "./circuit-analog-adapter.js";
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
// Ideal conductors leave rounding noise far below this; anything smaller reads as no current.
const CURRENT_EPSILON = 1e-7;
/** Suppresses voltage residual from the legacy 1 µΩ conductance approximation. */
const VOLTAGE_EPSILON = 1e-7;
const OVERLOAD_RATIO = 1.5;

interface Conductance {
  a: number;
  b: number;
  g: number;
  /** Present for the battery's internal resistance so loop checks can omit that source. */
  batteryId?: string;
}

interface CurrentSource {
  /** Node the source pushes current into. */
  into: number;
  from: number;
  amps: number;
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

function documentIssue(document: CircuitDocument): string | null {
  const ids = new Set(document.parts.map((part) => part.id));
  if (ids.size !== document.parts.length) { return "部品 ID が重複しています。"; }
  for (const part of document.parts) {
    const issue = partValueIssue(part);
    if (issue) { return issue; }
  }
  const kinds = new Map(document.parts.map((part) => [part.id, part.kind]));
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

const key = ({ partId, terminal }: CircuitEndpoint) => `${partId}:${terminal}`;

function indexTerminals(parts: readonly CircuitPart[]) {
  const index = new Map<string, number>();
  for (const part of parts) {
    for (const terminal of terminalsOf(part.kind)) { index.set(`${part.id}:${terminal}`, index.size); }
  }
  return index;
}

function isClosed(part: CircuitPart, switchStates: Record<string, boolean>) {
  return switchStates[part.id] ?? part.initiallyClosed ?? false;
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
  const sources: CurrentSource[] = [];
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
      // A battery is its Norton equivalent: V/r pushed into + in parallel with 1/r.
      const ohms = batteryOhms(part);
      const a = node(part.id, "a");
      const b = node(part.id, "b");
      conductances.push({ a, b, g: 1 / ohms, batteryId: part.id });
      sources.push({ into: a, from: b, amps: (part.voltageVolts ?? 0) / ohms });
      continue;
    }
    const ohms = partOhms(part, switchStates);
    if (ohms !== null) {
      conductances.push({ a: node(part.id, "a"), b: node(part.id, "b"), g: 1 / ohms });
    }
  }
  return { conductances, sources };
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

function pivotRow(matrix: number[][], column: number) {
  let pivot = column;
  for (let row = column + 1; row < matrix.length; row += 1) {
    if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) { pivot = row; }
  }
  return pivot;
}

/** Gaussian elimination with partial pivoting; the inputs are consumed. */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length;
  for (let column = 0; column < size; column += 1) {
    const pivot = pivotRow(matrix, column);
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    [rhs[column], rhs[pivot]] = [rhs[pivot], rhs[column]];
    const lead = matrix[column][column];
    if (Math.abs(lead) < 1e-18) { return null; }
    for (let row = column + 1; row < size; row += 1) {
      const factor = matrix[row][column] / lead;
      for (let k = column; k < size; k += 1) { matrix[row][k] -= factor * matrix[column][k]; }
      rhs[row] -= factor * rhs[column];
    }
  }
  const solution = Array.from({ length: size }, () => 0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = rhs[row];
    for (let k = row + 1; k < size; k += 1) { sum -= matrix[row][k] * solution[k]; }
    solution[row] = sum / matrix[row][row];
  }
  return solution;
}

/** Node potentials of the network, with each group's reference node at 0 V. */
function nodeVoltages(
  size: number,
  conductances: readonly Conductance[],
  sources: readonly CurrentSource[],
) {
  const references = referenceNodes(size, conductances);
  const unknowns = new Map<number, number>();
  for (let node = 0; node < size; node += 1) {
    if (!references.has(node)) { unknowns.set(node, unknowns.size); }
  }
  const matrix = Array.from({ length: unknowns.size }, () =>
    Array.from({ length: unknowns.size }, () => 0),
  );
  const rhs = Array.from({ length: unknowns.size }, () => 0);
  const add = (row: number | undefined, column: number | undefined, value: number) => {
    if (row !== undefined && column !== undefined) { matrix[row][column] += value; }
  };
  for (const { a, b, g } of conductances) {
    const ia = unknowns.get(a);
    const ib = unknowns.get(b);
    add(ia, ia, g);
    add(ib, ib, g);
    add(ia, ib, -g);
    add(ib, ia, -g);
  }
  for (const { into, from, amps } of sources) {
    const ii = unknowns.get(into);
    const ifrom = unknowns.get(from);
    if (ii !== undefined) { rhs[ii] += amps; }
    if (ifrom !== undefined) { rhs[ifrom] -= amps; }
  }
  const solution = solveLinear(matrix, rhs);
  if (!solution) { return null; }
  return Array.from({ length: size }, (_, node) => {
    const unknown = unknowns.get(node);
    return unknown === undefined ? 0 : solution[unknown];
  });
}

function readPart(
  part: CircuitPart,
  voltage: (partId: string, terminal: CircuitTerminal) => number,
  switchStates: Record<string, boolean>,
): CircuitPartReading {
  const voltageVolts = part.kind === "junction" ? 0 : voltage(part.id, "a") - voltage(part.id, "b");
  if (part.kind === "battery") {
    const currentAmps = (voltageVolts - (part.voltageVolts ?? 0)) / batteryOhms(part);
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

function tidy(value: number) {
  return Math.abs(value) < CURRENT_EPSILON ? 0 : value;
}

function readAll(
  document: CircuitDocument,
  index: Map<string, number>,
  voltages: number[],
  switchStates: Record<string, boolean>,
) {
  const meterStatusByPart = meterStatuses(document, { mode: "dc", switchStates });
  const voltage = (partId: string, terminal: CircuitTerminal) =>
    voltages[index.get(`${partId}:${terminal}`) ?? -1] ?? 0;
  const parts: Record<string, CircuitPartReading> = {};
  for (const part of document.parts) {
    const reading = readPart(part, voltage, switchStates);
    parts[part.id] = {
      ...reading,
      terminalVoltages: Object.fromEntries(terminalsOf(part.kind).map((terminal) => [terminal, voltage(part.id, terminal)])),
      terminalCurrents: part.kind === "junction" ? { a: 0 } : { a: tidy(reading.currentAmps), b: -tidy(reading.currentAmps) },
      ...(meterStatusByPart[part.id] ? { meterStatus: meterStatusByPart[part.id] } : {}),
      voltageVolts: Math.abs(reading.voltageVolts) < VOLTAGE_EPSILON ? 0 : reading.voltageVolts,
      currentAmps: tidy(reading.currentAmps),
      powerWatts: tidy(reading.powerWatts),
    };
  }
  const wireCurrents: Record<string, number> = {};
  for (const wire of document.wires) {
    const from = voltage(wire.from.partId, wire.from.terminal);
    const to = voltage(wire.to.partId, wire.to.terminal);
    wireCurrents[wire.id] = tidy((from - to) / IDEAL_OHMS);
  }
  return { parts, wireCurrents };
}

function shortedBattery(
  batteries: readonly CircuitPart[],
  parts: Record<string, CircuitPartReading>,
) {
  return batteries.find((battery) => {
    const reading = parts[battery.id];
    if (!reading || Math.abs(reading.currentAmps) < CURRENT_EPSILON) { return false; }
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
  const invalid = documentIssue(document);
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
  const { conductances, sources } = buildNetwork(document, index, switchStates);
  const voltages = nodeVoltages(index.size, conductances, sources);
  if (!voltages) { return result("invalid", "回路を計算できませんでした。接続を確認してください。"); }
  const { parts, wireCurrents } = readAll(document, index, voltages, switchStates);
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
    return result("open", "回路が開いています。導線とスイッチを確認してください。", readings);
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
