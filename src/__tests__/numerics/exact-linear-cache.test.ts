import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearExactLinearInverseCache,
  solveRealLinearSystemWithExactInverseCache,
} from "../../exact-linear-cache.js";
import { numberToExactRational } from "../../exact-linear-algebra.js";
import { exactRealStateValue, realStateFromExact } from "../../exact-numeric-state.js";
import {
  assertCorrectRounding,
  compareRational,
  divideRational,
  rational,
  rationalFromNumber,
  type Rational,
} from "../helpers/numeric-oracle.js";

function assertCachedSolution(
  result: ReturnType<typeof solveRealLinearSystemWithExactInverseCache>,
  expected: Rational,
  cacheHit: boolean,
) {
  if (result.status !== "solved") { throw new Error(`Expected a cached solution, got ${result.status}`); }
  if (result.cacheHit !== cacheHit) { throw new Error(`Expected cacheHit=${String(cacheHit)}`); }
  const actual = exactRealStateValue(result.solution, 0);
  if (!actual) { throw new Error("Missing exact solution"); }
  if (compareRational(actual, expected) !== 0) { throw new Error("Incorrect exact solution"); }
  assertCorrectRounding(result.solution[0]!, expected, "cached solution");
}

describe("exact linear inverse cache", () => {
  beforeEach(clearExactLinearInverseCache);
  afterEach(clearExactLinearInverseCache);

  it("waits for matrix reuse and keeps changing right sides and underflowed results exact", () => {
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    const twiceMinimum = numberToExactRational(Number.MIN_VALUE * 2)!;
    const expectedUnderflow = rational(1n, 2n ** 1075n);

    const first = solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [minimum]);
    expect(first.status).toBe("not-applicable");
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [minimum]),
      expectedUnderflow,
      false,
    );
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [twiceMinimum]),
      rational(1n, 2n ** 1074n),
      true,
    );

    const changed = solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(4), [twiceMinimum]);
    expect(changed.status).toBe("not-applicable");
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(4), [twiceMinimum]),
      expectedUnderflow,
      false,
    );
  });

  it("uses an exact inverse even when its entries overflow binary64", () => {
    const finiteRhs = numberToExactRational(1e-308)!;
    const expected = divideRational(rationalFromNumber(1e-308)!, rational(1n, 2n ** 1074n));
    expect(solveRealLinearSystemWithExactInverseCache(
      1, Float64Array.of(Number.MIN_VALUE), [finiteRhs],
    ).status).toBe("not-applicable");
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(Number.MIN_VALUE), [finiteRhs]),
      expected,
      false,
    );
  });

  it("admits interleaved recurring matrices and reuses their inverses", () => {
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    const coefficients = Array.from({ length: 16 }, (_, index) => index + 2);
    for (const coefficient of coefficients) {
      expect(solveRealLinearSystemWithExactInverseCache(
        1, Float64Array.of(coefficient), [minimum],
      ).status).toBe("not-applicable");
    }
    for (const cacheHit of [false, true]) {
      for (const coefficient of coefficients) {
        assertCachedSolution(
          solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(coefficient), [minimum]),
          rational(1n, BigInt(coefficient) * 2n ** 1074n),
          cacheHit,
        );
      }
    }
  });

  it("avoids inverse construction for a stream of changing matrices with distant repeats", () => {
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let coefficient = 2; coefficient < 22; coefficient += 1) {
        expect(solveRealLinearSystemWithExactInverseCache(
          1, Float64Array.of(coefficient), [minimum],
        ).status).toBe("not-applicable");
      }
    }
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(21), [minimum]),
      rational(1n, 21n * 2n ** 1074n),
      false,
    );
  });

  it("distinguishes exact coefficients with the same binary64 projection", () => {
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    const underflowed = realStateFromExact([rational(1n, 2n ** 1075n)]);
    const differentUnderflow = realStateFromExact([rational(1n, 2n ** 1076n)]);
    expect(underflowed[0]).toBe(differentUnderflow[0]);
    expect(solveRealLinearSystemWithExactInverseCache(1, underflowed, [minimum]).status).toBe("not-applicable");
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, underflowed, [minimum]), rational(2n), false,
    );
    expect(solveRealLinearSystemWithExactInverseCache(1, differentUnderflow, [minimum]).status).toBe("not-applicable");
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, differentUnderflow, [minimum]), rational(4n), false,
    );
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, underflowed, [minimum]), rational(2n), true,
    );
  });

  it("clears both reuse history and stored inverses", () => {
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [minimum]);
    solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [minimum]);
    solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(3), [minimum]);
    clearExactLinearInverseCache();
    for (const coefficient of [2, 3]) {
      expect(solveRealLinearSystemWithExactInverseCache(
        1, Float64Array.of(coefficient), [minimum],
      ).status).toBe("not-applicable");
    }
  });

  it("keeps the first-use inverse path for large exact histories", () => {
    const belowThreshold = rational(1n, 2n ** 8190n);
    expect(solveRealLinearSystemWithExactInverseCache(
      1, Float64Array.of(5), [belowThreshold],
    ).status).toBe("not-applicable");
    const history = rational(1n, 2n ** 8191n);
    for (const coefficient of [2, 3, 4]) {
      assertCachedSolution(
        solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(coefficient), [history]),
        rational(1n, BigInt(coefficient) * 2n ** 8191n),
        false,
      );
    }
    assertCachedSolution(
      solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [history]),
      rational(1n, 2n ** 8192n),
      true,
    );
  });

  it("keeps a changing dense system fast with nonbinary exact histories", () => {
    let previous = 0n;
    let next = 1n;
    for (let index = 0; index < 12_000; index += 1) {
      [previous, next] = [next, previous + next];
    }
    const expected = { numerator: previous, denominator: next };
    for (const weight of [1, 2, 3]) {
      // Every row sums to one, so the independent solution is the same
      // consecutive Fibonacci ratio in all three components.
      const matrix = Float64Array.of(
        1 + 2 * weight, -weight, -weight,
        -weight, 1 + 2 * weight, -weight,
        -weight, -weight, 1 + 2 * weight,
      );
      const result = solveRealLinearSystemWithExactInverseCache(3, matrix, [expected, expected, expected]);
      expect(result.status).toBe("solved");
      if (result.status !== "solved") { throw new Error("Expected inverse solve for large history"); }
      expect(result.cacheHit).toBe(false);
      for (let index = 0; index < 3; index += 1) {
        const exact = exactRealStateValue(result.solution, index);
        expect(exact).not.toBeNull();
        if (!exact) { throw new Error("Missing exact solution"); }
        expect(compareRational(exact, expected)).toBe(0);
        assertCorrectRounding(result.solution[index]!, expected, "dense large-history solution");
      }
    }
  });
});
