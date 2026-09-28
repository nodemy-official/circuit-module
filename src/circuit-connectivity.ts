import { terminalsOf, type CircuitDocument, type CircuitTerminal } from "./circuit-model.js";

export interface CircuitConnectivityGraph {
  adjacent: Map<string, string[]>;
  endpointKey: (partId: string, terminal: CircuitTerminal) => string;
}

export const circuitConnectivityEndpointKey = (partId: string, terminal: CircuitTerminal) =>
  JSON.stringify([partId, terminal]);

export function connectCircuitEndpoints(graph: CircuitConnectivityGraph, first: string, second: string) {
  graph.adjacent.get(first)?.push(second);
  graph.adjacent.get(second)?.push(first);
}

export function joinCircuitPartTerminals(
  graph: CircuitConnectivityGraph,
  partId: string,
  terminals: readonly CircuitTerminal[],
) {
  const first = terminals[0];
  if (!first) { return; }
  for (const terminal of terminals.slice(1)) {
    connectCircuitEndpoints(graph, graph.endpointKey(partId, first), graph.endpointKey(partId, terminal));
  }
}

export function createCircuitConnectivityGraph(document: CircuitDocument): CircuitConnectivityGraph {
  const endpointKey = circuitConnectivityEndpointKey;
  const adjacent = new Map<string, string[]>();
  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) {
      adjacent.set(endpointKey(part.id, terminal), []);
    }
  }
  const graph = { adjacent, endpointKey };
  for (const wire of document.wires) {
    connectCircuitEndpoints(graph, endpointKey(wire.from.partId, wire.from.terminal), endpointKey(wire.to.partId, wire.to.terminal));
  }
  const firstGround = document.parts.find((part) => part.kind === "ground");
  if (firstGround) {
    for (const ground of document.parts.filter((part) => part.kind === "ground").slice(1)) {
      connectCircuitEndpoints(graph, endpointKey(firstGround.id, "a"), endpointKey(ground.id, "a"));
    }
  }
  return graph;
}

export function circuitEndpointsConnected(graph: CircuitConnectivityGraph, start: string, goal: string) {
  const pending = [start];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === goal) { return true; }
    for (const next of graph.adjacent.get(current ?? "") ?? []) {
      if (visited.has(next)) { continue; }
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}
