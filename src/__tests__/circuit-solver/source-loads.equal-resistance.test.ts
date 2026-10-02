import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitPart, CircuitWire } from "../../circuit-model.js";
import { analyzeCircuit, MAX_CIRCUIT_ANALYSIS_TERMINALS } from "../../circuit-solver.js";
import {
  addRational as add,
  assertCorrectRounding,
  compareRational,
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
const internal = input(0.1);
const threshold = input(0.001);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const parallel = (values: readonly Rational[]) => divide(one, sum(values.map((value) => divide(one, value))));

interface Element {
  id: string;
  resistance: Rational;
  emf: Rational;
  direction: 1 | -1;
}

interface Branch {
  from: string;
  to: string;
  elements: Element[];
  wires: string[];
  driven: boolean;
}

interface Fixture {
  document: CircuitDocument;
  branches: Branch[];
}

interface Source {
  positive: number[];
  negative: number[];
  emfs?: number[];
  driven?: boolean;
}

interface Case {
  load: number[][];
  sources: Source[];
  equivalent?: number;
  tap?: { source: number; resistance: number; after: number; oppositeResistance?: number };
  tapAll?: boolean;
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function fixtureFor(values: Case): Fixture {
  const document: CircuitDocument = { title: "Topology separates equal load and source ballast", parts: [], wires: [] };
  const branches: Branch[] = [];
  const endpoints = new Map<string, CircuitWire["from"]>();
  const endpoint = (id: string, terminal: "a" | "b"): CircuitWire["from"] => ({ partId: id, terminal });
  const addNode = (node: string) => {
    document.parts.push(part(node, "junction"));
    endpoints.set(node, endpoint(node, "a"));
  };
  for (const node of ["P", "N"]) { addNode(node); }
  const resistor = (id: string, resistance: number): Element => {
    document.parts.push(part(id, "resistor", { resistanceOhms: resistance }));
    return { id, resistance: input(resistance), emf: zero, direction: 1 };
  };
  const battery = (id: string, emf: number): Element => {
    document.parts.push(part(id, "battery", { voltageVolts: Math.abs(emf), internalResistanceOhms: 0.1 }));
    return { id, resistance: internal, emf: input(emf), direction: emf < 0 ? -1 : 1 };
  };
  const connect = (id: string, from: CircuitWire["from"], to: CircuitWire["from"]) => {
    document.wires.push({ id, from, to });
    return id;
  };
  const chain = (id: string, from: string, to: string, elements: Element[], driven: boolean, main = false) => {
    const wires: string[] = [];
    const first = elements[0]!;
    const last = elements.at(-1)!;
    if (!main) {
      wires.push(connect(`${id}-in`, endpoints.get(from)!, endpoint(first.id, first.direction > 0 ? "a" : "b")));
    }
    for (let index = 1; index < elements.length; index += 1) {
      const previous = elements[index - 1]!;
      const next = elements[index]!;
      wires.push(connect(`${id}-${index}`, endpoint(previous.id, previous.direction > 0 ? "b" : "a"), endpoint(next.id, next.direction > 0 ? "a" : "b")));
    }
    if (!main) {
      wires.push(connect(`${id}-out`, endpoint(last.id, last.direction > 0 ? "b" : "a"), endpoints.get(to)!));
    }
    branches.push({ from, to, elements, wires, driven });
  };
  for (const [index, segments] of values.load.entries()) {
    const elements = segments.map((resistance, segment) => resistor(`load${index}-${segment}`, resistance));
    if (index === 0) {
      // Use the first load's actual terminals as the common rails, exactly
      // matching the parent's four-cell, four-wire-per-cell reproducer.
      endpoints.set("P", endpoint(elements[0]!.id, "a"));
      endpoints.set("N", endpoint(elements.at(-1)!.id, "b"));
    }
    chain(`load${index}`, "P", "N", elements, false, index === 0);
  }
  const sources: Source[] = [...values.sources];
  if (values.equivalent !== undefined) {
    sources.push({ positive: [0.01], negative: [], emfs: [values.equivalent, -2], driven: values.equivalent === 3 });
  }
  for (const [index, source] of sources.entries()) {
    const positive = source.positive.map((resistance, segment) => resistor(`p${index}-${segment}`, resistance));
    const cells = (source.emfs ?? [1]).map((emf, cell) => battery(`s${index}-${cell}`, emf));
    const negative = source.negative.map((resistance, segment) => resistor(`n${index}-${segment}`, resistance));
    if (values.tap && (values.tap.source === index || values.tapAll && index < values.sources.length)) {
      const tapped = `T${index}`;
      const opposite = `U${index}`;
      addNode(tapped);
      addNode(opposite);
      const before = positive.slice(0, values.tap.after);
      const after = positive.slice(values.tap.after);
      chain(`ballast${index}`, "P", tapped, before, false);
      if (values.tap.oppositeResistance === undefined) {
        chain(`source${index}`, tapped, "N", [...after, ...cells, ...negative], source.driven ?? true);
      } else {
        chain(`source${index}`, tapped, opposite, [...after, ...cells], source.driven ?? true);
        chain(`negative${index}`, opposite, "N", negative, false);
        chain(`opposite-tap${index}`, "P", opposite, [resistor(`opposite-tap${index}`, values.tap.oppositeResistance)], false);
      }
      chain(`tap${index}`, tapped, "N", [resistor(`tap${index}`, values.tap.resistance)], false);
    } else {
      chain(`source${index}`, "P", "N", [...positive, ...cells, ...negative], source.driven ?? true);
    }
  }
  return { document, branches };
}

function equalSources(count: number, positive: number, negative = positive): Source[] {
  return Array.from({ length: count }, () => ({ positive: [positive], negative: [negative] }));
}

// Independent rational KCL after eliminating untapped series nodes. The
// reduced graph retains only the common rails and the actual tap nodes.
// Every resistor, battery internal R and individual 1 µΩ wire remains in
// the exact branch resistance. No production arithmetic/solver is imported.
function branchVoltages(branches: readonly Branch[], resistance: (branch: Branch) => Rational, emf: (branch: Branch) => Rational, fixed: ReadonlyMap<string, Rational>) {
  const nodes = [...new Set(branches.flatMap((branch) => [branch.from, branch.to]))].filter((node) => !fixed.has(node));
  const matrix = nodes.map(() => nodes.map(() => zero));
  const rhs = nodes.map(() => zero);
  for (const branch of branches) {
    const conductance = divide(one, resistance(branch));
    const a = nodes.indexOf(branch.from);
    const b = nodes.indexOf(branch.to);
    const drive = multiply(emf(branch), conductance);
    if (a >= 0) {
      matrix[a][a] = add(matrix[a][a], conductance);
      rhs[a] = add(rhs[a], drive);
      if (b < 0) { rhs[a] = add(rhs[a], multiply(conductance, fixed.get(branch.to)!)); }
    }
    if (b >= 0) {
      matrix[b][b] = add(matrix[b][b], conductance);
      rhs[b] = subtract(rhs[b], drive);
      if (a < 0) { rhs[b] = add(rhs[b], multiply(conductance, fixed.get(branch.from)!)); }
    }
    if (a >= 0 && b >= 0) {
      matrix[a][b] = subtract(matrix[a][b], conductance);
      matrix[b][a] = subtract(matrix[b][a], conductance);
    }
  }
  for (let pivot = 0; pivot < nodes.length; pivot += 1) {
    const divisor = matrix[pivot][pivot];
    for (let column = pivot; column < nodes.length; column += 1) {
      matrix[pivot][column] = divide(matrix[pivot][column], divisor);
    }
    rhs[pivot] = divide(rhs[pivot], divisor);
    for (let row = 0; row < nodes.length; row += 1) {
      if (row === pivot) { continue; }
      const factor = matrix[row][pivot];
      for (let column = pivot; column < nodes.length; column += 1) {
        matrix[row][column] = subtract(matrix[row][column], multiply(factor, matrix[pivot][column]));
      }
      rhs[row] = subtract(rhs[row], multiply(factor, rhs[pivot]));
    }
  }
  return (node: string) => fixed.get(node) ?? rhs[nodes.indexOf(node)]!;
}

function oracle(fixture: Fixture) {
  const resistance = (branch: Branch) => sum([
    ...branch.elements.map((element) => element.resistance),
    multiply(lead, rational(BigInt(branch.wires.length))),
  ]);
  const emf = (branch: Branch) => sum(branch.elements.map((element) => element.emf));
  const voltage = branchVoltages(fixture.branches, resistance, emf, new Map([["N", zero]]));
  const currents = new Map<Branch, Rational>();
  for (const branch of fixture.branches) {
    const current = divide(subtract(subtract(voltage(branch.from), voltage(branch.to)), emf(branch)), resistance(branch));
    currents.set(branch, current);
  }
  return { currents };
}

function variant(document: CircuitDocument, reverseCells: boolean, reverseWires: boolean): CircuitDocument {
  const cells = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const flip = (endpoint: CircuitWire["from"]): CircuitWire["from"] => reverseCells && cells.has(endpoint.partId)
    ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" } : endpoint;
  return {
    ...document,
    parts: [...document.parts].reverse(),
    wires: [...document.wires].reverse().map((wire) => ({
      ...wire,
      from: flip(reverseWires ? wire.to : wire.from),
      to: flip(reverseWires ? wire.from : wire.to),
    })),
  };
}

// The fixture's common output is P-N. Keep all intermediate tap nodes inside
// their source branches, suppress selected cells, and eliminate them exactly.
// Add the resulting output resistance to the common passive load resistance;
// local source/shunt dissipation never participates in this loop resistance.
function externalOutputResponse(fixture: Fixture) {
  const passive = (branch: Branch) => branch.elements.every((element) => element.emf.numerator === 0n);
  const loads = fixture.branches.filter((branch) => branch.from === "P" && branch.to === "N" && passive(branch));
  if (loads.length === 0) { return null; }
  const resistance = (branch: Branch) => sum([
    ...branch.elements.map((element) => element.emf.numerator === 0n ? element.resistance : zero),
    multiply(lead, rational(BigInt(branch.wires.length))),
  ]);
  const sourceBranches = fixture.branches.filter((branch) => !loads.includes(branch) && (branch.driven || passive(branch)));
  const suppressed = branchVoltages(sourceBranches, resistance, () => zero, new Map([["P", one], ["N", zero]]));
  const outputConductance = sum(sourceBranches.map((branch) => {
    const current = divide(subtract(suppressed(branch.from), suppressed(branch.to)), resistance(branch));
    return branch.from === "P" ? current : branch.to === "P" ? negate(current) : zero;
  }));
  if (outputConductance.numerator === 0n) { return null; }
  const open = branchVoltages(sourceBranches, resistance, (branch) => sum(branch.elements.map((element) => element.emf)), new Map([["N", zero]]));
  return { resistance: add(parallel(loads.map(resistance)), divide(one, outputConductance)), voltage: open("P") };
}

function verify(fixture: Fixture, expectedStatus?: "closed" | "short", variants = true) {
  const expected = oracle(fixture);
  const output = externalOutputResponse(fixture);
  const external = output?.resistance ?? null;
  const status = output && output.voltage.numerator !== 0n && compareRational(output.resistance, threshold) < 0 ? "short" : "closed";
  if (expectedStatus && status !== expectedStatus) { throw new Error(`Independent oracle expected ${expectedStatus}, calculated ${status}`); }
  const permutations = variants ? [[false, false], [true, false], [false, true], [true, true]] : [[false, false]];
  for (const [reverseCells, reverseWires] of permutations) {
    const document = reverseCells || reverseWires ? variant(fixture.document, reverseCells, reverseWires) : fixture.document;
    const analysis = analyzeCircuit(document);
    for (const branch of fixture.branches) {
      const rawCurrent = expected.currents.get(branch)!;
      for (const element of branch.elements) {
        const battery = element.emf.numerator !== 0n;
        const direction = battery ? element.direction : reverseCells ? -1 : 1;
        const current = direction < 0 ? negate(rawCurrent) : rawCurrent;
        const emf = element.direction < 0 ? negate(element.emf) : element.emf;
        const voltage = add(emf, multiply(element.resistance, current));
        const power = multiply(voltage, battery ? negate(current) : current);
        assertCorrectRounding(analysis.parts[element.id].currentAmps, current, `${element.id}: current`);
        assertCorrectRounding(analysis.parts[element.id].voltageVolts, voltage, `${element.id}: voltage`);
        assertCorrectRounding(analysis.parts[element.id].powerWatts, power, `${element.id}: power`);
      }
      for (const id of branch.wires) {
        const current = reverseCells !== reverseWires ? negate(rawCurrent) : rawCurrent;
        assertCorrectRounding(analysis.wireCurrents[id], current, `${id}: wire current`);
      }
    }
    if (analysis.status !== status) { throw new Error(`Expected ${status}, received ${analysis.status}: ${analysis.message}`); }
  }
  return { status, external, expected, outputVoltage: output?.voltage ?? null };
}

describe("equal-resistance source/load topology audit", () => {
  it.each([0.0004, 0.0007, 0.001].flatMap((resistance) => [undefined, 3].map((equivalent) => ({ resistance, equivalent }))))(
    "separates a common load from equal ballast on both cell sides (%j)", ({ resistance, equivalent }) => {
      const fixture = fixtureFor({ load: [[resistance]], sources: equalSources(4, resistance), equivalent });
      const leadResistance = add(multiply(input(resistance), rational(2n)), multiply(lead, rational(4n)));
      const external = add(input(resistance), parallel([
        ...Array.from({ length: 4 }, () => leadResistance),
        ...equivalent === undefined ? [] : [add(input(0.01), multiply(lead, rational(4n)))],
      ]));
      const result = verify(fixture);
      expect(compareRational(result.external!, external)).toBe(0);
      expect(result.status).toBe(resistance === 0.0004 ? "short" : "closed");
      if (equivalent === 3) {
        expect(result.expected.currents.get(fixture.branches.at(-1)!)!.numerator).toBeLessThan(0n);
      }
    },
  );

  it.each([undefined, 3])("cuts multiple parallel loads together (equivalent=%s)", (equivalent) => {
    const resistance = 0.0012;
    const fixture = fixtureFor({ load: [[resistance], [resistance], [resistance]], sources: equalSources(8, resistance), equivalent });
    // Each load alone and each cell alone exceed the threshold; only the
    // parallel load plus the parallel two-sided ballast crosses it.
    const ballast = add(multiply(input(resistance), rational(2n)), multiply(lead, rational(4n)));
    expect(compareRational(add(input(resistance), divide(ballast, rational(8n))), threshold)).toBe(1);
    verify(fixture, "short");
  });

  it.each([undefined, 3])("retains series-split loads and ballasts, including equal segment values (equivalent=%s)", (equivalent) => {
    const fixture = fixtureFor({
      load: [[0.0002, 0.0002], [0.0004, 0.0004]],
      sources: Array.from({ length: 4 }, () => ({ positive: [0.0002, 0.0002], negative: [0.0001, 0.0002, 0.0001] })),
      equivalent,
    });
    verify(fixture, "short");
  });

  it.each([undefined, 3])("groups unequal ballasts on both sides across the load's rank (equivalent=%s)", (equivalent) => {
    const fixture = fixtureFor({
      load: [[0.0007]],
      sources: [
        { positive: [0.0006], negative: [0.000_05] },
        { positive: [0.0015], negative: [0.000_05] },
        { positive: [0.0015], negative: [0.000_05] },
        { positive: [0.0015], negative: [0.000_05] },
      ],
      equivalent,
    });
    verify(fixture, "short");
  });

  it.each([0.0004, 0.0007].flatMap((load) => [0.0004, 0.01, 1000].flatMap((tap) => [undefined, 3].map((equivalent) => ({ load, tap, equivalent }))))) (
    "keeps an intermediate ballast tap in the output response (%j)", ({ load, tap, equivalent }) => {
      const sources = equalSources(4, load);
      sources[0].positive = [load / 2, load / 2];
      const fixture = fixtureFor({ load: [[load]], sources, equivalent, tap: { source: 0, resistance: tap, after: 1 } });
      const result = verify(fixture);
      // The tap is a separate passive path. Do not replace its current by
      // the first cell's current or infer resistance from actual E/I.
      const tapBranch = fixture.branches.find((branch) => branch.elements[0]?.id === "tap0")!;
      const sourceBranch = fixture.branches.find((branch) => branch.elements.some((element) => element.id === "s0-0"))!;
      expect(compareRational(result.expected.currents.get(tapBranch)!, result.expected.currents.get(sourceBranch)!)).not.toBe(0);
    },
  );

  it.each([undefined, 3])("uses exact threshold comparisons at adjacent floats with equal load/ballast (equivalent=%s)", (equivalent) => {
    const approximateBoundary = equivalent === undefined ? (0.001 - 1e-6) / 1.5 : 0.000_672_74;
    // Locate a binary64 boundary by independent rational comparisons; this
    // also accounts for sharing the added 3 V - 2 V path's physical leads.
    const external = (resistance: number) => add(input(resistance), parallel([
      ...Array.from({ length: 4 }, () => add(multiply(input(resistance), rational(2n)), multiply(lead, rational(4n)))),
      ...equivalent === undefined ? [] : [add(input(0.01), multiply(lead, rational(4n)))],
    ]));
    let lower = 0.0006;
    let upper = 0.0008;
    let candidate = approximateBoundary;
    while (nextUp(lower) < upper) {
      if (compareRational(external(candidate), threshold) < 0) { lower = candidate; }
      else { upper = candidate; }
      candidate = lower + (upper - lower) / 2;
      if (candidate === lower || candidate === upper) { break; }
    }
    expect(nextUp(lower)).toBe(upper);
    expect(nextDown(upper)).toBe(lower);
    expect(verify(fixtureFor({ load: [[lower]], sources: equalSources(4, lower), equivalent })).status).toBe("short");
    expect(verify(fixtureFor({ load: [[upper]], sources: equalSources(4, upper), equivalent })).status).toBe("closed");
  });

  it.each([0.0012, 0.0024].flatMap((resistance) => [undefined, 3].map((equivalent) => ({ resistance, equivalent }))))(
    "distinguishes equal-valued ballast, load and crossed upstream taps (%j)", ({ resistance, equivalent }) => {
      const fixture = fixtureFor({
        load: [[resistance]], sources: equalSources(2, resistance), equivalent,
        tap: { source: 0, after: 1, resistance, oppositeResistance: resistance },
      });
      verify(fixture, "closed");
    },
  );

  it.each([2, 3].flatMap((count) => [0.0012, 0.002, 0.004].map((resistance) => ({ count, resistance }))))(
    "keeps a balanced output closed when every source has crossed taps (%j)", ({ count, resistance }) => {
      const fixture = fixtureFor({
        load: [[resistance]], sources: equalSources(count, resistance), tapAll: true,
        tap: { source: 0, after: 1, resistance, oppositeResistance: resistance },
      });
      // Symmetry gives V(P)=V(N) and zero actual load current. A cell's
      // local return is greater than 1 mΩ. Suppressing the cell leaves an
      // output resistance R+2 µΩ; its nonzero local supply power is not
      // common-load drive, whose open-circuit voltage is exactly zero.
      const external = add(input(resistance), divide(add(input(resistance), multiply(lead, rational(2n))), rational(BigInt(count))));
      const result = verify(fixture);
      expect(compareRational(result.external!, external)).toBe(0);
      expect(result.outputVoltage!.numerator).toBe(0n);
      expect(result.expected.currents.get(fixture.branches[0])!.numerator).toBe(0n);
    },
  );

  it.each([undefined, 3])("protects an unloaded zero-EMF source loop (equivalent=%s)", (equivalent) => {
    const fixture = fixtureFor({ load: [], sources: equalSources(4, 0.0004), equivalent });
    const result = verify(fixture, "closed");
    expect(result.external).toBeNull();
    for (const current of result.expected.currents.values()) { expect(current.numerator).toBe(0n); }
  });

  it.each([0.0004, 0.0007])("tests the passive load even while all four local cells charge (R=%s)", (resistance) => {
    const fixture = fixtureFor({ load: [[resistance]], sources: equalSources(4, resistance), equivalent: 1002 });
    const result = verify(fixture);
    for (const branch of fixture.branches.filter((candidate) => candidate.driven)) {
      expect(result.expected.currents.get(branch)!.numerator).toBeGreaterThan(0n);
    }
    expect(result.status).toBe(resistance === 0.0004 ? "short" : "closed");
  });

  it.each([[], [[0.0011]], [[0.0004]]].map((load) => ({ load })))("does not group equal-voltage series cells as parallel (loads=%j)", ({ load }) => {
    const fixture = fixtureFor({
      load,
      sources: [
        { positive: [0.0004], negative: [0.0004], emfs: [1, 1, 1, 1] },
        { positive: [0.0004], negative: [0.0004], emfs: [1, 1, 1, 1] },
      ],
    });
    // Each series string contributes its entire physical lead resistance;
    // normalizing to one volt never divides that resistance by four cells.
    verify(fixture, load.length === 0 || load[0][0] === 0.0011 ? "closed" : "short");
  });

  it("preserves a protected 1 V + 1 V versus 2 V zero-EMF loop", () => {
    verify(fixtureFor({ load: [], sources: [
      { positive: [0.0004], negative: [0.0004], emfs: [1, 1] },
      { positive: [0.0004], negative: [0.0004], emfs: [2] },
    ] }), "closed");
  });

  it("keeps opposite-polarity cells in different drive groups", () => {
    const fixture = fixtureFor({ load: [[1]], sources: [
      { positive: [0.0004], negative: [0.0004], emfs: [1] },
      { positive: [0.0004], negative: [0.0004], emfs: [-1], driven: false },
    ] });
    // The circulating return includes both cells' two-sided ballasts.
    expect(compareRational(add(multiply(input(0.0004), rational(4n)), multiply(lead, rational(8n))), threshold)).toBe(1);
    verify(fixture, "closed");
  });

  it.each([0.0004, 0.001_01])("checks 64 two-sided cells at the public terminal limit without subset enumeration (load=%s)", (load) => {
    const fixture = fixtureFor({ load: [[load]], sources: equalSources(64, 0.0007), equivalent: 3 });
    let terminals = fixture.document.parts.reduce((count, item) => count + (item.kind === "junction" ? 1 : 2), 0);
    while (terminals < MAX_CIRCUIT_ANALYSIS_TERMINALS) {
      fixture.document.parts.push(part(`unused${terminals}`, "junction"));
      terminals += 1;
    }
    expect(terminals).toBe(MAX_CIRCUIT_ANALYSIS_TERMINALS);
    verify(fixture, load === 0.0004 ? "short" : "closed", false);
  });
});
