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

// Independent binary64 rational arithmetic; no production math is imported.
const zero = rational(0n);
const one = rational(1n);
const two = rational(2n);
const input = (value: number) => rationalFromNumber(value)!;
const wireR = input(1e-6);
const leads = multiply(two, wireR);
const threshold = input(0.001);
const sum = (values: readonly Rational[]) => values.reduce(add, zero);
const parallel = (a: Rational, b: Rational) => divide(multiply(a, b), add(a, b));
const squared = (value: Rational) => multiply(value, value);

interface Case {
  name: string;
  otherEmf?: number;
  otherInternal?: number;
  dangling?: boolean;
  reordered?: boolean;
  load?: number;
  equilibrated?: boolean;
}

interface PassiveReading {
  id: string;
  r: Rational;
  branch: "load" | "bridgeA" | "bridgeB" | "cell" | "op" | "other";
  wires: string[];
}

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(value: string): CircuitEndpoint {
  const [partId, terminal] = value.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown terminal ${value}`); }
  return { partId, terminal };
}

function fixture(value: Case) {
  const document: CircuitDocument = {
    title: value.name,
    parts: [part("P", "junction"), part("N", "junction"), part("X", "junction")],
    wires: [],
  };
  const passive: PassiveReading[] = [];
  const wire = (from: string, to: string) => {
    const id = `w${document.wires.length}`;
    document.wires.push({ id, from: endpoint(from), to: endpoint(to) });
    return id;
  };
  const resistor = (id: string, from: string, to: string, r: number, branch: PassiveReading["branch"]) => {
    document.parts.push(part(id, "resistor", { resistanceOhms: r }));
    const wires = [wire(from, `${id}:a`), wire(`${id}:b`, to)];
    passive.push({ id, r: input(r), branch, wires });
    return add(input(r), leads);
  };

  // Alternative fixture: all relevant resistances are matched exactly,
  // including each physical wire. P=1/2 V, X=1/4 V, so otherEmf=1/4 V
  // is an exactly equilibrated source, rather than a rounded approximation.
  const d = 2 ** -11;
  let load: Rational;
  if (value.equilibrated) {
    document.parts.push(part("Y", "junction"));
    load = add(resistor("loadA", "P:a", "Y:a", 2 * d, "load"),
      resistor("loadB", "Y:a", "N:a", 2 * d, "load"));
  } else {
    load = resistor("load", "P:a", "N:a", value.load ?? 0.0004, "load");
  }
  const a = resistor("bridgeA", "P:a", "X:a", value.equilibrated ? 2 * d : 0.0006, "bridgeA");
  const b = resistor("bridgeB", "X:a", "N:a", value.equilibrated ? 2 * d : 0.0006, "bridgeB");
  const internal = input(value.equilibrated ? 2 * d : 0.1);
  let ballast = zero;
  for (let index = 0; index < 2; index += 1) {
    document.parts.push(part(`cell${index}`, "battery", {
      voltageVolts: 1, internalResistanceOhms: value.equilibrated ? 2 * d : 0.1,
    }));
    ballast = add(resistor(`p${index}`, "P:a", `cell${index}:a`, value.equilibrated ? d : 0.0015, "cell"),
      resistor(`n${index}`, `cell${index}:b`, "N:a", value.equilibrated ? d : 0.000_05, "cell"));
  }
  const otherInternal = input(value.otherInternal ?? 1000);
  let otherBallast = zero;
  if (value.otherEmf !== undefined) {
    document.parts.push(part("other", "battery", {
      voltageVolts: Math.abs(value.otherEmf), internalResistanceOhms: value.otherInternal ?? 1000,
    }));
    // Reversed EMF is represented by physical polarity reversal; battery
    // input validation requires a strictly positive voltage magnitude.
    const from = value.otherEmf < 0 ? "other:b" : "other:a";
    const to = value.otherEmf < 0 ? "other:a" : "other:b";
    const positive = resistor("op", from, "X:a", 1000, "op");
    if (!value.dangling) {
      otherBallast = add(positive, resistor("on", to, "N:a", 1000, "other"));
    }
  }
  if (value.reordered) {
    document.parts.reverse();
    document.wires.reverse();
  }
  return { value, document, passive, load, a, b, ballast, internal, otherBallast, otherInternal };
}

type Fixture = ReturnType<typeof fixture>;

// Independent two-node KCL with series interiors eliminated exactly:
// A*P-h*X = 2/Rcell; D*X-h*P = Eother/Rother, N=0.
function operatingPoint(value: Fixture) {
  const cellR = add(value.ballast, value.internal);
  const cellG = divide(two, cellR);
  const h = divide(one, value.a);
  const otherPresent = value.value.otherEmf !== undefined && !value.value.dangling;
  const otherR = add(value.otherBallast, value.otherInternal);
  const otherG = otherPresent ? divide(one, otherR) : zero;
  const source = otherPresent ? multiply(input(value.value.otherEmf!), otherG) : zero;
  const a = sum([cellG, divide(one, value.load), h]);
  const d = sum([h, divide(one, value.b), otherG]);
  const determinant = subtract(multiply(a, d), squared(h));
  const p = divide(add(multiply(cellG, d), multiply(h, source)), determinant);
  const x = divide(add(multiply(source, a), multiply(h, cellG)), determinant);
  return {
    p, x,
    load: divide(p, value.load),
    bridgeA: divide(subtract(p, x), value.a),
    bridgeB: divide(x, value.b),
    cell: divide(subtract(p, one), cellR),
    op: otherPresent ? divide(subtract(input(value.value.otherEmf!), x), otherR) : zero,
    other: otherPresent ? divide(subtract(x, input(value.value.otherEmf!)), otherR) : zero,
  };
}

function retained(value: CircuitExactComplex | undefined, scalar: number): Rational {
  if (!value) { return input(scalar); }
  if (!("numerator" in value.real)) { throw new Error("Unexpected expression in DC reading"); }
  const n = value.real.numerator;
  return rational(n.startsWith("-") ? -BigInt(n.slice(1)) : BigInt(n), BigInt(value.real.denominator));
}

const cases: Case[] = [
  { name: "original complete passive load" },
  { name: "2 V unselected source makes the passive bridge source-side", otherEmf: 2 },
  { name: "large unselected internal resistance", otherEmf: 2, otherInternal: 1e6 },
  { name: "reversed unselected EMF", otherEmf: -2 },
  { name: "smaller unselected EMF", otherEmf: 0.5 },
  { name: "reordered parts and wires", otherEmf: 2, reordered: true },
  { name: "dangling source leaves the complete load boundary", otherEmf: 2, dangling: true },
  { name: "above-threshold common-load boundary", otherEmf: 2, load: 0.0006 },
  { name: "equilibrated baseline", equilibrated: true },
  { name: "exactly zero-current additional source", equilibrated: true, otherEmf: 0.25 },
];

describe("unselected-source passive loads", () => {
  it.each(cases)("$name", (configuration) => {
    const value = fixture(configuration);
    const point = operatingPoint(value);
    const bridge = add(value.a, value.b);
    const sourceR = divide(value.ballast, two);
    const otherParticipates = configuration.otherEmf !== undefined && !configuration.dangling;

    // The documented macro boundary is determined before opening other
    // groups. With the other cell present, X is internal to its source macro;
    // opening that cell retains P-X-N as a genuine passive source-side path.
    // Without a participating other cell, both P-N paths are the common load.
    const external = otherParticipates
      ? add(value.load, parallel(sourceR, bridge))
      : add(sourceR, parallel(value.load, bridge));
    const voc = otherParticipates ? divide(bridge, add(sourceR, bridge)) : one;
    expect(compare(voc, zero), "common output has nonzero, positive Voc").toBe(1);
    const individual = add(value.ballast, parallel(value.load, bridge));
    expect(compare(individual, threshold), "neither selected cell has a passive short").toBe(1);
    if (otherParticipates) {
      const otherReturn = add(value.otherBallast, parallel(value.b, add(value.a, value.load)));
      expect(compare(otherReturn, input(2000)), "other cell passive return exceeds its 2 kOhm ballast").toBe(1);
      // Every cycle containing other must traverse both private ballasts.
      // The only remaining source-source cycle is the equal 1 V pair,
      // whose net EMF is exactly zero, independently of operating currents.
      expect(compare(value.otherBallast, threshold), "all other-driven cycles exceed threshold").toBe(1);
    }
    const expectedStatus = compare(external, threshold) < 0 ? "short" : "closed";
    const actual = analyzeCircuit(value.document);
    expect(actual.status, "documented Rout + common-load metric, with independent local/cycle guards").toBe(expectedStatus);

    expect(sum([multiply(two, point.cell), point.load, point.bridgeA]).numerator, "P KCL").toBe(0n);
    expect(sum([negate(point.bridgeA), point.bridgeB, point.other]).numerator, "X KCL").toBe(0n);
    const supplied = add(negate(multiply(two, point.cell)),
      negate(multiply(input(configuration.otherEmf ?? 0), point.other)));
    const dissipated = sum([
      multiply(multiply(two, add(value.ballast, value.internal)), squared(point.cell)),
      multiply(value.load, squared(point.load)), multiply(value.a, squared(point.bridgeA)),
      multiply(value.b, squared(point.bridgeB)),
      multiply(add(value.otherBallast, value.otherInternal), squared(point.other)),
    ]);
    expect(compare(supplied, dissipated), "exact energy conservation, including all wires and internal losses").toBe(0);

    for (const resistor of value.passive) {
      const current = point[resistor.branch];
      const voltage = multiply(resistor.r, current);
      const reading = actual.parts[resistor.id];
      expect(compare(retained(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${resistor.id} retained current`).toBe(0);
      assertCorrectRounding(reading.currentAmps, current, `${resistor.id} current`);
      assertCorrectRounding(reading.voltageVolts, voltage, `${resistor.id} voltage`);
      assertCorrectRounding(reading.powerWatts, multiply(voltage, current), `${resistor.id} power`);
      for (const id of resistor.wires) {
        assertCorrectRounding(actual.wireCurrents[id], current, `${id} current`);
      }
    }
    for (const id of ["cell0", "cell1", ...(configuration.otherEmf === undefined ? [] : ["other"])]) {
      const other = id === "other";
      const current = other ? configuration.otherEmf! < 0 ? negate(point.other) : point.other : point.cell;
      const emf = other ? input(Math.abs(configuration.otherEmf!)) : one;
      const resistance = other ? value.otherInternal : value.internal;
      const voltage = add(emf, multiply(resistance, current));
      const reading = actual.parts[id];
      expect(compare(retained(reading.exactTerminalCurrents?.a, reading.currentAmps), current), `${id} retained current`).toBe(0);
      assertCorrectRounding(reading.currentAmps, current, `${id} current`);
      assertCorrectRounding(reading.voltageVolts, voltage, `${id} voltage`);
      assertCorrectRounding(reading.powerWatts, negate(multiply(voltage, current)), `${id} delivered terminal power`);
    }
    if (configuration.equilibrated) {
      expect(compare(point.p, rational(1n, 2n)), "exact equilibrium at P").toBe(0);
      expect(compare(point.x, rational(1n, 4n)), "exact equilibrium at X").toBe(0);
      expect(point.other.numerator, "additional equilibrium source current is exactly zero").toBe(0n);
      // Compare every existing branch quantity to the independent baseline;
      // this adds no additional analyzeCircuit call or fixture to the audit.
      const baseline = operatingPoint(fixture({ name: "oracle equilibrium", equilibrated: true }));
      for (const key of ["p", "x", "load", "bridgeA", "bridgeB", "cell"] as const) {
        expect(compare(point[key], baseline[key]), `${key} unchanged exactly`).toBe(0);
      }
    } else if (otherParticipates && configuration.otherEmf !== 0) {
      expect(point.other.numerator, "the original 2 V addition is not a zero-current invariance case").not.toBe(0n);
    }
  });
});
