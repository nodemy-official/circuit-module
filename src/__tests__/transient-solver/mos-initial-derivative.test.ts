import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function circuit(kind: "nmos" | "pmos", reverse: boolean, phase?: number, extra: readonly CircuitSpec[] = []) {
  const sign = kind === "nmos" ? 1 : -1;
  return createCircuitFromSpecs([
    ["supply", "ac-source", ["supply", "0"], { voltageVolts: 0, offsetVolts: sign * 10 }],
    ["gate", "ac-source", ["gate", "0"], { voltageVolts: phase === undefined ? 0 : 0.125, offsetVolts: sign * 3,
      frequencyHz: 1, phaseDegrees: (phase ?? 90) + (sign === -1 ? 180 : 0) }],
    ["l", "inductor", ["supply", "drain"], { inductanceHenries: 1, initialCurrentAmps: sign }],
    ["mos", kind, reverse ? ["0", "gate", "drain"] : ["drain", "gate", "0"], {
      thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0,
    }],
    ["ground", "ground", ["0"]],
    ...extra,
  ], "Consistent saturated MOS and inductor initial derivatives");
}

describe("initial inductor voltages controlled by a saturated MOS", () => {
  for (const kind of ["nmos", "pmos"] as const) {
    for (const reverse of [false, true]) {
      it.each([undefined, 90, 270])(`${kind}, reverse=${reverse}, phase=%s`, (phase) => {
        const document = circuit(kind, reverse, phase);
        const sign = kind === "nmos" ? 1 : -1;
        // I = beta/2 * (Vgs - Vth)^2; L*dI/dt = L*beta*(Vgs-Vth)*dVgs/dt.
        const expected = phase === undefined ? 0 : sign * (phase === 90 ? -1 : 1) * 4 * Math.PI * Math.SQRT2 * 0.125;
        for (const timeStepSeconds of [1e-3, 1e-5]) {
          const result = simulateTransient(document, { durationSeconds: timeStepSeconds, timeStepSeconds });
          expect(result.status, result.message).toBe("valid");
          const initial = result.samples[0]!.parts;
          expect(initial.l!.currentAmps).toBe(sign);
          if (expected === 0) { expect(initial.l!.voltageVolts).toBe(0); }
          else { expect(Math.abs(initial.l!.voltageVolts / expected - 1)).toBeLessThan(1e-12); }
          expect(initial.mos!.currentAmps).toBe(reverse ? -sign : sign);
          expect(initial.l!.voltageVolts + (reverse ? -1 : 1) * initial.mos!.voltageVolts).toBeCloseTo(sign * 10, 12);
        }
      });
    }
  }

  it("gets the gate derivative from capacitor current and divides series inductor voltage", () => {
    const document = createCircuitFromSpecs([
      ["supply", "battery", ["supply", "0"], { voltageVolts: 10 }],
      ["bias", "battery", ["bias", "0"], { voltageVolts: 3 }],
      ["gate-r", "resistor", ["bias", "gate"], { resistanceOhms: 2 }],
      ["gate-c", "capacitor", ["gate", "0"], { capacitanceFarads: 1, initialVoltageVolts: 4 }],
      ["l1", "inductor", ["supply", "mid"], { inductanceHenries: 0.25, initialCurrentAmps: 4 }],
      ["l2", "inductor", ["mid", "drain"], { inductanceHenries: 0.75, initialCurrentAmps: 4 }],
      ["mos", "nmos", ["drain", "gate", "0"], { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0 }],
      ["ground", "ground", ["0"]],
    ], "RC driven MOS with series inductors");
    const result = simulateTransient(document, { durationSeconds: 1e-3, timeStepSeconds: 1e-3 });
    expect(result.status, result.message).toBe("valid");
    const initial = result.samples[0]!.parts;
    // dVg/dt = (3-4)/2/1 = -0.5; dI/dt = 2*(4-2)*(-0.5) = -2.
    expect(initial["gate-c"]!.currentAmps).toBe(-0.5);
    expect(initial.l1!.voltageVolts).toBe(-0.5);
    expect(initial.l2!.voltageVolts).toBe(-1.5);
    expect(initial.mos!.voltageVolts).toBe(12);
    expect(initial.mos!.currentAmps).toBe(4);
  });

  it("keeps an exactly distinct triode current below saturation", () => {
    const document = circuit("nmos", false);
    const current = 1 - 2 ** -40;
    document.parts.find((part) => part.id === "l")!.initialCurrentAmps = current;
    const result = simulateTransient(document, { durationSeconds: 1e-3, timeStepSeconds: 1e-3 });
    expect(result.status, result.message).toBe("valid");
    const initial = result.samples[0]!.parts;
    const drain = 1 - 2 ** -20;
    expect(initial.l!.currentAmps).toBe(current);
    expect(initial.l!.voltageVolts).toBeCloseTo(10 - drain, 10);
    expect(initial.mos!.currentAmps).toBeCloseTo(current, 14);
  });

  it("keeps a finite output conductance and the original triode root", () => {
    const document = circuit("nmos", false, 90);
    document.parts.find((part) => part.id === "mos")!.channelLengthModulation = 0.01;
    const result = simulateTransient(document, { durationSeconds: 1e-3, timeStepSeconds: 1e-3 });
    expect(result.status, result.message).toBe("valid");
    const initial = result.samples[0]!.parts;
    const drain = initial.mos!.voltageVolts;
    expect(drain).toBeLessThan(1);
    expect((2 * drain - drain * drain) * (1 + 0.01 * drain)).toBeCloseTo(1, 12);
    expect(initial.l!.voltageVolts + drain).toBe(10);
  });

  it.each([1e-300, 1, 1e200])("preserves the initial derivative at current scale %s", (current) => {
    const document = circuit("nmos", false, 90);
    document.parts.find((part) => part.id === "mos")!.transconductanceAmpsPerVoltSquared = 2 * current;
    const inductor = document.parts.find((part) => part.id === "l")!;
    inductor.initialCurrentAmps = current;
    inductor.inductanceHenries = 1 / current;
    const expected = -inductor.inductanceHenries * current * 4 * Math.PI * Math.SQRT2 * 0.125;
    for (const reverseOrder of [false, true]) {
      if (reverseOrder) { document.parts.reverse(); document.wires.reverse(); }
      const result = simulateTransient(document, { durationSeconds: 1e-5, timeStepSeconds: 1e-5 });
      expect(result.status, result.message).toBe("valid");
      const initial = result.samples[0]!.parts;
      expect(initial.l!.currentAmps).toBe(current);
      expect(initial.mos!.currentAmps).toBe(current);
      expect(Math.abs(initial.l!.voltageVolts / expected - 1)).toBeLessThan(1e-12);
    }
  });
});
