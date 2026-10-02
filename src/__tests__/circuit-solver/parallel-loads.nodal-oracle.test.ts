import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitPart, CircuitWire } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
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

const one = rational(1n);
const zero = rational(0n);
const input = (value: number) => rationalFromNumber(value)!;
const lead = input(1e-6);
const internal = input(0.1);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const parallel = (values: readonly Rational[]) => divide(one, sum(values.map((value) => divide(one, value))));

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

function documentFor(ballasts: readonly number[], load: number, otherBallast?: number, highEmf = 3): CircuitDocument {
  const document: CircuitDocument = {
    title: "Independent final parallel-load review",
    parts: [part("load", "resistor", { resistanceOhms: load })],
    wires: [],
  };
  for (const [index, ballast] of ballasts.entries()) {
    const id = `s${index}`;
    document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
    if (ballast === 0) {
      document.wires.push(wire(`${id}-in`, "load:a", `${id}:a`));
    } else {
      document.parts.push(part(`ballast${index}`, "resistor", { resistanceOhms: ballast }));
      document.wires.push(wire(`${id}-in`, "load:a", `ballast${index}:a`), wire(`${id}-mid`, `ballast${index}:b`, `${id}:a`));
    }
    document.wires.push(wire(`${id}-out`, `${id}:b`, "load:b"));
  }
  if (otherBallast !== undefined) {
    document.parts.push(
      part("high", "battery", { voltageVolts: highEmf, internalResistanceOhms: 0.1 }),
      part("charging", "battery", { voltageVolts: 2, internalResistanceOhms: 0.1 }),
      part("other-ballast", "resistor", { resistanceOhms: otherBallast }),
    );
    document.wires.push(
      wire("other-in", "load:a", "other-ballast:a"),
      wire("other-mid", "other-ballast:b", "high:a"),
      wire("other-series", "high:b", "charging:b"),
      wire("other-out", "charging:a", "load:b"),
    );
  }
  return document;
}

function cellLeads(ballast: number) {
  return add(input(ballast), multiply(lead, rational(ballast === 0 ? 2n : 3n)));
}

function reversed(document: CircuitDocument): CircuitDocument {
  const batteryIds = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const flip = (endpoint: CircuitWire["from"]): CircuitWire["from"] => batteryIds.has(endpoint.partId)
    ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" } : endpoint;
  return {
    ...document,
    parts: [...document.parts].reverse(),
    wires: [...document.wires].reverse().map((connection) => ({ ...connection, from: flip(connection.to), to: flip(connection.from) })),
  };
}

// Two unknowns suffice even with a load tapped at s0:a. A is load:a,
// P is s0:a, and load:b is ground. Eliminate every untapped wire, then
// apply independent rational Cramer's rule; no production solver is used.
function tappedOracle(tap: number, cellInternal: Rational, other: boolean) {
  const firstResistance = add(cellInternal, lead);
  const firstBallast = add(input(0.0015), multiply(lead, rational(2n)));
  const secondResistance = add(cellInternal, cellLeads(0.0015));
  const otherResistance = sum([multiply(cellInternal, rational(2n)), input(0.01), multiply(lead, rational(4n))]);
  const tapResistance = add(input(tap), multiply(lead, rational(2n)));
  const firstG = divide(one, firstResistance);
  const ballastG = divide(one, firstBallast);
  const secondG = divide(one, secondResistance);
  const otherG = other ? divide(one, otherResistance) : zero;
  const tapG = divide(one, tapResistance);
  const aa = sum([divide(one, input(0.0003)), ballastG, secondG, otherG]);
  const pp = sum([firstG, ballastG, tapG]);
  const driveA = add(secondG, otherG);
  const determinant = subtract(multiply(aa, pp), multiply(ballastG, ballastG));
  const a = divide(add(multiply(driveA, pp), multiply(ballastG, firstG)), determinant);
  const p = divide(add(multiply(firstG, aa), multiply(ballastG, driveA)), determinant);
  return {
    a, p,
    firstCurrent: divide(subtract(p, one), firstResistance),
    secondCurrent: divide(subtract(a, one), secondResistance),
    otherCurrent: other ? divide(subtract(a, one), otherResistance) : zero,
    tapCurrent: divide(p, tapResistance),
  };
}

describe("parallel loads against an independent nodal oracle", () => {
  it("retains a shared short when ballast exceeds the load and an equivalent resistive source path is added", () => {
    const ballasts = [0.0015, 0.0015];
    const load = 0.0002;
    const otherBallast = 0.01;
    const leads = ballasts.map(cellLeads);
    const external = add(input(load), parallel(leads));
    expect(compareRational(external, input(0.001))).toBe(-1);
    expect(compareRational(add(input(load), leads[0]), input(0.001))).toBe(1);
    const baseline = analyzeCircuit(documentFor(ballasts, load));
    expect(baseline.status, baseline.message).toBe("short");

    const document = documentFor(ballasts, load, otherBallast);
    const analysis = analyzeCircuit(document);
    // Every source path has net EMF 1 V. Eliminate the untapped leads;
    // independent scalar KCL determines load voltage and each cell current.
    const sourceResistances = leads.map((resistance) => add(internal, resistance));
    const otherResistance = sum([multiply(internal, rational(2n)), input(otherBallast), multiply(lead, rational(4n))]);
    const sourceEquivalent = parallel([...sourceResistances, otherResistance]);
    const current = divide(one, add(input(load), sourceEquivalent));
    const voltage = multiply(input(load), current);
    assertCorrectRounding(analysis.parts.load.voltageVolts, voltage, "load voltage");
    assertCorrectRounding(analysis.parts.load.currentAmps, current, "load current");
    for (const [index, resistance] of sourceResistances.entries()) {
      const cellCurrent = divide(subtract(voltage, one), resistance);
      assertCorrectRounding(analysis.parts[`s${index}`].currentAmps, cellCurrent, `cell ${index} current`);
      assertCorrectRounding(analysis.parts[`s${index}`].voltageVolts, add(one, multiply(internal, cellCurrent)), `cell ${index} voltage`);
    }
    assertCorrectRounding(analysis.parts.high.currentAmps, divide(subtract(voltage, one), otherResistance), "high current");
    assertCorrectRounding(analysis.parts.charging.currentAmps, divide(subtract(one, voltage), otherResistance), "charging current");
    expect(analysis.status, analysis.message).toBe("short");
  });

  it.each([3, 4])("shares unequal ballast despite an added %s V source path", (highEmf) => {
    const ballasts = [0.0012, 0.0018];
    const load = 0.0002;
    const external = add(input(load), parallel(ballasts.map(cellLeads)));
    expect(compareRational(external, input(0.001))).toBe(-1);
    const original = documentFor(ballasts, load, 0.01, highEmf);
    for (const document of [original, reversed(original)]) {
      const analysis = analyzeCircuit(document);
      expect.soft(analysis.status, analysis.message).toBe("short");
    }
  });

  it("retains a parallel group whose ballast values straddle the load resistance", () => {
    const ballasts = [0.0006, 0.0015, 0.0015, 0.0015];
    const load = 0.0007;
    const leads = ballasts.map(cellLeads);
    const external = add(input(load), parallel(leads));
    expect(compareRational(external, input(0.001))).toBe(-1);
    // The three upper-band cells alone are insufficient. Retaining the
    // fourth cell requires both ballast ranks while excluding the load's
    // intermediate rank, which a contiguous resistance band cannot do.
    expect(compareRational(add(input(load), parallel(leads.slice(1))), input(0.001))).toBe(1);
    expect(analyzeCircuit(documentFor(ballasts, load)).status).toBe("short");
    const original = documentFor(ballasts, load, 0.01);
    const sourceEquivalent = parallel([
      ...leads.map((resistance) => add(internal, resistance)),
      sum([multiply(internal, rational(2n)), input(0.01), multiply(lead, rational(4n))]),
    ]);
    const current = divide(one, add(input(load), sourceEquivalent));
    const voltage = multiply(input(load), current);
    for (const document of [original, reversed(original)]) {
      const analysis = analyzeCircuit(document);
      const sign = document === original ? one : negate(one);
      assertCorrectRounding(analysis.parts.load.currentAmps, multiply(sign, current), "interleaved ballast load current");
      assertCorrectRounding(analysis.parts.load.voltageVolts, multiply(sign, voltage), "interleaved ballast load voltage");
      for (const [index, resistance] of leads.entries()) {
        assertCorrectRounding(analysis.parts[`s${index}`].currentAmps, divide(subtract(voltage, one), add(internal, resistance)), `interleaved cell ${index} current`);
      }
      expect.soft(analysis.status, analysis.message).toBe("short");
    }
  });

  it("shares ballast on both sides without a conductor-only common battery rail", () => {
    const ballasts = [0.0006, 0.0015, 0.0015, 0.0015];
    const load = 0.0007;
    const negativeBallast = 0.000_05;
    const leads = ballasts.map((ballast) => sum([cellLeads(ballast), input(negativeBallast), lead]));
    const external = add(input(load), parallel(leads));
    expect(compareRational(external, input(0.001))).toBe(-1);
    expect(compareRational(add(input(load), leads[0]), input(0.001))).toBe(1);
    for (const otherBallast of [undefined, 0.01]) {
      const original = documentFor(ballasts, load, otherBallast);
      for (const [index] of ballasts.entries()) {
        original.parts.push(part(`negative${index}`, "resistor", { resistanceOhms: negativeBallast }));
        const connection = original.wires.find((candidate) => candidate.id === `s${index}-out`)!;
        connection.to = { partId: `negative${index}`, terminal: "a" };
        original.wires.push(wire(`negative${index}-out`, `negative${index}:b`, "load:b"));
      }
      const sourceResistances = leads.map((resistance) => add(internal, resistance));
      if (otherBallast !== undefined) {
        sourceResistances.push(sum([multiply(internal, rational(2n)), input(otherBallast), multiply(lead, rational(4n))]));
      }
      const current = divide(one, add(input(load), parallel(sourceResistances)));
      const voltage = multiply(input(load), current);
      const analysis = analyzeCircuit(original);
      assertCorrectRounding(analysis.parts.load.currentAmps, current, "two-sided ballast load current");
      assertCorrectRounding(analysis.parts.load.voltageVolts, voltage, "two-sided ballast load voltage");
      for (const [index, resistance] of leads.entries()) {
        assertCorrectRounding(analysis.parts[`s${index}`].currentAmps, divide(subtract(voltage, one), add(internal, resistance)), `two-sided cell ${index} current`);
      }
      expect.soft(analysis.status, analysis.message).toBe("short");
    }
  });

  it.each([0.000_998_5, 0.001_01])("checks a charging equal-EMF subgroup at load=%s", (load) => {
    const external = add(input(load), lead);
    const status = compareRational(external, input(0.001)) < 0 ? "short" : "closed";
    // The 502 V - 2 V path can charge both 1 V cells, but its 10 mΩ
    // ballast prevents its own circulating return from being a short.
    const original = documentFor([0, 0], load, 0.01, 502);
    for (const document of [original, reversed(original)]) {
      const analysis = analyzeCircuit(document);
      expect(analysis.parts.s0.currentAmps).toBeGreaterThan(0);
      expect(analysis.parts.s1.currentAmps).toBeGreaterThan(0);
      expect(analysis.parts.s0.powerWatts).toBeLessThan(0);
      expect(analysis.parts.s1.powerWatts).toBeLessThan(0);
      expect(analysis.status, analysis.message).toBe(status);
    }
  });

  it.each([0, 0.0015])("keeps all actual currents zero in protected consistent cycles with ballast=%s", (ballast) => {
    const loaded = documentFor([ballast, ballast], 0.0002, 0.01);
    const removeLoadEndpoint = (endpoint: CircuitWire["from"]): CircuitWire["from"] => endpoint.partId === "load"
      ? { partId: endpoint.terminal === "a" ? "positive" : "negative", terminal: "a" } : endpoint;
    const original = {
      ...loaded,
      parts: [...loaded.parts.filter((item) => item.id !== "load"), part("positive", "junction"), part("negative", "junction")],
      wires: loaded.wires.map((connection) => ({ ...connection, from: removeLoadEndpoint(connection.from), to: removeLoadEndpoint(connection.to) })),
    };
    for (const document of [original, reversed(original)]) {
      const analysis = analyzeCircuit(document);
      expect(analysis.status, analysis.message).toBe("closed");
      for (const reading of Object.values(analysis.parts)) {
        expect(reading.currentAmps).toBe(0);
        expect(reading.powerWatts).toBe(0);
      }
      for (const current of Object.values(analysis.wireCurrents)) { expect(current).toBe(0); }
      for (const item of document.parts.filter((candidate) => candidate.kind === "battery")) {
        expect(analysis.parts[item.id].voltageVolts).toBe(item.voltageVolts);
      }
    }
  });

  it.each([
    0.001 - 0.001_503 / 2,
    0.001 - 1 / (2 / (0.0015 + 3e-6) + 1 / (0.01 + 4e-6)),
  ].flatMap((boundary) => [nextDown(boundary), nextUp(boundary)]))(
    "crosses the shared ballast threshold at adjacent float load=%s", (load) => {
      const ballasts = [0.0015, 0.0015];
      const leads = ballasts.map(cellLeads);
      const baselineExternal = add(input(load), parallel(leads));
      const baselineStatus = compareRational(baselineExternal, input(0.001)) < 0 ? "short" : "closed";
      expect(analyzeCircuit(documentFor(ballasts, load)).status).toBe(baselineStatus);
      // The reduced 3 V - 2 V path joins the equal net-EMF group and shares
      // its four leads plus ballast. This can legitimately cross a boundary.
      const jointExternal = add(input(load), parallel([...leads, add(input(0.01), multiply(lead, rational(4n)))]));
      const status = compareRational(jointExternal, input(0.001)) < 0 ? "short" : "closed";
      const analysis = analyzeCircuit(documentFor(ballasts, load, 0.01));
      expect(analysis.status, analysis.message).toBe(status);
    },
  );

  it.each([false, true])("keeps passive-load addition monotone (crossing=%s)", (crossing) => {
    const original = documentFor([0, 0], 0.000_999_5, 0.01);
    const baseline = analyzeCircuit(original);
    expect(baseline.status).toBe("closed");
    const extraResistance = crossing ? 1 : 1000;
    const augmented = {
      ...original,
      parts: [...original.parts, part("extra", "resistor", { resistanceOhms: extraResistance })],
      wires: [...original.wires, wire("extra-in", "load:a", "extra:a"), wire("extra-out", "extra:b", "load:b")],
    };
    const effectiveLoad = parallel([input(0.000_999_5), add(input(extraResistance), multiply(lead, rational(2n)))]);
    const external = add(effectiveLoad, lead);
    const status = compareRational(external, input(0.001)) < 0 ? "short" : "closed";
    expect(status).toBe(crossing ? "short" : "closed");
    const analysis = analyzeCircuit(augmented);
    expect(analysis.status, analysis.message).toBe(status);
  });

  it.each([1000, 0.1, 0.02, 0.01])("retains a load tap upstream of one ballast (tap=%s)", (tap) => {
    const original = documentFor([0.0015, 0.0015], 0.0003, 0.01);
    const document = {
      ...original,
      parts: [...original.parts, part("tap", "resistor", { resistanceOhms: tap })],
      wires: [...original.wires, wire("tap-in", "s0:a", "tap:a"), wire("tap-out", "tap:b", "load:b")],
    };
    const expected = tappedOracle(tap, internal, true);
    // All three paths have net EMF 1 V. Remove their cell internal R and
    // jointly drive them; total injected current gives the exact external R.
    const unit = tappedOracle(tap, zero, true);
    const external = divide(one, negate(sum([unit.firstCurrent, unit.secondCurrent, unit.otherCurrent])));
    const status = compareRational(external, input(0.001)) < 0 ? "short" : "closed";
    const analysis = analyzeCircuit(document);
    assertCorrectRounding(analysis.parts.load.voltageVolts, expected.a, "tapped load voltage");
    assertCorrectRounding(analysis.parts.s0.currentAmps, expected.firstCurrent, "tapped cell current");
    assertCorrectRounding(analysis.parts.s1.currentAmps, expected.secondCurrent, "untapped cell current");
    assertCorrectRounding(analysis.parts.tap.currentAmps, expected.tapCurrent, "tap current");
    assertCorrectRounding(analysis.parts.tap.voltageVolts, multiply(input(tap), expected.tapCurrent), "tap voltage");
    expect(analysis.status, analysis.message).toBe(status);
  });

  it("does not merge opposite-polarity cells into an equal-EMF unit drive", () => {
    const original = documentFor([0.0007, 0.0007], 1, 0.01);
    const document = {
      ...original,
      wires: original.wires.map((connection) => ({
        ...connection,
        from: connection.from.partId === "s1" ? { ...connection.from, terminal: connection.from.terminal === "a" ? "b" as const : "a" as const } : connection.from,
        to: connection.to.partId === "s1" ? { ...connection.to, terminal: connection.to.terminal === "a" ? "b" as const : "a" as const } : connection.to,
      })),
    };
    // The opposite cells' shortest circulating return contains both
    // ballasts: 1.406 mΩ. Every passive return is greater still.
    expect(compareRational(multiply(cellLeads(0.0007), rational(2n)), input(0.001))).toBe(1);
    const analysis = analyzeCircuit(document);
    expect(analysis.parts.s0.currentAmps).toBeLessThan(0);
    expect(analysis.parts.s1.currentAmps).toBeLessThan(0);
    expect(analysis.status, analysis.message).toBe("closed");
  });

  it("checks 64 parallel cells inside a larger source block without enumerating subsets", () => {
    const count = 64;
    const load = 0.001_01;
    const original = documentFor(Array.from({ length: count }, () => 0), load, 0.01);
    const analysis = analyzeCircuit(original);
    const localResistance = add(internal, multiply(lead, rational(2n)));
    const otherResistance = sum([multiply(internal, rational(2n)), input(0.01), multiply(lead, rational(4n))]);
    const sourceEquivalent = divide(one, add(divide(rational(BigInt(count)), localResistance), divide(one, otherResistance)));
    const loadCurrent = divide(one, add(input(load), sourceEquivalent));
    const loadVoltage = multiply(input(load), loadCurrent);
    const cellCurrent = divide(subtract(loadVoltage, one), localResistance);
    assertCorrectRounding(analysis.parts.load.currentAmps, loadCurrent, "64-cell load current");
    for (let index = 0; index < count; index += 1) {
      assertCorrectRounding(analysis.parts[`s${index}`].currentAmps, cellCurrent, `cell ${index} current`);
    }
    expect(analysis.status, analysis.message).toBe("closed");
  });
});
