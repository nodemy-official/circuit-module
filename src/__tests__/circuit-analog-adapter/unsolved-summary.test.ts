import { describe, expect, it } from "vitest";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

describe("analog summary readings for unsolved circuits", () => {
  it.each(["bulb", "__proto__", "constructor"])("does not fabricate zero power for %s when finite inputs overflow the result", (id) => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["p", "0"], { voltageVolts: 1e200, internalResistanceOhms: 1 }],
      [id, "bulb", ["p", "0"], { resistanceOhms: 20 }],
      ["ground", "ground", ["0"]],
    ], "Unrepresentable bulb power");
    const result = analyzeCircuit(document, {}, { mode: "dc" });
    // I = 1e200 / 21 is finite; P = 20 * I^2 cannot be a finite number.
    expect(result.status).toBe("invalid");
    expect(result.parts).toEqual({});
    expect(result.currentAmps).toBeNull();
    expect(Object.hasOwn(result.bulbPowerWatts, id)).toBe(false);
    expect(result.bulbPowerWatts).toEqual({});
  });

  it.each(["dc", "ac"] as const)("omits the bulb summary when ideal sources contradict each other in %s", (mode) => {
    const document = createCircuitFromSpecs([
      ["first", "ac-source", ["p", "0"], { voltageVolts: 1, offsetVolts: 1, frequencyHz: 1000 }],
      ["second", "ac-source", ["p", "0"], { voltageVolts: 2, offsetVolts: 2, frequencyHz: 1000 }],
      ["bulb", "bulb", ["p", "0"], { resistanceOhms: 20 }],
    ], "Contradictory ideal sources");
    const result = analyzeCircuit(document, {}, { mode });
    expect(result.status).toBe("invalid");
    expect(result.parts).toEqual({});
    expect(result.bulbPowerWatts).toEqual({});
  });

  it("keeps a calculated zero separate from an absent reading", () => {
    const document = createCircuitFromSpecs([
      ["bulb", "bulb", ["p", "0"]],
      ["ground", "ground", ["0"]],
    ], "Solved unpowered bulb");
    const result = analyzeCircuit(document);
    expect(result.status).toBe("idle");
    expect(result.parts.bulb!.powerWatts).toBe(0);
    expect(result.bulbPowerWatts).toEqual({ bulb: 0 });
  });
});
