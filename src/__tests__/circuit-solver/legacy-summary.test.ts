import { describe, expect, it } from "vitest";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

describe("legacy DC summary readings", () => {
  it("reports the finite current of a shorted single source", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["short", "short"], { voltageVolts: 1, internalResistanceOhms: 1 }],
    ], "Shorted battery with finite internal resistance");
    const result = analyzeCircuit(document);
    // The legacy model includes one 1-microohm wire in the shorted loop.
    const current = 1 / (1 + 1e-6);
    expect(result.status).toBe("short");
    expect(result.issues[0]).toMatchObject({ severity: "error", partId: "source" });
    expect(result.currentAmps).not.toBeNull();
    expect(Math.abs(result.currentAmps! / current - 1)).toBeLessThan(1e-14);
    expect(Math.abs(result.parts.source!.currentAmps / -current - 1)).toBeLessThan(1e-14);
  });

  it.each([false, true])("keeps an independent bulb's power when another source is shorted (reversed=%s)", (reverse) => {
    const specs: CircuitSpec[] = [
      ["source", "battery", ["p", "n"], { voltageVolts: 9, internalResistanceOhms: 1 }],
      ["bulb", "bulb", ["p", "n"], { resistanceOhms: 20, ratedPowerWatts: 10 }],
    ];
    const baseline = analyzeCircuit(createCircuitFromSpecs(specs, "Independent bulb"));
    specs.push(["shorted", "battery", ["short", "short"], { voltageVolts: 1, internalResistanceOhms: 1 }]);
    const result = analyzeCircuit(createCircuitFromSpecs(reverse ? specs.toReversed() : specs, "Bulb beside a shorted source"));
    const current = 9 / (1 + 20 + 2e-6);
    const power = 20 * current * current;
    expect(baseline.status).toBe("closed");
    expect(result.status).toBe("short");
    expect(result.currentAmps).toBeNull();
    expect(Math.abs(result.bulbPowerWatts.bulb! / power - 1)).toBeLessThan(1e-14);
    expect(result.bulbPowerWatts.bulb).toBe(baseline.bulbPowerWatts.bulb);
    expect(result.bulbPowerWatts.bulb).toBe(result.parts.bulb!.powerWatts);
  });

  it.each(["idle", "open"] as const)("reports zero bulb power in a solved %s circuit", (status) => {
    const specs: CircuitSpec[] = [["bulb", "bulb", ["p", "n"]]];
    if (status === "open") {
      specs.push(["source", "battery", ["p", "unconnected"], { voltageVolts: 9 }]);
    }
    const result = analyzeCircuit(createCircuitFromSpecs(specs, "Unpowered bulb"));
    expect(result.status).toBe(status);
    expect(result.currentAmps).toBe(status === "open" ? 0 : null);
    expect(result.bulbPowerWatts).toEqual({ bulb: 0 });
    expect(result.parts.bulb!.powerWatts).toBe(0);
  });
});
