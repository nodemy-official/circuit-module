// biome-ignore-all lint/suspicious/noMisplacedAssertion: Assertion helpers are called only from test bodies.
import { describe, expect, it } from "vitest";
import type {
  CircuitDocument,
  CircuitPart,
  CircuitPartKind,
  CircuitWire,
} from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";

// Independent scalar circuit reductions. No production arithmetic or extended
// solver is used to compute expected values, including binary64 thresholds.
const conductorOhms = 1e-6;
const shortOhms = 1e-3;
const internalOhms = 0.1;

interface Fraction {
  n: bigint;
  d: bigint;
}

function fraction(n: bigint, d = 1n): Fraction {
  let a = n < 0n ? -n : n;
  let b = d < 0n ? -d : d;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
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

function plus(a: Fraction, b: Fraction) {
  return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
}

function times(a: Fraction, b: Fraction) {
  return fraction(a.n * b.n, a.d * b.d);
}

function over(a: Fraction, b: Fraction) {
  return fraction(a.n * b.d, a.d * b.n);
}

function sum(values: readonly Fraction[]) {
  return values.reduce(plus, fraction(0n));
}

function number(value: Fraction) {
  return Number(value.n) / Number(value.d);
}

function belowThreshold(value: Fraction) {
  const threshold = input(shortOhms);
  return value.n * threshold.d < threshold.n * value.d;
}

function parallel(values: readonly Fraction[]) {
  return over(fraction(1n), sum(values.map((value) => over(fraction(1n), value))));
}

function part(id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart {
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

function expectRelative(actual: number, expected: number) {
  if (expected === 0) {
    expect(actual).toBe(0);
  } else {
    expect(actual / expected).toBeCloseTo(1, 12);
  }
}

function variants(document: CircuitDocument) {
  return [
    document,
    { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() },
    { ...document, wires: document.wires.map((connection) => ({
      ...connection, from: connection.to, to: connection.from,
    })) },
  ];
}

function expectConservation(document: CircuitDocument, analysis: CircuitAnalysis) {
  const balances = new Map<string, { residual: number; scale: number }>();
  function add(key: string, value: number) {
    const previous = balances.get(key) ?? { residual: 0, scale: 0 };
    previous.residual += value;
    previous.scale += Math.abs(value);
    balances.set(key, previous);
  }
  let delivered = 0;
  let chemical = 0;
  let internalLoss = 0;
  let passiveLoss = 0;
  let absolutePower = 0;
  for (const item of document.parts) {
    const reading = analysis.parts[item.id];
    for (const [terminal, current] of Object.entries(reading.terminalCurrents ?? {})) {
      add(`${item.id}:${terminal}`, current);
    }
    absolutePower += Math.abs(reading.powerWatts);
    if (item.kind === "battery") {
      delivered += reading.powerWatts;
      chemical -= item.voltageVolts! * reading.currentAmps;
      internalLoss += reading.currentAmps ** 2 * Math.max(item.internalResistanceOhms!, conductorOhms);
    } else {
      passiveLoss += reading.powerWatts;
    }
  }
  for (const connection of document.wires) {
    const current = analysis.wireCurrents[connection.id];
    add(`${connection.from.partId}:${connection.from.terminal}`, current);
    add(`${connection.to.partId}:${connection.to.terminal}`, -current);
    passiveLoss += current ** 2 * conductorOhms;
  }
  for (const { residual, scale } of balances.values()) {
    expect(scale === 0 ? residual : Math.abs(residual) / scale).toBeLessThan(3e-14);
  }
  const scale = Math.max(absolutePower, passiveLoss, internalLoss, Math.abs(chemical));
  if (scale === 0) {
    expect(delivered).toBe(0);
  } else {
    expect(Math.abs(delivered - passiveLoss) / scale).toBeLessThan(3e-14);
    expect(Math.abs(chemical - passiveLoss - internalLoss) / scale).toBeLessThan(3e-14);
  }
}

function withOpenBranches(document: CircuitDocument): CircuitDocument {
  const augmented: CircuitDocument = {
    ...document, parts: [...document.parts], wires: [...document.wires],
  };
  for (const source of document.parts.filter((item) => item.kind === "battery")) {
    for (const terminal of ["a", "b"] as const) {
      const id = `open-${source.id}-${terminal}`;
      augmented.parts.push(
        part(id, "battery", { voltageVolts: 1e20, internalResistanceOhms: 0.3 }),
        part(`${id}-meter`, "ammeter"),
        part(`${id}-stop`, "switch", { initiallyClosed: false }),
      );
      augmented.wires.push(
        wire(`${id}-1`, `${source.id}:${terminal}`, `${id}:b`),
        wire(`${id}-2`, `${id}:a`, `${id}-meter:b`),
        wire(`${id}-3`, `${id}-meter:a`, `${id}-stop:a`),
      );
    }
  }
  return augmented;
}

function expectOpenBranchInvariant(document: CircuitDocument, baseline: CircuitAnalysis) {
  for (const variant of variants(withOpenBranches(document))) {
    const analysis = analyzeCircuit(variant, {}, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe(baseline.status);
    for (const item of document.parts) {
      for (const field of ["currentAmps", "voltageVolts", "powerWatts"] as const) {
        expect(analysis.parts[item.id][field]).toBe(baseline.parts[item.id][field]);
      }
    }
    for (const item of variant.parts.filter((candidate) => candidate.id.startsWith("open-"))) {
      expect(analysis.parts[item.id].currentAmps).toBe(0);
      expect(analysis.parts[item.id].powerWatts).toBe(0);
    }
    expectConservation(variant, analysis);
  }
}

function seriesDocument(emfs: readonly number[], resistance: number, split: boolean): CircuitDocument {
  const count = split ? emfs.length : 1;
  const document: CircuitDocument = {
    title: "Independent series loop and exact threshold",
    parts: [
      ...emfs.map((emf, index) => part(`s${index}`, "battery", {
        voltageVolts: Math.abs(emf), internalResistanceOhms: internalOhms,
      })),
      ...Array.from({ length: count }, (_, index) => part(`r${index}`, "resistor", {
        resistanceOhms: resistance / count,
      })),
    ],
    wires: [],
  };
  for (const [index, emf] of emfs.entries()) {
    const nextIndex = (index + 1) % emfs.length;
    const leaving = `s${index}:${emf > 0 ? "b" : "a"}`;
    const entering = `s${nextIndex}:${emfs[nextIndex] > 0 ? "a" : "b"}`;
    if (split || index === emfs.length - 1) {
      const load = split ? index : 0;
      document.wires.push(wire(`wa${index}`, leaving, `r${load}:a`), wire(`wb${index}`, `r${load}:b`, entering));
    } else {
      document.wires.push(wire(`w${index}`, leaving, entering));
    }
  }
  return document;
}

const seriesCases = [[1], [1, 2], [1, 2, 3], [1, -1], [1, -(1 + 2 ** -40)], [1, -2, 3]];

describe("legacy DC signed series sources and short thresholds", () => {
  // For one cell, splitting the load constructs the identical circuit.
  it.each(seriesCases.flatMap((emfs) => (emfs.length === 1 ? [false] : [false, true]).flatMap((split) =>
    [0.000_995, 0.000_996, 0.000_998, 0.001, 0.001_001, 1].map((resistance) => ({ emfs, split, resistance })),
  )))("checks signed series EMFs and threshold $emfs / $resistance / split=$split", ({ emfs, split, resistance }) => {
    const document = seriesDocument(emfs, resistance, split);
    const emf = sum(emfs.map(input));
    const external = sum([
      ...document.parts.filter((item) => item.kind === "resistor").map((item) => input(item.resistanceOhms!)),
      times(input(conductorOhms), fraction(BigInt(document.wires.length))),
    ]);
    const total = plus(external, times(input(internalOhms), fraction(BigInt(emfs.length))));
    const current = number(over(emf, total));
    const status = emf.n !== 0n && belowThreshold(external) ? "short" : "closed";
    for (const variant of variants(document)) {
      const analysis = analyzeCircuit(variant);
      expect(analysis.status, analysis.message).toBe(status);
      for (const [index, value] of emfs.entries()) {
        const expected = -Math.sign(value) * current;
        expectRelative(analysis.parts[`s${index}`].currentAmps, expected);
        expectRelative(analysis.parts[`s${index}`].voltageVolts, Math.abs(value) + internalOhms * expected);
      }
      for (const load of document.parts.filter((item) => item.kind === "resistor")) {
        expectRelative(analysis.parts[load.id].currentAmps, -current);
        expectRelative(analysis.parts[load.id].powerWatts, current ** 2 * load.resistanceOhms!);
      }
      expectConservation(variant, analysis);
    }
    expectOpenBranchInvariant(document, analyzeCircuit(document));
  });
});

function parallelDocument(emfs: readonly number[], leadOhms: readonly number[], loadOhms?: number): CircuitDocument {
  const document: CircuitDocument = {
    title: "Independent parallel-source scalar KCL",
    parts: [part("p", "junction"), part("n", "junction")],
    wires: [],
  };
  for (const [index, emf] of emfs.entries()) {
    document.parts.push(
      part(`s${index}`, "battery", { voltageVolts: Math.abs(emf), internalResistanceOhms: internalOhms }),
      part(`lead${index}`, "resistor", { resistanceOhms: leadOhms[index] }),
    );
    document.wires.push(
      wire(`pa${index}`, "p:a", `lead${index}:a`),
      wire(`ps${index}`, `lead${index}:b`, `s${index}:${emf > 0 ? "a" : "b"}`),
      wire(`sn${index}`, `s${index}:${emf > 0 ? "b" : "a"}`, "n:a"),
    );
  }
  if (loadOhms !== undefined) {
    document.parts.push(part("load", "resistor", { resistanceOhms: loadOhms }));
    document.wires.push(wire("loadp", "p:a", "load:a"), wire("loadn", "load:b", "n:a"));
  }
  return document;
}

function parallelOracle(emfs: readonly number[], leads: readonly number[], loadOhms?: number) {
  const resistance = leads.map((lead) => sum([input(internalOhms), input(lead), times(input(conductorOhms), fraction(3n))]));
  const load = loadOhms === undefined ? undefined : plus(input(loadOhms), times(input(conductorOhms), fraction(2n)));
  const sourceConductance = sum(resistance.map((value) => over(fraction(1n), value)));
  const drive = sum(resistance.map((value, index) => over(input(emfs[index]), value)));
  const voltage = over(drive, plus(sourceConductance, load ? over(fraction(1n), load) : fraction(0n)));
  const currents = resistance.map((value, index) => over(plus(voltage, input(-emfs[index])), value));
  return { voltage: number(voltage), currents: currents.map(number), loadCurrent: load ? number(over(voltage, load)) : 0 };
}

describe("legacy DC parallel circulation and short thresholds", () => {
  it.each([1, 1 + 2 ** -40, 2, -1, -2].flatMap((second) =>
    [0.001_790_999_9, 0.001_791_000_1, 0.0022].flatMap((returned) =>
      [undefined, 1000].map((load) => ({ second, returned, load })),
    ),
  ))("checks parallel circulation, cancellation and exact boundary $second / $returned / load=$load", ({ second, returned, load }) => {
    const emfs = [1, second, second];
    const leads = [0.0001, returned, returned];
    const document = parallelDocument(emfs, leads, load);
    const returnBranches = leads.slice(1).map((value) => plus(input(value), times(input(conductorOhms), fraction(3n))));
    if (load !== undefined) {
      returnBranches.push(plus(input(load), times(input(conductorOhms), fraction(2n))));
    }
    const returnOhms = parallel(returnBranches);
    const external = plus(plus(input(leads[0]), times(input(conductorOhms), fraction(3n))), returnOhms);
    const oracle = parallelOracle(emfs, leads, load);
    const status = second !== 1 && belowThreshold(external) ? "short" : "closed";
    for (const variant of variants(document)) {
      const analysis = analyzeCircuit(variant);
      expect(analysis.status, analysis.message).toBe(status);
      for (const [index, emf] of emfs.entries()) {
        expectRelative(analysis.parts[`s${index}`].currentAmps, Math.sign(emf) * oracle.currents[index]);
        expectRelative(analysis.parts[`lead${index}`].currentAmps, oracle.currents[index]);
      }
      if (load !== undefined) {
        expectRelative(analysis.parts.load.currentAmps, oracle.loadCurrent);
      }
      expectConservation(variant, analysis);
    }
    expectOpenBranchInvariant(document, analyzeCircuit(document));
  });
});

function reverseBatteryPolarity(document: CircuitDocument): CircuitDocument {
  const batteries = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  function reverse(endpoint: CircuitWire["from"]): CircuitWire["from"] {
    return batteries.has(endpoint.partId)
      ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" }
      : endpoint;
  }
  return {
    ...document,
    wires: document.wires.map((connection) => ({
      ...connection, from: reverse(connection.from), to: reverse(connection.to),
    })),
  };
}

function zeroCirculationDocument(loadOhms?: number): CircuitDocument {
  const document: CircuitDocument = {
    title: "Zero circulating EMF, actively driven passive return",
    parts: [
      part("s1", "battery", { voltageVolts: 1, internalResistanceOhms: internalOhms }),
      part("s2", "battery", { voltageVolts: 2, internalResistanceOhms: internalOhms }),
      part("s3", "battery", { voltageVolts: 3, internalResistanceOhms: internalOhms }),
    ],
    wires: [
      wire("series", "s1:b", "s2:a"), wire("positive", "s1:a", "s3:a"),
      wire("negative", "s2:b", "s3:b"),
    ],
  };
  if (loadOhms !== undefined) {
    for (const id of ["r1", "r2"]) {
      document.parts.push(part(id, "resistor", { resistanceOhms: loadOhms }));
      document.wires.push(wire(`${id}-a`, "s1:a", `${id}:a`), wire(`${id}-b`, `${id}:b`, "s1:b"));
    }
  }
  return document;
}

describe("legacy DC source groups with zero circulation", () => {
  it.each([0.000_49, 0.0005])("keeps the other circulating sources when the first tested cell has exactly zero current (R=%s)", (resistance) => {
    const document = parallelDocument([2, 1, 3], [resistance, resistance, resistance]);
    const oracle = parallelOracle([2, 1, 3], [resistance, resistance, resistance]);
    const external = times(plus(input(resistance), times(input(conductorOhms), fraction(3n))), fraction(2n));
    for (const variant of variants(document)) {
      const analysis = analyzeCircuit(variant);
      expect(analysis.parts.s0.currentAmps).toBe(0);
      expect(analysis.parts.s0.voltageVolts).toBe(2);
      for (const index of [1, 2]) {
        expectRelative(analysis.parts[`s${index}`].currentAmps, oracle.currents[index]);
      }
      expect(analysis.status, analysis.message).toBe(belowThreshold(external) ? "short" : "closed");
      expectConservation(variant, analysis);
    }
  });

  it.each([2, 3, 5].flatMap((count) => [0.001_995, 0.001_997, 0.002_002].map((loadOhms) => ({ count, loadOhms }))))(
    "checks equal parallel cells supplying a near-threshold passive load ($count cells, R=$loadOhms)", ({ count, loadOhms }) => {
      const document: CircuitDocument = {
        title: "Equal parallel cells drive a passive short without circulating EMF",
        parts: [
          part("p", "junction"), part("n", "junction"),
          ...Array.from({ length: count }, (_, index) => part(`s${index}`, "battery", {
            voltageVolts: 1, internalResistanceOhms: internalOhms,
          })),
          part("r1", "resistor", { resistanceOhms: loadOhms }), part("r2", "resistor", { resistanceOhms: loadOhms }),
        ],
        wires: [
          ...Array.from({ length: count }, (_, index) => [
            wire(`sp${index}`, `s${index}:a`, "p:a"), wire(`sn${index}`, `s${index}:b`, "n:a"),
          ]).flat(),
          wire("r1p", "p:a", "r1:a"), wire("r1n", "r1:b", "n:a"),
          wire("r2p", "p:a", "r2:a"), wire("r2n", "r2:b", "n:a"),
        ],
      };
      const leads = times(input(conductorOhms), fraction(2n));
      const load = over(plus(input(loadOhms), leads), fraction(2n));
      const external = plus(load, over(leads, fraction(BigInt(count))));
      const source = over(plus(input(internalOhms), leads), fraction(BigInt(count)));
      const current = number(over(fraction(1n), plus(load, source)));
      for (const variant of variants(document)) {
        const analysis = analyzeCircuit(variant);
        expect(analysis.status, analysis.message).toBe(belowThreshold(external) ? "short" : "closed");
        for (let index = 0; index < count; index += 1) {
          expectRelative(analysis.parts[`s${index}`].currentAmps, -current / count);
        }
        for (const id of ["r1", "r2"]) {
          expectRelative(analysis.parts[id].currentAmps, current / 2);
        }
        expectConservation(variant, analysis);
      }
    },
  );

  it.each([undefined, 0.001_99, 0.001_994, 0.001_996, 0.001_999, 0.002])(
    "retains the individual 1-V passive-return threshold with a consistent source triangle (R=%s)", (loadOhms) => {
      // A 1-V cell and the opposing 3-V/2-V series path are equal-EMF
      // parallel branches. No load means exactly zero current everywhere.
      // Their added passive path cannot increase the first cell's own load R.
      const document = zeroCirculationDocument(loadOhms);
      const firstResistance = input(internalOhms);
      const secondResistance = sum([times(firstResistance, fraction(2n)), times(input(conductorOhms), fraction(3n))]);
      const sourceResistance = parallel([firstResistance, secondResistance]);
      const load = loadOhms === undefined ? undefined
        : over(plus(input(loadOhms), times(input(conductorOhms), fraction(2n))), fraction(2n));
      const loadCurrent = load ? over(fraction(1n), plus(sourceResistance, load)) : fraction(0n);
      const voltageDeficit = times(sourceResistance, loadCurrent);
      const firstCurrent = -number(over(voltageDeficit, firstResistance));
      const secondCurrent = -number(over(voltageDeficit, secondResistance));
      const expectedStatus = load && belowThreshold(load) ? "short" : "closed";
      const statuses: string[] = [];
      for (const [index, variant] of [...variants(document), reverseBatteryPolarity(document)].entries()) {
        const analysis = analyzeCircuit(variant);
        for (const [id, expected] of [["s1", firstCurrent], ["s2", -secondCurrent], ["s3", secondCurrent]] as const) {
          expectRelative(analysis.parts[id].currentAmps, expected);
          const battery = document.parts.find((item) => item.id === id)!;
          expectRelative(analysis.parts[id].voltageVolts, battery.voltageVolts! + internalOhms * expected);
          expectRelative(analysis.parts[id].powerWatts, -(battery.voltageVolts! + internalOhms * expected) * expected);
        }
        if (load) {
          for (const id of ["r1", "r2"]) {
            expectRelative(analysis.parts[id].currentAmps, (index === 3 ? -1 : 1) * number(loadCurrent) / 2);
            expectRelative(analysis.parts[id].powerWatts, (number(loadCurrent) / 2) ** 2 * loadOhms!);
          }
        }
        expectConservation(variant, analysis);
        statuses.push(analysis.status);
      }
      const baseline = analyzeCircuit(document);
      expectOpenBranchInvariant(document, baseline);
      if (loadOhms !== undefined) {
        // Removing the equivalent source path preserves this passive load.
        const single: CircuitDocument = {
          ...document,
          parts: document.parts.filter((item) => item.id !== "s2" && item.id !== "s3"),
          wires: document.wires.filter((connection) => !["series", "positive", "negative"].includes(connection.id)),
        };
        expect(analyzeCircuit(single).status).toBe(expectedStatus);
      }
      expect(statuses).toEqual(Array.from({ length: 4 }, () => expectedStatus));
    },
  );
});

describe("legacy DC conductor energy conservation", () => {
  it.each(["ammeter", "switch"] as const)("accounts for %s loss in a reversed charging-source loop", (kind) => {
    const document: CircuitDocument = {
      title: "Reversed conductors and battery charging",
      parts: [
        part("strong", "battery", { voltageVolts: 12, internalResistanceOhms: 0.2 }),
        part("weak", "battery", { voltageVolts: 3, internalResistanceOhms: 0.4 }),
        part("device", kind, { initiallyClosed: true }),
        part("load", "resistor", { resistanceOhms: 0.000_994 }),
      ],
      wires: [
        wire("w1", "strong:a", "device:b"), wire("w2", "device:a", "load:a"),
        wire("w3", "load:b", "weak:a"), wire("w4", "weak:b", "strong:b"),
      ],
    };
    const external = sum([input(0.000_994), times(input(conductorOhms), fraction(5n))]);
    const current = number(over(input(9), sum([external, input(0.2), input(0.4)])));
    for (const variant of variants(document)) {
      const analysis = analyzeCircuit(variant);
      expect(analysis.status, analysis.message).toBe(belowThreshold(external) ? "short" : "closed");
      expectRelative(analysis.parts.device.currentAmps, -current);
      expectRelative(analysis.parts.device.voltageVolts, -current * conductorOhms);
      expectRelative(analysis.parts.device.powerWatts, current ** 2 * conductorOhms);
      expectRelative(analysis.parts.weak.currentAmps, current);
      expectRelative(analysis.parts.weak.powerWatts, -(3 + 0.4 * current) * current);
      expectConservation(variant, analysis);
    }
  });
});
