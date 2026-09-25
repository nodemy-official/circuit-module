import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
  type CircuitWire,
  terminalName,
} from "./circuit-model.js";

export type CircuitDiagnosticSeverity = "error" | "warning" | "info";

export type CircuitDiagnosticCode =
  | "duplicate-part-id"
  | "duplicate-wire-id"
  | "invalid-part-kind"
  | "missing-wire-part"
  | "ambiguous-wire-part"
  | "invalid-wire-terminal"
  | "same-terminal-wire"
  | "duplicate-wire"
  | "isolated-part"
  | "unconnected-terminal"
  | "dead-end-junction"
  | "unpowered-component"
  | "wire-bypassed-part"
  | "wire-shorted-battery"
  | "wire-shorted-voltage-source"
  | "duplicate-label";

export interface CircuitDiagnostic {
  id: string;
  code: CircuitDiagnosticCode;
  severity: CircuitDiagnosticSeverity;
  message: string;
  partIds: string[];
  wireIds: string[];
}

interface IndexedPart {
  part: CircuitPart;
  index: number;
  key: string;
  terminals: readonly CircuitTerminal[];
}

interface ValidWire {
  id: string;
  from: CircuitEndpoint;
  to: CircuitEndpoint;
  fromPart: IndexedPart;
  toPart: IndexedPart;
}

class DisjointSet {
  private readonly parents = new Map<string, string>();
  private readonly ranks = new Map<string, number>();

  add(value: string) {
    if (this.parents.has(value)) { return; }
    this.parents.set(value, value);
    this.ranks.set(value, 0);
  }

  find(value: string): string {
    this.add(value);
    let root = value;
    while (this.parents.get(root) !== root) {
      root = this.parents.get(root) ?? root;
    }
    let current = value;
    while (current !== root) {
      const parent = this.parents.get(current);
      if (parent === undefined) { break; }
      this.parents.set(current, root);
      current = parent;
    }
    return root;
  }

  union(first: string, second: string) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) { return; }
    const firstRank = this.ranks.get(firstRoot) ?? 0;
    const secondRank = this.ranks.get(secondRoot) ?? 0;
    if (firstRank < secondRank) {
      this.parents.set(firstRoot, secondRoot);
    } else {
      this.parents.set(secondRoot, firstRoot);
      if (firstRank === secondRank) { this.ranks.set(firstRoot, firstRank + 1); }
    }
  }

  connected(first: string, second: string) {
    return this.find(first) === this.find(second);
  }
}

function partTerminals(kind: unknown): readonly CircuitTerminal[] {
  if (typeof kind !== "string") { return []; }
  return circuitPartCatalog[kind as CircuitPartKind]?.terminals ?? [];
}

function endpointKey(endpoint: CircuitEndpoint) {
  return JSON.stringify([endpoint.partId, endpoint.terminal]);
}

function partKey(part: CircuitPart, index: number) {
  return JSON.stringify([part.id, index]);
}

function makeDiagnostic(
  code: CircuitDiagnosticCode,
  severity: CircuitDiagnosticSeverity,
  message: string,
  partIds: readonly string[] = [],
  wireIds: readonly string[] = [],
  identity = "",
): CircuitDiagnostic {
  const parts = [...new Set(partIds)].sort();
  const wires = [...new Set(wireIds)].sort();
  return {
    id: `${code}:${parts.join(",")}:${wires.join(",")}:${identity}`,
    code,
    severity,
    message,
    partIds: parts,
    wireIds: wires,
  };
}

function terminalIsValid(part: IndexedPart, terminal: string): terminal is CircuitTerminal {
  return part.terminals.includes(terminal as CircuitTerminal);
}

function partLabel(part: CircuitPart) {
  return part.label.trim() || part.id;
}

function indexParts(document: CircuitDocument, diagnostics: CircuitDiagnostic[]) {
  const partsById = new Map<string, IndexedPart[]>();
  const indexedParts = document.parts.map((part, index): IndexedPart => ({
    part,
    index,
    key: partKey(part, index),
    terminals: partTerminals(part.kind),
  }));

  for (const item of indexedParts) {
    const entries = partsById.get(item.part.id) ?? [];
    entries.push(item);
    partsById.set(item.part.id, entries);
    if (item.terminals.length === 0) {
      diagnostics.push(makeDiagnostic(
        "invalid-part-kind",
        "error",
        `部品 ${item.part.id} の種類を確認してください。`,
        [item.part.id],
        [],
        String(item.index),
      ));
    }
  }
  for (const [id, entries] of partsById) {
    if (entries.length > 1) {
      diagnostics.push(makeDiagnostic(
        "duplicate-part-id",
        "error",
        `部品 ID「${id}」が重複しています。`,
        [id],
        [],
        String(entries.length),
      ));
    }
  }
  return { indexedParts, partsById };
}

function reportDuplicateWireIds(document: CircuitDocument, diagnostics: CircuitDiagnostic[]) {
  const wireIdGroups = new Map<string, string[]>();
  for (const wire of document.wires) {
    const entries = wireIdGroups.get(wire.id) ?? [];
    entries.push(wire.id);
    wireIdGroups.set(wire.id, entries);
  }
  for (const [id, entries] of wireIdGroups) {
    if (entries.length > 1) {
      diagnostics.push(makeDiagnostic(
        "duplicate-wire-id",
        "error",
        `導線 ID「${id}」が重複しています。`,
        [],
        [id],
        String(entries.length),
      ));
    }
  }
}

function validateWireEndpoint(
  wire: CircuitWire,
  endpoint: CircuitEndpoint,
  matches: readonly IndexedPart[],
  side: "from" | "to",
  diagnostics: CircuitDiagnostic[],
): IndexedPart | null {
  const sideLabel = side === "from" ? "始点" : "終点";
  if (matches.length === 0) {
    diagnostics.push(makeDiagnostic(
      "missing-wire-part",
      "error",
      `導線「${wire.id}」の${sideLabel}に部品 ${endpoint.partId} がありません。`,
      [endpoint.partId],
      [wire.id],
      side,
    ));
    return null;
  }
  if (matches.length > 1) {
    diagnostics.push(makeDiagnostic(
      "ambiguous-wire-part",
      "error",
      `導線「${wire.id}」の${sideLabel}は重複 ID「${endpoint.partId}」を参照しています。`,
      [endpoint.partId],
      [wire.id],
      side,
    ));
    return null;
  }
  const part = matches[0];
  if (!part || !terminalIsValid(part, endpoint.terminal)) {
    diagnostics.push(makeDiagnostic(
      "invalid-wire-terminal",
      "error",
      `導線「${wire.id}」の${sideLabel}端子を確認してください。`,
      [endpoint.partId],
      [wire.id],
      side,
    ));
    return null;
  }
  return part;
}

function collectWireGraph(
  document: CircuitDocument,
  partsById: ReadonlyMap<string, readonly IndexedPart[]>,
  indexedParts: readonly IndexedPart[],
  diagnostics: CircuitDiagnostic[],
) {
  const validWires: ValidWire[] = [];
  const terminalWireCounts = new Map<string, number>();
  const partConnections = new DisjointSet();
  const wireConnections = new DisjointSet();
  for (const item of indexedParts) { partConnections.add(item.key); }
  let firstGround: IndexedPart | undefined;
  for (const item of indexedParts) {
    if (item.part.kind !== "ground") { continue; }
    const terminal = endpointKey({ partId: item.part.id, terminal: "a" });
    if (firstGround) {
      const firstTerminal = endpointKey({ partId: firstGround.part.id, terminal: "a" });
      wireConnections.union(firstTerminal, terminal);
      partConnections.union(firstGround.key, item.key);
    } else {
      firstGround = item;
    }
  }

  for (const wire of document.wires) {
    const fromEntries = partsById.get(wire.from.partId) ?? [];
    const toEntries = partsById.get(wire.to.partId) ?? [];
    const fromPart = validateWireEndpoint(wire, wire.from, fromEntries, "from", diagnostics);
    const toPart = validateWireEndpoint(wire, wire.to, toEntries, "to", diagnostics);
    if (!fromPart || !toPart) { continue; }

    if (endpointKey(wire.from) === endpointKey(wire.to)) {
      diagnostics.push(makeDiagnostic(
        "same-terminal-wire",
        "error",
        `導線「${wire.id}」は同じ端子につながっています。`,
        [wire.from.partId],
        [wire.id],
      ));
      continue;
    }

    validWires.push({ id: wire.id, from: wire.from, to: wire.to, fromPart, toPart });
    const fromKey = endpointKey(wire.from);
    const toKey = endpointKey(wire.to);
    terminalWireCounts.set(fromKey, (terminalWireCounts.get(fromKey) ?? 0) + 1);
    terminalWireCounts.set(toKey, (terminalWireCounts.get(toKey) ?? 0) + 1);
    wireConnections.union(fromKey, toKey);
    partConnections.union(fromPart.key, toPart.key);
  }
  return { validWires, terminalWireCounts, partConnections, wireConnections };
}

function reportDuplicateWires(validWires: readonly ValidWire[], diagnostics: CircuitDiagnostic[]) {
  const duplicateEdges = new Map<string, ValidWire[]>();
  for (const wire of validWires) {
    const first = endpointKey(wire.from);
    const second = endpointKey(wire.to);
    const [left, right] = first < second ? [first, second] : [second, first];
    const key = JSON.stringify([left, right]);
    const entries = duplicateEdges.get(key) ?? [];
    entries.push(wire);
    duplicateEdges.set(key, entries);
  }
  for (const wires of duplicateEdges.values()) {
    if (wires.length > 1) {
      const first = wires[0];
      if (!first) { continue; }
      diagnostics.push(makeDiagnostic(
        "duplicate-wire",
        "error",
        `同じ端子間をつなぐ導線が${wires.length}本あります。`,
        [first.from.partId, first.to.partId],
        wires.map((wire) => wire.id),
      ));
    }
  }
}

function reportDuplicateLabels(indexedParts: readonly IndexedPart[], diagnostics: CircuitDiagnostic[]) {
  const labels = new Map<string, IndexedPart[]>();
  for (const item of indexedParts) {
    if (item.part.kind === "ground") { continue; }
    const label = item.part.label.trim();
    if (!label) { continue; }
    const entries = labels.get(label) ?? [];
    entries.push(item);
    labels.set(label, entries);
  }
  for (const [label, entries] of labels) {
    if (entries.length > 1) {
      diagnostics.push(makeDiagnostic(
        "duplicate-label",
        "warning",
        `表示名「${label}」が複数の部品で使われています。`,
        entries.map(({ part }) => part.id),
        [],
        label,
      ));
    }
  }
}

function reportTerminalConnections(
  indexedParts: readonly IndexedPart[],
  validWires: readonly ValidWire[],
  terminalWireCounts: ReadonlyMap<string, number>,
  diagnostics: CircuitDiagnostic[],
) {
  for (const item of indexedParts) {
    if (item.terminals.length === 0) { continue; }
    const connectedCount = item.terminals.filter((terminal) =>
      (terminalWireCounts.get(endpointKey({ partId: item.part.id, terminal })) ?? 0) > 0,
    ).length;
    if (connectedCount === 0) {
      diagnostics.push(makeDiagnostic(
        "isolated-part",
        "warning",
        `${partLabel(item.part)} に導線がつながっていません。`,
        [item.part.id],
        [],
        String(item.index),
      ));
      continue;
    }
    for (const terminal of item.terminals) {
      if ((terminalWireCounts.get(endpointKey({ partId: item.part.id, terminal })) ?? 0) > 0) { continue; }
      diagnostics.push(makeDiagnostic(
        "unconnected-terminal",
        "warning",
        `${partLabel(item.part)} の${terminalName(item.part, terminal)}が未接続です。`,
        [item.part.id],
        [],
        `${item.index}:${terminal}`,
      ));
    }
    if (item.part.kind === "junction") {
      const incidentWireIds = validWires
        .filter((wire) => wire.fromPart.key === item.key || wire.toPart.key === item.key)
        .map((wire) => wire.id);
      if (incidentWireIds.length !== 1) { continue; }
      diagnostics.push(makeDiagnostic(
        "dead-end-junction",
        "warning",
        `接続点 ${partLabel(item.part)} は導線1本だけにつながっています。`,
        [item.part.id],
        incidentWireIds,
        String(item.index),
      ));
    }
  }
}

function reportUnpoweredComponents(
  indexedParts: readonly IndexedPart[],
  validWires: readonly ValidWire[],
  partConnections: DisjointSet,
  diagnostics: CircuitDiagnostic[],
) {
  const componentGroups = new Map<string, IndexedPart[]>();
  for (const item of indexedParts) {
    const root = partConnections.find(item.key);
    const entries = componentGroups.get(root) ?? [];
    entries.push(item);
    componentGroups.set(root, entries);
  }
  for (const entries of componentGroups.values()) {
    const keys = new Set(entries.map((item) => item.key));
    const wires = validWires.filter((wire) => keys.has(wire.fromPart.key) && keys.has(wire.toPart.key));
    if (
      wires.length === 0 ||
      entries.some(({ part }) =>
        part.kind === "battery" || part.kind === "ac-source" || part.kind === "current-source",
      ) ||
      !entries.some(({ part }) => part.kind !== "junction")
    ) { continue; }
    diagnostics.push(makeDiagnostic(
      "unpowered-component",
      "warning",
      "電池を含まない接続回路があります。",
      entries.map(({ part }) => part.id),
      wires.map(({ id }) => id),
    ));
  }
}

function reportWireBypasses(
  indexedParts: readonly IndexedPart[],
  validWires: readonly ValidWire[],
  wireConnections: DisjointSet,
  diagnostics: CircuitDiagnostic[],
) {
  for (const item of indexedParts) {
    if (item.terminals.length !== 2 || !item.terminals.includes("a") || !item.terminals.includes("b")) { continue; }
    const firstTerminal = endpointKey({ partId: item.part.id, terminal: "a" });
    const secondTerminal = endpointKey({ partId: item.part.id, terminal: "b" });
    if (!wireConnections.connected(firstTerminal, secondTerminal)) { continue; }
    const battery = item.part.kind === "battery";
    const voltageSource = item.part.kind === "ac-source";
    diagnostics.push(makeDiagnostic(
      battery ? "wire-shorted-battery" : voltageSource ? "wire-shorted-voltage-source" : "wire-bypassed-part",
      battery || voltageSource ? "error" : "warning",
      battery || voltageSource
        ? `${partLabel(item.part)} の両端子が導線だけでつながり、短絡しています。`
        : `${partLabel(item.part)} の両端子が導線だけでつながり、部品が迂回されています。`,
      [item.part.id],
      validWires
        .filter((wire) => wireConnections.connected(firstTerminal, endpointKey(wire.from)))
        .filter((wire) => wireConnections.connected(firstTerminal, endpointKey(wire.to)))
        .map(({ id }) => id),
      String(item.index),
    ));
  }
}

/**
 * Finds structural circuit problems without invoking the electrical solver.
 * The result is deterministic for a given document and can be used for editor feedback.
 */
export function inspectCircuit(document: CircuitDocument): CircuitDiagnostic[] {
  const diagnostics: CircuitDiagnostic[] = [];
  const { indexedParts, partsById } = indexParts(document, diagnostics);
  reportDuplicateWireIds(document, diagnostics);
  const { validWires, terminalWireCounts, partConnections, wireConnections } =
    collectWireGraph(document, partsById, indexedParts, diagnostics);
  reportDuplicateWires(validWires, diagnostics);
  reportDuplicateLabels(indexedParts, diagnostics);
  reportTerminalConnections(indexedParts, validWires, terminalWireCounts, diagnostics);
  reportUnpoweredComponents(indexedParts, validWires, partConnections, diagnostics);
  reportWireBypasses(indexedParts, validWires, wireConnections, diagnostics);
  return diagnostics;
}
