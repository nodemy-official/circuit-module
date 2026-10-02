import { describe, expect, it } from "vitest";

import {
  addExactRational,
  deferExactRationalReduction,
  divideExactRational,
  exactRationalProductToNumber,
  exactRationalToNumber,
  isExactRealLinearSolution,
  multiplyExactRational,
  roundExactRationalSignificand,
  sumExactRationals,
} from "../../exact-linear-algebra.js";
import { assertCorrectRounding, compareRational, rational } from "../helpers/numeric-oracle.js";

const widths = [2047, 2048, 2049, 4095, 4096, 4097, 20_000, 200_000];

describe("long integer quotient numeric contract", () => {
  it.each(widths)("rounds unreduced %i-bit histories at binary64 midpoints", (width) => {
    const factor = 2n ** BigInt(width) + 1n;
    const midpoints = [
      { numerator: 2n ** 53n + 1n, denominator: 2n ** 53n },
      { numerator: 2n ** 53n + 3n, denominator: 2n ** 53n },
      { numerator: 1n, denominator: 2n ** 1075n },
      { numerator: 3n, denominator: 2n ** 1075n },
      { numerator: 2n ** 53n - 1n, denominator: 2n ** 1075n },
      { numerator: (2n ** 54n - 1n) * 2n ** 970n, denominator: 1n },
    ];
    for (const midpoint of midpoints) {
      for (const offset of [-1n, 0n, 1n]) {
        for (const sign of [-1n, 1n]) {
          const value = {
            numerator: sign * (midpoint.numerator * factor + offset),
            denominator: midpoint.denominator * factor,
          };
          assertCorrectRounding(exactRationalToNumber(value), value, `width=${width}, offset=${offset}`);
        }
      }
    }
  });

  it.each([2, 53, 257, 512])("certifies %i-bit quotients on either side of integer and rounding boundaries", (bits) => {
    const factor = 2n ** 20_000n + 1n;
    for (const base of [2n ** BigInt(bits - 1), 2n ** BigInt(bits - 1) + 1n]) {
      for (const quarter of [0n, 1n, 2n, 3n]) {
        for (const offset of [-1n, 0n, 1n]) {
          // Offset is much smaller than a quarter bin; parity decides an
          // exact tie, independently of the production quotient algorithm.
          const increment = quarter > 2n || (quarter === 2n &&
            (offset > 0n || (offset === 0n && base % 2n === 1n))) ? 1n : 0n;
          const input = { numerator: (4n * base + quarter) * factor + offset, denominator: 4n * factor };
          for (const sign of [-1n, 1n]) {
            const actual = roundExactRationalSignificand({ ...input, numerator: sign * input.numerator }, bits);
            expect(compareRational(actual, { numerator: sign * (base + increment), denominator: 1n })).toBe(0);
          }
        }
      }
    }
  });

  it.each(widths)("preserves exact cancellation and denominator scales in %i-bit arithmetic", (width) => {
    const factor = 2n ** BigInt(width) + 1n;
    const left = deferExactRationalReduction({ numerator: 7n, denominator: 3n * factor });
    const right = deferExactRationalReduction({ numerator: 11n, denominator: 5n * factor });
    const expectedSum = { numerator: 68n, denominator: 15n * factor };
    expect(compareRational(addExactRational(left, right), expectedSum)).toBe(0);
    expect(compareRational(sumExactRationals([left, right]), expectedSum)).toBe(0);
    for (const sign of [-1n, 1n]) {
      const first = { numerator: sign * 7n * factor, denominator: 11n * factor };
      const second = { numerator: 13n * factor, denominator: 17n * factor };
      expect(multiplyExactRational(first, second)).toEqual({ numerator: sign * 91n, denominator: 187n });
      expect(divideExactRational(first, second)).toEqual({ numerator: sign * 119n, denominator: 143n });
    }
  });

  it("checks the full exact equation despite a residual smaller than binary64", () => {
    const factor = 2n ** 200_000n + 1n;
    const solution = [deferExactRationalReduction({ numerator: factor + 1n, denominator: factor })];
    const coefficient = [{ numerator: 3n, denominator: 5n }];
    const rhs = [{ numerator: 6n * (factor + 1n), denominator: 10n * factor }];
    expect(isExactRealLinearSolution(1, coefficient, rhs, solution)).toBe(true);
    expect(isExactRealLinearSolution(1, coefficient, [{ ...rhs[0]!, numerator: rhs[0]!.numerator + 1n }], solution))
      .toBe(false);
  });

  it("preserves canonical answers across repeated small divisors and cache eviction", () => {
    const divisors = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n];
    for (let repeat = 0; repeat < 2; repeat += 1) {
      for (let index = 0; index < 40; index += 1) {
        const numerator = 2n ** 4096n + BigInt(index);
        for (const divisor of divisors) {
          for (const sign of [-1n, 1n]) {
            expect(divideExactRational(
              { numerator: sign * numerator, denominator: 1n },
              { numerator: divisor, denominator: 1n },
            )).toEqual(rational(sign * numerator, divisor));
          }
        }
      }
    }
  });

  it("keys reused factors by integer values when callers edit a rational object", () => {
    const input = { numerator: 3n * 2n ** 4096n, denominator: 1n };
    const divisor = { numerator: 3n, denominator: 1n };
    for (let edit = 0; edit < 4; edit += 1) {
      expect(divideExactRational(input, divisor)).toEqual(rational(input.numerator, divisor.numerator));
      input.numerator += 1n;
      divisor.numerator += 2n;
    }
  });

  it("certifies product bounds for histories straddling a rounding midpoint", () => {
    const factor = 2n ** 20_000n + 1n;
    const denominator = factor * 2n ** 53n;
    const left = deferExactRationalReduction({ numerator: factor + 1n, denominator: factor });
    for (const offset of [-3n, 0n, 3n]) {
      const right = deferExactRationalReduction({ numerator: factor * (2n ** 53n + 1n) + offset, denominator });
      const expectedProduct = { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
      assertCorrectRounding(exactRationalProductToNumber(left, right), expectedProduct, `product offset=${offset}`);
    }
  });
});
