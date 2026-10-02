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
  wires: string[];
}

interface Fixture {
  document: CircuitDocument;
  branches: Branch[];
  expectedStatus: "short" | "closed";
  outputSign: -1 | 0 | 1;
  closedForm?: Rational;
  partial?: boolean;
  localShort?: boolean;
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function fixture(title: string, expectedStatus: Fixture["expectedStatus"]): Fixture {
  return {
    document: { title, parts: [part("P", "junction"), part("N", "junction")], wires: [] },
    branches: [], expectedStatus, outputSign: 1,
  };
}

function junction(value: Fixture, id: string) {
  value.document.parts.push(part(id, "junction"));
  return `${id}:a`;
}

function endpoint(text: string): CircuitEndpoint {
  const [partId, terminal] = text.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown terminal ${text}`); }
  return { partId, terminal };
}

function rawWire(value: Fixture, a: string, b: string) {
  const id = `w${value.document.wires.length}`;
  value.document.wires.push({ id, from: endpoint(a), to: endpoint(b) });
  return id;
}

function wire(value: Fixture, a: string, b: string) {
  value.branches.push({ a, b, r: lead, e: zero, wires: [rawWire(value, a, b)] });
}

function resistor(value: Fixture, id: string, a: string, b: string, resistance: number, load = false) {
  value.document.parts.push(part(id, "resistor", { resistanceOhms: resistance }));
  const r = add(input(resistance), multiply(two, lead));
  // These interiors have no taps: eliminate exactly both physical leads.
  value.branches.push({ a, b, r, e: zero, id, partR: input(resistance), load,
    wires: [rawWire(value, a, `${id}:a`), rawWire(value, `${id}:b`, b)] });
  return r;
}

function cell(value: Fixture, id: string, voltage: number) {
  value.document.parts.push(part(id, "battery", { voltageVolts: voltage, internalResistanceOhms: 0.1 }));
  value.branches.push({ a: `${id}:a`, b: `${id}:b`, r: input(0.1), e: input(voltage), id, cell: true, wires: [] });
}

// Independent rational branch-current MNA. KCL is incidence; each KVL row
// is Va - Vb - R*I = E. Ideal selected cells remain voltage constraints.
// Separate disconnected components each receive exactly one reference.
function solve(branches: readonly Branch[], injection?: { a: string; b: string }) {
  const nodes = [...new Set(branches.flatMap((branch) => [branch.a, branch.b]))];
  const adjacent = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const branch of branches) {
    adjacent.get(branch.a)!.push(branch.b);
    adjacent.get(branch.b)!.push(branch.a);
  }
  const roots = new Map<string, string>();
  for (const root of nodes) {
    if (roots.has(root)) { continue; }
    roots.set(root, root);
    const queue = [root];
    for (const node of queue) {
      for (const next of adjacent.get(node)!) {
        if (!roots.has(next)) { roots.set(next, root); queue.push(next); }
      }
    }
  }
  if (injection && (!roots.has(injection.a) || roots.get(injection.a) !== roots.get(injection.b))) {
    throw new Error("Independent port is disconnected");
  }
  const positions = new Map(nodes.filter((node) => roots.get(node) !== node).map((node, index) => [node, index]));
  const count = positions.size + branches.length;
  const rows = Array.from({ length: count }, () => Array.from({ length: count + 1 }, () => zero));
  const stamp = (row: number | undefined, column: number | undefined, value: Rational) => {
    if (row !== undefined && column !== undefined) { rows[row][column] = add(rows[row][column], value); }
  };
  for (const [index, branch] of branches.entries()) {
    const current = positions.size + index;
    const a = positions.get(branch.a);
    const b = positions.get(branch.b);
    stamp(a, current, one);
    stamp(b, current, negate(one));
    stamp(current, a, one);
    stamp(current, b, negate(one));
    stamp(current, current, negate(branch.r));
    rows[current][count] = branch.e;
  }
  if (injection) {
    stamp(positions.get(injection.a), count, one);
    stamp(positions.get(injection.b), count, negate(one));
  }
  for (let column = 0; column < count; column += 1) {
    const pivot = rows.findIndex((row, index) => index >= column && row[column].numerator !== 0n);
    if (pivot < 0) { throw new Error(`Independent singular matrix at ${column}`); }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= count; item += 1) { rows[column][item] = divide(rows[column][item], divisor); }
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
    solution[row] = subtract(rows[row][count], sum(solution.slice(row + 1)
      .map((value, index) => multiply(rows[row][row + index + 1], value))));
  }
  return {
    voltage: (node: string) => positions.has(node) ? solution[positions.get(node)!] : zero,
    currents: solution.slice(positions.size),
  };
}

function port(value: Fixture, a = "P:a", b = "N:a", loads = value.branches.filter((branch) => branch.load)) {
  const ideal = value.branches.filter((branch) => !loads.includes(branch))
    .map((branch) => branch.cell ? { ...branch, r: zero } : branch);
  const open = solve(ideal);
  const suppressed = solve(ideal.map((branch) => ({ ...branch, e: zero })), { a, b });
  const passive = solve(loads, { a, b });
  return {
    r: add(subtract(suppressed.voltage(a), suppressed.voltage(b)), subtract(passive.voltage(a), passive.voltage(b))),
    v: subtract(open.voltage(a), open.voltage(b)),
  };
}

// Deliberately keep discovery separate from this physical branch-current
// oracle: all selected ideal cells, original paired terminals and real leads
// participate in the independent output experiment.
interface Options {
  order?: number[];
  stages?: number;
  other?: number;
  sameResistance?: number;
  tap?: number;
}

function mixedLoad(title: string, options: Options = {}) {
  const order = options.order ?? [3, -2];
  const other = options.other ?? 0.0004;
  const value = fixture(title, other === 0.0004 ? "short" : "closed");
  value.outputSign = sum(order.map(input)).numerator > 0n ? 1 : -1;
  const count = options.stages ?? 3;
  const segments: Rational[] = [];
  const nodes = ["P:a", ...Array.from({ length: count - 1 }, (_, index) => junction(value, `J${index}`)), "N:a"];
  for (let index = 0; index < count; index += 1) {
    segments.push(resistor(value, `load${index}`, nodes[index], nodes[index + 1],
      options.sameResistance ?? (index === 0 ? 0.000_15 : 0.000_15 / (count - 1)), true));
  }
  const tapLoad = resistor(value, "loadTap", nodes[0], nodes[1], 0.03, true);
  const alternate = resistor(value, "loadOther", "P:a", "N:a", options.sameResistance ?? other, true);
  const ends: { p: string; n: string; mid: string }[] = [];
  for (let column = 0; column < 2; column += 1) {
    const signed = column === 0 ? order : [...order].reverse();
    const cells = signed.map((voltage, position) => {
      // IDs deliberately sort against source column and cell insertion order.
      const id = `${column === 0 ? "z" : "a"}${position}`;
      cell(value, id, Math.abs(voltage));
      resistor(value, `local${column}-${position}`, `${id}:a`, `${id}:b`, 0.003);
      return { start: `${id}:${voltage > 0 ? "a" : "b"}`, end: `${id}:${voltage > 0 ? "b" : "a"}` };
    });
    wire(value, cells[0].end, cells[1].start);
    ends.push({ p: cells[0].start, n: cells[1].end, mid: cells[0].end });
  }
  const p = options.sameResistance ?? 0.0015;
  const n = options.sameResistance ?? 0.000_05;
  for (const [index, end] of ends.entries()) {
    resistor(value, `p${index}`, "P:a", end.p, p);
    resistor(value, `n${index}`, end.n, "N:a", n);
  }
  for (const side of ["p", "n"] as const) { resistor(value, `weak${side}`, ends[0][side], ends[1][side], 1000); }
  if (options.tap !== undefined) {
    // Both output searches can encounter a wrong series midpoint first.
    // These paths must propose roots without replacing the paired string.
    resistor(value, "rootChoiceP", "P:a", ends[0].mid, options.tap);
    resistor(value, "rootChoiceN", "N:a", ends[1].mid, options.tap);
    value.document.parts.reverse();
    value.document.wires.reverse();
  } else {
    const source = divide(sum([input(p), input(n), multiply(rational(5n), lead)]), two);
    value.closedForm = add(source, parallel(sum([parallel(segments[0], tapLoad), ...segments.slice(1)]), alternate));
  }
  if (options.sameResistance !== undefined) {
    value.expectedStatus = options.sameResistance < 0.001 ? "short" : "closed";
  }
  return value;
}

const cases: Fixture[] = [];
for (const order of [[3, -2], [-2, 3], [2, -3], [-3, 2]]) {
  for (const other of [0.0004, 0.003]) {
    cases.push(mixedLoad(`mixed column order=${order} alternate=${other}`, { order, other }));
  }
}
for (const stages of [2, 4]) {
  for (const other of [0.0004, 0.003]) {
    cases.push(mixedLoad(`isolated actual outputs stages=${stages} alternate=${other}`, { stages, other }));
  }
}
for (const sameResistance of [0.000_15, 0.0012]) {
  cases.push(mixedLoad(`same ballast and load resistance=${sameResistance}`, { sameResistance }));
}
for (const tap of [1000, 1e100]) {
  for (const other of [0.0004, 0.003]) {
    cases.push(mixedLoad(`multiple physical root choices tap=${tap} alternate=${other}`, { tap, other }));
  }
}

function exactReading(retained: CircuitExactComplex | undefined, scalar: number) {
  if (!retained) { return input(scalar); }
  if (!("numerator" in retained.real)) { throw new Error("Expected an exact DC rational"); }
  const numerator = retained.real.numerator;
  return rational(numerator.startsWith("-") ? -BigInt(numerator.slice(1)) : BigInt(numerator), BigInt(retained.real.denominator));
}

function reversed(value: Fixture): CircuitDocument {
  const twoTerminal = new Set(value.document.parts.filter((item) => item.kind !== "junction").map((item) => item.id));
  const flip = (end: CircuitEndpoint): CircuitEndpoint => twoTerminal.has(end.partId)
    ? { ...end, terminal: end.terminal === "a" ? "b" : "a" } : { ...end };
  // Reverse all cell polarities together, plus every resistor and wire.
  // Logical node voltages change sign while each part's A/B reading stays.
  return { ...value.document, parts: [...value.document.parts].reverse(),
    wires: [...value.document.wires].reverse().map((edge) => ({ ...edge, from: flip(edge.to), to: flip(edge.from) })) };
}

describe("source discovery against an independent port oracle", () => {
  it.each(cases)("$document.title", (value) => {
    const response = port(value);
    expect(compare(response.v, zero), "independent open-output polarity").toBe(value.outputSign);
    if (value.closedForm) {
      expect(compare(response.r, value.closedForm), "closed form equals independent KCL response").toBe(0);
      expect(compare(response.v, input(value.outputSign)), "mixed string exact EMF").toBe(0);
    }
    expect(compare(response.r, threshold) < 0 ? "short" : "closed", "complete common load").toBe(value.expectedStatus);
    const expected = solve(value.branches);
    const results = [analyzeCircuit(value.document), analyzeCircuit(reversed(value))];
    const kcl = new Map<string, Rational>();
    let power = zero;
    for (const [index, branch] of value.branches.entries()) {
      const current = expected.currents[index];
      kcl.set(branch.a, add(kcl.get(branch.a) ?? zero, current));
      kcl.set(branch.b, subtract(kcl.get(branch.b) ?? zero, current));
      const drop = add(branch.e, multiply(branch.r, current));
      expect(compare(subtract(expected.voltage(branch.a), expected.voltage(branch.b)), drop), "oracle KVL").toBe(0);
      power = add(power, multiply(drop, current));
      if (branch.cell) {
        const local = solve(value.branches.filter((edge) => !edge.cell), { a: branch.a, b: branch.b });
        expect(compare(subtract(local.voltage(branch.a), local.voltage(branch.b)), threshold), "no individual passive short").toBe(1);
      }
      for (const result of results) {
        if (branch.id) {
          const reading = result.parts[branch.id];
          const voltage = branch.cell ? drop : multiply(branch.partR!, current);
          expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${branch.id} exact current`).toBe(0);
          expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage), `${branch.id} exact voltage`).toBe(0);
          assertCorrectRounding(reading.currentAmps, current, `${branch.id} current`);
          assertCorrectRounding(reading.voltageVolts, voltage, `${branch.id} voltage`);
          assertCorrectRounding(reading.powerWatts, multiply(voltage, branch.cell ? negate(current) : current), `${branch.id} power`);
        }
        for (const id of branch.wires) { assertCorrectRounding(result.wireCurrents[id], current, `${id} physical current`); }
      }
    }
    expect([...kcl.values()].every((current) => current.numerator === 0n), "exact KCL").toBe(true);
    expect(power.numerator, "exact energy conservation including every physical wire").toBe(0n);
    expect(results.map((result) => result.status), value.document.title).toEqual([value.expectedStatus, value.expectedStatus]);
  });
});
