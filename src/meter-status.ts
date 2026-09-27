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

function joinAcross(nodes: DisjointSet, index: Map<string, number>, part: CircuitPart, terminals: CircuitTerminal[]) {
  const first = terminals[0] === undefined ? undefined : index.get(endpointKey(part.id, terminals[0]));
  if (first === undefined) { return; }
  for (const terminal of terminals.slice(1)) {
    const next = index.get(endpointKey(part.id, terminal));
    if (next !== undefined) { nodes.join(first, next); }
  }
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

function joinElectricalParts(
  document: CircuitDocument,
  index: Map<string, number>,
  nodes: DisjointSet,
  referenceNode: number,
  options: MeterStatusOptions,
) {
  const switchStates = options.switchStates ?? {};
  const frequencyHz = acAnalysisFrequency(document, options.frequencyHz);
  for (const part of document.parts) {
    switch (part.kind) {
      case "battery":
      case "ac-source":
      case "resistor":
      case "bulb":
      case "ammeter":
      case "diode":
      case "led":
        joinAcross(nodes, index, part, ["a", "b"]);
        break;
      case "inductor":
        if (options.mode !== "ac" || isAcReactiveConductive(part, frequencyHz)) {
          joinAcross(nodes, index, part, ["a", "b"]);
        }
        break;
      case "switch":
        if (isSwitchClosed(part, switchStates)) { joinAcross(nodes, index, part, ["a", "b"]); }
        break;
      case "capacitor":
        if (options.mode === "ac" && isAcReactiveConductive(part, frequencyHz)) {
          joinAcross(nodes, index, part, ["a", "b"]);
        }
        break;
      case "potentiometer":
      case "npn-transistor":
      case "pnp-transistor":
        joinAcross(nodes, index, part, ["a", "b", "c"]);
        break;
      case "nmos":
      case "pmos":
        joinAcross(nodes, index, part, ["a", "c"]);
        break;
      case "op-amp": {
        const output = index.get(endpointKey(part.id, "c"));
        if (output !== undefined) { nodes.join(output, referenceNode); }
        break;
      }
      default:
        break;
    }
  }
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
    } else if (part.kind === "inductor" && options.mode !== "ac") {
      joinAcross(nodes, index, part, ["a", "b"]);
    }
  }
  const a = index.get(endpointKey(ammeter.id, "a"));
  const b = index.get(endpointKey(ammeter.id, "b"));
  return a !== undefined && b !== undefined && nodes.find(a) === nodes.find(b);
}
