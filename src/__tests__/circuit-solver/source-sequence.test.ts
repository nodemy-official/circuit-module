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
const input = (value: number) => rationalFromNumber(value)!;
const lead = input(1e-6);
const internal = input(0.1);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const parallel = (values: readonly Rational[]) => divide(one, sum(values.map((value) => divide(one, value))));
const times = (value: Rational, count: number) => multiply(value, rational(BigInt(count)));

interface Options {
  columns: number[][];
  split: number;
  alternate: number;
  stages?: number;
  loadTotal?: number;
  alternateCount?: number;
  positive?: number;
}

interface Resistor {
  id: string;
  r: Rational;
  total: Rational;
  wires: string[];
}

interface Expected {
  voltage: Rational;
  current: Rational;
  power: Rational;
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(text: string): CircuitEndpoint {
  const [partId, terminal] = text.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(text); }
  return { partId, terminal };
}

// Independent closed form: replace each real cell/private-return pair by
// its Thevenin equivalent, then solve the parallel strings at P-N. The
// short experiment instead suppresses the original ideal cells, retaining
// every ballast, inter-cell wire and complete common parallel load.
function fixture(options: Options) {
  const document: CircuitDocument = { title: "Original source strings with private returns", parts: [], wires: [] };
  const readings = new Map<string, Expected>();
  const currents = new Map<string, Rational>();
  const cellResiduals: Rational[] = [];
  const junction = (id: string) => {
    document.parts.push(part(id, "junction"));
    return `${id}:a`;
  };
  const p = junction("P");
  const n = junction("N");
  const wire = (a: string, b: string) => {
    const id = `wire${document.wires.length}`;
    document.wires.push({ id, from: endpoint(a), to: endpoint(b) });
    return id;
  };
  const resistor = (id: string, a: string, b: string, ohms: number): Resistor => {
    document.parts.push(part(id, "resistor", { resistanceOhms: ohms }));
    return { id, r: input(ohms), total: add(input(ohms), times(lead, 2)),
      wires: [wire(a, `${id}:a`), wire(`${id}:b`, b)] };
  };
  const record = (element: Resistor, current: Rational) => {
    const voltage = multiply(element.r, current);
    readings.set(element.id, { voltage, current, power: multiply(voltage, current) });
    for (const id of element.wires) { currents.set(id, current); }
  };
  const stages = options.stages ?? 4;
  const loadNodes = [p, ...Array.from({ length: stages - 1 }, (_, i) => junction(`loadNode${i}`)), n];
  const segments = Array.from({ length: stages }, (_, i) =>
    resistor(`load${i}`, loadNodes[i], loadNodes[i + 1], (options.loadTotal ?? 0.0003) / stages));
  const tap = resistor("loadTap", p, loadNodes[1], 0.02);
  const alternatives = Array.from({ length: options.alternateCount ?? 1 }, (_, i) =>
    resistor(`alternate${i}`, p, n, options.alternate));
  const firstLoad = parallel([segments[0].total, tap.total]);
  const stagedLoad = sum([firstLoad, ...segments.slice(1).map((element) => element.total)]);
  const loadResistance = parallel([stagedLoad, ...alternatives.map((element) => element.total)]);
  const ballast = (prefix: string, from: string, to: string, total: number) => {
    const nodes = [from, ...Array.from({ length: options.split - 1 }, (_, i) => junction(`${prefix}Node${i}`)), to];
    return Array.from({ length: options.split }, (_, i) => resistor(`${prefix}${i}`, nodes[i], nodes[i + 1], total / options.split));
  };
  const columns = options.columns.map((voltages, column) => {
    const cells = voltages.map((signed, cell) => {
      const id = `cell${column}-${cell}`;
      document.parts.push(part(id, "battery", { voltageVolts: Math.abs(signed), internalResistanceOhms: 0.1 }));
      const shunt = resistor(`private${column}-${cell}`, `${id}:a`, `${id}:b`, 0.003);
      return { id, signed, shunt, p: `${id}:${signed > 0 ? "a" : "b"}`, n: `${id}:${signed > 0 ? "b" : "a"}` };
    });
    const links = cells.slice(1).map((cell, i) => wire(cells[i].n, cell.p));
    const positive = ballast(`positive${column}-`, p, cells[0].p, options.positive ?? 0.0015);
    const negative = ballast(`negative${column}-`, cells.at(-1)!.n, n, 0.000_05);
    const outside = sum([...positive, ...negative].map((element) => element.total).concat(times(lead, links.length)));
    const equivalentCells = cells.map((cell) => parallel([internal, cell.shunt.total]));
    const voltage = sum(cells.map((cell) => divide(multiply(input(cell.signed), cell.shunt.total), add(internal, cell.shunt.total))));
    return { cells, links, positive, negative, outside, resistance: sum([outside, ...equivalentCells]), voltage, equivalentCells };
  });
  const conductance = sum(columns.map((column) => divide(one, column.resistance)));
  const drive = sum(columns.map((column) => divide(column.voltage, column.resistance)));
  const voltage = divide(drive, add(conductance, divide(one, loadResistance)));
  const loadCurrent = divide(voltage, loadResistance);
  const stagedCurrent = divide(voltage, stagedLoad);
  const firstDrop = multiply(stagedCurrent, firstLoad);
  record(segments[0], divide(firstDrop, segments[0].total));
  record(tap, divide(firstDrop, tap.total));
  for (const element of segments.slice(1)) { record(element, stagedCurrent); }
  for (const element of alternatives) { record(element, divide(voltage, element.total)); }
  const stringCurrents = columns.map((column) => {
    const current = divide(subtract(voltage, column.voltage), column.resistance);
    for (const element of [...column.positive, ...column.negative]) { record(element, current); }
    for (const id of column.links) { currents.set(id, current); }
    for (const [i, cell] of column.cells.entries()) {
      const oriented = cell.signed > 0 ? current : negate(current);
      const cellVoltage = add(divide(multiply(input(Math.abs(cell.signed)), cell.shunt.total), add(internal, cell.shunt.total)),
        multiply(column.equivalentCells[i], oriented));
      const cellCurrent = divide(subtract(cellVoltage, input(Math.abs(cell.signed))), internal);
      readings.set(cell.id, { voltage: cellVoltage, current: cellCurrent, power: multiply(cellVoltage, negate(cellCurrent)) });
      record(cell.shunt, divide(cellVoltage, cell.shunt.total));
      cellResiduals.push(subtract(add(cellCurrent, divide(cellVoltage, cell.shunt.total)), oriented));
    }
    return current;
  });
  const outputResidual = add(sum(stringCurrents), loadCurrent);
  const absorbed = sum([...readings].map(([id, reading]) => id.startsWith("cell") ? negate(reading.power) : reading.power));
  const wirePower = sum([...currents.values()].map((current) => multiply(lead, multiply(current, current))));
  const powerResidual = add(absorbed, wirePower);
  const emf = sum(options.columns[0].map(input));
  const equalEmfs = options.columns.every((column) => compare(sum(column.map(input)), emf) === 0);
  const external = add(parallel(columns.map((column) => column.outside)), loadResistance);
  const status = emf.numerator !== 0n && compare(external, input(0.001)) < 0 ? "short" : "closed";
  return { document, readings, currents, external, status, cellResiduals, outputResidual, powerResidual, equalEmfs };
}

function retained(value: CircuitExactComplex | undefined, display: number) {
  if (!value) {
    if (display === 0) { return zero; }
    throw new Error("Missing retained exact DC reading");
  }
  if (!("numerator" in value.real)) { throw new Error("Expected DC rational"); }
  const numerator = value.real.numerator;
  return rational(numerator.startsWith("-") ? -BigInt(numerator.slice(1)) : BigInt(numerator), BigInt(value.real.denominator));
}

const cases: Options[] = [];
for (const split of [1, 2]) {
  for (const alternate of [0.0004, 0.003]) {
    for (const columns of [[[5, -4], [-4, 5]], [[-5, 4], [4, -5]], [[5, -4], [9, -3, -5]]]) {
      cases.push({ columns, split, alternate });
    }
  }
}
cases.push({ columns: [[5, -5], [-5, 5]], split: 2, alternate: 0.0004 });
cases.push({ columns: [[5, -4], [-4, 5], [9, -3, -5]], split: 2, alternate: 0.0004 });
cases.push({ columns: [[5, -4], [-4, 5]], split: 1, alternate: 0.002, loadTotal: 0.008 });
cases.push({ columns: [[5, -4], [-4, 5], [5, -4], [-4, 5]], split: 1,
  alternate: 0.0012, alternateCount: 2, loadTotal: 0.0048 });

describe("original source-sequence repair with independent closed forms", () => {
  it.each(cases)("$columns split=$split alternate=$alternate", (options) => {
    const value = fixture(options);
    expect(value.cellResiduals.every((residual) => residual.numerator === 0n), "cell/private-return KCL").toBe(true);
    expect(value.outputResidual.numerator, "common output KCL").toBe(0n);
    expect(value.powerResidual.numerator, "exact energy conservation including all physical leads").toBe(0n);
    expect(value.equalEmfs, "equal original string EMF").toBe(true);
    const names = new Map(value.document.parts.map((item, i) => [item.id, `${value.document.parts.length - i};|日本語,${item.id}`]));
    const rename = (node: CircuitEndpoint) => ({ ...node, partId: names.get(node.partId)! });
    const renamed = { ...value.document,
      parts: [...value.document.parts].reverse().map((item) => ({ ...item, id: names.get(item.id)! })),
      wires: [...value.document.wires].reverse().map((edge) => ({ ...edge, from: rename(edge.from), to: rename(edge.to) })),
    };
    for (const [document, name] of [
      [value.document, (id: string) => id],
      [renamed, (id: string) => names.get(id)!],
    ] as const) {
      const actual = analyzeCircuit(document);
      expect(actual.status, `physical Rout + complete Rload = ${value.external.numerator}/${value.external.denominator}`).toBe(value.status);
      for (const [id, expected] of value.readings) {
        const reading = actual.parts[name(id)];
        expect(compare(retained(reading.exactVoltage, reading.voltageVolts), expected.voltage), `${id} exact voltage`).toBe(0);
        expect(compare(retained(reading.exactTerminalCurrents?.a, reading.currentAmps), expected.current), `${id} exact current`).toBe(0);
        assertCorrectRounding(reading.voltageVolts, expected.voltage, `${id} voltage`);
        assertCorrectRounding(reading.currentAmps, expected.current, `${id} current`);
        assertCorrectRounding(reading.powerWatts, expected.power, `${id} power`);
      }
      for (const [id, current] of value.currents) { assertCorrectRounding(actual.wireCurrents[id], current, id); }
    }
  });
});
