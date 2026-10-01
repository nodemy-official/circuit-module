import { expect, it } from "vitest";
import { retainedComplex, restoredComplex } from "../circuit-reading.js";
import { createExactExpressionCapture, freezeCapturedExactExpressions, withExactExpressionCapture } from "../exact-expression.js";
import { solveExactComplexLinearSystem, solveExactRealLinearSystem } from "../exact-linear-algebra.js";
import { complexFromExact, exactComplexValue } from "../exact-numeric-state.js";

it.each(["real", "complex"] as const)("preserves the exact %s solution's transport across dense pivot swaps and JSON cloning", (mode) => {
  const matrix = [0, 1, 1, 2, 3, 4, 3, 2, 5];
  const denominator = 2n ** 8192n + 13n;
  const numerators = [2n ** 4096n + 17n, -(2n ** 4096n + 19n), 2n ** 4096n + 23n];
  const imaginaryNumerators = mode === "complex" ? [1n, -2n, 3n] : [0n, 0n, 0n];
  const coefficients = matrix.map((value) => ({ numerator: BigInt(value), denominator: 1n }));
  // Independent oracle: choose x, construct b=A*x with integer arithmetic.
  // The zero first pivot requires a row swap; det(A)=-3 is nonzero.
  const rhs = (values: bigint[]) => values.map((_, row) => ({
    numerator: values.reduce((sum, value, column) => sum + BigInt(matrix[row * 3 + column]!) * value, 0n), denominator,
  }));
  const capture = createExactExpressionCapture();
  const readings = withExactExpressionCapture(capture, () => {
    const solved = mode === "real"
      ? solveExactRealLinearSystem(3, coefficients, rhs(numerators))!.map((real) => ({ real, imaginary: { numerator: 0n, denominator: 1n } }))
      : solveExactComplexLinearSystem(3, coefficients, coefficients.map(() => ({ numerator: 0n, denominator: 1n })), rhs(numerators), rhs(imaginaryNumerators))!;
    return solved.map((value) => retainedComplex(complexFromExact(value))!);
  });
  const original = { readings, precisionExpressions: freezeCapturedExactExpressions(capture) };
  expect(original.precisionExpressions.length).toBeGreaterThan(0);
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    for (const [index, reading] of result.readings.entries()) {
      const restored = exactComplexValue(restoredComplex(reading, result.precisionExpressions)!)!;
      expect(restored.real.numerator * denominator).toBe(numerators[index]! * restored.real.denominator);
      expect(restored.imaginary.numerator * denominator).toBe(imaginaryNumerators[index]! * restored.imaginary.denominator);
    }
  }
});
