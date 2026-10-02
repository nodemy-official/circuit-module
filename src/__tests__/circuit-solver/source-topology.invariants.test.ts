// biome-ignore-all lint/suspicious/noMisplacedAssertion: Helpers verify independently derived audit expectations.
import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitEndpoint, CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import {
  addRational as add,
  assertCorrectRounding,
  compareRational as compare,
  divideRational as divide,
  multiplyRational as multiply,
  negateRational as negate,
  nextDown,
  nextUp,
  rational,
  rationalFromNumber,
  subtractRational as subtract,
  type Rational,
} from "../helpers/numeric-oracle.js";

const zero = rational(0n);
const one = rational(1n);
const input = (value: number) => rationalFromNumber(value)!;
const lead = input(1e-6);
const threshold = input(0.001);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const parallel = (values: readonly Rational[]) => divide(one, sum(values.map((value) => divide(one, value))));

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(value: string): CircuitEndpoint {
  const [partId, terminal] = value.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown terminal ${value}`); }
  return { partId, terminal };
}

function wire(document: CircuitDocument, from: string, to: string) {
  document.wires.push({ id: `w${document.wires.length}`, from: endpoint(from), to: endpoint(to) });
}

function resistorPath(document: CircuitDocument, id: string, from: string, to: string, values: readonly number[]) {
  let previous = from;
  for (const [index, resistanceOhms] of values.entries()) {
    const name = `${id}${index}`;
    document.parts.push(part(name, "resistor", { resistanceOhms }));
    wire(document, previous, `${name}:a`);
    previous = `${name}:b`;
  }
  wire(document, previous, to);
  return add(sum(values.map(input)), multiply(lead, rational(BigInt(values.length + 1))));
}

// An independent small MNA oracle: source currents are unknowns and satisfy
// Va - Vb - r I = E. Production uses Norton conductance stamping instead.
// Only exact BigInt fractions are used; no production math or solver imports.
function eliminate(rows: Rational[][]) {
  const count = rows.length;
  for (let column = 0; column < count; column += 1) {
    const pivot = rows.findIndex((row, index) => index >= column && row[column].numerator !== 0n);
    if (pivot < 0) { throw new Error(`Independent MNA is singular at ${column}`); }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= count; item += 1) {
      rows[column][item] = divide(rows[column][item], divisor);
    }
    for (let row = column + 1; row < count; row += 1) {
      const factor = rows[row][column];
      if (factor.numerator === 0n) { continue; }
      rows[row][column] = zero;
      for (let item = column + 1; item <= count; item += 1) {
        rows[row][item] = subtract(rows[row][item], multiply(factor, rows[column][item]));
      }
    }
  }
  const solution = Array.from({ length: count }, () => zero);
  for (let row = count - 1; row >= 0; row -= 1) {
    solution[row] = subtract(rows[row][count], sum(solution.slice(row + 1).map((value, offset) =>
      multiply(rows[row][row + offset + 1], value))));
  }
  return solution;
}

function oracle(document: CircuitDocument, idealCells = false) {
  const nodes = new Map<string, number>();
  for (const item of document.parts) {
    nodes.set(`${item.id}:a`, nodes.size);
    if (item.kind !== "junction") { nodes.set(`${item.id}:b`, nodes.size); }
  }
  const cells = document.parts.filter((item) => item.kind === "battery");
  const nodeCount = nodes.size - 1;
  const count = nodeCount + cells.length;
  const rows = Array.from({ length: count }, () => Array.from({ length: count + 1 }, () => zero));
  const node = (name: string) => nodes.get(name)! - 1;
  const stamp = (row: number, column: number, value: Rational) => {
    if (row >= 0 && column >= 0) { rows[row][column] = add(rows[row][column], value); }
  };
  const passive = (from: string, to: string, resistance: Rational) => {
    const a = node(from);
    const b = node(to);
    const g = divide(one, resistance);
    stamp(a, a, g);
    stamp(b, b, g);
    stamp(a, b, negate(g));
    stamp(b, a, negate(g));
  };
  for (const connection of document.wires) {
    passive(`${connection.from.partId}:${connection.from.terminal}`, `${connection.to.partId}:${connection.to.terminal}`, lead);
  }
  for (const item of document.parts.filter((candidate) => candidate.kind === "resistor")) {
    passive(`${item.id}:a`, `${item.id}:b`, input(item.resistanceOhms!));
  }
  for (const [index, cell] of cells.entries()) {
    const a = node(`${cell.id}:a`);
    const b = node(`${cell.id}:b`);
    const current = nodeCount + index;
    stamp(a, current, one);
    stamp(b, current, negate(one));
    stamp(current, a, one);
    stamp(current, b, negate(one));
    stamp(current, current, idealCells ? zero : negate(input(Math.max(cell.internalResistanceOhms ?? 0, 1e-6))));
    rows[current][count] = input(cell.voltageVolts!);
  }
  const solution = eliminate(rows);
  const potential = (name: string) => node(name) < 0 ? zero : solution[node(name)];
  const voltage = (id: string) => subtract(potential(`${id}:a`), potential(`${id}:b`));
  const currents = new Map(cells.map((cell, index) => [cell.id, solution[nodeCount + index]]));
  const current = (item: CircuitPart) => item.kind === "battery" ? currents.get(item.id)!
    : item.kind === "junction" ? zero : divide(voltage(item.id), input(item.resistanceOhms!));
  const passivePower = sum([
    ...document.parts.filter((item) => item.kind === "resistor").map((item) => multiply(voltage(item.id), current(item))),
    ...document.wires.map((connection) => {
      const drop = subtract(potential(`${connection.from.partId}:${connection.from.terminal}`), potential(`${connection.to.partId}:${connection.to.terminal}`));
      return divide(multiply(drop, drop), lead);
    }),
  ]);
  return { potential, voltage, current, passivePower };
}

function verify(document: CircuitDocument, status: "short" | "closed") {
  const expected = oracle(document);
  const actual = analyzeCircuit(document);
  expect.soft(actual.status, `${document.title}: ${actual.message}`).toBe(status);
  for (const item of document.parts.filter((candidate) => candidate.kind !== "junction")) {
    const voltage = expected.voltage(item.id);
    const current = expected.current(item);
    const power = multiply(voltage, current);
    assertCorrectRounding(actual.parts[item.id].voltageVolts, voltage, `${item.id} voltage`);
    assertCorrectRounding(actual.parts[item.id].currentAmps, current, `${item.id} current`);
    assertCorrectRounding(actual.parts[item.id].powerWatts, item.kind === "battery" ? negate(power) : power, `${item.id} power`);
  }
  for (const connection of document.wires) {
    const drop = subtract(expected.potential(`${connection.from.partId}:${connection.from.terminal}`), expected.potential(`${connection.to.partId}:${connection.to.terminal}`));
    assertCorrectRounding(actual.wireCurrents[connection.id], divide(drop, lead), `${connection.id} current`);
  }
  return actual;
}

function variant(document: CircuitDocument, flip: boolean): CircuitDocument {
  const cells = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const reverse = (value: CircuitEndpoint): CircuitEndpoint => flip && cells.has(value.partId)
    ? { ...value, terminal: value.terminal === "a" ? "b" : "a" } : value;
  return {
    ...document,
    parts: [...document.parts].reverse(),
    wires: [...document.wires].reverse().map((connection) => ({ ...connection, from: reverse(connection.to), to: reverse(connection.from) })),
  };
}

interface ParallelCase {
  name: string;
  positive: readonly number[];
  negative: readonly number[];
  load: readonly number[];
  secondLoad?: readonly number[];
  equivalent?: boolean;
  tapA?: number;
  tapB?: number;
  internal?: number;
}

function parallelDocument(values: ParallelCase) {
  const document: CircuitDocument = {
    title: values.name,
    parts: [part("left", "junction"), part("right", "junction")],
    wires: [],
  };
  const returns: Rational[] = [];
  for (let index = 0; index < 2; index += 1) {
    const id = `cell${index}`;
    document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: values.internal ?? 0.1 }));
    const positive = resistorPath(document, `positive${index}-`, "left:a", `${id}:a`, values.positive);
    const negative = resistorPath(document, `negative${index}-`, `${id}:b`, "right:a", values.negative);
    const tapA = values.tapA === undefined ? undefined : add(input(values.tapA), multiply(lead, rational(2n)));
    const tapB = values.tapB === undefined ? undefined : add(input(values.tapB), multiply(lead, rational(2n)));
    // Source suppression at the actual left/right output ports. A private
    // crossed tap contributes to Rout, not to the common passive load.
    returns.push(index === 0 ? add(tapB ? parallel([positive, tapB]) : positive,
      tapA ? parallel([negative, tapA]) : negative) : add(positive, negative));
  }
  const loads = [resistorPath(document, "load", "left:a", "right:a", values.load)];
  if (values.secondLoad) { loads.push(resistorPath(document, "secondLoad", "left:a", "right:a", values.secondLoad)); }
  if (values.equivalent) {
    document.parts.push(
      part("high", "battery", { voltageVolts: 3, internalResistanceOhms: 0.1 }),
      part("opposed", "battery", { voltageVolts: 2, internalResistanceOhms: 0.1 }),
    );
    const positive = resistorPath(document, "otherPositive", "left:a", "high:a", [0.01]);
    wire(document, "high:b", "opposed:b");
    const negative = resistorPath(document, "otherNegative", "opposed:a", "right:a", []);
    returns.push(sum([positive, lead, negative]));
  }
  if (values.tapA !== undefined) { resistorPath(document, "tapA", "cell0:a", "right:a", [values.tapA]); }
  if (values.tapB !== undefined) { resistorPath(document, "tapB", "left:a", "cell0:b", [values.tapB]); }
  // Independent Thevenin output R plus the common load R. Internal cell R
  // is excluded; local shunt loss never enters this output-port metric.
  const external = add(parallel(loads), parallel(returns));
  return { document, external };
}

function twoPortTapExternal(tap: number) {
  const positive = add(input(0.0015), multiply(lead, rational(2n)));
  const negative = add(input(0.000_05), multiply(lead, rational(2n)));
  const tapResistance = add(input(tap), multiply(lead, rational(2n)));
  const source = add(positive, negative);
  const tappedSource = add(parallel([positive, tapResistance]), parallel([negative, tapResistance]));
  return add(add(input(0.0002), multiply(lead, rational(2n))), parallel([tappedSource, source]));
}

const parallelCases: ParallelCase[] = [
  { name: "both-side ballast short", positive: [0.0015], negative: [0.000_05], load: [0.0002] },
  { name: "split ballast and load short", positive: [0.000_75, 0.000_75], negative: [0.000_025, 0.000_025], load: [0.0001, 0.0001] },
  { name: "split ballast and load nonshort", positive: [0.000_75, 0.000_75], negative: [0.000_025, 0.000_025], load: [0.000_15, 0.000_15] },
  { name: "parallel load short", positive: [0.0015], negative: [0.000_05], load: [0.0004], secondLoad: [0.0004] },
  { name: "parallel load nonshort", positive: [0.0015], negative: [0.000_05], load: [0.0006], secondLoad: [0.0006] },
  { name: "equivalent 3V-2V path short", positive: [0.0015], negative: [0.000_05], load: [0.0002], equivalent: true },
  { name: "both upstream taps short", positive: [0.0015], negative: [0.000_05], load: [0.0003], tapA: 0.01, tapB: 0.01, equivalent: true },
  { name: "local loss cannot short a 1.017657 mOhm common output", positive: [0.0015], negative: [0.000_05], load: [0.000_34], tapA: 0.01, tapB: 0.01, equivalent: true },
  { name: "weak both-side taps nonshort", positive: [0.0015], negative: [0.000_05], load: [0.0003], tapA: 1000, tapB: 1000, equivalent: true },
  { name: "equal-valued ballast load and crossed taps", positive: [0.0012], negative: [0.0012], load: [0.0012], tapA: 0.0012, tapB: 0.0012 },
  { name: "internal resistance is excluded", positive: [0.0015], negative: [0.000_05], load: [0.0002], internal: 1000 },
  { name: "weak load legitimately crosses threshold", positive: [], negative: [], load: [0.000_997_5], secondLoad: [1] },
  { name: "weaker load stays above threshold", positive: [], negative: [], load: [0.000_997_5], secondLoad: [1000] },
  { name: "adjacent float below wire-aware threshold", positive: [], negative: [], load: [nextDown(0.000_997)] },
  { name: "adjacent float above wire-aware threshold", positive: [], negative: [], load: [nextUp(0.000_997)] },
];

describe("source topology and permutation invariants", () => {
  it.each(parallelCases)("$name", (values) => {
    const { document, external } = parallelDocument(values);
    const status = compare(external, threshold) < 0 ? "short" : "closed";
    verify(document, status);
    if (["both-side ballast short", "split ballast and load short", "parallel load short", "equivalent 3V-2V path short", "both upstream taps short", "weak both-side taps nonshort", "equal-valued ballast load and crossed taps"].includes(values.name)) {
      verify(variant(document, true), status);
    }
  });

  it.each([1000, 0.01])("adding both-side passive taps must retain a proven short (tap=%s)", (tap) => {
    const baselineValues = { name: "Proven short before passive taps", positive: [0.0015], negative: [0.000_05], load: [0.0002] };
    const baseline = parallelDocument(baselineValues);
    expect(compare(baseline.external, threshold)).toBe(-1);
    verify(baseline.document, "short");
    const tapped = parallelDocument({ ...baselineValues, name: "Passive taps cannot hide the existing short", tapA: tap, tapB: tap });
    expect(compare(tapped.external, twoPortTapExternal(tap))).toBe(0);
    expect(compare(tapped.external, baseline.external)).toBe(-1);
    verify(tapped.document, "short");
    verify(variant(tapped.document, true), "short");
  });

  it("retains the proven short when every source port has a weak crossed tap", () => {
    const baseline = parallelDocument({ name: "All source ports are tapped", positive: [0.0015], negative: [0.000_05], load: [0.0002], tapA: 1000, tapB: 1000 });
    resistorPath(baseline.document, "secondTapA", "cell1:a", "right:a", [1000]);
    resistorPath(baseline.document, "secondTapB", "left:a", "cell1:b", [1000]);
    const positive = add(input(0.0015), multiply(lead, rational(2n)));
    const negative = add(input(0.000_05), multiply(lead, rational(2n)));
    const tap = add(input(1000), multiply(lead, rational(2n)));
    const source = add(parallel([positive, tap]), parallel([negative, tap]));
    const external = add(add(input(0.0002), multiply(lead, rational(2n))), divide(source, rational(2n)));
    expect(compare(external, baseline.external)).toBe(-1);
    expect(compare(external, threshold)).toBe(-1);
    verify(baseline.document, "short");
    verify(variant(baseline.document, true), "short");
  });

  it("keeps six equal resistors closed without a shared load", () => {
    const built = parallelDocument({ name: "Six-resistor crossed-tap reduction", positive: [0.0012], negative: [0.0012], load: [0.0012], tapA: 0.0012, tapB: 0.0012 });
    const document = {
      ...built.document,
      parts: built.document.parts.filter((item) => item.id !== "load0"),
      wires: built.document.wires.filter((connection) => connection.from.partId !== "load0" && connection.to.partId !== "load0"),
    };
    // With r = resistor + its two real leads, ideal cell0 potentials are
    // 1 and 0. Scalar KCL gives left=2/3 and right=1/3. Cell0 delivers 1/r
    // and cell1 delivers 1/(3r). The inverse of this combined power is
    // 3r/4, but it includes cell0's private r return. There is no common
    // passive load: the real circulating macro return is r+2r=3r.
    const resistance = add(input(0.0012), multiply(lead, rational(2n)));
    const external = divide(multiply(resistance, rational(3n)), rational(4n));
    const independent = oracle(document, true);
    expect(compare(divide(one, independent.passivePower), external)).toBe(0);
    expect(compare(independent.current(document.parts.find((item) => item.id === "cell0")!), negate(divide(one, resistance)))).toBe(0);
    expect(compare(independent.current(document.parts.find((item) => item.id === "cell1")!), negate(divide(one, multiply(resistance, rational(3n)))))).toBe(0);
    expect(compare(resistance, threshold)).toBe(1);
    expect(compare(external, threshold)).toBe(-1);
    expect(compare(multiply(resistance, rational(3n)), threshold)).toBe(1);
    verify(document, "closed");
    verify(variant(document, true), "closed");
  });

  it.each([
    { emfs: [1, 1], load: 0.001_01 },
    { emfs: [1, 2, -2], load: 0.001_01 },
    { emfs: [1, 2, -3], load: 0.000_01 },
    { emfs: [1, -2, 1], load: 0.000_01 },
    { emfs: [1, 2, -nextUp(3)], load: 0.000_01 },
    { emfs: [1, 2, -nextDown(3)], load: 0.000_01 },
  ])("series/zero EMF emfs=$emfs load=$load", ({ emfs, load }) => {
    const document: CircuitDocument = { title: "Series cells must follow their actual path", parts: [], wires: [] };
    for (const [index, emf] of emfs.entries()) {
      document.parts.push(part(`cell${index}`, "battery", { voltageVolts: Math.abs(emf), internalResistanceOhms: 0.1 }));
    }
    const entry = (index: number) => `cell${index}:${emfs[index] > 0 ? "a" : "b"}`;
    const exit = (index: number) => `cell${index}:${emfs[index] > 0 ? "b" : "a"}`;
    for (let index = 1; index < emfs.length; index += 1) { wire(document, exit(index - 1), entry(index)); }
    const loadResistance = resistorPath(document, "load", exit(emfs.length - 1), entry(0), [load]);
    const emf = sum(emfs.map(input));
    const external = add(loadResistance, multiply(lead, rational(BigInt(emfs.length - 1))));
    const status = emf.numerator !== 0n && compare(external, threshold) < 0 ? "short" : "closed";
    const expectedCurrent = divide(emf, add(external, multiply(input(0.1), rational(BigInt(emfs.length)))));
    const actual = verify(document, status);
    assertCorrectRounding(actual.parts.cell0.currentAmps, negate(expectedCurrent), "series scalar KVL");
    verify(variant(document, false), status);
  });

  it("partial charging does not turn the terminal ratio into external R", () => {
    const load = 1;
    const { document } = parallelDocument({ name: "Charging with resistive return", positive: [0.0006], negative: [0.0006], load: [load] });
    document.parts.find((item) => item.id === "cell1")!.voltageVolts = 3;
    // The shortest driven return contains all four ballast resistors and
    // eight leads. All passive paths also exceed SHORT_OHMS.
    const circulating = sum([multiply(input(0.0006), rational(4n)), multiply(lead, rational(8n))]);
    expect(compare(circulating, threshold)).toBe(1);
    const actual = verify(document, "closed");
    expect(actual.parts.cell0.currentAmps).toBeGreaterThan(0);
    expect(actual.parts.cell1.currentAmps).toBeLessThan(0);
    verify(variant(document, true), "closed");
  });

  it.each([-1, 3])("opposite/unequal EMFs retain the actual circulating return (second=%s)", (second) => {
    const { document } = parallelDocument({ name: "Actual oriented source paths", positive: [0.000_35], negative: [0.000_35], load: [1] });
    document.parts.find((item) => item.id === "cell1")!.voltageVolts = Math.abs(second);
    if (second < 0) {
      const flip = (value: CircuitEndpoint): CircuitEndpoint => value.partId === "cell1"
        ? { ...value, terminal: value.terminal === "a" ? "b" : "a" } : value;
      document.wires = document.wires.map((connection) => ({ ...connection, from: flip(connection.from), to: flip(connection.to) }));
    }
    const circulating = add(multiply(input(0.000_35), rational(4n)), multiply(lead, rational(8n)));
    expect(compare(circulating, threshold)).toBe(1);
    verify(document, "closed");
    verify(variant(document, true), "closed");
  });

  it("does not jointly drive equal-voltage cells with separate local loads and a series bridge", () => {
    const document: CircuitDocument = { title: "Equal voltage is insufficient to establish parallel ports", parts: [], wires: [] };
    for (let index = 0; index < 2; index += 1) {
      document.parts.push(part(`cell${index}`, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
      resistorPath(document, `load${index}`, `cell${index}:a`, `cell${index}:b`, [0.0014]);
    }
    wire(document, "cell0:b", "cell1:a");
    const local = add(input(0.0014), multiply(lead, rational(2n)));
    expect(compare(local, threshold)).toBe(1);
    // Unconditionally driving both at one volt gives local/2 < threshold;
    // their real connection is series, and neither individual load is short.
    expect(compare(divide(local, rational(2n)), threshold)).toBe(-1);
    verify(document, "closed");
    verify(variant(document, true), "closed");
  });
});
