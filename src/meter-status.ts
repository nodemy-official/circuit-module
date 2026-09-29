import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";
import { acAnalysisFrequency, isAcReactiveConductive } from "./ac-reactive.js";

export type MeterStatus = "connected" | "unconnected" | "floating";

interface MeterStatusOptions {
  mode?: "dc" | "ac";
  frequencyHz?: number;
  switchStates?: Record<string, boolean>;
  /** MOS channels with no current or incremental response are open branches. */
  channelConducting?: Readonly<Record<string, boolean>>;
  /** AC-bias terminal groups joined by each nonlinear device's small-signal conductance. */
  smallSignalConnections?: Readonly<Record<string, readonly (readonly CircuitTerminal[])[]>>;
  /** Initial transient solve fixes an inductor's current instead of shorting it. */
  initialInductorCurrents?: boolean;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(node: number): number {
    const parent = this.parent[node] ?? node;
    if (parent === node) { return node; }
    const root = this.find(parent);
    this.parent[node] = root;
    return root;
  }

  join(left: number, right: number) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) { this.parent[leftRoot] = rightRoot; }
  }
}

function endpointKey(partId: string, terminal: CircuitTerminal) {
  return `${partId}:${terminal}`;
}

function terminalIndex(document: CircuitDocument) {
  const index = new Map<string, number>();
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      index.set(endpointKey(part.id, terminal), index.size);
    }
  }
  return index;
}

function joinWiresAndGrounds(
  document: CircuitDocument,
  index: Map<string, number>,
  nodes: DisjointSet,
  referenceNode: number,
) {
  for (const wire of document.wires) {
    const from = index.get(endpointKey(wire.from.partId, wire.from.terminal));
    const to = index.get(endpointKey(wire.to.partId, wire.to.terminal));
    if (from !== undefined && to !== undefined) { nodes.join(from, to); }
  }
  for (const part of document.parts) {
    if (part.kind !== "ground") { continue; }
    const ground = index.get(endpointKey(part.id, "a"));
    if (ground !== undefined) { nodes.join(ground, referenceNode); }
  }
}

function isSwitchClosed(part: CircuitPart, switchStates: Record<string, boolean>) {
  const override = Object.hasOwn(switchStates, part.id) ? switchStates[part.id] : undefined;
  return override ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
}

function joinAcross(
  nodes: DisjointSet,
  index: Map<string, number>,
  part: CircuitPart,
  terminals: readonly CircuitTerminal[],
) {
  const first = terminals[0] === undefined ? undefined : index.get(endpointKey(part.id, terminals[0]));
  if (first === undefined) { return; }
  for (const terminal of terminals.slice(1)) {
    const next = index.get(endpointKey(part.id, terminal));
    if (next !== undefined) { nodes.join(first, next); }
  }
}

function joinSmallSignalGroups(
  nodes: DisjointSet,
  index: Map<string, number>,
  part: CircuitPart,
  options: MeterStatusOptions,
) {
  const groups = options.mode === "ac" ? options.smallSignalConnections?.[part.id] : undefined;
  if (groups === undefined) { return false; }
  for (const group of groups) { joinAcross(nodes, index, part, group); }
  return true;
}

function joinMosChannel(
  nodes: DisjointSet,
  index: Map<string, number>,
  part: CircuitPart,
  channelConducting: Readonly<Record<string, boolean>> | undefined,
) {
  if (channelConducting?.[part.id] !== false) { joinAcross(nodes, index, part, ["a", "c"]); }
}

/**
 * Marks measurements that have no physical lead connection or no shared voltage reference.
 * Ideal ammeters bypassed by wires are floating because their branch current is indeterminate.
 */
export function meterStatuses(
  document: CircuitDocument,
  options: MeterStatusOptions = {},
): Record<string, MeterStatus> {
  const meters = document.parts.filter((part) => part.kind === "ammeter" || part.kind === "voltmeter");
  if (meters.length === 0) { return Object.create(null); }
  const index = terminalIndex(document);
  const referenceNode = index.size;
  const electricalNodes = new DisjointSet(index.size + 1);
  joinWiresAndGrounds(document, index, electricalNodes, referenceNode);
  if (!document.parts.some((part) => part.kind === "ground") && index.size > 0) {
    // The analog solver uses its first terminal as the reference when the document has no GND.
    electricalNodes.join(0, referenceNode);
  }
  joinElectricalParts(document, index, electricalNodes, referenceNode, options);

  const statuses: Record<string, MeterStatus> = Object.create(null);
  const wired = wiredTerminalSet(document);
  for (const part of meters) {
    statuses[part.id] = meterStatusForPart(
      document,
      part,
      index,
      wired,
      electricalNodes,
      options,
    );
  }
  return statuses;
}

function wiredTerminalSet(document: CircuitDocument) {
  const wired = new Set<string>();
  for (const wire of document.wires) {
    wired.add(endpointKey(wire.from.partId, wire.from.terminal));
    wired.add(endpointKey(wire.to.partId, wire.to.terminal));
  }
  return wired;
}

interface ElectricalConnectionContext {
  index: Map<string, number>,
  nodes: DisjointSet,
  referenceNode: number,
  options: MeterStatusOptions,
  frequencyHz: number;
}

type ElectricalPartJoiner = (part: CircuitPart, context: ElectricalConnectionContext) => void;

function joinPartTerminals(
  part: CircuitPart,
  context: ElectricalConnectionContext,
  terminals: readonly CircuitTerminal[],
) {
  joinAcross(context.nodes, context.index, part, terminals);
}

function joinAlwaysConnectedPart(part: CircuitPart, context: ElectricalConnectionContext) {
  joinPartTerminals(part, context, ["a", "b"]);
}

function joinDiodeTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  if (!joinSmallSignalGroups(context.nodes, context.index, part, context.options)) {
    joinPartTerminals(part, context, ["a", "b"]);
  }
}

function joinInductorTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  if (context.options.mode !== "ac" || isAcReactiveConductive(part, context.frequencyHz)) {
    joinPartTerminals(part, context, ["a", "b"]);
  }
}

function joinSwitchTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  if (isSwitchClosed(part, context.options.switchStates ?? {})) {
    joinPartTerminals(part, context, ["a", "b"]);
  }
}

function joinCapacitorTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  if (context.options.mode === "ac" && isAcReactiveConductive(part, context.frequencyHz)) {
    joinPartTerminals(part, context, ["a", "b"]);
  }
}

function joinPotentiometerTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  joinPartTerminals(part, context, ["a", "b", "c"]);
}

function joinTransistorTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  if (!joinSmallSignalGroups(context.nodes, context.index, part, context.options)) {
    joinPartTerminals(part, context, ["a", "b", "c"]);
  }
}

function joinMosTerminals(part: CircuitPart, context: ElectricalConnectionContext) {
  if (!joinSmallSignalGroups(context.nodes, context.index, part, context.options)) {
    joinMosChannel(context.nodes, context.index, part, context.options.channelConducting);
  }
}

function joinOpAmpOutput(part: CircuitPart, context: ElectricalConnectionContext) {
  const output = context.index.get(endpointKey(part.id, "c"));
  if (output !== undefined) { context.nodes.join(output, context.referenceNode); }
}

const electricalPartJoiners: Partial<Record<CircuitPart["kind"], ElectricalPartJoiner>> = {
  battery: joinAlwaysConnectedPart,
  "ac-source": joinAlwaysConnectedPart,
  resistor: joinAlwaysConnectedPart,
  bulb: joinAlwaysConnectedPart,
  ammeter: joinAlwaysConnectedPart,
  diode: joinDiodeTerminals,
  led: joinDiodeTerminals,
  inductor: joinInductorTerminals,
  switch: joinSwitchTerminals,
  capacitor: joinCapacitorTerminals,
  potentiometer: joinPotentiometerTerminals,
  "npn-transistor": joinTransistorTerminals,
  "pnp-transistor": joinTransistorTerminals,
  nmos: joinMosTerminals,
  pmos: joinMosTerminals,
  "op-amp": joinOpAmpOutput,
};

function joinElectricalParts(
  document: CircuitDocument,
  index: Map<string, number>,
  nodes: DisjointSet,
  referenceNode: number,
  options: MeterStatusOptions,
) {
  const context = {
    index,
    nodes,
    referenceNode,
    options,
    frequencyHz: acAnalysisFrequency(document, options.frequencyHz),
  };
  for (const part of document.parts) { electricalPartJoiners[part.kind]?.(part, context); }
}

function meterStatusForPart(
  document: CircuitDocument,
  part: CircuitPart,
  index: Map<string, number>,
  wired: Set<string>,
  electricalNodes: DisjointSet,
  options: MeterStatusOptions,
): MeterStatus {
  const aKey = endpointKey(part.id, "a");
  const bKey = endpointKey(part.id, "b");
  if (!wired.has(aKey) || !wired.has(bKey)) { return "unconnected"; }
  const a = index.get(aKey);
  const b = index.get(bKey);
  if (a === undefined || b === undefined) { return "unconnected"; }
  if (part.kind === "voltmeter" && electricalNodes.find(a) !== electricalNodes.find(b)) {
    return "floating";
  }
  if (part.kind === "ammeter" && idealPathBypassingAmmeter(document, index, part, options)) {
    return "floating";
  }
  return "connected";
}

function idealPathBypassingAmmeter(
  document: CircuitDocument,
  index: Map<string, number>,
  ammeter: CircuitPart,
  options: MeterStatusOptions,
) {
  const nodes = new DisjointSet(index.size + 1);
  const referenceNode = index.size;
  joinWiresAndGrounds(document, index, nodes, referenceNode);
  for (const part of document.parts) {
    if (part.id === ammeter.id) { continue; }
    if (part.kind === "ammeter") {
      joinAcross(nodes, index, part, ["a", "b"]);
    } else if (part.kind === "switch" && isSwitchClosed(part, options.switchStates ?? {})) {
      joinAcross(nodes, index, part, ["a", "b"]);
    } else if (part.kind === "inductor" && options.mode !== "ac" && !options.initialInductorCurrents) {
      joinAcross(nodes, index, part, ["a", "b"]);
    }
  }
  const a = index.get(endpointKey(ammeter.id, "a"));
  const b = index.get(endpointKey(ammeter.id, "b"));
  return a !== undefined && b !== undefined && nodes.find(a) === nodes.find(b);
}
