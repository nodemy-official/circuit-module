import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitEndpoint, CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
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
const internal = input(0.1);
const threshold = input(0.001);
const parallel = (...values: Rational[]) => divide(one, values.reduce((total, value) => add(total, divide(one, value)), zero));

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}

function endpoint(value: string): CircuitEndpoint {
  const [partId, terminal] = value.split(":");
  if (terminal !== "a" && terminal !== "b") { throw new Error(`Unknown port ${value}`); }
  return { partId, terminal };
}

function wire(document: CircuitDocument, from: string, to: string) {
  document.wires.push({ id: `w${document.wires.length}`, from: endpoint(from), to: endpoint(to) });
}

function resistor(document: CircuitDocument, id: string, from: string, to: string, resistanceOhms: number) {
  document.parts.push(part(id, "resistor", { resistanceOhms }));
  wire(document, from, `${id}:a`);
  wire(document, `${id}:b`, to);
  return add(input(resistanceOhms), multiply(two, lead));
}

function reversed(document: CircuitDocument): CircuitDocument {
  const cells = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const flip = (port: CircuitEndpoint): CircuitEndpoint => cells.has(port.partId)
    ? { ...port, terminal: port.terminal === "a" ? "b" : "a" } : port;
  return { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse()
    .map((connection) => ({ ...connection, from: flip(connection.to), to: flip(connection.from) })) };
}

describe("source-output macros separate local loss from shared load", () => {
  it.each([1000, 1e100])("zero-current links cannot multiply a series drive (R=%s)", (weak) => {
    const document: CircuitDocument = { title: "Two aiding cells with null passive links", parts: [
      part("a", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
      part("b", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
    ], wires: [] };
    const between = resistor(document, "between", "a:b", "b:a", 0.0015);
    const load = resistor(document, "load", "b:b", "a:a", 0.0015);
    const baseline = analyzeCircuit(document);
    resistor(document, "weakP", "a:a", "b:a", weak);
    resistor(document, "weakN", "a:b", "b:b", weak);
    const expectedCurrent = negate(divide(two, add(multiply(two, internal), add(between, load))));
    expect(compare(add(between, load), threshold)).toBe(1);
    expect(baseline.status).toBe("closed");
    for (const candidate of [document, reversed(document)]) {
      const actual = analyzeCircuit(candidate);
      expect(actual.status).toBe("closed");
      for (const id of ["a", "b"]) {
        assertCorrectRounding(actual.parts[id].currentAmps, expectedCurrent, `${id} series KVL`);
        assertCorrectRounding(actual.parts[id].voltageVolts, add(one, multiply(internal, expectedCurrent)), `${id} voltage`);
        if (candidate === document) { expect(actual.parts[id]).toEqual(baseline.parts[id]); }
      }
      for (const id of ["weakP", "weakN"]) {
        expect(actual.parts[id].voltageVolts).toBe(0);
        expect(actual.parts[id].currentAmps).toBe(0);
        expect(actual.parts[id].powerWatts).toBe(0);
      }
      if (candidate === document) {
        for (const id of ["between", "load"]) { expect(actual.parts[id]).toEqual(baseline.parts[id]); }
        for (const [id, current] of Object.entries(baseline.wireCurrents)) { expect(actual.wireCurrents[id]).toBe(current); }
      }
    }
  });

  it.each([
    { count: 2, ballast: 0.0012, tap: 0.0012, load: 0.0001 },
    { count: 3, ballast: 0.0015, tap: 0.002, load: 0.0003 },
    { count: 2, ballast: 0.0015, tap: 0.0008, load: 0.0003 },
    { count: 2, ballast: 0.0015, tap: 0.01, load: 0.0003 },
  ])("retains zero, attenuated and inverted macro EMFs (%j)", ({ count, ballast, tap, load }) => {
    const document: CircuitDocument = { title: "Identical crossed source macros", parts: [part("P", "junction"), part("N", "junction")], wires: [] };
    const loadR = resistor(document, "load", "P:a", "N:a", load);
    for (let index = 0; index < count; index += 1) {
      const id = `cell${index}`;
      document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
      resistor(document, `p${index}`, "P:a", `${id}:a`, ballast);
      resistor(document, `n${index}`, `${id}:b`, "N:a", ballast);
      resistor(document, `tapA${index}`, `${id}:a`, "N:a", tap);
      resistor(document, `tapB${index}`, "P:a", `${id}:b`, tap);
    }
    const r = add(input(ballast), multiply(two, lead));
    const t = add(input(tap), multiply(two, lead));
    const n = rational(BigInt(count));
    const outputEmf = divide(subtract(t, r), add(r, t));
    const outputR = divide(multiply(two, parallel(r, t)), n);
    const external = add(outputR, loadR);
    const status = outputEmf.numerator !== 0n && compare(external, threshold) < 0 ? "short" : "closed";
    // Independent differential KCL. U is cell terminal V, V is output V:
    // (C+1/ri)U-BV=1/ri; (nC+1/L)V-nBU=0.
    const c = add(divide(one, multiply(two, r)), divide(one, multiply(two, t)));
    const b = subtract(divide(one, multiply(two, r)), divide(one, multiply(two, t)));
    const a = add(c, divide(one, internal));
    const d = add(multiply(n, c), divide(one, loadR));
    const determinant = subtract(multiply(a, d), multiply(n, multiply(b, b)));
    const outputVoltage = divide(multiply(n, b), multiply(internal, determinant));
    const cellVoltage = divide(add(divide(one, internal), multiply(b, outputVoltage)), a);
    const cellCurrent = divide(subtract(cellVoltage, one), internal);
    // All unselected cells are open for the separate individual return.
    const otherG = add(divide(one, loadR), divide(multiply(subtract(n, one), two), add(r, t)));
    const localR = divide(one, subtract(c, divide(multiply(b, b), add(c, otherG))));
    expect(compare(localR, threshold)).toBe(1);
    for (const candidate of [document, reversed(document)]) {
      const actual = analyzeCircuit(candidate);
      expect(actual.status).toBe(status);
      for (let index = 0; index < count; index += 1) {
        assertCorrectRounding(actual.parts[`cell${index}`].voltageVolts, cellVoltage, "cell KCL voltage");
        assertCorrectRounding(actual.parts[`cell${index}`].currentAmps, cellCurrent, "cell KCL current");
      }
      const signed = candidate === document ? outputVoltage : negate(outputVoltage);
      assertCorrectRounding(actual.parts.load.voltageVolts, multiply(input(load), divide(signed, loadR)), "common load V");
      assertCorrectRounding(actual.parts.load.currentAmps, divide(signed, loadR), "common load I");
    }
  });

  it.each([2, 4, 64].flatMap((count) => {
    const boundary = 0.001 - 2e-6 - 2e-6 / count;
    return [nextDown(boundary), nextUp(boundary)].map((load) => ({ count, load }));
  }))("keeps shared physical output wires outside private source macros (%j)", ({ count, load }) => {
    const document: CircuitDocument = { title: "Common output lead sharing", parts: [
      part("P", "junction"), part("N", "junction"), part("load", "resistor", { resistanceOhms: load }),
    ], wires: [] };
    wire(document, "P:a", "load:a");
    wire(document, "load:b", "N:a");
    for (let index = 0; index < count; index += 1) {
      const id = `cell${index}`;
      document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
      wire(document, "P:a", `${id}:a`);
      wire(document, `${id}:b`, "N:a");
    }
    const n = rational(BigInt(count));
    const shared = add(input(load), multiply(two, lead));
    const external = add(shared, divide(multiply(two, lead), n));
    const cellCurrent = negate(divide(one, add(internal, add(multiply(two, lead), multiply(n, shared)))));
    const actual = analyzeCircuit(document);
    expect(actual.status).toBe(compare(external, threshold) < 0 ? "short" : "closed");
    assertCorrectRounding(actual.parts.cell0.currentAmps, cellCurrent, "shared-lead KVL");
    assertCorrectRounding(actual.parts.load.currentAmps, negate(multiply(n, cellCurrent)), "shared-lead KCL");
  });

  it.each([[1, 1, 1, 1], [3, -2]].flatMap((emfs) => [0.000_59, 0.000_61].map((load) => ({ emfs, load }))))(
    "retains original paired cells in parallel series-string macros (%j)", ({ emfs, load }) => {
      const document: CircuitDocument = { title: "Two compound source macros", parts: [part("P", "junction"), part("N", "junction")], wires: [] };
      const loadR = resistor(document, "load", "P:a", "N:a", load);
      for (let branch = 0; branch < 2; branch += 1) {
        let previous = "P:a";
        for (const [position, emf] of emfs.entries()) {
          const id = `cell${branch}-${position}`;
          document.parts.push(part(id, "battery", { voltageVolts: Math.abs(emf), internalResistanceOhms: 0.1 }));
          const entry = `${id}:${emf > 0 ? "a" : "b"}`;
          if (position === 0) { resistor(document, `p${branch}`, previous, entry, 0.0004); }
          else { wire(document, previous, entry); }
          previous = `${id}:${emf > 0 ? "b" : "a"}`;
        }
        resistor(document, `n${branch}`, previous, "N:a", 0.0004);
      }
      const n = rational(BigInt(emfs.length));
      const branchR = add(multiply(two, input(0.0004)), multiply(add(n, rational(3n)), lead));
      const external = add(loadR, divide(branchR, two));
      const emf = emfs.map(input).reduce(add, zero);
      const cellCurrent = negate(divide(emf, add(multiply(n, internal), add(branchR, multiply(two, loadR)))));
      for (const candidate of [document, reversed(document)]) {
        const actual = analyzeCircuit(candidate);
        expect(actual.status).toBe(compare(external, threshold) < 0 ? "short" : "closed");
        for (const [position, value] of emfs.entries()) {
          assertCorrectRounding(actual.parts[`cell0-${position}`].currentAmps, value > 0 ? cellCurrent : negate(cellCurrent), "compound-string KVL");
        }
      }
    },
  );

  it.each([0.02, 0.01])("a single upstream private shunt cannot lower the common load metric (R=%s)", (tap) => {
    const document: CircuitDocument = { title: "Private shunt loss versus output R", parts: [part("load", "resistor", { resistanceOhms: 0.000_32 })], wires: [] };
    for (let index = 0; index < 2; index += 1) {
      const id = `cell${index}`;
      document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
      resistor(document, `p${index}`, "load:a", `${id}:a`, 0.0015);
      wire(document, `${id}:b`, "load:b");
    }
    resistor(document, "tap", "cell0:a", "load:b", tap);
    const p = add(input(0.0015), multiply(two, lead));
    const t = add(input(tap), multiply(two, lead));
    // Suppressed cell0 joins its own paired ports. The tap parallels its
    // 1 µΩ negative wire, and cannot become an independent common load.
    const external = add(input(0.000_32), parallel(add(p, parallel(lead, t)), add(p, lead)));
    expect(compare(external, threshold)).toBe(1);
    expect(analyzeCircuit(document).status).toBe("closed");
    expect(analyzeCircuit(reversed(document)).status).toBe("closed");
  });

  it("keeps private shunt loss out of an unequal-EMF circulating return", () => {
    const document: CircuitDocument = { title: "Resistive circulation with a private load", parts: [part("P", "junction"), part("N", "junction")], wires: [] };
    const load = resistor(document, "load", "P:a", "N:a", 1);
    for (let index = 0; index < 2; index += 1) {
      const id = `cell${index}`;
      document.parts.push(part(id, "battery", { voltageVolts: index + 1, internalResistanceOhms: 0.1 }));
      resistor(document, `p${index}`, "P:a", `${id}:a`, 0.0015);
      resistor(document, `n${index}`, `${id}:b`, "N:a", 0.000_05);
    }
    const shunt = resistor(document, "shunt", "cell0:a", "cell0:b", 0.0012);
    const branch = add(add(input(0.0015), input(0.000_05)), multiply(rational(4n), lead));
    const local = parallel(shunt, add(branch, load));
    const circulation = multiply(two, branch);
    expect(compare(local, threshold)).toBe(1);
    expect(compare(add(branch, load), threshold)).toBe(1);
    expect(compare(circulation, threshold)).toBe(1);
    expect(analyzeCircuit(document).status).toBe("closed");
    expect(analyzeCircuit(reversed(document)).status).toBe("closed");
  });
});
