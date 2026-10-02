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
const parallel = (a: Rational, b: Rational) => divide(multiply(a, b), add(a, b));
function exactReading(retained: CircuitExactComplex | undefined, scalar: number) {
  if (!retained) { return input(scalar); }
  if (!("numerator" in retained.real)) { throw new Error("Unexpected non-rational DC reading"); }
  const text = retained.real.numerator;
  return rational(text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text), BigInt(retained.real.denominator));
}

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
  external: Rational;
  sign: -1 | 0 | 1;
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(value: string): CircuitEndpoint {
  const [partId, terminal] = value.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown terminal ${value}`); }
  return { partId, terminal };
}

function wire(value: Fixture, a: string, b: string) {
  value.document.wires.push({ id: `w${value.document.wires.length}`, from: endpoint(a), to: endpoint(b) });
}

function resistor(value: Fixture, id: string, a: string, b: string, resistance: number, load = false) {
  value.document.parts.push(part(id, "resistor", { resistanceOhms: resistance }));
  wire(value, a, `${id}:a`);
  wire(value, `${id}:b`, b);
  const r = add(input(resistance), multiply(rational(2n), lead));
  value.branches.push({ a, b, r, e: zero, id, partR: input(resistance), load });
  return r;
}

function cell(value: Fixture, id: string) {
  value.document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
  value.branches.push({ a: `${id}:a`, b: `${id}:b`, r: input(0.1), e: one, id, cell: true });
}

// Independent branch-current KCL/KVL: Va - Vb - R*I = E.
// Zero-R sources remain voltage constraints, including in port experiments.
// Untapped resistor interiors are eliminated with both physical wires kept.
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

const cases: Fixture[] = [];
for (const side of ["P", "N", "both"]) {
  for (const scenario of [
    { r: 0.0015, tap: 0.002, load: 0.0001 },
    { r: 0.0015, tap: 0.0008, load: 0.0003 },
    { r: 0.0012, tap: nextUp(0.0012), load: 0.0001 },
    { r: 0.0012, tap: 0.0012, load: 0.0001 },
  ]) {
    const value: Fixture = {
      document: { title: `Coupled crossed output ${side} ${JSON.stringify(scenario)}`, parts: [], wires: [] },
      branches: [], external: zero, sign: 0,
    };
    value.document.parts.push(part("P", "junction"), part("N", "junction"));
    const load = resistor(value, "load", "P:a", "N:a", scenario.load, true);
    for (let index = 0; index < 2; index += 1) {
      const id = `c${index}`;
      cell(value, id);
      resistor(value, `p${index}`, "P:a", `${id}:a`, scenario.r);
      resistor(value, `n${index}`, `${id}:b`, "N:a", scenario.r);
      resistor(value, `a${index}`, `${id}:a`, "N:a", scenario.tap);
      resistor(value, `b${index}`, "P:a", `${id}:b`, scenario.tap);
    }
    if (side !== "N") { resistor(value, "bridgeP", "c0:a", "c1:a", 1000); }
    if (side !== "P") { resistor(value, "bridgeN", "c0:b", "c1:b", 1000); }
    const r = add(input(scenario.r), multiply(rational(2n), lead));
    const tap = add(input(scenario.tap), multiply(rational(2n), lead));
    value.external = add(load, parallel(r, tap));
    value.sign = compare(tap, r);
    cases.push(value);
  }
}

// Connected private returns and compound strings must not be rejected merely
// because the source side contains a passive path between the output ports.
// Source-string metadata preserves the opposing-terminal series connection.
for (const length of [1, 2]) {
  for (const load of [0.0001, 0.0012]) {
    for (const weak of [1000, 1e100]) {
      const value: Fixture = {
        document: { title: `Coupled private shunts length=${length} load=${load} bridge=${weak}`, parts: [], wires: [] },
        branches: [], external: zero, sign: 1,
      };
      value.document.parts.push(part("P", "junction"), part("N", "junction"));
      const loadR = resistor(value, "load", "P:a", "N:a", load, true);
      let source = zero;
      for (let branch = 0; branch < 2; branch += 1) {
        for (let position = 0; position < length; position += 1) {
          cell(value, `c${branch}-${position}`);
          resistor(value, `shunt${branch}-${position}`, `c${branch}-${position}:a`, `c${branch}-${position}:b`, 0.003);
          if (position > 0) {
            const a = `c${branch}-${position - 1}:b`;
            const b = `c${branch}-${position}:a`;
            wire(value, a, b);
            value.branches.push({ a, b, r: lead, e: zero });
          }
        }
        const p = resistor(value, `p${branch}`, "P:a", `c${branch}-0:a`, 0.0007);
        const n = resistor(value, `n${branch}`, `c${branch}-${length - 1}:b`, "N:a", 0.0007);
        source = add(add(p, n), multiply(rational(BigInt(length - 1)), lead));
      }
      resistor(value, "bridgeP", "c0-0:a", "c1-0:a", weak);
      resistor(value, "bridgeN", `c0-${length - 1}:b`, `c1-${length - 1}:b`, weak);
      value.external = add(loadR, divide(source, rational(2n)));
      cases.push(value);
    }
  }
}

describe("independent common-output boundary certification", () => {
  it.each(cases)("$document.title", (value) => {
    const sources = value.branches.filter((branch) => !branch.load);
    const ideal = sources.map((branch) => branch.cell ? { ...branch, r: zero } : branch);
    const open = solve(ideal);
    const suppressed = solve(ideal.map((branch) => ({ ...branch, e: zero })), { a: "P:a", b: "N:a" });
    const load = value.branches.find((branch) => branch.load)!;
    const resistance = add(subtract(suppressed.voltage("P:a"), suppressed.voltage("N:a")), load.r);
    const emf = subtract(open.voltage("P:a"), open.voltage("N:a"));
    expect(compare(resistance, value.external), "closed form equals independent port KCL").toBe(0);
    expect(compare(emf, zero), "positive, inverted, tiny and zero output EMFs").toBe(value.sign);
    const status = value.sign !== 0 && compare(resistance, threshold) < 0 ? "short" : "closed";
    const actual = analyzeCircuit(value.document);
    const expected = solve(value.branches);
    expect(actual.status, value.document.title).toBe(status);
    // Reorder and reverse every physical edge, without changing the circuit.
    const reordered = analyzeCircuit({ ...value.document, parts: [...value.document.parts].reverse(),
      wires: [...value.document.wires].reverse().map((edge) => ({ ...edge, from: edge.to, to: edge.from })) });
    expect(reordered.status).toBe(status);
    for (const [index, branch] of value.branches.entries()) {
      const current = expected.currents[index];
      if (branch.id) {
        const voltage = branch.cell ? add(branch.e, multiply(branch.r, current)) : multiply(branch.partR!, current);
        for (const result of [actual, reordered]) {
          const reading = result.parts[branch.id];
          expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current)).toBe(0);
          expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage)).toBe(0);
          assertCorrectRounding(reading.currentAmps, current, `${branch.id} KCL current`);
          assertCorrectRounding(reading.voltageVolts, voltage, `${branch.id} KVL voltage`);
          assertCorrectRounding(reading.powerWatts, multiply(voltage, branch.cell ? negate(current) : current), `${branch.id} power`);
        }
      }
      if (branch.cell) {
        const returned = solve(value.branches.filter((edge) => !edge.cell), { a: branch.a, b: branch.b });
        expect(compare(subtract(returned.voltage(branch.a), returned.voltage(branch.b)), threshold),
          `${branch.id} individual passive return stays above threshold`).toBe(1);
      }
      if (branch.id?.startsWith("bridge")) {
        expect(current.numerator, "coupling is an exact null-current perturbation").toBe(0n);
      }
    }
  });
});
