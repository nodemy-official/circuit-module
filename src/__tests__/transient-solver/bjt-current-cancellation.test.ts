import { expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

const part = (id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...fields,
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

const thermalVoltage = 0.025_85;
const forwardExponent = 80;
const forwardCurrent = 1e300;
const currentGain = 1e300;
const saturationCurrent = forwardCurrent / Math.expm1(forwardExponent);
const baseVoltage = forwardExponent * thermalVoltage;

function transientDocument(kind: "npn-transistor" | "pnp-transistor"): CircuitDocument {
  const pnp = kind === "pnp-transistor";
  return {
    title: `${kind} cancellation in transient analysis`,
    parts: [
      part("source", "battery", { voltageVolts: baseVoltage }),
      part(kind, kind, { currentGain, saturationCurrentAmps: saturationCurrent }),
      part("ammeter", "ammeter"),
      part("ground", "ground"),
    ],
    wires: [
      wire("collector-ground", kind, "a", "ground", "a"),
      wire("emitter-meter", kind, "c", "ammeter", pnp ? "b" : "a"),
      wire("meter-ground", "ammeter", pnp ? "a" : "b", "ground", "a"),
      wire("base-source", "source", pnp ? "b" : "a", kind, "b"),
      wire("source-ground", "source", pnp ? "a" : "b", "ground", "a"),
    ],
  };
}

it.each([
  { kind: "npn-transistor" as const, expectedEmitterCurrent: -1, expectedMeterCurrent: 1 },
  { kind: "pnp-transistor" as const, expectedEmitterCurrent: 1, expectedMeterCurrent: 1 },
])("preserves the $kind emitter and ammeter currents throughout transient samples", ({
  kind,
  expectedEmitterCurrent,
  expectedMeterCurrent,
}) => {
  const result = simulateTransient(transientDocument(kind), {
    durationSeconds: 0.1,
    timeStepSeconds: 0.1,
  });

  // Equal 80-thermal-voltage junction exponents give If=Ir=1e300 A. Ebers-Moll
  // leaves a finite emitter residual |Ie|=If/beta=1 A despite that cancellation.
  const expectedFromIndependentRatio = forwardCurrent / currentGain;

  expect(result.status, result.message).toBe("valid");
  expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.1]);
  for (const sample of result.samples) {
    expect(sample.parts[kind]?.terminalCurrents?.c).toBeCloseTo(
      expectedEmitterCurrent * expectedFromIndependentRatio,
      12,
    );
    expect(sample.parts.ammeter.currentAmps).toBeCloseTo(expectedMeterCurrent * expectedFromIndependentRatio, 12);
  }
});
