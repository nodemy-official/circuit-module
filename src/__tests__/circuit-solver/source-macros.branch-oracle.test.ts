import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitEndpoint, CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitExactComplex } from "../../circuit-solver.js";
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
const two = rational(2n);
const input = (value: number) => rationalFromNumber(value)!;
const lead = input(1e-6);
const threshold = input(0.001);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const parallel = (...values: Rational[]) => divide(one, sum(values.map((value) => divide(one, value))));

interface Branch {
  a: string;
  b: string;
  r: Rational;
  e: Rational;
  id?: string;
  cell?: boolean;
  partR?: Rational;
  wires: string[];
  load?: boolean;
}

interface Fixture {
  document: CircuitDocument;
  branches: Branch[];
  p: string;
  n: string;
  selected: Set<string>;
  status: "closed" | "short";
  external?: Rational;
  outputSign?: -1 | 0 | 1;
  zeroLinks?: string[];
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(value: string): CircuitEndpoint {
  const [partId, terminal] = value.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown terminal ${value}`); }
  return { partId, terminal };
}

function fixture(title: string, load?: number, directLoad = false): Fixture {
  const value: Fixture = {
    document: { title, parts: [], wires: [] }, branches: [],
    p: directLoad ? "load:a" : "P:a", n: directLoad ? "load:b" : "N:a",
    selected: new Set(), status: "closed",
  };
  if (directLoad) {
    value.document.parts.push(part("load", "resistor", { resistanceOhms: load }));
    value.branches.push({ a: value.p, b: value.n, r: input(load!), e: zero, id: "load", partR: input(load!), wires: [], load: true });
  } else {
    value.document.parts.push(part("P", "junction"), part("N", "junction"));
    if (load !== undefined) { resistor(value, "load", value.p, value.n, load, true); }
  }
  return value;
}

function rawWire(value: Fixture, a: string, b: string) {
  const id = `w${value.document.wires.length}`;
  value.document.wires.push({ id, from: endpoint(a), to: endpoint(b) });
  return id;
}

function wire(value: Fixture, a: string, b: string) {
  value.branches.push({ a, b, r: lead, e: zero, wires: [rawWire(value, a, b)] });
  return lead;
}

function resistor(value: Fixture, id: string, a: string, b: string, resistance: number, load = false) {
  value.document.parts.push(part(id, "resistor", { resistanceOhms: resistance }));
  const r = add(input(resistance), multiply(two, lead));
  value.branches.push({ a, b, r, e: zero, id, partR: input(resistance), load,
    wires: [rawWire(value, a, `${id}:a`), rawWire(value, `${id}:b`, b)] });
  return r;
}

function cell(value: Fixture, id: string, voltage: number, internal = 0.1, selected = true) {
  value.document.parts.push(part(id, "battery", { voltageVolts: voltage, internalResistanceOhms: internal }));
  value.branches.push({ a: `${id}:a`, b: `${id}:b`, r: input(Math.max(internal, 1e-6)), e: input(voltage), id, cell: true, wires: [] });
  if (selected) { value.selected.add(id); }
}

function simple(value: Fixture, id: string, positive: number, negative: number, internal = 0.1) {
  cell(value, id, 1, internal);
  const p = positive === 0 ? wire(value, value.p, `${id}:a`) : resistor(value, `p-${id}`, value.p, `${id}:a`, positive);
  const n = negative === 0 ? wire(value, `${id}:b`, value.n) : resistor(value, `n-${id}`, `${id}:b`, value.n, negative);
  return add(p, n);
}

function string(value: Fixture, id: string, emfs: readonly number[], ballast: number) {
  let previous = value.p;
  let resistance = zero;
  for (const [index, emf] of emfs.entries()) {
    const name = `${id}-${index}`;
    cell(value, name, Math.abs(emf));
    const a = `${name}:${emf > 0 ? "a" : "b"}`;
    const b = `${name}:${emf > 0 ? "b" : "a"}`;
    resistance = add(resistance, index === 0 ? resistor(value, `p-${id}`, previous, a, ballast) : wire(value, previous, a));
    previous = b;
  }
  return add(resistance, resistor(value, `n-${id}`, previous, value.n, ballast));
}

// Independent branch-current MNA: each edge contributes one current unknown,
// KCL uses incidence signs, and its KVL row is Va - Vb - R*I = E.
// Untapped resistor interiors are eliminated by exact series addition, with
// every physical 1 µΩ wire retained. No production arithmetic is imported.
function solve(branches: readonly Branch[], injection?: { a: string; b: string }) {
  const nodes = [...new Set(branches.flatMap((branch) => [branch.a, branch.b]))];
  const adjacency = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const branch of branches) {
    adjacency.get(branch.a)!.push(branch.b);
    adjacency.get(branch.b)!.push(branch.a);
  }
  const component = new Map<string, string>();
  for (const root of nodes) {
    if (component.has(root)) { continue; }
    component.set(root, root);
    const pending = [root];
    for (const node of pending) {
      for (const next of adjacency.get(node)!) {
        if (component.has(next)) { continue; }
        component.set(next, root);
        pending.push(next);
      }
    }
  }
  if (injection && (component.get(injection.a) === undefined || component.get(injection.a) !== component.get(injection.b))) { return null; }
  const unknowns = nodes.filter((node) => component.get(node) !== node);
  const count = unknowns.length + branches.length;
  const rows = Array.from({ length: count }, () => Array.from({ length: count + 1 }, () => zero));
  const stamp = (row: number, column: number, value: Rational) => {
    if (row >= 0 && column >= 0) { rows[row][column] = add(rows[row][column], value); }
  };
  for (const [index, branch] of branches.entries()) {
    const a = unknowns.indexOf(branch.a);
    const b = unknowns.indexOf(branch.b);
    const current = unknowns.length + index;
    stamp(a, current, one);
    stamp(b, current, negate(one));
    stamp(current, a, one);
    stamp(current, b, negate(one));
    stamp(current, current, negate(branch.r));
    rows[current][count] = branch.e;
  }
  if (injection) {
    stamp(unknowns.indexOf(injection.a), count, one);
    stamp(unknowns.indexOf(injection.b), count, negate(one));
  }
  for (let column = 0; column < count; column += 1) {
    const pivot = rows.findIndex((row, index) => index >= column && row[column].numerator !== 0n);
    if (pivot < 0) { throw new Error(`Independent KCL/KVL singular at ${column}`); }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= count; item += 1) { rows[column][item] = divide(rows[column][item], divisor); }
    for (let row = column + 1; row < count; row += 1) {
      const factor = rows[row][column];
      rows[row][column] = zero;
      for (let item = column + 1; item <= count; item += 1) { rows[row][item] = subtract(rows[row][item], multiply(factor, rows[column][item])); }
    }
  }
  const solution = Array.from({ length: count }, () => zero);
  for (let row = count - 1; row >= 0; row -= 1) {
    solution[row] = subtract(rows[row][count], sum(solution.slice(row + 1).map((value, index) => multiply(rows[row][row + index + 1], value))));
  }
  const voltage = (node: string) => unknowns.indexOf(node) < 0 ? zero : solution[unknowns.indexOf(node)];
  return { voltage, currents: solution.slice(unknowns.length) };
}

function output(value: Fixture) {
  const sources = value.branches.filter((branch) => !branch.load && (!branch.cell || value.selected.has(branch.id!)));
  const ideal = sources.map((branch) => branch.cell ? { ...branch, r: zero } : branch);
  const suppressed = solve(ideal.map((branch) => ({ ...branch, e: zero })), { a: value.p, b: value.n });
  const open = solve(ideal);
  if (!suppressed || !open) { throw new Error("Independent output is disconnected"); }
  const r = subtract(suppressed.voltage(value.p), suppressed.voltage(value.n));
  const loads = value.branches.filter((branch) => branch.load);
  return { r: add(r, parallel(...loads.map((branch) => branch.r))), v: subtract(open.voltage(value.p), open.voltage(value.n)) };
}

const cases: Fixture[] = [];

// Shared output wires stay outside parallel private source leads. Adjacent
// binary64 inputs straddle the exact, wire-aware threshold.
for (const count of [2, 3, 5]) {
  const boundary = 0.001 - 2e-6 - 2e-6 / count;
  for (const load of [nextDown(boundary), nextUp(boundary)]) {
    const value = fixture(`shared leads: ${count} cells, load=${load}`, load);
    const returns = Array.from({ length: count }, (_, index) => simple(value, `s${index}`, 0, 0));
    value.external = add(add(input(load), multiply(two, lead)), parallel(...returns));
    value.status = compare(value.external, threshold) < 0 ? "short" : "closed";
    value.outputSign = 1;
    cases.push(value);
  }
}
for (const load of [0.0002, 0.0006]) {
  const value = fixture(`unequal two-sided ballasts: load=${load}`, load, true);
  const a = simple(value, "s0", 0.0015, 0.000_05, 1000);
  const b = simple(value, "s1", 0.0021, 0.000_09, 1000);
  value.external = add(input(load), parallel(a, b));
  value.status = compare(value.external, threshold) < 0 ? "short" : "closed";
  value.outputSign = 1;
  cases.push(value);
}

// A balanced cross-tap has zero output EMF despite nonzero private cell
// currents. A one-ULP imbalance must remain nonzero, even at tiny source E.
for (const scenario of [
  { r: 0.0012, t: 0.0012, load: 0.0001, emf: 1 },
  { r: 0.0015, t: 0.0008, load: 0.0003, emf: 1 },
  { r: 0.0015, t: 0.002, load: 0.0003, emf: 1 },
  { r: 0.0012, t: nextDown(0.0012), load: 0.0001, emf: 1 },
  { r: 0.0012, t: nextUp(0.0012), load: 0.0001, emf: 1 },
  { r: 0.0012, t: nextDown(0.0012), load: 0.0001, emf: 1e-300 },
  { r: 0.0012, t: nextUp(0.0012), load: 0.0001, emf: 1e-300 },
  { r: 0.0012, t: nextUp(0.0012), load: 0.0001, emf: Number.MIN_VALUE },
  { r: 0.0006, t: 0.0006, load: 0.01, emf: 1 },
  { r: 0.0012, t: 0.0012, load: 0.0001, emf: Number.MIN_VALUE },
]) {
  const value = fixture(`crossed output: ${JSON.stringify(scenario)}`, scenario.load, true);
  for (let index = 0; index < 2; index += 1) {
    const id = `s${index}`;
    cell(value, id, scenario.emf);
    resistor(value, `p${index}`, value.p, `${id}:a`, scenario.r);
    resistor(value, `n${index}`, `${id}:b`, value.n, scenario.r);
    resistor(value, `tA${index}`, `${id}:a`, value.n, scenario.t);
    resistor(value, `tB${index}`, value.p, `${id}:b`, scenario.t);
  }
  const r = add(input(scenario.r), multiply(two, lead));
  const t = add(input(scenario.t), multiply(two, lead));
  value.external = add(input(scenario.load), parallel(r, t));
  value.outputSign = compare(t, r);
  // At symmetry each cell's two passive return paths are 2r in parallel.
  value.status = compare(r, threshold) < 0 || value.outputSign !== 0 && compare(value.external, threshold) < 0 ? "short" : "closed";
  cases.push(value);
}

for (const emfs of [[1, 1, 1, 1], [3, -2], [1, 2, -3], [1, 2, -nextUp(3)]]) {
  for (const load of [0.000_59, 0.000_61]) {
    const value = fixture(`compound paired cells: ${emfs.join(",")}, load=${load}`, load);
    const a = string(value, "a", emfs, 0.0004);
    const b = string(value, "b", emfs, 0.0004);
    value.external = add(add(input(load), multiply(two, lead)), parallel(a, b));
    value.outputSign = compare(sum(emfs.map(input)), zero);
    value.status = value.outputSign !== 0 && compare(value.external, threshold) < 0 ? "short" : "closed";
    cases.push(value);
  }
}

// An unselected, oppositely oriented 2 V cell is open in this subgroup
// evaluation. Its four resistors still give two 2r paths in parallel.
for (const bridge of [0.002, 0.01]) {
  for (const load of bridge === 0.002 ? [0.000_44, 0.000_46] : [0.000_29, 0.000_31]) {
    const value = fixture(`unselected passive bridge: r=${bridge}, load=${load}`, load, true);
    const a = simple(value, "s0", 0.0015, 0);
    const b = simple(value, "s1", 0.0015, 0);
    cell(value, "other", 2, 0.1, false);
    for (const [id, from, to] of [
      ["otherP", value.p, "other:b"], ["otherN", "other:a", value.n],
      ["otherTA", "other:b", value.n], ["otherTB", value.p, "other:a"],
    ]) { resistor(value, id, from, to, bridge); }
    value.external = add(input(load), parallel(a, b, add(input(bridge), multiply(two, lead))));
    value.outputSign = 1;
    value.status = compare(value.external, threshold) < 0 ? "short" : "closed";
    cases.push(value);
  }
}

for (const load of [0.0003, 0.000_34]) {
  for (const reverseOrder of [false, true]) {
    const value = fixture(`3-2 V subgroup and both upstream taps: load=${load}, reorder=${reverseOrder}`, load, true);
    const p = add(input(0.0015), multiply(two, lead));
    const n = add(input(0.000_05), multiply(two, lead));
    const t = add(input(0.01), multiply(two, lead));
    simple(value, "s0", 0.0015, 0.000_05);
    const second = simple(value, "s1", 0.0015, 0.000_05);
    resistor(value, "tapA", "s0:a", value.n, 0.01);
    resistor(value, "tapB", value.p, "s0:b", 0.01);
    cell(value, "high", 3);
    cell(value, "opposed", 2);
    const third = sum([resistor(value, "thirdP", value.p, "high:a", 0.01), wire(value, "high:b", "opposed:b"), wire(value, "opposed:a", value.n)]);
    value.external = add(input(load), parallel(add(parallel(p, t), parallel(n, t)), second, third));
    value.outputSign = 1;
    value.status = load === 0.0003 ? "short" : "closed";
    if (reverseOrder) {
      value.document.parts.reverse();
      value.document.wires.reverse();
    }
    cases.push(value);
  }
}

for (const weak of [1000, 1e100]) {
  const value = fixture(`series null links: r=${weak}`);
  cell(value, "a", 1);
  cell(value, "b", 1);
  resistor(value, "between", "a:b", "b:a", 0.0015);
  resistor(value, "load", "b:b", "a:a", 0.0015);
  resistor(value, "weakP", "a:a", "b:a", weak);
  resistor(value, "weakN", "a:b", "b:b", weak);
  value.zeroLinks = ["weakP", "weakN"];
  cases.push(value);
}

for (const shunt of [0.0009, 0.0012]) {
  const value = fixture(`private individual shunt: r=${shunt}`, 0.01);
  simple(value, "s0", 0.003, 0.003);
  simple(value, "s1", 0.003, 0.003);
  resistor(value, "private", "s0:a", "s0:b", shunt);
  value.status = shunt === 0.0009 ? "short" : "closed";
  cases.push(value);
}

// Six-resistor graph with no passive branch directly between the hubs.
// Cell0's local return is r, cell1's is 3r; the circulating macro return
// is 3r. Summing private losses and inverting would incorrectly give 3r/4.
for (const reverseOrder of [false, true]) {
  const value = fixture(`no common load, six equal resistors: reorder=${reverseOrder}`);
  simple(value, "s0", 0.0012, 0.0012);
  simple(value, "s1", 0.0012, 0.0012);
  resistor(value, "tapA", "s0:a", value.n, 0.0012);
  resistor(value, "tapB", value.p, "s0:b", 0.0012);
  if (reverseOrder) { value.document.parts.reverse(); value.document.wires.reverse(); }
  cases.push(value);
}

// Adding an exactly zero-current same-side bridge cannot change the circuit's
// drive, common port resistance, or status. Both sides have real ballasts, so
// a conductor-only shared source-constraint group cannot mask discovery gaps.
// Known review finding: the four 0.2 mΩ bridged fixtures currently return
// closed instead of short, although Rout+Rload = 0.979 mΩ and bridge I = 0.
// sourceOutputCut merges the sources through the weak edge after removing
// the output hubs, so its >=2 independent-source-macro condition is lost.
for (const load of [0.0002, 0.0003]) {
  const value = fixture(`parallel null-bridge baseline: load=${load}`, load);
  const a = simple(value, "s0", 0.0015, 0.000_05);
  const b = simple(value, "s1", 0.0015, 0.000_05);
  value.external = add(add(input(load), multiply(two, lead)), parallel(a, b));
  value.outputSign = 1;
  value.status = compare(value.external, threshold) < 0 ? "short" : "closed";
  cases.push(value);
}
for (const weak of [1000, 1e100]) {
  for (const load of [0.0002, 0.0003]) {
    const value = fixture(`parallel null bridges: r=${weak}, load=${load}`, load);
    const a = simple(value, "s0", 0.0015, 0.000_05);
    const b = simple(value, "s1", 0.0015, 0.000_05);
    resistor(value, "weakP", "s0:a", "s1:a", weak);
    resistor(value, "weakN", "s0:b", "s1:b", weak);
    value.zeroLinks = ["weakP", "weakN"];
    value.external = add(add(input(load), multiply(two, lead)), parallel(a, b));
    value.outputSign = 1;
    value.status = compare(value.external, threshold) < 0 ? "short" : "closed";
    cases.push(value);
  }
}
for (const weak of [1000, 1e100]) {
  const value = fixture(`parallel one-sided null bridge: r=${weak}`, 0.0002);
  const a = simple(value, "s0", 0.0015, 0.000_05);
  const b = simple(value, "s1", 0.0015, 0.000_05);
  resistor(value, "weakP", "s0:a", "s1:a", weak);
  value.zeroLinks = ["weakP"];
  value.external = add(add(input(0.0002), multiply(two, lead)), parallel(a, b));
  value.outputSign = 1;
  value.status = "short";
  cases.push(value);
}
for (const shunt of [0.0017, 0.003]) {
  const value = fixture(`parallel private passive returns: r=${shunt}`, 0.01);
  simple(value, "s0", 0.003, 0.003);
  simple(value, "s1", 0.003, 0.003);
  resistor(value, "private0", "s0:a", "s0:b", shunt);
  resistor(value, "private1", "s0:a", "s0:b", shunt);
  value.status = shunt === 0.0017 ? "short" : "closed";
  cases.push(value);
}

function exactReading(retained: CircuitExactComplex | undefined, scalar: number) {
  if (!retained) { return input(scalar); }
  if (!("numerator" in retained.real)) { throw new Error("Unexpected expression in DC rational reading"); }
  const text = retained.real.numerator;
  return rational(text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text), BigInt(retained.real.denominator));
}

function magnitude(value: Rational) { return value.numerator < 0n ? negate(value) : value; }

describe("source-output macros against an independent branch oracle", () => {
  it.each(cases)("$document.title", (value) => {
    const expected = solve(value.branches)!;
    if (value.document.title.startsWith("parallel null") || value.document.title.startsWith("parallel one-sided null")) {
      // With or without these bridges, symmetry gives Icell=-1/(ri+b+2L),
      // b=1.5mΩ+0.05mΩ+4 wires and L=load+2 shared wires.
      const ballast = add(add(input(0.0015), input(0.000_05)), multiply(rational(4n), lead));
      const load = value.branches.find((branch) => branch.load)!.r;
      const current = negate(divide(one, sum([input(0.1), ballast, multiply(two, load)])));
      for (const [index, branch] of value.branches.entries()) {
        if (branch.cell) { expect(compare(expected.currents[index], current), "null bridge preserves scalar KVL").toBe(0); }
      }
    }
    if (value.external) {
      const response = output(value);
      expect(compare(response.r, value.external), "closed form versus independent port KCL").toBe(0);
      expect(compare(response.v, zero), "exact open-circuit EMF sign").toBe(value.outputSign);
      // MIN_VALUE cases also exercise a nonzero port EMF below display range.
      if (value.outputSign !== 0 && value.document.parts.some((item) => item.voltageVolts === Number.MIN_VALUE)) {
        expect(response.v.numerator).not.toBe(0n);
      }
    }
    const actual = analyzeCircuit(value.document);
    expect.soft(actual.status, value.document.title).toBe(value.status);
    for (const [index, branch] of value.branches.entries()) {
      const current = expected.currents[index];
      if (branch.id) {
        const voltage = branch.cell ? add(branch.e, multiply(branch.r, current)) : multiply(branch.partR!, current);
        const power = multiply(voltage, branch.cell ? negate(current) : current);
        const reading = actual.parts[branch.id];
        // Validate the retained signed rational as well as the exact nearest
        // rounding interval. Scalar zero has no physical polarity; the tiny
        // signed voltage/current must still survive in the precision fields.
        expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${branch.id} retained current`).toBe(0);
        expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage), `${branch.id} retained voltage`).toBe(0);
        assertCorrectRounding(Math.abs(reading.currentAmps), magnitude(current), `${branch.id} current magnitude`);
        assertCorrectRounding(Math.abs(reading.voltageVolts), magnitude(voltage), `${branch.id} voltage magnitude`);
        assertCorrectRounding(reading.powerWatts, power, `${branch.id} power`);
      }
      for (const id of branch.wires) {
        assertCorrectRounding(Math.abs(actual.wireCurrents[id]), magnitude(current), `${id} current magnitude`);
        if (actual.wireCurrents[id] !== 0) { expect(Math.sign(actual.wireCurrents[id])).toBe(compare(current, zero)); }
      }
    }
    // Check every private passive return separately, with all cells open.
    // This is independent of the common output and never uses Vcell/Icell.
    const passive = value.branches.filter((branch) => !branch.cell);
    for (const [index, branch] of value.branches.entries()) {
      if (!branch.cell) { continue; }
      const returned = solve(passive, { a: branch.a, b: branch.b });
      if (!returned) { continue; }
      const resistance = subtract(returned.voltage(branch.a), returned.voltage(branch.b));
      if (compare(resistance, threshold) < 0 && expected.currents[index].numerator !== 0n) {
        expect(actual.status, `${branch.id}: independently proven individual passive short`).toBe("short");
      }
    }
    for (const id of value.zeroLinks ?? []) {
      const index = value.branches.findIndex((branch) => branch.id === id);
      expect(expected.currents[index].numerator).toBe(0n);
      expect(actual.parts[id].currentAmps).toBe(0);
      expect(actual.parts[id].voltageVolts).toBe(0);
    }
  });
});
