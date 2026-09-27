import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
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
) => ({ id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } });

const polar = (magnitude: number, phaseDegrees: number) => {
  const phase = phaseDegrees * Math.PI / 180;
  return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
};

const add = (left: { real: number; imaginary: number }, right: { real: number; imaginary: number }) => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

const divide = (left: { real: number; imaginary: number }, right: { real: number; imaginary: number }) => {
  const denominator = right.real ** 2 + right.imaginary ** 2;
  return {
    real: (left.real * right.real + left.imaginary * right.imaginary) / denominator,
    imaginary: (left.imaginary * right.real - left.real * right.imaginary) / denominator,
  };
};

function expectPhasor(
  actual: { real: number; imaginary: number },
  expected: { real: number; imaginary: number },
  relativeTolerance = 1e-8,
  absoluteTolerance = 1e-12,
) {
  const error = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  const tolerance = absoluteTolerance + relativeTolerance * Math.hypot(expected.real, expected.imaginary);
  if (error > tolerance) {
    throw new Error(`actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} error=${error} tolerance=${tolerance}`);
  }
}

function assertKcl(document: CircuitDocument, result: Extract<ReturnType<typeof analyzeAnalogCircuit>, { status: "valid" }>) {
  const parent = new Map<string, string>();
  const key = (partId: string, terminal: CircuitTerminal) => JSON.stringify([partId, terminal]);
  const find = (endpoint: string): string => {
    const previous = parent.get(endpoint);
    if (!previous) { parent.set(endpoint, endpoint); return endpoint; }
    if (previous === endpoint) { return endpoint; }
    const root = find(previous);
    parent.set(endpoint, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) { parent.set(leftRoot, rightRoot); }
  };

  for (const item of document.parts) {
    for (const terminal of terminalsOf(item.kind)) { find(key(item.id, terminal)); }
  }
  for (const connection of document.wires) {
    union(key(connection.from.partId, connection.from.terminal), key(connection.to.partId, connection.to.terminal));
  }
  const grounds = document.parts.filter((item) => item.kind === "ground");
  for (const ground of grounds.slice(1)) { union(key(grounds[0]!.id, "a"), key(ground.id, "a")); }

  const currents = new Map<string, { real: number; imaginary: number }>();
  const scales = new Map<string, number>();
  for (const item of document.parts) {
    const reading = result.parts[item.id];
    for (const terminal of terminalsOf(item.kind)) {
      const net = find(key(item.id, terminal));
      const current = reading?.terminalCurrents[terminal] ?? { real: 0, imaginary: 0 };
      currents.set(net, add(currents.get(net) ?? { real: 0, imaginary: 0 }, current));
      scales.set(net, (scales.get(net) ?? 0) + Math.hypot(current.real, current.imaginary));
    }
  }
  for (const [net, current] of currents) {
    const residual = Math.hypot(current.real, current.imaginary);
    const tolerance = 1e-9 * Math.max(1, scales.get(net) ?? 0);
    if (residual >= tolerance) {
      throw new Error(`KCL residual at ${net} is ${residual} A (tolerance ${tolerance} A)`);
    }
  }
}

function assertNodeAndTerminalVoltagesAgree(
  document: CircuitDocument,
  result: Extract<ReturnType<typeof analyzeAnalogCircuit>, { status: "valid" }>,
) {
  const parent = new Map<string, string>();
  const key = (partId: string, terminal: CircuitTerminal) => JSON.stringify([partId, terminal]);
  const find = (endpoint: string): string => {
    const previous = parent.get(endpoint);
    if (!previous) { parent.set(endpoint, endpoint); return endpoint; }
    if (previous === endpoint) { return endpoint; }
    const root = find(previous);
    parent.set(endpoint, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) { parent.set(leftRoot, rightRoot); }
  };
  for (const item of document.parts) {
    for (const terminal of terminalsOf(item.kind)) { find(key(item.id, terminal)); }
  }
  for (const connection of document.wires) {
    union(key(connection.from.partId, connection.from.terminal), key(connection.to.partId, connection.to.terminal));
  }
  const grounds = document.parts.filter((item) => item.kind === "ground");
  for (const ground of grounds.slice(1)) { union(key(grounds[0]!.id, "a"), key(ground.id, "a")); }

  const firstEndpointByNet = new Map<string, string>();
  const voltageByNet = new Map<string, { real: number; imaginary: number }>();
  for (const item of document.parts) {
    const reading = result.parts[item.id];
    for (const terminal of terminalsOf(item.kind)) {
      const endpoint = key(item.id, terminal);
      const net = find(endpoint);
      const voltage = reading?.terminalVoltages[terminal];
      if (!voltage) { throw new Error(`Missing terminal voltage at ${item.id}:${terminal}`); }
      const firstVoltage = voltageByNet.get(net);
      if (firstVoltage && (firstVoltage.real !== voltage.real || firstVoltage.imaginary !== voltage.imaginary)) {
        throw new Error(`Terminal voltage mismatch within net ${net}`);
      }
      if (!firstVoltage) {
        voltageByNet.set(net, voltage);
        const label = `${item.id}:${terminal}`;
        firstEndpointByNet.set(net, label);
        const nodeVoltage = result.nodeVoltages[label];
        if (!nodeVoltage || nodeVoltage.real !== voltage.real || nodeVoltage.imaginary !== voltage.imaginary) {
          throw new Error(`nodeVoltages[${label}] does not match the first terminal voltage on that net`);
        }
      }
    }
  }
  if (Object.keys(result.nodeVoltages).length !== firstEndpointByNet.size) {
    throw new Error("nodeVoltages does not contain exactly one entry per electrical net");
  }
}

describe("AC reference invariants with floating components", () => {
  it("keeps analytic parallel branch values and a voltmeter correct when the driven network floats", () => {
    const voltage = polar(8, -27);
    const frequencyHz = 230;
    const omega = 2 * Math.PI * frequencyHz;
    const resistance = 120;
    const inductance = 0.03;
    const capacitance = 47e-6;
    const document: CircuitDocument = {
      title: "GNDから独立した交流並列回路",
      parts: [
        part("source", "ac-source", { voltageVolts: 8, phaseDegrees: -27, frequencyHz }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("inductor", "inductor", { inductanceHenries: inductance }),
        part("capacitor", "capacitor", { capacitanceFarads: capacitance }),
        part("meter", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-resistor-a", "source", "a", "resistor", "a"),
        wire("source-inductor-a", "source", "a", "inductor", "a"),
        wire("source-capacitor-a", "source", "a", "capacitor", "a"),
        wire("source-meter-a", "source", "a", "meter", "a"),
        wire("resistor-return", "resistor", "b", "source", "b"),
        wire("inductor-return", "inductor", "b", "source", "b"),
        wire("capacitor-return", "capacitor", "b", "source", "b"),
        wire("meter-return", "meter", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    if (result.status !== "valid") { return; }

    const expectedResistorCurrent = divide(voltage, { real: resistance, imaginary: 0 });
    const expectedInductorCurrent = divide(voltage, { real: 0, imaginary: omega * inductance });
    const expectedCapacitorCurrent = divide(voltage, { real: 0, imaginary: -1 / (omega * capacitance) });
    const expectedSourceCurrent = {
      real: -(expectedResistorCurrent.real + expectedInductorCurrent.real + expectedCapacitorCurrent.real),
      imaginary: -(expectedResistorCurrent.imaginary + expectedInductorCurrent.imaginary + expectedCapacitorCurrent.imaginary),
    };

    for (const id of ["resistor", "inductor", "capacitor", "meter"]) {
      expectPhasor(result.parts[id]!.voltage, voltage);
    }
    expectPhasor(result.parts.resistor.current, expectedResistorCurrent);
    expectPhasor(result.parts.inductor.current, expectedInductorCurrent);
    expectPhasor(result.parts.capacitor.current, expectedCapacitorCurrent);
    expectPhasor(result.parts.source.current, expectedSourceCurrent);
    expect(result.parts.meter.meterStatus).toBe("connected");
    expect(result.parts.ground.terminalVoltages.a).toEqual({ real: 0, imaginary: 0 });
    expect(result.nodeVoltages["ground:a"]).toEqual({ real: 0, imaginary: 0 });
    expectPhasor(result.parts.resistor.terminalVoltages.a!, result.parts.inductor.terminalVoltages.a!);
    expectPhasor(result.parts.resistor.terminalVoltages.b!, result.parts.capacitor.terminalVoltages.b!);
    assertNodeAndTerminalVoltagesAgree(document, result);
    assertKcl(document, result);
  });

  it("preserves millivolt branch and meter voltages in a floating high common-mode loop", () => {
    const document: CircuitDocument = {
      title: "GNDから独立した高共通電位の微小交流回路",
      parts: [
        part("high", "ac-source", { voltageVolts: 1e16, phaseDegrees: 31, frequencyHz: 60 }),
        part("left", "resistor", { resistanceOhms: 1e16 }),
        part("small", "ac-source", { voltageVolts: 2e-3, phaseDegrees: -47, frequencyHz: 60 }),
        part("load", "resistor", { resistanceOhms: 1e-3 }),
        part("right", "resistor", { resistanceOhms: 1e16 }),
        part("meter", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("high-left", "high", "a", "left", "a"),
        wire("left-small", "left", "b", "small", "a"),
        wire("left-load", "left", "b", "load", "a"),
        wire("small-right", "small", "b", "right", "a"),
        wire("load-right", "load", "b", "right", "a"),
        wire("return", "high", "b", "right", "b"),
        wire("meter-load-a", "meter", "a", "load", "a"),
        wire("meter-load-b", "meter", "b", "load", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    if (result.status !== "valid") { return; }

    const expectedSmallVoltage = polar(2e-3, -47);
    expectPhasor(result.parts.small.voltage, expectedSmallVoltage, 1e-8, 1e-13);
    expectPhasor(result.parts.load.voltage, expectedSmallVoltage, 1e-8, 1e-13);
    expectPhasor(result.parts.meter.voltage, expectedSmallVoltage, 1e-8, 1e-13);
    expect(result.parts.meter.meterStatus).toBe("connected");
    expect(result.parts.load.terminalVoltages.a!.real).toBe(result.parts.load.terminalVoltages.b!.real);
    expect(result.parts.load.terminalVoltages.a!.imaginary).toBe(result.parts.load.terminalVoltages.b!.imaginary);
    expect(result.parts.ground.terminalVoltages.a).toEqual({ real: 0, imaginary: 0 });
    expect(result.nodeVoltages["ground:a"]).toEqual({ real: 0, imaginary: 0 });
    assertNodeAndTerminalVoltagesAgree(document, result);
    assertKcl(document, result);
  });
});
