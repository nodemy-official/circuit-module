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
const parallel = (a: Rational, b: Rational) => divide(multiply(a, b), add(a, b));

interface Branch {
  a: string;
  b: string;
  r: Rational;
  e: Rational;
  id?: string;
  partR?: Rational;
  cell?: boolean;
  load?: boolean;
}

interface Fixture {
  document: CircuitDocument;
  branches: Branch[];
  external?: Rational;
  emf?: Rational;
  cellCurrent?: Rational;
  loadCurrent?: Rational;
  partialCut?: boolean;
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(value: string): CircuitEndpoint {
  const [partId, terminal] = value.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown terminal ${value}`); }
  return { partId, terminal };
}

function fixture(title: string): Fixture {
  return { document: { title, parts: [], wires: [] }, branches: [] };
}

function wire(value: Fixture, a: string, b: string) {
  value.document.wires.push({ id: `w${value.document.wires.length}`, from: endpoint(a), to: endpoint(b) });
}

function resistor(value: Fixture, id: string, a: string, b: string, resistance: number, load = false) {
  value.document.parts.push(part(id, "resistor", { resistanceOhms: resistance }));
  wire(value, a, `${id}:a`);
  wire(value, `${id}:b`, b);
  const r = add(input(resistance), multiply(two, lead));
  value.branches.push({ a, b, r, e: zero, id, partR: input(resistance), load });
  return r;
}

function cell(value: Fixture, id: string) {
  value.document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
  value.branches.push({ a: `${id}:a`, b: `${id}:b`, r: input(0.1), e: one, id, cell: true });
}

// Independent rational branch-current KCL/KVL. Each untapped resistor's
// interior is eliminated with both physical 1 µΩ wires retained. Ideal
// sources are voltage constraints, never an approximate large conductance.
function solve(branches: readonly Branch[], injection?: { a: string; b: string }) {
  const nodes = [...new Set(branches.flatMap((branch) => [branch.a, branch.b]))];
  const voltages = new Map(nodes.slice(1).map((node, index) => [node, index]));
  const count = voltages.size + branches.length;
  const rows = Array.from({ length: count }, () => Array.from({ length: count + 1 }, () => zero));
  const stamp = (row: number | undefined, column: number | undefined, value: Rational) => {
    if (row !== undefined && column !== undefined) { rows[row][column] = add(rows[row][column], value); }
  };
  for (const [index, branch] of branches.entries()) {
    const current = voltages.size + index;
    const a = voltages.get(branch.a);
    const b = voltages.get(branch.b);
    stamp(a, current, one);
    stamp(b, current, negate(one));
    stamp(current, a, one);
    stamp(current, b, negate(one));
    stamp(current, current, negate(branch.r));
    rows[current][count] = branch.e;
  }
  if (injection) {
    stamp(voltages.get(injection.a), count, one);
    stamp(voltages.get(injection.b), count, negate(one));
  }
  for (let column = 0; column < count; column += 1) {
    const pivot = rows.findIndex((row, index) => index >= column && row[column].numerator !== 0n);
    if (pivot < 0) { throw new Error(`Independent singular KCL/KVL at ${column}`); }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= count; item += 1) { rows[column][item] = divide(rows[column][item], divisor); }
    for (let row = column + 1; row < count; row += 1) {
      const factor = rows[row][column];
      rows[row][column] = zero;
      for (let item = column + 1; item <= count; item += 1) {
        rows[row][item] = subtract(rows[row][item], multiply(factor, rows[column][item]));
      }
    }
  }
  const solution = Array.from({ length: count }, () => zero);
  for (let row = count - 1; row >= 0; row -= 1) {
    solution[row] = subtract(rows[row][count], sum(solution.slice(row + 1)
      .map((value, index) => multiply(rows[row][row + index + 1], value))));
  }
  const voltage = (node: string) => {
    const position = voltages.get(node);
    return position === undefined ? zero : solution[position];
  };
  return { voltage, currents: solution.slice(voltages.size) };
}

function port(branches: readonly Branch[], a = "P:a", b = "N:a") {
  const ideal = branches.map((branch) => branch.cell ? { ...branch, r: zero } : branch);
  const open = solve(ideal);
  const suppressed = solve(ideal.map((branch) => ({ ...branch, e: zero })), { a, b });
  return { r: subtract(suppressed.voltage(a), suppressed.voltage(b)), v: subtract(open.voltage(a), open.voltage(b)) };
}

type Side = "P" | "N" | "both";
function drivers(side: Side, weak: number, load: number, topology: "hub" | "diamond" = "hub", count = 2, length = 1) {
  const value = fixture(`${topology} ${side} weak=${weak} load=${load} branches=${count} length=${length}`);
  value.document.parts.push(part("P", "junction"), part("N", "junction"));
  const loadR = resistor(value, "load", "P:a", "N:a", load, true);
  const ends: { P: string; N: string }[] = [];
  for (let branch = 0; branch < count; branch += 1) {
    for (let position = 0; position < length; position += 1) {
      const id = `c${branch}-${position}`;
      cell(value, id);
      if (length > 1) { resistor(value, `shunt${branch}-${position}`, `${id}:a`, `${id}:b`, 0.003); }
      if (position > 0) {
        const a = `c${branch}-${position - 1}:b`;
        const b = `${id}:a`;
        wire(value, a, b);
        value.branches.push({ a, b, r: lead, e: zero });
      }
    }
    ends.push({ P: `c${branch}-0:a`, N: `c${branch}-${length - 1}:b` });
  }
  const n = rational(BigInt(count));
  const r = add(input(0.0007), multiply(two, lead));
  const w = add(input(weak), multiply(two, lead));
  const half = add(input(0.000_35), multiply(two, lead));
  const sides: Rational[] = [];
  for (const output of ["P", "N"] as const) {
    const coupled = side === output || side === "both";
    if (coupled && topology === "hub") { value.document.parts.push(part(`X${output}`, "junction")); }
    for (const [branch, terminals] of ends.entries()) {
      if (coupled && topology === "diamond") {
        const hub = `U${output}${branch}`;
        value.document.parts.push(part(hub, "junction"));
        resistor(value, `inner${output}${branch}`, terminals[output], `${hub}:a`, 0.000_35);
        resistor(value, `outer${output}${branch}`, `${hub}:a`, `${output}:a`, 0.000_35);
      } else {
        resistor(value, `ballast${output}${branch}`, terminals[output], `${output}:a`, 0.0007);
        if (coupled) { resistor(value, `link${output}${branch}`, terminals[output], `X${output}:a`, weak); }
      }
    }
    if (coupled && topology === "hub") {
      resistor(value, `hub${output}`, `X${output}:a`, `${output}:a`, weak);
      // The equal terminal-to-X arms are w/n, followed by the X-to-output
      // arm w. This passive path is parallel to the original r/n ballast.
      sides.push(parallel(divide(r, n), divide(multiply(add(n, one), w), n)));
    } else if (coupled) {
      resistor(value, `bridge${output}`, `U${output}0:a`, `U${output}1:a`, weak);
      sides.push(divide(multiply(two, half), n));
    } else { sides.push(divide(r, n)); }
  }
  value.external = sum([loadR, ...sides, divide(multiply(rational(BigInt(length - 1)), lead), n)]);
  value.emf = rational(BigInt(length));
  const shunt = add(input(0.003), multiply(two, lead));
  const internal = input(0.1);
  const effectiveR = length > 1 ? parallel(internal, shunt) : internal;
  const effectiveE = length > 1 ? divide(shunt, add(internal, shunt)) : one;
  value.loadCurrent = divide(multiply(value.emf, effectiveE), add(value.external, divide(multiply(value.emf, effectiveR), n)));
  const branchCurrent = divide(value.loadCurrent, n);
  value.cellCurrent = length > 1 ? negate(divide(add(one, multiply(shunt, branchCurrent)), add(internal, shunt))) : negate(branchCurrent);
  return value;
}

const cases: Fixture[] = [];
for (const side of ["P", "N", "both"] as const) {
  for (const weak of [1000, 1e100]) {
    for (const load of [0.0001, 0.0012]) { cases.push(drivers(side, weak, load)); }
  }
  for (const load of [0.0001, 0.0012]) { cases.push(drivers(side, load === 0.0001 ? 1000 : 1e100, load, "diamond")); }
}
for (const weak of [1000, 1e100]) {
  for (const load of [0.0001, 0.0012]) {
    cases.push(drivers("both", weak, load, "hub", 3));
    cases.push(drivers("both", weak, load, "hub", 2, 2));
  }

  // A pair of series cells with private loads remains one source column.
  // Extra positive/negative passive couplings must not invent two drivers.
  const privateSeries = fixture(`one series column with private shunts weak=${weak}`);
  cell(privateSeries, "c0");
  cell(privateSeries, "c1");
  wire(privateSeries, "c0:b", "c1:a");
  privateSeries.branches.push({ a: "c0:b", b: "c1:a", r: lead, e: zero });
  resistor(privateSeries, "local0", "c0:a", "c0:b", 0.0014);
  resistor(privateSeries, "local1", "c1:a", "c1:b", 0.0014);
  resistor(privateSeries, "linkP", "c0:a", "c1:a", weak);
  resistor(privateSeries, "linkN", "c0:b", "c1:b", weak);
  cases.push(privateSeries);

  // N is an articulation at the tempting P-J partial load cut. Its
  // nonzero Voc and sub-threshold resistance cannot certify a common load.
  const partial = fixture(`complete common load versus partial cut weak=${weak}`);
  partial.document.parts.push(part("P", "junction"), part("N", "junction"), part("J", "junction"));
  for (let branch = 0; branch < 2; branch += 1) {
    cell(partial, `c${branch}`);
    resistor(partial, `p${branch}`, "P:a", `c${branch}:a`, 0.0015);
    resistor(partial, `n${branch}`, `c${branch}:b`, "N:a", 0.000_05);
  }
  resistor(partial, "linkP", "c0:a", "c1:a", weak);
  resistor(partial, "linkN", "c0:b", "c1:b", weak);
  const a = resistor(partial, "loadA", "P:a", "J:a", 0.000_15, true);
  const b = resistor(partial, "loadB", "J:a", "N:a", 0.000_15, true);
  const tap = resistor(partial, "loadTap", "P:a", "J:a", 0.03, true);
  const other = resistor(partial, "loadOther", "P:a", "N:a", 0.003, true);
  const source = divide(add(add(input(0.0015), input(0.000_05)), multiply(rational(4n), lead)), two);
  const loads = parallel(add(parallel(a, tap), b), other);
  partial.external = add(source, loads);
  partial.emf = one;
  partial.cellCurrent = negate(divide(one, add(input(0.1), multiply(two, partial.external))));
  partial.partialCut = true;
  cases.push(partial);
}

function exactReading(retained: CircuitExactComplex | undefined, scalar: number) {
  if (!retained) { return input(scalar); }
  if (!("numerator" in retained.real)) { throw new Error("Unexpected non-rational DC reading"); }
  const text = retained.real.numerator;
  return rational(text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text), BigInt(retained.real.denominator));
}

describe("source boundary independent driver flow", () => {
  it.each(cases)("$document.title", (value) => {
    const expected = solve(value.branches);
    let status = "closed";
    if (value.external) {
      const sources = value.branches.filter((branch) => !branch.load);
      const response = port(sources);
      const loads = solve(value.branches.filter((branch) => branch.load), { a: "P:a", b: "N:a" });
      const resistance = add(response.r, subtract(loads.voltage("P:a"), loads.voltage("N:a")));
      expect(compare(resistance, value.external), "closed form equals independent port KCL").toBe(0);
      expect(compare(response.v, value.emf!), "open-circuit EMF is exact").toBe(0);
      status = compare(value.external, threshold) < 0 ? "short" : "closed";
      if (value.partialCut) {
        const cutLoads = value.branches.filter((branch) => branch.id === "loadA" || branch.id === "loadTap");
        const cutSources = value.branches.filter((branch) => !cutLoads.includes(branch));
        const cut = port(cutSources, "P:a", "J:a");
        const passive = solve(cutLoads, { a: "P:a", b: "J:a" });
        expect(compare(add(cut.r, subtract(passive.voltage("P:a"), passive.voltage("J:a"))), threshold)).toBe(-1);
        expect(compare(cut.v, zero)).toBe(1);
        expect(status).toBe("closed");
      }
    }
    const actual = analyzeCircuit(value.document);
    const reordered = analyzeCircuit({ ...value.document, parts: [...value.document.parts].reverse(),
      wires: [...value.document.wires].reverse().map((edge) => ({ ...edge, from: edge.to, to: edge.from })) });
    for (const result of [actual, reordered]) { expect(result.status, value.document.title).toBe(status); }
    for (const [index, branch] of value.branches.entries()) {
      const current = expected.currents[index];
      if (branch.cell && value.cellCurrent) { expect(compare(current, value.cellCurrent), "cell current closed form").toBe(0); }
      if (branch.id === "load" && value.loadCurrent) { expect(compare(current, value.loadCurrent), "load current closed form").toBe(0); }
      if (branch.id?.startsWith("bridge")) { expect(current.numerator, "diamond bridge exact symmetry").toBe(0n); }
      if (branch.id?.startsWith("hub")) { expect(compare(current, zero), "hub path carries a nonzero current even at 1e100 Ω").not.toBe(0); }
      if (branch.id) {
        const voltage = branch.cell ? add(branch.e, multiply(branch.r, current)) : multiply(branch.partR!, current);
        for (const result of [actual, reordered]) {
          const reading = result.parts[branch.id];
          expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${branch.id} exact KCL current`).toBe(0);
          expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage), `${branch.id} exact KVL voltage`).toBe(0);
          assertCorrectRounding(reading.currentAmps, current, `${branch.id} current`);
          assertCorrectRounding(reading.voltageVolts, voltage, `${branch.id} voltage`);
          assertCorrectRounding(reading.powerWatts, multiply(voltage, branch.cell ? negate(current) : current), `${branch.id} power`);
        }
      }
      if (branch.cell) {
        const returned = solve(value.branches.filter((edge) => !edge.cell), { a: branch.a, b: branch.b });
        expect(compare(subtract(returned.voltage(branch.a), returned.voltage(branch.b)), threshold),
          "individual passive return is not a local short").toBe(1);
      }
    }
  });
});
