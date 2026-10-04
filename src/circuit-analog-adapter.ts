import { circuitAnalysisOptionsSchema, simulationBooleanSchema } from "./circuit-validation.js";
import { analyzeAnalogCircuit, type ComplexValue, type AnalogCircuitPartReading } from "./analog-solver.js";
import { complex, complexDivide, complexMagnitude, complexPhaseDegrees } from "./analog-math.js";
import { exactComplexValue } from "./exact-numeric-state.js";
import { acAnalysisFrequency, frequencyMatches, isAcReactiveConductive } from "./ac-reactive.js";
import { circuitPartCatalog, terminalsOf, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "./circuit-model.js";
import {
  circuitEndpointsConnected,
  connectCircuitEndpoints,
  createCircuitConnectivityGraph,
  joinCircuitPartTerminals,
  type CircuitConnectivityGraph,
} from "./circuit-connectivity.js";
import { SimulationSnapshotContext, snapshotSimulationRecord, validatedSimulationDocument } from "./simulation-input.js";
import type { CircuitAnalysis, CircuitAnalysisOptions, CircuitIssue, CircuitPartReading } from "./circuit-solver.js";
import { readingPrecision, terminalVoltageDifferences } from "./circuit-reading.js";
import { bulbOverloadIssue } from "./circuit-power-diagnostics.js";

function shortedDcBattery(document: CircuitDocument, switchStates: Record<string, boolean>, readings: Record<string, AnalogCircuitPartReading>) {
  const graph = createCircuitConnectivityGraph(document);
  for (const part of document.parts) {
    if (part.kind === "ammeter" || (part.kind === "switch" && switchClosedState(part, switchStates)) ||
        part.kind === "inductor" || part.kind === "ac-source" ||
        (part.kind === "battery" && (part.internalResistanceOhms ?? 0) === 0)) {
      joinCircuitPartTerminals(graph, part.id, ["a", "b"]);
    }
    if (part.kind === "potentiometer") {
      const position = part.wiperPosition ?? circuitPartCatalog.potentiometer.defaults.wiperPosition ?? 0.5;
      if (position === 0) { joinCircuitPartTerminals(graph, part.id, ["a", "c"]); }
      if (position === 1) { joinCircuitPartTerminals(graph, part.id, ["b", "c"]); }
    }
  }
  return document.parts.find((part) => {
    if (part.kind !== "battery") { return false; }
    const reading = readings[part.id];
    const current = reading && exactComplexValue(reading.current);
    const voltage = reading && exactComplexValue(reading.voltage);
    // An ideal source path is a short only when its net imposed voltage is
    // exactly zero. Individual sources may be nonzero and cancel in series.
    return current !== null && current !== undefined && current.real.numerator !== 0n &&
      voltage?.real.numerator === 0n && circuitEndpointsConnected(
      graph, graph.endpointKey(part.id, "a"), graph.endpointKey(part.id, "b"),
    );
  });
}

function extendedAnalysisMessage(status: CircuitAnalysis["status"], analogMessage: string, shorted?: { label?: string }) {
  if (shorted) { return `${shorted.label ?? circuitPartCatalog.battery.defaults.label}が短絡しています。抵抗か電球を直列に入れてください。`; }
  return status === "open"
    ? "回路が開いているため電流は流れていません。導線とスイッチを確認してください。"
    : analogMessage;
}

function extendedAnalysisIssues(document: CircuitDocument, readings: Record<string, AnalogCircuitPartReading>,
  analogIssues: readonly CircuitIssue[], message: string, shorted?: CircuitPart) {
  const issues = [...analogIssues];
  if (shorted) { issues.unshift({ severity: "error", partId: shorted.id, message }); }
  for (const part of document.parts) {
    if (part.kind !== "bulb" || !Object.hasOwn(readings, part.id)) { continue; }
    const power = exactComplexValue(readings[part.id]!.power);
    const warning = power && bulbOverloadIssue(part, power.real);
    if (warning) { issues.push(warning); }
  }
  return issues;
}

const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const directlyConductiveKinds = new Set<CircuitPart["kind"]>([
  "battery", "ac-source", "resistor", "bulb", "ammeter", "diode", "led",
]);
const smallSignalCurrentKinds = new Set<CircuitPart["kind"]>([
  "diode", "led", "npn-transistor", "pnp-transistor", "nmos", "pmos",
]);
const magnitude = complexMagnitude;
const phase = complexPhaseDegrees;

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

interface ConductivityGraph extends CircuitConnectivityGraph {
  firstGround?: CircuitPart;
}

function partEstablishesPotentialPath(part: CircuitPart, mode: "dc" | "ac", frequencyHz: number) {
  if (directlyConductiveKinds.has(part.kind)) { return true; }
  if (part.kind === "inductor") {
    return mode === "dc" || isAcReactiveConductive(part, frequencyHz);
  }
  return part.kind === "capacitor" && mode === "ac" && isAcReactiveConductive(part, frequencyHz);
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
  frequencyHz: number,
  switchStates: Record<string, boolean>,
  reference: string | undefined,
) {
  if (partEstablishesPotentialPath(part, mode, frequencyHz)) {
    joinCircuitPartTerminals(graph, part.id, ["a", "b"]);
    return;
  }
  if (part.kind === "switch") {
    if (switchClosedState(part, switchStates)) { joinCircuitPartTerminals(graph, part.id, ["a", "b"]); }
    return;
  }
  if (part.kind === "capacitor" || part.kind === "inductor") { return; }
  if (part.kind === "current-source") {
    const currentAmps = part.currentAmps ?? circuitPartCatalog["current-source"].defaults.currentAmps ?? 0;
    if (mode === "dc" && currentAmps !== 0) { joinCircuitPartTerminals(graph, part.id, ["a", "b"]); }
    return;
  }
  if (part.kind === "potentiometer" || part.kind === "npn-transistor" || part.kind === "pnp-transistor") {
    joinCircuitPartTerminals(graph, part.id, ["a", "b", "c"]);
    return;
  }
  if (part.kind === "nmos" || part.kind === "pmos") {
    joinCircuitPartTerminals(graph, part.id, ["a", "c"]);
    return;
  }
  if (part.kind === "op-amp") {
    const target = reference ?? referenceEndpointKey(document, graph);
    if (target) { connectCircuitEndpoints(graph, graph.endpointKey(part.id, "c"), target); }
  }
}

function connectivityGraph(
  document: CircuitDocument,
  mode: "dc" | "ac",
  frequencyHz: number,
  switchStates: Record<string, boolean>,
  excludedPartId: string,
  readings: Record<string, CircuitPartReading>,
) {
  const graph: ConductivityGraph = {
    ...createCircuitConnectivityGraph(document),
    firstGround: document.parts.find((part) => part.kind === "ground"),
  };
  const reference = referenceEndpointKey(document, graph);
  for (const part of document.parts) {
    if (part.id === excludedPartId) { continue; }
    const reading = readings[part.id];
    if (mode === "ac" && smallSignalCurrentKinds.has(part.kind) &&
        reading?.acCurrentResponseTerminalGroups !== undefined) {
      for (const group of reading.acCurrentResponseTerminalGroups) {
        if (group.length > 1) { joinCircuitPartTerminals(graph, part.id, group); }
      }
      continue;
    }
    if ((part.kind === "nmos" || part.kind === "pmos") && reading?.channelConducting === false) { continue; }
    connectPartInGraph(graph, part, document, mode, frequencyHz, switchStates, reference);
  }
  return graph;
}

function hasSourceReturnPath(
  document: CircuitDocument,
  source: CircuitPart,
  mode: "dc" | "ac",
  frequencyHz: number,
  switchStates: Record<string, boolean>,
  readings: Record<string, CircuitPartReading>,
) {
  const graph = connectivityGraph(document, mode, frequencyHz, switchStates, source.id, readings);
  return circuitEndpointsConnected(
    graph,
    graph.endpointKey(source.id, "a"),
    graph.endpointKey(source.id, "b"),
  );
}

function hasOpAmpOutputReturnPath(
  document: CircuitDocument,
  opAmp: CircuitPart,
  mode: "dc" | "ac",
  frequencyHz: number,
  switchStates: Record<string, boolean>,
  readings: Record<string, CircuitPartReading>,
) {
  const graph = connectivityGraph(document, mode, frequencyHz, switchStates, opAmp.id, readings);
  const reference = referenceEndpointKey(document, graph);
  return reference !== undefined && circuitEndpointsConnected(
    graph,
    graph.endpointKey(opAmp.id, "c"),
    reference,
  );
}

function isActiveSourceForMode(source: CircuitPart, mode: "dc" | "ac", frequencyHz: number) {
  if (source.kind === "battery") { return mode === "dc"; }
  if (source.kind === "ac-source") {
    if (mode === "dc") {
      return (source.offsetVolts ?? circuitPartCatalog["ac-source"].defaults.offsetVolts ?? 0) !== 0;
    }
    const sourceFrequency = source.frequencyHz ?? circuitPartCatalog["ac-source"].defaults.frequencyHz ?? 0;
    const amplitude = source.voltageVolts ?? circuitPartCatalog["ac-source"].defaults.voltageVolts ?? 0;
    return amplitude !== 0 && frequencyMatches(sourceFrequency, frequencyHz);
  }
  if (source.kind !== "current-source") { return true; }
  const currentAmps = source.currentAmps ?? circuitPartCatalog["current-source"].defaults.currentAmps ?? 0;
  return mode === "dc" && currentAmps !== 0;
}

function analysisStatus(
  document: CircuitDocument,
  analogStatus: "valid" | "empty" | "invalid",
  sources: CircuitPart[],
  mode: "dc" | "ac",
  frequencyHz: number,
  switchStates: Record<string, boolean>,
  readings: Record<string, CircuitPartReading>,
  analogReadings: Record<string, AnalogCircuitPartReading>,
): CircuitAnalysis["status"] {
  if (analogStatus !== "valid") { return analogStatus; }
  const hasOpAmpOutputLoop = document.parts.some((part) =>
    part.kind === "op-amp" && hasOpAmpOutputReturnPath(document, part, mode, frequencyHz, switchStates, readings),
  );
  const activeSources = sources.filter((source) => isActiveSourceForMode(source, mode, frequencyHz));
  if (activeSources.length === 0) { return hasOpAmpOutputLoop ? "closed" : "idle"; }
  const hasClosedSourceLoop = activeSources.some((source) =>
    hasSourceReturnPath(document, source, mode, frequencyHz, switchStates, readings),
  );
  // A transistor can drive a closed output loop while its input draws no
  // current. The solved terminal currents satisfy KCL even when the input
  // source has no conductive return path. Inspect before display rounding.
  const hasControlledCurrent = mode === "ac" && document.parts.some((part) =>
    smallSignalCurrentKinds.has(part.kind) && Object.values(analogReadings[part.id]?.terminalCurrents ?? {}).some((current) => {
      const exact = exactComplexValue(current);
      return exact !== null && (exact.real.numerator !== 0n || exact.imaginary.numerator !== 0n);
    }),
  );
  return hasClosedSourceLoop || hasOpAmpOutputLoop || hasControlledCurrent ? "closed" : "open";
}

function adaptReading(
  part: CircuitPart,
  reading: AnalogCircuitPartReading,
  ac: boolean,
  switchStates: Record<string, boolean>,
): CircuitPartReading {
  const deliversPower = ac ? part.kind === "ac-source" : sourceKinds.has(part.kind);
  const powerWatts = part.kind === "capacitor" || part.kind === "inductor" ? 0
    : reading.power.real * (deliversPower ? -1 : 1);
  const localDifferences = terminalVoltageDifferences(reading.terminalVoltages, ac, reading.terminalVoltageDifferences);
  const result: CircuitPartReading = {
    voltageVolts: ac ? magnitude(reading.voltage) : reading.voltage.real,
    currentAmps: ac ? magnitude(reading.current) : reading.current.real,
    powerWatts,
    terminalVoltages: terminalValues(reading.terminalVoltages, ac),
    ...readingPrecision(reading),
    ...(localDifferences ? { terminalVoltageDifferences: localDifferences } : {}),
    terminalCurrents: terminalValues(reading.terminalCurrents, ac),
    ...(reading.meterStatus ? { meterStatus: reading.meterStatus } : {}),
    ...(part.kind === "switch" ? { switchClosed: switchClosedState(part, switchStates) } : {}),
    ...(reading.channelConducting === undefined ? {} : { channelConducting: reading.channelConducting }),
    ...(reading.acReferenceTerminalGroups === undefined
      ? {}
      : { acReferenceTerminalGroups: reading.acReferenceTerminalGroups }),
    ...(reading.acCurrentResponseTerminalGroups === undefined
      ? {}
      : { acCurrentResponseTerminalGroups: reading.acCurrentResponseTerminalGroups }),
  };
  if (ac) {
    result.voltagePhaseDegrees = phase(reading.voltage);
    result.currentPhaseDegrees = phase(reading.current);
    result.reactivePowerVars = reading.power.imaginary;
    result.terminalVoltagePhasesDegrees = Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, phase(value)]));
    result.terminalCurrentPhasesDegrees = Object.fromEntries(Object.entries(reading.terminalCurrents).map(([terminal, value]) => [terminal, phase(value)]));
  }
  if (part.kind === "bulb") { result.brightness = reading.brightness; }
  if (part.kind === "led" && !ac) { result.brightness = Math.max(0, Math.min(1, complexDivide(reading.current, complex(part.ratedCurrentAmps ?? 0.02)).real)); }
  return result;
}

/** Bridges complex circuit analysis to the editor's scalar reading API. */
export function analyzeExtendedCircuit(
  document: CircuitDocument,
  switchStates: Record<string, boolean>,
  options: CircuitAnalysisOptions,
): CircuitAnalysis {
  try {
    return analyzeExtendedCircuitFromInput(document, switchStates, options);
  } catch {
    return invalidAdapterResult("回路データまたは解析条件を読み取れません。");
  }
}

function analyzeExtendedCircuitFromInput(
  inputDocument: CircuitDocument,
  inputSwitchStates: Record<string, boolean>,
  options: CircuitAnalysisOptions,
): CircuitAnalysis {
  const input = adapterInput(inputDocument, inputSwitchStates, options);
  if (typeof input === "string") { return invalidAdapterResult(input); }
  // The solver, scalar readings and connectivity must share one document.
  const { document, switchStates, options: validatedOptions } = input;
  const firstAc = document.parts.find((part) => part.kind === "ac-source");
  const mode = validatedOptions.mode === "ac" || (validatedOptions.mode !== "dc" && firstAc) ? "ac" : "dc";
  const frequencyHz = acAnalysisFrequency(document, validatedOptions.frequencyHz);
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
  const shorted = analog.status === "valid" && mode === "dc" ? shortedDcBattery(document, switchStates, analog.parts) : undefined;
  const status = shorted ? "short" : analysisStatus(document, analog.status, sources, mode, frequencyHz, switchStates, parts, analog.parts);
  const message = extendedAnalysisMessage(status, analog.message, shorted);
  const currentAmps = analog.status === "valid" && sources.length === 1 && !document.parts.some((part) => part.kind === "op-amp")
    ? Math.abs(parts[sources[0].id]?.currentAmps ?? 0) : null;
  return {
    status,
    message,
    mode,
    ...(mode === "ac" ? { frequencyHz } : {}),
    currentAmps,
    parts,
    bulbPowerWatts: Object.fromEntries(document.parts
      .filter((part) => part.kind === "bulb" && Object.hasOwn(parts, part.id))
      .map((part) => [part.id, parts[part.id]!.powerWatts])),
    // Ideal wires can form loops with indeterminate branch currents; do not invent flow directions.
    wireCurrents: {},
    issues: extendedAnalysisIssues(document, analog.parts, analog.issues, message, shorted),
  };
}

function invalidAdapterResult(message: string): CircuitAnalysis {
  return {
    status: "invalid",
    message,
    currentAmps: null,
    parts: {},
    bulbPowerWatts: {},
    wireCurrents: {},
    issues: [{ severity: "error", message }],
  };
}

function adapterInput(document: unknown, switchStates: unknown, options: unknown): string | {
  document: CircuitDocument;
  switchStates: Record<string, boolean>;
  options: CircuitAnalysisOptions;
} {
  try {
    const context = new SimulationSnapshotContext();
    const validatedDocument = validatedSimulationDocument(document, context);
    if (typeof validatedDocument === "string") { return validatedDocument; }
    const kinds = new Map(validatedDocument.parts.map((part) => [part.id, part.kind]));
    const snapshot = snapshotSimulationRecord(switchStates, kinds.keys(), context);
    if (!snapshot) {
      return "スイッチ状態は部品 ID ごとの真偽値で指定してください。";
    }
    const capturedOptions = snapshotSimulationRecord(options, undefined, context);
    if (!capturedOptions) { return "解析条件はオブジェクトで指定してください。"; }
    const parsed = circuitAnalysisOptionsSchema.safeParse(capturedOptions);
    if (!parsed.success) { return parsed.error.issues[0]!.message; }
    for (const [partId, state] of Object.entries(snapshot)) {
      if (kinds.get(partId) !== "switch") { return `スイッチ状態の対象「${partId}」はスイッチ部品ではありません。`; }
      if (!simulationBooleanSchema.safeParse(state).success) { return "スイッチ状態は部品 ID ごとの真偽値で指定してください。"; }
    }
    if (!context.isStable()) { return "回路データまたは解析条件が取得中に変更されました。"; }
    // Keep mode selection, solving and readings on the validated option values.
    return { document: validatedDocument, switchStates: snapshot as Record<string, boolean>, options: parsed.data };
  } catch {
    return "解析条件またはスイッチ状態を読み取れません。";
  }
}
