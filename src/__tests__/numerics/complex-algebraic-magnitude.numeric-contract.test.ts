import { expect, it } from "vitest";
import { complex, complexAdd, complexDivide, complexMagnitude, withComplexMagnitudeNormalization } from "../../analog-math.js";
import { assertCorrectRounding, assertCorrectSqrtRounding, rational } from "../helpers/numeric-oracle.js";

it.each([-1n, 0n, 1n])("rounds a mixed algebraic magnitude on midpoint side %s", (side) => {
  const midpoint = 2n ** 53n + 1n;
  const squaredMagnitude = rational(midpoint * midpoint * 2n ** 1094n + side, 2n ** 1200n);
  const real = withComplexMagnitudeNormalization(complex(1), rational(1n, 2n));
  const imaginary = withComplexMagnitudeNormalization(complex(0, -1),
    rational(squaredMagnitude.numerator * 2n - squaredMagnitude.denominator, squaredMagnitude.denominator * 2n));
  const value = complexAdd(real, imaginary);
  // The independently specified orthogonal squares sum exactly to q.
  assertCorrectSqrtRounding(complexMagnitude(value), squaredMagnitude, "orthogonal algebraic magnitude");
  expect(value.real).toBeGreaterThan(0);
  expect(value.imaginary).toBeLessThan(0);
});

it("certifies an irrational magnitude with a mixed complex numerator and denominator", () => {
  const numerator = complexAdd(complex(1), withComplexMagnitudeNormalization(complex(0, 1), rational(3n)));
  const denominator = complexAdd(complex(1), withComplexMagnitudeNormalization(complex(1), rational(2n)));
  const actual = complexMagnitude(complexDivide(numerator, denominator));
  // |(1+i√3)/(1+√2)| = 2√2−2. Independently bracket √2
  // using integer Newton iteration, without production arithmetic functions.
  const scale = 2n ** 1024n;
  const square = 2n * scale * scale;
  let root = 2n * scale;
  for (;;) {
    const next = (root + square / root) / 2n;
    if (next >= root) { break; }
    root = next;
  }
  expect(root * root <= square && square < (root + 1n) ** 2n).toBe(true);
  assertCorrectRounding(actual, rational(2n * root - 2n * scale, scale), "algebraic magnitude lower bound");
  assertCorrectRounding(actual, rational(2n * (root + 1n) - 2n * scale, scale), "algebraic magnitude upper bound");
});
