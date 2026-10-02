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
  outputSign: 0 | 1;
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

function mixed(value: Fixture, index: number, reversedOrder: boolean) {
  const first = `c${index}-3`;
  const second = `c${index}-2`;
  cell(value, first, 3);
  cell(value, second, 2);
  resistor(value, `local3-${index}`, `${first}:a`, `${first}:b`, 0.003);
  resistor(value, `local2-${index}`, `${second}:a`, `${second}:b`, 0.003);
  if (reversedOrder) {
    wire(value, `${second}:a`, `${first}:a`);
    return { p: `${second}:b`, n: `${first}:b` };
  }
  wire(value, `${first}:b`, `${second}:b`);
  return { p: `${first}:a`, n: `${second}:a` };
}

const cases: Fixture[] = [];

// Eight 3-2 V columns with private shunts, different original cell ordering,
// two/three drivers and weak outer hubs or inter-column links.
for (const topology of ["P", "N", "both", "direct"] as const) {
  for (const load of [0.0001, 0.0012]) {
    const value = fixture(`mixed 3-2 V ${topology} load=${load}`, load < 0.001 ? "short" : "closed");
    resistor(value, "load", "P:a", "N:a", load, true);
    const count = topology === "both" ? 3 : 2;
    const weak = topology === "P" || topology === "direct" ? 1000 : 1e100;
    const ends = Array.from({ length: count }, (_, index) => mixed(value, index, index % 2 === 1));
    for (const side of ["p", "n"] as const) {
      const boundary = side === "p" ? "P:a" : "N:a";
      const coupled = topology === "both" || topology.toLowerCase() === side;
      const hub = coupled ? junction(value, `X${side}`) : "";
      for (const [index, end] of ends.entries()) {
        resistor(value, `ballast${side}${index}`, end[side], boundary, 0.0007);
        if (coupled) { resistor(value, `weak${side}${index}`, end[side], hub, weak); }
      }
      if (coupled) { resistor(value, `hub${side}`, hub, boundary, weak); }
      if (topology === "direct") { resistor(value, `bridge${side}`, ends[0][side], ends[1][side], weak); }
    }
    cases.push(value);
  }
}

// Six two-stage connector meshes retain known disjoint driver routes. Add
// horizontal, diagonal and optional cross-side edges without deleting any
// conductor in the actual port experiment.
for (const mode of ["ladder", "diagonal", "crossed"] as const) {
  for (const load of [0.0001, 0.0012]) {
    const value = fixture(`connector mesh ${mode} load=${load}`, load < 0.001 ? "short" : "closed");
    resistor(value, "load", "P:a", "N:a", load, true);
    for (let index = 0; index < 2; index += 1) { cell(value, `s${index}`, 1); }
    for (const side of ["P", "N"] as const) {
      for (let index = 0; index < 2; index += 1) {
        const u = junction(value, `U${side}${index}`);
        const v = junction(value, `V${side}${index}`);
        const end = `s${index}:${side === "P" ? "a" : "b"}`;
        resistor(value, `inner${side}${index}`, end, u, 0.0002);
        resistor(value, `middle${side}${index}`, u, v, 0.0002);
        resistor(value, `outer${side}${index}`, v, `${side}:a`, 0.0003);
      }
      resistor(value, `upper${side}`, `U${side}0:a`, `U${side}1:a`, 1000);
      resistor(value, `lower${side}`, `V${side}0:a`, `V${side}1:a`, 1e100);
      if (mode !== "ladder") {
        resistor(value, `diagonal${side}0`, `U${side}0:a`, `V${side}1:a`, 0.002);
        resistor(value, `diagonal${side}1`, `U${side}1:a`, `V${side}0:a`, 0.002);
      }
    }
    if (mode === "crossed") {
      resistor(value, "cross0", "UP0:a", "VN1:a", 0.005);
      resistor(value, "cross1", "UN0:a", "VP1:a", 0.005);
    } else {
      const first = add(input(0.0002), multiply(two, lead));
      const middle = mode === "ladder" ? first : parallel(first, add(input(0.002), multiply(two, lead)));
      value.closedForm = sum([first, middle, add(input(0.0003), multiply(two, lead)), add(input(load), multiply(two, lead))]);
    }
    cases.push(value);
  }
}

// Four near-threshold circuits: shared positive/negative wires are genuine
// series 1 µΩ terms and do not belong to either driver's parallel ballast.
for (const sharedNegative of [false, true]) {
  for (const load of [0.000_293, 0.000_296]) {
    const value = fixture(`shared physical leads negative=${sharedNegative} load=${load}`, load === 0.000_293 ? "short" : "closed");
    const p = junction(value, "sharedP");
    const n = sharedNegative ? junction(value, "sharedN") : "N:a";
    wire(value, p, "P:a");
    if (sharedNegative) { wire(value, n, "N:a"); }
    const loadR = resistor(value, "load", "P:a", "N:a", load, true);
    for (let index = 0; index < 2; index += 1) {
      cell(value, `s${index}`, 1);
      resistor(value, `p${index}`, `s${index}:a`, p, 0.0007);
      resistor(value, `n${index}`, `s${index}:b`, n, 0.0007);
    }
    value.closedForm = sum([add(input(0.0007), multiply(two, lead)), lead, sharedNegative ? lead : zero, loadR]);
    cases.push(value);
  }
}

// Four mixed-source partial cuts with two interior load junctions. Private
// shunts expose both raw-cell and reduced-string discovery for the same IDs.
// ID ordering varies independently of insertion and case execution ordering.
for (const rename of [false, true]) {
  for (const other of [0.0004, 0.003]) {
    const value = fixture(`raw/reduced multi-cut rename=${rename} alternate=${other}`, other === 0.0004 ? "short" : "closed");
    const j = junction(value, "J");
    const k = junction(value, "K");
    const a = resistor(value, "loadA", "P:a", j, 0.000_15, true);
    const b = resistor(value, "loadB", j, k, 0.000_075, true);
    const c = resistor(value, "loadC", k, "N:a", 0.000_075, true);
    const tap = resistor(value, "loadTap", "P:a", j, 0.03, true);
    const alternate = resistor(value, "loadOther", "P:a", "N:a", other, true);
    const ends = [mixed(value, 0, false), mixed(value, 1, true)];
    for (const [index, end] of ends.entries()) {
      resistor(value, `p${index}`, "P:a", end.p, 0.0015);
      resistor(value, `n${index}`, end.n, "N:a", 0.000_05);
    }
    for (const side of ["p", "n"] as const) { resistor(value, `weak${side}`, ends[0][side], ends[1][side], 1000); }
    const source = divide(sum([input(0.0015), input(0.000_05), multiply(rational(5n), lead)]), two);
    value.closedForm = add(source, parallel(sum([parallel(a, tap), b, c]), alternate));
    value.partial = other === 0.003;
    if (rename) {
      const renamed = (id: string) => id.startsWith("c0") ? id.replace("c0", "z") : id.startsWith("c1") ? id.replace("c1", "a") : id;
      for (const item of value.document.parts) { item.id = renamed(item.id); }
      for (const edge of value.document.wires) {
        edge.from.partId = renamed(edge.from.partId);
        edge.to.partId = renamed(edge.to.partId);
      }
      for (const branch of value.branches) {
        branch.a = branch.a.split(":").map((text, index) => index === 0 ? renamed(text) : text).join(":");
        branch.b = branch.b.split(":").map((text, index) => index === 0 ? renamed(text) : text).join(":");
        if (branch.id) { branch.id = renamed(branch.id); }
      }
    }
    cases.push(value);
  }
}

// Three crossed-tap limits: exact zero is closed with safe local returns;
// exact zero still leaves a real local short; one binary64 ULP of asymmetry
// creates a strictly nonzero Voc and must not be swallowed by a tolerance.
for (const mode of ["zero-safe", "zero-local-short", "tiny"] as const) {
  const value = fixture(`exact crossed limit ${mode}`, mode === "zero-safe" ? "closed" : "short");
  const ballast = mode === "zero-local-short" ? 0.0008 : 0.0012;
  const tap = mode === "tiny" ? nextUp(ballast) : ballast;
  value.outputSign = mode === "tiny" ? 1 : 0;
  value.localShort = mode === "zero-local-short";
  resistor(value, "load", "P:a", "N:a", 0.0001, true);
  for (let index = 0; index < 2; index += 1) {
    cell(value, `s${index}`, 1);
    resistor(value, `p${index}`, "P:a", `s${index}:a`, ballast);
    resistor(value, `n${index}`, `s${index}:b`, "N:a", ballast);
    resistor(value, `tapP${index}`, `s${index}:a`, "N:a", tap);
    resistor(value, `tapN${index}`, "P:a", `s${index}:b`, tap);
  }
  const hub = junction(value, "X");
  resistor(value, "weak0", "s0:a", hub, 1e100);
  resistor(value, "weak1", "s1:a", hub, 1e100);
  resistor(value, "weakN", "s0:b", "s1:b", 1000);
  value.closedForm = add(add(input(0.0001), multiply(two, lead)), parallel(
    add(input(ballast), multiply(two, lead)), add(input(tap), multiply(two, lead))));
  cases.push(value);
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

describe("source boundaries against an independent port oracle", () => {
  it.each(cases)("$document.title", (value) => {
    const response = port(value);
    expect(compare(response.v, zero), "independent exact Voc sign").toBe(value.outputSign);
    if (value.closedForm) { expect(compare(response.r, value.closedForm), "closed form equals independent KCL port response").toBe(0); }
    if (!value.localShort) {
      expect(value.outputSign !== 0 && compare(response.r, threshold) < 0 ? "short" : "closed", "independently certified complete load").toBe(value.expectedStatus);
    }
    if (value.partial) {
      const cut = port(value, "P:a", "J:a", value.branches.filter((branch) => branch.id === "loadA" || branch.id === "loadTap"));
      expect(compare(cut.r, threshold), "tempting partial cut is below threshold").toBe(-1);
      expect(compare(cut.v, zero), "partial cut has a nonzero Voc").toBe(1);
      expect(compare(response.r, threshold), "complete load remains above threshold").toBe(1);
    }
    const expected = solve(value.branches);
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
        const returned = solve(value.branches.filter((edge) => !edge.cell), { a: branch.a, b: branch.b });
        const local = subtract(returned.voltage(branch.a), returned.voltage(branch.b));
        expect(compare(local, threshold), "local passive return tested separately from common Voc").toBe(value.localShort ? -1 : 1);
        expect(current.numerator, "cell remains locally active at exact zero common Voc").not.toBe(0n);
      }
    }
    expect([...kcl.values()].every((current) => current.numerator === 0n), "exact node conservation").toBe(true);
    expect(power.numerator, "exact energy conservation including all 1 µΩ wires").toBe(0n);
    const results = [analyzeCircuit(value.document), analyzeCircuit(reversed(value))];
    for (const actual of results) {
      for (const [index, branch] of value.branches.entries()) {
        const current = expected.currents[index];
        if (branch.id) {
          const reading = actual.parts[branch.id];
          const voltage = branch.cell ? add(branch.e, multiply(branch.r, current)) : multiply(branch.partR!, current);
          expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${branch.id} exact current`).toBe(0);
          expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage), `${branch.id} exact voltage`).toBe(0);
          assertCorrectRounding(reading.currentAmps, current, `${branch.id} current`);
          assertCorrectRounding(reading.voltageVolts, voltage, `${branch.id} voltage`);
          assertCorrectRounding(reading.powerWatts, multiply(voltage, branch.cell ? negate(current) : current), `${branch.id} power`);
        }
        for (const id of branch.wires) { assertCorrectRounding(actual.wireCurrents[id], current, `${id} current (physical lead)`); }
      }
    }
    expect(results.map((actual) => actual.status), value.document.title).toEqual([value.expectedStatus, value.expectedStatus]);
  });
});
