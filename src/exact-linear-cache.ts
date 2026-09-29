import {
  addExactRational,
  deferExactRationalReduction,
  exactRationalToNumber,
  isExactRealLinearSolution,
  multiplyExactRational,
  numberToExactRational,
  solveExactRealLinearSystem,
  type ExactRational,
} from "./exact-linear-algebra.js";
import { exactRealStateInput, exactRealStateValue, realStateFromExact } from "./exact-numeric-state.js";

const MAX_CACHED_MATRIX_SIZE = 16;
const MAX_INVERSE_CACHE_ENTRIES = 16;
const LARGE_RATIONAL_THRESHOLD = 2n ** 1024n;
const ZERO = numberToExactRational(0)!;
const ONE = numberToExactRational(1)!;

type CachedSolveResult =
  | { status: "not-applicable" }
  | { status: "singular" }
  | { status: "solved"; solution: Float64Array; cacheHit: boolean };

const inverseCache = new Map<string, readonly ExactRational[]>();

function isLargeRational(value: ExactRational) {
  const numerator = value.numerator < 0n ? -value.numerator : value.numerator;
  return numerator >= LARGE_RATIONAL_THRESHOLD || value.denominator >= LARGE_RATIONAL_THRESHOLD;
}

function exactMatrixKey(size: number, matrix: Float64Array) {
  if (matrix.length !== size * size) { return null; }
  const entries: string[] = [String(size)];
  for (let index = 0; index < matrix.length; index += 1) {
    const value = exactRealStateValue(matrix, index);
    if (!value || value.denominator === 0n) { return null; }
    entries.push(`${value.numerator}/${value.denominator}`);
  }
  return entries.join(";");
}

function touchInverse(key: string, inverse: readonly ExactRational[]) {
  inverseCache.delete(key);
  inverseCache.set(key, inverse);
  while (inverseCache.size > MAX_INVERSE_CACHE_ENTRIES) {
    const oldest = inverseCache.keys().next().value;
    if (oldest === undefined) { break; }
    inverseCache.delete(oldest);
  }
}

function exactInverse(size: number, matrix: Float64Array): readonly ExactRational[] | null {
  const inverse = new Array<ExactRational>(size * size);
  const exactMatrix = exactRealStateInput(matrix);
  for (let column = 0; column < size; column += 1) {
    const unitVector = Array.from({ length: size }, (_, row) => row === column ? ONE : ZERO);
    const solution = solveExactRealLinearSystem(size, exactMatrix, unitVector);
    if (!solution) { return null; }
    for (let row = 0; row < size; row += 1) {
      const value = solution[row];
      if (!value) { return null; }
      inverse[row * size + column] = value;
    }
  }
  return inverse;
}

function exactMatrixVectorProduct(size: number, inverse: readonly ExactRational[], rhs: readonly ExactRational[]) {
  const solution: ExactRational[] = [];
  for (let row = 0; row < size; row += 1) {
    let sum = ZERO;
    for (let column = 0; column < size; column += 1) {
      const coefficient = inverse[row * size + column];
      const value = rhs[column];
      if (!coefficient || !value || coefficient.numerator === 0n || value.numerator === 0n) { continue; }
      sum = addExactRational(sum, multiplyExactRational(coefficient, value));
    }
    solution.push(sum);
  }
  return solution;
}

/** Solves eligible small linear systems by reusing an exact inverse for a matrix. */
export function solveRealLinearSystemWithExactInverseCache(
  size: number,
  matrix: Float64Array,
  rhs: readonly ExactRational[],
): CachedSolveResult {
  if (size <= 0 || size > MAX_CACHED_MATRIX_SIZE || rhs.length !== size ||
      !rhs.some(isLargeRational)) {
    return { status: "not-applicable" };
  }
  const key = exactMatrixKey(size, matrix);
  if (!key) { return { status: "not-applicable" }; }

  let inverse = inverseCache.get(key);
  const cacheHit = inverse !== undefined;
  if (!inverse) {
    inverse = exactInverse(size, matrix) ?? undefined;
    if (!inverse) { return { status: "singular" }; }
  }

  const deferredRhs = rhs.map((value) => isLargeRational(value)
    ? deferExactRationalReduction(value)
    : value);
  const exactSolution = exactMatrixVectorProduct(size, inverse, deferredRhs);
  // Verify cache hits too: the cache is an optimization, not an authority on
  // the current matrix. A failed certificate falls back to the checked solve.
  if (!isExactRealLinearSolution(size, exactRealStateInput(matrix), deferredRhs, exactSolution)) {
    inverseCache.delete(key);
    return { status: "not-applicable" };
  }
  if (!exactSolution.every((value) => Number.isFinite(exactRationalToNumber(value)))) {
    return { status: "singular" };
  }
  const solution = realStateFromExact(exactSolution);
  if (!solution.every(Number.isFinite)) { return { status: "singular" }; }
  touchInverse(key, inverse);
  return { status: "solved", solution, cacheHit };
}

/** Clears the private cache between isolated unit tests. */
export function clearExactLinearInverseCache() {
  inverseCache.clear();
}
