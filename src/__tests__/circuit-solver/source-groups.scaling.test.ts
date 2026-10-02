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
const input = (value: number) => rationalFromNumber(value)!;
const lead = input(1e-6);
const threshold = input(0.001);
const internal = input(0.1);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const times = (value: Rational, count: number) => multiply(value, rational(BigInt(count)));
const parallel = (values: readonly Rational[]) => divide(one, sum(values.map((value) => divide(one, value))));

interface Options {
  name: string;
  status: "short" | "closed";
  columns?: number[][];
  positive?: number;
  negative?: number;
  split?: number;
  loads?: number[];
  tap?: number;
  alternate?: number;
  privateResistance?: number;
  shared?: boolean;
  decorations?: boolean;
  highBallast?: boolean;
  boundary?: -1 | 0 | 1;
  partialLoad?: boolean;
  tinyDrive?: boolean;
  localShort?: boolean;
  circulation?: boolean;
}

interface Resistor {
  id: string;
  r: Rational;
  total: Rational;
  wires: string[];
}

interface Reading {
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

// Independent closed forms replace each real cell/private shunt by a
// Thevenin pair, then apply KCL to the parallel strings. Short experiments
// instead suppress the original ideal cells and keep every physical lead.
// No production arithmetic, reduction or source-discovery helper is used.
function fixture(options: Options) {
  const document: CircuitDocument = { title: options.name, parts: [], wires: [] };
  const readings = new Map<string, Reading>();
  const currents = new Map<string, Rational>();
  const residuals: Rational[] = [];
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
  const loads = options.loads ?? [0.000_15];
  const loadNodes = [p, ...loads.slice(1).map((_, i) => junction(`loadNode${i}`)), n];
  const segments = loads.map((r, i) => resistor(`load${i}`, loadNodes[i], loadNodes[i + 1], r));
  const tap = options.tap === undefined ? undefined : resistor("loadTap", p, loadNodes[1], options.tap);
  const alternate = options.alternate === undefined ? undefined : resistor("loadOther", p, n, options.alternate);
  const firstLoad = tap ? parallel([segments[0].total, tap.total]) : segments[0].total;
  const stagedLoad = sum([firstLoad, ...segments.slice(1).map((element) => element.total)]);
  const loadResistance = alternate ? parallel([stagedLoad, alternate.total]) : stagedLoad;
  const feedP = options.shared ? junction("feedP") : p;
  const feedN = options.shared ? junction("feedN") : n;
  const sharedWires = options.shared ? [wire(p, feedP), wire(feedN, n)] : [];
  const sharedResistance = times(lead, sharedWires.length);
  const split = options.split ?? 1;
  const ballast = (prefix: string, from: string, to: string, ohms: number) => {
    const nodes = [from, ...Array.from({ length: split - 1 }, (_, i) => junction(`${prefix}Node${i}`)), to];
    return Array.from({ length: split }, (_, i) => resistor(`${prefix}${i}`, nodes[i], nodes[i + 1], ohms / split));
  };
  const columns = (options.columns ?? [[4, -3], [-3, 4]]).map((voltages, column) => {
    const cells = voltages.map((signed, cell) => {
      const id = `cell${column}-${cell}`;
      document.parts.push(part(id, "battery", { voltageVolts: Math.abs(signed), internalResistanceOhms: 0.1 }));
      const shunt = resistor(`private${column}-${cell}`, `${id}:a`, `${id}:b`, options.privateResistance ?? 0.003);
      return { id, signed, shunt, p: `${id}:${signed > 0 ? "a" : "b"}`, n: `${id}:${signed > 0 ? "b" : "a"}` };
    });
    const links = cells.slice(1).map((cell, i) => wire(cells[i].n, cell.p));
    const positive = ballast(`positive${column}-`, feedP, cells[0].p, options.positive ?? 0.0015);
    const negative = ballast(`negative${column}-`, cells.at(-1)!.n, feedN, options.negative ?? 0.000_05);
    const outside = sum([...positive, ...negative].map((element) => element.total).concat(times(lead, links.length)));
    const cellResistances = cells.map((cell) => parallel([internal, cell.shunt.total]));
    const emf = sum(voltages.map(input));
    const voltage = sum(cells.map((cell) => divide(multiply(input(cell.signed), cell.shunt.total), add(internal, cell.shunt.total))));
    const resistance = sum([outside, ...cellResistances]);
    return { cells, links, positive, negative, outside, cellResistances, emf, voltage, resistance };
  });
  const conductance = sum(columns.map((column) => divide(one, column.resistance)));
  const drive = sum(columns.map((column) => divide(column.voltage, column.resistance)));
  const busVoltage = divide(drive, add(conductance, divide(one, add(loadResistance, sharedResistance))));
  const loadCurrent = divide(busVoltage, add(loadResistance, sharedResistance));
  const voltage = multiply(loadCurrent, loadResistance);
  const stagedCurrent = divide(voltage, stagedLoad);
  const firstDrop = multiply(stagedCurrent, firstLoad);
  record(segments[0], divide(firstDrop, segments[0].total));
  if (tap) { record(tap, divide(firstDrop, tap.total)); }
  for (const element of segments.slice(1)) { record(element, stagedCurrent); }
  if (alternate) { record(alternate, divide(voltage, alternate.total)); }
  for (const id of sharedWires) { currents.set(id, negate(loadCurrent)); }
  const stringCurrents = columns.map((column) => {
    const current = divide(subtract(busVoltage, column.voltage), column.resistance);
    for (const element of [...column.positive, ...column.negative]) { record(element, current); }
    for (const id of column.links) { currents.set(id, current); }
    for (const [i, cell] of column.cells.entries()) {
      const oriented = cell.signed > 0 ? current : negate(current);
      const cellVoltage = add(divide(multiply(input(Math.abs(cell.signed)), cell.shunt.total), add(internal, cell.shunt.total)),
        multiply(column.cellResistances[i], oriented));
      const cellCurrent = divide(subtract(cellVoltage, input(Math.abs(cell.signed))), internal);
      readings.set(cell.id, { voltage: cellVoltage, current: cellCurrent, power: negate(multiply(cellVoltage, cellCurrent)) });
      const shuntCurrent = divide(cellVoltage, cell.shunt.total);
      record(cell.shunt, shuntCurrent);
      residuals.push(subtract(add(cellCurrent, shuntCurrent), oriented));
    }
    return current;
  });
  if (options.decorations) {
    const midpoint = columns[0].cells[0].n;
    const deadA = junction("deadA");
    const deadB = junction("deadB");
    for (const element of [
      resistor("leafA", midpoint, deadA, 0.004),
      resistor("leafB", deadA, deadB, 0.0002),
      resistor("selfLoop", midpoint, midpoint, 0.0001),
    ]) { record(element, zero); }
  }
  residuals.push(add(sum(stringCurrents), loadCurrent));
  const absorbed = sum([...readings].map(([id, reading]) => id.startsWith("cell") ? negate(reading.power) : reading.power));
  const wirePower = sum([...currents.values()].map((current) => multiply(lead, multiply(current, current))));
  residuals.push(add(absorbed, wirePower));

  const outputR = parallel(columns.map((column) => column.outside));
  const outputVoc = divide(sum(columns.map((column) => divide(column.emf, column.outside))),
    sum(columns.map((column) => divide(one, column.outside))));
  const external = sum([outputR, sharedResistance, loadResistance]);
  const localReturns = columns.flatMap((column, index) => {
    const returnResistance = parallel([add(loadResistance, sharedResistance), ...columns.filter((_, i) => i !== index)
      .map((other) => sum([other.outside, ...other.cells.map((cell) => cell.shunt.total)]))]);
    return column.cells.map((cell, i) => parallel([cell.shunt.total,
      sum([column.outside, returnResistance, ...column.cells.filter((_, j) => j !== i).map((other) => other.shunt.total)])]));
  });
  return { document, readings, currents, residuals, columns, external, outputVoc, localReturns, loadResistance, outputR };
}

function retained(value: CircuitExactComplex | undefined, display: number): Rational {
  if (!value) {
    if (display === 0) { return zero; }
    throw new Error("Missing retained exact DC reading");
  }
  if (!("numerator" in value.real)) { throw new Error("Expected DC rational"); }
  const n = value.real.numerator;
  return rational(n.startsWith("-") ? -BigInt(n.slice(1)) : BigInt(n), BigInt(value.real.denominator));
}

// Exact equality is constructed using a sub-microohm final load segment:
// all binary64 inputs, including the 6.5 physical-lead terms, sum to the
// binary64 threshold exactly. Moving just this segment by one ULP leaves
// the displayed total unchanged but must change the strict comparison.
const mainLoad = 0.000_218_4;
const base = sum([divide(add(input(0.0015), input(0.000_05)), rational(2n)), input(mainLoad), multiply(lead, rational(13n, 2n))]);
const remaining = subtract(threshold, base);
const equalitySegment = Number(remaining.numerator) / Number(remaining.denominator);
const highColumns = Array.from({ length: 6 }, (_, i) => i % 2 === 0 ? [4, -3] : [-3, 4]);

const cases: Options[] = [
  { name: "six mixed strings: 4.5 mOhm ballast exceeds private shunts, true output short", status: "short",
    columns: highColumns, positive: 0.0045, loads: [0.000_15], highBallast: true },
  { name: "six mixed strings: 5 mOhm ballast exceeds private shunts, closed control", status: "closed",
    columns: highColumns, positive: 0.005, loads: [0.0002], highBallast: true },
  { name: "Rayleigh lower bound one ULP below exact threshold", status: "short",
    loads: [mainLoad, nextDown(equalitySegment)], boundary: -1 },
  { name: "Rayleigh lower bound equals exact threshold", status: "closed",
    loads: [mainLoad, equalitySegment], boundary: 0 },
  { name: "Rayleigh lower bound one ULP above exact threshold", status: "closed",
    loads: [mainLoad, nextUp(equalitySegment)], boundary: 1 },
  { name: "near threshold without shared output leads", status: "short", loads: [0.000_219_5] },
  { name: "both shared output leads remain outside the parallel ballast", status: "closed", loads: [0.000_219_5], shared: true },
  { name: "positive source offsets through two/three-cell strings and split ballast", status: "short",
    columns: [[5, -2, -2], [-3, 4]], split: 2, positive: 0.0012, loads: [0.0002] },
  { name: "negative source offsets through two/three-cell strings and split ballast", status: "short",
    columns: [[-5, 2, 2], [3, -4]], split: 2, positive: 0.0012, loads: [0.0002] },
  { name: "source-side pruning baseline with split ballast", status: "short", split: 2 },
  { name: "source-side leaves and self-loops preserve port response and physical zero currents", status: "short", split: 2, decorations: true },
  { name: "zero original output EMF keeps safe private returns closed", status: "closed", columns: [[4, -4], [-4, 4]] },
  { name: "zero output EMF and high common load still preserve private local short", status: "short",
    columns: [[4, -4], [-4, 4]], loads: [0.005], privateResistance: 0.0005, localShort: true },
  { name: "zero common Voc and high common load still preserve circulation short", status: "short",
    columns: [[1], [-1]], positive: 0.0001, negative: 0.0001, loads: [0.005], circulation: true },
  { name: "false partial cuts cannot replace the complete staged parallel load", status: "closed",
    loads: [0.0001, 0.0001, 0.0001], tap: 0.03, alternate: 0.003, partialLoad: true },
  { name: "one-ULP nonzero original string EMF remains a driven short", status: "short",
    columns: [[nextUp(4), -4], [-4, nextUp(4)]], tinyDrive: true },
];

function assertPhysics(value: ReturnType<typeof fixture>, reordered: boolean) {
  const names = new Map(value.document.parts.map((item, i) => [item.id, `${value.document.parts.length - i};|日本語,${item.id}`]));
  const rename = (node: CircuitEndpoint) => ({ ...node, partId: names.get(node.partId)! });
  const document = reordered ? { ...value.document,
    parts: [...value.document.parts].reverse().map((item) => ({ ...item, id: names.get(item.id)! })),
    wires: [...value.document.wires].reverse().map((edge) => ({ ...edge, from: rename(edge.to), to: rename(edge.from) })),
  } : value.document;
  const actual = analyzeCircuit(document);
  for (const [id, expected] of value.readings) {
    const reading = actual.parts[reordered ? names.get(id)! : id];
    if (compare(retained(reading.exactVoltage, reading.voltageVolts), expected.voltage) !== 0) {
      throw new Error(`${id}: retained voltage differs from independent rational oracle`);
    }
    if (compare(retained(reading.exactTerminalCurrents?.a, reading.currentAmps), expected.current) !== 0) {
      throw new Error(`${id}: retained current differs from independent rational oracle`);
    }
    assertCorrectRounding(reading.voltageVolts, expected.voltage, `${id} voltage`);
    assertCorrectRounding(reading.currentAmps, expected.current, `${id} current`);
    assertCorrectRounding(reading.powerWatts, expected.power, `${id} terminal power`);
  }
  for (const [id, current] of value.currents) {
    assertCorrectRounding(actual.wireCurrents[id], reordered ? negate(current) : current, `${id} wire current`);
  }
  return actual;
}

describe("source-group scaling and conservation", () => {
  it.each(cases)("$name", (options) => {
    const value = fixture(options);
    expect(compare(input(equalitySegment), remaining), "threshold fixture is exactly representable binary64").toBe(0);
    expect(remaining.numerator > 0n, "positive compensation resistor").toBe(true);
    expect(value.residuals.every((residual) => residual.numerator === 0n), "exact cell/output KCL and energy conservation including all physical leads").toBe(true);
    expect(value.currents.size, "every wire has an independently computed current").toBe(value.document.wires.length);
    expect(value.localReturns.some((r) => compare(r, threshold) < 0), "independent individual passive returns").toBe(options.localShort ?? false);
    if (options.boundary !== undefined) {
      expect(compare(value.external, threshold), "all-cell Rayleigh lower bound at physical output").toBe(options.boundary);
    }
    if (options.highBallast) {
      expect(compare(input(options.positive!), input(0.003)), "ballast rank is above the private shunt rank").toBe(1);
      for (const magnitude of [3, 4]) {
        const partial = add(value.loadResistance, parallel(value.columns.map((column) =>
          sum([column.outside, ...column.cells.filter((cell) => Math.abs(cell.signed) !== magnitude).map((cell) => cell.shunt.total)]))));
        expect(compare(partial, threshold), `${magnitude} V-only group is above threshold with other cells open`).toBe(1);
      }
    }
    if (options.partialLoad) {
      expect(compare(add(value.outputR, add(input(options.loads![0]), times(lead, 2))), threshold), "tempting partial-load metric is below threshold").toBe(-1);
      expect(compare(value.external, threshold), "entire common load is above threshold").toBe(1);
    }
    if (options.circulation) {
      expect(value.outputVoc.numerator, "exact common Voc is zero").toBe(0n);
      expect(compare(sum(value.columns.map((column) => column.outside)), threshold), "actual source-source circulation resistance is below threshold").toBe(-1);
      expect(subtract(value.columns[0].emf, value.columns[1].emf).numerator, "nonzero circulating drive").not.toBe(0n);
    } else {
      const outputShort = value.outputVoc.numerator !== 0n && compare(value.external, threshold) < 0;
      expect(outputShort || (options.localShort ?? false) ? "short" : "closed", "independent complete-output/local-short classification").toBe(options.status);
    }
    if (options.tinyDrive) {
      expect(compare(value.outputVoc, zero), "one ULP cancellation remains strictly positive").toBe(1);
      expect(compare(value.outputVoc, input(1e-14)), "drive is smaller than ordinary absolute tolerances").toBe(-1);
    }
    expect(assertPhysics(value, false).status, `Rout + complete Rload = ${value.external.numerator}/${value.external.denominator}`).toBe(options.status);
    // Keep exactly two larger circuits; small cases also cover IDs, source
    // partitions, reversed arrays and reversed physical-wire orientation.
    if (!options.highBallast) { expect(assertPhysics(value, true).status, "ID/array/wire reversal invariance").toBe(options.status); }
  });
});
