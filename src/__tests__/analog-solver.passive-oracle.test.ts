import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeAnalogCircuit, type ComplexValue } from "../analog-solver.js";

type PassiveKind = "resistor" | "capacitor" | "inductor";

interface GeneratedBranch {
  id: string;
  kind: PassiveKind | "ac-source";
  a: number;
  b: number;
  value: number;
  phaseDegrees?: number;
}

interface OracleResult {
  nodeVoltages: ComplexValue[];
  partVoltages: Record<string, ComplexValue>;
  partCurrents: Record<string, ComplexValue>;
}

const add = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

const subtract = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real - right.real,
  imaginary: left.imaginary - right.imaginary,
});

const multiply = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real * right.real - left.imaginary * right.imaginary,
  imaginary: left.real * right.imaginary + left.imaginary * right.real,
});

const divide = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const scale = Math.max(Math.abs(right.real), Math.abs(right.imaginary));
  const real = right.real / scale;
  const imaginary = right.imaginary / scale;
  const denominator = real * real + imaginary * imaginary;
  return {
    real: ((left.real / scale) * real + (left.imaginary / scale) * imaginary) / denominator,
    imaginary: ((left.imaginary / scale) * real - (left.real / scale) * imaginary) / denominator,
  };
};

const magnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);

function seededRandom(seed: number) {
  const modulus = 2_147_483_647;
  let state = seed % modulus;
  if (state === 0) { state = 1; }
  return () => {
    // Park–Miller's product remains exactly representable as a JS integer here.
    state = (state * 48_271) % modulus;
    return state / modulus;
  };
}

function makePart(id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart {
  return {
    id,
    kind,
    x: 0,
    y: 0,
    ...circuitPartCatalog[kind].defaults,
    ...fields,
  };
}

function wire(
  id: string,
  fromPartId: string,
  fromTerminal: CircuitTerminal,
  toPartId: string,
  toTerminal: CircuitTerminal,
) {
  return {
    id,
    from: { partId: fromPartId, terminal: fromTerminal },
    to: { partId: toPartId, terminal: toTerminal },
  };
}

function impedance(branch: GeneratedBranch, frequencyHz: number): ComplexValue {
  if (branch.kind === "resistor") { return { real: branch.value, imaginary: 0 }; }
  const omega = 2 * Math.PI * frequencyHz;
  return branch.kind === "inductor"
    ? { real: 0, imaginary: omega * branch.value }
    : { real: 0, imaginary: -1 / (omega * branch.value) };
}

/** Independent complex MNA oracle. Sources and passive admittances are stamped directly. */
function solveOracle(
  nodeCount: number,
  branches: GeneratedBranch[],
  frequencyHz: number,
  referenceNode: number | undefined,
): OracleResult {
  // An ungrounded circuit has an arbitrary common-mode voltage. Anchor node zero for
  // the oracle; the comparisons below use branch voltages, which are reference-invariant.
  const oracleReferenceNode = referenceNode ?? 0;
  const nodeUnknowns = Array.from({ length: nodeCount }, () => -1);
  let unknownCount = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    if (node !== oracleReferenceNode) { nodeUnknowns[node] = unknownCount++; }
  }
  const sourceUnknowns = new Map<string, number>();
  for (const branch of branches) {
    if (branch.kind === "ac-source") { sourceUnknowns.set(branch.id, unknownCount++); }
  }

  const matrix: ComplexValue[][] = Array.from({ length: unknownCount }, () =>
    Array.from({ length: unknownCount }, () => ({ real: 0, imaginary: 0 })),
  );
  const rhs = Array.from({ length: unknownCount }, () => ({ real: 0, imaginary: 0 }));
  const stamp = (row: number, column: number, value: ComplexValue) => {
    if (row < 0 || column < 0) { return; }
    matrix[row]![column] = add(matrix[row]![column]!, value);
  };

  for (const branch of branches) {
    const a = nodeUnknowns[branch.a] ?? -1;
    const b = nodeUnknowns[branch.b] ?? -1;
    if (branch.kind === "ac-source") {
      const sourceIndex = sourceUnknowns.get(branch.id)!;
      stamp(a, sourceIndex, { real: 1, imaginary: 0 });
      stamp(b, sourceIndex, { real: -1, imaginary: 0 });
      stamp(sourceIndex, a, { real: 1, imaginary: 0 });
      stamp(sourceIndex, b, { real: -1, imaginary: 0 });
      const phase = ((branch.phaseDegrees ?? 0) * Math.PI) / 180;
      rhs[sourceIndex] = {
        real: branch.value * Math.cos(phase),
        imaginary: branch.value * Math.sin(phase),
      };
      continue;
    }

    const admittance = divide({ real: 1, imaginary: 0 }, impedance(branch, frequencyHz));
    stamp(a, a, admittance);
    stamp(a, b, { real: -admittance.real, imaginary: -admittance.imaginary });
    stamp(b, a, { real: -admittance.real, imaginary: -admittance.imaginary });
    stamp(b, b, admittance);
  }

  // Scaled partial pivoting keeps this small independent oracle stable across the seeded values.
  for (let column = 0; column < unknownCount; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < unknownCount; row += 1) {
      if (magnitude(matrix[row]![column]!) > magnitude(matrix[pivot]![column]!)) { pivot = row; }
    }
    if (magnitude(matrix[pivot]![column]!) < 1e-18) {
      throw new Error(`Oracle matrix is singular at column ${column}`);
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    [rhs[column], rhs[pivot]] = [rhs[pivot]!, rhs[column]!];

    const pivotValue = matrix[column]![column]!;
    for (let row = column + 1; row < unknownCount; row += 1) {
      const factor = divide(matrix[row]![column]!, pivotValue);
      if (factor.real === 0 && factor.imaginary === 0) { continue; }
      for (let next = column; next < unknownCount; next += 1) {
        matrix[row]![next] = subtract(
          matrix[row]![next]!,
          multiply(factor, matrix[column]![next]!),
        );
      }
      rhs[row] = subtract(rhs[row]!, multiply(factor, rhs[column]!));
    }
  }

  const solution = Array.from({ length: unknownCount }, () => ({ real: 0, imaginary: 0 }));
  for (let row = unknownCount - 1; row >= 0; row -= 1) {
    let value = rhs[row]!;
    for (let column = row + 1; column < unknownCount; column += 1) {
      value = subtract(value, multiply(matrix[row]![column]!, solution[column]!));
    }
    solution[row] = divide(value, matrix[row]![row]!);
  }

  const nodeVoltages = nodeUnknowns.map((unknown) =>
    unknown < 0 ? { real: 0, imaginary: 0 } : solution[unknown]!,
  );
  const partVoltages: Record<string, ComplexValue> = {};
  const partCurrents: Record<string, ComplexValue> = {};
  for (const branch of branches) {
    const voltage = subtract(nodeVoltages[branch.a]!, nodeVoltages[branch.b]!);
    const current = branch.kind === "ac-source"
      ? solution[sourceUnknowns.get(branch.id)!]!
      : divide(voltage, impedance(branch, frequencyHz));
    partVoltages[branch.id] = voltage;
    partCurrents[branch.id] = current;
  }
  return { nodeVoltages, partVoltages, partCurrents };
}

function makeSeededCircuit(seed: number): {
  document: CircuitDocument;
  branches: GeneratedBranch[];
  nodeCount: number;
  frequencyHz: number;
  groundNode?: number;
} {
  const random = seededRandom(seed);
  const integer = (limit: number) => Math.floor(random() * limit);
  const nodeCount = 4 + integer(3);
  const frequencyHz = [50, 60, 400, 1000, 2400][integer(5)]!;
  const branches: GeneratedBranch[] = [];
  let nextId = 0;
  const addPassive = (kind: PassiveKind, a: number, b: number) => {
    const values = kind === "resistor"
      ? [2.2, 10, 47, 220, 1000]
      : kind === "capacitor"
        ? [47e-9, 220e-9, 1e-6, 4.7e-6]
        : [1e-3, 4.7e-3, 22e-3, 100e-3];
    branches.push({ id: `p${nextId++}`, kind, a, b, value: values[integer(values.length)]! });
  };
  const addRandomPassive = (a: number, b: number) => {
    const kindRoll = integer(10);
    addPassive(kindRoll < 6 ? "resistor" : kindRoll < 8 ? "capacitor" : "inductor", a, b);
  };

  // A resistive spanning tree guarantees every generated network has a unique AC solution.
  for (let node = 1; node < nodeCount; node += 1) {
    const reversed = integer(2) === 0;
    addPassive("resistor", reversed ? node : node - 1, reversed ? node - 1 : node);
  }

  // Include a Wheatstone bridge and one parallel element in every fuzz case.
  addRandomPassive(0, 2);
  addRandomPassive(1, 3);
  addRandomPassive(0, 1);

  // Add independent ideal sources whose source-only graph is a forest, avoiding redundant constraints.
  const sourceParent = Array.from({ length: nodeCount }, (_, node) => node);
  const find = (node: number): number => {
    if (sourceParent[node] === node) { return node; }
    sourceParent[node] = find(sourceParent[node]!);
    return sourceParent[node]!;
  };
  const sourceCount = 2 + integer(2);
  let attempts = 0;
  while (branches.filter((branch) => branch.kind === "ac-source").length < sourceCount && attempts < 100) {
    attempts += 1;
    const a = integer(nodeCount);
    const b = integer(nodeCount);
    if (a === b || find(a) === find(b)) { continue; }
    sourceParent[find(a)] = find(b);
    const phaseDegrees = [0, 25, -55, 90, 145][integer(5)]!;
    branches.push({
      id: `s${nextId++}`,
      kind: "ac-source",
      a,
      b,
      value: [0.5, 2, 5, 12][integer(4)]!,
      phaseDegrees,
    });
  }

  // Extra branches create parallel paths and bridges without relying on a canned topology.
  const extraCount = 2 + integer(5);
  for (let index = 0; index < extraCount; index += 1) {
    const a = integer(nodeCount);
    let b = integer(nodeCount);
    if (a === b) { b = (b + 1) % nodeCount; }
    addRandomPassive(a, b);
  }

  const groundNode = integer(2) === 0 ? undefined : integer(nodeCount);
  const parts: CircuitPart[] = branches.map((branch) => makePart(
    branch.id,
    branch.kind as CircuitPartKind,
    branch.kind === "ac-source"
      ? {
        voltageVolts: branch.value,
        frequencyHz,
        phaseDegrees: branch.phaseDegrees,
      }
      : branch.kind === "resistor"
        ? { resistanceOhms: branch.value }
        : branch.kind === "capacitor"
          ? { capacitanceFarads: branch.value }
          : { inductanceHenries: branch.value },
  ));
  if (groundNode !== undefined) { parts.push(makePart("ground", "ground")); }

  const endpointsByNode = Array.from({ length: nodeCount }, () => [] as [string, CircuitTerminal][]);
  for (const branch of branches) {
    endpointsByNode[branch.a]!.push([branch.id, "a"]);
    endpointsByNode[branch.b]!.push([branch.id, "b"]);
  }
  if (groundNode !== undefined) { endpointsByNode[groundNode]!.push(["ground", "a"]); }

  const wires: CircuitDocument["wires"] = [];
  let wireId = 0;
  for (const endpoints of endpointsByNode) {
    const [first, ...rest] = endpoints;
    for (const endpoint of rest) {
      if (first) { wires.push(wire(`w${wireId++}`, first[0], first[1], endpoint[0], endpoint[1])); }
    }
  }

  return {
    document: { title: `seeded-passive-ac-${seed}`, parts, wires },
    branches,
    nodeCount,
    frequencyHz,
    ...(groundNode === undefined ? {} : { groundNode }),
  };
}

function assertPhasorClose(actual: ComplexValue, expected: ComplexValue, context: string) {
  const error = magnitude(subtract(actual, expected));
  const tolerance = 1e-9 + 2e-8 * magnitude(expected);
  if (error > tolerance) {
    throw new Error(
      `${context}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} error=${error}`,
    );
  }
}

describe("seeded passive AC circuits against an independent nodal oracle", () => {
  it("matches branch voltages, currents, KCL, and KVL for parallel and bridge networks", () => {
    const seeds = Array.from({ length: 512 }, (_, index) => 0x5e_ed_00_00 + index);
    const coverage = {
      grounded: false,
      ungrounded: false,
      resistor: false,
      capacitor: false,
      inductor: false,
      multipleSources: false,
      parallel: false,
      bridge: false,
    };
    for (const seed of seeds) {
      const generated = makeSeededCircuit(seed);
      const passiveBranches = generated.branches.filter((branch) => branch.kind !== "ac-source");
      const pairCounts = new Map<string, number>();
      for (const branch of passiveBranches) {
        coverage[branch.kind] = true;
        const key = `${Math.min(branch.a, branch.b)}:${Math.max(branch.a, branch.b)}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
      coverage.grounded ||= generated.groundNode !== undefined;
      coverage.ungrounded ||= generated.groundNode === undefined;
      coverage.multipleSources ||= generated.branches.filter((branch) => branch.kind === "ac-source").length > 1;
      coverage.parallel ||= [...pairCounts.values()].some((count) => count > 1);
      coverage.bridge ||= ["0:1", "0:2", "1:2", "1:3", "2:3"]
        .every((pair) => (pairCounts.get(pair) ?? 0) > 0);
      const analysis = analyzeAnalogCircuit(generated.document, {
        mode: "ac",
        frequencyHz: generated.frequencyHz,
      });
      expect(analysis.status, `seed=${seed}: ${analysis.message}`).toBe("valid");

      const oracle = solveOracle(
        generated.nodeCount,
        generated.branches,
        generated.frequencyHz,
        generated.groundNode,
      );
      const terminalSums = Array.from({ length: generated.nodeCount }, () => ({ real: 0, imaginary: 0 }));
      const terminalScales = Array.from({ length: generated.nodeCount }, () => 0);

      for (const branch of generated.branches) {
        const reading = analysis.parts[branch.id]!;
        const expectedVoltage = oracle.partVoltages[branch.id]!;
        const expectedCurrent = oracle.partCurrents[branch.id]!;
        const actualVoltage = reading.voltage;
        const actualCurrent = reading.current;
        assertPhasorClose(actualVoltage, expectedVoltage, `seed=${seed} ${branch.id} voltage`);
        assertPhasorClose(actualCurrent, expectedCurrent, `seed=${seed} ${branch.id} current`);

        const voltageFromNodes = subtract(oracle.nodeVoltages[branch.a]!, oracle.nodeVoltages[branch.b]!);
        assertPhasorClose(actualVoltage, voltageFromNodes, `seed=${seed} ${branch.id} KVL`);

        terminalSums[branch.a] = add(terminalSums[branch.a]!, actualCurrent);
        terminalSums[branch.b] = add(terminalSums[branch.b]!, {
          real: -actualCurrent.real,
          imaginary: -actualCurrent.imaginary,
        });
        terminalScales[branch.a] += magnitude(actualCurrent);
        terminalScales[branch.b] += magnitude(actualCurrent);
      }

      for (let node = 0; node < generated.nodeCount; node += 1) {
        const residual = magnitude(terminalSums[node]!);
        const scale = terminalScales[node]!;
        expect(residual, `seed=${seed} node=${node} KCL residual=${residual} scale=${scale}`)
          .toBeLessThanOrEqual(1e-8 * Math.max(scale, 1));
      }
    }
    expect(coverage).toEqual({
      grounded: true,
      ungrounded: true,
      resistor: true,
      capacitor: true,
      inductor: true,
      multipleSources: true,
      parallel: true,
      bridge: true,
    });
  });
});
