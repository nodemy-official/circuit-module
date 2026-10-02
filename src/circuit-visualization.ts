import { circuitPartCatalog, endpointName, terminalsOf, type CircuitDocument, type CircuitEndpoint, type CircuitPart, type CircuitTerminal } from "./circuit-model.js";
import { complex, complexAdd, complexDivide, complexFromPolar, complexMagnitude, complexMultiply, complexPhaseDegrees, complexSubtract } from "./analog-math.js";
import {
  circuitEndpointsConnected,
  connectCircuitEndpoints,
  createCircuitConnectivityGraph,
  joinCircuitPartTerminals,
} from "./circuit-connectivity.js";
import type { CircuitAnalysis, CircuitPartReading } from "./circuit-solver.js";
import { acAnalysisFrequency, isAcReactiveConductive } from "./ac-reactive.js";
import { formatCircuitNumber } from "./number-format.js";
import type { TransientAnalysis } from "./transient-solver.js";
import { retainedComplexIsNonzero, restoredReadingComplex, type CircuitExactComplex } from "./circuit-reading.js";
import type { ExactExpressionNode } from "./exact-expression.js";

export interface CircuitPotentialContext {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  nodes?: CircuitNode[];
}

export interface CircuitTransientFrame {
  analysis: TransientAnalysis;
  sampleIndex: number;
}

export interface CircuitNodeCurrent {
  endpoint: CircuitEndpoint;
  label: string;
  /** Positive is leaving the net and entering the component. AC is an RMS magnitude. */
  amps: number;
  phaseDegrees?: number;
}

export interface CircuitNode {
  id: string;
  label: string;
  endpoints: CircuitEndpoint[];
  referenceGroup: string;
  voltageVolts?: number;
  voltagePhaseDegrees?: number;
  exactVoltage?: CircuitExactComplex;
  currents: CircuitNodeCurrent[];
  /** Magnitude of the signed (DC) or phasor (AC) sum. Undefined for incomplete readings. */
  currentResidualAmps?: number;
  currentBalanceNote?: string;
}

export const circuitEndpointKey = (endpoint: CircuitEndpoint) => JSON.stringify([endpoint.partId, endpoint.terminal]);
const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

function transientFrameParts(document: CircuitDocument, sample: TransientAnalysis["samples"][number], expressions?: readonly ExactExpressionNode[]) {
  const parts = Object.create(null) as Record<string, CircuitPartReading>;
  for (const part of document.parts) {
    if (!Object.hasOwn(sample.parts, part.id)) { continue; }
    const reading = sample.parts[part.id];
    if (!reading) { continue; }
    const powerWatts = reading.powerWatts * (sourceKinds.has(part.kind) ? -1 : 1);
    let brightness: number | undefined;
    if (part.kind === "bulb" || part.kind === "led") {
      const current = restoredReadingComplex(reading.exactTerminalCurrents?.a, reading.currentAmps, undefined, false, expressions) ?? complex(reading.currentAmps);
      const voltage = restoredReadingComplex(reading.exactVoltage, reading.voltageVolts, undefined, false, expressions) ?? complex(reading.voltageVolts);
      const relative = part.kind === "bulb"
        ? complexDivide(complexMultiply(voltage, current), complex(part.ratedPowerWatts ?? 2))
        : complexDivide(current, complex(part.ratedCurrentAmps ?? 0.02));
      brightness = Math.max(0, Math.min(1, relative.real));
    }
    parts[part.id] = { ...reading, powerWatts, ...(brightness === undefined ? {} : { brightness }) };
  }
  return parts;
}

function transientSourceIsActive(part: CircuitPart, sample: TransientAnalysis["samples"][number], expressions?: readonly ExactExpressionNode[]) {
  if (part.kind === "battery") { return (part.voltageVolts ?? circuitPartCatalog.battery.defaults.voltageVolts ?? 0) !== 0; }
  if (part.kind === "ac-source") {
    return (part.voltageVolts ?? circuitPartCatalog["ac-source"].defaults.voltageVolts ?? 0) !== 0 ||
      (part.offsetVolts ?? circuitPartCatalog["ac-source"].defaults.offsetVolts ?? 0) !== 0;
  }
  if (part.kind === "current-source") {
    return (part.currentAmps ?? circuitPartCatalog["current-source"].defaults.currentAmps ?? 0) !== 0;
  }
  const reading = sample.parts[part.id];
  // Displayed state values can underflow while the exact state still drives
  // a representable current or voltage at the other reactive terminal value.
  if (part.kind !== "capacitor" && part.kind !== "inductor") { return false; }
  if ((finite(reading?.voltageVolts) && reading.voltageVolts !== 0) ||
    (finite(reading?.currentAmps) && reading.currentAmps !== 0)) { return true; }
  return [reading?.exactVoltage, reading?.exactTerminalCurrents?.a].some((retained) => retainedComplexIsNonzero(retained, expressions));
}

function transientConductiveTerminals(
  part: CircuitPart,
  sample: TransientAnalysis["samples"][number],
): CircuitTerminal[] {
  switch (part.kind) {
    case "battery":
    case "ac-source":
    case "resistor":
    case "bulb":
    case "ammeter":
    case "diode":
    case "led":
    case "capacitor":
    case "inductor":
      return ["a", "b"];
    case "switch":
      return sample.parts[part.id]?.switchClosed ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false
        ? ["a", "b"] : [];
    case "potentiometer":
    case "npn-transistor":
    case "pnp-transistor":
      return ["a", "b", "c"];
    case "nmos":
    case "pmos":
      return sample.parts[part.id]?.channelConducting !== false ? ["a", "c"] : [];
    case "current-source":
      return transientSourceIsActive(part, sample) ? ["a", "b"] : [];
    default:
      return [];
  }
}

function transientConnectivityGraph(
  document: CircuitDocument,
  sample: TransientAnalysis["samples"][number],
  excludedPartId: string,
) {
  const graph = createCircuitConnectivityGraph(document);
  const { endpointKey } = graph;
  const grounds = document.parts.filter((part) => part.kind === "ground");
  const firstGround = grounds[0];
  const firstPart = document.parts[0];
  const referenceTerminal = firstPart ? terminalsOf(firstPart.kind)[0] : undefined;
  const reference = firstGround
    ? endpointKey(firstGround.id, "a")
    : firstPart && referenceTerminal ? endpointKey(firstPart.id, referenceTerminal) : undefined;
  for (const part of document.parts) {
    if (part.id === excludedPartId) { continue; }
    if (part.kind === "op-amp" && reference) {
      connectCircuitEndpoints(graph, endpointKey(part.id, "c"), reference);
    }
    joinCircuitPartTerminals(graph, part.id, transientConductiveTerminals(part, sample));
  }
  return { ...graph, reference };
}

function transientReturnPath(
  document: CircuitDocument,
  sample: TransientAnalysis["samples"][number],
  sourceId: string,
) {
  const graph = transientConnectivityGraph(document, sample, sourceId);
  return circuitEndpointsConnected(
    graph,
    graph.endpointKey(sourceId, "a"),
    graph.endpointKey(sourceId, "b"),
  );
}

function transientOpAmpOutputReturnPath(
  document: CircuitDocument,
  sample: TransientAnalysis["samples"][number],
  opAmpId: string,
) {
  const graph = transientConnectivityGraph(document, sample, opAmpId);
  return graph.reference !== undefined && circuitEndpointsConnected(
    graph,
    graph.endpointKey(opAmpId, "c"),
    graph.reference,
  );
}

function transientAnalysisStatus(
  document: CircuitDocument,
  sample: TransientAnalysis["samples"][number],
  expressions?: readonly ExactExpressionNode[],
): CircuitAnalysis["status"] {
  const sources = document.parts.filter((part) => transientSourceIsActive(part, sample, expressions));
  const hasOpAmpOutputLoop = document.parts.some((part) =>
    part.kind === "op-amp" && transientOpAmpOutputReturnPath(document, sample, part.id),
  );
  if (sources.length === 0) { return hasOpAmpOutputLoop ? "closed" : "idle"; }
  return sources.some((part) => transientReturnPath(document, sample, part.id)) || hasOpAmpOutputLoop
    ? "closed"
    : "open";
}

/** Adapt a sampled state without re-solving it as a DC operating point. */
export function analysisAtTransientFrame(document: CircuitDocument, frame: CircuitTransientFrame): CircuitAnalysis | null {
  if (frame.analysis.status !== "valid") { return null; }
  const sample = frame.analysis.samples[frame.sampleIndex];
  if (!sample) { return null; }
  const parts = transientFrameParts(document, sample, frame.analysis.precisionExpressions);
  const sources = document.parts.filter((part) => sourceKinds.has(part.kind));
  const hasOpAmp = document.parts.some((part) => part.kind === "op-amp");
  const sourceCurrent = sources.length === 1 && !hasOpAmp ? parts[sources[0].id]?.currentAmps : undefined;
  return {
    status: transientAnalysisStatus(document, sample, frame.analysis.precisionExpressions), mode: "dc", timeSeconds: sample.timeSeconds, currentAmps: finite(sourceCurrent) ? Math.abs(sourceCurrent) : null,
    message: `過渡解析：${formatCircuitQuantity(sample.timeSeconds, "s")} の瞬時値`,
    parts, wireCurrents: {}, issues: frame.analysis.issues,
    ...(frame.analysis.precisionExpressions ? { precisionExpressions: frame.analysis.precisionExpressions } : {}),
    bulbPowerWatts: Object.fromEntries(document.parts.filter((part) => part.kind === "bulb").map((part) => [part.id, parts[part.id]?.powerWatts ?? 0])),
  };
}

function nodeGroups(keys: string[]) {
  const parents = new Map(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let root = parents.get(key) ?? key;
    while (parents.has(root) && parents.get(root) !== root) { root = parents.get(root)!; }
    if (parents.has(key)) { parents.set(key, root); }
    return root;
  };
  const union = (first: string, second: string) => {
    if (parents.has(first) && parents.has(second)) { parents.set(find(second), find(first)); }
  };
  return { find, union };
}

function phasor(value: number, degrees = 0) {
  return complexFromPolar(value, degrees);
}

function analysisFrequency(document: CircuitDocument, analysis: CircuitAnalysis) {
  return acAnalysisFrequency(document, analysis.frequencyHz);
}

function referenceTerminalGroups(
  part: CircuitPart,
  analysis: CircuitAnalysis,
  frequencyHz: number,
): readonly (readonly CircuitTerminal[])[] {
  const acGroups = analysis.mode === "ac" ? analysis.parts[part.id]?.acReferenceTerminalGroups : undefined;
  if (acGroups !== undefined) { return acGroups; }

  switch (part.kind) {
    case "battery":
    case "ac-source":
    case "resistor":
    case "bulb":
    case "ammeter":
    case "diode":
    case "led":
      return [["a", "b"]];
    case "inductor":
      return analysis.mode === "ac"
        ? isAcReactiveConductive(part, frequencyHz) ? [["a", "b"]] : []
        : [["a", "b"]];
    case "switch":
      return (analysis.parts[part.id]?.switchClosed ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false) ? [["a", "b"]] : [];
    case "capacitor":
      return analysis.timeSeconds !== undefined ||
        (analysis.mode === "ac" && isAcReactiveConductive(part, frequencyHz)) ? [["a", "b"]] : [];
    case "potentiometer":
    case "npn-transistor":
    case "pnp-transistor":
      return [["a", "b", "c"]];
    case "nmos":
    case "pmos":
      return analysis.parts[part.id]?.channelConducting === false ? [] : [["a", "c"]];
    default:
      // Ideal current sources, voltmeters, MOS gates, and op-amp inputs do not
      // establish a voltage reference between their terminals.
      return [];
  }
}

function potentialReferenceGroups(
  document: CircuitDocument,
  endpoints: CircuitEndpoint[],
  analysis: CircuitAnalysis,
) {
  const references = nodeGroups(endpoints.map(circuitEndpointKey));
  const frequencyHz = analysisFrequency(document, analysis);
  const firstGround = document.parts.find((part) => part.kind === "ground");
  const solverReference = firstGround
    ? circuitEndpointKey({ partId: firstGround.id, terminal: "a" })
    : endpoints[0] ? circuitEndpointKey(endpoints[0]) : undefined;
  for (const wire of document.wires) {
    references.union(circuitEndpointKey(wire.from), circuitEndpointKey(wire.to));
  }
  for (const ground of document.parts.filter((part) => part.kind === "ground").slice(1)) {
    const first = circuitEndpointKey({ partId: firstGround?.id ?? ground.id, terminal: "a" });
    references.union(first, circuitEndpointKey({ partId: ground.id, terminal: "a" }));
  }
  for (const part of document.parts) {
    if (part.kind === "op-amp") {
      if (solverReference) {
        references.union(circuitEndpointKey({ partId: part.id, terminal: "c" }), solverReference);
      }
      continue;
    }
    for (const group of referenceTerminalGroups(part, analysis, frequencyHz)) {
      const first = group[0];
      if (!first) { continue; }
      const firstKey = circuitEndpointKey({ partId: part.id, terminal: first });
      for (const terminal of group.slice(1)) {
        references.union(firstKey, circuitEndpointKey({ partId: part.id, terminal }));
      }
    }
  }
  return references;
}

function nodeReading(endpoints: CircuitEndpoint[], document: CircuitDocument, analysis: CircuitAnalysis) {
  const currents: CircuitNodeCurrent[] = [];
  let current = complex();
  let voltageVolts: number | undefined;
  let voltagePhaseDegrees: number | undefined;
  let exactVoltage: CircuitExactComplex | undefined;
  let complete = true;
  for (const endpoint of endpoints) {
    const part = document.parts.find((item) => item.id === endpoint.partId)!;
    const reading = analysis.parts[part.id];
    const voltage = reading?.terminalVoltages?.[endpoint.terminal];
    if (voltageVolts === undefined && finite(voltage) && reading?.meterStatus !== "floating") {
      voltageVolts = voltage;
      voltagePhaseDegrees = reading?.terminalVoltagePhasesDegrees?.[endpoint.terminal];
      exactVoltage = reading?.exactTerminalVoltages?.[endpoint.terminal];
    }
    if (part.kind === "junction" || part.kind === "ground") { continue; }
    const amps = reading?.terminalCurrents?.[endpoint.terminal];
    const phaseDegrees = reading?.terminalCurrentPhasesDegrees?.[endpoint.terminal];
    if (!finite(amps) || reading?.meterStatus === "floating" || (analysis.mode === "ac" && !finite(phaseDegrees))) { complete = false; continue; }
    currents.push({ endpoint, label: endpointName(part, endpoint.terminal), amps, phaseDegrees });
    const value = restoredReadingComplex(reading?.exactTerminalCurrents?.[endpoint.terminal], amps, phaseDegrees, analysis.mode === "ac", analysis.precisionExpressions) ?? phasor(amps, phaseDegrees);
    current = complexAdd(current, value);
  }
  return {
    voltageVolts,
    voltagePhaseDegrees,
    ...(exactVoltage ? { exactVoltage } : {}),
    currents,
    currentResidualAmps: complete && currents.length > 0 ? complexMagnitude(current) : undefined,
  };
}

function markImplicitSupplyReturn(document: CircuitDocument, nodes: CircuitNode[]): CircuitNode[] {
  if (!document.parts.some((part) => part.kind === "op-amp")) { return nodes; }
  // The simplified op-amp returns its output current through the solver reference.
  // That power-supply terminal is not part of the three-terminal drawing.
  const ground = document.parts.find((part) => part.kind === "ground");
  const reference = ground ? nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === ground.id)) : nodes[0];
  return nodes.map((node) => node !== reference ? node : {
    ...node,
    currentResidualAmps: undefined,
    currentBalanceNote: "オペアンプの省略された電源端子にも電流が流れるため、表示中の端子だけでは流入・流出を合計できません。",
  });
}

/** Merge ideal-wire endpoints, retaining terminal currents instead of inventing currents in wire loops. */
export function circuitNodes(document: CircuitDocument, analysis: CircuitAnalysis): CircuitNode[] {
  if (analysis.status === "invalid" || analysis.status === "short" || analysis.status === "empty") { return []; }
  const endpoints = document.parts.flatMap((part) => terminalsOf(part.kind).map((terminal) => ({ partId: part.id, terminal })));
  const keys = endpoints.map(circuitEndpointKey);
  const nets = nodeGroups(keys);
  const references = potentialReferenceGroups(document, endpoints, analysis);
  for (const wire of document.wires) {
    nets.union(circuitEndpointKey(wire.from), circuitEndpointKey(wire.to));
  }
  const grounds = document.parts.filter((part) => part.kind === "ground");
  for (const ground of grounds.slice(1)) {
    const first = circuitEndpointKey({ partId: grounds[0].id, terminal: "a" });
    const next = circuitEndpointKey({ partId: ground.id, terminal: "a" });
    nets.union(first, next);
  }
  const grouped = new Map<string, CircuitEndpoint[]>();
  for (const endpoint of endpoints) {
    const key = nets.find(circuitEndpointKey(endpoint));
    const group = grouped.get(key) ?? [];
    group.push(endpoint); grouped.set(key, group);
  }
  const nodes = [...grouped.values()].map((members, index) => {
    const first = members[0];
    const part = document.parts.find((item) => item.id === first.partId)!;
    return {
      id: circuitEndpointKey(first), label: `N${index + 1} · ${endpointName(part, first.terminal)}`,
      endpoints: members, referenceGroup: references.find(circuitEndpointKey(first)),
      ...nodeReading(members, document, analysis),
    };
  });
  return markImplicitSupplyReturn(document, nodes);
}

export function defaultReferenceNode(document: CircuitDocument, nodes: CircuitNode[]): CircuitNode | undefined {
  const reference = document.parts.find((part) => part.kind === "ground") ?? document.parts.find((part) => part.kind === "battery" || part.kind === "ac-source");
  return nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === reference?.id && endpoint.terminal === (reference.kind === "ground" ? "a" : "b"))) ?? nodes[0];
}

const preciseTwoTerminalVoltageKinds = new Set<CircuitPart["kind"]>([
  "battery", "ac-source", "current-source", "resistor", "bulb", "capacitor", "inductor", "ammeter", "diode", "led", "switch",
]);

const preciseThreeTerminalVoltageKinds = new Set<CircuitPart["kind"]>(["npn-transistor", "pnp-transistor", "nmos", "pmos"]);

function hasPreciseTwoTerminalVoltage(part: CircuitPart, reading: CircuitPartReading): boolean {
  if (part.kind === "voltmeter") { return reading.meterStatus === "connected"; }
  return preciseTwoTerminalVoltageKinds.has(part.kind);
}

function sharedPartTerminalPairs(
  node: CircuitNode,
  reference: CircuitNode,
): { partId: string; fromTerminal: CircuitTerminal; toTerminal: CircuitTerminal }[] {
  const pairs: { partId: string; fromTerminal: CircuitTerminal; toTerminal: CircuitTerminal }[] = [];
  for (const endpoint of node.endpoints) {
    for (const referenceEndpoint of reference.endpoints) {
      if (endpoint.partId !== referenceEndpoint.partId || endpoint.terminal === referenceEndpoint.terminal) { continue; }
      pairs.push({ partId: endpoint.partId, fromTerminal: endpoint.terminal, toTerminal: referenceEndpoint.terminal });
    }
  }
  return pairs;
}

function preciseBranchVoltage(
  pair: { partId: string; fromTerminal: CircuitTerminal; toTerminal: CircuitTerminal },
  context: CircuitPotentialContext,
) {
  const voltage = preciseBranchPhasor(pair, context);
  if (!voltage) { return; }
  if (context.analysis.mode !== "ac") { return { volts: voltage.real, phaseDegrees: 0 }; }
  const volts = complexMagnitude(voltage);
  return Number.isFinite(volts)
    ? { volts, phaseDegrees: complexPhaseDegrees(voltage) }
    : undefined;
}

interface ComplexPotential {
  real: number;
  imaginary: number;
}

interface PreciseBranchPair {
  partId: string;
  fromTerminal: CircuitTerminal;
  toTerminal: CircuitTerminal;
}

function terminalBranchPhasor(
  reading: CircuitPartReading,
  terminal: CircuitTerminal,
  resistance: number,
  ac: boolean,
  expressions?: readonly ExactExpressionNode[],
): ComplexPotential | undefined {
  const current = reading.terminalCurrents?.[terminal];
  const phaseDegrees = ac ? reading.terminalCurrentPhasesDegrees?.[terminal] : 0;
  if (!finite(current) || !finite(phaseDegrees) || !Number.isFinite(resistance)) { return; }
  const value = restoredReadingComplex(reading.exactTerminalCurrents?.[terminal], current, phaseDegrees, ac, expressions) ?? phasor(current, phaseDegrees);
  const voltage = complexMultiply(value, complex(resistance));
  return Number.isFinite(voltage.real) && Number.isFinite(voltage.imaginary) ? voltage : undefined;
}

function negativePotential(value: ComplexPotential): ComplexPotential {
  return complexMultiply(value, complex(-1));
}

function primaryReadingPhasor(reading: CircuitPartReading, reverse: boolean, ac: boolean, expressions?: readonly ExactExpressionNode[]): ComplexPotential | undefined {
  if (!finite(reading.voltageVolts)) { return; }
  const retained = restoredReadingComplex(reading.exactVoltage, reading.voltageVolts, reading.voltagePhaseDegrees, ac, expressions);
  if (retained) { return reverse ? negativePotential(retained) : retained; }
  if (!ac) { return { real: reading.voltageVolts * (reverse ? -1 : 1), imaginary: 0 }; }
  if (!finite(reading.voltagePhaseDegrees)) { return; }
  const voltage = phasor(
    Math.abs(reading.voltageVolts),
    reading.voltagePhaseDegrees,
  );
  // Adding 180 degrees first can erase an offset near an axis before its
  // quadrature voltage is reconstructed. Reverse the components instead.
  return Number.isFinite(voltage.real) && Number.isFinite(voltage.imaginary)
    ? reverse ? negativePotential(voltage) : voltage
    : undefined;
}

function potentiometerSegmentForPair(pair: PreciseBranchPair) {
  const segmentTerminal: "a" | "b" | undefined = pair.fromTerminal === "a" && pair.toTerminal === "c" ? "a"
    : pair.fromTerminal === "b" && pair.toTerminal === "c" ? "b"
      : pair.fromTerminal === "c" && pair.toTerminal === "a" ? "a"
        : pair.fromTerminal === "c" && pair.toTerminal === "b" ? "b" : undefined;
  if (!segmentTerminal) { return; }
  return { terminal: segmentTerminal, reverse: pair.fromTerminal === "c" };
}

function potentiometerBranchPhasor(
  part: CircuitPart,
  reading: CircuitPartReading,
  pair: PreciseBranchPair,
  ac: boolean,
  expressions?: readonly ExactExpressionNode[],
): ComplexPotential | undefined {
  if (pair.fromTerminal === "a" && pair.toTerminal === "b") { return primaryReadingPhasor(reading, false, ac, expressions); }
  if (pair.fromTerminal === "b" && pair.toTerminal === "a") { return primaryReadingPhasor(reading, true, ac, expressions); }
  const segment = potentiometerSegmentForPair(pair);
  if (!segment) { return; }
  const position = part.wiperPosition ?? 0.5;
  const totalResistance = part.resistanceOhms ?? 1000;
  const resistance = totalResistance * (segment.terminal === "a" ? position : 1 - position);
  const voltage = terminalBranchPhasor(reading, segment.terminal, resistance, ac, expressions);
  if (!voltage) { return; }
  return segment.reverse ? negativePotential(voltage) : voltage;
}

function preciseBranchPhasor(
  pair: PreciseBranchPair,
  context: CircuitPotentialContext,
): ComplexPotential | undefined {
  const part = context.document.parts.find((item) => item.id === pair.partId);
  const reading = context.analysis.parts[pair.partId];
  if (!part || !reading) { return; }
  const ac = context.analysis.mode === "ac";
  const expressions = context.analysis.precisionExpressions;
  const local = localTerminalPhasor(reading, pair, ac, expressions);
  if (local) { return local; }
  if (part.kind === "potentiometer") { return potentiometerBranchPhasor(part, reading, pair, ac, expressions); }
  if (preciseThreeTerminalVoltageKinds.has(part.kind)) {
    const forward = pair.fromTerminal === "a" && pair.toTerminal === "c";
    const reverse = pair.fromTerminal === "c" && pair.toTerminal === "a";
    return forward || reverse ? primaryReadingPhasor(reading, reverse, ac, expressions) : undefined;
  }
  if (!hasPreciseTwoTerminalVoltage(part, reading) ||
    !((pair.fromTerminal === "a" && pair.toTerminal === "b") ||
      (pair.fromTerminal === "b" && pair.toTerminal === "a"))) { return; }
  return primaryReadingPhasor(reading, pair.fromTerminal === "b", ac, expressions);
}

function localTerminalPhasor(reading: CircuitPartReading, pair: PreciseBranchPair, ac: boolean, expressions?: readonly ExactExpressionNode[]) {
  const difference = reading.terminalVoltageDifferences?.find((candidate) =>
    (candidate.fromTerminal === pair.fromTerminal && candidate.toTerminal === pair.toTerminal) ||
    (candidate.fromTerminal === pair.toTerminal && candidate.toTerminal === pair.fromTerminal));
  if (!difference || !finite(difference.voltageVolts)) { return; }
  const reverse = difference.fromTerminal === pair.toTerminal;
  const retained = restoredReadingComplex(difference.exactVoltage, difference.voltageVolts, difference.voltagePhaseDegrees, ac, expressions);
  if (retained) { return reverse ? negativePotential(retained) : retained; }
  if (!ac) { return { real: reverse ? -difference.voltageVolts : difference.voltageVolts, imaginary: 0 }; }
  if (!finite(difference.voltagePhaseDegrees)) { return; }
  const value = phasor(difference.voltageVolts, difference.voltagePhaseDegrees);
  return reverse ? negativePotential(value) : value;
}

interface PotentialPathEdge {
  nodeId: string;
  difference: ComplexPotential;
  cost: number;
}

interface PotentialPathGraph {
  nodeIds: string[];
  adjacency: Map<string, PotentialPathEdge[]>;
}

interface PotentialPathPredecessor {
  nodeId: string;
  difference: ComplexPotential;
}

interface PotentialPathTree {
  predecessors: Map<string, PotentialPathPredecessor>;
}

interface PotentialContextCache {
  snapshot: unknown[];
  trees: Map<string, PotentialPathTree>;
  graph?: PotentialPathGraph;
}

const potentialContextCaches = new WeakMap<CircuitPotentialContext, PotentialContextCache>();

function appendTerminalSnapshot(snapshot: unknown[], values: Partial<Record<CircuitTerminal, number>> | undefined) {
  snapshot.push(values);
  for (const terminal of ["a", "b", "c"] as const) { snapshot.push(values?.[terminal]); }
}

function appendTerminalGroupsSnapshot(
  snapshot: unknown[],
  groups: readonly (readonly CircuitTerminal[])[] | undefined,
) {
  snapshot.push(groups, groups?.length);
  for (const group of groups ?? []) {
    snapshot.push(group, group.length);
    for (const terminal of group) { snapshot.push(terminal); }
  }
}

function appendTerminalDifferencesSnapshot(snapshot: unknown[], reading: CircuitPartReading | undefined) {
  const differences = reading?.terminalVoltageDifferences;
  snapshot.push(differences, differences?.length);
  for (const difference of differences ?? []) {
    snapshot.push(difference, difference.fromTerminal, difference.toTerminal, difference.voltageVolts, difference.voltagePhaseDegrees);
    appendExactComplexSnapshot(snapshot, difference.exactVoltage);
  }
}

function appendExactComponentSnapshot(snapshot: unknown[], value: unknown) {
  snapshot.push(value);
  if (typeof value === "object" && value !== null) {
    snapshot.push("numerator" in value ? value.numerator : undefined,
      "denominator" in value ? value.denominator : undefined,
      "expression" in value ? value.expression : undefined,
      "sign" in value ? value.sign : undefined);
  }
}

function appendProjectionSnapshot(snapshot: unknown[], projection: unknown) {
  snapshot.push(projection);
  if (typeof projection === "object" && projection !== null) {
    snapshot.push("real" in projection ? projection.real : undefined,
      "magnitude" in projection ? projection.magnitude : undefined,
      "phaseDegrees" in projection ? projection.phaseDegrees : undefined);
  }
}

function appendExactComplexSnapshot(snapshot: unknown[], value: unknown) {
  snapshot.push(value);
  if (typeof value === "object" && value !== null) {
    appendExactComponentSnapshot(snapshot, "real" in value ? value.real : undefined);
    appendExactComponentSnapshot(snapshot, "imaginary" in value ? value.imaginary : undefined);
    appendExactComponentSnapshot(snapshot, "magnitudeNormalizationSquared" in value ? value.magnitudeNormalizationSquared : undefined);
    appendProjectionSnapshot(snapshot, "projection" in value ? value.projection : undefined);
  }
}

function appendReadingPrecisionSnapshot(snapshot: unknown[], reading: CircuitPartReading | undefined) {
  appendExactComplexSnapshot(snapshot, reading?.exactVoltage);
  for (const values of [reading?.exactTerminalVoltages, reading?.exactTerminalCurrents]) {
    snapshot.push(values);
    if (values) { for (const terminal of ["a", "b", "c"] as const) { appendExactComplexSnapshot(snapshot, values[terminal]); } }
  }
}

function potentialContextSnapshot(context: CircuitPotentialContext) {
  const { document, analysis } = context;
  const snapshot: unknown[] = [
    document,
    document.parts,
    document.wires,
    analysis,
    analysis.parts,
    analysis.precisionExpressions,
    context.nodes,
    analysis.status,
    analysis.mode,
    analysis.frequencyHz,
    analysis.timeSeconds,
    document.parts.length,
  ];

  for (const part of document.parts) {
    const reading = analysis.parts[part.id];
    appendReadingPrecisionSnapshot(snapshot, reading);
    snapshot.push(
      part,
      part.id,
      part.kind,
      part.resistanceOhms,
      part.wiperPosition,
      part.initiallyClosed,
      part.frequencyHz,
      part.capacitanceFarads,
      part.inductanceHenries,
      reading,
      reading?.meterStatus,
      reading?.switchClosed,
      reading?.channelConducting,
      reading?.acReferenceTerminalGroups,
      reading?.voltageVolts,
      reading?.voltagePhaseDegrees,
    );
    appendTerminalGroupsSnapshot(snapshot, reading?.acReferenceTerminalGroups);
    appendTerminalDifferencesSnapshot(snapshot, reading);
    appendTerminalSnapshot(snapshot, reading?.terminalVoltages);
    appendTerminalSnapshot(snapshot, reading?.terminalCurrents);
    appendTerminalSnapshot(snapshot, reading?.terminalVoltagePhasesDegrees);
    appendTerminalSnapshot(snapshot, reading?.terminalCurrentPhasesDegrees);
  }

  snapshot.push(document.wires.length);
  for (const wire of document.wires) {
    snapshot.push(
      wire,
      wire.from,
      wire.from.partId,
      wire.from.terminal,
      wire.to,
      wire.to.partId,
      wire.to.terminal,
    );
  }

  if (context.nodes) {
    snapshot.push(context.nodes.length);
    for (const node of context.nodes) {
      appendExactComplexSnapshot(snapshot, node.exactVoltage);
      snapshot.push(
        node,
        node.id,
        node.referenceGroup,
        node.endpoints,
        node.endpoints.length,
        node.voltageVolts,
        node.voltagePhaseDegrees,
      );
      for (const endpoint of node.endpoints) {
        snapshot.push(endpoint, endpoint.partId, endpoint.terminal);
      }
    }
  }

  return snapshot;
}

function samePotentialContextSnapshot(first: readonly unknown[], second: readonly unknown[]) {
  return first.length === second.length && first.every((value, index) => Object.is(value, second[index]));
}

function potentialContextCache(context: CircuitPotentialContext) {
  const snapshot = potentialContextSnapshot(context);
  const cached = potentialContextCaches.get(context);
  if (cached && samePotentialContextSnapshot(cached.snapshot, snapshot)) { return cached; }

  const next: PotentialContextCache = {
    snapshot,
    trees: new Map(),
  };
  potentialContextCaches.set(context, next);
  return next;
}

function leastCostPotentialNode(
  nodeIds: string[],
  costs: Map<string, number>,
  hops: Map<string, number>,
  visited: Set<string>,
) {
  let currentId: string | undefined;
  for (const candidateId of nodeIds) {
    if (visited.has(candidateId)) { continue; }
    const candidateCost = costs.get(candidateId) ?? Number.POSITIVE_INFINITY;
    const currentCost = currentId === undefined ? Number.POSITIVE_INFINITY : costs.get(currentId) ?? Number.POSITIVE_INFINITY;
    const candidateHops = hops.get(candidateId) ?? Number.POSITIVE_INFINITY;
    const currentHops = currentId === undefined ? Number.POSITIVE_INFINITY : hops.get(currentId) ?? Number.POSITIVE_INFINITY;
    if (candidateCost < currentCost || (candidateCost === currentCost && candidateHops < currentHops)) {
      currentId = candidateId;
    }
  }
  return currentId;
}

function improvesPotentialPath(candidateCost: number, candidateHops: number, knownCost: number, knownHops: number) {
  if (candidateCost < knownCost) { return true; }
  return candidateCost === knownCost && candidateHops < knownHops;
}

function potentialPathGraph(
  context: CircuitPotentialContext,
  cache: PotentialContextCache,
): PotentialPathGraph {
  if (cache.graph) { return cache.graph; }

  const nodes = context.nodes ?? circuitNodes(context.document, context.analysis);
  const byEndpoint = new Map<string, CircuitNode>();
  for (const node of nodes) {
    for (const endpoint of node.endpoints) { byEndpoint.set(circuitEndpointKey(endpoint), node); }
  }
  const parts = precisePotentialParts(context, byEndpoint);
  const largestMagnitude = Math.max(0, ...parts.map((part) => part.magnitude));

  const adjacency = new Map(nodes.map((node) => [node.id, [] as PotentialPathEdge[]]));
  for (const part of parts) {
    const cost = largestMagnitude === 0 ? 0 : part.magnitude / largestMagnitude;
    adjacency.get(part.first.id)?.push({ nodeId: part.second.id, difference: part.voltage, cost });
    adjacency.get(part.second.id)?.push({
      nodeId: part.first.id,
      difference: negativePotential(part.voltage),
      cost,
    });
  }
  const graph = { nodeIds: nodes.map((node) => node.id), adjacency };
  cache.graph = graph;
  return graph;
}

function preciseReadingTerminalPairs(part: CircuitPart, reading: CircuitPartReading | undefined): [CircuitTerminal, CircuitTerminal][] {
  const local = reading?.terminalVoltageDifferences;
  if (local) { return local.map((difference) => [difference.fromTerminal, difference.toTerminal]); }
  if (part.kind === "potentiometer") { return [["a", "c"], ["b", "c"]]; }
  return preciseThreeTerminalVoltageKinds.has(part.kind) ? [["a", "c"]] : [["a", "b"]];
}

function precisePotentialParts(
  context: CircuitPotentialContext,
  byEndpoint: Map<string, CircuitNode>,
) {
  const parts: {
    first: CircuitNode;
    second: CircuitNode;
    voltage: ComplexPotential;
    magnitude: number;
  }[] = [];
  for (const part of context.document.parts) {
    const terminalPairs = preciseReadingTerminalPairs(part, context.analysis.parts[part.id]);
    for (const [fromTerminal, toTerminal] of terminalPairs) {
      const first = byEndpoint.get(circuitEndpointKey({ partId: part.id, terminal: fromTerminal }));
      const second = byEndpoint.get(circuitEndpointKey({ partId: part.id, terminal: toTerminal }));
      if (!first || !second || first.id === second.id || first.referenceGroup !== second.referenceGroup) { continue; }
      const voltage = preciseBranchPhasor({ partId: part.id, fromTerminal, toTerminal }, context);
      if (!voltage) { continue; }
      const magnitude = complexMagnitude(voltage);
      if (!Number.isFinite(magnitude)) { continue; }
      parts.push({ first, second, voltage, magnitude });
    }
  }
  return parts;
}

function shortestPotentialPathTree(startId: string, graph: PotentialPathGraph): PotentialPathTree {
  const costs = new Map(graph.nodeIds.map((id) => [id, Number.POSITIVE_INFINITY]));
  const hops = new Map(graph.nodeIds.map((id) => [id, Number.POSITIVE_INFINITY]));
  const predecessors = new Map<string, PotentialPathPredecessor>();
  const visited = new Set<string>();
  costs.set(startId, 0);
  hops.set(startId, 0);

  while (visited.size < graph.nodeIds.length) {
    const currentId = leastCostPotentialNode(graph.nodeIds, costs, hops, visited);
    if (currentId === undefined || !Number.isFinite(costs.get(currentId))) { break; }
    visited.add(currentId);

    for (const edge of graph.adjacency.get(currentId) ?? []) {
      if (visited.has(edge.nodeId)) { continue; }
      const candidateCost = (costs.get(currentId) ?? Number.POSITIVE_INFINITY) + edge.cost;
      const candidateHops = (hops.get(currentId) ?? Number.POSITIVE_INFINITY) + 1;
      const knownCost = costs.get(edge.nodeId) ?? Number.POSITIVE_INFINITY;
      const knownHops = hops.get(edge.nodeId) ?? Number.POSITIVE_INFINITY;
      if (improvesPotentialPath(candidateCost, candidateHops, knownCost, knownHops)) {
        costs.set(edge.nodeId, candidateCost);
        hops.set(edge.nodeId, candidateHops);
        predecessors.set(edge.nodeId, { nodeId: currentId, difference: edge.difference });
      }
    }
  }
  return { predecessors };
}

function precisePathPotential(
  node: CircuitNode,
  reference: CircuitNode,
  context: CircuitPotentialContext,
  cache: PotentialContextCache,
): { volts: number; phaseDegrees: number } | undefined {
  if (node.id === reference.id) { return undefined; }
  let tree = cache.trees.get(reference.id);
  if (!tree) {
    tree = shortestPotentialPathTree(reference.id, potentialPathGraph(context, cache));
    cache.trees.set(reference.id, tree);
  }

  let value = complex();
  for (let currentId = node.id; currentId !== reference.id;) {
    const predecessor = tree.predecessors.get(currentId);
    if (!predecessor) { return undefined; }
    // The tree stores reference minus node along its traversal; this view shows node minus reference.
    value = complexSubtract(value, predecessor.difference);
    currentId = predecessor.nodeId;
  }
  if (context.analysis.mode !== "ac") {
    return Number.isFinite(value.real) ? { volts: value.real, phaseDegrees: 0 } : undefined;
  }
  const volts = complexMagnitude(value);
  return Number.isFinite(volts)
    ? { volts, phaseDegrees: complexPhaseDegrees(value) }
    : undefined;
}

function precisePartPotential(
  node: CircuitNode,
  reference: CircuitNode,
  context: CircuitPotentialContext | undefined,
): { volts: number; phaseDegrees: number } | undefined {
  if (!context || node.id === reference.id) { return undefined; }
  const cache = potentialContextCache(context);
  for (const pair of sharedPartTerminalPairs(node, reference)) {
    const precise = preciseBranchVoltage(pair, context);
    if (precise) { return precise; }
  }
  return precisePathPotential(node, reference, context, cache);
}

function finitePotential(volts: number, phaseDegrees: number) {
  return finite(volts) ? { volts, phaseDegrees } : null;
}

/** AC differences subtract complex phasors, never their RMS magnitudes. */
export function circuitPotential(
  node: CircuitNode | undefined,
  reference: CircuitNode | undefined,
  ac: boolean,
  context?: CircuitPotentialContext,
) {
  if (!node || !reference || node.referenceGroup !== reference.referenceGroup) { return null; }
  const precise = precisePartPotential(node, reference, context);
  if (precise) { return precise; }
  if (!ac) {
    if (!finite(node.voltageVolts) || !finite(reference.voltageVolts)) { return null; }
    const difference = complexSubtract((context && restoredReadingComplex(node.exactVoltage, node.voltageVolts, undefined, false, context.analysis.precisionExpressions)) || complex(node.voltageVolts),
      (context && restoredReadingComplex(reference.exactVoltage, reference.voltageVolts, undefined, false, context.analysis.precisionExpressions)) || complex(reference.voltageVolts));
    return finitePotential(difference.real, 0);
  }
  if (!finite(node.voltageVolts) || !finite(reference.voltageVolts)) { return null; }
  if (!finite(node.voltagePhaseDegrees) || !finite(reference.voltagePhaseDegrees)) { return null; }
  const first = (context && restoredReadingComplex(node.exactVoltage, node.voltageVolts, node.voltagePhaseDegrees, true, context.analysis.precisionExpressions)) || phasor(node.voltageVolts, node.voltagePhaseDegrees);
  const second = (context && restoredReadingComplex(reference.exactVoltage, reference.voltageVolts, reference.voltagePhaseDegrees, true, context.analysis.precisionExpressions)) || phasor(reference.voltageVolts, reference.voltagePhaseDegrees);
  const value = complexSubtract(first, second);
  const volts = complexMagnitude(value);
  return finitePotential(volts, complexPhaseDegrees(value));
}

export function circuitPotentialColor(volts: number, scale: number) {
  const amount = Math.min(1, Math.abs(volts) / Math.max(scale, 1e-12));
  return `hsl(${volts < 0 ? 218 : 18} ${Math.round(amount * 80)}% ${Math.round(55 - amount * 12)}%)`;
}

export function formatCircuitQuantity(value: number | undefined, unit: string): string {
  if (!finite(value)) { return "—"; }
  if (value === 0) { return `0 ${unit}`; }
  if (Math.abs(value) < 1e-24) { return `${formatCircuitNumber(value)} ${unit}`; }
  const prefixes: [number, string][] = [[1e-24, "y"], [1e-21, "z"], [1e-18, "a"], [1e-15, "f"], [1e-12, "p"], [1e-9, "n"], [1e-6, "μ"], [1e-3, "m"], [1, ""], [1e3, "k"], [1e6, "M"], [1e9, "G"]];
  const [scale, prefix] = prefixes.find(([threshold]) => Math.abs(value) < threshold * 1000) ?? prefixes.at(-1)!;
  return `${formatCircuitNumber(value / scale)} ${prefix}${unit}`;
}
