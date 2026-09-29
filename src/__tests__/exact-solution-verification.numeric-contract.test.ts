import { describe, expect, it } from "vitest";

import {
  isExactComplexLinearSolution,
  isExactRealLinearSolution,
  type ExactComplexValue,
  type ExactRational,
} from "../exact-linear-algebra.js";

function q(numerator: bigint, denominator = 1n): ExactRational {
  return { numerator, denominator };
}

function complex(real: ExactRational, imaginary: ExactRational): ExactComplexValue {
  return { real, imaginary };
}

describe("exact linear solution verification numeric contract", () => {
  it("accepts an exact solution and rejects a solution one binary64 ulp away", () => {
    const oneUlpAboveOne = q(4_503_599_627_370_497n, 4_503_599_627_370_496n);

    expect(isExactRealLinearSolution(1, new Float64Array([1]), new Float64Array([1]), [q(1n)]))
      .toBe(true);
    expect(isExactRealLinearSolution(
      1,
      new Float64Array([1]),
      new Float64Array([1]),
      [oneUlpAboveOne],
    )).toBe(false);
  });

  it("rejects a residual that ordinary number addition rounds to zero", () => {
    const matrix = new Float64Array([9_007_199_254_740_992, 1, 0, 1]);
    const rhs = new Float64Array([9_007_199_254_740_992, 1]);

    expect(9_007_199_254_740_992 + 1).toBe(9_007_199_254_740_992);
    expect(isExactRealLinearSolution(2, matrix, rhs, [q(1n), q(1n)])).toBe(false);
  });

  it("rejects a nonzero residual that underflows to zero as a number", () => {
    const underflowingResidual = q(1n, 2n ** 1_075n);

    expect(2 ** -1075).toBe(0);
    expect(isExactRealLinearSolution(
      1,
      new Float64Array([1]),
      new Float64Array([0]),
      [underflowingResidual],
    )).toBe(false);
  });

  it("accepts exact cancellation of products that overflow as numbers", () => {
    expect(isExactRealLinearSolution(
      2,
      new Float64Array([Number.MAX_VALUE, Number.MAX_VALUE, 0, 1]),
      new Float64Array([0, -2]),
      [q(2n), q(-2n)],
    )).toBe(true);
  });

  it("checks the complex imaginary sign in the exact product", () => {
    const matrixReal = [q(1n)];
    const matrixImaginary = [q(1n)];
    const rhsReal = [q(0n)];
    const rhsImaginary = [q(2n)];

    expect(isExactComplexLinearSolution(
      1,
      matrixReal,
      matrixImaginary,
      rhsReal,
      rhsImaginary,
      [complex(q(1n), q(1n))],
    )).toBe(true);
    expect(isExactComplexLinearSolution(
      1,
      matrixReal,
      matrixImaginary,
      rhsReal,
      rhsImaginary,
      [complex(q(1n), q(-1n))],
    )).toBe(false);
  });

  it("accepts empty real and complex systems", () => {
    expect(isExactRealLinearSolution(0, new Float64Array(), new Float64Array(), [])).toBe(true);
    expect(isExactComplexLinearSolution(0, [], [], [], [], [])).toBe(true);
  });

  it("rejects invalid sizes and array shapes", () => {
    expect(isExactRealLinearSolution(-1, [], [], [])).toBe(false);
    expect(isExactRealLinearSolution(1.5, [], [], [])).toBe(false);
    expect(isExactRealLinearSolution(1, [], [q(0n)], [q(0n)])).toBe(false);
    expect(isExactRealLinearSolution(1, [q(1n)], [], [q(0n)])).toBe(false);
    expect(isExactRealLinearSolution(1, [q(1n)], [q(0n)], [])).toBe(false);

    expect(isExactComplexLinearSolution(1, [], [q(0n)], [q(0n)], [q(0n)], [complex(q(0n), q(0n))]))
      .toBe(false);
    expect(isExactComplexLinearSolution(1, [q(1n)], [], [q(0n)], [q(0n)], [complex(q(0n), q(0n))]))
      .toBe(false);
    expect(isExactComplexLinearSolution(1, [q(1n)], [q(0n)], [], [q(0n)], [complex(q(0n), q(0n))]))
      .toBe(false);
    expect(isExactComplexLinearSolution(1, [q(1n)], [q(0n)], [q(0n)], [], [complex(q(0n), q(0n))]))
      .toBe(false);
    expect(isExactComplexLinearSolution(1, [q(1n)], [q(0n)], [q(0n)], [q(0n)], []))
      .toBe(false);
  });

  it("rejects nonfinite number entries", () => {
    expect(isExactRealLinearSolution(1, new Float64Array([Number.NaN]), [q(0n)], [q(0n)]))
      .toBe(false);
    expect(isExactRealLinearSolution(1, [q(1n)], new Float64Array([Number.POSITIVE_INFINITY]), [q(0n)]))
      .toBe(false);
    expect(isExactComplexLinearSolution(
      1,
      [q(1n)],
      new Float64Array([Number.NEGATIVE_INFINITY]),
      [q(0n)],
      [q(0n)],
      [complex(q(0n), q(0n))],
    )).toBe(false);
    expect(isExactComplexLinearSolution(
      1,
      [q(1n)],
      [q(0n)],
      [q(0n)],
      new Float64Array([Number.NaN]),
      [complex(q(0n), q(0n))],
    )).toBe(false);
  });

  it("rejects zero denominators in real and complex values", () => {
    const invalid = q(1n, 0n);

    expect(isExactRealLinearSolution(1, [invalid], [q(0n)], [q(0n)])).toBe(false);
    expect(isExactRealLinearSolution(1, [q(1n)], [invalid], [q(0n)])).toBe(false);
    expect(isExactRealLinearSolution(1, [q(1n)], [q(0n)], [invalid])).toBe(false);
    expect(isExactComplexLinearSolution(
      1,
      [q(1n)],
      [q(0n)],
      [q(0n)],
      [q(0n)],
      [complex(q(0n), invalid)],
    )).toBe(false);
  });

  it("accepts negative denominators and unreduced fractions", () => {
    expect(isExactRealLinearSolution(
      1,
      [q(-6n, -3n)],
      [q(-12n, 3n)],
      [q(6n, -3n)],
    )).toBe(true);
    expect(isExactComplexLinearSolution(
      1,
      [q(-8n, -4n)],
      [q(0n, -5n)],
      [q(-12n, 3n)],
      [q(0n, 7n)],
      [complex(q(-6n, 3n), q(0n, -9n))],
    )).toBe(true);
  });

  it("does not mutate matrix, right-hand side, or solution inputs", () => {
    const realMatrix = [q(2n, 4n)];
    const realRhs = [q(1n, 2n)];
    const realSolution = [q(1n, 1n)];
    const realSnapshots = [realMatrix, realRhs, realSolution].map((values) =>
      values.map(({ numerator, denominator }) => ({ numerator, denominator })),
    );

    const complexMatrixReal = [q(2n, 4n)];
    const complexMatrixImaginary = [q(0n, 5n)];
    const complexRhsReal = [q(1n, 2n)];
    const complexRhsImaginary = [q(0n, 7n)];
    const complexSolution = [complex(q(1n, 1n), q(0n, 9n))];
    const complexSnapshots = [
      complexMatrixReal,
      complexMatrixImaginary,
      complexRhsReal,
      complexRhsImaginary,
    ].map((values) => values.map(({ numerator, denominator }) => ({ numerator, denominator })));
    const solutionSnapshot = complexSolution.map(({ real, imaginary }) => ({
      real: { numerator: real.numerator, denominator: real.denominator },
      imaginary: { numerator: imaginary.numerator, denominator: imaginary.denominator },
    }));

    expect(isExactRealLinearSolution(1, realMatrix, realRhs, realSolution)).toBe(true);
    expect(isExactComplexLinearSolution(
      1,
      complexMatrixReal,
      complexMatrixImaginary,
      complexRhsReal,
      complexRhsImaginary,
      complexSolution,
    )).toBe(true);

    expect([realMatrix, realRhs, realSolution]).toEqual(realSnapshots);
    expect([
      complexMatrixReal,
      complexMatrixImaginary,
      complexRhsReal,
      complexRhsImaginary,
    ]).toEqual(complexSnapshots);
    expect(complexSolution).toEqual(solutionSnapshot);
  });
});
