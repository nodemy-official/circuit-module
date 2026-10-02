import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit, type AnalogCircuitAnalysis } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  terminalsOf,
} from "../../circuit-model.js";
import { createCircuitFromSpecs, type CircuitSpec as NodePart } from "../helpers/circuit-fixture.js";

const circuit = (specs: readonly NodePart[]) =>
  createCircuitFromSpecs(specs, "Independent DC physical-equation audit");

function relativeError(actual: number, expected: number) {
  if (expected === 0) { return actual === 0 ? 0 : Number.POSITIVE_INFINITY; }
  return Math.abs((actual - expected) / expected);
}

// Independent binary64 physical equations; no solver math or device helper is used.
function physicalEquationFailures(specs: readonly NodePart[], analysis: AnalogCircuitAnalysis) {
  if (analysis.status !== "valid") { return [analysis.message]; }
  const failures: string[] = [];
  const match = (actual: number, expected: number, description: string) => {
    if (!(relativeError(actual, expected) < 2e-9)) {
      failures.push(`${description}: actual=${actual}, expected=${expected}`);
    }
  };
  const currentsByNode = new Map<string, number[]>();
  const powers: number[] = [];
  for (const [id, kind, nodes, values] of specs) {
    const reading = analysis.parts[id]!;
    const parameters = { ...circuitPartCatalog[kind].defaults, ...values };
    const voltages = terminalsOf(kind).map((terminal) => reading.terminalVoltages[terminal]!.real);
    const currents = terminalsOf(kind).map((terminal) => reading.terminalCurrents[terminal]!.real);
    for (const [index, current] of currents.entries()) {
      const node = nodes[index]!;
      const terms = currentsByNode.get(node) ?? [];
      terms.push(current);
      currentsByNode.set(node, terms);
    }
    powers.push(reading.power.real);
    const [va = 0, vb = 0, vc = 0] = voltages;
    if (kind === "resistor") {
      match(currents[0]!, reading.voltage.real / parameters.resistanceOhms!, `Ohm at ${id}`);
      // Public node projections may cancel when a reverse-leakage drop is only 1e-11 V.
      const projectionBound = 2 * Number.EPSILON * (Math.abs(va) + Math.abs(vb));
      if (!(Math.abs(va - vb - reading.voltage.real) <= projectionBound)) { failures.push(`Voltage projection at ${id}`); }
    }
    if (kind === "diode") {
      match(currents[0]!, parameters.saturationCurrentAmps! * Math.expm1((va - vb) / (parameters.emissionCoefficient! * 0.025_85)), `Shockley at ${id}`);
      match(currents[1]!, -currents[0]!, `Diode conservation at ${id}`);
    }
    if (kind === "npn-transistor" || kind === "pnp-transistor") {
      const sign = kind === "npn-transistor" ? 1 : -1;
      const forward = parameters.saturationCurrentAmps! * Math.expm1(sign * (vb - vc) / 0.025_85);
      const reverse = parameters.saturationCurrentAmps! * Math.expm1(sign * (vb - va) / 0.025_85);
      for (const [index, expected] of [
        sign * (forward - 2 * reverse),
        sign * (forward / parameters.currentGain! + reverse),
        sign * (-forward - forward / parameters.currentGain! + reverse),
      ].entries()) { match(currents[index]!, expected, `Ebers-Moll at ${id}:${index}`); }
    }
    if (kind === "nmos" || kind === "pmos") {
      const sign = kind === "nmos" ? 1 : -1;
      const vds = sign * (va - vc);
      const overdrive = sign * (vb - (vds < 0 ? va : vc)) - parameters.thresholdVolts!;
      const magnitude = Math.abs(vds);
      const squareLaw = overdrive <= 0 ? 0 : magnitude < overdrive
        ? parameters.transconductanceAmpsPerVoltSquared! * (overdrive * magnitude - magnitude ** 2 / 2)
        : parameters.transconductanceAmpsPerVoltSquared! * overdrive ** 2 / 2;
      const expected = sign * Math.sign(vds) * squareLaw * (1 + parameters.channelLengthModulation! * magnitude);
      match(currents[0]!, expected, `Square law at ${id}`);
      match(currents[1]!, 0, `Gate current at ${id}`);
      match(currents[2]!, -expected, `MOS conservation at ${id}`);
    }
    if (kind === "op-amp") {
      const target = Math.max(parameters.negativeRailVolts!, Math.min(parameters.positiveRailVolts!, parameters.openLoopGain! * (va - vb)));
      if (!(Math.abs(vc - target - 20 * currents[2]!) < 1e-9)) { failures.push(`Op-amp output law at ${id}`); }
      match(currents[0]!, 0, `Positive input current at ${id}`);
      match(currents[1]!, 0, `Negative input current at ${id}`);
      // The specified three-terminal op-amp returns output current through implicit GND.
      const returns = currentsByNode.get("0") ?? [];
      returns.push(-currents[2]!);
      currentsByNode.set("0", returns);
    }
  }
  for (const [node, currents] of currentsByNode) {
    const scale = currents.reduce((sum, current) => sum + Math.abs(current), 0);
    const residual = currents.reduce((sum, current) => sum + current, 0);
    if (!((scale === 0 ? residual : Math.abs(residual) / scale) < 1e-10)) { failures.push(`KCL at ${node}`); }
  }
  const powerScale = powers.reduce((sum, power) => sum + Math.abs(power), 0);
  const powerResidual = Math.abs(powers.reduce((sum, power) => sum + power, 0));
  if (!((powerScale === 0 ? powerResidual : powerResidual / powerScale) < 1e-10)) { failures.push("Total power conservation"); }
  return failures;
}

function bisect(lowerBound: number, upperBound: number, residual: (value: number) => number) {
  let low = lowerBound;
  let high = upperBound;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (residual(middle) > 0) { high = middle; }
    else { low = middle; }
  }
  return (low + high) / 2;
}

describe("DC references, device equations and convergence", () => {
  it.each(["grounded", "reordered", "floating"])("solves a four-diode bridge from Shockley and KVL (%s)", (variant) => {
    const specs: NodePart[] = [
      ["supply", "battery", ["high", "low"], { voltageVolts: 3.3 }],
      ["d1", "diode", ["high", "positive"]],
      ["d2", "diode", ["low", "positive"]],
      ["d3", "diode", ["negative", "high"]],
      ["d4", "diode", ["negative", "low"]],
      ["load", "resistor", ["positive", "negative"], { resistanceOhms: 680 }],
    ];
    if (variant !== "floating") { specs.push(["ground", "ground", ["low"]]); }
    if (variant === "reordered") { specs.reverse(); }
    const analysis = analyzeAnalogCircuit(circuit(specs), { mode: "dc" });
    expect(physicalEquationFailures(specs, analysis)).toEqual([]);
    const drop = bisect(0, 3.3 / 2, (voltage) => 1e-12 * (Math.expm1(voltage / 0.025_85) + Math.expm1((voltage - 3.3) / 0.025_85)) - (3.3 - 2 * voltage) / 680);
    expect(relativeError(analysis.parts.load!.current.real, (3.3 - 2 * drop) / 680)).toBeLessThan(2e-9);
  });

  it.each([false, true])("solves opposed diodes below reverse saturation (reordered=%s)", (reordered) => {
    const specs: NodePart[] = [
      ["ground", "ground", ["0"]],
      ["source", "current-source", ["0", "input"], { currentAmps: 4e-7 }],
      ["forward", "diode", ["input", "middle"], { saturationCurrentAmps: 1e-6 }],
      ["reverse", "diode", ["0", "middle"], { saturationCurrentAmps: 1e-6 }],
    ];
    if (reordered) { specs.reverse(); }
    const analysis = analyzeAnalogCircuit(circuit(specs), { mode: "dc" });
    expect(physicalEquationFailures(specs, analysis)).toEqual([]);
    expect(relativeError(analysis.parts.forward!.voltage.real, 0.025_85 * Math.log1p(0.4))).toBeLessThan(2e-9);
    expect(relativeError(analysis.parts.reverse!.voltage.real, 0.025_85 * Math.log1p(-0.4))).toBeLessThan(2e-9);
  });

  it("rejects opposed diodes when the imposed current exceeds reverse saturation", () => {
    const specs: NodePart[] = [
      ["ground", "ground", ["0"]],
      ["source", "current-source", ["0", "input"], { currentAmps: 2e-6 }],
      ["forward", "diode", ["input", "middle"], { saturationCurrentAmps: 1e-6 }],
      ["reverse", "diode", ["0", "middle"], { saturationCurrentAmps: 1e-6 }],
    ];
    // Shockley reverse current is strictly greater than -Is at every finite voltage.
    expect(analyzeAnalogCircuit(circuit(specs), { mode: "dc" }).status).toBe("invalid");
  });

  it.each(["npn-transistor", "pnp-transistor", "nmos", "pmos"] as const)("conserves a resistor-loaded current mirror including saturation (%s)", (kind) => {
    const sign = kind === "npn-transistor" || kind === "nmos" ? 1 : -1;
    for (const resistanceOhms of [1000, 10_000]) {
      const specs: NodePart[] = [
        ["ground", "ground", ["0"]],
        ["supply", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 5 }],
        ["reference-current", "current-source", ["0", "bias"], { currentAmps: sign * 0.001 }],
        ["reference", kind, ["bias", "bias", "0"]],
        ["output", kind, ["output", "bias", "0"]],
        ["load", "resistor", ["supply", "output"], { resistanceOhms }],
      ];
      expect(physicalEquationFailures(specs, analyzeAnalogCircuit(circuit(specs), { mode: "dc" }))).toEqual([]);
    }
  });

  it.each(["npn-transistor", "pnp-transistor", "nmos", "pmos"] as const)("handles pairwise terminal shorts without losing KCL (%s)", (kind) => {
    for (const short of ["ab", "bc", "ac"]) {
      const remaining = ["a", "b", "c"].find((terminal) => !short.includes(terminal))!;
      const specs: NodePart[] = [
        ["ground", "ground", ["0"]],
        ["supply", "battery", ["supply", "0"], { voltageVolts: 5 }],
        ["feed", "resistor", ["supply", "short"], { resistanceOhms: 1000 }],
        ["device", kind, ["a", "b", "c"].map((terminal) => short.includes(terminal) ? "short" : terminal)],
        ["return", "resistor", [remaining, "0"], { resistanceOhms: 1000 }],
      ];
      expect(physicalEquationFailures(specs, analyzeAnalogCircuit(circuit(specs), { mode: "dc" }))).toEqual([]);
    }
  });

  it.each([-1, 1])("accounts for an op-amp's implicit return and rail loading (%s V input)", (input) => {
    const specs: NodePart[] = [
      ["ground", "ground", ["0"]],
      ["input", "battery", input > 0 ? ["input", "0"] : ["0", "input"], { voltageVolts: 1 }],
      ["op", "op-amp", ["input", "0", "output"]],
      ["load", "resistor", ["output", "0"], { resistanceOhms: 1000 }],
    ];
    const analysis = analyzeAnalogCircuit(circuit(specs), { mode: "dc" });
    expect(physicalEquationFailures(specs, analysis)).toEqual([]);
    expect(relativeError(analysis.parts.op!.voltage.real, input * 15 * 1000 / 1020)).toBeLessThan(2e-9);
  });

  it.each(["nmos", "pmos"] as const)("solves negative feedback through a MOS source follower (%s)", (kind) => {
    const sign = kind === "nmos" ? 1 : -1;
    const specs: NodePart[] = [
      ["ground", "ground", ["0"]],
      ["supply", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 5 }],
      ["input", "battery", sign === 1 ? ["input", "0"] : ["0", "input"], { voltageVolts: 1 }],
      ["op", "op-amp", ["input", "sense", "drive"]],
      ["device", kind, ["supply", "drive", "sense"]],
      ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
    ];
    expect(physicalEquationFailures(specs, analyzeAnalogCircuit(circuit(specs), { mode: "dc" }))).toEqual([]);
  });

  it.each([
    { kind: "npn-transistor", input: 0.5, reordered: false },
    { kind: "npn-transistor", input: 1, reordered: true },
    { kind: "pnp-transistor", input: 1, reordered: false },
  ] as const)("finds the independently proven BJT feedback root ($kind, $input V, reordered=$reordered)", ({ kind, input, reordered }) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    const atEmitter = (emitter: number) => {
      // Eliminate exp(Vbe/Vt) directly from emitter KCL, retaining reverse transport.
      const reverseRatio = Math.exp((emitter - 5) / 0.025_85);
      const exponential = (emitter / (1000 * 1e-14) + 1 / 100) / (1 + 1 / 100 - reverseRatio);
      const base = emitter + 0.025_85 * Math.log(exponential);
      const forward = 1e-14 * (exponential - 1);
      const reverse = 1e-14 * (exponential * reverseRatio - 1);
      const baseCurrent = forward / 100 + reverse;
      return { emitter, base, baseCurrent, collectorCurrent: forward - 2 * reverse, emitterCurrent: -forward - forward / 100 + reverse };
    };
    const equation = (emitter: number) => {
      const point = atEmitter(emitter);
      return point.base + 20 * point.baseCurrent - 100_000 * (input - emitter);
    };
    expect(equation(0)).toBeLessThan(0);
    expect(equation(input)).toBeGreaterThan(0);
    const expected = atEmitter(bisect(0, input, equation));
    expect(Math.abs(equation(expected.emitter))).toBeLessThan(2e-11);
    expect(Math.abs(expected.emitterCurrent + expected.emitter / 1000)).toBeLessThan(1e-17);
    expect(expected.base + 20 * expected.baseCurrent).toBeLessThan(15);
    const specs: NodePart[] = [
      ["ground", "ground", ["0"]],
      ["supply", "battery", sign === 1 ? ["supply", "0"] : ["0", "supply"], { voltageVolts: 5 }],
      ["input", "battery", sign === 1 ? ["input", "0"] : ["0", "input"], { voltageVolts: input }],
      ["op", "op-amp", ["input", "sense", "drive"]],
      ["device", kind, ["supply", "drive", "sense"]],
      ["load", "resistor", ["sense", "0"], { resistanceOhms: 1000 }],
    ];
    if (reordered) { specs.reverse(); }
    const analysis = analyzeAnalogCircuit(circuit(specs), { mode: "dc" });
    // Regression: initialization must not reject this independently proven feedback root.
    expect(analysis.status, analysis.message).toBe("valid");
    expect(physicalEquationFailures(specs, analysis)).toEqual([]);
    expect(relativeError(analysis.parts.device!.terminalVoltages.c!.real, sign * expected.emitter)).toBeLessThan(2e-9);
    expect(relativeError(analysis.parts.device!.terminalVoltages.b!.real, sign * expected.base)).toBeLessThan(2e-9);
    expect(relativeError(analysis.parts.device!.terminalCurrents.a!.real, sign * expected.collectorCurrent)).toBeLessThan(2e-9);
  }, 120_000);
});
