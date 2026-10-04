import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function mixedCurrentCircuit(sign: number, reversed: boolean) {
  const drain = 0.65;
  const gate = 0.6;
  const thermal = 0.025_85;
  // Manufacture the two current injections from independent device equations
  // at a known operating point. Tiny LED/BJT currents share nodes with a
  // milliamperes-scale MOS channel and exact resistor/source cancellations.
  const forward = 1e-14 * Math.expm1(-gate / thermal);
  const backward = 1e-14 * Math.expm1((drain - gate) / thermal);
  const channel = 0.5 * 0.02 * (gate - 0.1) ** 2 * (1 + 0.01 * drain);
  const link = 1e-20 * Math.expm1((drain - gate) / (2 * thermal));
  const gateLed = 1e-20 * Math.expm1(gate / (2 * thermal));
  const collector = -forward + 2 * backward;
  const base = -forward / 100 - backward;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["drain-load", "resistor", ["drain", "0"], { resistanceOhms: 1000 }],
    ["gate-load", "resistor", ["gate", "0"], { resistanceOhms: 1000 }],
    ["bjt", sign === 1 ? "pnp-transistor" : "npn-transistor", ["drain", "gate", "0"], { saturationCurrentAmps: 1e-14, currentGain: 100 }],
    ["mos", sign === 1 ? "nmos" : "pmos", ["drain", "gate", "0"], {
      thresholdVolts: 0.1, transconductanceAmpsPerVoltSquared: 0.02, channelLengthModulation: 0.01,
    }],
    ["drain-current", "current-source", ["0", "drain"], { currentAmps: sign * (drain / 1000 + collector + channel + link) }],
    ["gate-current", "current-source", ["0", "gate"], { currentAmps: sign * (gate / 1000 + base - link + gateLed) }],
    ["link", "led", sign === 1 ? ["drain", "gate"] : ["gate", "drain"]],
    ["gate-led", "led", sign === 1 ? ["gate", "0"] : ["0", "gate"]],
  ];
  return {
    document: createCircuitFromSpecs(reversed ? specs.toReversed() : specs, "Mixed weak-junction and MOS currents"),
    drain: sign * drain, gate: sign * gate, channel: sign * channel,
    collector: sign * collector, base: sign * base, link, gateLed,
  };
}

const cases = [-1, 1].flatMap((sign) => [false, true].flatMap((reversed) =>
  (["dc", "ac", "transient"] as const).map((mode) => ({ sign, reversed, mode })),
));

it.each(cases)("solves independently biased weak junctions beside a MOS channel ($mode, sign=$sign, reversed=$reversed)", ({ sign, reversed, mode }) => {
  const expected = mixedCurrentCircuit(sign, reversed);
  const started = performance.now();
  const close = (actual: number, target: number) => {
    expect(Math.abs(actual / target - 1)).toBeLessThan(2e-11);
  };
  if (mode === "transient") {
    const result = simulateTransient(expected.document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    for (const { parts } of result.samples) {
      close(parts["drain-load"]!.voltageVolts, expected.drain);
      close(parts["gate-load"]!.voltageVolts, expected.gate);
      close(parts.mos!.currentAmps, expected.channel);
      close(parts.bjt!.terminalCurrents!.a!, expected.collector);
      close(parts.bjt!.terminalCurrents!.b!, expected.base);
      close(parts.link!.currentAmps, expected.link);
      close(parts["gate-led"]!.currentAmps, expected.gateLed);
    }
  } else {
    const result = analyzeAnalogCircuit(expected.document, { mode });
    expect(result.status, result.message).toBe("valid");
    if (mode === "dc") {
      close(result.parts["drain-load"]!.voltage.real, expected.drain);
      close(result.parts["gate-load"]!.voltage.real, expected.gate);
      close(result.parts.mos!.current.real, expected.channel);
      close(result.parts.bjt!.terminalCurrents.a!.real, expected.collector);
      close(result.parts.bjt!.terminalCurrents.b!.real, expected.base);
      close(result.parts.link!.current.real, expected.link);
      close(result.parts["gate-led"]!.current.real, expected.gateLed);
    } else {
      // With no AC excitation the response is zero after resolving DC bias.
      for (const reading of Object.values(result.parts)) {
        expect(reading.voltage.real).toBe(0);
        expect(reading.current.real).toBe(0);
      }
    }
  }
  // The original two-node circuit spent over 40 seconds in damped Newton
  // retries. Allow ample runtime for busy CI while catching that regression.
  expect(performance.now() - started).toBeLessThan(5000);
});
