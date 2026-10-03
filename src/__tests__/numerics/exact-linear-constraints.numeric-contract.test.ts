import { describe, expect, it } from "vitest";

import {
  deferExactRationalReduction,
  solveExactRealLinearConstraints,
} from "../../exact-linear-algebra.js";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  type Rational,
} from "../helpers/numeric-oracle.js";

function dotProduct(row: ReadonlyMap<number, Rational>, values: readonly Rational[]) {
  let sum = rational(0n);
  for (const [column, coefficient] of row) {
    sum = addRational(sum, multiplyRational(coefficient, values[column]!));
  }
  return sum;
}

function expectSolution(
  variableCount: number,
  rows: readonly ReadonlyMap<number, Rational>[],
  rhs: readonly Rational[],
  expected: readonly Rational[],
) {
  const actual = solveExactRealLinearConstraints(variableCount, rows, rhs);
  if (!actual || actual.length !== variableCount) {
    throw new Error("Consistent constraints must have a solution of the requested size");
  }
  for (let column = 0; column < variableCount; column += 1) {
    if (compareRational(actual[column]!, expected[column]!) !== 0 || actual[column]!.denominator <= 0n) {
      throw new Error(`Unexpected exact solution at column ${column}`);
    }
  }
  // This oracle uses only the test helper's BigInt arithmetic, independently
  // checking every original row as well as the chosen particular solution.
  for (let index = 0; index < rows.length; index += 1) {
    if (compareRational(dotProduct(rows[index]!, actual), rhs[index]!) !== 0) {
      throw new Error(`Exact constraint ${index} is not satisfied`);
    }
  }
}

describe("exact sparse linear constraints numeric contract", () => {
  it("solves overdetermined constraints with redundant and zero rows", () => {
    const rows = [
      new Map([[1, rational(3n, 2n)]]),
      new Map([[0, rational(2n, 5n)], [1, rational(-1n, 7n)]]),
      new Map([[0, rational(4n, 5n)], [1, rational(-2n, 7n)]]),
      new Map<number, Rational>(),
      new Map([[0, rational(6n, 5n)], [1, rational(15n, 14n)]]),
    ];
    const expected = [rational(3n, 5n), rational(-2n, 7n)];
    const rhs = rows.map((row) => dotProduct(row, expected));

    expectSolution(2, rows, rhs, expected);
  });

  it("sets leading, internal and trailing free columns to zero", () => {
    const rows = [
      new Map<number, Rational>(),
      new Map([[3, rational(2n)], [1, rational(1n)], [2, rational(5n)], [4, rational(4n)]]),
      new Map([[1, rational(3n)], [2, rational(15n)], [3, rational(8n)], [4, rational(13n)]]),
    ];

    expectSolution(
      5, rows, [rational(0n), rational(7n), rational(23n)],
      [rational(0n), rational(5n), rational(0n), rational(1n), rational(0n)],
    );
  });

  it.each([false, true])("prioritizes columns over row and Map insertion order (reverse=%s)", (reverse) => {
    const rows = [
      new Map([[2, rational(1n)], [1, rational(1n)]]),
      new Map([[2, rational(1n)], [0, rational(1n)]]),
    ];
    const rhs = [rational(3n), rational(4n)];

    expectSolution(
      3, reverse ? rows.toReversed() : rows, reverse ? rhs.toReversed() : rhs,
      [rational(4n), rational(3n), rational(0n)],
    );
  });

  it("returns a particular solution for a singular square system", () => {
    expectSolution(2, [
      new Map([[1, rational(2n)], [0, rational(1n)]]),
      new Map([[0, rational(2n)], [1, rational(4n)]]),
    ], [rational(3n), rational(6n)], [rational(3n), rational(0n)]);
  });

  it("returns all zeros for no constraints or all-zero constraints", () => {
    const expected = [rational(0n), rational(0n), rational(0n)];
    expectSolution(3, [], [], expected);
    expectSolution(3, [
      new Map(),
      new Map([[2, { numerator: 0n, denominator: -7n }]]),
    ], [rational(0n), rational(0n)], expected);
  });

  it("handles zero-dimensional consistent and inconsistent systems", () => {
    expectSolution(0, [], [], []);
    expectSolution(0, [new Map(), new Map()], [rational(0n), { numerator: 0n, denominator: -9n }], []);
    expect(solveExactRealLinearConstraints(0, [new Map()], [rational(1n, 2n ** 2200n)]))
      .toBeNull();
    expect(solveExactRealLinearConstraints(0, [new Map([[0, rational(0n)]])], [rational(0n)]))
      .toBeNull();
  });

  it("rejects contradictory zero rows, including explicit zero coefficients", () => {
    for (const row of [new Map(), new Map([[0, rational(0n)]])]) {
      expect(solveExactRealLinearConstraints(2, [row], [rational(1n, 2n ** 2200n)]))
        .toBeNull();
    }
  });

  it("rejects a contradiction after elimination in a rank-deficient system", () => {
    expect(solveExactRealLinearConstraints(3, [
      new Map([[2, rational(2n)], [1, rational(1n)]]),
      new Map([[1, rational(3n)], [2, rational(6n)]]),
    ], [rational(7n), rational(22n)])).toBeNull();
  });

  it("checks excess rows even after every variable has a pivot", () => {
    const tiny = rational(1n, 2n ** 2200n);
    expect(solveExactRealLinearConstraints(2, [
      new Map([[0, rational(1n)]]),
      new Map([[1, rational(1n)]]),
      new Map([[0, rational(1n)], [1, rational(1n)]]),
    ], [rational(1n), rational(2n), addRational(rational(3n), tiny)])).toBeNull();
  });

  it("keeps a pivot smaller than binary64 underflow after near cancellation", () => {
    const tiny = rational(1n, 2n ** 2200n);
    expectSolution(2, [
      new Map([[0, rational(1n)], [1, rational(1n)]]),
      new Map([[0, rational(1n)], [1, addRational(rational(1n), tiny)]]),
    ], [rational(2n), addRational(rational(2n), tiny)], [rational(1n), rational(1n)]);
  });

  it.each([false, true])("preserves large rationals and exponent differences (deferred=%s)", (deferred) => {
    const scale = 2n ** 4096n;
    const huge = rational(scale);
    const tiny = rational(1n, scale);
    const mixed = addRational(huge, tiny);
    const rows = [
      new Map([[0, huge], [1, tiny]]),
      new Map([[0, tiny], [1, huge]]),
      new Map([[0, mixed], [1, mixed]]),
    ];
    const expected = [rational(scale + 1n, 3n), rational(-7n, scale + 5n)];
    const rhs = rows.map((row) => dotProduct(row, expected));
    const inputRows = deferred ? rows.map((row) => new Map(
      [...row].map(([column, coefficient]) => [column, deferExactRationalReduction(coefficient)]),
    )) : rows;
    const inputRhs = deferred ? rhs.map(deferExactRationalReduction) : rhs;

    expectSolution(2, inputRows, inputRhs, expected);
  });

  it("verifies exact cancellation of products beyond binary64 overflow", () => {
    const huge = rational(2n ** 2048n);
    const negativeHuge = rational(-(2n ** 2048n));
    expectSolution(2, [
      new Map([[0, huge], [1, huge]]),
      new Map([[1, rational(1n)]]),
    ], [rational(0n), negativeHuge], [huge, negativeHuge]);
  });

  it("normalizes negative denominators and unreduced fractions", () => {
    expectSolution(2, [
      new Map([[0, { numerator: -6n, denominator: -3n }], [1, { numerator: 0n, denominator: -5n }]]),
      new Map([[0, { numerator: 2n, denominator: -4n }]]),
    ], [{ numerator: 14n, denominator: -7n }, { numerator: -3n, denominator: -6n }],
    [rational(-1n), rational(0n)]);
  });

  it.each([false, true])("does not mutate input arrays, Maps or rational objects (inconsistent=%s)", (inconsistent) => {
    const coefficient = Object.freeze({ numerator: 6n, denominator: -3n });
    const rows = Object.freeze([
      new Map([[1, rational(1n)]]),
      new Map([[1, rational(2n)], [0, coefficient]]),
      new Map([[0, rational(-4n)], [1, rational(4n)]]),
    ]);
    const rhs = Object.freeze([
      Object.freeze({ numerator: 6n, denominator: 3n }),
      Object.freeze({ numerator: 2n, denominator: -1n }),
      Object.freeze({ numerator: inconsistent ? -5n : -4n, denominator: 1n }),
    ]);
    const rowSnapshots = rows.map((row) => [...row].map(([column, value]) => [column, { ...value }]));
    const rhsSnapshot = rhs.map((value) => ({ ...value }));

    if (inconsistent) {
      expect(solveExactRealLinearConstraints(2, rows, rhs)).toBeNull();
    } else {
      expectSolution(2, rows, rhs, [rational(3n), rational(2n)]);
    }

    expect(rows.map((row) => [...row])).toEqual(rowSnapshots);
    expect(rhs).toEqual(rhsSnapshot);
    expect(rows[1]!.get(0)).toBe(coefficient);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    2 ** 32, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])("rejects invalid variable count %s", (size) => {
    expect(solveExactRealLinearConstraints(size, [], [])).toBeNull();
  });

  it("rejects mismatched row and RHS lengths and missing array entries", () => {
    expect(solveExactRealLinearConstraints(1, [new Map()], [])).toBeNull();
    expect(solveExactRealLinearConstraints(1, [], [rational(0n)])).toBeNull();
    expect(solveExactRealLinearConstraints(0, [], [rational(0n)])).toBeNull();
    expect(solveExactRealLinearConstraints(1, new Array<ReadonlyMap<number, Rational>>(1), [rational(0n)]))
      .toBeNull();
    expect(solveExactRealLinearConstraints(1, [new Map()], new Array<Rational>(1))).toBeNull();
  });

  it.each([-1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER, "0", 0n])("rejects invalid columns even with zero coefficients: %s", (column) => {
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [
      1, [new Map([[column, rational(0n)]])], [rational(0n)],
    ])).toBeNull();
  });

  it.each([
    { numerator: 1n, denominator: 0n },
    { numerator: 0n, denominator: 0n },
    { numerator: 1, denominator: 1n },
    { numerator: 1n, denominator: 1 },
    { numerator: Number.NaN, denominator: 1n },
    { numerator: 1n },
    { denominator: 1n },
    null,
    undefined,
    0,
    "1",
  ])("rejects malformed coefficients and RHS rationals: %s", (value) => {
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [
      1, [new Map([[0, value]])], [rational(0n)],
    ])).toBeNull();
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [
      1, [new Map([[0, rational(1n)]])], [value],
    ])).toBeNull();
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [
      0, [new Map()], [value],
    ])).toBeNull();
  });

  it.each([null, undefined, {}, 1, "row", []])("rejects malformed row containers: %s", (row) => {
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [1, [row], [rational(0n)]]))
      .toBeNull();
  });

  it.each([null, undefined, {}, 1, "array"])("rejects malformed row and RHS arrays: %s", (value) => {
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [0, value, []])).toBeNull();
    expect(Reflect.apply(solveExactRealLinearConstraints, undefined, [0, [], value])).toBeNull();
  });
});
