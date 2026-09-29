import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
  type CircuitWire,
} from "../circuit-model.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function underflowGdsCircuit(kind: "nmos" | "pmos", orientation: "forward" | "reverse"): CircuitDocument {
  const bias = kind === "nmos"
    ? orientation === "forward"
      ? { a: 1, b: 2, c: 0 }
      : { a: 0, b: 2, c: 1 }
    : orientation === "forward"
      ? { a: 1, b: 0, c: 2 }
      : { a: 2, b: 0, c: 1 };
  const drivenTerminal = orientation === "forward" ? "a" : "c";
  const parts = [
    part("ground", "ground"),
    part(kind, kind, {
      thresholdVolts: 1,
      transconductanceAmpsPerVoltSquared: 1,
      channelLengthModulation: Number.MIN_VALUE,
    }),
  ];
  const wires: CircuitWire[] = [];

  for (const terminal of ["a", "b", "c"] as const) {
    const voltage = bias[terminal];
    if (terminal === drivenTerminal) {
      parts.push(part("drive", "ac-source", {
        voltageVolts: 1e16,
        offsetVolts: voltage,
        frequencyHz: 1000,
      }));
      wires.push(
        wire("drive-device", "drive", "a", kind, terminal),
        wire("drive-return", "drive", "b", "ground", "a"),
      );
    } else if (voltage === 0) {
      wires.push(wire(`${terminal}-ground`, kind, terminal, "ground", "a"));
    } else {
      const biasId = `${terminal}-bias`;
      parts.push(part(biasId, "battery", { voltageVolts: voltage }));
      wires.push(
        wire(`${terminal}-positive`, biasId, "a", kind, terminal),
        wire(`${terminal}-return`, biasId, "b", "ground", "a"),
      );
    }
  }

  return { title: `Underflowed ${kind} ${orientation} gds`, parts, wires };
}

it.each([
  { kind: "nmos", orientation: "forward", sign: 1 },
  { kind: "pmos", orientation: "forward", sign: 1 },
  { kind: "nmos", orientation: "reverse", sign: -1 },
  { kind: "pmos", orientation: "reverse", sign: -1 },
] as const)("preserves underflowed $kind $orientation output conductance", ({ kind, orientation, sign }) => {
  const analysis = analyzeAnalogCircuit(underflowGdsCircuit(kind, orientation), {
    mode: "ac",
    frequencyHz: 1000,
  });
  // In saturation gds = lambda * beta * Vov^2 / 2 = 2^-1075,
  // which rounds to zero alone. Multiplying first by the AC voltage keeps
  // the physically expected current inside binary64's representable range.
  const expectedCurrent = sign * Number.MIN_VALUE * (1e16 / 2);

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts[kind]!.channelConducting).toBe(true);
  expect(analysis.parts[kind]!.terminalCurrents.a!.real).toBe(expectedCurrent);
});
