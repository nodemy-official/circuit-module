import { describe, expect, it } from "vitest";

import {
  addExactRational,
  deferExactRationalReduction,
  divideExactRational,
  exactRationalProductToNumber,
  exactRationalSquareRootToNumber,
  exactRationalToNumber,
  isExactComplexLinearSolution,
  isExactRealLinearSolution,
  multiplyExactRational,
  subtractExactRational,
  sumExactRationals,
  type ExactRational,
} from "../../exact-linear-algebra.js";
import {
  addRational,
  assertCorrectRounding,
  assertCorrectSqrtRounding,
  compareRational,
  createSeededRandom,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
} from "../helpers/numeric-oracle.js";

const q = (numerator: bigint, denominator = 1n): ExactRational => ({ numerator, denominator });
const zero = q(0n);
const widths = [2047, 2048, 2049, 4095, 4096, 4097];

function assertSameValue(actual: ExactRational | null, expected: ExactRational) {
  if (actual === null) {
    throw new Error("The exact arithmetic result must exist.");
  }
  if (actual.denominator <= 0n) {
    throw new Error("The exact arithmetic denominator must be positive.");
  }
  if (compareRational(actual, expected) !== 0) {
    throw new Error("The exact arithmetic result differs from the independent oracle.");
  }
}

describe("independent long quotient review", () => {
  it("preserves arbitrary signed arithmetic across raw, canonical, and deferred operands", () => {
    const next = createSeededRandom(0x519e_872dn);
    for (let index = 0; index < 36; index += 1) {
      const factor = 2n ** BigInt(widths[index % widths.length]!) + 1n;
      const sign = index % 2 === 0 ? -1n : 1n;
      const left = q(sign * (next() + 1n) * factor, (next() + 1n) * factor);
      const right = q((next() + 1n) * (factor + 2n), sign * (next() + 1n) * (factor + 2n));
      const expected = [
        addRational(left, right), subtractRational(left, right),
        multiplyRational(left, right), divideRational(left, right),
      ];
      const modes = [
        [left, right],
        [addExactRational(left, zero), addExactRational(right, zero)],
        [deferExactRationalReduction(left), right],
        [deferExactRationalReduction(left), deferExactRationalReduction(right)],
      ];
      for (const [first, second] of modes) {
        const results = [
          addExactRational(first!, second!), subtractExactRational(first!, second!),
          multiplyExactRational(first!, second!), divideExactRational(first!, second!),
        ];
        for (let operation = 0; operation < results.length; operation += 1) {
          assertSameValue(results[operation]!, expected[operation]!);
        }
        assertSameValue(sumExactRationals([first!, second!, zero]), expected[0]!);
      }
    }
  });

  it("cancels huge factors for quotients wider than 128 bits with either sign and operand order", () => {
    const factor = 2n ** 2048n + 1n;
    for (const bits of [1, 127, 128, 129, 2047, 2050]) {
      const quotient = 2n ** BigInt(bits) + 3n;
      for (const sign of [-1n, 1n]) {
        const left = q(sign * quotient * factor, 7n * factor);
        const right = q(11n * factor, 13n * factor);
        assertSameValue(multiplyExactRational(left, right), q(sign * 11n * quotient, 91n));
        assertSameValue(multiplyExactRational(right, left), q(sign * 11n * quotient, 91n));
        assertSameValue(divideExactRational(left, right), q(sign * 13n * quotient, 77n));
        assertSameValue(divideExactRational(right, left), q(sign * 77n, 13n * quotient));
      }
    }
    expect(divideExactRational(zero, q(factor))).toEqual(zero);
    expect(divideExactRational(q(factor), zero)).toBeNull();
  });

  it("retains canonical answers after both cache capacities are exceeded and old keys recur", () => {
    for (const cycle of [0, 1]) {
      for (let index = 0; index < 34; index += 1) {
        const numerator = 2n ** 2048n + BigInt(index);
        for (let divisor = 2n; divisor <= 18n; divisor += 1n) {
          const sign = cycle === 0 ? -1n : 1n;
          const expected = rational(sign * numerator, divisor);
          expect(addExactRational(q(sign * numerator, divisor), zero)).toEqual(expected);
          expect(addExactRational(q(-sign * numerator, -divisor), zero)).toEqual(expected);
        }
      }
    }
  });

  it("rounds perturbed signed midpoints with one-unit histories at the optimization threshold", () => {
    const midpoints = [
      q(2n ** 53n + 1n, 2n ** 53n), q(2n ** 53n + 3n, 2n ** 53n),
      q(1n, 2n ** 1075n), q(3n, 2n ** 1075n),
      q(2n ** 53n - 1n, 2n ** 1075n), q((2n ** 54n - 1n) * 2n ** 970n),
    ];
    for (const factor of [2n ** 2048n - 1n, 2n ** 2048n, 2n ** 2048n + 1n]) {
      for (const midpoint of midpoints) {
        for (const offset of [-1n, 0n, 1n]) {
          for (const sign of [-1n, 1n]) {
            const input = q(sign * (midpoint.numerator * factor + offset), midpoint.denominator * factor);
            assertCorrectRounding(exactRationalToNumber(input), input, "threshold midpoint");
          }
        }
      }
    }
  });

  it("certifies interval products using independent exact cross-products", () => {
    const next = createSeededRandom(0x9367_442bn);
    for (let index = 0; index < 30; index += 1) {
      const factor = 2n ** BigInt(widths[index % widths.length]!) + 1n;
      const sign = index % 2 === 0 ? -1n : 1n;
      const left = deferExactRationalReduction(q(sign * (next() + 1n) * factor + 1n, (next() + 1n) * factor));
      const right = deferExactRationalReduction(q((next() + 1n) * factor - 1n, (next() + 1n) * factor));
      const expected = q(left.numerator * right.numerator, left.denominator * right.denominator);
      assertCorrectRounding(exactRationalProductToNumber(left, right), expected, `product ${index}`);
    }
  });

  it("accepts independently assembled real equations and rejects a one-unit residual", () => {
    for (let index = 0; index < 18; index += 1) {
      const factor = 2n ** BigInt(widths[index % widths.length]!) + 1n;
      const matrix = [q(2n), q(1n, factor), q(-3n, factor), q(4n)];
      const solution = [
        deferExactRationalReduction(q(factor + 1n, factor)),
        deferExactRationalReduction(q(-factor + 1n, factor)),
      ];
      const rhs = [0, 1].map((row) => {
        const sum = addRational(multiplyRational(matrix[row * 2]!, solution[0]!), multiplyRational(matrix[row * 2 + 1]!, solution[1]!));
        const scale = index % 3 === 0 ? -factor : index % 3 === 1 ? 2n : 1n;
        return q(sum.numerator * scale, sum.denominator * scale);
      });
      expect(isExactRealLinearSolution(2, matrix, rhs, solution)).toBe(true);
      for (const row of [0, 1]) {
        const wrong = rhs.map((value, position) => position === row ? q(value.numerator + 1n, value.denominator) : value);
        expect(isExactRealLinearSolution(2, matrix, wrong, solution)).toBe(false);
      }
    }
    expect(isExactRealLinearSolution(1, [zero], [q(0n, 2n ** 4096n)], [zero])).toBe(true);
    expect(isExactRealLinearSolution(1, [zero], [q(1n, 2n ** 4096n)], [zero])).toBe(false);
  });

  it("checks both components of complex equations against independent rational products", () => {
    for (const width of widths) {
      const factor = 2n ** BigInt(width) + 1n;
      const real = q(2n, factor);
      const imaginary = q(-3n, factor);
      const solution = {
        real: deferExactRationalReduction(q(factor + 1n, factor)),
        imaginary: deferExactRationalReduction(q(-factor + 1n, factor)),
      };
      const expectedReal = subtractRational(multiplyRational(real, solution.real), multiplyRational(imaginary, solution.imaginary));
      const expectedImaginary = addRational(multiplyRational(real, solution.imaginary), multiplyRational(imaginary, solution.real));
      const rhsReal = q(-2n * expectedReal.numerator, -2n * expectedReal.denominator);
      const rhsImaginary = q(3n * expectedImaginary.numerator, 3n * expectedImaginary.denominator);
      expect(isExactComplexLinearSolution(1, [real], [imaginary], [rhsReal], [rhsImaginary], [solution])).toBe(true);
      expect(isExactComplexLinearSolution(1, [real], [imaginary], [q(rhsReal.numerator + 1n, rhsReal.denominator)], [rhsImaginary], [solution])).toBe(false);
      expect(isExactComplexLinearSolution(1, [real], [imaginary], [rhsReal], [q(rhsImaginary.numerator + 1n, rhsImaginary.denominator)], [solution])).toBe(false);
    }
  });

  it("preserves square-root rounding around bit-length powers and signed normalization", () => {
    for (const width of [31, 32, 33, 63, 64, 65, 127, 128, 129, 2047, 2048, 2049, 4095, 4096, 4097]) {
      const power = 2n ** BigInt(width);
      for (const offset of [-1n, 0n, 1n]) {
        const input = q(-(power + offset), -(power - 1n));
        assertCorrectSqrtRounding(exactRationalSquareRootToNumber(input), rational(input.numerator, input.denominator), `sqrt ${width}`);
      }
    }
  });
});
