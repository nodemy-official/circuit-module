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
  unselected?: boolean;
  load?: boolean;
  wires: string[];
}

interface Fixture {
  document: CircuitDocument;
  branches: Branch[];
  expectedStatus: "short" | "closed";
  outputSign: -1 | 0 | 1;
  closedForm?: Rational;
  localShort?: boolean;
  large?: boolean;
  rayleigh?: "equal" | "decrease";
  baseline?: Fixture;
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


// The physical cut is fixed before opening the unrelated source. Its passive
// conductors and both raw terminals remain, unlike deleting its whole macro.
function port(value: Fixture) {
  const source = value.branches.filter((branch) => !branch.load && !branch.unselected)
    .map((branch) => branch.cell ? { ...branch, r: zero } : branch);
  const open = solve(source);
  const suppressed = solve(source.map((branch) => ({ ...branch, e: zero })), { a: "P:a", b: "N:a" });
  const load = solve(value.branches.filter((branch) => branch.load), { a: "P:a", b: "N:a" });
  return {
    r: add(subtract(suppressed.voltage("P:a"), suppressed.voltage("N:a")),
      subtract(load.voltage("P:a"), load.voltage("N:a"))),
    v: subtract(open.voltage("P:a"), open.voltage("N:a")),
  };
}

interface Options {
  columns?: number[][];
  alternate?: number;
  stages?: number;
  p?: number;
  n?: number;
  equal?: number;
  tap?: number;
  shared?: boolean;
  weak?: number;
  other?: "p" | "both";
  otherResistance?: number;
  otherShunt?: boolean;
  privateR?: number;
  symmetric?: boolean;
}

function mixed(title: string, options: Options = {}) {
  const columns = options.columns ?? [[3, -2], [-2, 3]];
  const value = fixture(title, options.alternate === 0.003 || options.equal === 0.0012 ? "closed" : "short");
  const emf = sum(columns[0].map(input));
  value.outputSign = compare(emf, zero);
  const stages = options.stages ?? 4;
  const nodes = ["P:a", ...Array.from({ length: stages - 1 }, (_, i) => junction(value, `LJ${i}`)), "N:a"];
  const loadSegments: Rational[] = [];
  for (let i = 0; i < stages; i += 1) {
    loadSegments.push(resistor(value, `load${i}`, nodes[i], nodes[i + 1], options.equal ?? 0.0003 / stages, true));
  }
  const loadTap = resistor(value, "loadTap", nodes[0], nodes[1], options.equal ?? 0.03, true);
  const alternate = resistor(value, "loadOther", "P:a", "N:a", options.equal ?? options.alternate ?? 0.0004, true);
  const p = options.equal ?? options.p ?? 0.0015;
  const n = options.equal ?? options.n ?? 0.000_05;
  const ends = columns.map((voltages, column) => {
    const cells = voltages.map((voltage, i) => {
      const id = `cell${column}-${i}`;
      cell(value, id, Math.abs(voltage));
      resistor(value, `private${column}-${i}`, `${id}:a`, `${id}:b`, options.privateR ?? 0.003);
      return { p: `${id}:${voltage > 0 ? "a" : "b"}`, n: `${id}:${voltage > 0 ? "b" : "a"}` };
    });
    for (let i = 1; i < cells.length; i += 1) { wire(value, cells[i - 1].n, cells[i].p); }
    return { p: cells[0].p, n: cells.at(-1)!.n, mid: cells[0].n };
  });
  const feed: Record<"p" | "n", string> = { p: "P:a", n: "N:a" };
  if (options.shared) {
    // Aliases have finite physical wires; they cannot be treated as zero-R
    // nodes by the independent oracle or included in a parallel ballast.
    for (const side of ["p", "n"] as const) {
      feed[side] = junction(value, `alias${side}`);
      wire(value, feed[side], side === "p" ? "P:a" : "N:a");
    }
  }
  for (const [column, end] of ends.entries()) {
    for (const side of ["p", "n"] as const) {
      const r = side === "p" ? p : n;
      const outer = feed[side];
      if (column === 0 && (options.other === side || options.other === "both")) {
        const id = `other${side}`;
        cell(value, id, 7);
        const other = value.branches.at(-1)!;
        other.unselected = true;
        other.r = input(options.otherResistance ?? 1000);
        value.document.parts.at(-1)!.internalResistanceOhms = options.otherResistance ?? 1000;
        resistor(value, `feed${side}0`, outer, `${id}:a`, r / 2);
        resistor(value, `feed${side}1`, `${id}:a`, end[side], r / 2);
        resistor(value, `otherReturn${side}`, `${id}:b`, side === "p" ? "N:a" : "P:a", 1000);
        if (options.otherShunt) { resistor(value, `otherShunt${side}`, `${id}:a`, `${id}:b`, 10); }
      } else if (options.symmetric) {
        const hub = junction(value, `U${side}${column}`);
        resistor(value, `inner${side}${column}`, outer, hub, r / 2);
        resistor(value, `outer${side}${column}`, hub, end[side], r / 2);
      } else { resistor(value, `ballast${side}${column}`, outer, end[side], r); }
    }
  }
  if (options.weak !== undefined) {
    for (const side of ["p", "n"] as const) {
      if (options.symmetric) {
        resistor(value, `diamond${side}`, `U${side}0:a`, `U${side}1:a`, options.weak);
      } else {
        const hub = junction(value, `hub${side}`);
        for (const [column, end] of ends.entries()) { resistor(value, `weak${side}${column}`, end[side], hub, options.weak); }
        resistor(value, `hubOuter${side}`, hub, feed[side], options.weak);
      }
    }
  }
  if (options.tap !== undefined) {
    // Wrong roots create alternative partitions of the same original ID set.
    resistor(value, "midTapP", "P:a", ends[0].mid, options.tap);
    resistor(value, "midTapN", "N:a", ends[1].mid, options.tap);
  }
  const simple = !options.other && options.tap === undefined && options.weak === undefined
    && columns.every((column) => column.length === columns[0].length);
  if (simple) {
    const source = divide(sum([input(p), input(n), multiply(rational(BigInt(options.symmetric ? 8 : 4)), lead),
      multiply(rational(BigInt(columns[0].length - 1)), lead)]), rational(BigInt(columns.length)));
    value.closedForm = sum([source, options.shared ? multiply(two, lead) : zero,
      parallel(sum([parallel(loadSegments[0], loadTap), ...loadSegments.slice(1)]), alternate)]);
  }
  return value;
}

const cases: Fixture[] = [];
function minimalPartitionRepro() {
  const value = fixture("minimal mixed 4-3 V private-shunt source discovery", "short");
  const load = resistor(value, "load", "P:a", "N:a", 0.000_15, true);
  for (const [column, voltages] of [[4, -3], [-3, 4]].entries()) {
    const ends = voltages.map((voltage, i) => {
      const id = `cell${column}-${i}`;
      cell(value, id, Math.abs(voltage));
      resistor(value, `private${column}-${i}`, `${id}:a`, `${id}:b`, 0.003);
      return { p: `${id}:${voltage > 0 ? "a" : "b"}`, n: `${id}:${voltage > 0 ? "b" : "a"}` };
    });
    wire(value, ends[0].n, ends[1].p);
    resistor(value, `ballastp${column}`, "P:a", ends[0].p, 0.0015);
    resistor(value, `ballastn${column}`, ends[1].n, "N:a", 0.000_05);
  }
  // Rext = (Rp + Rn + 5*Rwire)/2 + (Rload + 2*Rwire).
  // The unequal ballasts bracket the load rank; private returns are 3 mΩ.
  value.closedForm = add(divide(sum([input(0.0015), input(0.000_05), multiply(rational(5n), lead)]), two), load);
  return value;
}

for (const order of [[4, -3], [-3, 4], [3, -4], [-4, 3]]) {
  cases.push(order[0] === 4 ? minimalPartitionRepro()
    : mixed(`mixed 4-3 V multiple roots ${order}`, { columns: [order, [...order].reverse()], tap: 1000 }));
}
for (const alternate of [0.0004, 0.003]) {
  cases.push(mixed(`unequal 2+3 strings alternate=${alternate}`, {
    columns: [[4, -3], [5, -2, -2]], alternate, tap: 1000,
  }));
}
for (const equal of [0.000_15, 0.0012]) {
  cases.push(mixed(`equal ballast and multi-stage load shared aliases ${equal}`, { equal, shared: true, tap: 1e100 }));
}
const symmetric = mixed("Rayleigh zero-current diamond baseline", { symmetric: true });
cases.push(symmetric);
const diamond = mixed("Rayleigh zero-current diamond weak addition", { symmetric: true, weak: 1000 });
diamond.rayleigh = "equal"; diamond.baseline = symmetric;
cases.push(diamond);
const hubBase = mixed("Rayleigh three-column baseline", {
  columns: [[4, -3], [-3, 4], [4, -3]], p: 0.0023,
});
cases.push(hubBase);
const hub = mixed("Rayleigh three-column shared weak hub addition", {
  columns: [[4, -3], [-3, 4], [4, -3]], p: 0.0023, weak: 1000,
});
hub.rayleigh = "decrease"; hub.baseline = hubBase;
cases.push(hub);
for (const other of ["p", "both"] as const) {
  for (const otherShunt of [false, true]) {
    cases.push(mixed(`passive route through unselected raw source ports ${other} shunt=${otherShunt}`, {
      other, otherShunt, otherResistance: otherShunt ? 1e100 : 1000,
      columns: [[4, -3], [-3, 4]], tap: 1000, weak: 1000,
    }));
  }
}
for (const localShort of [false, true]) {
  const value = mixed(`zero output EMF separate local short=${localShort}`, {
    columns: [[4, -4], [-4, 4]], privateR: localShort ? 0.0008 : 0.003, weak: 1000,
  });
  value.localShort = localShort;
  value.expectedStatus = localShort ? "short" : "closed";
  cases.push(value);
}
const opposite = mixed("opposite mixed columns nonshort circulation", {
  columns: [[4, -3], [3, -4]], shared: true, weak: 1000,
});
opposite.outputSign = 0; opposite.expectedStatus = "closed";
cases.push(opposite);
const large = mixed("eight mixed/private-shunt columns closed observation", {
  columns: Array.from({ length: 8 }, (_, i) => i % 2 === 0 ? [4, -3] : [-3, 4]),
  alternate: 0.003, p: 0.006, n: 0.000_05, weak: 1000,
});
large.large = true;
cases.push(large);

function exactReading(value: CircuitExactComplex | undefined, scalar: number) {
  if (!value) {
    if (scalar === 0) { return zero; }
    throw new Error(`Missing retained exact reading ${scalar}`);
  }
  if (!("numerator" in value.real)) { throw new Error("Expected rational DC output"); }
  const numerator = value.real.numerator;
  return rational(numerator.startsWith("-") ? -BigInt(numerator.slice(1)) : BigInt(numerator), BigInt(value.real.denominator));
}

function variant(value: Fixture) {
  const names = new Map(value.document.parts.map((item, i) => [item.id, `${value.document.parts.length - i};,|["\\日本語]${item.id}`]));
  const end = (node: CircuitEndpoint) => ({ ...node, partId: names.get(node.partId)! });
  return {
    names,
    document: { ...value.document,
      parts: [...value.document.parts].reverse().map((item) => ({ ...item, id: names.get(item.id)! })),
      wires: [...value.document.wires].reverse().map((edge) => ({ ...edge, from: end(edge.from), to: end(edge.to) })),
    },
  };
}

// Voltage/current/power expectations use independent rational KCL/KVL and
// correct binary64 rounding intervals. No production numerical helper or
// approximate zero/expanded tolerance enters any assertion.
describe("source discovery against an independent nodal oracle", () => {
  it.each(cases)("$document.title", (value) => {
    const response = port(value);
    expect(compare(response.v, zero), "independent exact open-output polarity").toBe(value.outputSign);
    if (value.closedForm) { expect(compare(response.r, value.closedForm), "closed form equals rational KCL port experiment").toBe(0); }
    const status = value.localShort || value.outputSign !== 0 && compare(response.r, threshold) < 0 ? "short" : "closed";
    expect(status, "physical output experiment, before production analysis").toBe(value.expectedStatus);
    if (value.rayleigh) {
      const before = port(value.baseline!);
      expect(compare(response.r, before.r), "passive Rayleigh bound").toBe(value.rayleigh === "equal" ? 0 : -1);
      expect(compare(response.v, before.v), "passive equilibrium link preserves ideal Voc exactly").toBe(0);
    }
    const point = solve(value.branches);
    const kcl = new Map<string, Rational>();
    let power = zero;
    for (const [i, branch] of value.branches.entries()) {
      const current = point.currents[i];
      kcl.set(branch.a, add(kcl.get(branch.a) ?? zero, current));
      kcl.set(branch.b, subtract(kcl.get(branch.b) ?? zero, current));
      const drop = add(branch.e, multiply(branch.r, current));
      expect(compare(subtract(point.voltage(branch.a), point.voltage(branch.b)), drop), "independent exact KVL").toBe(0);
      power = add(power, multiply(drop, current));
      if (branch.cell) {
        const local = solve(value.branches.filter((edge) => !edge.cell), { a: branch.a, b: branch.b });
        expect(compare(subtract(local.voltage(branch.a), local.voltage(branch.b)), threshold), "passive local short separate from common Voc")
          .toBe(value.localShort && !branch.unselected ? -1 : 1);
      }
    }
    expect([...kcl.values()].every((current) => current.numerator === 0n), "exact node conservation").toBe(true);
    expect(power.numerator, "exact energy conservation includes every 1 microohm physical lead").toBe(0n);
    const start = performance.now();
    const actual = analyzeCircuit(value.document);
    const elapsed = performance.now() - start;
    const renamed = variant(value);
    const results = [{ actual, name: (id: string) => id }];
    if (!value.large) { results.push({ actual: analyzeCircuit(renamed.document), name: (id: string) => renamed.names.get(id)! }); }
    if (value.large) {
      console.info(`FINAL_REVIEW_EIGHT_COLUMNS parts=${value.document.parts.length} wires=${value.document.wires.length} analyzeMs=${elapsed.toFixed(3)} status=${actual.status}`);
    }
    if (!value.large && results.some((result) => result.actual.status !== value.expectedStatus)) {
      console.info(`FINAL_REVIEW_MISMATCH title=${value.document.title} expected=${value.expectedStatus} original=${actual.status} renamed=${results[1].actual.status} externalMilliOhms=${Number(response.r.numerator) / Number(response.r.denominator) * 1000} voc=${Number(response.v.numerator) / Number(response.v.denominator)}`);
    }
    for (const result of results) {
      for (const [i, branch] of value.branches.entries()) {
        const current = point.currents[i];
        if (branch.id) {
          const reading = result.actual.parts[result.name(branch.id)];
          const voltage = branch.cell ? add(branch.e, multiply(branch.r, current)) : multiply(branch.partR!, current);
          expect(compare(exactReading(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${branch.id} exact current`).toBe(0);
          expect(compare(exactReading(reading.exactVoltage, reading.voltageVolts), voltage), `${branch.id} exact voltage`).toBe(0);
          assertCorrectRounding(reading.currentAmps, current, `${branch.id} current`);
          assertCorrectRounding(reading.voltageVolts, voltage, `${branch.id} voltage`);
          assertCorrectRounding(reading.powerWatts, multiply(voltage, branch.cell ? negate(current) : current), `${branch.id} power`);
        }
        for (const id of branch.wires) { assertCorrectRounding(result.actual.wireCurrents[id], current, `${id} current`); }
      }
      expect(result.actual.status, `${value.document.title} production status`).toBe(value.expectedStatus);
    }
  });
});
