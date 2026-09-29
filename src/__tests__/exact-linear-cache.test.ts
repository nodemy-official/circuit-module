import { describe, expect, it } from "vitest";

import {
  clearExactLinearInverseCache,
  solveRealLinearSystemWithExactInverseCache,
} from "../exact-linear-cache.js";
import {
  divideExactRational,
  exactRationalToNumber,
  numberToExactRational,
} from "../exact-linear-algebra.js";
import { exactRealStateValue } from "../exact-numeric-state.js";

function rationalEquivalent(
  actual: ReturnType<typeof exactRealStateValue>,
  expected: NonNullable<ReturnType<typeof exactRealStateValue>>,
) {
  return actual !== null &&
    actual.numerator * expected.denominator === expected.numerator * actual.denominator;
}

describe("exact linear inverse cache", () => {
  it("reuses an exact inverse across changing right sides and keeps underflowed results exact", () => {
    clearExactLinearInverseCache();
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    const twiceMinimum = numberToExactRational(Number.MIN_VALUE * 2)!;
    const two = numberToExactRational(2)!;
    const four = numberToExactRational(4)!;

    const first = solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [minimum]);
    expect(first.status).toBe("solved");
    if (first.status !== "solved") { return; }
    expect(first.cacheHit).toBe(false);
    expect(first.solution[0]).toBe(0);
    const firstExact = exactRealStateValue(first.solution, 0);
    const expectedUnderflow = divideExactRational(minimum, two)!;
    expect(rationalEquivalent(firstExact, expectedUnderflow)).toBe(true);

    const reused = solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(2), [twiceMinimum]);
    expect(reused.status).toBe("solved");
    if (reused.status !== "solved") { return; }
    expect(reused.cacheHit).toBe(true);
    expect(reused.solution[0]).toBe(Number.MIN_VALUE);

    const changedMatrix = solveRealLinearSystemWithExactInverseCache(1, Float64Array.of(4), [twiceMinimum]);
    expect(changedMatrix.status).toBe("solved");
    if (changedMatrix.status !== "solved") { return; }
    expect(changedMatrix.cacheHit).toBe(false);
    expect(changedMatrix.solution[0]).toBe(0);
    const changedExact = exactRealStateValue(changedMatrix.solution, 0);
    const changedExpected = divideExactRational(twiceMinimum, four)!;
    expect(rationalEquivalent(changedExact, changedExpected)).toBe(true);
    clearExactLinearInverseCache();
  });

  it("uses an exact inverse even when its entries overflow binary64", () => {
    clearExactLinearInverseCache();
    const minimum = numberToExactRational(Number.MIN_VALUE)!;
    const finiteRhs = numberToExactRational(1e-308)!;
    const expected = divideExactRational(finiteRhs, minimum)!;

    const solved = solveRealLinearSystemWithExactInverseCache(
      1,
      Float64Array.of(Number.MIN_VALUE),
      [finiteRhs],
    );
    expect(solved.status).toBe("solved");
    if (solved.status !== "solved") { return; }
    expect(solved.cacheHit).toBe(false);
    expect(solved.solution[0]).toBe(exactRationalToNumber(expected));
    const exact = exactRealStateValue(solved.solution, 0);
    expect(rationalEquivalent(exact, expected)).toBe(true);
    clearExactLinearInverseCache();
  });
});
