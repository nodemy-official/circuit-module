import { expect, it } from "vitest";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import { nextUp } from "../helpers/numeric-oracle.js";

it("uses catalog labels for direct extended-analysis diagnostics when labels are omitted", () => {
  for (const mode of ["dc", "ac"] as const) {
    const specs: CircuitSpec[] = mode === "dc"
      ? [["source", "battery", ["v", "0"], { voltageVolts: 1, internalResistanceOhms: 1 }]]
      : [["source", "ac-source", ["v", "0"], { voltageVolts: 10 }],
        ["bulb", "bulb", ["v", "0"], { resistanceOhms: 10, ratedPowerWatts: 1 }]];
    const document = createCircuitFromSpecs(specs, "Diagnostics with omitted catalog labels");
    if (mode === "dc") { document.wires.push({ id: "short", from: { partId: "source", terminal: "a" }, to: { partId: "source", terminal: "b" } }); }
    for (const part of document.parts) { Reflect.deleteProperty(part, "label"); }
    const options = { mode };
    const actual = analyzeExtendedCircuit(document, {}, options);
    const expected = analyzeCircuit(document, {}, options);
    expect(actual.status).toBe(expected.status);
    expect(actual.issues).toEqual(expected.issues);
    expect(actual.message).toBe(expected.message);
    expect(actual.issues[0]!.message).not.toContain("undefined");
  }
});

it.each(["wire", "ammeter", "switch", "inductor", "pot-a", "pot-b", "grounds"])(
  "diagnoses an ideal external battery short through %s while preserving finite readings", (path) => {
    const specs: CircuitSpec[] = [["source", "battery", ["v", "0"], { voltageVolts: 1, internalResistanceOhms: 1 }]];
    if (path === "wire") { specs.push(["tie", "junction", ["v"]], ["tie-0", "junction", ["0"]]); }
    else if (path === "grounds") { specs.push(["g1", "ground", ["v"]], ["g2", "ground", ["0"]]); }
    else if (path === "pot-a") { specs.push(["path", "potentiometer", ["v", "unused", "0"], { wiperPosition: 0 }]); }
    else if (path === "pot-b") { specs.push(["path", "potentiometer", ["unused", "v", "0"], { wiperPosition: 1 }]); }
    else { specs.push(["path", path as "ammeter" | "switch" | "inductor", ["v", "0"], { initiallyClosed: true }]); }
    specs.push(["isolated", "ground", ["isolated"]]);
    const document = createCircuitFromSpecs(specs, "Shorted finite battery with extended parts");
    if (path === "wire") { document.wires.push({ id: "short", from: { partId: "source", terminal: "a" }, to: { partId: "source", terminal: "b" } }); }
    const result = analyzeCircuit(document);
    expect(result.status, result.message).toBe("short");
    expect(result.currentAmps).toBe(1);
    expect(result.parts.source.voltageVolts).toBe(0);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "error", partId: "source" }));
  },
);

it("keeps an open switch, a resistive potentiometer and an unpowered short out of the short diagnosis", () => {
  for (const path of ["open", "resistive", "unpowered"] as const) {
    const document = createCircuitFromSpecs([
      ["source", path === "unpowered" ? "ac-source" : "battery", ["v", "0"], { voltageVolts: path === "unpowered" ? 0 : 1, internalResistanceOhms: 1 }],
      ...(path === "resistive"
        ? [["path", "potentiometer", ["v", "unused", "0"], { resistanceOhms: 10, wiperPosition: 0.5 }] as CircuitSpec]
        : [["path", "switch", ["v", "0"], { initiallyClosed: path === "unpowered" }] as CircuitSpec]),
      ["isolated", "ground", ["isolated"]],
    ], "No driven ideal short");
    const result = analyzeCircuit(document, {}, { mode: "dc" });
    expect(result.status, `${path}: ${result.message}`).toBe(path === "unpowered" ? "idle" : path === "open" ? "open" : "closed");
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(false);
  }
});

it.each(["dc", "ac"] as const)("retains the exact bulb overload boundary in extended %s analysis", (mode) => {
  const cases = [
    { voltage: 10, resistance: 10, rating: 1, overloaded: true },
    { voltage: 3, resistance: 3, rating: 2, overloaded: false },
    // Both binary64 products rating*1.5 round to 1; their exact signs differ.
    { voltage: 1, resistance: 1, rating: 2 / 3, overloaded: true },
    { voltage: 1, resistance: 1, rating: nextUp(2 / 3), overloaded: false },
    { voltage: 2 ** -536, resistance: 1, rating: 2 * Number.MIN_VALUE, overloaded: true },
    { voltage: 2 ** -536, resistance: 1, rating: 3 * Number.MIN_VALUE, overloaded: false },
    { voltage: 2 ** 500, resistance: 1, rating: 2 ** 999, overloaded: true },
    { voltage: 2 ** 500, resistance: 1, rating: 2 ** 1000, overloaded: false },
  ];
  for (const { voltage, resistance, rating, overloaded } of cases) {
    const document = createCircuitFromSpecs([
      ["source", mode === "dc" ? "battery" : "ac-source", ["v", "0"], { voltageVolts: voltage, frequencyHz: 1, phaseDegrees: 37 }],
      ["bulb", "bulb", ["v", "0"], { resistanceOhms: resistance, ratedPowerWatts: rating }],
      ["isolated", "ground", ["isolated"]],
    ], "Extended bulb overload boundary");
    const result = analyzeCircuit(document, {}, { mode });
    expect(result.status, result.message).toBe("closed");
    expect(result.issues.some((issue) => issue.partId === "bulb" && issue.severity === "warning")).toBe(overloaded);
  }
});
