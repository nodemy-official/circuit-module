import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { frequencyMatches } from "../../ac-reactive.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";
import { compareRational, multiplyRational, nextUp, rationalFromNumber, subtractRational } from "../helpers/numeric-oracle.js";

describe("frequency matching at the numeric boundary", () => {
  it.each([Number.MIN_VALUE, 1e-310, 1e-308, 2 ** -1022, 1e-200, 1, 1e200, Number.MAX_VALUE / 2])(
    "matches the independent relative-error oracle near %s Hz", (frequency) => {
      let adjacent = frequency;
      for (let step = 0; step < 8; step += 1) {
        const difference = subtractRational(rationalFromNumber(adjacent)!, rationalFromNumber(frequency)!);
        const tolerance = multiplyRational(rationalFromNumber(adjacent)!, rationalFromNumber(4 * Number.EPSILON)!);
        const expected = compareRational(difference, tolerance) <= 0;
        expect(frequencyMatches(frequency, adjacent)).toBe(expected);
        expect(frequencyMatches(adjacent, frequency)).toBe(expected);
        adjacent = nextUp(adjacent);
      }
    },
  );

  it("keeps a subnormal-frequency source active within rounding tolerance", () => {
    const frequency = 1e-308;
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["supply", "return"], { voltageVolts: 1, frequencyHz: frequency }],
      ["load", "resistor", ["supply", "return"], { resistanceOhms: 1 }],
    ], "Subnormal frequency");
    const matchedOptions = { mode: "ac" as const, frequencyHz: nextUp(frequency) };
    const analog = analyzeAnalogCircuit(document, matchedOptions);
    const scalar = analyzeCircuit(document, {}, matchedOptions);
    expect(analog.status, analog.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    expect(analog.parts.load.current.real).toBe(1);
    expect(scalar.parts.load.currentAmps).toBe(1);
    expect(scalar.issues.some((issue) => issue.message.includes("解析周波数と異なる"))).toBe(false);

    const distinct = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: nextUp(nextUp(frequency)) });
    expect(distinct.status, distinct.message).toBe("idle");
    expect(distinct.parts.load.currentAmps).toBe(0);
    expect(distinct.issues.some((issue) => issue.message.includes("解析周波数と異なる"))).toBe(true);
  });
});
