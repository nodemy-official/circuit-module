import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
} from "../../circuit-model.js";

export type CircuitSpec = readonly [string, CircuitPartKind, readonly string[], Partial<CircuitPart>?];

/** Builds an ideal-wire fixture by joining terminals with the same node name. */
export function createCircuitFromSpecs(specs: readonly CircuitSpec[], title: string): CircuitDocument {
  const parts = specs.map(([id, kind, , values]) => ({
    id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
  }));
  const nets = new Map<string, CircuitEndpoint>();
  const wires: CircuitDocument["wires"] = [];
  for (const [id, kind, nodes] of specs) {
    for (const [index, terminal] of terminalsOf(kind).entries()) {
      const node = nodes[index];
      if (node === undefined) { throw new Error(`Missing node for ${id}:${terminal}`); }
      const endpoint = { partId: id, terminal };
      const previous = nets.get(node);
      if (previous) { wires.push({ id: `w${wires.length}`, from: previous, to: endpoint }); }
      else { nets.set(node, endpoint); }
    }
  }
  return { title, parts, wires };
}
