import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "../circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("potentiometer power rounding", () => {
  it("adds exact segment powers before rounding the measured total", () => {
    const document: CircuitDocument = {
      title: "Exact potentiometer segment power sum",
      parts: [
        part("source-a", "battery", { voltageVolts: 1 + Number.EPSILON }),
        part("source-b", "battery", { voltageVolts: 2 ** -26 }),
        part("pot", "potentiometer", { resistanceOhms: 3, wiperPosition: 1 / 3 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("a-pot", "source-a", "a", "pot", "a"),
        wire("a-ground", "source-a", "b", "ground", "a"),
        wire("b-pot", "source-b", "a", "pot", "b"),
        wire("b-ground", "source-b", "b", "ground", "a"),
        wire("wiper-ground", "pot", "c", "ground", "a"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document);

    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.parts.pot!.power.real).toBe(1 + 3 * Number.EPSILON);
    expect(analysis.parts.pot!.power.imaginary).toBe(0);
  });
});
