/** A complex number represented as its rectangular components. */
export interface ComplexValue {
  real: number;
  imaginary: number;
}

export const complex = (real = 0, imaginary = 0): ComplexValue => ({ real, imaginary });

/** Multiplies finite factors without rounding intermediate products into the subnormal range. */
export function scaledProduct(values: readonly number[]): number {
  if (values.some((value) => !Number.isFinite(value))) { return Number.NaN; }
  if (values.some((value) => value === 0)) { return 0; }
  let sign = 1;
  let mantissa = 1;
  let exponent = 0;
  for (const value of values) {
    if (value < 0) { sign = -sign; }
    const magnitude = Math.abs(value);
    const factorExponent = Math.max(-1074, Math.min(1023, Math.floor(Math.log2(magnitude))));
    mantissa *= magnitude / 2 ** factorExponent;
    exponent += factorExponent;
    // log2 can round across an exact power-of-two boundary.
    while (mantissa >= 2) { mantissa /= 2; exponent += 1; }
    while (mantissa < 1) { mantissa *= 2; exponent -= 1; }
  }
  if (exponent > 1023) { return sign * Number.POSITIVE_INFINITY; }
  if (exponent < -1075) { return sign * 0; }
  // Round to subnormal units only once, after every factor has contributed.
  const product = exponent < -1022
    ? (mantissa * 2 ** (exponent + 1074)) * Number.MIN_VALUE
    : mantissa * 2 ** exponent;
  return sign * product;
}

export const complexAdd = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

export const complexSubtract = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: left.real - right.real,
  imaginary: left.imaginary - right.imaginary,
});

export const complexMultiply = (left: ComplexValue, right: ComplexValue): ComplexValue => ({
  real: productSum(left.real, right.real, -left.imaginary, right.imaginary),
  imaginary: productSum(left.real, right.imaginary, left.imaginary, right.real),
});

function rescaleQuotient(value: number, numeratorScale: number, denominatorScale: number) {
  if (value === 0) { return value; }
  const ratio = numeratorScale / denominatorScale;
  if (Number.isFinite(ratio) && ratio >= 2 ** -1022) { return value * ratio; }
  // Apply all factors before rounding a subnormal quotient. Neither forming
  // the scale ratio nor multiplying the numerator first preserves those bits.
  // Split the divisor's power of two so its reciprocal is always representable.
  const exponent = Math.max(-1074, Math.min(1023, Math.floor(Math.log2(denominatorScale))));
  const firstExponent = Math.floor(exponent / 2);
  return scaledProduct([
    value,
    numeratorScale,
    1 / (denominatorScale / 2 ** exponent),
    2 ** -firstExponent,
    2 ** -(exponent - firstExponent),
  ]);
}

export const complexDivide = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  if (right.imaginary === 0 && right.real !== 0) {
    return complex(left.real / right.real, left.imaginary / right.real);
  }
  if (right.real === 0 && right.imaginary !== 0) {
    return complex(left.imaginary / right.imaginary, -left.real / right.imaginary);
  }
  // Normalize both operands before multiplying: squaring a finite phasor can
  // overflow or underflow even when the quotient is near unity.
  const numeratorScale = Math.max(Math.abs(left.real), Math.abs(left.imaginary)) || 1;
  const denominatorScale = Math.max(Math.abs(right.real), Math.abs(right.imaginary));
  const leftReal = left.real / numeratorScale;
  const leftImaginary = left.imaginary / numeratorScale;
  const rightReal = right.real / denominatorScale;
  const rightImaginary = right.imaginary / denominatorScale;
  // A normalized minor component can lose precision in the subnormal range
  // even though its contribution to the quotient is normal. Keep that component
  // unscaled until all product factors are available; its squared ratio is negligible.
  if (Math.abs(rightImaginary) < 2 ** -1022 && right.imaginary !== 0) {
    const real = left.real / right.real;
    const imaginary = left.imaginary / right.real;
    const inverse = 1 / right.real;
    return complex(real + scaledProduct([left.imaginary, right.imaginary, inverse, inverse]),
      imaginary - scaledProduct([left.real, right.imaginary, inverse, inverse]));
  }
  if (Math.abs(rightReal) < 2 ** -1022 && right.real !== 0) {
    const real = left.real / right.imaginary;
    const imaginary = left.imaginary / right.imaginary;
    const inverse = 1 / right.imaginary;
    return complex(imaginary + scaledProduct([left.real, right.real, inverse, inverse]),
      -real + scaledProduct([left.imaginary, right.real, inverse, inverse]));
  }
  const denominator = rightReal * rightReal + rightImaginary * rightImaginary;
  return {
    real: rescaleQuotient(
      (leftReal * rightReal + leftImaginary * rightImaginary) / denominator,
      numeratorScale,
      denominatorScale,
    ),
    imaginary: rescaleQuotient(
      (leftImaginary * rightReal - leftReal * rightImaginary) / denominator,
      numeratorScale,
      denominatorScale,
    ),
  };
};

export const complexConjugate = (value: ComplexValue): ComplexValue => ({
  real: value.real,
  imaginary: -value.imaginary,
});

export const complexMagnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);

export const complexPhaseRadians = (value: ComplexValue) => Math.atan2(value.imaginary, value.real);

export function complexPhaseDegrees(value: ComplexValue) {
  const { real, imaginary } = value;
  // atan2 returns zero when a tiny, representable angle in degrees is below
  // the smallest binary64 radian. Divide by the scaled real part first.
  if (real > 0 && Math.abs(imaginary) <= real * 1e-8) {
    const scaledReal = real / 180;
    if (scaledReal !== 0) { return (imaginary / scaledReal) / Math.PI; }
  }
  return (complexPhaseRadians(value) * 180) / Math.PI;
}

function exactFloatUnits(value: number) {
  if (!Number.isFinite(value)) { return; }
  const bitsView = new DataView(new ArrayBuffer(8));
  bitsView.setFloat64(0, value, false);
  const highWord = bitsView.getUint32(0, false);
  const lowWord = bitsView.getUint32(4, false);
  const negative = highWord >= 2 ** 31;
  const unsignedHighWord = highWord % (2 ** 31);
  const exponent = Math.floor(unsignedHighWord / (2 ** 20));
  const fractionHigh = unsignedHighWord % (2 ** 20);
  const fraction = BigInt(fractionHigh) * (2n ** 32n) + BigInt(lowWord);
  if (exponent === 0) { return negative ? -fraction : fraction; }
  const significand = (2n ** 52n) + fraction;
  const units = significand * (2n ** BigInt(exponent - 1));
  return negative ? -units : units;
}

/** Preserve products below one subnormal unit until their sum is rounded. */
function productSum(a: number, b: number, c: number, d: number) {
  const first = a * b;
  const second = c * d;
  if (Math.abs(first) >= 2 ** -1022 || Math.abs(second) >= 2 ** -1022 ||
      (first === 0 && (a === 0 || b === 0) && second === 0 && (c === 0 || d === 0))) {
    return first + second;
  }
  const values = [a, b, c, d].map(exactFloatUnits);
  const [aUnits, bUnits, cUnits, dUnits] = values;
  if (aUnits === undefined || bUnits === undefined || cUnits === undefined || dUnits === undefined) {
    return first + second;
  }
  const sum = aUnits * bUnits + cUnits * dUnits;
  const magnitude = sum < 0n ? -sum : sum;
  const divisor = 2n ** 1074n;
  let units = magnitude / divisor;
  const remainder = magnitude % divisor;
  if (remainder > divisor / 2n || (remainder === divisor / 2n && units % 2n === 1n)) {
    units += 1n;
  }
  return (sum < 0n ? -1 : 1) * Number(units) * Number.MIN_VALUE;
}

function floatFromExactUnits(value: bigint) {
  if (value === 0n) { return 0; }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const bitLength = magnitude.toString(2).length;
  if (bitLength <= 52) {
    return (negative ? -1 : 1) * Number(magnitude) * Number.MIN_VALUE;
  }

  const shift = bitLength - 53;
  const discardedUnits = 2n ** BigInt(shift);
  let significand = magnitude / discardedUnits;
  if (shift > 0) {
    const remainder = magnitude % discardedUnits;
    const halfway = discardedUnits / 2n;
    if (remainder > halfway || (remainder === halfway && significand % 2n === 1n)) {
      significand += 1n;
    }
  }
  const rounded = Number(significand) * 2 ** (shift - 1074);
  return negative ? -rounded : rounded;
}

/** Sums finite binary64 values exactly before rounding the final result once. */
export function exactComponentSum(values: readonly number[]) {
  // A single IEEE-754 addition already rounds the exact sum once. Most MNA
  // rows have at most two nonzero terms, so avoid BigInt work for those rows.
  if (values.length <= 2) {
    const first = values.length > 0 ? values[0] as number : 0;
    const second = values.length > 1 ? values[1] as number : 0;
    if (!Number.isFinite(first) || !Number.isFinite(second)) { return Number.NaN; }
    const sum = first + second;
    return sum === 0 ? 0 : sum;
  }
  let sum = 0n;
  for (const value of values) {
    const units = exactFloatUnits(value);
    if (units === undefined) { return Number.NaN; }
    sum += units;
  }
  return floatFromExactUnits(sum);
}

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
    const magnitude = Math.max(Math.abs(matrixReal[index] ?? 0), Math.abs(matrixImaginary[index] ?? 0));
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
  const valueReal = matrixReal[rowLead] ?? 0;
  const valueImaginary = matrixImaginary[rowLead] ?? 0;
  const factor = complexDivide(complex(valueReal, valueImaginary), complex(leadReal, leadImaginary));
  const factorReal = factor.real;
  const factorImaginary = factor.imaginary;

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
    solution[row] = complexDivide(complex(sumReal, sumImaginary), complex(leadReal, leadImaginary));
  }
  return solution;
}

function validSystem(size: number, matrix: Float64Array, rhs: Float64Array) {
  return Number.isSafeInteger(size) && size >= 0 &&
    matrix.length === size * size && rhs.length === size &&
    matrix.every(Number.isFinite) && rhs.every(Number.isFinite);
}

function powerOfTwoAtMost(value: number) {
  if (value <= 0) { return 0; }
  // 2**1024 overflows and 2**-1075 underflows, so keep the exponent in range.
  const exponent = Math.max(-1074, Math.min(1023, Math.floor(Math.log2(value))));
  return 2 ** exponent;
}

function rowScalingFactor(coefficientScale: number, rhsScale: number) {
  const rowScale = powerOfTwoAtMost(coefficientScale);
  // Leave the row untouched when normalizing its coefficients would overflow
  // the right-hand side; that preserves small coefficients in extreme systems.
  return rowScale > 0 && rhsScale / rowScale <= Number.MAX_VALUE / 4 ? rowScale : 0;
}

function preservesBinary64ValueWhenScaled(value: number, rowScale: number) {
  if (value === 0) { return true; }
  const scaled = value / rowScale;
  // Subnormal rounding can change a small coefficient or RHS during equilibration.
  return Number.isFinite(scaled) && scaled * rowScale === value;
}

function canScaleComplexRow(
  size: number,
  start: number,
  row: number,
  rowScale: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
) {
  if (!preservesBinary64ValueWhenScaled(rhsReal[row] ?? 0, rowScale) ||
    !preservesBinary64ValueWhenScaled(rhsImaginary[row] ?? 0, rowScale)) {
    return false;
  }
  for (let column = 0; column < size; column += 1) {
    const index = start + column;
    if (!preservesBinary64ValueWhenScaled(matrixReal[index] ?? 0, rowScale) ||
      !preservesBinary64ValueWhenScaled(matrixImaginary[index] ?? 0, rowScale)) {
      return false;
    }
  }
  return true;
}

function scaleComplexRows(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
) {
  for (let row = 0; row < size; row += 1) {
    let coefficientScale = 0;
    const start = row * size;
    for (let column = 0; column < size; column += 1) {
      const index = start + column;
      coefficientScale = Math.max(
        coefficientScale,
        Math.abs(matrixReal[index] ?? 0),
        Math.abs(matrixImaginary[index] ?? 0),
      );
    }
    const rhsScale = Math.max(Math.abs(rhsReal[row] ?? 0), Math.abs(rhsImaginary[row] ?? 0));
    const rowScale = rowScalingFactor(coefficientScale, rhsScale);
    if (rowScale === 0) { continue; }
    if (!canScaleComplexRow(
      size,
      start,
      row,
      rowScale,
      matrixReal,
      matrixImaginary,
      rhsReal,
      rhsImaginary,
    )) { continue; }
    for (let column = 0; column < size; column += 1) {
      const index = start + column;
      matrixReal[index] = (matrixReal[index] ?? 0) / rowScale;
      matrixImaginary[index] = (matrixImaginary[index] ?? 0) / rowScale;
    }
    rhsReal[row] = (rhsReal[row] ?? 0) / rowScale;
    rhsImaginary[row] = (rhsImaginary[row] ?? 0) / rowScale;
  }
}

function solveComplexLinearSystemInPlace(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
): ComplexValue[] | null {
  scaleComplexRows(size, matrixReal, matrixImaginary, rhsReal, rhsImaginary);
  for (let column = 0; column < size; column += 1) {
    const { pivot, magnitude } = complexPivotRow(size, matrixReal, matrixImaginary, column);
    if (magnitude === 0 || !Number.isFinite(magnitude)) { return null; }
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

/** Solves a dense complex matrix in place; returns null for singular or nonfinite systems. */
export function solveComplexLinearSystem(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
): ComplexValue[] | null {
  if (!validSystem(size, matrixReal, rhsReal) || !validSystem(size, matrixImaginary, rhsImaginary)) {
    return null;
  }

  const rhsMagnitude = Math.max(
    ...rhsReal.map(Math.abs),
    ...rhsImaginary.map(Math.abs),
  );
  if (rhsMagnitude > 0 && rhsMagnitude < 2 ** -1022) {
    // A subnormal excitation can disappear when elimination multiplies its RHS
    // by an ordinary-sized pivot factor. Since every RHS is subnormal here,
    // scaling the whole solution by an exact power of two keeps the matrix
    // untouched and postpones subnormal rounding until the solution is restored.
    const solutionScale = powerOfTwoAtMost(rhsMagnitude);
    const originalMatrixReal = matrixReal.slice();
    const originalMatrixImaginary = matrixImaginary.slice();
    const originalRhsReal = rhsReal.slice();
    const originalRhsImaginary = rhsImaginary.slice();
    for (let index = 0; index < size; index += 1) {
      rhsReal[index] = (rhsReal[index] ?? 0) / solutionScale;
      rhsImaginary[index] = (rhsImaginary[index] ?? 0) / solutionScale;
    }

    const scaledSolution = solveComplexLinearSystemInPlace(
      size,
      matrixReal,
      matrixImaginary,
      rhsReal,
      rhsImaginary,
    );
    if (scaledSolution) {
      const solution = scaledSolution.map((value) => complex(
        scaledProduct([value.real, solutionScale]),
        scaledProduct([value.imaginary, solutionScale]),
      ));
      if (solution.every((value) => Number.isFinite(value.real) && Number.isFinite(value.imaginary))) {
        return solution;
      }
    }

    // Normalizing the RHS can expose an otherwise finite solution to an
    // intermediate overflow in a highly ill-conditioned system. Retry the
    // original equations before reporting failure.
    matrixReal.set(originalMatrixReal);
    matrixImaginary.set(originalMatrixImaginary);
    rhsReal.set(originalRhsReal);
    rhsImaginary.set(originalRhsImaginary);
  }

  return solveComplexLinearSystemInPlace(
    size,
    matrixReal,
    matrixImaginary,
    rhsReal,
    rhsImaginary,
  );
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

function scaleRealRows(size: number, matrix: Float64Array, rhs: Float64Array) {
  for (let row = 0; row < size; row += 1) {
    let coefficientScale = 0;
    const start = row * size;
    for (let column = 0; column < size; column += 1) {
      coefficientScale = Math.max(coefficientScale, Math.abs(matrix[start + column] ?? 0));
    }
    const rowScale = rowScalingFactor(coefficientScale, Math.abs(rhs[row] ?? 0));
    if (rowScale === 0) { continue; }
    let preservesValues = preservesBinary64ValueWhenScaled(rhs[row] ?? 0, rowScale);
    for (let column = 0; preservesValues && column < size; column += 1) {
      preservesValues = preservesBinary64ValueWhenScaled(matrix[start + column] ?? 0, rowScale);
    }
    if (!preservesValues) { continue; }
    for (let column = 0; column < size; column += 1) {
      matrix[start + column] = (matrix[start + column] ?? 0) / rowScale;
    }
    rhs[row] = (rhs[row] ?? 0) / rowScale;
  }
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

function realRowCoefficientCounts(size: number, matrix: Float64Array) {
  const counts = new Uint32Array(size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (matrix[row * size + column] !== 0) { counts[row] += 1; }
    }
  }
  return counts;
}

/** Substitute exact zero constraints before elimination mixes their rows with
 * large coefficients. In MNA, an unconnected terminal fixes its only branch
 * current to zero; losing this constraint to roundoff can prevent convergence. */
function substituteZeroConstraints(size: number, matrix: Float64Array, rhs: Float64Array) {
  const counts = realRowCoefficientCounts(size, matrix);
  const pending = Array.from({ length: size }, (_, row) => row)
    .filter((row) => counts[row] === 1 && rhs[row] === 0);
  for (const constrainedRow of pending) {
    if (counts[constrainedRow] !== 1) { continue; }
    let constrainedColumn = 0;
    while (matrix[constrainedRow * size + constrainedColumn] === 0) { constrainedColumn += 1; }
    for (let row = 0; row < size; row += 1) {
      const index = row * size + constrainedColumn;
      if (row === constrainedRow || matrix[index] === 0) { continue; }
      matrix[index] = 0;
      counts[row] -= 1;
      if (counts[row] === 1 && rhs[row] === 0) { pending.push(row); }
    }
  }
}

function solveRealLinearSystemInPlace(
  size: number,
  matrix: Float64Array,
  rhs: Float64Array,
): Float64Array | null {
  substituteZeroConstraints(size, matrix, rhs);
  scaleRealRows(size, matrix, rhs);
  for (let column = 0; column < size; column += 1) {
    const { pivot, magnitude } = realPivotRow(size, matrix, column);
    if (magnitude === 0 || !Number.isFinite(magnitude)) { return null; }
    if (pivot !== column) {
      swapRealRows(size, matrix, rhs, column, pivot);
    }
    for (let row = column + 1; row < size; row += 1) {
      eliminateRealRow(size, matrix, rhs, column, row);
    }
  }
  const solution = backSubstituteReal(size, matrix, rhs);
  return solution.every(Number.isFinite) ? solution : null;
}

/** Solves a dense real matrix in place; returns null for singular or nonfinite systems. */
export function solveRealLinearSystem(
  size: number,
  matrix: Float64Array,
  rhs: Float64Array,
): Float64Array | null {
  if (!validSystem(size, matrix, rhs)) { return null; }
  const rhsMagnitude = Math.max(...rhs.map(Math.abs));
  if (rhsMagnitude > 0 && rhsMagnitude < 2 ** -1022) {
    // As for the complex solver, postpone subnormal rounding until after
    // elimination. Otherwise an ordinary pivot factor can erase the excitation.
    const solutionScale = powerOfTwoAtMost(rhsMagnitude);
    const originalMatrix = matrix.slice();
    const originalRhs = rhs.slice();
    for (let index = 0; index < size; index += 1) {
      rhs[index] = (rhs[index] ?? 0) / solutionScale;
    }
    const scaledSolution = solveRealLinearSystemInPlace(size, matrix, rhs);
    if (scaledSolution) {
      const solution = scaledSolution.map((value) => scaledProduct([value, solutionScale]));
      if (solution.every(Number.isFinite)) { return solution; }
    }
    // A finite original solution can overflow in the normalized coordinates.
    matrix.set(originalMatrix);
    rhs.set(originalRhs);
  }
  return solveRealLinearSystemInPlace(size, matrix, rhs);
}
