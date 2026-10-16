import { expect, it } from "vitest";

import { restoredComplex, restoredReadingComplex, retainedComplexIsNonzero, type CircuitExactComplex } from "../../circuit-reading.js";
import { analysisAtTransientFrame } from "../../circuit-visualization.js";
import type { ExactExpressionNode } from "../../exact-expression.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

const rational = (numerator: string, denominator = "1") => ({ numerator, denominator });
const precision = (): CircuitExactComplex => ({ real: rational("1", (2n ** 1200n).toString()), imaginary: rational("0") });
const optionalFields = ["projection", "magnitudeNormalizationSquared", "normalizedFraction"] as const;

function unexcitedFrame(exactVoltage: CircuitExactComplex, precisionExpressions?: readonly ExactExpressionNode[]) {
  const document = createCircuitFromSpecs([
    ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 0 }],
    ["r", "resistor", ["v", "g"], { resistanceOhms: 1 }],
  ]);
  const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
  analysis.samples[1]!.parts.c!.exactVoltage = exactVoltage;
  analysis.precisionExpressions = precisionExpressions;
  return analysisAtTransientFrame(document, { analysis, sampleIndex: 1 });
}

it.each(optionalFields.flatMap((field) => [false, 0, "", null, Number.NaN].map((value) => ({ field, value }))))(
  "ignores explicitly invalid $field metadata ($value)",
  ({ field, value }) => {
    const exact = precision();
    Reflect.set(exact, field, value);
    expect(restoredReadingComplex(exact, 0, undefined, false)).toBeUndefined();
    expect(retainedComplexIsNonzero(exact)).toBe(false);
    expect(unexcitedFrame(exact)?.status).toBe("idle");
  },
);

it.each(optionalFields)("preserves an underflowed exact value when optional %s is undefined", (field) => {
  const exact = precision();
  Reflect.set(exact, field, undefined);
  expect(restoredReadingComplex(exact, 0, undefined, false)).toEqual({ real: 0, imaginary: 0 });
  expect(retainedComplexIsNonzero(exact)).toBe(true);
  expect(unexcitedFrame(exact)?.status).toBe("closed");
});

it.each([
  { real: 0, magnitude: Number.NaN, phaseDegrees: 0 },
  { real: 0, magnitude: -1, phaseDegrees: 0 },
  { real: 0, magnitude: 0, phaseDegrees: Number.NaN },
  { real: 0, magnitude: 0, phaseDegrees: Number.POSITIVE_INFINITY },
])("ignores invalid numeric projection coordinates ($magnitude, $phaseDegrees)", (projection) => {
  const exact = { ...precision(), projection };
  expect(restoredReadingComplex(exact, 0, undefined, false)).toBeUndefined();
  expect(retainedComplexIsNonzero(exact)).toBe(false);
  expect(unexcitedFrame(exact)?.status).toBe("idle");
});

it("preserves finite rectangular components with an overflowing magnitude projection", () => {
  const largest = (2n ** 1024n - 2n ** 971n).toString();
  const exact = {
    real: rational(largest), imaginary: rational(largest),
    projection: { real: Number.MAX_VALUE, magnitude: Number.POSITIVE_INFINITY, phaseDegrees: 45 },
  };
  expect(restoredReadingComplex(exact, Number.MAX_VALUE, undefined, false)).toEqual({ real: Number.MAX_VALUE, imaginary: Number.MAX_VALUE });
  expect(retainedComplexIsNonzero(exact)).toBe(true);
  const transported: CircuitExactComplex = JSON.parse(JSON.stringify(exact));
  expect(restoredReadingComplex(transported, Number.MAX_VALUE, undefined, false)).toEqual({ real: Number.MAX_VALUE, imaginary: Number.MAX_VALUE });
  expect(restoredReadingComplex(transported, Number.POSITIVE_INFINITY, 45, true)).toEqual({ real: Number.MAX_VALUE, imaginary: Number.MAX_VALUE });
  expect(retainedComplexIsNonzero(transported)).toBe(true);
});

it.each([true, 1, " 1 ", "+1", "0b1", "0o1"])("rejects an invalid expression literal denominator (%s)", (denominator) => {
  const literal: ExactExpressionNode = { operation: "literal", numerator: "1", denominator: "1" };
  const table = [literal];
  const exact: CircuitExactComplex = { real: { expression: 0, sign: 1 }, imaginary: rational("0") };
  expect(restoredComplex(exact, table)?.real).toBe(1);
  Reflect.set(literal, "denominator", denominator);
  expect(restoredComplex(exact, table)).toBeUndefined();
  expect(retainedComplexIsNonzero(exact, table)).toBe(false);
  expect(unexcitedFrame(exact, table)?.status).toBe("idle");
});
