import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { analyzeAnalogCircuit, type ComplexValue } from "../analog-solver.js";

const frequencyHz = 73;

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({ id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } });

function seededRandom(seed: number) {
  let state = seed % 4_294_967_296;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const add = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

const subtract = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real - right.real,
  imaginary: left.imaginary - right.imaginary,
});

const magnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);

const polar = (value: ComplexValue) => ({
  voltageVolts: magnitude(value),
  phaseDegrees: value.real === 0 && value.imaginary === 0
    ? 0
    : Math.atan2(value.imaginary, value.real) * 180 / Math.PI,
});

function expectPhasor(actual: ComplexValue, expected: ComplexValue, context: string) {
  const error = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  const tolerance = 2e-9 + 2e-8 * magnitude(expected);
  if (error > tolerance) {
    throw new Error(`${context}: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}, error=${error}, tolerance=${tolerance}`);
  }
}

function randomPhasor(random: () => number, low: number, high: number): ComplexValue {
  const radius = low + random() * (high - low);
  const phase = (random() * 2 - 1) * Math.PI;
  return { real: radius * Math.cos(phase), imaginary: radius * Math.sin(phase) };
}

function arbitraryNodePotentials(nodeCount: number, random: () => number): ComplexValue[] {
  // The first and last nodes stay close in phasor space even though the
  // source path between them includes much larger, unrelated phasors.
  // This makes KVL accumulation sensitive to a shared real/imaginary scale.
  return Array.from({ length: nodeCount }, (_, node) => {
    if (node === 0) { return { real: 0, imaginary: 0 }; }
    if (node === 1) { return randomPhasor(random, 48, 96); }
    if (node === nodeCount - 1) { return randomPhasor(random, 0.12, 0.4); }
    return randomPhasor(random, 4, 64);
  });
}

function axisNodePotentials(nodeCount: number, random: () => number): ComplexValue[] {
  const potentials: ComplexValue[] = [{ real: 0, imaginary: 0 }];
  const axes: ComplexValue[] = [
    { real: 1, imaginary: 0 },
    { real: -1, imaginary: 0 },
    { real: 0, imaginary: 1 },
    { real: 0, imaginary: -1 },
  ];
  for (let node = 1; node < nodeCount; node += 1) {
    const axis = axes[(node - 1) % axes.length]!;
    const radius = 1 + Math.floor(random() * 12);
    potentials.push({ real: axis.real * radius, imaginary: axis.imaginary * radius });
  }
  return potentials;
}

function sourceEdges(nodeCount: number, axis: boolean, random: () => number) {
  if (axis) {
    // A star contains exact phase axes, then same-axis chords make redundant
    // ideal-source cycles without introducing arbitrary rotations.
    const edges = Array.from({ length: nodeCount - 1 }, (_, node) => [0, node + 1] as const);
    for (let left = 1; left < nodeCount; left += 1) {
      const right = left + 1;
      if (right < nodeCount && left % 2 === 1) { edges.push([left, right]); }
    }
    return edges;
  }

  const edges: Array<readonly [number, number]> = [];
  for (let node = 1; node < nodeCount; node += 1) { edges.push([node - 1, node]); }
  edges.push([nodeCount - 1, 0]);
  const used = new Set(edges.map(([left, right]) => `${Math.min(left, right)}:${Math.max(left, right)}`));
  for (let attempt = 0; attempt < nodeCount; attempt += 1) {
    const left = Math.floor(random() * nodeCount);
    let right = Math.floor(random() * nodeCount);
    if (right === left) { right = (right + 1) % nodeCount; }
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    if (used.has(key)) { continue; }
    used.add(key);
    edges.push([left, right]);
  }
  return edges;
}

function makeDocument(nodePotentials: ComplexValue[], edges: Array<readonly [number, number]>, random: () => number) {
  const nodeCount = nodePotentials.length;
  const loadPositiveNode = Math.floor(random() * nodeCount);
  let loadNegativeNode = Math.floor(random() * nodeCount);
  if (loadNegativeNode === loadPositiveNode) { loadNegativeNode = (loadNegativeNode + 1) % nodeCount; }
  const groundNode = Math.floor(random() * nodeCount);
  const orientedEdges = edges.map(([left, right], index) => {
    const reversed = random() < 0.5;
    return {
      id: `source-${index}`,
      positiveNode: reversed ? right : left,
      negativeNode: reversed ? left : right,
    };
  });
  const sourceParts = orientedEdges.map((edge) => {
    const sourceVoltage = subtract(nodePotentials[edge.positiveNode]!, nodePotentials[edge.negativeNode]!);
    return part(edge.id, "ac-source", {
      ...polar(sourceVoltage),
      frequencyHz,
    });
  });
  let baseCycleResidual: ComplexValue | undefined;
  let baseCycleScale = 0;
  if (edges.length >= nodeCount && edges.slice(0, nodeCount).every((_, index) => {
    const expected = index < nodeCount - 1 ? [index, index + 1] : [nodeCount - 1, 0];
    return edges[index]?.[0] === expected[0] && edges[index]?.[1] === expected[1];
  })) {
    baseCycleResidual = { real: 0, imaginary: 0 };
    for (let index = 0; index < nodeCount; index += 1) {
      const from = index < nodeCount - 1 ? index : nodeCount - 1;
      const to = index < nodeCount - 1 ? index + 1 : 0;
      const edge = orientedEdges[index]!;
      const reading = sourceParts[index]!;
      const phase = (reading.phaseDegrees ?? 0) * Math.PI / 180;
      const inputVoltage = {
        real: (reading.voltageVolts ?? 0) * Math.cos(phase),
        imaginary: (reading.voltageVolts ?? 0) * Math.sin(phase),
      };
      baseCycleScale += reading.voltageVolts ?? 0;
      const direction = edge.positiveNode === from && edge.negativeNode === to ? 1 : -1;
      baseCycleResidual = add(baseCycleResidual, {
        real: direction * inputVoltage.real,
        imaginary: direction * inputVoltage.imaginary,
      });
    }
  }
  const load = part("load", "resistor", { resistanceOhms: 37 });
  const ground = part("ground", "ground");
  const parts = [...sourceParts, load, ground];
  const nodeEndpoints: Array<Array<{ partId: string; terminal: CircuitTerminal }>> =
    Array.from({ length: nodeCount }, () => []);
  for (const edge of orientedEdges) {
    nodeEndpoints[edge.positiveNode]!.push({ partId: edge.id, terminal: "a" });
    nodeEndpoints[edge.negativeNode]!.push({ partId: edge.id, terminal: "b" });
  }
  nodeEndpoints[loadPositiveNode]!.push({ partId: "load", terminal: "a" });
  nodeEndpoints[loadNegativeNode]!.push({ partId: "load", terminal: "b" });

  const wires: CircuitDocument["wires"] = [];
  let wireIndex = 0;
  const representativeByNode = nodeEndpoints.map((endpoints, node) => {
    const [representative, ...others] = endpoints;
    if (!representative) { throw new Error(`node ${node} has no source endpoint`); }
    for (const endpoint of others) {
      wires.push(wire(`node-${node}-${wireIndex++}`, representative.partId, representative.terminal, endpoint.partId, endpoint.terminal));
    }
    return representative;
  });
  wires.push(wire(
    "ground-wire",
    "ground",
    "a",
    representativeByNode[groundNode]!.partId,
    representativeByNode[groundNode]!.terminal,
  ));

  return {
    document: { title: "シード固定の交流電源グラフ", parts, wires },
    oracle: subtract(nodePotentials[loadPositiveNode]!, nodePotentials[loadNegativeNode]!),
    groundNode,
    representativeByNode,
    baseCycleResidual,
    baseCycleScale,
  };
}

function moveGroundToNode(
  document: CircuitDocument,
  representativeByNode: Array<{ partId: string; terminal: CircuitTerminal }>,
  node: number,
): CircuitDocument {
  const target = representativeByNode[node]!;
  return {
    ...document,
    wires: document.wires.map((connection) => connection.id === "ground-wire"
      ? wire("ground-wire", "ground", "a", target.partId, target.terminal)
      : connection),
  };
}

function checkLoad(document: CircuitDocument, expected: ComplexValue, label: string) {
  const analog = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
  const sourceSummary = document.parts
    .filter((item) => item.kind === "ac-source")
    .map(({ id, voltageVolts, phaseDegrees }) => ({ id, voltageVolts, phaseDegrees }));
  if (analog.status !== "valid") {
    throw new Error(`${label}: ${analog.message}; sources=${JSON.stringify(sourceSummary)}`);
  }
  const analogReading = analog.parts.load!;
  expectPhasor(analogReading.voltage, expected, `${label} independent node-potential oracle`);
  expectPhasor({
    real: analogReading.terminalVoltages.a!.real - analogReading.terminalVoltages.b!.real,
    imaginary: analogReading.terminalVoltages.a!.imaginary - analogReading.terminalVoltages.b!.imaginary,
  }, expected, `${label} terminal-potential difference`);

  const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
  if (scalar.status !== "closed") { throw new Error(`${label}: ${scalar.message}`); }
  const reading = scalar.parts.load!;
  const phase = (reading.voltagePhaseDegrees ?? 0) * Math.PI / 180;
  expectPhasor({
    real: reading.voltageVolts * Math.cos(phase),
    imaginary: reading.voltageVolts * Math.sin(phase),
  }, expected, `${label} public load reading`);
  return { analog, scalar };
}

describe("seeded ideal AC source graph properties", () => {
  it("matches independent node-potential differences across graph size, ordering, and GND", () => {
    const random = seededRandom(0x4b_56_4c_27);
    for (let sample = 0; sample < 12; sample += 1) {
      const nodeCount = 3 + Math.floor(random() * 6);
      const axis = sample % 3 === 0;
      const potentials = axis
        ? axisNodePotentials(nodeCount, random)
        : arbitraryNodePotentials(nodeCount, random);
      const edges = sourceEdges(nodeCount, axis, random);
      const {
        document,
        oracle,
        groundNode,
        representativeByNode,
        baseCycleResidual,
        baseCycleScale,
      } = makeDocument(potentials, edges, random);
      if (baseCycleResidual) {
        const roundoffTolerance = 64 * Number.EPSILON * baseCycleScale;
        expect(Math.abs(baseCycleResidual.real),
          `sample ${sample} generated a numerically inconsistent source cycle: ${JSON.stringify(baseCycleResidual)}`,
        ).toBeLessThanOrEqual(roundoffTolerance);
        expect(Math.abs(baseCycleResidual.imaginary),
          `sample ${sample} generated a numerically inconsistent source cycle: ${JSON.stringify(baseCycleResidual)}`,
        ).toBeLessThanOrEqual(roundoffTolerance);
      }
      const cycleNote = baseCycleResidual
        ? `; input cycle residual=${JSON.stringify(baseCycleResidual)}`
        : "";
      const baseline = checkLoad(document, oracle, `seeded sample ${sample}, ${nodeCount} nodes${cycleNote}`);

      const reordered = {
        ...document,
        parts: [...document.parts].reverse(),
        wires: [...document.wires].reverse(),
      };
      const reorderedResult = checkLoad(reordered, oracle, `reordered sample ${sample}`);
      expectPhasor(reorderedResult.analog.parts.load!.voltage, baseline.analog.parts.load!.voltage, `part and wire order sample ${sample}`);

      const movedNode = (groundNode + 1) % nodeCount;
      const moved = checkLoad(
        moveGroundToNode(document, representativeByNode, movedNode),
        oracle,
        `moved GND sample ${sample}`,
      );
      expectPhasor(moved.analog.parts.load!.voltage, baseline.analog.parts.load!.voltage, `GND movement sample ${sample}`);
    }
  });
});
