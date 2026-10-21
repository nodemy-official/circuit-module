import { expect, it } from "vitest";
import { createCircuitFromSpecs } from "./helpers/circuit-fixture.js";
import { matchingTransientEnergy } from "../transient-energy.js";
import { simulateTransient } from "../transient-solver.js";

it.each(["voltage", "current"] as const)("checks the exact sign of a compact %s projection after scalar underflow", (field) => {
  const document = createCircuitFromSpecs([
    ["c", "capacitor", ["a", "0"], { capacitanceFarads: 1, initialVoltageVolts: Number.MIN_VALUE }],
    ["r", "resistor", ["a", "0"], { resistanceOhms: 1 }],
    ["g", "ground", ["0"]],
  ], "compact projection sign");
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  expect(result.status, result.message).toBe("valid");
  const part = document.parts[0]!;
  const match = () => matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions);
  expect(match()).toBeDefined();
  const reading = result.samples[1]!.parts.c!;
  const metadata = field === "voltage" ? reading.exactVoltage : reading.exactTerminalCurrents?.a;
  expect(Math.abs(field === "voltage" ? reading.voltageVolts : reading.currentAmps)).toBe(0);
  expect(metadata?.projection).toBeDefined();
  metadata!.projection!.phaseDegrees = field === "voltage" ? 180 : 0;
  expect(match()).toBeUndefined();
});
