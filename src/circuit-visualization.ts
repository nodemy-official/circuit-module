import { endpointName, terminalsOf, type CircuitDocument, type CircuitEndpoint, type CircuitPart, type CircuitTerminal } from "./circuit-model.js";
import type { CircuitAnalysis, CircuitPartReading } from "./circuit-solver.js";
import type { TransientAnalysis } from "./transient-solver.js";

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
  const radians = degrees * Math.PI / 180;
  return { real: value * Math.cos(radians), imaginary: value * Math.sin(radians) };
}

function referenceTerminalGroups(part: CircuitPart, analysis: CircuitAnalysis): CircuitTerminal[][] {
  switch (part.kind) {
    case "battery":
    case "ac-source":
    case "resistor":
    case "bulb":
    case "ammeter":
    case "diode":
    case "led":
    case "inductor":
      return [["a", "b"]];
    case "switch":
      return (analysis.parts[part.id]?.switchClosed ?? part.initiallyClosed ?? false) ? [["a", "b"]] : [];
    case "capacitor":
      return analysis.mode === "ac" || analysis.timeSeconds !== undefined ? [["a", "b"]] : [];
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
    for (const group of referenceTerminalGroups(part, analysis)) {
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
  }
  const sum = currents.reduce((total, entry) => {
    const value = phasor(entry.amps, entry.phaseDegrees);
    return { real: total.real + value.real, imaginary: total.imaginary + value.imaginary };
  }, { real: 0, imaginary: 0 });
  return { voltageVolts, voltagePhaseDegrees, currents, currentResidualAmps: complete && currents.length > 0 ? Math.hypot(sum.real, sum.imaginary) : undefined };
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

/** AC differences subtract complex phasors, never their RMS magnitudes. */
export function circuitPotential(node: CircuitNode | undefined, reference: CircuitNode | undefined, ac: boolean) {
  if (!node || !reference || node.referenceGroup !== reference.referenceGroup || !finite(node.voltageVolts) || !finite(reference.voltageVolts)) { return null; }
  if (!ac) { return { volts: node.voltageVolts - reference.voltageVolts, phaseDegrees: 0 }; }
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
  if (Math.abs(value) < 1e-14) { return `0 ${unit}`; }
  const prefixes: [number, string][] = [[1e-12, "p"], [1e-9, "n"], [1e-6, "μ"], [1e-3, "m"], [1, ""], [1e3, "k"], [1e6, "M"], [1e9, "G"]];
  const [scale, prefix] = prefixes.find(([threshold]) => Math.abs(value) < threshold * 1000) ?? prefixes.at(-1)!;
  return `${Number((value / scale).toPrecision(4))} ${prefix}${unit}`;
}
