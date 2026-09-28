import { describe, expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "./circuit-model.js";
import { complex, solveComplexLinearSystem } from "./analog-math.js";
import { analyzeAnalogCircuit } from "./analog-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("analog AC subnormal source audit", () => {
  it("retains the representable current from a minimum-scale complex source", () => {
    const document: CircuitDocument = {
      title: "Subnormal AC source through a series R-L load",
      parts: [
        part("source", "ac-source", { voltageVolts: 1e-323, phaseDegrees: 45, frequencyHz: 1 }),
        part("resistor", "resistor", { resistanceOhms: 1 }),
        part("inductor", "inductor", { inductanceHenries: 1 / Math.PI }),
      ],
      wires: [
        wire("source-resistor", "source", "a", "resistor", "a"),
        wire("resistor-inductor", "resistor", "b", "inductor", "a"),
        wire("inductor-source", "inductor", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    const minimum = Number.MIN_VALUE;
    // The source phasor rounds to (MIN, MIN); dividing it by 1 + 2i gives
    // (3/5 MIN, -1/5 MIN), which rounds to (MIN, 0).
    expect(result.parts.resistor.current.real).toBe(minimum);
    expect(Math.abs(result.parts.resistor.current.imaginary)).toBe(0);
    expect(result.parts.inductor.current.real).toBe(minimum);
    expect(Math.abs(result.parts.inductor.current.imaginary)).toBe(0);
    expect(result.parts.source.current.real).toBe(-minimum);
    expect(Math.abs(result.parts.source.current.imaginary)).toBe(0);
  });

  it("falls back when RHS normalization overflows a finite minimum-scale solution", () => {
    const minimum = Number.MIN_VALUE;
    const solution = solveComplexLinearSystem(
      1,
      new Float64Array([minimum]),
      new Float64Array([0]),
      new Float64Array([minimum]),
      new Float64Array([0]),
    );

    expect(solution).toEqual([complex(1, 0)]);
  });

  it("leaves mixed-scale RHS vectors and zero RHS vectors unscaled", () => {
    const minimum = Number.MIN_VALUE;
    const mixedSolution = solveComplexLinearSystem(
      2,
      new Float64Array([1, 0, 0, 1]),
      new Float64Array(4),
      new Float64Array([minimum, 1]),
      new Float64Array(2),
    );
    const zeroSolution = solveComplexLinearSystem(
      2,
      new Float64Array([1, 0, 0, 1]),
      new Float64Array(4),
      new Float64Array(2),
      new Float64Array(2),
    );

    expect(mixedSolution).toEqual([complex(minimum, 0), complex(1, 0)]);
    expect(zeroSolution).toEqual([complex(0, 0), complex(0, 0)]);
  });
});
