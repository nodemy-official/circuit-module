import { expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { matchingTransientEnergy } from "../transient-energy.js";
import { simulateTransient } from "../transient-solver.js";
import { assertCorrectRounding, rational } from "./helpers/numeric-oracle.js";

function rc(): CircuitDocument {
  return {
    title: "厳密なRCエネルギー",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 1 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
      { id: "c", kind: "capacitor", label: "C", x: 0, y: 0, capacitanceFarads: 1 },
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "r", terminal: "b" }, to: { partId: "c", terminal: "a" } },
      { id: "c", from: { partId: "c", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      { id: "g", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

it("retains maximum-length energy readouts with independently rounded RC energies after cloning", () => {
  const document = rc();
  const steps = 2000;
  const original = simulateTransient(document, { durationSeconds: steps / 1024, timeStepSeconds: 1 / 1024 });
  expect(original.status, original.message).toBe("valid");
  const json = JSON.stringify(original);
  // Includes an independent expression-table snapshot to detect mutable metadata.
  // Both the sampled values and their linear-size validation evidence stay compact.
  expect(json.length).toBeLessThan(12_000_000);
  for (const result of [original, JSON.parse(json) as typeof original, structuredClone(original)]) {
    const resistor = matchingTransientEnergy(document.parts[1]!, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions);
    const capacitor = matchingTransientEnergy(document.parts[2]!, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions);
    expect(resistor).toHaveLength(steps + 1);
    expect(capacitor).toHaveLength(steps + 1);
    for (const index of [0, 1, 1000, 2000]) {
      // I_n=(1024/1025)^n; V_C,n=1-I_n. Sum the geometric
      // trapezoid series with integer arithmetic, independent of production.
      const a = 1024n ** BigInt(index);
      const b = 1025n ** BigInt(index);
      const dissipated = rational((1024n ** 2n + 1025n ** 2n) * (b * b - a * a), 2048n * (1025n ** 2n - 1024n ** 2n) * b * b);
      const stored = rational((b - a) ** 2n, 2n * b * b);
      assertCorrectRounding(resistor![index]!.dissipatedJoules!, dissipated, `resistor at ${index}`);
      assertCorrectRounding(capacitor![index]!.storedJoules!, stored, `capacitor at ${index}`);
    }
  }
});

it.each(["time", "power", "voltage", "current", "exact", "projection", "coefficient", "missing", "negative"])("invalidates derived energy after %s edits", (field) => {
  const document = rc();
  const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
  const part = document.parts[2]!;
  expect(matchingTransientEnergy(part, result.samples, result.energyReadings)).toBeDefined();
  const sample = result.samples[1]!;
  const reading = sample.parts.c!;
  switch (field) {
    case "time": sample.timeSeconds = 0.25; break;
    case "power": reading.powerWatts = 7; break;
    case "voltage": reading.voltageVolts = 7; break;
    case "current": reading.currentAmps = 7; break;
    case "exact": reading.exactVoltage!.real = { numerator: "0x1", denominator: "0x2" }; break;
    case "projection": reading.exactVoltage!.projection!.real = 7; break;
    case "coefficient": part.capacitanceFarads = 7; break;
    case "missing": result.energyReadings = { c: { kind: "capacitor", coefficient: 1, samples: result.energyReadings!.c!.samples.map((entry) => ({ ...entry, storedJoules: undefined })) } }; break;
    case "negative": result.energyReadings = { c: { kind: "capacitor", coefficient: 1, samples: result.energyReadings!.c!.samples.map((entry) => ({ ...entry, storedJoules: -1 })) } }; break;
    default: throw new Error("Unknown energy edit");
  }
  expect(matchingTransientEnergy(part, result.samples, result.energyReadings)).toBeUndefined();
});

it("keeps a separate expression-table snapshot and invalidates derived energies after its source changes", () => {
  const document = rc();
  const original = simulateTransient(document, { durationSeconds: 1 / 16, timeStepSeconds: 1 / 1024 });
  for (const result of [JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    const part = document.parts[2]!;
    expect(matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions)).toBeDefined();
    const component = result.samples.at(-1)!.parts.c!.exactVoltage!.real;
    expect("expression" in component).toBe(true);
    if (!("expression" in component)) { throw new Error("Expected compact history"); }
    expect(result.energyPrecisionExpressions).not.toBe(result.precisionExpressions);
    result.precisionExpressions = result.precisionExpressions!.map((node, index) => index === component.expression
      ? { operation: "literal", numerator: "1", denominator: "3" } : node);
    expect(matchingTransientEnergy(part, result.samples, result.energyReadings, result.precisionExpressions, result.energyPrecisionExpressions)).toBeUndefined();
  }
});
