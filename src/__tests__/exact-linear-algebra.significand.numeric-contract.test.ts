import { expect, it } from "vitest";
import { roundExactRationalSignificand } from "../exact-linear-algebra.js";
import { addRational, compareRational, multiplyRational, negateRational, rational } from "./helpers/numeric-oracle.js";

it.each([2, 53, 512].flatMap((bits) => [-2500, -1074, -1022, -1, 0, 1024, 2500].map((exponent) => ({ bits, exponent }))))(
  "rounds $bits significant bits at exponent $exponent without clipping the exponent",
  ({ bits, exponent }) => {
    const unitExponent = exponent - bits + 1;
    const unit = unitExponent < 0 ? rational(1n, 2n ** BigInt(-unitExponent)) : rational(2n ** BigInt(unitExponent));
    const leading = 2n ** BigInt(bits - 1);
    for (const base of [leading, leading + 1n, 2n ** BigInt(bits) - 1n]) {
      for (const quarter of [1n, 2n, 3n]) {
        const input = multiplyRational(addRational(rational(base), rational(quarter, 4n)), unit);
        // Quarter-bin positions and parity determine the independent answer,
        // including the carry into the next exponent at the upper midpoint.
        const rounded = base + (quarter > 2n || (quarter === 2n && base % 2n !== 0n) ? 1n : 0n);
        const expected = multiplyRational(rational(rounded), unit);
        for (const sign of [1, -1]) {
          const signedInput = sign === 1 ? input : negateRational(input);
          const signedExpected = sign === 1 ? expected : negateRational(expected);
          const actual = roundExactRationalSignificand(signedInput, bits);
          expect(compareRational(actual, signedExpected)).toBe(0);
          expect(actual.denominator).toBeGreaterThan(0n);
        }
      }
    }
  },
);

it("preserves exact zero and rejects invalid precision", () => {
  expect(roundExactRationalSignificand(rational(0n), 512)).toEqual(rational(0n));
  for (const bits of [0, 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => roundExactRationalSignificand(rational(1n), bits)).toThrow(RangeError);
  }
});
