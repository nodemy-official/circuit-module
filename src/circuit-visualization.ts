import { circuitPartCatalog, endpointName, terminalsOf, type CircuitDocument, type CircuitEndpoint, type CircuitPart, type CircuitTerminal } from "./circuit-model.js";
import { exactComponentSum } from "./analog-math.js";
import type { CircuitAnalysis, CircuitPartReading } from "./circuit-solver.js";
import { acAnalysisFrequency, isAcReactiveConductive } from "./ac-reactive.js";
import type { TransientAnalysis } from "./transient-solver.js";

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
  currents: CircuitNodeCurrent[];
  /** Magnitude of the signed (DC) or phasor (AC) sum. Undefined for incomplete readings. */
  currentResidualAmps?: number;
  currentBalanceNote?: string;
}

export const circuitEndpointKey = (endpoint: CircuitEndpoint) => JSON.stringify([endpoint.partId, endpoint.terminal]);
const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

function transientFrameParts(document: CircuitDocument, sample: TransientAnalysis["samples"][number]) {
  const parts = Object.create(null) as Record<string, CircuitPartReading>;
  for (const part of document.parts) {
    if (!Object.hasOwn(sample.parts, part.id)) { continue; }
    const reading = sample.parts[part.id];
    if (!reading) { continue; }
    const powerWatts = reading.powerWatts * (sourceKinds.has(part.kind) ? -1 : 1);
    const brightness = part.kind === "bulb" ? Math.max(0, Math.min(1, powerWatts / (part.ratedPowerWatts ?? 2)))
      : part.kind === "led" ? Math.max(0, Math.min(1, reading.currentAmps / (part.ratedCurrentAmps ?? 0.02))) : undefined;
    parts[part.id] = { ...reading, powerWatts, ...(brightness === undefined ? {} : { brightness }) };
  }
  return parts;
}

/** Adapt a sampled state without re-solving it as a DC operating point. */
export function analysisAtTransientFrame(document: CircuitDocument, frame: CircuitTransientFrame): CircuitAnalysis | null {
  if (frame.analysis.status !== "valid") { return null; }
  const sample = frame.analysis.samples[frame.sampleIndex];
  if (!sample) { return null; }
  const parts = transientFrameParts(document, sample);
  const sources = document.parts.filter((part) => sourceKinds.has(part.kind));
  const hasOpAmp = document.parts.some((part) => part.kind === "op-amp");
  const sourceCurrent = sources.length === 1 && !hasOpAmp ? parts[sources[0].id]?.currentAmps : undefined;
  return {
    status: "closed", mode: "dc", timeSeconds: sample.timeSeconds, currentAmps: finite(sourceCurrent) ? Math.abs(sourceCurrent) : null,
    message: `過渡解析：${formatCircuitQuantity(sample.timeSeconds, "s")} の瞬時値`,
    parts, wireCurrents: {}, issues: frame.analysis.issues,
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
  const wrappedDegrees = degrees % 360;
  const quadrant = Math.round(wrappedDegrees / 90);
  const offsetDegrees = wrappedDegrees - quadrant * 90;
  const nearAxis = Math.abs(offsetDegrees) < 1e-7;
  const offsetRadians = nearAxis ? 0 : (offsetDegrees * Math.PI) / 180;
  const alongAxis = nearAxis ? value : value * Math.cos(offsetRadians);
  const acrossAxis = nearAxis
    ? (value * (Math.PI / 180)) * offsetDegrees
    : value * Math.sin(offsetRadians);
  switch (((quadrant % 4) + 4) % 4) {
    case 0: return { real: alongAxis, imaginary: acrossAxis };
    case 1: return { real: -acrossAxis, imaginary: alongAxis };
    case 2: return { real: -alongAxis, imaginary: -acrossAxis };
    default: return { real: acrossAxis, imaginary: -alongAxis };
  }
}

function analysisFrequency(document: CircuitDocument, analysis: CircuitAnalysis) {
  return acAnalysisFrequency(document, analysis.frequencyHz);
}

function referenceTerminalGroups(
  part: CircuitPart,
  analysis: CircuitAnalysis,
  frequencyHz: number,
): CircuitTerminal[][] {
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
      return [["a", "c"]];
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
  const realCurrentComponents: number[] = [];
  const imaginaryCurrentComponents: number[] = [];
  let voltageVolts: number | undefined;
  let voltagePhaseDegrees: number | undefined;
  let complete = true;
  for (const endpoint of endpoints) {
    const part = document.parts.find((item) => item.id === endpoint.partId)!;
    const reading = analysis.parts[part.id];
    const voltage = reading?.terminalVoltages?.[endpoint.terminal];
    if (voltageVolts === undefined && finite(voltage) && reading?.meterStatus !== "floating") {
      voltageVolts = voltage;
      voltagePhaseDegrees = reading?.terminalVoltagePhasesDegrees?.[endpoint.terminal];
    }
    if (part.kind === "junction" || part.kind === "ground") { continue; }
    const amps = reading?.terminalCurrents?.[endpoint.terminal];
    const phaseDegrees = reading?.terminalCurrentPhasesDegrees?.[endpoint.terminal];
    if (!finite(amps) || reading?.meterStatus === "floating" || (analysis.mode === "ac" && !finite(phaseDegrees))) { complete = false; continue; }
    currents.push({ endpoint, label: endpointName(part, endpoint.terminal), amps, phaseDegrees });
    const value = phasor(amps, phaseDegrees);
    realCurrentComponents.push(value.real);
    imaginaryCurrentComponents.push(value.imaginary);
  }
  const realCurrent = exactComponentSum(realCurrentComponents);
  const imaginaryCurrent = exactComponentSum(imaginaryCurrentComponents);
  return {
    voltageVolts,
    voltagePhaseDegrees,
    currents,
    currentResidualAmps: complete && currents.length > 0 ? Math.hypot(realCurrent, imaginaryCurrent) : undefined,
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
  "battery", "ac-source", "resistor", "bulb", "capacitor", "inductor", "ammeter", "diode", "led",
]);
const potentiometerIdsCache = new WeakMap<CircuitPotentialContext, Set<string>>();

function potentiometerIds(context: CircuitPotentialContext) {
  const cached = potentiometerIdsCache.get(context);
  if (cached) { return cached; }
  const ids = new Set(context.document.parts
    .filter((part) => part.kind === "potentiometer")
    .map((part) => part.id));
  potentiometerIdsCache.set(context, ids);
  return ids;
}

function hasPreciseTwoTerminalVoltage(part: CircuitPart, reading: CircuitPartReading): boolean {
  if (part.kind === "switch") { return reading.switchClosed === true; }
  if (part.kind === "voltmeter") { return reading.meterStatus === "connected"; }
  return preciseTwoTerminalVoltageKinds.has(part.kind);
}

function sharedPartTerminalPairs(
  node: CircuitNode,
  reference: CircuitNode,
  context: CircuitPotentialContext,
): { partId: string; fromTerminal: CircuitTerminal; toTerminal: CircuitTerminal }[] {
  const pairs: { partId: string; fromTerminal: CircuitTerminal; toTerminal: CircuitTerminal }[] = [];
  const potentiometers = potentiometerIds(context);
  for (const endpoint of node.endpoints) {
    for (const referenceEndpoint of reference.endpoints) {
      if (endpoint.partId !== referenceEndpoint.partId || endpoint.terminal === referenceEndpoint.terminal) { continue; }
      const twoTerminalPair =
        (endpoint.terminal === "a" && referenceEndpoint.terminal === "b") ||
        (endpoint.terminal === "b" && referenceEndpoint.terminal === "a");
      if (twoTerminalPair || potentiometers.has(endpoint.partId)) {
        pairs.push({ partId: endpoint.partId, fromTerminal: endpoint.terminal, toTerminal: referenceEndpoint.terminal });
      }
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
  const volts = Math.hypot(voltage.real, voltage.imaginary);
  return Number.isFinite(volts)
    ? { volts, phaseDegrees: volts === 0 ? 0 : Math.atan2(voltage.imaginary, voltage.real) * 180 / Math.PI }
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
): ComplexPotential | undefined {
  const current = reading.terminalCurrents?.[terminal];
  const phaseDegrees = reading.terminalCurrentPhasesDegrees?.[terminal];
  if (!finite(current) || !finite(phaseDegrees) || !Number.isFinite(resistance)) { return; }
  const voltage = phasor(current * resistance, phaseDegrees);
  return Number.isFinite(voltage.real) && Number.isFinite(voltage.imaginary) ? voltage : undefined;
}

function negativePotential(value: ComplexPotential): ComplexPotential {
  return { real: -value.real, imaginary: -value.imaginary };
}

function primaryReadingPhasor(reading: CircuitPartReading, reverse: boolean): ComplexPotential | undefined {
  if (!finite(reading.voltageVolts) || !finite(reading.voltagePhaseDegrees)) { return; }
  const voltage = phasor(
    Math.abs(reading.voltageVolts),
    reading.voltagePhaseDegrees + (reverse ? 180 : 0),
  );
  return Number.isFinite(voltage.real) && Number.isFinite(voltage.imaginary) ? voltage : undefined;
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
): ComplexPotential | undefined {
  if (pair.fromTerminal === "a" && pair.toTerminal === "b") { return primaryReadingPhasor(reading, false); }
  if (pair.fromTerminal === "b" && pair.toTerminal === "a") { return primaryReadingPhasor(reading, true); }
  const segment = potentiometerSegmentForPair(pair);
  if (!segment) { return; }
  const position = part.wiperPosition ?? 0.5;
  const totalResistance = part.resistanceOhms ?? 1000;
  const resistance = totalResistance * (segment.terminal === "a" ? position : 1 - position);
  const voltage = terminalBranchPhasor(reading, segment.terminal, resistance);
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
  if (part.kind === "potentiometer") { return potentiometerBranchPhasor(part, reading, pair); }
  if (!hasPreciseTwoTerminalVoltage(part, reading) ||
    !((pair.fromTerminal === "a" && pair.toTerminal === "b") ||
      (pair.fromTerminal === "b" && pair.toTerminal === "a"))) { return; }
  return primaryReadingPhasor(reading, pair.fromTerminal === "b");
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

const potentialPathGraphCache = new WeakMap<CircuitPotentialContext, PotentialPathGraph>();
const potentialPathTreeCache = new WeakMap<CircuitPotentialContext, Map<string, PotentialPathTree>>();

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

function potentialPathGraph(context: CircuitPotentialContext): PotentialPathGraph {
  const cached = potentialPathGraphCache.get(context);
  if (cached) { return cached; }

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
      difference: { real: -part.voltage.real, imaginary: -part.voltage.imaginary },
      cost,
    });
  }
  const graph = { nodeIds: nodes.map((node) => node.id), adjacency };
  potentialPathGraphCache.set(context, graph);
  return graph;
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
    const terminalPairs: [CircuitTerminal, CircuitTerminal][] = part.kind === "potentiometer"
      ? [["a", "c"], ["b", "c"]]
      : [["a", "b"]];
    for (const [fromTerminal, toTerminal] of terminalPairs) {
      const first = byEndpoint.get(circuitEndpointKey({ partId: part.id, terminal: fromTerminal }));
      const second = byEndpoint.get(circuitEndpointKey({ partId: part.id, terminal: toTerminal }));
      if (!first || !second || first.id === second.id || first.referenceGroup !== second.referenceGroup) { continue; }
      const voltage = preciseBranchPhasor({ partId: part.id, fromTerminal, toTerminal }, context);
      if (!voltage) { continue; }
      const magnitude = Math.hypot(voltage.real, voltage.imaginary);
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
  context: CircuitPotentialContext | undefined,
): { volts: number; phaseDegrees: number } | undefined {
  if (context?.analysis.mode !== "ac" || node.id === reference.id) { return undefined; }
  let pathTrees = potentialPathTreeCache.get(context);
  if (!pathTrees) {
    pathTrees = new Map();
    potentialPathTreeCache.set(context, pathTrees);
  }
  let tree = pathTrees.get(reference.id);
  if (!tree) {
    tree = shortestPotentialPathTree(reference.id, potentialPathGraph(context));
    pathTrees.set(reference.id, tree);
  }

  const realParts: number[] = [];
  const imaginaryParts: number[] = [];
  for (let currentId = node.id; currentId !== reference.id;) {
    const predecessor = tree.predecessors.get(currentId);
    if (!predecessor) { return undefined; }
    // The tree stores reference minus node along its traversal; this view shows node minus reference.
    realParts.push(-predecessor.difference.real);
    imaginaryParts.push(-predecessor.difference.imaginary);
    currentId = predecessor.nodeId;
  }
  const real = exactComponentSum(realParts);
  const imaginary = exactComponentSum(imaginaryParts);
  const volts = Math.hypot(real, imaginary);
  return Number.isFinite(volts)
    ? { volts, phaseDegrees: volts === 0 ? 0 : Math.atan2(imaginary, real) * 180 / Math.PI }
    : undefined;
}

function precisePartPotential(
  node: CircuitNode,
  reference: CircuitNode,
  context: CircuitPotentialContext | undefined,
): { volts: number; phaseDegrees: number } | undefined {
  if (context?.analysis.mode !== "ac" || node.id === reference.id) { return undefined; }
  for (const pair of sharedPartTerminalPairs(node, reference, context)) {
    const precise = preciseBranchVoltage(pair, context);
    if (precise) { return precise; }
  }
  return precisePathPotential(node, reference, context);
}

/** AC differences subtract complex phasors, never their RMS magnitudes. */
export function circuitPotential(
  node: CircuitNode | undefined,
  reference: CircuitNode | undefined,
  ac: boolean,
  context?: CircuitPotentialContext,
) {
  if (!node || !reference || node.referenceGroup !== reference.referenceGroup) { return null; }
  if (!ac) {
    if (!finite(node.voltageVolts) || !finite(reference.voltageVolts)) { return null; }
    return { volts: node.voltageVolts - reference.voltageVolts, phaseDegrees: 0 };
  }
  const precise = precisePartPotential(node, reference, context);
  if (precise) { return precise; }
  if (!finite(node.voltageVolts) || !finite(reference.voltageVolts)) { return null; }
  if (!finite(node.voltagePhaseDegrees) || !finite(reference.voltagePhaseDegrees)) { return null; }
  const first = phasor(node.voltageVolts, node.voltagePhaseDegrees);
  const second = phasor(reference.voltageVolts, reference.voltagePhaseDegrees);
  const real = first.real - second.real;
  const imaginary = first.imaginary - second.imaginary;
  const volts = Math.hypot(real, imaginary);
  return { volts, phaseDegrees: volts === 0 ? 0 : Math.atan2(imaginary, real) * 180 / Math.PI };
}

export function circuitPotentialColor(volts: number, scale: number) {
  const amount = Math.min(1, Math.abs(volts) / Math.max(scale, 1e-12));
  return `hsl(${volts < 0 ? 218 : 18} ${Math.round(amount * 80)}% ${Math.round(55 - amount * 12)}%)`;
}

export function formatCircuitQuantity(value: number | undefined, unit: string): string {
  if (!finite(value)) { return "—"; }
  if (value === 0) { return `0 ${unit}`; }
  if (Math.abs(value) < 1e-24) { return `${Number(value.toPrecision(4))} ${unit}`; }
  const prefixes: [number, string][] = [[1e-24, "y"], [1e-21, "z"], [1e-18, "a"], [1e-15, "f"], [1e-12, "p"], [1e-9, "n"], [1e-6, "μ"], [1e-3, "m"], [1, ""], [1e3, "k"], [1e6, "M"], [1e9, "G"]];
  const [scale, prefix] = prefixes.find(([threshold]) => Math.abs(value) < threshold * 1000) ?? prefixes.at(-1)!;
  return `${Number((value / scale).toPrecision(4))} ${prefix}${unit}`;
}
