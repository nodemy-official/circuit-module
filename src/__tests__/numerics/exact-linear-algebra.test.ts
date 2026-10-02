import { describe, expect, it } from "vitest";

import {
  addExactRational,
  deferExactRationalReduction,
  divideExactRational,
  exactRationalToNumber,
  exactRationalProductToNumber,
  exactRationalSquareRootToNumber,
  multiplyExactRational,
  numberToExactRational,
  solveComplexLinearSystem,
  solveExactComplexLinearSystem,
  solveExactRealLinearSystem,
  solveRealLinearSystem,
  subtractExactRational,
  sumExactRationals,
} from "../../exact-linear-algebra.js";

describe("exact binary rational conversion", () => {
  it("recovers exact normal and subnormal binary64 inputs", () => {
    expect(numberToExactRational(1.5)).toEqual({ numerator: 3n, denominator: 2n });
    const binaryTenth = numberToExactRational(0.1);
    expect(binaryTenth).not.toBeNull();
    expect(binaryTenth).not.toEqual({ numerator: 1n, denominator: 10n });
    expect(exactRationalToNumber(binaryTenth ?? { numerator: 0n, denominator: 1n })).toBe(0.1);
    expect(numberToExactRational(Number.MIN_VALUE)).toEqual({
      numerator: 1n,
      denominator: 2n ** 1074n,
    });
    expect(numberToExactRational(2 ** -1022)).toEqual({
      numerator: 1n,
      denominator: 2n ** 1022n,
    });
    expect(numberToExactRational(Number.NaN)).toBeNull();
    expect(numberToExactRational(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds exact rational square roots at subnormal and overflow boundaries", () => {
    const minimum = numberToExactRational(Number.MIN_VALUE);
    const maximum = numberToExactRational(Number.MAX_VALUE);
    expect(minimum).not.toBeNull();
    expect(maximum).not.toBeNull();
    expect(exactRationalSquareRootToNumber(multiplyExactRational(minimum!, minimum!)))
      .toBe(Number.MIN_VALUE);
    expect(exactRationalSquareRootToNumber({ numerator: 9n, denominator: 2n ** 2150n }))
      .toBe(2 * Number.MIN_VALUE);
    expect(exactRationalSquareRootToNumber(multiplyExactRational(maximum!, maximum!)))
      .toBe(Number.MAX_VALUE);

    const overflowMidpoint = (2n ** 1024n) - (2n ** 970n);
    expect(exactRationalSquareRootToNumber({
      numerator: overflowMidpoint * overflowMidpoint,
      denominator: 1n,
    })).toBe(Number.POSITIVE_INFINITY);
  });

  it("rounds subnormal halfway cases to even", () => {
    const halfMinimum = { numerator: 1n, denominator: 2n ** 1075n };
    const oneAndHalfMinimum = { numerator: 3n, denominator: 2n ** 1075n };
    const negativeHalfMinimum = { numerator: -1n, denominator: 2n ** 1075n };

    expect(exactRationalToNumber(halfMinimum)).toBe(0);
    expect(exactRationalToNumber(oneAndHalfMinimum)).toBe(2 * Number.MIN_VALUE);
    expect(Object.is(exactRationalToNumber(negativeHalfMinimum), -0)).toBe(true);
  });

  it("rounds at the maximum finite and overflow midpoint exactly", () => {
    const maximumSignificand = 2n ** 53n - 1n;
    const maximum = { numerator: maximumSignificand * 2n ** 971n, denominator: 1n };
    const overflowMidpoint = {
      numerator: (2n ** 54n - 1n) * 2n ** 970n,
      denominator: 1n,
    };
    const belowMidpoint = {
      numerator: overflowMidpoint.numerator - 1n,
      denominator: 1n,
    };

    expect(exactRationalToNumber(maximum)).toBe(Number.MAX_VALUE);
    expect(exactRationalToNumber(belowMidpoint)).toBe(Number.MAX_VALUE);
    expect(exactRationalToNumber(overflowMidpoint)).toBe(Number.POSITIVE_INFINITY);
    expect(exactRationalToNumber({ ...overflowMidpoint, numerator: -overflowMidpoint.numerator }))
      .toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("exact rational product conversion", () => {
  it("rounds products with huge common denominators without expanding them", () => {
    const commonDenominator = 2n ** 20_000n + 1n;
    const left = deferExactRationalReduction({
      numerator: commonDenominator + 1n,
      denominator: commonDenominator,
    });
    const right = deferExactRationalReduction({
      numerator: commonDenominator + 2n,
      denominator: commonDenominator,
    });

    expect(exactRationalProductToNumber(left, right)).toBe(1);
  });

  it("rounds exact halfway products to even", () => {
    const one = { numerator: 1n, denominator: 1n };
    const lowerMidpoint = { numerator: 2n ** 53n + 1n, denominator: 2n ** 53n };
    const upperMidpoint = { numerator: 2n ** 53n + 3n, denominator: 2n ** 53n };

    expect(exactRationalProductToNumber(one, lowerMidpoint)).toBe(1);
    expect(exactRationalProductToNumber(one, upperMidpoint)).toBe(1 + 2 ** -51);
  });

  it("preserves signs at underflow and overflow boundaries", () => {
    const halfMinimumProductLeft = { numerator: 1n, denominator: 2n ** 537n };
    const halfMinimumProductRight = { numerator: -1n, denominator: 2n ** 538n };
    const maximum = numberToExactRational(Number.MAX_VALUE);
    const two = numberToExactRational(2);

    expect(maximum).not.toBeNull();
    expect(two).not.toBeNull();
    expect(exactRationalProductToNumber(halfMinimumProductLeft, halfMinimumProductRight)).toBe(-0);
    expect(Object.is(
      exactRationalProductToNumber(halfMinimumProductLeft, { ...halfMinimumProductRight, numerator: 1n }),
      0,
    )).toBe(true);
    expect(exactRationalProductToNumber(maximum!, two!)).toBe(Number.POSITIVE_INFINITY);
    expect(exactRationalProductToNumber(
      { ...maximum!, numerator: -maximum!.numerator },
      two!,
    )).toBe(Number.NEGATIVE_INFINITY);
  });

  it("falls back for subnormal estimates and preserves invalid-denominator behavior", () => {
    const minimumSubnormal = numberToExactRational(Number.MIN_VALUE);

    expect(minimumSubnormal).not.toBeNull();
    expect(exactRationalProductToNumber(minimumSubnormal!, { numerator: -1n, denominator: 1n }))
      .toBe(-Number.MIN_VALUE);
    expect(() => exactRationalProductToNumber(
      { numerator: 0n, denominator: 1n },
      { numerator: 1n, denominator: 0n },
    )).toThrow(RangeError);
  });
});

describe("exact real linear solver", () => {
  it("solves a nearly singular system whose exact determinant is one", () => {
    const scale = 2 ** 52;
    const matrix = new Float64Array([scale, scale - 1, scale + 1, scale]);
    const rhs = new Float64Array([2 * scale, 2 * scale + 2]);

    const exact = solveExactRealLinearSystem(2, matrix, rhs);
    const rounded = solveRealLinearSystem(2, matrix, rhs);

    expect(exact).toEqual([
      { numerator: 2n, denominator: 1n },
      { numerator: 0n, denominator: 1n },
    ]);
    expect(rounded).toEqual(new Float64Array([2, 0]));
  });

  it("preserves exact solutions when Bareiss elimination swaps a later pivot row", () => {
    const exact = solveExactRealLinearSystem(
      3,
      new Float64Array([2, 1, 0, 4, 2, 1, 0, 3, 2]),
      new Float64Array([4, 11, 12]),
    );

    expect(exact).toEqual([
      { numerator: 1n, denominator: 1n },
      { numerator: 2n, denominator: 1n },
      { numerator: 3n, denominator: 1n },
    ]);
  });

  it("preserves a solution when both matrix coefficient and excitation are subnormal", () => {
    const exact = solveExactRealLinearSystem(
      1,
      new Float64Array([Number.MIN_VALUE]),
      new Float64Array([Number.MIN_VALUE]),
    );

    expect(exact).toEqual([{ numerator: 1n, denominator: 1n }]);
  });

  it("accepts an exact RHS below binary64 range without rounding it to zero", () => {
    const exactRhs = [{ numerator: -1n, denominator: -(4n * 2n ** 1074n) }];
    const matrix = new Float64Array([Number.MIN_VALUE]);

    expect(solveExactRealLinearSystem(1, matrix, exactRhs)).toEqual([
      { numerator: 1n, denominator: 4n },
    ]);
    expect(solveRealLinearSystem(1, matrix, exactRhs)).toEqual(new Float64Array([0.25]));
    expect(solveExactRealLinearSystem(1, matrix, [{ numerator: 1n, denominator: 0n }])).toBeNull();
  });

  it("accepts exact matrix coefficients below binary64 range", () => {
    const exactMatrix = [{ numerator: 1n, denominator: 2n ** 1075n }];
    const exactRhs = [{ numerator: 1n, denominator: 2n ** 1076n }];

    expect(solveExactRealLinearSystem(1, exactMatrix, exactRhs)).toEqual([
      { numerator: 1n, denominator: 2n },
    ]);
    expect(solveRealLinearSystem(1, exactMatrix, exactRhs)).toEqual(new Float64Array([0.5]));
  });

  it("keeps large exact RHS denominators out of Bareiss matrix pivots", () => {
    const exactSolution = [
      { numerator: 1n, denominator: 2n ** 1600n },
      { numerator: 1n, denominator: 3n ** 800n },
    ];
    const twiceFirst = multiplyExactRational({ numerator: 2n, denominator: 1n }, exactSolution[0]!);
    const fourTimesSecond = multiplyExactRational({ numerator: 4n, denominator: 1n }, exactSolution[1]!);
    const sixTimesFirst = multiplyExactRational({ numerator: 6n, denominator: 1n }, exactSolution[0]!);
    const eightTimesSecond = multiplyExactRational({ numerator: 8n, denominator: 1n }, exactSolution[1]!);
    const rhs = [
      addExactRational(twiceFirst, fourTimesSecond),
      addExactRational(sixTimesFirst, eightTimesSecond),
    ];

    expect(solveExactRealLinearSystem(2, new Float64Array([2, 4, 6, 8]), rhs)).toEqual(exactSolution);
  });

  it("returns exact answers outside binary64 range and rejects only the rounded wrapper", () => {
    const exact = solveExactRealLinearSystem(
      1,
      new Float64Array([Number.MIN_VALUE]),
      new Float64Array([1]),
    );

    expect(exact).not.toBeNull();
    const value = exact?.[0];
    expect(value).toBeDefined();
    expect(exactRationalToNumber(value ?? { numerator: 0n, denominator: 1n }))
      .toBe(Number.POSITIVE_INFINITY);
    expect(solveRealLinearSystem(1, new Float64Array([Number.MIN_VALUE]), new Float64Array([1])))
      .toBeNull();
  });

  it("returns null for singular and nonfinite systems", () => {
    expect(solveExactRealLinearSystem(
      2,
      new Float64Array([1, 2, 2, 4]),
      new Float64Array([1, 2]),
    )).toBeNull();
    expect(solveExactRealLinearSystem(
      1,
      new Float64Array([Number.POSITIVE_INFINITY]),
      new Float64Array([1]),
    )).toBeNull();
  });

  it("solves a sparse system at the 512-variable limit", () => {
    const size = 512;
    const matrix = new Float64Array(size * size);
    const rhs = new Float64Array(size);
    for (let index = 0; index < size; index += 1) {
      matrix[index * size + index] = index + 1;
      rhs[index] = index + 1;
    }

    const exact = solveExactRealLinearSystem(size, matrix, rhs);

    expect(exact).not.toBeNull();
    expect(exact?.every((value) => value.numerator === 1n && value.denominator === 1n)).toBe(true);
  });
});

describe("exact rational identity shortcuts", () => {
  it("preserves exact immutable deferred rationals through arithmetic", () => {
    const source = { numerator: 6n, denominator: 15n };
    const deferred = deferExactRationalReduction(source);
    const coefficient = numberToExactRational(1.5);

    expect(deferred).toEqual({ numerator: 6n, denominator: 15n });
    expect(Object.isFrozen(deferred)).toBe(true);
    expect(Reflect.set(deferred, "numerator", 12n)).toBe(false);
    source.numerator = 12n;
    expect(deferred.numerator).toBe(6n);

    expect(addExactRational(deferred, { numerator: 1n, denominator: 3n })).toEqual({
      numerator: 11n,
      denominator: 15n,
    });
    expect(subtractExactRational(deferred, { numerator: 1n, denominator: 3n })).toEqual({
      numerator: 1n,
      denominator: 15n,
    });
    expect(multiplyExactRational(deferred, coefficient!)).toEqual({
      numerator: 3n,
      denominator: 5n,
    });
    expect(divideExactRational(deferred, coefficient!)).toEqual({
      numerator: 4n,
      denominator: 15n,
    });
    expect(sumExactRationals([deferred, { numerator: 1n, denominator: 5n }])).toEqual({
      numerator: 9n,
      denominator: 15n,
    });
    expect(exactRationalToNumber(deferred)).toBe(0.4);
  });

  it("does not cache number conversions for mutable rational objects", () => {
    const value = { numerator: 1n, denominator: 2n };

    expect(exactRationalToNumber(value)).toBe(0.5);
    value.numerator = 3n;
    expect(exactRationalToNumber(value)).toBe(1.5);
  });

  it("multiplies canonical values with equal denominators directly", () => {
    const left = numberToExactRational(0.5);
    const right = numberToExactRational(1.5);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const product = multiplyExactRational(left!, right!);

    expect(product).toEqual({ numerator: 3n, denominator: 4n });
    expect(Object.isFrozen(product)).toBe(true);
  });

  it("multiplies canonical values with a huge shared denominator without large cross-gcds", () => {
    const commonDenominator = 2n ** 20_000n + 1n;
    const left = divideExactRational(
      { numerator: commonDenominator + 2n, denominator: 1n },
      { numerator: 3n * commonDenominator, denominator: 1n },
    );
    const right = divideExactRational(
      { numerator: commonDenominator + 4n, denominator: 1n },
      { numerator: 5n * commonDenominator, denominator: 1n },
    );

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const product = multiplyExactRational(left!, right!);

    expect(product).toEqual({
      numerator: ((commonDenominator + 2n) * (commonDenominator + 4n)) / 3n,
      denominator: 5n * commonDenominator * commonDenominator,
    });
    expect(Object.isFrozen(product)).toBe(true);
  });

  it("keeps public results canonical when simplifying zero and one", () => {
    const nonReduced = { numerator: 2n, denominator: 4n };
    const zero = { numerator: 0n, denominator: 1n };
    const one = { numerator: 1n, denominator: 1n };

    expect(addExactRational(zero, nonReduced)).toEqual({ numerator: 1n, denominator: 2n });
    expect(multiplyExactRational(one, nonReduced)).toEqual({ numerator: 1n, denominator: 2n });
    expect(divideExactRational(nonReduced, one)).toEqual({ numerator: 1n, denominator: 2n });
  });

  it("cross-cancels division while canonicalizing non-reduced signed inputs", () => {
    expect(divideExactRational(
      { numerator: 6n, denominator: 35n },
      { numerator: -9n, denominator: 14n },
    )).toEqual({ numerator: -4n, denominator: 15n });
    expect(divideExactRational(
      { numerator: 2n, denominator: 4n },
      { numerator: 3n, denominator: 2n },
    )).toEqual({ numerator: 1n, denominator: 3n });
  });

  it("freezes shared zero and canonical values against mutation", () => {
    const zero = multiplyExactRational(
      { numerator: 0n, denominator: 1n },
      { numerator: 7n, denominator: 3n },
    );
    const canonical = numberToExactRational(0.5);
    const one = { numerator: 1n, denominator: 1n };
    const identityProduct = canonical && multiplyExactRational(one, canonical);

    expect(Object.isFrozen(zero)).toBe(true);
    expect(Reflect.set(zero, "numerator", 2n)).toBe(false);
    expect(addExactRational(zero, zero)).toEqual({ numerator: 0n, denominator: 1n });
    expect(identityProduct).toBe(canonical);
    expect(identityProduct && Object.isFrozen(identityProduct)).toBe(true);
  });
});

describe("exact rational summation", () => {
  it("reduces only the completed sum and canonicalizes signed inputs", () => {
    expect(sumExactRationals([])).toEqual({ numerator: 0n, denominator: 1n });
    expect(sumExactRationals([
      { numerator: 1n, denominator: 3n },
      { numerator: 1n, denominator: 6n },
      { numerator: -1n, denominator: 2n },
    ])).toEqual({ numerator: 0n, denominator: 1n });
    expect(sumExactRationals([
      { numerator: 2n, denominator: 4n },
      { numerator: 1n, denominator: 6n },
    ])).toEqual({ numerator: 2n, denominator: 3n });
    expect(sumExactRationals([
      { numerator: 3n, denominator: -6n },
      { numerator: 1n, denominator: 3n },
    ])).toEqual({ numerator: -1n, denominator: 6n });
    expect(() => sumExactRationals([{ numerator: 1n, denominator: 0n }]))
      .toThrow(RangeError);
  });
});

describe("exact complex linear solver", () => {
  it("solves complex equations exactly before returning the rounded phasor", () => {
    const exact = solveExactComplexLinearSystem(
      1,
      new Float64Array([1]),
      new Float64Array([1]),
      new Float64Array([-1]),
      new Float64Array([3]),
    );
    const rounded = solveComplexLinearSystem(
      1,
      new Float64Array([1]),
      new Float64Array([1]),
      new Float64Array([-1]),
      new Float64Array([3]),
    );

    expect(exact).toEqual([{
      real: { numerator: 1n, denominator: 1n },
      imaginary: { numerator: 2n, denominator: 1n },
    }]);
    expect(rounded).toEqual([{ real: 1, imaginary: 2 }]);
  });

  it("preserves exact cancellation before complex output rounding", () => {
    const exact = solveExactComplexLinearSystem(
      1,
      new Float64Array([1]),
      new Float64Array([0]),
      new Float64Array([Number.MIN_VALUE]),
      new Float64Array([Number.MIN_VALUE]),
    );

    expect(exact).toEqual([{
      real: { numerator: 1n, denominator: 2n ** 1074n },
      imaginary: { numerator: 1n, denominator: 2n ** 1074n },
    }]);
  });

  it("preserves exact complex matrix and RHS components below binary64 range", () => {
    const exactMatrix = [{ numerator: 1n, denominator: 2n ** 1075n }];
    const exactRhs = [{ numerator: 1n, denominator: 2n ** 1076n }];
    const exact = solveExactComplexLinearSystem(
      1,
      exactMatrix,
      [{ numerator: 0n, denominator: 1n }],
      exactRhs,
      exactRhs,
    );
    const rounded = solveComplexLinearSystem(
      1,
      exactMatrix,
      [{ numerator: 0n, denominator: 1n }],
      exactRhs,
      exactRhs,
    );

    expect(exact).toEqual([{
      real: { numerator: 1n, denominator: 2n },
      imaginary: { numerator: 1n, denominator: 2n },
    }]);
    expect(rounded).toEqual([{ real: 0.5, imaginary: 0.5 }]);
  });
});
