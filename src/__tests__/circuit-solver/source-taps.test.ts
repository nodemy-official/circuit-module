import { expect, it } from "vitest";
import type { CircuitDocument, CircuitPart, CircuitWire } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { addRational as add, assertCorrectRounding, compareRational, divideRational as divide, multiplyRational as multiply, negateRational as negate, rational, rationalFromNumber } from "../helpers/numeric-oracle.js";

const input = (value: number) => rationalFromNumber(value)!;
const one = rational(1n);
const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({ id, kind, label: id, x: 0, y: 0, ...values });

it.each([2, 3].flatMap((count) => [0.0012, 0.002, 0.004].map((resistance) => ({ count, resistance }))))(
  "keeps zero-output crossed source macros closed ($count cells, $resistance ohms)", ({ count, resistance }) => {
    const document: CircuitDocument = { title: "Every cell has equal crossed taps", parts: [part("load", "resistor", { resistanceOhms: resistance })], wires: [] };
    const connect = (from: string, to: string) => {
      const [fromPart, fromTerminal] = from.split(":");
      const [toPart, toTerminal] = to.split(":");
      document.wires.push({ id: `wire${document.wires.length}`, from: { partId: fromPart, terminal: fromTerminal as "a" | "b" }, to: { partId: toPart, terminal: toTerminal as "a" | "b" } });
    };
    for (let index = 0; index < count; index += 1) {
      const id = `cell${index}`;
      document.parts.push(part(id, "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }));
      for (const [branch, from, to] of [["positive", "load:a", `${id}:a`], ["negative", `${id}:b`, "load:b"], ["tapA", `${id}:a`, "load:b"], ["tapB", "load:a", `${id}:b`]] as const) {
        const resistorId = `${branch}${index}`;
        document.parts.push(part(resistorId, "resistor", { resistanceOhms: resistance }));
        connect(from, `${resistorId}:a`);
        connect(`${resistorId}:b`, to);
      }
    }
    // Symmetry fixes both load terminals to the same potential. Each cell
    // sees two 2*(R+2 µΩ) paths in parallel, so its passive return is R+2 µΩ.
    // The source-output two-port has zero open-circuit EMF. Its private
    // cell returns cannot be aggregated as power delivered to the load.
    // No production solver or arithmetic participates in this oracle.
    const branch = add(input(resistance), multiply(input(1e-6), rational(2n)));
    expect(compareRational(branch, input(0.001))).toBe(1);
    const current = negate(divide(one, add(input(0.1), branch)));
    const voltage = add(one, multiply(input(0.1), current));
    const cells = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
    const reverse = (endpoint: CircuitWire["from"]): CircuitWire["from"] => cells.has(endpoint.partId) ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" } : endpoint;
    for (const candidate of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse().map((wire) => ({ ...wire, from: reverse(wire.to), to: reverse(wire.from) })) }]) {
      const result = analyzeCircuit(candidate);
      for (const id of cells) {
        assertCorrectRounding(result.parts[id].currentAmps, current, `${id} current`);
        assertCorrectRounding(result.parts[id].voltageVolts, voltage, `${id} voltage`);
      }
      expect(result.parts.load.currentAmps).toBe(0);
      expect(result.parts.load.voltageVolts).toBe(0);
      expect(result.parts.load.powerWatts).toBe(0);
      expect.soft(result.status, result.message).toBe("closed");
    }
  },
);
