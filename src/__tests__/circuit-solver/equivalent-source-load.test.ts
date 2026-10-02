// biome-ignore-all lint/suspicious/noMisplacedAssertion: Assertions are helpers invoked by tests.
import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitPart, CircuitWire } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";

// Independent rational KCL, including the exact binary64 inputs and wire loss.
// Expected values never use production arithmetic or another circuit solver.
interface Fraction {
  n: bigint;
  d: bigint;
}

function fraction(n: bigint, d = 1n): Fraction {
  let a = n < 0n ? -n : n;
  let b = d < 0n ? -d : d;
  while (b !== 0n) { [a, b] = [b, a % b]; }
  const divisor = (a || 1n) * (d < 0n ? -1n : 1n);
  return { n: n / divisor, d: d / divisor };
}

function input(value: number): Fraction {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number(bits / 2n ** 52n % 2048n);
  const mantissa = bits % 2n ** 52n;
  const signed = (bits / 2n ** 63n === 0n ? 1n : -1n)
    * (exponent === 0 ? mantissa : mantissa + 2n ** 52n);
  const shift = exponent === 0 ? -1074 : exponent - 1075;
  return shift < 0 ? fraction(signed, 2n ** BigInt(-shift))
    : fraction(signed * 2n ** BigInt(shift));
}

function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
}

function multiply(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.n, a.d * b.d);
}

function divide(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.d, a.d * b.n);
}

function negate(value: Fraction): Fraction {
  return { n: -value.n, d: value.d };
}

function sum(values: readonly Fraction[]): Fraction {
  return values.reduce(add, fraction(0n));
}

function asNumber(value: Fraction): number {
  return Number(value.n) / Number(value.d);
}

const one = fraction(1n);
const lead = input(1e-6);
const internal = input(0.1);

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, to: string): CircuitWire {
  const [fromPart, fromTerminal] = from.split(":");
  const [toPart, toTerminal] = to.split(":");
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal as "a" | "b" },
    to: { partId: toPart, terminal: toTerminal as "a" | "b" },
  };
}

function addLoad(document: CircuitDocument, id: string, from: string, to: string, resistanceOhms: number) {
  document.parts.push(part(id, "resistor", { resistanceOhms }));
  document.wires.push(wire(`${id}-a`, from, `${id}:a`), wire(`${id}-b`, `${id}:b`, to));
}

interface SourceCase {
  secondEmf: number;
  loadOhms?: number;
  extraSource: boolean;
  weakLoad: boolean;
}

function sourceTriangle({ secondEmf, loadOhms, extraSource, weakLoad }: SourceCase): CircuitDocument {
  const document: CircuitDocument = {
    title: "Equivalent source path retains the local passive short",
    parts: [
      part("local", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
      part("charging", "battery", { voltageVolts: secondEmf, internalResistanceOhms: 0.1 }),
      part("strong", "battery", { voltageVolts: secondEmf + 1, internalResistanceOhms: 0.1 }),
    ],
    wires: [
      wire("series", "local:b", "charging:a"),
      wire("positive", "local:a", "strong:a"),
      wire("negative", "charging:b", "strong:b"),
    ],
  };
  if (loadOhms !== undefined) {
    addLoad(document, "r1", "local:a", "local:b", loadOhms);
    addLoad(document, "r2", "local:a", "local:b", loadOhms);
  }
  if (extraSource) {
    document.parts.push(part("parallel", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
    document.wires.push(wire("parallel-a", "local:a", "parallel:a"), wire("parallel-b", "parallel:b", "local:b"));
  }
  if (weakLoad) {
    addLoad(document, "weak-local", "local:a", "local:b", 1000);
    addLoad(document, "weak-high", "local:b", "charging:b", 1000);
  }
  return document;
}

function triangleOracle({ secondEmf, loadOhms, extraSource, weakLoad }: SourceCase) {
  const loadResistance = loadOhms === undefined ? undefined : add(input(loadOhms), multiply(lead, fraction(2n)));
  const weakResistance = add(input(1000), multiply(lead, fraction(2n)));
  const firstG = divide(one, internal);
  const secondG = divide(one, add(internal, lead));
  const strongG = divide(one, add(internal, multiply(lead, fraction(2n))));
  const parallelG = extraSource ? divide(one, add(internal, multiply(lead, fraction(2n)))) : fraction(0n);
  const localG = sum([
    loadResistance ? divide(fraction(2n), loadResistance) : fraction(0n),
    weakLoad ? divide(one, weakResistance) : fraction(0n),
  ]);
  const weakG = weakLoad ? divide(one, weakResistance) : fraction(0n);
  // Reference is local:b. Unknowns are local:a and charging:b; eliminating
  // the untapped source leads gives a two-node KCL system solved by Cramer.
  const aa = sum([firstG, parallelG, localG, strongG]);
  const cc = sum([secondG, strongG, weakG]);
  const driveA = sum([firstG, parallelG, multiply(input(secondEmf + 1), strongG)]);
  const driveC = negate(sum([multiply(input(secondEmf), secondG), multiply(input(secondEmf + 1), strongG)]));
  const determinant = add(multiply(aa, cc), negate(multiply(strongG, strongG)));
  const a = divide(add(multiply(driveA, cc), multiply(strongG, driveC)), determinant);
  const c = divide(add(multiply(driveC, aa), multiply(strongG, driveA)), determinant);
  const currents: Record<string, Fraction> = {
    local: multiply(add(a, negate(one)), firstG),
    charging: multiply(negate(add(c, input(secondEmf))), secondG),
    strong: multiply(sum([a, negate(c), input(-(secondEmf + 1))]), strongG),
  };
  if (loadResistance) {
    currents.r1 = divide(a, loadResistance);
    currents.r2 = currents.r1;
  }
  if (extraSource) { currents.parallel = multiply(add(a, negate(one)), parallelG); }
  if (weakLoad) {
    currents["weak-local"] = divide(a, weakResistance);
    currents["weak-high"] = divide(negate(c), weakResistance);
  }
  const passiveResistance = localG.n === 0n ? undefined : divide(one, localG);
  const threshold = input(0.001);
  const status = passiveResistance && passiveResistance.n * threshold.d < threshold.n * passiveResistance.d
    ? "short" : "closed";
  return { currents, status };
}

function reversePolarity(document: CircuitDocument): CircuitDocument {
  const batteries = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const reverse = (endpoint: CircuitWire["from"]): CircuitWire["from"] => batteries.has(endpoint.partId)
    ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" } : endpoint;
  return { ...document, wires: document.wires.map((connection) => ({
    ...connection, from: reverse(connection.from), to: reverse(connection.to),
  })) };
}

function withOpenSource(document: CircuitDocument): CircuitDocument {
  return {
    ...document,
    parts: [...document.parts, part("open", "battery", { voltageVolts: 1e20, internalResistanceOhms: 0.3 })],
    wires: [...document.wires, wire("open-lead", "local:a", "open:b")],
  };
}

function variants(document: CircuitDocument) {
  return [
    { document, sign: 1 },
    { document: { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }, sign: 1 },
    { document: { ...document, wires: document.wires.map((connection) => ({
      ...connection, from: connection.to, to: connection.from,
    })) }, sign: 1 },
    { document: reversePolarity(document), sign: -1 },
    { document: withOpenSource(document), sign: 1 },
  ];
}

function expectFraction(actual: number, expected: Fraction) {
  if (expected.n === 0n) { expect(actual).toBe(0); }
  else { expect(actual / asNumber(expected)).toBeCloseTo(1, 12); }
}

function expectConservation(document: CircuitDocument, analysis: CircuitAnalysis) {
  const balances = new Map<string, { residual: number; scale: number }>();
  const accumulate = (endpoint: string, current: number) => {
    const previous = balances.get(endpoint) ?? { residual: 0, scale: 0 };
    balances.set(endpoint, { residual: previous.residual + current, scale: previous.scale + Math.abs(current) });
  };
  let sourcePower = 0;
  let chemicalPower = 0;
  let internalPower = 0;
  let passivePower = 0;
  let scale = 0;
  for (const item of document.parts) {
    const reading = analysis.parts[item.id];
    for (const [terminal, current] of Object.entries(reading.terminalCurrents ?? {})) {
      accumulate(`${item.id}:${terminal}`, current);
    }
    scale += Math.abs(reading.powerWatts);
    if (item.kind === "battery") {
      sourcePower += reading.powerWatts;
      chemicalPower -= item.voltageVolts! * reading.currentAmps;
      internalPower += reading.currentAmps ** 2 * item.internalResistanceOhms!;
    } else { passivePower += reading.powerWatts; }
  }
  for (const connection of document.wires) {
    const current = analysis.wireCurrents[connection.id];
    accumulate(`${connection.from.partId}:${connection.from.terminal}`, current);
    accumulate(`${connection.to.partId}:${connection.to.terminal}`, -current);
    passivePower += current ** 2 * 1e-6;
  }
  for (const { residual, scale: currentScale } of balances.values()) {
    expect(currentScale === 0 ? residual : Math.abs(residual) / currentScale).toBeLessThan(3e-14);
  }
  scale = Math.max(scale, internalPower, passivePower, Math.abs(chemicalPower));
  expect(scale === 0 ? sourcePower : Math.abs(sourcePower - passivePower) / scale).toBeLessThan(3e-14);
  expect(scale === 0 ? chemicalPower : Math.abs(chemicalPower - internalPower - passivePower) / scale).toBeLessThan(3e-14);
}

const sourceCases = [2, 7, 2 ** 30].flatMap((secondEmf) =>
  [undefined, 0.001_994, 0.001_996, 0.001_997_999_9, 0.001_998_000_1, 0.002].flatMap((loadOhms) =>
    [false, true].flatMap((extraSource) => [false, true].map((weakLoad) => ({ secondEmf, loadOhms, extraSource, weakLoad }))),
  ),
);

describe("local passive shorts under equivalent battery paths", () => {
  it.each(sourceCases)(
    "keeps the 1-V load classification with $secondEmf-V charging cell, load=$loadOhms, extra=$extraSource, weak=$weakLoad",
    (values) => {
      const original = sourceTriangle(values);
      const oracle = triangleOracle(values);
      for (const { document, sign } of variants(original)) {
        const analysis = analyzeCircuit(document, {}, { mode: "dc" });
        expect(analysis.status, analysis.message).toBe(oracle.status);
        for (const item of original.parts) {
          const current = oracle.currents[item.id];
          const expectedCurrent = item.kind === "battery" || sign === 1 ? current : negate(current);
          const expectedVoltage = item.kind === "battery"
            ? add(input(item.voltageVolts!), multiply(internal, current))
            : multiply(input(item.resistanceOhms!), expectedCurrent);
          const expectedPower = multiply(expectedVoltage, item.kind === "battery" ? negate(current) : expectedCurrent);
          expectFraction(analysis.parts[item.id].currentAmps, expectedCurrent);
          expectFraction(analysis.parts[item.id].voltageVolts, expectedVoltage);
          expectFraction(analysis.parts[item.id].powerWatts, expectedPower);
        }
        if (document.parts.some((item) => item.id === "open")) {
          expect(analysis.parts.open.currentAmps).toBe(0);
          expect(analysis.parts.open.powerWatts).toBe(0);
          expect(analysis.wireCurrents["open-lead"]).toBe(0);
        }
        expectConservation(document, analysis);
      }
      // Removing equivalent sources leaves the same independent passive R.
      const single = { ...original,
        parts: original.parts.filter((item) => ["local", "r1", "r2", "weak-local"].includes(item.id)),
        wires: original.wires.filter((connection) => connection.id.startsWith("r") || connection.id.startsWith("weak-local")),
      };
      expect(analyzeCircuit(single).status).toBe(single.wires.length === 0 ? "open" : oracle.status);
    },
  );

  it.each([2 ** -10, 2 ** -9])("checks the load when the local cell has exactly zero current (R=%s)", (resistance) => {
    const original: CircuitDocument = {
      title: "Balanced local cell with a driven passive return",
      parts: [
        part("local", "battery", { voltageVolts: 1, internalResistanceOhms: 8e-6 }),
        part("charging", "battery", { voltageVolts: 14, internalResistanceOhms: 8e-6 }),
        part("strong", "battery", { voltageVolts: 15, internalResistanceOhms: 8e-6 }),
      ],
      wires: [wire("negative", "charging:b", "strong:b")],
    };
    addLoad(original, "load", "local:a", "local:b", resistance);
    addLoad(original, "weak", "local:b", "charging:b", 7 * resistance);
    const connect = (id: string, from: string, to: string, count: number) => {
      let previous = from;
      for (let position = 0; position < count - 1; position += 1) {
        const next = `${id}-${position}`;
        original.parts.push(part(next, "junction"));
        original.wires.push(wire(`${next}-wire`, previous, `${next}:a`));
        previous = `${next}:a`;
      }
      original.wires.push(wire(`${id}-last`, previous, to));
    };
    connect("series", "local:b", "charging:a", 16);
    connect("positive", "local:a", "strong:a", 15);
    // Each high-voltage branch has R=24 µΩ, including its 8 µΩ cell.
    // Independent KCL gives Vlocal=1, Iload=1/(R+2w), Ihigh=-Iload,
    // Iweak=2 Iload, and Ilocal=0 exactly for both binary64 load inputs.
    const loadResistance = add(input(resistance), multiply(lead, fraction(2n)));
    const current = divide(one, loadResistance);
    const status = resistance === 2 ** -10 ? "short" : "closed";
    for (const { document, sign } of variants(original)) {
      const analysis = analyzeCircuit(document);
      expect(analysis.status, analysis.message).toBe(status);
      expect(analysis.parts.local.currentAmps).toBe(0);
      expect(analysis.parts.local.powerWatts).toBe(0);
      expect(analysis.parts.local.voltageVolts).toBe(1);
      for (const [id, emf] of [["charging", 14], ["strong", 15]] as const) {
        const voltage = add(input(emf), negate(multiply(input(8e-6), current)));
        expectFraction(analysis.parts[id].currentAmps, negate(current));
        expectFraction(analysis.parts[id].voltageVolts, voltage);
        expectFraction(analysis.parts[id].powerWatts, multiply(voltage, current));
      }
      expectFraction(analysis.parts.load.currentAmps, sign === 1 ? current : negate(current));
      expectFraction(analysis.parts.weak.currentAmps, multiply(current, fraction(BigInt(2 * sign))));
      expectFraction(analysis.parts.load.powerWatts, multiply(multiply(current, current), input(resistance)));
      expectFraction(analysis.parts.weak.powerWatts, multiply(multiply(current, current), input(28 * resistance)));
      expectConservation(document, analysis);
    }
  });
});

describe("protected series battery loops", () => {
  it.each([false, true].flatMap((opposed) => [0.0003, 0.000_75].flatMap((resistance) =>
    [1, 2].map((secondEmf) => ({ opposed, resistance, secondEmf })),
  )))("retains total external R and zero-EMF cancellation ($opposed, $resistance, $secondEmf)", ({ opposed, resistance, secondEmf }) => {
    const original: CircuitDocument = {
      title: "Separated passive sections protect a series-source loop",
      parts: [
        part("local", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
        part("other", "battery", { voltageVolts: secondEmf, internalResistanceOhms: 0.1 }),
        part("r1", "resistor", { resistanceOhms: resistance }),
        part("r2", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("w1", "local:b", "r1:a"), wire("w2", "r1:b", `other:${opposed ? "b" : "a"}`),
        wire("w3", `other:${opposed ? "a" : "b"}`, "r2:a"), wire("w4", "r2:b", "local:a"),
      ],
    };
    const external = sum([multiply(input(resistance), fraction(2n)), multiply(lead, fraction(4n))]);
    const emf = input(1 + (opposed ? -secondEmf : secondEmf));
    const current = divide(emf, add(external, multiply(internal, fraction(2n))));
    const threshold = input(0.001);
    const status = emf.n !== 0n && external.n * threshold.d < threshold.n * external.d ? "short" : "closed";
    for (const { document, sign } of variants(original)) {
      const analysis = analyzeCircuit(document);
      expect(analysis.status, analysis.message).toBe(status);
      expectFraction(analysis.parts.local.currentAmps, negate(current));
      expectFraction(analysis.parts.other.currentAmps, opposed ? current : negate(current));
      for (const id of ["r1", "r2"]) {
        expectFraction(analysis.parts[id].currentAmps, sign === 1 ? negate(current) : current);
      }
      expectConservation(document, analysis);
    }
  });
});
