import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const thermalVoltage = 0.025_85;
const kinds = ["npn-transistor", "pnp-transistor"] as const;
const parameters = [
  { beta: 0.75, saturation: 1e-14 },
  { beta: 100, saturation: 1e-14 },
  { beta: 0.6, saturation: 1e-120 },
  { beta: 2.3, saturation: 1e-280 },
  { beta: 100, saturation: 1e-6 },
] as const;
const operatingPoints = parameters.flatMap((parameter) =>
  [1, 0.1].map((collectorVoltage) => ({ ...parameter, collectorVoltage })));

function openBaseDevice(kind: typeof kinds[number], beta: number, saturation: number, amplitude = 0, collectorVoltage = 1) {
  const sign = kind === "npn-transistor" ? 1 : -1;
  return createCircuitFromSpecs([
    ["source", "ac-source", ["collector", "0"], { voltageVolts: amplitude, offsetVolts: sign * collectorVoltage, frequencyHz: 1000 }],
    ["device", kind, ["collector", "open-base", "0"], { currentGain: beta, saturationCurrentAmps: saturation }],
    ["ground", "ground", ["0"]],
  ], "Open BJT base with finite Ebers-Moll operating point");
}

// Ib=Is*((exp(Vb/Vt)-1)/beta + exp((Vb-Vc)/Vt)-1)=0.
// Solve before rounding junction currents; retain the reverse exponential.
function openBaseOracle(beta: number, saturation: number, collectorVoltage: number) {
  const reverseFactor = Math.exp(-collectorVoltage / thermalVoltage);
  const denominator = 1 + beta * reverseFactor;
  return {
    baseVoltage: thermalVoltage * (Math.log1p(beta) - Math.log1p(beta * reverseFactor)),
    collectorCurrent: (beta + 2) * saturation * (1 - reverseFactor) / denominator,
    baseResponse: beta * reverseFactor / denominator,
    collectorConductance: ((beta + 1) * (beta + 2) * saturation * reverseFactor) /
      (thermalVoltage * denominator * denominator),
  };
}

function assertRelative(actual: number, expected: number) {
  if (!Number.isFinite(actual) || (expected === 0 ? actual !== 0 : Math.abs((actual - expected) / expected) >= 1e-10)) {
    throw new Error(`Expected ${actual} to agree with independent value ${expected}`);
  }
}

function assertKcl(residual: number, scale: number, label: string) {
  if (!(scale > 0) || !(Math.abs(residual) / scale < 1e-10)) {
    throw new Error(`${label}: residual ${residual} at independent-current scale ${scale}`);
  }
}

function assertDcReadings(
  kind: typeof kinds[number], beta: number, saturation: number, collectorVoltage: number,
  voltages: { a?: number; b?: number; c?: number },
  currents: { a?: number; b?: number; c?: number }, sourceCurrent: number,
) {
  const sign = kind === "npn-transistor" ? 1 : -1;
  const oracle = openBaseOracle(beta, saturation, collectorVoltage);
  assertRelative(voltages.a!, sign * collectorVoltage);
  assertRelative(voltages.b!, sign * oracle.baseVoltage);
  assertRelative(voltages.c!, 0);
  assertRelative(currents.a!, sign * oracle.collectorCurrent);
  assertRelative(currents.c!, -sign * oracle.collectorCurrent);

  // Independently evaluate each physical junction and its base contribution.
  const forward = saturation * Math.expm1(sign * (voltages.b! - voltages.c!) / thermalVoltage);
  const reverse = saturation * Math.expm1(sign * (voltages.b! - voltages.a!) / thermalVoltage);
  const baseScale = Math.abs(forward / beta) + Math.abs(reverse);
  assertKcl(currents.b!, baseScale, "Open base KCL");
  assertKcl(forward / beta + reverse, baseScale, "Independent base equation");
  assertRelative(currents.a!, sign * (forward - 2 * reverse));
  assertRelative(currents.c!, sign * (-forward * (1 + 1 / beta) + reverse));

  // Base, collector, emitter and the complete device all obey KCL at the
  // independent-current scale, even when base rounding leaves a tiny residual.
  const currentScale = Math.abs(currents.a!) + Math.abs(currents.c!) + baseScale;
  assertKcl(currents.a! + currents.b! + currents.c!, currentScale, "Device KCL");
  assertKcl(currents.a! + sourceCurrent, currentScale, "Collector KCL");
  assertKcl(currents.c! - sourceCurrent, currentScale, "Emitter KCL");
}

describe.each(kinds)("%s with an unconnected base", (kind) => {
  it.each(operatingPoints)("finds the DC operating point at beta=$beta, Is=$saturation, Vc=$collectorVoltage", ({ beta, saturation, collectorVoltage }) => {
    const result = analyzeAnalogCircuit(openBaseDevice(kind, beta, saturation, 0, collectorVoltage));
    expect(result.status, result.message).toBe("valid");
    const device = result.parts.device;
    assertDcReadings(kind, beta, saturation, collectorVoltage,
      { a: device.terminalVoltages.a!.real, b: device.terminalVoltages.b!.real, c: device.terminalVoltages.c!.real },
      { a: device.terminalCurrents.a!.real, b: device.terminalCurrents.b!.real, c: device.terminalCurrents.c!.real },
      result.parts.source.current.real);
  });

  it.each(operatingPoints)("retains the AC response at beta=$beta, Is=$saturation, Vc=$collectorVoltage", ({ beta, saturation, collectorVoltage }) => {
    const amplitude = 0.001;
    const result = analyzeAnalogCircuit(openBaseDevice(kind, beta, saturation, amplitude, collectorVoltage), { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    const oracle = openBaseOracle(beta, saturation, collectorVoltage);
    const device = result.parts.device;
    assertRelative(device.terminalVoltages.b!.real, amplitude * oracle.baseResponse);
    assertRelative(device.terminalCurrents.a!.real, amplitude * oracle.collectorConductance);
    assertRelative(device.terminalCurrents.c!.real, -amplitude * oracle.collectorConductance);
    const scale = Math.abs(device.terminalCurrents.a!.real) + Math.abs(device.terminalCurrents.c!.real);
    expect(Math.abs(device.terminalCurrents.b!.real) / scale).toBeLessThan(1e-10);
    expect(Math.abs(device.terminalCurrents.a!.real + result.parts.source.current.real) / scale).toBeLessThan(1e-10);
    expect(Math.abs(device.terminalCurrents.c!.real - result.parts.source.current.real) / scale).toBeLessThan(1e-10);
  });

  it.each(operatingPoints)("preserves transient KCL at beta=$beta, Is=$saturation, Vc=$collectorVoltage", ({ beta, saturation, collectorVoltage }) => {
    for (const startFromOperatingPoint of [false, true]) {
      const result = simulateTransient(openBaseDevice(kind, beta, saturation, 0, collectorVoltage), {
        durationSeconds: 0.002, timeStepSeconds: 0.001, startFromOperatingPoint,
      });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples.map((sample) => sample.timeSeconds)).toEqual([0, 0.001, 0.002]);
      for (const sample of result.samples) {
        const device = sample.parts.device;
        assertDcReadings(kind, beta, saturation, collectorVoltage, device.terminalVoltages!, device.terminalCurrents!, sample.parts.source.currentAmps);
      }
    }
  });

  it.each(parameters)("follows a changing collector voltage at beta=$beta, Is=$saturation", ({ beta, saturation }) => {
    const amplitude = 0.001;
    const sign = kind === "npn-transistor" ? 1 : -1;
    for (const startFromOperatingPoint of [false, true]) {
      const result = simulateTransient(openBaseDevice(kind, beta, saturation, amplitude, 0.1), {
        durationSeconds: 0.0004, timeStepSeconds: 0.0001, startFromOperatingPoint,
      });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(5);
      for (const sample of result.samples) {
        const device = sample.parts.device;
        const collectorVoltage = 0.1 + sign * Math.SQRT2 * amplitude * Math.cos(2 * Math.PI * 1000 * sample.timeSeconds);
        assertDcReadings(kind, beta, saturation, collectorVoltage, device.terminalVoltages!, device.terminalCurrents!, sample.parts.source.currentAmps);
      }
    }
  });

  it("retains the small base residual instead of clamping its current to zero", () => {
    const result = analyzeAnalogCircuit(openBaseDevice(kind, 0.75, 1e-14));
    expect(result.status, result.message).toBe("valid");
    expect(Math.abs(result.parts.device.terminalCurrents.b!.real)).toBeGreaterThan(0);
    expect(Math.abs(result.parts.device.terminalCurrents.b!.real) / 1e-14).toBeLessThan(1e-10);
  });

  it.each([1e-14, 1e-280])("rejects a real base-current imbalance even at Is=%s", (saturation) => {
    const sign = kind === "npn-transistor" ? 1 : -1;
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["collector", "0"], { voltageVolts: 0, offsetVolts: sign }],
      ["device", kind, ["collector", "base", "0"], { currentGain: 0.75, saturationCurrentAmps: saturation }],
      ["draw", "current-source", ["base", "0"], { currentAmps: sign * 4 * saturation }],
      ["ground", "ground", ["0"]],
    ], "Base demand exceeds reverse saturation current");
    // Ib cannot be below -Is*(1+1/beta), even as both junctions reverse bias.
    expect(analyzeAnalogCircuit(document).status).toBe("invalid");
    expect(analyzeAnalogCircuit(document, { mode: "ac" }).status).toBe("invalid");
    expect(simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 }).status).toBe("invalid");
  });
});
