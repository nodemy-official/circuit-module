import { describe, expect, it } from "vitest";

import {
  deferExactRationalReduction,
  solveExactComplexLinearSystem,
  solveExactRealLinearSystem,
} from "../../exact-linear-algebra.js";
import {
  addRational,
  compareRational,
  createSeededRandom,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
} from "../helpers/numeric-oracle.js";

function powerOfTwo(exponent: number) {
  return exponent < 0
    ? rational(1n, 2n ** BigInt(-exponent))
    : rational(2n ** BigInt(exponent));
}

function generatedSystem(seed: bigint, sparse: boolean) {
  const next = createSeededRandom(seed);
  const size = sparse ? 16 : 3 + Number(next() % 5n);
  const matrix: Rational[][] = [];
  const scales = [-1200, -530, 0, 530, 1200];
  for (let row = 0; row < size; row += 1) {
    let offDiagonalMagnitude = 0n;
    const values = Array.from({ length: size }, (_, column) => {
      if (row === column || (sparse && Math.abs(row - column) !== 1)) {
        return rational(0n);
      }
      const numerator = next() % 7n - 3n;
      offDiagonalMagnitude += numerator < 0n ? -numerator : numerator;
      return rational(numerator);
    });
    // Strict row diagonal dominance proves nonsingularity before the row
    // scaling and permutation, independently of the production solver.
    values[row] = rational(offDiagonalMagnitude + 1n);
    const scale = multiplyRational(
      powerOfTwo(scales[Number(next() % BigInt(scales.length))]!),
      rational(next() % 2n === 0n ? 1n : -1n, next() % 17n + 1n),
    );
    matrix.push(values.map((value) => multiplyRational(value, scale)));
  }
  matrix.reverse();
  const solution = Array.from({ length: size }, () => multiplyRational(
    rational(next() % 23n - 11n, next() % 19n + 1n),
    powerOfTwo(scales[Number(next() % BigInt(scales.length))]!),
  ));
  return { size, matrix, solution };
}

function dotProduct(row: readonly Rational[], values: readonly Rational[]) {
  return row.reduce((sum, value, index) => addRational(
    sum,
    multiplyRational(value, values[index]!),
  ), rational(0n));
}

describe("generated exact linear systems with independent planted solutions", () => {
  it.each([false, true])("recovers scaled and permuted real systems (sparse=%s)", (sparse) => {
    for (let seed = 1n; seed <= 24n; seed += 1n) {
      const { size, matrix, solution } = generatedSystem(seed, sparse);
      const rhs = matrix.map((row) => dotProduct(row, solution));
      // Deferred input exercises the long-transient arithmetic path too.
      const inputRhs = seed % 2n === 0n ? rhs.map(deferExactRationalReduction) : rhs;
      const actual = solveExactRealLinearSystem(size, matrix.flat(), inputRhs);
      expect(actual, `seed=${String(seed)}, sparse=${String(sparse)}`).not.toBeNull();
      for (let index = 0; index < size; index += 1) {
        expect(compareRational(actual![index]!, solution[index]!)).toBe(0);
      }
    }
  });

  it.each([false, true])("recovers exact complex solutions across realification (sparse=%s)", (sparse) => {
    for (let seed = 25n; seed <= 40n; seed += 1n) {
      const { size, matrix, solution } = generatedSystem(seed, sparse);
      const imaginarySolution = solution.toReversed();
      // Multiplying each real row by a nonzero complex scalar preserves
      // invertibility and produces independent real/imaginary RHS oracles.
      const imaginaryMatrix = matrix.map((row, index) => row.map((value) => multiplyRational(
        value,
        rational(BigInt(index % 7 - 3), BigInt(index + 1)),
      )));
      const rhsReal = matrix.map((row, index) => subtractRational(
        dotProduct(row, solution),
        dotProduct(imaginaryMatrix[index]!, imaginarySolution),
      ));
      const rhsImaginary = matrix.map((row, index) => addRational(
        dotProduct(row, imaginarySolution),
        dotProduct(imaginaryMatrix[index]!, solution),
      ));
      const actual = solveExactComplexLinearSystem(
        size, matrix.flat(), imaginaryMatrix.flat(), rhsReal, rhsImaginary,
      );
      expect(actual, `seed=${String(seed)}, sparse=${String(sparse)}`).not.toBeNull();
      for (let index = 0; index < size; index += 1) {
        expect(compareRational(actual![index]!.real, solution[index]!)).toBe(0);
        expect(compareRational(actual![index]!.imaginary, imaginarySolution[index]!)).toBe(0);
      }
    }
  });
});
