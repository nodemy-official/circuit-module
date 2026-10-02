import { describe, expect, it } from "vitest";

import { complexMagnitude, complexPhaseDegrees, exactComponentSum, type ComplexValue } from "../../analog-math.js";
import { analyzeAnalogCircuit, type AnalogCircuitAnalysis, type AnalogCircuitPartReading } from "../../analog-solver.js";
import { circuitPartCatalog, terminalsOf, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function dcDividerDocument(midpointKind: "junction" | "ground", reverseParts: boolean): CircuitDocument {
  const parts = [
    part("midpoint", midpointKind),
    part("source", "battery", { voltageVolts: 4, internalResistanceOhms: 270 }),
    part("load", "resistor", { resistanceOhms: 15 }),
    part("upper", "resistor", { resistanceOhms: 1e11 }),
    part("lower", "resistor", { resistanceOhms: 1e18 }),
  ];
  return {
    title: "弱参照点を含む直流分圧回路",
    parts: reverseParts ? [...parts].reverse() : parts,
    wires: [
      wire("w1", "source", "a", "load", "a"),
      wire("w2", "load", "a", "upper", "a"),
      wire("w3", "upper", "b", "midpoint", "a"),
      wire("w4", "midpoint", "a", "lower", "a"),
      wire("w5", "lower", "b", "source", "b"),
      wire("w6", "load", "b", "source", "b"),
    ],
  };
}

type WeakTransientInductor = "none" | "unconnected" | "parallel-to-load";

function weakReferenceTransientDocument(inductor: WeakTransientInductor): CircuitDocument {
  const parts = [
    part("n0", "junction"),
    part("n1", "junction"),
    part("n3", "junction"),
    part("p0", "battery", { voltageVolts: 4, internalResistanceOhms: 270 }),
    part("p3", "resistor", { resistanceOhms: 1e11 }),
    part("p8", "resistor", { resistanceOhms: 1e18 }),
    part("p10", "resistor", { resistanceOhms: 15 }),
  ];
  if (inductor !== "none") {
    parts.push(part("unconnected-inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0 }));
  }
  return {
    title: "弱参照点を含む過渡直流分圧回路",
    parts,
    wires: [
      wire("w0a", "p0", "a", "n3", "a"),
      wire("w0b", "p0", "b", "n1", "a"),
      wire("w3a", "p3", "a", "n0", "a"),
      wire("w3b", "p3", "b", "n3", "a"),
      wire("w8a", "p8", "a", "n0", "a"),
      wire("w8b", "p8", "b", "n1", "a"),
      wire("w10a", "p10", "a", "n1", "a"),
      wire("w10b", "p10", "b", "n3", "a"),
      ...(inductor === "parallel-to-load"
        ? [
            wire("wire-inductor-a", "unconnected-inductor", "a", "p10", "a"),
            wire("wire-inductor-b", "unconnected-inductor", "b", "p10", "b"),
          ]
        : []),
    ],
  };
}

function acDividerDocument(phaseDegrees: number, midpointKind: "junction" | "ground", reverseParts: boolean): CircuitDocument {
  const parts = [
    part("midpoint", midpointKind),
    part("source", "ac-source", { voltageVolts: 4, frequencyHz: 1000, phaseDegrees }),
    part("series", "resistor", { resistanceOhms: 270 }),
    part("load", "resistor", { resistanceOhms: 15 }),
    part("upper", "resistor", { resistanceOhms: 1e11 }),
    part("lower", "resistor", { resistanceOhms: 1e18 }),
  ];
  return {
    title: "弱参照点を含む交流分圧回路",
    parts: reverseParts ? [...parts].reverse() : parts,
    wires: [
      wire("w1", "source", "a", "series", "a"),
      wire("w2", "series", "b", "load", "a"),
      wire("w3", "load", "a", "upper", "a"),
      wire("w4", "upper", "b", "midpoint", "a"),
      wire("w5", "midpoint", "a", "lower", "a"),
      wire("w6", "lower", "b", "load", "b"),
      wire("w7", "load", "b", "source", "b"),
    ],
  };
}

function dividerOracle(sourceVoltage: number, seriesResistance: number) {
  const upperResistance = 1e11;
  const lowerResistance = 1e18;
  const loadResistance = 15;
  const dividerResistance = upperResistance + lowerResistance;
  const parallelResistance = 1 / (1 / loadResistance + 1 / dividerResistance);
  const sourceCurrent = sourceVoltage / (seriesResistance + parallelResistance);
  const loadVoltage = sourceCurrent * parallelResistance;
  const loadCurrent = loadVoltage / loadResistance;
  const dividerCurrent = loadVoltage / dividerResistance;
  return {
    sourceCurrent,
    loadVoltage,
    loadCurrent,
    upperVoltage: dividerCurrent * upperResistance,
    lowerVoltage: dividerCurrent * lowerResistance,
    dividerCurrent,
  };
}

function reading(analysis: AnalogCircuitAnalysis, partId: string): AnalogCircuitPartReading {
  const result = analysis.parts[partId];
  if (!result) { throw new Error(`Missing analog reading for ${partId}`); }
  return result;
}

function terminalCurrent(analysis: AnalogCircuitAnalysis, partId: string, terminal: CircuitTerminal): ComplexValue {
  const current = reading(analysis, partId).terminalCurrents[terminal];
  if (!current) { throw new Error(`Missing ${partId}:${terminal} current`); }
  return current;
}

function firstTerminalPotential(document: CircuitDocument, analysis: AnalogCircuitAnalysis): ComplexValue | undefined {
  const firstPart = document.parts[0];
  const firstTerminal = firstPart ? terminalsOf(firstPart.kind)[0] : undefined;
  return firstPart && firstTerminal ? reading(analysis, firstPart.id).terminalVoltages[firstTerminal] : undefined;
}

function relativeError(actual: number, expected: number) {
  return Math.abs(actual / expected - 1);
}

function relativeKclResidual(components: ComplexValue[]) {
  const real = exactComponentSum(components.map((value) => value.real));
  const imaginary = exactComponentSum(components.map((value) => value.imaginary));
  const scale = Math.max(...components.map(complexMagnitude));
  return Math.hypot(real, imaginary) / scale;
}

function relativeRealKclResidual(components: number[]) {
  const residual = Math.abs(exactComponentSum(components));
  const scale = Math.max(...components.map(Math.abs));
  return scale === 0 ? residual : residual / scale;
}

function sampleTerminalCurrent(
  sample: ReturnType<typeof simulateTransient>["samples"][number],
  partId: string,
  terminal: CircuitTerminal,
) {
  const current = sample.parts[partId]?.terminalCurrents?.[terminal];
  if (current === undefined) { throw new Error(`Missing ${partId}:${terminal} transient current`); }
  return current;
}

function dividerReadingErrors(analysis: AnalogCircuitAnalysis, oracle: ReturnType<typeof dividerOracle>, phaseDegrees = 0) {
  const sourceCurrent = reading(analysis, "source").current;
  const load = reading(analysis, "load");
  const upper = reading(analysis, "upper");
  const lower = reading(analysis, "lower");
  const errors = [
    relativeError(complexMagnitude(sourceCurrent), oracle.sourceCurrent),
    relativeError(complexMagnitude(load.current), oracle.loadCurrent),
    relativeError(complexMagnitude(load.voltage), oracle.loadVoltage),
    relativeError(complexMagnitude(upper.current), oracle.dividerCurrent),
    relativeError(complexMagnitude(lower.current), oracle.dividerCurrent),
    relativeError(complexMagnitude(upper.voltage), oracle.upperVoltage),
    relativeError(complexMagnitude(lower.voltage), oracle.lowerVoltage),
  ];
  if (analysis.mode === "ac") {
    errors.push(
      Math.abs(complexPhaseDegrees(upper.current) - phaseDegrees),
      Math.abs(complexPhaseDegrees(lower.current) - phaseDegrees),
      Math.abs(complexPhaseDegrees(upper.voltage) - phaseDegrees),
      Math.abs(complexPhaseDegrees(lower.voltage) - phaseDegrees),
    );
  }
  return errors;
}

describe("analog DC analysis with a weak divider reference", () => {
  it.each([
    ["junction first", "junction", false],
    ["ground at the divider midpoint", "ground", false],
    ["reversed part order", "junction", true],
  ] as const)("matches an equivalent-resistance oracle with %s", (_case, midpointKind, reverseParts) => {
    const document = dcDividerDocument(midpointKind, reverseParts);
    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    const oracle = dividerOracle(4, 270);

    expect(analysis.status, analysis.message).toBe("valid");
    for (const error of dividerReadingErrors(analysis, oracle)) { expect(error).toBeLessThan(1e-8); }
    if (midpointKind === "ground") {
      expect(reading(analysis, "midpoint").terminalVoltages.a).toEqual({ real: 0, imaginary: 0 });
    } else {
      expect(firstTerminalPotential(document, analysis)).toEqual({ real: 0, imaginary: 0 });
    }
    expect(relativeKclResidual([
      terminalCurrent(analysis, "source", "a"),
      terminalCurrent(analysis, "load", "a"),
      terminalCurrent(analysis, "upper", "a"),
    ])).toBeLessThan(1e-12);
    expect(relativeKclResidual([
      terminalCurrent(analysis, "source", "b"),
      terminalCurrent(analysis, "load", "b"),
      terminalCurrent(analysis, "lower", "b"),
    ])).toBeLessThan(1e-12);
    expect(relativeKclResidual([
      terminalCurrent(analysis, "upper", "b"),
      terminalCurrent(analysis, "lower", "a"),
    ])).toBeLessThan(1e-12);
  });
});

describe("analog AC analysis with a weak divider reference", () => {
  it.each([0, 37, 90])("preserves the divider phasor at source phase %s degrees across part orders", (phaseDegrees) => {
    const oracle = dividerOracle(4, 270);
    const documents: [CircuitDocument, "junction" | "ground"][] = [
      [acDividerDocument(phaseDegrees, "junction", false), "junction"],
      [acDividerDocument(phaseDegrees, "ground", false), "ground"],
      [acDividerDocument(phaseDegrees, "junction", true), "junction"],
    ];

    for (const [document, midpointKind] of documents) {
      const analysis = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(analysis.status, analysis.message).toBe("valid");
      for (const error of dividerReadingErrors(analysis, oracle, phaseDegrees)) { expect(error).toBeLessThan(1e-8); }
      if (midpointKind === "ground") {
        expect(reading(analysis, "midpoint").terminalVoltages.a).toEqual({ real: 0, imaginary: 0 });
      } else {
        expect(firstTerminalPotential(document, analysis)).toEqual({ real: 0, imaginary: 0 });
      }
      expect(relativeKclResidual([
        terminalCurrent(analysis, "source", "a"),
        terminalCurrent(analysis, "series", "a"),
      ])).toBeLessThan(1e-12);
      expect(relativeKclResidual([
        terminalCurrent(analysis, "series", "b"),
        terminalCurrent(analysis, "load", "a"),
        terminalCurrent(analysis, "upper", "a"),
      ])).toBeLessThan(1e-12);
      expect(relativeKclResidual([
        terminalCurrent(analysis, "source", "b"),
        terminalCurrent(analysis, "load", "b"),
        terminalCurrent(analysis, "lower", "b"),
      ])).toBeLessThan(1e-12);
      expect(relativeKclResidual([
        terminalCurrent(analysis, "upper", "b"),
        terminalCurrent(analysis, "lower", "a"),
      ])).toBeLessThan(1e-12);
    }
  });
});

describe("transient initialization with a weak divider reference", () => {
  it.each([
    ["without inductors", "none"],
    ["with an unrelated unconnected inductor", "unconnected"],
    ["with a zero-current inductor parallel to the load", "parallel-to-load"],
  ] as const)("matches the initial oracle and checks the first step %s", (_case, inductor) => {
    const document = weakReferenceTransientDocument(inductor);
    // At t=0, the inductor current is fixed at its initial value. The no-L
    // circuit is therefore the appropriate DC oracle, including when a zero-
    // current inductor is physically placed in parallel with the load.
    const dcDocument = inductor === "parallel-to-load" ? weakReferenceTransientDocument("none") : document;
    const dc = analyzeAnalogCircuit(dcDocument, { mode: "dc" });
    const transient = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
    const oracle = dividerOracle(4, 270);
    const expectedCurrents = {
      p0: -oracle.sourceCurrent,
      p3: -oracle.dividerCurrent,
      p8: oracle.dividerCurrent,
      p10: -oracle.loadCurrent,
    };
    const transientMismatches: string[] = [];

    expect(dc.status, dc.message).toBe("valid");
    expect(transient.status, transient.message).toBe("valid");
    for (const [partId, expected] of Object.entries(expectedCurrents)) {
      expect(relativeError(reading(dc, partId).current.real, expected), `DC oracle for ${partId}`).toBeLessThan(1e-8);
      const samplesToCompare = inductor === "parallel-to-load" ? transient.samples.slice(0, 1) : transient.samples.slice(0, 2);
      for (const sample of samplesToCompare) {
        const current = sample.parts[partId]?.currentAmps ?? Number.NaN;
        const error = relativeError(current, reading(dc, partId).current.real);
        if (!(error < 1e-8)) { transientMismatches.push(`${partId} at t=${sample.timeSeconds}: ${current} (relative error ${error})`); }
      }
    }
    expect(transientMismatches).toEqual([]);

    if (inductor === "parallel-to-load") {
      const firstStep = transient.samples[1];
      if (!firstStep) { throw new Error("Missing first transient step"); }
      expect(relativeError(firstStep.parts.p3.currentAmps, -firstStep.parts.p8.currentAmps))
        .toBeLessThan(1e-12);
      expect(relativeRealKclResidual([
        sampleTerminalCurrent(firstStep, "p3", "a"),
        sampleTerminalCurrent(firstStep, "p8", "a"),
      ])).toBeLessThan(1e-12);
      expect(relativeRealKclResidual([
        sampleTerminalCurrent(firstStep, "p0", "a"),
        sampleTerminalCurrent(firstStep, "p3", "b"),
        sampleTerminalCurrent(firstStep, "p10", "b"),
        sampleTerminalCurrent(firstStep, "unconnected-inductor", "b"),
      ])).toBeLessThan(1e-12);
      expect(relativeRealKclResidual([
        sampleTerminalCurrent(firstStep, "p0", "b"),
        sampleTerminalCurrent(firstStep, "p8", "b"),
        sampleTerminalCurrent(firstStep, "p10", "a"),
        sampleTerminalCurrent(firstStep, "unconnected-inductor", "a"),
      ])).toBeLessThan(1e-12);
    }
  });
});
