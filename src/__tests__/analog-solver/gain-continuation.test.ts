import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
} from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

type Spec = readonly [string, CircuitPartKind, readonly string[], Partial<CircuitPart>?];

function circuit(specs: readonly Spec[]): CircuitDocument {
  const parts = specs.map(([id, kind, , values]) => ({
    id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
  }));
  const nets = new Map<string, CircuitDocument["wires"][number]["from"]>();
  const wires: CircuitDocument["wires"] = [];
  for (const [id, kind, nodes] of specs) {
    for (const [index, terminal] of terminalsOf(kind).entries()) {
      const endpoint = { partId: id, terminal };
      const previous = nets.get(nodes[index]!);
      if (previous) { wires.push({ id: `w${wires.length}`, from: previous, to: endpoint }); }
      else { nets.set(nodes[index]!, endpoint); }
    }
  }
  return { title: "Independent gain continuation audit", parts, wires };
}

interface Feedback {
  gain: number;
  input: number;
  rail: number;
  sign: number;
}

const nominal: Feedback = { gain: 100_000, input: 1, rail: 15, sign: 1 };

function feedbackSpecs(scenario: Feedback, prefix = "", useAc = false): Spec[] {
  const node = (name: string) => `${prefix}${name}`;
  const oriented = (positive: string, negative: string) => scenario.sign === 1
    ? [positive, negative] : [negative, positive];
  return [
    [node("supply"), "battery", oriented(node("collector"), "0"), { voltageVolts: 5 }],
    [node("input"), useAc ? "ac-source" : "battery", useAc ? [node("input"), "0"] : oriented(node("input"), "0"), useAc
      ? { voltageVolts: 1e-4, offsetVolts: scenario.sign * scenario.input, frequencyHz: 1000 }
      : { voltageVolts: scenario.input }],
    [node("op"), "op-amp", [node("input"), node("emitter"), node("base")], {
      openLoopGain: scenario.gain,
      positiveRailVolts: scenario.sign === 1 ? scenario.rail : 15,
      negativeRailVolts: scenario.sign === 1 ? -15 : -scenario.rail,
    }],
    [node("q"), scenario.sign === 1 ? "npn-transistor" : "pnp-transistor", [node("collector"), node("base"), node("emitter")]],
    [node("load"), "resistor", [node("emitter"), "0"], { resistanceOhms: 1000 }],
  ];
}

// Independent elimination of Ebers-Moll emitter KCL. Solve for the input
// error directly: evaluating G * (Vin - Ve) loses precision at G=1e12.
// Math.log/exp appear only at the physical junction approximation boundary.
function feedbackOracle(scenario: Feedback) {
  const atError = (error: number) => {
    const emitter = scenario.input - error;
    const ratio = Math.exp((emitter - 5) / 0.025_85);
    const exponential = (emitter / (1000 * 1e-14) + 0.01) / (1.01 - ratio);
    const base = emitter + 0.025_85 * Math.log(exponential);
    const baseCurrent = 1e-14 * ((exponential - 1) / 100 + exponential * ratio - 1);
    const drive = base + 20 * baseCurrent;
    return { emitter, base, baseCurrent, drive, exponential, ratio,
      residual: Math.min(scenario.rail, scenario.gain * error) - drive };
  };
  let low = 0;
  let high = scenario.input;
  if (!(atError(low).residual < 0 && atError(high).residual > 0)) {
    throw new Error("Independent input-error equation has no bracket");
  }
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const middle = (low + high) / 2;
    if (atError(middle).residual < 0) { low = middle; }
    else { high = middle; }
  }
  const result = atError((low + high) / 2);
  if (!(Math.abs(result.residual) < 2e-14)) {
    throw new Error(`Independent root residual: ${result.residual}`);
  }
  return result;
}

function relative(actual: number, expected: number) {
  return Math.abs((actual - expected) / expected);
}

function feedbackErrors(result: ReturnType<typeof analyzeAnalogCircuit>, scenario: Feedback, prefix = "") {
  const expected = feedbackOracle(scenario);
  const load = result.parts[`${prefix}load`]!;
  const transistor = result.parts[`${prefix}q`]!;
  const op = result.parts[`${prefix}op`]!;
  return [
    [relative(load.voltage.real, scenario.sign * expected.emitter), 2e-9],
    [relative(transistor.terminalVoltages.b!.real, scenario.sign * expected.base), 2e-9],
    [relative(transistor.terminalCurrents.b!.real, scenario.sign * expected.baseCurrent), 2e-9],
    [Math.abs(transistor.terminalCurrents.c!.real + load.current.real) / Math.abs(load.current.real), 2e-10],
    [Math.abs(op.current.real + transistor.terminalCurrents.b!.real) / Math.abs(expected.baseCurrent), 2e-10],
  ];
}

describe("independent op-amp gain continuation audit", () => {
  it.each([0.999_999, 1, 1.000_001])("solves at the strict linear-seed rail boundary, factor=%s", (factor) => {
    const scenario = { ...nominal, gain: 1e7, input: factor * 15 / 1e7 };
    const result = analyzeAnalogCircuit(circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario)]), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    for (const [error, tolerance] of feedbackErrors(result, scenario)) { expect(error).toBeLessThan(tolerance!); }
  }, 30_000);

  it.each([1e9, 1e12])("preserves a finite-gain DC and AC root at gain %s", (gain) => {
    const scenario = { ...nominal, gain };
    const expected = feedbackOracle(scenario);
    const document = circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario, "", true)]);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    for (const [error, tolerance] of feedbackErrors(dc, scenario)) { expect(error).toBeLessThan(tolerance!); }
    const exponentialDerivative = (1 / (1000 * 1e-14) + expected.exponential * expected.ratio / 0.025_85) / (1.01 - expected.ratio);
    const baseDerivative = 1 + 0.025_85 * exponentialDerivative / expected.exponential;
    const baseCurrentDerivative = 1e-14 * (exponentialDerivative / 100
      + exponentialDerivative * expected.ratio + expected.exponential * expected.ratio / 0.025_85);
    const emitterGain = gain / (gain + baseDerivative + 20 * baseCurrentDerivative);
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    expect(relative(ac.parts.load!.voltage.real, emitterGain * 1e-4)).toBeLessThan(2e-9);
    expect(relative(ac.parts.q!.terminalVoltages.b!.real, emitterGain * baseDerivative * 1e-4)).toBeLessThan(2e-9);
  }, 60_000);

  it.each([1, -1])("retains a finite AC derivative immediately inside the rail, sign=%s", (sign) => {
    const unclipped = feedbackOracle(nominal);
    const scenario = { ...nominal, sign, rail: unclipped.drive + 1e-6 };
    const document = circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario, "", true)]);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    for (const [error, tolerance] of feedbackErrors(dc, scenario)) { expect(error).toBeLessThan(tolerance!); }
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    expect(relative(ac.parts.load!.voltage.real, 1e-4 / (1 + (1 + 0.025_85 / unclipped.emitter + 20 / 101_000) / nominal.gain))).toBeLessThan(2e-9);
  }, 30_000);

  it.each([1, -1])("clips consistently immediately outside the rail, sign=%s", (sign) => {
    const scenario = { ...nominal, sign, rail: feedbackOracle(nominal).drive - 1e-6 };
    const document = circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario, "", true)]);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    for (const [error, tolerance] of feedbackErrors(dc, scenario)) { expect(error).toBeLessThan(tolerance!); }
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.load!.voltage.real).toBe(0);
    expect(ac.parts.op!.current.real).toBe(0);
  }, 30_000);

  it.each([false, true])("restores every original gain for mixed-gain amplifiers, reversed=%s", (reversed) => {
    const scenarios = [{ ...nominal, gain: 0.5 }, { ...nominal, gain: 17, sign: -1 }, { ...nominal, gain: 1e7 }];
    const specs: Spec[] = [["ground", "ground", ["0"]], ...scenarios.flatMap((scenario, index) => feedbackSpecs(scenario, `${index}-`))];
    const document = circuit(reversed ? specs.reverse() : specs);
    const original = JSON.stringify(document);
    const result = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    for (const [index, scenario] of scenarios.entries()) {
      for (const [error, tolerance] of feedbackErrors(result, scenario, `${index}-`)) { expect(error).toBeLessThan(tolerance!); }
    }
    expect(JSON.stringify(document)).toBe(original);
  }, 60_000);

  it("retains a static high-gain root through transient reinitialization", () => {
    const scenario = { ...nominal, gain: 1e9 };
    const expected = feedbackOracle(scenario);
    const result = simulateTransient(circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario)]), {
      durationSeconds: 0.001, timeStepSeconds: 0.001,
    });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(relative(sample.parts.load!.voltageVolts, expected.emitter)).toBeLessThan(2e-9);
      expect(Math.abs(sample.parts.q!.terminalCurrents!.c! + sample.parts.load!.currentAmps) / Math.abs(sample.parts.load!.currentAmps)).toBeLessThan(2e-10);
    }
  }, 60_000);

  it.each([1e12, -1e12])("preserves exact feedback differences below a common-bias ULP at %s V", (common) => {
    const scenario = { ...nominal, gain: 1e7 };
    const specs = feedbackSpecs(scenario, "", true).map(([id, kind, nodes, values]): Spec => [
      id, kind, nodes.map((node) => node === "0" ? "return" : node === "base" && id === "op" ? "output" : node), values,
    ]);
    specs.push(
      ["ground", "ground", ["0"]],
      ["common", "ac-source", ["return", "0"], { voltageVolts: 0, offsetVolts: common, frequencyHz: 1000 }],
      ["shift", "ac-source", ["base", "output"], { voltageVolts: 0, offsetVolts: common, frequencyHz: 1000 }],
    );
    const document = circuit(specs);
    const expected = feedbackOracle(scenario);
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    expect(relative(dc.parts.load!.voltage.real, expected.emitter)).toBeLessThan(2e-9);
    expect(relative(dc.parts.op!.voltage.real, expected.base)).toBeLessThan(2e-9);
    expect(relative(dc.parts.q!.terminalCurrents.b!.real, expected.baseCurrent)).toBeLessThan(2e-9);
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    expect(ac.status, ac.message).toBe("valid");
    const gain = scenario.gain / (scenario.gain + 1 + 0.025_85 / expected.emitter + 20 / 101_000);
    expect(relative(ac.parts.load!.voltage.real, gain * 1e-4)).toBeLessThan(2e-9);
    expect(Math.abs(ac.parts.q!.terminalCurrents.c!.real + ac.parts.load!.current.real) / Math.abs(ac.parts.load!.current.real)).toBeLessThan(2e-10);
  }, 60_000);

  it.each([false, true])("keeps an independent BJT island independent of feedback, currentDriven=%s", (currentDriven) => {
    const island: Spec[] = currentDriven ? [
      ["island-q", "npn-transistor", ["island-hot", "island-hot", "island-return"]],
      ["island-current", "current-source", ["island-return", "island-hot"], { currentAmps: 0.001 }],
    ] : [
      ["island-q", "npn-transistor", ["island-collector", "island-return", "island-return"]],
    ];
    const isolated = analyzeAnalogCircuit(circuit(island), { mode: "dc" });
    expect(isolated.status, isolated.message).toBe("valid");
    const expectedVoltage = currentDriven ? 0.025_85 * Math.log1p(0.001 / (1.01 * 1e-14)) : 0;
    if (currentDriven) {
      expect(relative(isolated.parts["island-q"]!.voltage.real, expectedVoltage)).toBeLessThan(2e-9);
    } else { expect(isolated.parts["island-q"]!.voltage.real).toBe(0); }
    const scenario = { ...nominal, gain: 1e7 };
    const standalone = analyzeAnalogCircuit(circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario)]), { mode: "dc" });
    expect(standalone.status, standalone.message).toBe("valid");
    const combined = analyzeAnalogCircuit(circuit([["ground", "ground", ["0"]], ...feedbackSpecs(scenario), ...island]), { mode: "dc" });
    expect(combined.status, combined.message).toBe("valid");
    for (const [error, tolerance] of feedbackErrors(combined, scenario)) { expect(error).toBeLessThan(tolerance!); }
    if (currentDriven) {
      expect(relative(combined.parts["island-q"]!.voltage.real, expectedVoltage)).toBeLessThan(2e-9);
      expect(relative(combined.parts["island-q"]!.terminalCurrents.c!.real, -0.001)).toBeLessThan(2e-9);
    } else { expect(combined.parts["island-q"]!.voltage.real).toBe(0); }
  }, 60_000);
});

describe("non-BJT feedback regression audit", () => {
  it.each(["diode", "nmos"] as const)("preserves a scalar feedback root through %s", (kind) => {
    const gain = 1000;
    const specs: Spec[] = [
      ["ground", "ground", ["0"]],
      ["input", "battery", ["input", "0"], { voltageVolts: 1 }],
      ["op", "op-amp", ["input", "feedback", "control"], { openLoopGain: gain }],
      ["load", "resistor", ["feedback", "0"], { resistanceOhms: 1000 }],
    ];
    if (kind === "diode") { specs.push(["device", "diode", ["control", "feedback"]]); }
    else {
      specs.push(
        ["device", "nmos", ["supply", "control", "feedback"]],
        ["supply", "battery", ["supply", "0"], { voltageVolts: 5 }],
      );
    }
    const drive = (emitter: number) => kind === "diode"
      ? emitter + 0.025_85 * Math.log1p(emitter / (1000 * 1e-12)) + 20 * emitter / 1000
      : emitter + 2 + Math.sqrt(2 * emitter / (1000 * 0.02 * (1 + 0.01 * (5 - emitter))));
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const middle = (low + high) / 2;
      if (gain * middle < drive(1 - middle)) { low = middle; }
      else { high = middle; }
    }
    const error = (low + high) / 2;
    expect(Math.abs(gain * error - drive(1 - error))).toBeLessThan(2e-14);
    const result = analyzeAnalogCircuit(circuit(specs), { mode: "dc" });
    expect(result.status, result.message).toBe("valid");
    expect(relative(result.parts.load!.voltage.real, 1 - error)).toBeLessThan(2e-9);
  }, 30_000);
});
