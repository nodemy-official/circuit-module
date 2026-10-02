import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";

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
const scenarios = [
  { kind: "npn-transistor", reversePartOrder: false },
  { kind: "npn-transistor", reversePartOrder: true },
  { kind: "pnp-transistor", reversePartOrder: false },
  { kind: "pnp-transistor", reversePartOrder: true },
] as const;

function bjtDocument(
  mode: "dc" | "ac",
  kind: "npn-transistor" | "pnp-transistor",
  reversePartOrder: boolean,
): CircuitDocument {
  const polarity = kind === "pnp-transistor" ? -1 : 1;
  const source = mode === "dc"
    ? part("source", "battery", { voltageVolts: baseVoltage })
    : part("source", "ac-source", {
      voltageVolts: 1e-3,
      frequencyHz: 1000,
      offsetVolts: polarity * baseVoltage,
    });
  const parts = [
    source,
    part("bjt", kind, {
      currentGain,
      saturationCurrentAmps: saturationCurrent,
    }),
    part("meter", "ammeter"),
    part("ground", "ground"),
  ];

  return {
    title: "BJT terminal-current cancellation",
    parts: reversePartOrder ? parts.reverse() : parts,
    wires: [
      wire("collector-ground", "bjt", "a", "ground", "a"),
      wire("emitter-meter", "bjt", "c", "meter", "a"),
      wire("meter-ground", "meter", "b", "ground", "a"),
      wire("base-source", "source", kind === "pnp-transistor" && mode === "dc" ? "b" : "a", "bjt", "b"),
      wire("source-ground", "source", kind === "pnp-transistor" && mode === "dc" ? "a" : "b", "ground", "a"),
    ],
  };
}

it.each(scenarios)(
  "retains all DC terminal currents for $kind with reversePartOrder=$reversePartOrder",
  ({ kind, reversePartOrder }) => {
    const analysis = analyzeAnalogCircuit(bjtDocument("dc", kind, reversePartOrder), { mode: "dc" });
    const polarity = kind === "pnp-transistor" ? -1 : 1;
    const expectedCollectorCurrent = -polarity * forwardCurrent;
    const expectedBaseCurrent = polarity * (forwardCurrent + forwardCurrent / currentGain);
    const expectedEmitterCurrent = -polarity * (forwardCurrent / currentGain);

    expect(analysis.status, analysis.message).toBe("valid");
    const bjt = analysis.parts.bjt;
    expect(bjt.terminalCurrents.a?.real).toBe(expectedCollectorCurrent);
    expect(bjt.terminalCurrents.b?.real).toBe(expectedBaseCurrent);

    // With Vbe = Vbc, If = Ir. Ebers-Moll gives Ie = polarity * -If / beta,
    // even though the uncombined terms are each about 1e300 A.
    expect(bjt.terminalCurrents.c?.real).toBeCloseTo(expectedEmitterCurrent, 12);
    expect(analysis.parts.meter.meterStatus).toBe("connected");
    expect(analysis.parts.meter.current.real).toBeCloseTo(-expectedEmitterCurrent, 12);
  },
);

it.each(scenarios)(
  "retains the AC emitter response for $kind with reversePartOrder=$reversePartOrder",
  ({ kind, reversePartOrder }) => {
    const analysis = analyzeAnalogCircuit(bjtDocument("ac", kind, reversePartOrder), { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("valid");
    const forwardSlope = (saturationCurrent * Math.exp(forwardExponent)) / thermalVoltage;
    const baseSlope = forwardSlope / currentGain;
    const expectedEmitterCurrent = -baseSlope * 1e-3;

    // dIe/dVb = -Gf - Gfb + Gr = -Gfb when Vbe = Vbc.
    expect(analysis.parts.bjt.terminalCurrents.c?.real).toBeCloseTo(expectedEmitterCurrent, 12);
    expect(analysis.parts.meter.meterStatus).toBe("connected");
    expect(analysis.parts.meter.current.real).toBeCloseTo(-expectedEmitterCurrent, 12);
  },
);
