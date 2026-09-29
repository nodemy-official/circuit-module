import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
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

function fixTerminalVoltage(
  parts: CircuitPart[],
  wires: CircuitDocument["wires"],
  terminal: CircuitTerminal,
  voltage: number,
  index: number,
) {
  if (voltage === 0) {
    wires.push(wire(`bias-${index}-ground`, "device", terminal, "ground", "a"));
    return;
  }
  const sourceId = `bias-${index}`;
  parts.push(part(sourceId, "battery", { voltageVolts: Math.abs(voltage) }));
  if (voltage > 0) {
    wires.push(
      wire(`bias-${index}-positive`, sourceId, "a", "device", terminal),
      wire(`bias-${index}-return`, sourceId, "b", "ground", "a"),
    );
  } else {
    wires.push(
      wire(`bias-${index}-positive`, sourceId, "a", "ground", "a"),
      wire(`bias-${index}-return`, sourceId, "b", "device", terminal),
    );
  }
}

function fixedBiasDocument(
  kind: "npn-transistor" | "pnp-transistor" | "nmos" | "pmos",
  voltages: [number, number, number],
  values: Partial<CircuitPart>,
): CircuitDocument {
  const parts = [part("device", kind, values), part("ground", "ground")];
  const wires: CircuitDocument["wires"] = [];
  for (const [index, terminal] of (["a", "b", "c"] as const).entries()) {
    fixTerminalVoltage(parts, wires, terminal, voltages[index] ?? 0, index);
  }
  return { title: "非線形素子の固定バイアス解析解", parts, wires };
}

function relativeError(actual: number, expected: number) {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);
}

function diodeSeriesCurrent(
  sourceVoltage: number,
  resistance: number,
  saturationCurrent: number,
  ideality: number,
) {
  let low = 0;
  let high = sourceVoltage / resistance;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const current = (low + high) / 2;
    const diodeVoltage = sourceVoltage - current * resistance;
    const diodeCurrent = saturationCurrent * Math.expm1(diodeVoltage / (ideality * 0.025_85));
    if (current > diodeCurrent) { high = current; }
    else { low = current; }
  }
  return (low + high) / 2;
}

function mosDrainCurrent(
  kind: "nmos" | "pmos",
  drain: number,
  gate: number,
  source: number,
  threshold: number,
  beta: number,
  lambda: number,
) {
  const polarity = kind === "pmos" ? -1 : 1;
  const vgs = polarity * (gate - source);
  const vds = polarity * (drain - source);
  const effectiveVgs = vds < 0 ? vgs - vds : vgs;
  const overdrive = effectiveVgs - threshold;
  if (overdrive <= 0) { return 0; }
  const magnitudeVds = Math.abs(vds);
  const squareLaw = magnitudeVds < overdrive
    ? beta * (overdrive * magnitudeVds - (magnitudeVds * magnitudeVds) / 2)
    : (beta * overdrive * overdrive) / 2;
  return polarity * Math.sign(vds) * squareLaw * (1 + lambda * magnitudeVds);
}

describe("nonlinear solver physical-equation audit", () => {
  it.each([
    { sourceVoltage: 0.8, resistance: 1000, saturationCurrent: 1e-12, ideality: 1 },
    { sourceVoltage: 0.25, resistance: 330, saturationCurrent: 1e-8, ideality: 2 },
    { sourceVoltage: 1.1, resistance: 47_000, saturationCurrent: 1e-16, ideality: 1.4 },
  ])("satisfies Shockley current and KVL for a diode load ($sourceVoltage V)", ({
    sourceVoltage,
    resistance,
    saturationCurrent,
    ideality,
  }) => {
    const document: CircuitDocument = {
      title: "ダイオード直列回路の解析解",
      parts: [
        part("source", "battery", { voltageVolts: sourceVoltage }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("device", "diode", { saturationCurrentAmps: saturationCurrent, emissionCoefficient: ideality }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-resistor", "source", "a", "resistor", "a"),
        wire("resistor-diode", "resistor", "b", "device", "a"),
        wire("diode-return", "device", "b", "source", "b"),
        wire("ground", "source", "b", "ground", "a"),
      ],
    };
    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    const expectedCurrent = diodeSeriesCurrent(sourceVoltage, resistance, saturationCurrent, ideality);
    const actualCurrent = analysis.parts.device.current.real;

    expect(analysis.status, analysis.message).toBe("valid");
    expect(relativeError(actualCurrent, expectedCurrent)).toBeLessThan(1e-9);
    expect(analysis.parts.resistor.current.real).toBeCloseTo(expectedCurrent, 10);
    expect(analysis.parts.source.current.real).toBeCloseTo(-expectedCurrent, 10);
    expect(
      sourceVoltage - analysis.parts.resistor.voltage.real - analysis.parts.device.voltage.real,
    ).toBeCloseTo(0, 10);
    expect(analysis.parts.device.terminalCurrents.a!.real + analysis.parts.device.terminalCurrents.b!.real)
      .toBeCloseTo(0, 12);
  });

  it.each([
    { kind: "npn-transistor", vc: 2, vb: 0.72, ve: 0, beta: 80, saturation: 1e-14 },
    { kind: "pnp-transistor", vc: 1.5, vb: 1.3, ve: 2, beta: 45, saturation: 3e-15 },
    { kind: "npn-transistor", vc: 0.4, vb: 0.5, ve: 0.8, beta: 12, saturation: 1e-15 },
  ] as const)("matches Ebers–Moll terminal currents and KCL for $kind", ({
    kind,
    vc,
    vb,
    ve,
    beta,
    saturation,
  }) => {
    const analysis = analyzeAnalogCircuit(
      fixedBiasDocument(kind, [vc, vb, ve], { currentGain: beta, saturationCurrentAmps: saturation }),
      { mode: "dc" },
    );
    const polarity = kind === "pnp-transistor" ? -1 : 1;
    const forward = saturation * Math.expm1((polarity * (vb - ve)) / 0.025_85);
    const reverse = saturation * Math.expm1((polarity * (vb - vc)) / 0.025_85);
    const expected = [
      polarity * (forward - 2 * reverse),
      polarity * (forward / beta + reverse),
      polarity * (-forward - forward / beta + reverse),
    ];
    const currents = analysis.parts.device.terminalCurrents;
    const actual = [currents.a?.real, currents.b?.real, currents.c?.real];

    expect(analysis.status, analysis.message).toBe("valid");
    for (let terminal = 0; terminal < 3; terminal += 1) {
      expect(actual[terminal]).toBeDefined();
      expect(relativeError(actual[terminal] ?? Number.NaN, expected[terminal] ?? 0)).toBeLessThan(1e-9);
    }
    expect(actual.reduce((sum, current) => sum + (current ?? 0), 0)).toBeCloseTo(0, 12);
  });

  it.each([
    { kind: "nmos", drain: -2, gate: 3, source: 5, threshold: 1, beta: 0.02, lambda: 0.01 },
    { kind: "pmos", drain: 8, gate: 4, source: 0, threshold: 2, beta: 0.02, lambda: 0.01 },
    { kind: "nmos", drain: -2, gate: 0, source: 5, threshold: 2, beta: 0.02, lambda: 0 },
    { kind: "pmos", drain: 2, gate: 10, source: 0, threshold: 2, beta: 0.02, lambda: 0 },
  ] as const)("matches the symmetric square-law channel and terminal KCL for $kind", ({
    kind,
    drain,
    gate,
    source,
    threshold,
    beta,
    lambda,
  }) => {
    const analysis = analyzeAnalogCircuit(
      fixedBiasDocument(kind, [drain, gate, source], {
        thresholdVolts: threshold,
        transconductanceAmpsPerVoltSquared: beta,
        channelLengthModulation: lambda,
      }),
      { mode: "dc" },
    );
    const actual = analysis.parts.device.terminalCurrents.a?.real;
    const expected = mosDrainCurrent(kind, drain, gate, source, threshold, beta, lambda);
    const currents = analysis.parts.device.terminalCurrents;

    expect(analysis.status, analysis.message).toBe("valid");
    expect(actual).toBeDefined();
    expect(relativeError(actual ?? Number.NaN, expected)).toBeLessThan(1e-9);
    expect(currents.a).toBeDefined();
    expect(currents.b).toBeDefined();
    expect(currents.c).toBeDefined();
    expect(
      (currents.a?.real ?? 0) + (currents.b?.real ?? 0) + (currents.c?.real ?? 0),
    ).toBeCloseTo(0, 12);
  });
});
