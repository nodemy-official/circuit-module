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

const cases: Fixture[] = [];
interface Proof {
  bridgeCurrent?: boolean;
  nonzeroCellCurrent?: boolean;
  cellCurrent?: Rational;
  cut?: { r: Rational; v: Rational };
}
const checks = new Map<Fixture, Proof>();

function markPort(value: Fixture, resistance: Rational, sign: -1 | 0 | 1 = 1) {
  value.external = resistance;
  value.outputSign = sign;
  value.status = sign !== 0 && compare(resistance, threshold) < 0 ? "short" : "closed";
}

function bridges(value: Fixture, side: string, positive = 0.0007, negative = 0.0009) {
  if (side !== "N") { resistor(value, "bridgeP", "s0:a", "s1:a", positive); }
  if (side !== "P") { resistor(value, "bridgeN", "s0:b", "s1:b", negative); }
}

// Independent two-node Wheatstone reduction with selected cell resistances
// removed. With a 1 V test port, A*z0-h*z1=gP0 and B*z1-h*z0=gP1.
// This closed form is checked against branch-current KCL/KVL, never against
// a production resistance or arithmetic helper.
function bridgedPort(p0: Rational, n0: Rational, p1: Rational, n1: Rational, links: readonly Rational[]) {
  const gp0 = divide(one, p0);
  const gn0 = divide(one, n0);
  const gp1 = divide(one, p1);
  const gn1 = divide(one, n1);
  const h = sum(links.map((link) => divide(one, link)));
  const a = sum([gp0, gn0, h]);
  const b = sum([gp1, gn1, h]);
  const determinant = subtract(multiply(a, b), multiply(h, h));
  const z0 = divide(add(multiply(b, gp0), multiply(h, gp1)), determinant);
  const z1 = divide(add(multiply(h, gp0), multiply(a, gp1)), determinant);
  return divide(one, add(multiply(gp0, subtract(one, z0)), multiply(gp1, subtract(one, z1))));
}

// Six exact-zero same-side bridges, including a negative-side-only bridge.
// Adjacent representable load values straddle the exact physical-wire-aware
// threshold, without a floating-point tolerance.
for (const side of ["P", "N", "both"]) {
  for (const load of [nextDown(0.000_221), nextUp(0.000_221)]) {
    const value = fixture(`balanced boundary ${side} load=${load}`, load);
    const r0 = simple(value, "s0", 0.0015, 0.000_05);
    const r1 = simple(value, "s1", 0.0015, 0.000_05);
    bridges(value, side, 1000, 1000);
    value.zeroLinks = side === "both" ? ["bridgeP", "bridgeN"] : [side === "P" ? "bridgeP" : "bridgeN"];
    markPort(value, add(add(input(load), multiply(two, lead)), parallel(r0, r1)));
    cases.push(value);
  }
}

// Six nonzero-current unequal Wheatstone bridges, both sides and each side.
// Explicit analytic resistance agrees exactly with the independent KCL solve.
for (const side of ["P", "N", "both"]) {
  for (const load of [0.000_05, 0.000_35]) {
    const value = fixture(`unequal bridge ${side} load=${load}`, load, true);
    simple(value, "s0", 0.0015, 0.000_05, 0.1);
    simple(value, "s1", 0.0021, 0.000_09, 1000);
    bridges(value, side);
    const links = value.branches.filter((branch) => branch.id?.startsWith("bridge")).map((branch) => branch.r);
    const r = bridgedPort(
      add(input(0.0015), multiply(two, lead)), add(input(0.000_05), multiply(two, lead)),
      add(input(0.0021), multiply(two, lead)), add(input(0.000_09), multiply(two, lead)), links,
    );
    markPort(value, add(input(load), r));
    checks.set(value, { bridgeCurrent: true });
    cases.push(value);
  }
}

// Four joined, symmetrically crossed source networks: exact zero Voc does
// not imply zero local cell current. Private return tests remain separate.
for (const side of ["P", "both"]) {
  for (const ballast of [0.0012, 0.0008]) {
    const value = fixture(`joined crossed zero-output ${side} r=${ballast}`, 0.0001, true);
    for (let index = 0; index < 2; index += 1) {
      const id = `s${index}`;
      cell(value, id, 1);
      resistor(value, `p${index}`, value.p, `${id}:a`, ballast);
      resistor(value, `n${index}`, `${id}:b`, value.n, ballast);
      resistor(value, `tapA${index}`, `${id}:a`, value.n, ballast);
      resistor(value, `tapB${index}`, value.p, `${id}:b`, ballast);
    }
    bridges(value, side, 0.01, 0.01);
    markPort(value, add(input(0.0001), divide(add(input(ballast), multiply(two, lead)), two)), 0);
    value.status = ballast === 0.0008 ? "short" : "closed";
    value.zeroLinks = side === "both" ? ["bridgeP", "bridgeN"] : ["bridgeP"];
    cases.push(value);
  }
}

// Four series-connected cells with separate local loads and weak side links.
// No common load is established by equal EMFs or graph connectivity alone.
for (const side of ["P", "both"]) {
  for (const reorder of [false, true]) {
    const value = fixture(`series with private loads ${side} reorder=${reorder}`);
    cell(value, "s0", 1);
    cell(value, "s1", 1);
    wire(value, "s0:b", "s1:a");
    resistor(value, "local0", "s0:a", "s0:b", 0.0014);
    resistor(value, "local1", "s1:a", "s1:b", 0.0014);
    bridges(value, side, 0.01, 0.01);
    if (reorder) { value.document.parts.reverse(); value.document.wires.reverse(); }
    checks.set(value, { nonzeroCellCurrent: true });
    cases.push(value);
  }
}

// Four common passive loads with an internal degree-three node, producing
// multiple cuts. The complete source-to-load two-terminal reduction is
// Rs + (((Ra || Rtap) + Rb) || Rother). Every wire is retained.
// The large tap and alternate common load must not turn a partial load into
// a private shunt inside the source macro and lower the short metric.
for (const other of [0.0004, 0.003]) {
  for (const reorder of [false, true]) {
    const value = fixture(`multiple load cuts other=${other} reorder=${reorder}`);
    value.document.parts.push(part("J", "junction"));
    const r0 = simple(value, "s0", 0.0015, 0.000_05);
    const r1 = simple(value, "s1", 0.0015, 0.000_05);
    bridges(value, "both", 1000, 1000);
    const a = resistor(value, "loadA", value.p, "J:a", 0.000_15, true);
    const b = resistor(value, "loadB", "J:a", value.n, 0.000_15, true);
    const tap = resistor(value, "loadTap", value.p, "J:a", 0.03, true);
    const alternate = resistor(value, "loadOther", value.p, value.n, other, true);
    const source = parallel(r0, r1);
    const first = parallel(a, tap);
    const loads = parallel(add(first, b), alternate);
    markPort(value, add(source, loads));
    value.zeroLinks = ["bridgeP", "bridgeN"];
    // I=-1/(ri+ballast+2*Rload); the alternative cut is
    // (Rs || Rother) + Rb + (Ra || Rtap), Voc=Rother/(Rs+Rother).
    checks.set(value, {
      cellCurrent: negate(divide(one, sum([input(0.1), r0, multiply(two, loads)]))),
      cut: {
        r: sum([parallel(source, alternate), b, first]),
        v: divide(alternate, add(source, alternate)),
      },
    });
    if (reorder) { value.document.parts.reverse(); value.document.wires.reverse(); }
    cases.push(value);
  }
}

// Four unselected-cell networks whose remaining resistors join selected
// source macros. Opening that cell must keep both real same-side bridges.
for (const load of [0.0002, 0.0003]) {
  for (const reorder of [false, true]) {
    const value = fixture(`unselected coupled passive bridge load=${load} reorder=${reorder}`, load);
    const r0 = simple(value, "s0", 0.0015, 0.000_05);
    const r1 = simple(value, "s1", 0.0015, 0.000_05);
    cell(value, "other", 2, 1000, false);
    for (const [id, a, b] of [
      ["oP0", "s0:a", "other:a"], ["oP1", "other:a", "s1:a"],
      ["oN0", "s0:b", "other:b"], ["oN1", "other:b", "s1:b"],
    ]) { resistor(value, id, a, b, 1000); }
    markPort(value, add(add(input(load), multiply(two, lead)), parallel(r0, r1)));
    if (reorder) { value.document.parts.reverse(); value.document.wires.reverse(); }
    cases.push(value);
  }
}

function exactReading(retained: CircuitExactComplex | undefined, scalar: number) {
  if (!retained) { return input(scalar); }
  if (!("numerator" in retained.real)) { throw new Error("Unexpected expression in DC rational reading"); }
  const text = retained.real.numerator;
  return rational(text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text), BigInt(retained.real.denominator));
}

function magnitude(value: Rational) { return value.numerator < 0n ? negate(value) : value; }

function portResponse(value: Fixture) {
  const sources = value.branches.filter((branch) => !branch.load && (!branch.cell || value.selected.has(branch.id!)));
  const ideal = sources.map((branch) => branch.cell ? { ...branch, r: zero } : branch);
  const suppressed = solve(ideal.map((branch) => ({ ...branch, e: zero })), { a: value.p, b: value.n });
  const open = solve(ideal);
  const loaded = solve(value.branches.filter((branch) => branch.load), { a: value.p, b: value.n });
  if (!suppressed || !open || !loaded) { throw new Error("Independent output is disconnected"); }
  return {
    r: add(subtract(suppressed.voltage(value.p), suppressed.voltage(value.n)),
      subtract(loaded.voltage(value.p), loaded.voltage(value.n))),
    v: subtract(open.voltage(value.p), open.voltage(value.n)),
  };
}

// An explicit alternate-port experiment uses the same independent branch
// KCL/KVL oracle. Only the named passive load is removed from the source
// side; this is diagnostic evidence, never the status expectation.
function cutExperiment(value: Fixture, a: string, b: string, loadIds: readonly string[]) {
  const load = value.branches.filter((branch) => loadIds.includes(branch.id!));
  const ideal = value.branches.filter((branch) => !load.includes(branch) && (!branch.cell || value.selected.has(branch.id!)))
    .map((branch) => branch.cell ? { ...branch, r: zero } : branch);
  const suppressed = solve(ideal.map((branch) => ({ ...branch, e: zero })), { a, b });
  const open = solve(ideal);
  const passive = solve(load, { a, b });
  if (!suppressed || !open || !passive) { throw new Error("Alternate cut is disconnected"); }
  return {
    r: add(subtract(suppressed.voltage(a), suppressed.voltage(b)), subtract(passive.voltage(a), passive.voltage(b))),
    v: subtract(open.voltage(a), open.voltage(b)),
  };
}

describe("coupled source macros against an independent oracle", () => {
  it.each(cases)("$document.title", (value) => {
    const expected = solve(value.branches)!;
    let response = { r: zero, v: zero };
    if (value.external) {
      response = portResponse(value);
      expect(compare(response.r, value.external), "closed form equals independent port KCL").toBe(0);
      expect(compare(response.v, zero), "exact open-circuit EMF sign").toBe(value.outputSign);
    }
    const proof = checks.get(value);
    if (proof?.cut) {
      const cut = cutExperiment(value, value.p, "J:a", ["loadA", "loadTap"]);
      expect(compare(cut.r, proof.cut.r), "alternate resistance closed form").toBe(0);
      expect(compare(cut.v, proof.cut.v), "alternate Voc closed form").toBe(0);
    }
    const actual = analyzeCircuit(value.document);
    let diagnostic = "";
    if (value.status === "closed" && value.external) {
      let a = value.p;
      let b = value.n;
      let loadIds: string[] = [];
      if (value.document.title.startsWith("multiple load cuts")) {
        b = "J:a";
        loadIds = ["loadA", "loadTap"];
      } else if (value.document.title.startsWith("unequal bridge P")) {
        a = "s0:a";
        b = "s1:a";
        loadIds = ["bridgeP"];
      } else if (value.document.title.startsWith("unequal bridge")) {
        a = value.n;
        b = "s0:b";
        loadIds = ["n-s0"];
      }
      if (loadIds.length) {
        const cut = cutExperiment(value, a, b, loadIds);
        expect(compare(cut.r, threshold), "alternate private cut has misleading sub-threshold R").toBe(-1);
        expect(cut.v.numerator, "alternate private cut is driven").not.toBe(0n);
        const display = (r: Rational) => Number(r.numerator) / Number(r.denominator);
        diagnostic = "; full R=" + display(value.external) + "; alternate " + a + "-" + b
          + " R=" + display(cut.r) + " Voc=" + display(cut.v) + " load=" + loadIds.join(",");
      }
    }
    expect.soft(actual.status, `${value.document.title}: ${actual.message}${diagnostic}`).toBe(value.status);
    for (const [index, branch] of value.branches.entries()) {
      const current = expected.currents[index];
      if (proof?.bridgeCurrent && branch.id?.startsWith("bridge")) {
        expect(current.numerator, "unequal bridge carries current").not.toBe(0n);
      }
      if (branch.cell && proof?.nonzeroCellCurrent) {
        expect(current.numerator, "series cell carries current").not.toBe(0n);
      }
      if (branch.cell && proof?.cellCurrent) {
        expect(compare(current, proof.cellCurrent), "scalar load KVL").toBe(0);
      }
      if (branch.id) {
        const voltage = branch.cell ? add(branch.e, multiply(branch.r, current)) : multiply(branch.partR!, current);
        const power = multiply(voltage, branch.cell ? negate(current) : current);
        const reading = actual.parts[branch.id];
        expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${branch.id} retained current`).toBe(0);
        expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage), `${branch.id} retained voltage`).toBe(0);
        assertCorrectRounding(Math.abs(reading.currentAmps), magnitude(current), `${branch.id} current`);
        assertCorrectRounding(Math.abs(reading.voltageVolts), magnitude(voltage), `${branch.id} voltage`);
        assertCorrectRounding(reading.powerWatts, power, `${branch.id} power`);
      }
      for (const id of branch.wires) {
        assertCorrectRounding(Math.abs(actual.wireCurrents[id]), magnitude(current), `${id} current`);
        if (actual.wireCurrents[id] !== 0) { expect(Math.sign(actual.wireCurrents[id])).toBe(compare(current, zero)); }
      }
    }
    const passive = value.branches.filter((branch) => !branch.cell);
    for (const [index, branch] of value.branches.entries()) {
      if (!branch.cell) { continue; }
      const returned = solve(passive, { a: branch.a, b: branch.b });
      if (!returned) { continue; }
      const resistance = subtract(returned.voltage(branch.a), returned.voltage(branch.b));
      if (compare(resistance, threshold) < 0 && expected.currents[index].numerator !== 0n) {
        expect(actual.status, `${branch.id}: independent private passive short`).toBe("short");
      }
      if (value.status === "closed") {
        expect(compare(resistance, threshold), `${branch.id}: no individual passive short`).not.toBe(-1);
      }
    }
    for (const id of value.zeroLinks ?? []) {
      const index = value.branches.findIndex((branch) => branch.id === id);
      expect(expected.currents[index].numerator, `${id} independent bridge current`).toBe(0n);
      expect(actual.parts[id].currentAmps).toBe(0);
      expect(actual.parts[id].voltageVolts).toBe(0);
    }
  });
});
