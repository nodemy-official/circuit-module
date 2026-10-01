import { expect, it } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "../circuit-model.js";
import { simulateTransient, type TransientSample } from "../transient-solver.js";

interface Branch {
  id: string;
  kind: "resistor" | "capacitor" | "inductor";
  a: number;
  b: number;
  value: number;
  initialCurrent: number;
}

function network(seed: number) {
  let state = seed;
  const choose = (count: number) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % count;
  };
  const nodeCount = 2 + choose(3);
  const sourceNode = nodeCount + 1;
  const sourceVoltage = 2 ** (1 + choose(3));
  const branches: Branch[] = [];
  const add = (kind: Branch["kind"], a: number, b: number) => {
    const reverse = choose(2) === 0;
    branches.push({
      id: `p${branches.length}`, kind,
      a: reverse ? b : a, b: reverse ? a : b,
      value: kind === "resistor" ? 2 ** choose(6) : 2 ** (-4 + choose(5)),
      initialCurrent: kind === "inductor" ? (choose(5) - 2) / 8 : 0,
    });
  };
  for (let node = 1; node <= nodeCount; node += 1) {
    add("capacitor", node, 0);
    add("resistor", node, node === nodeCount ? sourceNode : node + 1);
    add("inductor", node, node === 1 ? sourceNode : node - 1);
  }
  add("resistor", 1, 0);
  add("resistor", nodeCount, 0);
  add("resistor", sourceNode, 1);
  add("inductor", nodeCount, 0);
  const part = (id: string, kind: CircuitPart["kind"], fields: Partial<CircuitPart> = {}): CircuitPart => ({
    id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...fields,
  });
  const parts = branches.map((branch) => part(branch.id, branch.kind,
    branch.kind === "resistor" ? { resistanceOhms: branch.value }
      : branch.kind === "capacitor" ? { capacitanceFarads: branch.value, initialVoltageVolts: 0 }
      : { inductanceHenries: branch.value, initialCurrentAmps: branch.initialCurrent }));
  parts.push(part("source", "battery", { voltageVolts: sourceVoltage }), part("ground", "ground"));
  const endpoints: [string, CircuitTerminal][][] = Array.from({ length: sourceNode + 1 }, () => []);
  for (const branch of branches) {
    endpoints[branch.a]!.push([branch.id, "a"]);
    endpoints[branch.b]!.push([branch.id, "b"]);
  }
  endpoints[0]!.push(["source", "b"], ["ground", "a"]);
  endpoints[sourceNode]!.push(["source", "a"]);
  const wires = endpoints.flatMap(([first, ...rest], node) => rest.map(([partId, terminal], index) => ({
    id: `w${node}-${index}`,
    from: { partId: first![0], terminal: first![1] },
    to: { partId, terminal },
  })));
  if (seed % 2 === 0) { parts.reverse(); wires.reverse(); }
  const document: CircuitDocument = { title: `RLC oracle seed ${seed}`, parts, wires };
  return { document, branches, nodeCount, sourceNode, sourceVoltage };
}

/** Independent floating-point nodal solver, using Norton rather than Thevenin companions. */
function eliminate(matrix: number[][], rhs: number[]) {
  for (let column = 0; column < rhs.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < rhs.length; row += 1) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) { pivot = row; }
    }
    [matrix[pivot], matrix[column]] = [matrix[column]!, matrix[pivot]!];
    [rhs[pivot], rhs[column]] = [rhs[column]!, rhs[pivot]!];
    for (let row = column + 1; row < rhs.length; row += 1) {
      const ratio = matrix[row]![column]! / matrix[column]![column]!;
      for (let index = column; index < rhs.length; index += 1) {
        matrix[row]![index] -= ratio * matrix[column]![index]!;
      }
      rhs[row] -= ratio * rhs[column]!;
    }
  }
  const result = Array.from({ length: rhs.length }, () => 0);
  for (let row = rhs.length - 1; row >= 0; row -= 1) {
    let value = rhs[row]!;
    for (let column = row + 1; column < rhs.length; column += 1) {
      value -= matrix[row]![column]! * result[column]!;
    }
    result[row] = value / matrix[row]![row]!;
  }
  return result;
}

function advance(
  generated: ReturnType<typeof network>,
  previousVoltages: number[],
  currents: Map<string, number>,
  dt: number,
) {
  const { nodeCount, sourceNode, sourceVoltage, branches } = generated;
  const matrix = Array.from({ length: nodeCount }, () => Array.from({ length: nodeCount }, () => 0));
  const rhs = Array.from({ length: nodeCount }, () => 0);
  for (const branch of branches) {
    const conductance = branch.kind === "resistor" ? 1 / branch.value
      : branch.kind === "capacitor" ? branch.value / dt : dt / branch.value;
    const history = branch.kind === "resistor" ? 0 : branch.kind === "capacitor"
      ? -conductance * (previousVoltages[branch.a]! - previousVoltages[branch.b]!)
      : currents.get(branch.id)!;
    for (const [node, other, sign] of [[branch.a, branch.b, 1], [branch.b, branch.a, -1]]) {
      if (node === 0 || node === sourceNode) { continue; }
      matrix[node! - 1]![node! - 1] += conductance;
      rhs[node! - 1] -= sign! * history;
      if (other === sourceNode) { rhs[node! - 1] += conductance * sourceVoltage; }
      else if (other !== 0) { matrix[node! - 1]![other! - 1] -= conductance; }
    }
  }
  return [0, ...eliminate(matrix, rhs), sourceVoltage];
}

function close(actual: number, expected: number, context: string) {
  if (Math.abs(actual - expected) > 2e-11 * Math.max(1e-3, Math.abs(expected)) || !Number.isFinite(actual)) {
    throw new Error(`${context}: ${actual} versus ${expected}`);
  }
}

function checkSample(
  generated: ReturnType<typeof network>,
  sample: TransientSample,
  voltages: number[],
  currents: Map<string, number>,
) {
  const sums = Array.from({ length: generated.sourceNode + 1 }, () => 0);
  let power = 0;
  let powerScale = 0;
  for (const branch of generated.branches) {
    const reading = sample.parts[branch.id]!;
    const context = `${generated.document.title} t=${sample.timeSeconds} ${branch.id}`;
    close(reading.voltageVolts, voltages[branch.a]! - voltages[branch.b]!, `${context} voltage`);
    close(reading.currentAmps, currents.get(branch.id)!, `${context} current`);
    sums[branch.a] += reading.terminalCurrents!.a!;
    sums[branch.b] += reading.terminalCurrents!.b!;
    power += reading.powerWatts;
    powerScale += Math.abs(reading.powerWatts);
  }
  const source = sample.parts.source!;
  close(source.currentAmps, -sums[generated.sourceNode]!, `${generated.document.title} source KCL`);
  sums[generated.sourceNode] += source.terminalCurrents!.a!;
  sums[0] += source.terminalCurrents!.b!;
  for (const sum of sums) { close(sum, 0, `${generated.document.title} node KCL`); }
  if (Math.abs(power + source.powerWatts) > 2e-13 * Math.max(1, powerScale)) {
    throw new Error(`${generated.document.title} t=${sample.timeSeconds} power residual ${power + source.powerWatts}`);
  }
}

it("matches independent Norton nodal steps for generated RLC bridge networks and preserves KCL and power", () => {
  for (let seed = 701; seed < 733; seed += 1) {
    const generated = network(seed);
    const timeStepSeconds = 1 / 128;
    const durationSeconds = 5.5 * timeStepSeconds;
    const result = simulateTransient(generated.document, { durationSeconds, timeStepSeconds });
    expect(result.status, `${generated.document.title}: ${result.message}`).toBe("valid");
    expect(result.samples).toHaveLength(7);
    expect(result.samples.at(-1)!.timeSeconds).toBe(durationSeconds);
    let voltages = [...Array.from({ length: generated.nodeCount + 1 }, () => 0), generated.sourceVoltage];
    const currents = new Map(generated.branches.map((branch) => [branch.id, branch.initialCurrent]));
    const initialKcl = Array.from({ length: voltages.length }, () => 0);
    for (const branch of generated.branches.filter((item) => item.kind !== "capacitor")) {
      const current = branch.kind === "resistor" ? (voltages[branch.a]! - voltages[branch.b]!) / branch.value : branch.initialCurrent;
      currents.set(branch.id, current);
      initialKcl[branch.a] += current;
      initialKcl[branch.b] -= current;
    }
    for (const branch of generated.branches.filter((item) => item.kind === "capacitor")) {
      currents.set(branch.id, branch.a === 0 ? initialKcl[branch.b]! : -initialKcl[branch.a]!);
    }
    checkSample(generated, result.samples[0]!, voltages, currents);
    let previousTime = 0;
    for (const sample of result.samples.slice(1)) {
      const dt = sample.timeSeconds - previousTime;
      const next = advance(generated, voltages, currents, dt);
      for (const branch of generated.branches) {
        const voltage = next[branch.a]! - next[branch.b]!;
        const previousVoltage = voltages[branch.a]! - voltages[branch.b]!;
        currents.set(branch.id, branch.kind === "resistor" ? voltage / branch.value
          : branch.kind === "capacitor" ? branch.value * (voltage - previousVoltage) / dt
          : currents.get(branch.id)! + dt * voltage / branch.value);
      }
      checkSample(generated, sample, next, currents);
      voltages = next;
      previousTime = sample.timeSeconds;
    }
  }
});
