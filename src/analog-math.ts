/** A complex number represented as its rectangular components. */
export interface ComplexValue {
  real: number;
  imaginary: number;
}

export const complex = (real = 0, imaginary = 0): ComplexValue => ({ real, imaginary });

export const complexAdd = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

export const complexSubtract = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real - right.real,
  imaginary: left.imaginary - right.imaginary,
});

export const complexMultiply = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real * right.real - left.imaginary * right.imaginary,
  imaginary: left.real * right.imaginary + left.imaginary * right.real,
});

export const complexDivide = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const denominator = right.real * right.real + right.imaginary * right.imaginary;
  return {
    real: (left.real * right.real + left.imaginary * right.imaginary) / denominator,
    imaginary: (left.imaginary * right.real - left.real * right.imaginary) / denominator,
  };
};

export const complexConjugate = (value: ComplexValue): ComplexValue => ({
  real: value.real,
  imaginary: -value.imaginary,
});

export const complexMagnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);

export const complexPhaseRadians = (value: ComplexValue) => Math.atan2(value.imaginary, value.real);

function complexPivotRow(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  column: number,
) {
  let pivot = column;
  let pivotMagnitude = 0;
  for (let row = column; row < size; row += 1) {
    const index = row * size + column;
    const magnitude = Math.hypot(matrixReal[index] ?? 0, matrixImaginary[index] ?? 0);
    if (magnitude > pivotMagnitude) {
      pivot = row;
      pivotMagnitude = magnitude;
    }
  }
  return { pivot, magnitude: pivotMagnitude };
}

function swapComplexRows(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
  firstRow: number,
  secondRow: number,
) {
  for (let column = 0; column < size; column += 1) {
    const first = firstRow * size + column;
    const second = secondRow * size + column;
    [matrixReal[first], matrixReal[second]] = [matrixReal[second] ?? 0, matrixReal[first] ?? 0];
    [matrixImaginary[first], matrixImaginary[second]] = [
      matrixImaginary[second] ?? 0,
      matrixImaginary[first] ?? 0,
    ];
  }
  [rhsReal[firstRow], rhsReal[secondRow]] = [rhsReal[secondRow] ?? 0, rhsReal[firstRow] ?? 0];
  [rhsImaginary[firstRow], rhsImaginary[secondRow]] = [
    rhsImaginary[secondRow] ?? 0,
    rhsImaginary[firstRow] ?? 0,
  ];
}

function eliminateComplexRow(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
  pivotColumn: number,
  row: number,
) {
  const pivotIndex = pivotColumn * size + pivotColumn;
  const rowLead = row * size + pivotColumn;
  const leadReal = matrixReal[pivotIndex] ?? 0;
  const leadImaginary = matrixImaginary[pivotIndex] ?? 0;
  const leadMagnitudeSquared = leadReal * leadReal + leadImaginary * leadImaginary;
  const valueReal = matrixReal[rowLead] ?? 0;
  const valueImaginary = matrixImaginary[rowLead] ?? 0;
  const factorReal = (valueReal * leadReal + valueImaginary * leadImaginary) / leadMagnitudeSquared;
  const factorImaginary = (valueImaginary * leadReal - valueReal * leadImaginary) / leadMagnitudeSquared;

  for (let column = pivotColumn + 1; column < size; column += 1) {
    const index = row * size + column;
    const pivotCell = pivotColumn * size + column;
    const cellReal = matrixReal[index] ?? 0;
    const cellImaginary = matrixImaginary[index] ?? 0;
    const coefficientReal = matrixReal[pivotCell] ?? 0;
    const coefficientImaginary = matrixImaginary[pivotCell] ?? 0;
    matrixReal[index] =
      cellReal - (factorReal * coefficientReal - factorImaginary * coefficientImaginary);
    matrixImaginary[index] =
      cellImaginary - (factorReal * coefficientImaginary + factorImaginary * coefficientReal);
  }
  matrixReal[rowLead] = 0;
  matrixImaginary[rowLead] = 0;
  const rowRhsReal = rhsReal[row] ?? 0;
  const rowRhsImaginary = rhsImaginary[row] ?? 0;
  const pivotRhsReal = rhsReal[pivotColumn] ?? 0;
  const pivotRhsImaginary = rhsImaginary[pivotColumn] ?? 0;
  rhsReal[row] = rowRhsReal - (factorReal * pivotRhsReal - factorImaginary * pivotRhsImaginary);
  rhsImaginary[row] =
    rowRhsImaginary - (factorReal * pivotRhsImaginary + factorImaginary * pivotRhsReal);
}

function backSubstituteComplex(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
) {
  const solution = Array.from({ length: size }, () => complex());
  for (let row = size - 1; row >= 0; row -= 1) {
    let sumReal = rhsReal[row] ?? 0;
    let sumImaginary = rhsImaginary[row] ?? 0;
    for (let column = row + 1; column < size; column += 1) {
      const index = row * size + column;
      const coefficientReal = matrixReal[index] ?? 0;
      const coefficientImaginary = matrixImaginary[index] ?? 0;
      const value = solution[column] ?? complex();
      sumReal -= coefficientReal * value.real - coefficientImaginary * value.imaginary;
      sumImaginary -= coefficientReal * value.imaginary + coefficientImaginary * value.real;
    }
    const diagonal = row * size + row;
    const leadReal = matrixReal[diagonal] ?? 0;
    const leadImaginary = matrixImaginary[diagonal] ?? 0;
    const denominator = leadReal * leadReal + leadImaginary * leadImaginary;
    solution[row] = {
      real: (sumReal * leadReal + sumImaginary * leadImaginary) / denominator,
      imaginary: (sumImaginary * leadReal - sumReal * leadImaginary) / denominator,
    };
  }
  return solution;
}

/** Solves a dense complex matrix using Gaussian elimination with partial pivoting. */
export function solveComplexLinearSystem(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
): ComplexValue[] | null {
  for (let column = 0; column < size; column += 1) {
    const { pivot, magnitude } = complexPivotRow(size, matrixReal, matrixImaginary, column);
    if (magnitude < 1e-24) { return null; }
    if (pivot !== column) {
      swapComplexRows(size, matrixReal, matrixImaginary, rhsReal, rhsImaginary, column, pivot);
    }
    for (let row = column + 1; row < size; row += 1) {
      eliminateComplexRow(
        size,
        matrixReal,
        matrixImaginary,
        rhsReal,
        rhsImaginary,
        column,
        row,
      );
    }
  }

  const solution = backSubstituteComplex(size, matrixReal, matrixImaginary, rhsReal, rhsImaginary);
  return solution.every((value) => Number.isFinite(value.real) && Number.isFinite(value.imaginary))
    ? solution
    : null;
}

function realPivotRow(size: number, matrix: Float64Array, column: number) {
  let pivot = column;
  let magnitude = 0;
  for (let row = column; row < size; row += 1) {
    const value = Math.abs(matrix[row * size + column] ?? 0);
    if (value > magnitude) {
      pivot = row;
      magnitude = value;
    }
  }
  return { pivot, magnitude };
}

function swapRealRows(size: number, matrix: Float64Array, rhs: Float64Array, firstRow: number, secondRow: number) {
  for (let column = 0; column < size; column += 1) {
    const first = firstRow * size + column;
    const second = secondRow * size + column;
    [matrix[first], matrix[second]] = [matrix[second] ?? 0, matrix[first] ?? 0];
  }
  [rhs[firstRow], rhs[secondRow]] = [rhs[secondRow] ?? 0, rhs[firstRow] ?? 0];
}

function eliminateRealRow(size: number, matrix: Float64Array, rhs: Float64Array, pivotColumn: number, row: number) {
  const rowLead = row * size + pivotColumn;
  const factor = (matrix[rowLead] ?? 0) / (matrix[pivotColumn * size + pivotColumn] ?? 1);
  for (let column = pivotColumn + 1; column < size; column += 1) {
    const index = row * size + column;
    matrix[index] = (matrix[index] ?? 0) - factor * (matrix[pivotColumn * size + column] ?? 0);
  }
  matrix[rowLead] = 0;
  rhs[row] = (rhs[row] ?? 0) - factor * (rhs[pivotColumn] ?? 0);
}

function backSubstituteReal(size: number, matrix: Float64Array, rhs: Float64Array) {
  const solution = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = rhs[row] ?? 0;
    for (let column = row + 1; column < size; column += 1) {
      sum -= (matrix[row * size + column] ?? 0) * (solution[column] ?? 0);
    }
    solution[row] = sum / (matrix[row * size + row] ?? 0);
  }
  return solution;
}

/** Solves a dense real matrix using Gaussian elimination with partial pivoting. */
export function solveRealLinearSystem(
  size: number,
  matrix: Float64Array,
  rhs: Float64Array,
): Float64Array | null {
  for (let column = 0; column < size; column += 1) {
    const { pivot, magnitude } = realPivotRow(size, matrix, column);
    if (magnitude < 1e-24) { return null; }
    if (pivot !== column) {
      swapRealRows(size, matrix, rhs, column, pivot);
    }
    for (let row = column + 1; row < size; row += 1) {
      eliminateRealRow(size, matrix, rhs, column, row);
    }
  }
  return backSubstituteReal(size, matrix, rhs);
}
