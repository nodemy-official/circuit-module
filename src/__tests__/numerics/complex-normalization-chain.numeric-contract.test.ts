import { describe, expect, it } from "vitest";
import {
  complex, complexAdd, complexConjugate, complexDivide, complexFromPolar, complexMagnitude,
  complexMultiply, complexRectangularValue, complexSubtract, withComplexMagnitudeNormalization,
} from "../../analog-math.js";
import { exactRationalSquareRoot } from "../../exact-linear-algebra.js";
import { exactComplexValue } from "../../exact-numeric-state.js";
import {
  addRational, assertCorrectRounding, assertCorrectSqrtRounding, compareRational,
  divideRational, multiplyRational, rational, subtractRational,
} from "../helpers/numeric-oracle.js";

const expectExactZero = (value: ReturnType<typeof complex>) => {
  const exact = exactComplexValue(value)!;
  if (value.real !== 0 || value.imaginary !== 0 || exact.real.numerator !== 0n || exact.imaginary.numerator !== 0n) {
    throw new Error("The cancelling chain must retain exact zero in both components.");
  }
};

describe("amplitude corrections through arithmetic chains", () => {
  it.each([complex(1), complex(1, 2), complex(0, 1)])(
    "simplifies mixed-radical division chains with coefficient %j before midpoint rounding", (coefficient) => {
      const sum = complexAdd(withComplexMagnitudeNormalization(coefficient, rational(2n)), complex(1));
      const unit = complexDivide(complexDivide(complexMultiply(sum, sum), sum), sum);
      expect(unit).toEqual(complex(1));
      expectExactZero(complexSubtract(unit, complex(1)));
      for (const numerator of [1n, 3n, 5n]) {
        const result = complexAdd(unit, complex(Number(numerator) * 2 ** -53));
        const expected = addRational(rational(1n), rational(numerator, 2n ** 53n));
        assertCorrectRounding(result.real, expected, "mixed divisor midpoint");
        expect(compareRational(exactComplexValue(result)!.real, expected)).toBe(0);
      }
    },
  );

  it("retains fractions through sums, products, quotients, conjugation and rectangular conversion", () => {
    const root = (squared: bigint, real: number, imaginary: number) =>
      withComplexMagnitudeNormalization(complex(real, imaginary), rational(squared));
    const first = complexAdd(complexAdd(root(2n, 1, 2), root(3n, 3, -1)), complex(1));
    const second = complexAdd(root(5n, 2, -1), complex(2, 1));
    const numerator = complex(1, 2);
    const left = complexDivide(numerator, first);
    const right = complexDivide(complex(1), second);
    const product = complexMultiply(first, second);
    expectExactZero(complexSubtract(complexMultiply(left, first), numerator));
    expectExactZero(complexSubtract(complexMultiply(complexRectangularValue(left), first), numerator));
    expectExactZero(complexSubtract(complexMultiply(complexAdd(left, right), product),
      complexAdd(complexMultiply(numerator, second), first)));
    expectExactZero(complexSubtract(complexMultiply(complexSubtract(left, right), product),
      complexSubtract(complexMultiply(numerator, second), first)));
    expectExactZero(complexSubtract(complexMultiply(complexDivide(left, right), first), complexMultiply(numerator, second)));
    expectExactZero(complexSubtract(complexMultiply(complexConjugate(left), complexConjugate(first)), complexConjugate(numerator)));
    expectExactZero(complexSubtract(complexMultiply(left, right), complexDivide(numerator, product)));
  });

  it("recognizes an exact midpoint component alongside an irrational quotient component", () => {
    const divisor = complexAdd(withComplexMagnitudeNormalization(complex(1), rational(2n)), complex(1));
    for (const offset of [1n, 3n]) {
      const midpoint = addRational(rational(1n), rational(offset, 2n ** 53n));
      const scale = complexAdd(complex(1), complex(Number(offset) * 2 ** -53));
      const numerator = complexAdd(complexMultiply(divisor, scale),
        withComplexMagnitudeNormalization(complex(0, 1), rational(3n)));
      const quotient = complexDivide(numerator, divisor);
      assertCorrectRounding(quotient.real, midpoint, "rational component of an algebraic fraction");
      expect(compareRational(exactComplexValue(quotient)!.real, midpoint)).toBe(0);
      expectExactZero(complexSubtract(complexMultiply(quotient, divisor), numerator));
    }
  });

  it.each([-1n, 1n])("certifies a general quotient on side %s of a midpoint beyond 512 bits", (side) => {
    const gap = rational(side, 2n ** 1600n);
    const squared = addRational(rational(1n), gap);
    const midpoint = rational(2n ** 53n + 1n, 2n ** 53n);
    // Independent rational bounds, verified by squaring; neither endpoint is
    // the midpoint, so both enclosures must round to the same candidate.
    const upperRoot = addRational(rational(1n), divideRational(gap, rational(2n)));
    const lowerRoot = subtractRational(upperRoot, multiplyRational(gap, gap));
    expect(compareRational(multiplyRational(lowerRoot, lowerRoot), squared)).toBeLessThan(0);
    expect(compareRational(multiplyRational(upperRoot, upperRoot), squared)).toBeGreaterThan(0);
    const twiceMidpoint = multiplyRational(rational(2n), midpoint);
    const lower = divideRational(twiceMidpoint, addRational(rational(1n), upperRoot));
    const upper = divideRational(twiceMidpoint, addRational(rational(1n), lowerRoot));
    for (const direction of [complex(1), complex(1, 1)]) {
      const divisor = complexAdd(direction, withComplexMagnitudeNormalization(direction, squared));
      const numerator = complexMultiply(complexAdd(complex(2), complex(2 ** -52)), direction);
      const quotient = complexDivide(numerator, divisor);
      assertCorrectRounding(quotient.real, lower, "quotient lower enclosure");
      assertCorrectRounding(quotient.real, upper, "quotient upper enclosure");
      expect(quotient.imaginary).toBe(0);
      expectExactZero(complexSubtract(complexMultiply(quotient, divisor), numerator));
    }
  });

  it("recovers the rationalized reciprocal identity without a field conjugation expansion", () => {
    const root = withComplexMagnitudeNormalization(complex(1), rational(2n));
    const divisor = complexAdd(root, complex(1));
    const reciprocal = complexDivide(complex(1), divisor);
    expectExactZero(complexSubtract(reciprocal, complexSubtract(root, complex(1))));
    const zero = complexSubtract(divisor, divisor);
    expect(complexDivide(complex(1), zero).real).toBeNaN();
    expect(complexDivide(zero, zero).imaginary).toBeNaN();
    expectExactZero(complexDivide(zero, divisor));
  });

  it("preserves fractions whose square roots have widely different exponents", () => {
    const tiny = withComplexMagnitudeNormalization(complex(2 ** 600, 2 ** 599), rational(2n, 2n ** 1200n));
    const huge = withComplexMagnitudeNormalization(complex(2 ** -600, -(2 ** -599)), rational(3n * 2n ** 1200n));
    const divisor = complexAdd(complexAdd(tiny, huge), complex(1, -1));
    const numerator = complex(2, -3);
    const quotient = complexDivide(numerator, divisor);
    expectExactZero(complexSubtract(complexMultiply(quotient, divisor), numerator));
    const unit = complexDivide(complexDivide(complexMultiply(divisor, divisor), divisor), divisor);
    assertCorrectRounding(complexAdd(unit, complex(2 ** -53)).real,
      rational(2n ** 53n + 1n, 2n ** 53n), "exponent-separated divisor midpoint");
  });

  it("certifies a nonzero mixed divisor even when its public component underflows", () => {
    const gap = rational(1n, 2n ** 1600n);
    const divisor = complexSubtract(withComplexMagnitudeNormalization(complex(1), addRational(rational(1n), gap)), complex(1));
    expect(divisor.real).toBe(0);
    expect(exactComplexValue(divisor)!.real.numerator).not.toBe(0n);
    const numerator = complex(2 ** -800);
    const quotient = complexDivide(numerator, divisor);
    const halfGap = divideRational(gap, rational(2n));
    const lower = divideRational(rational(1n, 2n ** 800n), halfGap);
    const upper = divideRational(rational(1n, 2n ** 800n), subtractRational(halfGap, multiplyRational(gap, gap)));
    assertCorrectRounding(quotient.real, lower, "underflowed divisor lower enclosure");
    assertCorrectRounding(quotient.real, upper, "underflowed divisor upper enclosure");
    expectExactZero(complexSubtract(complexMultiply(quotient, divisor), numerator));
  });

  it("applies normalization replacement to fraction provenance", () => {
    const divisor = complexAdd(withComplexMagnitudeNormalization(complex(1, 2), rational(2n)), complex(1));
    const quotient = complexDivide(complex(1, -1), divisor);
    const scaled = withComplexMagnitudeNormalization(quotient, rational(2n));
    const restored = withComplexMagnitudeNormalization(scaled, rational(1n));
    expectExactZero(complexSubtract(restored, quotient));
    expectExactZero(complexSubtract(complexMultiply(complexRectangularValue(scaled), divisor),
      withComplexMagnitudeNormalization(complex(1, -1), rational(2n))));
    expectExactZero(complexSubtract(withComplexMagnitudeNormalization(scaled, rational(3n)),
      withComplexMagnitudeNormalization(quotient, rational(3n))));
  });

  it.each(["real", "imaginary"] as const)("invalidates fraction provenance after a caller edits %s", (component) => {
    const divisor = complexAdd(withComplexMagnitudeNormalization(complex(1, 2), rational(2n)), complex(1));
    const quotient = complexDivide(complex(1), divisor);
    const original = complexDivide(complex(1), divisor);
    quotient[component] = 2;
    const edited = complex(quotient.real, quotient.imaginary);
    expectExactZero(complexSubtract(quotient, edited));
    expectExactZero(complexSubtract(complexMultiply(quotient, divisor), complexMultiply(edited, divisor)));
    expectExactZero(complexSubtract(complexMultiply(original, divisor), complex(1)));
  });

  it("retains a sum of 32 independent roots through reciprocal cancellation", () => {
    const primes = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n,
      59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n, 113n, 127n, 131n];
    const sum = primes.map((squared) => withComplexMagnitudeNormalization(complex(1), rational(squared)))
      .reduce(complexAdd, complex());
    expect(complexDivide(sum, sum)).toEqual(complex(1));
    // This needs compact products, not all 2^32 field conjugates.
    expectExactZero(complexSubtract(complexMultiply(complexDivide(complex(1), sum), sum), complex(1)));
  });

  it.each([37, -37, 45, 1e-200])("retains cancelling phase %s through mixed sums and a final divisor", (phase) => {
    const value = complexFromPolar(1, phase);
    const restored = complexSubtract(complexAdd(value, complex(1)), complex(1));
    expectExactZero(complexSubtract(restored, value));
    const unit = complexDivide(restored, value);
    expect(unit).toEqual(complex(1));
    for (const numerator of [1n, 3n, 5n]) {
      const result = complexAdd(unit, complex(Number(numerator) * 2 ** -53));
      assertCorrectRounding(result.real, addRational(rational(1n), rational(numerator, 2n ** 53n)), "chained midpoint");
    }
  });

  it("combines rationally equivalent radicals and preserves exact residuals through scaling", () => {
    const first = withComplexMagnitudeNormalization(complex(1, 2), rational(2n));
    const second = withComplexMagnitudeNormalization(complex(2, 4), rational(1n, 2n));
    const shifted = complexAdd(first, complex(1e-300, -1e-300));
    const difference = complexSubtract(shifted, second);
    expect(complexDivide(difference, complex(1e-300))).toEqual(complex(1, -1));
    expectExactZero(complexSubtract(complexMultiply(shifted, complex(2)), complexMultiply(complexAdd(second, complex(1e-300, -1e-300)), complex(2))));
  });

  it("retains each independent radical through a longer sum and rectangular conversion", () => {
    const terms = [2n, 3n, 5n, 7n].map((squared, index) =>
      withComplexMagnitudeNormalization(complex(index + 1, 4 - index), rational(squared)));
    let sum = terms.reduce(complexAdd, complex());
    sum = complexRectangularValue(sum);
    for (const index of [2, 0, 3, 1]) { sum = complexSubtract(sum, terms[index]!); }
    expectExactZero(sum);
  });

  it.each([-1n, 1n])("refines independent radicals on side %s of a binary64 midpoint", (side) => {
    const midpoint = 2n ** 53n + 1n;
    const squared = rational(midpoint * midpoint * 2n ** 1094n + side, 2n ** 1200n);
    const real = withComplexMagnitudeNormalization(complex(1), squared);
    const second = withComplexMagnitudeNormalization(complex(0, 1), rational(2n));
    const third = withComplexMagnitudeNormalization(complex(0, 1), rational(3n));
    const pair = complexAdd(real, second);
    const combined = complexAdd(pair, third);
    for (const value of [pair, combined, complexSubtract(combined, third), complexSubtract(complexSubtract(combined, third), second)]) {
      assertCorrectSqrtRounding(value.real, squared, "algebraic midpoint enclosure");
    }
  });

  it.each([-1n, 0n, 1n])("re-expands retained terms after normalization replacement on midpoint side %s", (side) => {
    const midpoint = 2n ** 53n + 1n;
    const squared = rational(midpoint * midpoint * 2n ** 1094n + side, 2n ** 1200n);
    const real = withComplexMagnitudeNormalization(complex(1), rational(squared.numerator, 9n * squared.denominator));
    const imaginary = withComplexMagnitudeNormalization(complex(0, 1), rational(2n));
    const sum = complexAdd(real, imaginary);
    const replaced = withComplexMagnitudeNormalization(sum, rational(9n));
    for (const value of [complexRectangularValue(replaced), complexRectangularValue(withComplexMagnitudeNormalization(real, squared))]) {
      assertCorrectSqrtRounding(value.real, squared, "replacement midpoint rectangular projection");
    }
  });

  it("keeps multiplication and conjugation consistent with distributive identities", () => {
    const value = complexFromPolar(1, 37);
    const plus = complexAdd(value, complex(1));
    const minus = complexSubtract(value, complex(1));
    expectExactZero(complexSubtract(complexMultiply(plus, minus), complexSubtract(complexMultiply(value, value), complex(1))));
    expectExactZero(complexSubtract(complexConjugate(plus), complexAdd(complexConjugate(value), complex(1))));
  });

  it("invalidates a sum's retained terms when its rectangular values are edited", () => {
    const sum = complexAdd(complexFromPolar(1, 37), complex(1));
    sum.real = 2;
    sum.imaginary = 0;
    expect(complexSubtract(sum, complex(1))).toEqual(complex(1));
    expect(complexMagnitude(sum)).toBe(2);
  });

  it("extracts only exact rational square roots with normalized signs", () => {
    expect(exactRationalSquareRoot(rational(4n, 9n))).toEqual(rational(2n, 3n));
    expect(exactRationalSquareRoot({ numerator: -16n, denominator: -36n })).toEqual(rational(2n, 3n));
    expect(exactRationalSquareRoot(rational(0n))).toEqual(rational(0n));
    expect(exactRationalSquareRoot(rational(2n))).toBeNull();
    expect(exactRationalSquareRoot(rational(-1n))).toBeNull();
    expect(exactRationalSquareRoot({ numerator: 1n, denominator: 0n })).toBeNull();
  });
});
