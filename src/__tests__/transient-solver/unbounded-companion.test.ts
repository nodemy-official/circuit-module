import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { addRational, assertCorrectRounding, divideRational, multiplyRational, rational, rationalFromNumber } from "../helpers/numeric-oracle.js";

describe("finite transient responses beyond the companion resistance projection", () => {
  it.each(["capacitor", "inductor"] as const)("keeps finite minimum-step %s charging", (kind) => {
    const dt = Number.MIN_VALUE;
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "g"], { voltageVolts: 1 }],
      ["r", "resistor", ["s", "storage"], { resistanceOhms: 1 }],
      ["storage", kind, ["storage", "g"], kind === "capacitor" ? { capacitanceFarads: 2 } : { inductanceHenries: 1 }],
    ], "Finite response with an unrepresentable companion resistance");
    const result = simulateTransient(document, { durationSeconds: dt, timeStepSeconds: dt });
    expect(result.status, result.message).toBe("valid");
    const step = rationalFromNumber(dt)!;
    const companion = kind === "capacitor" ? divideRational(step, rational(2n)) : divideRational(rational(1n), step);
    const current = divideRational(rational(1n), addRational(rational(1n), companion));
    const voltage = multiplyRational(current, companion);
    const reading = result.samples[1]!.parts.storage;
    assertCorrectRounding(reading.currentAmps, current, "finite charging current");
    assertCorrectRounding(reading.voltageVolts, voltage, "finite charging voltage");
    expect(reading.currentAmps).toBe(kind === "capacitor" ? 1 : dt);
    expect(reading.voltageVolts).toBe(kind === "capacitor" ? 0 : 1);
    expect(result.samples[1]!.parts.r.currentAmps).toBe(reading.currentAmps);
  });

  it.each(["capacitor", "inductor"] as const)("keeps finite %s decay when its companion ratio rounds beyond the range", (kind) => {
    const dt = kind === "capacitor" ? 2 : 4;
    const document = createCircuitFromSpecs([
      ["r", "resistor", ["s", "g"], { resistanceOhms: Number.MIN_VALUE }],
      ["storage", kind, ["s", "g"], kind === "capacitor"
        ? { capacitanceFarads: Number.MIN_VALUE, initialVoltageVolts: Number.MIN_VALUE }
        : { inductanceHenries: Number.MIN_VALUE, initialCurrentAmps: 1 }],
    ], "Decay beyond the companion projection");
    const result = simulateTransient(document, { durationSeconds: dt, timeStepSeconds: dt });
    expect(result.status, result.message).toBe("valid");
    const minimum = rationalFromNumber(Number.MIN_VALUE)!;
    const time = rationalFromNumber(dt)!;
    const current = kind === "capacitor"
      ? divideRational(multiplyRational(minimum, minimum), addRational(multiplyRational(minimum, minimum), time))
      : divideRational(rational(1n), addRational(rational(1n), time));
    const loadVoltage = multiplyRational(current, minimum);
    const reading = result.samples[1]!.parts.storage;
    assertCorrectRounding(reading.voltageVolts, kind === "capacitor" ? loadVoltage : rational(-loadVoltage.numerator, loadVoltage.denominator), "decay voltage");
    assertCorrectRounding(reading.currentAmps, kind === "capacitor" ? rational(-current.numerator, current.denominator) : current, "decay current");
  });
});
