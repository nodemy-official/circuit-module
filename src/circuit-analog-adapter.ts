import { analyzeAnalogCircuit, type ComplexValue, type AnalogCircuitPartReading } from "./analog-solver.js";
import { circuitPartCatalog, terminalsOf, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "./circuit-model.js";
import type { CircuitAnalysis, CircuitAnalysisOptions, CircuitPartReading } from "./circuit-solver.js";

const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const directlyConductiveKinds = new Set<CircuitPart["kind"]>([
  "battery", "ac-source", "resistor", "bulb", "ammeter", "diode", "led", "inductor",
]);
const magnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);
const phase = (value: ComplexValue) =>
  value.real === 0 && value.imaginary === 0
    ? 0
    : Math.atan2(value.imaginary, value.real) * 180 / Math.PI;

function setRecordValue<T>(record: Record<string, T>, property: string, value: T) {
  Object.defineProperty(record, property, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function terminalValues(values: Partial<Record<CircuitTerminal, ComplexValue>>, ac: boolean) {
  return Object.fromEntries(Object.entries(values).map(([terminal, value]) =>
    [terminal, ac ? magnitude(value) : value.real],
  ));
}

function switchClosedState(part: CircuitPart, switchStates: Record<string, boolean>) {
  if (part.kind !== "switch") { return; }
  const override = Object.hasOwn(switchStates, part.id) ? switchStates[part.id] : undefined;
  return override ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
}

interface ConductivityGraph {
  adjacent: Map<string, string[]>;
  endpointKey: (partId: string, terminal: CircuitTerminal) => string;
  firstGround?: CircuitPart;
}

function connectGraphEndpoints(graph: ConductivityGraph, first: string, second: string) {
  graph.adjacent.get(first)?.push(second);
  graph.adjacent.get(second)?.push(first);
}

function joinGraphPart(graph: ConductivityGraph, part: CircuitPart, terminals: CircuitTerminal[]) {
  const first = terminals[0];
  if (!first) { return; }
  for (const terminal of terminals.slice(1)) {
    connectGraphEndpoints(graph, graph.endpointKey(part.id, first), graph.endpointKey(part.id, terminal));
  }
}

function referenceEndpointKey(document: CircuitDocument, graph: ConductivityGraph) {
  const firstGround = graph.firstGround;
  if (firstGround) { return graph.endpointKey(firstGround.id, "a"); }
  const firstPart = document.parts[0];
  const firstTerminal = firstPart ? terminalsOf(firstPart.kind)[0] : undefined;
  return firstPart && firstTerminal ? graph.endpointKey(firstPart.id, firstTerminal) : undefined;
}

function connectPartInGraph(
  graph: ConductivityGraph,
  part: CircuitPart,
  document: CircuitDocument,
  mode: "dc" | "ac",
  switchStates: Record<string, boolean>,
  reference: string | undefined,
) {
  if (directlyConductiveKinds.has(part.kind)) { joinGraphPart(graph, part, ["a", "b"]); return; }
  if (part.kind === "switch") {
    if (switchClosedState(part, switchStates)) { joinGraphPart(graph, part, ["a", "b"]); }
    return;
  }
  if (part.kind === "capacitor") {
    if (mode === "ac") { joinGraphPart(graph, part, ["a", "b"]); }
    return;
  }
  if (part.kind === "current-source") {
    const currentAmps = part.currentAmps ?? circuitPartCatalog["current-source"].defaults.currentAmps ?? 0;
    if (mode === "dc" && currentAmps !== 0) { joinGraphPart(graph, part, ["a", "b"]); }
    return;
  }
  if (part.kind === "potentiometer" || part.kind === "npn-transistor" || part.kind === "pnp-transistor") {
    joinGraphPart(graph, part, ["a", "b", "c"]);
    return;
  }
  if (part.kind === "nmos" || part.kind === "pmos") {
    joinGraphPart(graph, part, ["a", "c"]);
    return;
  }
  if (part.kind === "op-amp") {
    const target = reference ?? referenceEndpointKey(document, graph);
    if (target) { connectGraphEndpoints(graph, graph.endpointKey(part.id, "c"), target); }
  }
}

function connectivityGraph(
  document: CircuitDocument,
  mode: "dc" | "ac",
  switchStates: Record<string, boolean>,
  excludedPartId: string,
) {
  const endpointKey = (partId: string, terminal: CircuitTerminal) => JSON.stringify([partId, terminal]);
  const graph: ConductivityGraph = { adjacent: new Map(), endpointKey };
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) { graph.adjacent.set(endpointKey(part.id, terminal), []); }
  }
  graph.firstGround = document.parts.find((part) => part.kind === "ground");
  for (const wire of document.wires) {
    connectGraphEndpoints(graph, endpointKey(wire.from.partId, wire.from.terminal), endpointKey(wire.to.partId, wire.to.terminal));
  }
  for (const ground of document.parts.filter((part) => part.kind === "ground").slice(1)) {
    if (graph.firstGround) {
      connectGraphEndpoints(graph, endpointKey(graph.firstGround.id, "a"), endpointKey(ground.id, "a"));
    }
  }
  const reference = referenceEndpointKey(document, graph);
  for (const part of document.parts) {
    if (part.id === excludedPartId) { continue; }
    connectPartInGraph(graph, part, document, mode, switchStates, reference);
  }
  return graph;
}

function connectedInGraph(adjacent: Map<string, string[]>, start: string, goal: string) {
  const visited = new Set<string>([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === goal) { return true; }
    for (const next of adjacent.get(current ?? "") ?? []) {
      if (visited.has(next)) { continue; }
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}

function hasSourceReturnPath(
  document: CircuitDocument,
  source: CircuitPart,
  mode: "dc" | "ac",
  switchStates: Record<string, boolean>,
) {
  const graph = connectivityGraph(document, mode, switchStates, source.id);
  return connectedInGraph(
    graph.adjacent,
    graph.endpointKey(source.id, "a"),
    graph.endpointKey(source.id, "b"),
  );
}

function hasOpAmpOutputReturnPath(
  document: CircuitDocument,
  opAmp: CircuitPart,
  mode: "dc" | "ac",
  switchStates: Record<string, boolean>,
) {
  const graph = connectivityGraph(document, mode, switchStates, opAmp.id);
  const reference = referenceEndpointKey(document, graph);
  return reference !== undefined && connectedInGraph(
    graph.adjacent,
    graph.endpointKey(opAmp.id, "c"),
    reference,
  );
}

function isActiveSourceForMode(source: CircuitPart, mode: "dc" | "ac") {
  if (source.kind !== "current-source") { return true; }
  const currentAmps = source.currentAmps ?? circuitPartCatalog["current-source"].defaults.currentAmps ?? 0;
  return mode === "dc" && currentAmps !== 0;
}

function analysisStatus(
  document: CircuitDocument,
  analogStatus: "valid" | "empty" | "invalid",
  sources: CircuitPart[],
  mode: "dc" | "ac",
  switchStates: Record<string, boolean>,
): CircuitAnalysis["status"] {
  if (analogStatus !== "valid") { return analogStatus; }
  const hasOpAmpOutputLoop = document.parts.some((part) =>
    part.kind === "op-amp" && hasOpAmpOutputReturnPath(document, part, mode, switchStates),
  );
  const activeSources = sources.filter((source) => isActiveSourceForMode(source, mode));
  if (activeSources.length === 0) { return hasOpAmpOutputLoop ? "closed" : "idle"; }
  const hasClosedSourceLoop = activeSources.some((source) => hasSourceReturnPath(document, source, mode, switchStates));
  return hasClosedSourceLoop || hasOpAmpOutputLoop ? "closed" : "open";
}

function adaptReading(
  part: CircuitPart,
  reading: AnalogCircuitPartReading,
  ac: boolean,
  switchStates: Record<string, boolean>,
): CircuitPartReading {
  const powerWatts = part.kind === "capacitor" || part.kind === "inductor" ? 0
    : reading.power.real * (sourceKinds.has(part.kind) ? -1 : 1);
  const result: CircuitPartReading = {
    voltageVolts: ac ? magnitude(reading.voltage) : reading.voltage.real,
    currentAmps: ac ? magnitude(reading.current) : reading.current.real,
    powerWatts,
    terminalVoltages: terminalValues(reading.terminalVoltages, ac),
    terminalCurrents: terminalValues(reading.terminalCurrents, ac),
    ...(reading.meterStatus ? { meterStatus: reading.meterStatus } : {}),
    ...(part.kind === "switch" ? { switchClosed: switchClosedState(part, switchStates) } : {}),
  };
  if (ac) {
    result.voltagePhaseDegrees = phase(reading.voltage);
    result.currentPhaseDegrees = phase(reading.current);
    result.reactivePowerVars = reading.power.imaginary;
    result.terminalVoltagePhasesDegrees = Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, phase(value)]));
    result.terminalCurrentPhasesDegrees = Object.fromEntries(Object.entries(reading.terminalCurrents).map(([terminal, value]) => [terminal, phase(value)]));
  }
  if (part.kind === "bulb") { result.brightness = Math.max(0, Math.min(1, powerWatts / (part.ratedPowerWatts ?? 2))); }
  if (part.kind === "led" && !ac) { result.brightness = Math.max(0, Math.min(1, result.currentAmps / (part.ratedCurrentAmps ?? 0.02))); }
  return result;
}

/** Bridges complex circuit analysis to the editor's scalar reading API. */
export function analyzeExtendedCircuit(
  document: CircuitDocument,
  switchStates: Record<string, boolean>,
  options: CircuitAnalysisOptions,
): CircuitAnalysis {
  const firstAc = document.parts.find((part) => part.kind === "ac-source");
  const mode = options.mode === "ac" || (options.mode !== "dc" && firstAc) ? "ac" : "dc";
  const frequencyHz = options.frequencyHz ?? firstAc?.frequencyHz ?? 1000;
  const analog = analyzeAnalogCircuit(document, { mode, frequencyHz, switchStates });
  const parts: Record<string, CircuitPartReading> = {};
  for (const part of document.parts) {
    if (!Object.hasOwn(analog.parts, part.id)) { continue; }
    const reading = analog.parts[part.id];
    if (reading) { setRecordValue(parts, part.id, adaptReading(part, reading, mode === "ac", switchStates)); }
  }
  const finiteReadings = Object.values(parts).every((reading) => [
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
  ].every((value) => value === undefined || Number.isFinite(value)));
  if (!finiteReadings) {
    const message = "回路の計算結果が数値の範囲を超えました。電圧・電流・抵抗値を確認してください。";
    return {
      status: "invalid",
      message,
      mode,
      ...(mode === "ac" ? { frequencyHz } : {}),
      currentAmps: null,
      parts: {},
      bulbPowerWatts: {},
      wireCurrents: {},
      issues: [{ severity: "error", message }],
    };
  }
  const sources = document.parts.filter((part) => sourceKinds.has(part.kind));
  const status = analysisStatus(document, analog.status, sources, mode, switchStates);
  const message = status === "open"
    ? "回路が開いているため電流は流れていません。導線とスイッチを確認してください。"
    : analog.message;
  const currentAmps = analog.status === "valid" && sources.length === 1 && !document.parts.some((part) => part.kind === "op-amp")
    ? Math.abs(parts[sources[0].id]?.currentAmps ?? 0) : null;
  return {
    status,
    message,
    mode,
    ...(mode === "ac" ? { frequencyHz } : {}),
    currentAmps,
    parts,
    bulbPowerWatts: Object.fromEntries(document.parts.filter((part) => part.kind === "bulb").map((part) => [part.id, parts[part.id]?.powerWatts ?? 0])),
    // Ideal wires can form loops with indeterminate branch currents; do not invent flow directions.
    wireCurrents: {},
    issues: analog.issues,
  };
}
