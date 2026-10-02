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

interface Case {
  count: number;
  load: number;
  ballast: number;
  secondBallast?: number;
  negativeBallast?: number;
  otherBallast?: number;
  highEmf?: number;
  middle?: number;
  device?: "ammeter" | "switch";
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function wire(id: string, from: string, fromTerminal: "a" | "b", to: string, toTerminal: "a" | "b"): CircuitWire {
  return { id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } };
}

function documentFor(values: Case, equivalent: boolean, weak: boolean): CircuitDocument {
  const document: CircuitDocument = {
    title: "A low-voltage parallel subgroup retains its shared passive short",
    parts: [part("load", "resistor", { resistanceOhms: values.load })],
    wires: [],
  };
  for (let index = 0; index < values.count; index += 1) {
    const id = `s${index}`;
    const ballast = index === 1 ? values.secondBallast ?? values.ballast : values.ballast;
    document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
    if (values.device || ballast !== 0) {
      document.parts.push(values.device
        ? part(`lead${index}`, values.device, { initiallyClosed: true })
        : part(`lead${index}`, "resistor", { resistanceOhms: ballast }));
      document.wires.push(wire(`${id}-in`, "load", "a", `lead${index}`, "a"), wire(`${id}-mid`, `lead${index}`, "b", id, "a"));
    } else {
      document.wires.push(wire(`${id}-in`, "load", "a", id, "a"));
    }
    if (values.negativeBallast) {
      document.parts.push(part(`negative${index}`, "resistor", { resistanceOhms: values.negativeBallast }));
      document.wires.push(wire(`${id}-out`, id, "b", `negative${index}`, "a"), wire(`${id}-negative`, `negative${index}`, "b", "load", "b"));
    } else {
      document.wires.push(wire(`${id}-out`, id, "b", "load", "b"));
    }
  }
  if (equivalent) {
    document.parts.push(part("high", "battery", { voltageVolts: values.highEmf ?? 3, internalResistanceOhms: 0.1 }), part("charging", "battery", { voltageVolts: 2, internalResistanceOhms: 0.1 }));
    document.wires.push(wire("high-out", "charging", "a", "load", "b"));
    if (values.otherBallast) {
      document.parts.push(part("other-ballast", "resistor", { resistanceOhms: values.otherBallast }));
      document.wires.push(wire("high-in", "load", "a", "other-ballast", "a"), wire("high-ballast", "other-ballast", "b", "high", "a"));
    } else {
      document.wires.push(wire("high-in", "load", "a", "high", "a"));
    }
    if (values.middle) {
      document.parts.push(part("middle", "resistor", { resistanceOhms: values.middle }));
      document.wires.push(wire("middle-in", "high", "b", "middle", "a"), wire("middle-out", "middle", "b", "charging", "b"));
    } else {
      document.wires.push(wire("high-mid", "high", "b", "charging", "b"));
    }
    if (weak) {
      document.parts.push(part("weak", "resistor", { resistanceOhms: 1000 }));
      document.wires.push(wire("weak-in", "high", "b", "weak", "a"), wire("weak-out", "weak", "b", "load", "b"));
    }
  }
  return document;
}

function lowLeadResistance(values: Case, index = 0) {
  const ballast = index === 1 ? values.secondBallast ?? values.ballast : values.ballast;
  const positive = values.device ? multiply(lead, rational(4n))
    : add(input(ballast), multiply(lead, rational(ballast === 0 ? 2n : 3n)));
  return values.negativeBallast ? sum([positive, input(values.negativeBallast), lead]) : positive;
}

// Independently eliminate untapped leads, then solve rail KCL by Cramer's
// rule. A=load:a and C=high:b; load:b is the reference. The charging
// branch includes the high:b -> charging:b conductor, even with a weak tap.
function oracle(values: Case, equivalent: boolean, weak: boolean) {
  const localResistances = Array.from({ length: values.count }, (_, index) => add(internal, lowLeadResistance(values, index)));
  const localG = sum(localResistances.map((ohms) => divide(one, ohms)));
  const loadG = divide(one, input(values.load));
  let a = divide(localG, add(localG, loadG));
  let c = zero;
  const highEmf = input(values.highEmf ?? 3);
  const highG = divide(one, sum([internal, input(values.otherBallast ?? 0), multiply(lead, rational(values.otherBallast ? 2n : 1n))]));
  const chargingG = divide(one, sum([internal, input(values.middle ?? 0), multiply(lead, rational(values.middle ? 3n : 2n))]));
  if (equivalent) {
    const weakG = weak ? divide(one, add(input(1000), multiply(lead, rational(2n)))) : zero;
    const aa = sum([localG, loadG, highG]);
    const cc = sum([highG, chargingG, weakG]);
    const driveA = add(localG, multiply(highEmf, highG));
    const driveC = negate(add(multiply(highEmf, highG), multiply(rational(2n), chargingG)));
    const determinant = subtract(multiply(aa, cc), multiply(highG, highG));
    a = divide(add(multiply(driveA, cc), multiply(highG, driveC)), determinant);
    c = divide(add(multiply(driveC, aa), multiply(highG, driveA)), determinant);
  }
  const readings: Record<string, { current: Rational; voltage: Rational; power: Rational }> = {};
  const wires: Record<string, Rational> = {};
  const addReading = (id: string, current: Rational, voltage: Rational, battery = false) => {
    readings[id] = { current, voltage, power: multiply(voltage, battery ? negate(current) : current) };
  };
  addReading("load", multiply(a, loadG), a);
  for (let index = 0; index < values.count; index += 1) {
    const id = `s${index}`;
    const ballast = index === 1 ? values.secondBallast ?? values.ballast : values.ballast;
    const localCurrent = divide(subtract(a, one), localResistances[index]);
    addReading(id, localCurrent, add(one, multiply(internal, localCurrent)), true);
    wires[`${id}-in`] = localCurrent;
    wires[`${id}-out`] = localCurrent;
    if (values.negativeBallast) {
      addReading(`negative${index}`, localCurrent, multiply(input(values.negativeBallast), localCurrent));
      wires[`${id}-negative`] = localCurrent;
    }
    if (values.device || ballast !== 0) {
      addReading(`lead${index}`, localCurrent, multiply(values.device ? lead : input(ballast), localCurrent));
      wires[`${id}-mid`] = localCurrent;
    }
  }
  if (equivalent) {
    const highCurrent = multiply(subtract(subtract(a, c), highEmf), highG);
    const chargingCurrent = multiply(subtract(negate(c), rational(2n)), chargingG);
    addReading("high", highCurrent, add(highEmf, multiply(internal, highCurrent)), true);
    addReading("charging", chargingCurrent, add(rational(2n), multiply(internal, chargingCurrent)), true);
    wires["high-in"] = highCurrent;
    if (values.otherBallast) {
      addReading("other-ballast", highCurrent, multiply(input(values.otherBallast), highCurrent));
      wires["high-ballast"] = highCurrent;
    }
    wires["high-out"] = negate(chargingCurrent);
    if (values.middle) {
      const current = negate(chargingCurrent);
      addReading("middle", current, multiply(input(values.middle), current));
      wires["middle-in"] = current;
      wires["middle-out"] = current;
    } else {
      wires["high-mid"] = negate(chargingCurrent);
    }
    if (weak) {
      const current = divide(c, add(input(1000), multiply(lead, rational(2n))));
      addReading("weak", current, multiply(input(1000), current));
      wires["weak-in"] = current;
      wires["weak-out"] = current;
    }
  }
  return { readings, wires };
}

function variants(document: CircuitDocument) {
  const batteries = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const reverse = (endpoint: CircuitWire["from"]): CircuitWire["from"] => batteries.has(endpoint.partId)
    ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" } : endpoint;
  return [
    { document, polarity: 1, wireSign: 1 },
    { document: { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }, polarity: 1, wireSign: 1 },
    { document: { ...document, wires: document.wires.map((connection) => ({ ...connection, from: connection.to, to: connection.from })) }, polarity: 1, wireSign: -1 },
    { document: { ...document, wires: document.wires.map((connection) => ({ ...connection, from: reverse(connection.from), to: reverse(connection.to) })) }, polarity: -1, wireSign: 1 },
    { document: {
      ...document,
      parts: [...document.parts, part("open", "battery", { voltageVolts: 1e20, internalResistanceOhms: 0.3 })],
      wires: [...document.wires, wire("open-lead", "load", "a", "open", "b")],
    }, polarity: 1, wireSign: 1 },
  ];
}

const devices: readonly Case["device"][] = [undefined, "ammeter", "switch"];
const cases: Case[] = [2, 5, 16].flatMap((count) => devices.flatMap((device) => {
  const values: Case = { count, load: 0, ballast: 0, device };
  const boundary = 0.001 - (device ? 4e-6 : 2e-6) / count;
  return [0.000_998_5, nextDown(boundary), nextUp(boundary), 0.001].map((load) => ({ ...values, load }));
}));
cases.push(...[0.000_91, 0.000_925].map((load) => ({ count: 4, load, ballast: 0.0003 })));
cases.push(...[0.000_998_5, 0.000_999_000_1, 0.000_999_05].map((load) => ({ count: 2, load, ballast: 0, middle: 0.0001 })));
cases.push(...[0.0002, 0.000_26].map((load) => ({ count: 2, load, ballast: 0.0015, otherBallast: 0.01 })));
cases.push(...[3, 4].map((highEmf) => ({ count: 2, load: 0.0002, ballast: 0.0012, secondBallast: 0.0018, otherBallast: 0.01, highEmf })));
cases.push({ count: 4, load: 0.0007, ballast: 0.0015, secondBallast: 0.0006, otherBallast: 0.01 });
cases.push({ count: 4, load: 0.0007, ballast: 0.0015, secondBallast: 0.0006, negativeBallast: 0.000_05, otherBallast: 0.01 });
cases.push(...[0.000_998_5, 0.001_01].map((load) => ({ count: 2, load, ballast: 0, otherBallast: 0.01, highEmf: 502 })));

describe("equal-EMF parallel subgroups inside a larger source network", () => {
  const scenarios = cases.flatMap((values) => [[false, false], [true, false], [true, true]].flatMap(([equivalent, weak]) => {
    const original = documentFor(values, equivalent, weak);
    return variants(original).map((variant, index) => ({ ...values, equivalent, weak, original, variant, variantIndex: index }));
  }));
  it.each(scenarios)("keeps the local passive load: count=$count load=$load device=$device ballast=$ballast middle=$middle equivalent=$equivalent weak=$weak variant=$variantIndex", (values) => {
    // Each local cell sees Rload+Rlead in isolation, but jointly their leads
    // contribute Rlead/N. The equal net-EMF series path also contributes its
    // three real leads; its source internal resistance is excluded.
    const equivalentLead = sum([input(values.middle ?? 0), input(values.otherBallast ?? 0), multiply(lead, rational((values.middle ? 4n : 3n) + (values.otherBallast ? 1n : 0n)))]);
    const localLeadG = sum(Array.from({ length: values.count }, (_, index) => divide(one, lowLeadResistance(values, index))));
    const leadG = add(localLeadG, values.equivalent && (values.highEmf ?? 3) === 3 ? divide(one, equivalentLead) : zero);
    const external = add(input(values.load), divide(one, leadG));
    const status = compareRational(external, input(0.001)) < 0 ? "short" : "closed";
    const { original } = values;
    const expected = oracle(values, values.equivalent, values.weak);
    const { document, polarity, wireSign } = values.variant;
    const analysis = analyzeCircuit(document);
    for (const item of original.parts) {
      const reading = expected.readings[item.id];
      const current = polarity < 0 && item.kind !== "battery" ? negate(reading.current) : reading.current;
      const voltage = polarity < 0 && item.kind !== "battery" ? negate(reading.voltage) : reading.voltage;
      assertCorrectRounding(analysis.parts[item.id].currentAmps, current, `${item.id}: current`);
      assertCorrectRounding(analysis.parts[item.id].voltageVolts, voltage, `${item.id}: voltage`);
      assertCorrectRounding(analysis.parts[item.id].powerWatts, reading.power, `${item.id}: power`);
    }
    for (const [id, current] of Object.entries(expected.wires)) {
      assertCorrectRounding(analysis.wireCurrents[id], polarity * wireSign < 0 ? negate(current) : current, `${id}: wire current`);
    }
    if (analysis.parts.open) {
      expect(analysis.parts.open.currentAmps).toBe(0);
      expect(analysis.parts.open.powerWatts).toBe(0);
      expect(analysis.wireCurrents["open-lead"]).toBe(0);
    }
    expect(analysis.status, analysis.message).toBe(status);
  });

  it.each([1000, 0.1, 0.02, 0.01])("measures the common output resistance with an upstream ballast tap (R=%s)", (tap) => {
    const values: Case = { count: 2, load: 0.000_32, ballast: 0.0015, otherBallast: 0.01 };
    const original = documentFor(values, true, false);
    original.parts.push(part("tap", "resistor", { resistanceOhms: tap }));
    original.wires.push(wire("tap-in", "s0", "a", "tap", "a"), wire("tap-out", "tap", "b", "load", "b"));
    // Unknown rails are A=load:a and D=s0:a. The tap makes the first
    // ballast current differ from its cell current. Keep that node in KCL.
    const tapped = (cellInternal: Rational) => {
      const ballastG = divide(one, add(input(values.ballast), multiply(lead, rational(2n))));
      const firstG = divide(one, add(cellInternal, lead));
      const secondG = divide(one, add(cellInternal, lowLeadResistance(values)));
      const otherG = divide(one, sum([multiply(cellInternal, rational(2n)), input(values.otherBallast!), multiply(lead, rational(4n))]));
      const tapG = divide(one, add(input(tap), multiply(lead, rational(2n))));
      const aa = sum([divide(one, input(values.load)), ballastG, secondG, otherG]);
      const dd = sum([ballastG, firstG, tapG]);
      const driveA = add(secondG, otherG);
      const determinant = subtract(multiply(aa, dd), multiply(ballastG, ballastG));
      const a = divide(add(multiply(driveA, dd), multiply(ballastG, firstG)), determinant);
      const d = divide(add(multiply(firstG, aa), multiply(ballastG, driveA)), determinant);
      return {
        a, first: multiply(subtract(d, one), firstG), second: multiply(subtract(a, one), secondG),
        other: multiply(subtract(a, one), otherG), ballast: multiply(subtract(a, d), ballastG), tap: multiply(d, tapG),
      };
    };
    const expected = tapped(internal);
    // Suppressing the first ideal cell places its negative lead in parallel
    // with the tap. The tap's local supply current is not common-load current.
    const firstOutput = add(
      add(input(values.ballast), multiply(lead, rational(2n))),
      divide(one, add(divide(one, lead), divide(one, add(input(tap), multiply(lead, rational(2n)))))),
    );
    const outputReturns = [firstOutput, lowLeadResistance(values), add(input(values.otherBallast!), multiply(lead, rational(4n)))];
    const external = add(input(values.load), divide(one, sum(outputReturns.map((resistance) => divide(one, resistance)))));
    const status = compareRational(external, input(0.001)) < 0 ? "short" : "closed";
    for (const { document, polarity } of variants(original)) {
      const analysis = analyzeCircuit(document);
      const currents: Record<string, Rational> = {
        load: divide(expected.a, input(values.load)), s0: expected.first, s1: expected.second,
        lead0: expected.ballast, lead1: expected.second, high: expected.other,
        charging: negate(expected.other), "other-ballast": expected.other, tap: expected.tap,
      };
      for (const item of original.parts) {
        const rawCurrent = currents[item.id];
        const battery = item.kind === "battery";
        const current = !battery && polarity < 0 ? negate(rawCurrent) : rawCurrent;
        const voltage = battery ? add(input(item.voltageVolts!), multiply(internal, current))
          : multiply(input(item.resistanceOhms!), current);
        assertCorrectRounding(analysis.parts[item.id].currentAmps, current, `${item.id}: tapped current`);
        assertCorrectRounding(analysis.parts[item.id].voltageVolts, voltage, `${item.id}: tapped voltage`);
        assertCorrectRounding(analysis.parts[item.id].powerWatts, multiply(voltage, battery ? negate(current) : current), `${item.id}: tapped power`);
      }
      expect(analysis.status, analysis.message).toBe(status);
    }
  });

  it.each([2 ** -10, 2 ** -9])("checks a passive subgroup drive even when every local cell has zero current (R=%s)", (resistance) => {
    const document: CircuitDocument = {
      title: "Two balanced local cells retain an independently driven passive load",
      parts: [
        part("p", "junction"), part("n", "junction"),
        part("s0", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
        part("s1", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
        part("high", "battery", { voltageVolts: 15, internalResistanceOhms: 8e-6 }),
        part("charging", "battery", { voltageVolts: 14, internalResistanceOhms: 8e-6 }),
        part("load", "resistor", { resistanceOhms: resistance }),
        part("weak", "resistor", { resistanceOhms: 7 * resistance }),
      ],
      wires: [
        wire("s0-in", "p", "a", "s0", "a"), wire("s0-out", "s0", "b", "n", "a"),
        wire("s1-in", "p", "a", "s1", "a"), wire("s1-out", "s1", "b", "n", "a"),
        wire("load-in", "p", "a", "load", "a"), wire("load-out", "load", "b", "n", "a"),
        wire("weak-in", "n", "a", "weak", "a"), wire("weak-out", "weak", "b", "high", "b"),
        wire("middle", "high", "b", "charging", "b"),
      ],
    };
    const addChain = (id: string, from: string, to: string, count: number) => {
      let previous = from;
      for (let index = 0; index < count - 1; index += 1) {
        const junction = `${id}${index}`;
        document.parts.push(part(junction, "junction"));
        document.wires.push(wire(junction, previous, "a", junction, "a"));
        previous = junction;
      }
      document.wires.push(wire(id, previous, "a", to, "a"));
    };
    addChain("high-chain", "p", "high", 16);
    addChain("charging-chain", "n", "charging", 15);
    // Rh=Rc=24w. With L=R+2w, W=7R+2w=7L-12w, rail KCL
    // gives Vp=1, Ih=Ic=-1/L, Iweak=2/L and Is0=Is1=0 exactly.
    const current = divide(one, add(input(resistance), multiply(lead, rational(2n))));
    for (const { document: variant, polarity } of variants(document)) {
      const analysis = analyzeCircuit(variant);
      for (const id of ["s0", "s1"]) {
        expect(analysis.parts[id].currentAmps).toBe(0);
        expect(analysis.parts[id].voltageVolts).toBe(1);
        expect(analysis.parts[id].powerWatts).toBe(0);
      }
      for (const [id, emf] of [["high", 15], ["charging", 14]] as const) {
        const voltage = subtract(input(emf), multiply(input(8e-6), current));
        assertCorrectRounding(analysis.parts[id].currentAmps, negate(current), `${id}: balanced current`);
        assertCorrectRounding(analysis.parts[id].voltageVolts, voltage, `${id}: balanced voltage`);
        assertCorrectRounding(analysis.parts[id].powerWatts, multiply(voltage, current), `${id}: balanced power`);
      }
      for (const [id, factor] of [["load", 1], ["weak", 2]] as const) {
        const passiveCurrent = multiply(current, rational(BigInt(factor * polarity)));
        const ohms = input(id === "load" ? resistance : 7 * resistance);
        assertCorrectRounding(analysis.parts[id].currentAmps, passiveCurrent, `${id}: balanced current`);
        assertCorrectRounding(analysis.parts[id].voltageVolts, multiply(ohms, passiveCurrent), `${id}: balanced voltage`);
        assertCorrectRounding(analysis.parts[id].powerWatts, multiply(ohms, multiply(passiveCurrent, passiveCurrent)), `${id}: balanced power`);
      }
      expect(analysis.status, analysis.message).toBe(resistance === 2 ** -10 ? "short" : "closed");
    }
  });
});
