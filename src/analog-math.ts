import {
  addExactComplex,
  addExactRational,
  divideExactRational,
  divideExactComplex,
  exactRationalToNumber,
  exactRationalSquareRootToNumber,
  multiplyExactComplex,
  multiplyExactRational,
  numberToExactRational,
  solveExactComplexLinearSystem,
  solveExactRealLinearSystem,
  subtractExactComplex,
  subtractExactRational,
  sumExactRationals,
  type ExactRational,
} from "./exact-linear-algebra.js";
import {
  complexFromExact,
  exactComplexValue,
  exactRealStateInput,
  realStateFromExact,
} from "./exact-numeric-state.js";

/** A complex number represented as its rectangular components. */
export interface ComplexValue {
  real: number;
  imaginary: number;
}

export const complex = (real = 0, imaginary = 0): ComplexValue => ({ real, imaginary });

/** Keeps the exact solution available to subsequent circuit calculations. */
export function solveRealLinearSystem(...args: Parameters<typeof solveExactRealLinearSystem>) {
  const [size, matrix, rhs] = args;
  const exact = solveExactRealLinearSystem(
    size,
    matrix instanceof Float64Array ? exactRealStateInput(matrix) : matrix,
    rhs instanceof Float64Array ? exactRealStateInput(rhs) : rhs,
  );
  if (!exact) { return null; }
  const result = realStateFromExact(exact);
  return result.every(Number.isFinite) ? result : null;
}

export function solveComplexLinearSystem(...args: Parameters<typeof solveExactComplexLinearSystem>) {
  const [size, matrixReal, matrixImaginary, rhsReal, rhsImaginary] = args;
  const exact = solveExactComplexLinearSystem(
    size,
    matrixReal instanceof Float64Array ? exactRealStateInput(matrixReal) : matrixReal,
    matrixImaginary instanceof Float64Array ? exactRealStateInput(matrixImaginary) : matrixImaginary,
    rhsReal instanceof Float64Array ? exactRealStateInput(rhsReal) : rhsReal,
    rhsImaginary instanceof Float64Array ? exactRealStateInput(rhsImaginary) : rhsImaginary,
  );
  if (!exact) { return null; }
  const result = exact.map(complexFromExact);
  return result.every((value) => Number.isFinite(value.real) && Number.isFinite(value.imaginary))
    ? result
    : null;
}

/** Computes a sum of exact products divided by one exact binary64 value. */
export function exactProductSumRatio(
  terms: readonly { factors: readonly (number | ExactRational)[]; sign?: 1 | -1 }[],
  denominator: number,
): ExactRational | null {
  const exactDenominator = numberToExactRational(denominator);
  if (!exactDenominator || exactDenominator.numerator === 0n) { return null; }

  let sum = numberToExactRational(0);
  if (!sum) { return null; }
  for (const term of terms) {
    let product = numberToExactRational(1);
    if (!product) { return null; }
    for (const factor of term.factors) {
      const exactFactor = typeof factor === "number" ? numberToExactRational(factor) : factor;
      if (!exactFactor) { return null; }
      product = multiplyExactRational(product, exactFactor);
    }
    sum = term.sign === -1
      ? subtractExactRational(sum, product)
      : addExactRational(sum, product);
  }

  return divideExactRational(sum, exactDenominator);
}

/** Computes a sum of exact products divided by one exact binary64 value. */
export function exactProductSumQuotient(
  terms: readonly { factors: readonly (number | ExactRational)[]; sign?: 1 | -1 }[],
  denominator: number,
) {
  const quotient = exactProductSumRatio(terms, denominator);
  return quotient ? exactRationalToNumber(quotient) : Number.NaN;
}

/** Computes a finite-vector dot product as an exact rational, without rounding. */
export function exactDotProductRational(
  left: readonly number[],
  right: readonly (number | ExactRational)[],
) {
  if (left.length !== right.length) { return null; }
  const products: ExactRational[] = [];
  for (let index = 0; index < left.length; index += 1) {
    const exactLeft = numberToExactRational(left[index] ?? Number.NaN);
    const rightValue = right[index] ?? Number.NaN;
    const exactRight = typeof rightValue === "number" ? numberToExactRational(rightValue) : rightValue;
    if (!exactLeft || !exactRight) { return null; }
    products.push(multiplyExactRational(exactLeft, exactRight));
  }
  return sumExactRationals(products);
}

/** Computes an exact product divided by one exact binary64 value. */
export function exactProductQuotient(
  numerators: readonly (number | ExactRational)[],
  denominator: number,
) {
  return exactProductSumQuotient([{ factors: numerators }], denominator);
}

/** Multiplies finite factors exactly and rounds the completed product once. */
export function scaledProduct(values: readonly number[]): number {
  if (values.some((value) => !Number.isFinite(value))) { return Number.NaN; }
  if (values.some((value) => value === 0)) { return 0; }
  if (values.length <= 2) { return (values[0] ?? 1) * (values[1] ?? 1); }
  let product = 1n;
  for (const value of values) {
    product *= exactFloatUnits(value) ?? 0n;
  }
  return floatFromExactUnits(product, -1074 * values.length);
}

export const complexAdd = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  return exactLeft && exactRight
    ? complexFromExact(addExactComplex(exactLeft, exactRight))
    : complex(left.real + right.real, left.imaginary + right.imaginary);
};

export const complexSubtract = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  return exactLeft && exactRight
    ? complexFromExact(subtractExactComplex(exactLeft, exactRight))
    : complex(left.real - right.real, left.imaginary - right.imaginary);
};

export const complexMultiply = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  return exactLeft && exactRight
    ? complexFromExact(multiplyExactComplex(exactLeft, exactRight))
    : complex(
      left.real * right.real - left.imaginary * right.imaginary,
      left.real * right.imaginary + left.imaginary * right.real,
    );
};

/** Divides finite complex inputs exactly before rounding the two output components. */
export const complexDivide = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  if (!exactLeft || !exactRight) {
    return complex(Number.NaN, Number.NaN);
  }
  const quotient = divideExactComplex(exactLeft, exactRight);
  return quotient ? complexFromExact(quotient) : complex(Number.NaN, Number.NaN);
};

export const complexConjugate = (value: ComplexValue): ComplexValue => {
  const exact = exactComplexValue(value);
  return exact ? complexFromExact({
    real: exact.real,
    imaginary: subtractExactRational({ numerator: 0n, denominator: 1n }, exact.imaginary),
  }) : complex(value.real, -value.imaginary);
};

export function complexMagnitude(value: ComplexValue) {
  const exact = exactComplexValue(value);
  if (!exact) { return Math.hypot(value.real, value.imaginary); }
  if (exact.imaginary.numerator === 0n) { return Math.abs(exactRationalToNumber(exact.real)); }
  if (exact.real.numerator === 0n) { return Math.abs(exactRationalToNumber(exact.imaginary)); }
  const squaredMagnitude = addExactRational(
    multiplyExactRational(exact.real, exact.real),
    multiplyExactRational(exact.imaginary, exact.imaginary),
  );
  return exactRationalSquareRootToNumber(squaredMagnitude);
}

function phaseComponents(value: ComplexValue) {
  const exact = exactComplexValue(value);
  if (!exact) { return [value.real, value.imaginary] as const; }
  const realMagnitude = {
    numerator: exact.real.numerator < 0n ? -exact.real.numerator : exact.real.numerator,
    denominator: exact.real.denominator,
  };
  const imaginaryMagnitude = {
    numerator: exact.imaginary.numerator < 0n ? -exact.imaginary.numerator : exact.imaginary.numerator,
    denominator: exact.imaginary.denominator,
  };
  const realScaled = realMagnitude.numerator * imaginaryMagnitude.denominator;
  const imaginaryScaled = imaginaryMagnitude.numerator * realMagnitude.denominator;
  const scale = realScaled >= imaginaryScaled ? realMagnitude : imaginaryMagnitude;
  if (scale.numerator === 0n) { return [0, 0] as const; }
  const normalizedReal = divideExactRational(exact.real, scale);
  const normalizedImaginary = divideExactRational(exact.imaginary, scale);
  return normalizedReal && normalizedImaginary
    ? [exactRationalToNumber(normalizedReal), exactRationalToNumber(normalizedImaginary)] as const
    : [value.real, value.imaginary] as const;
}

export function complexPhaseRadians(value: ComplexValue) {
  const [real, imaginary] = phaseComponents(value);
  return Math.atan2(imaginary, real);
}

function exactNearAxisPhaseDegrees(value: ComplexValue) {
  const exact = exactComplexValue(value);
  if (!exact || exact.real.numerator <= 0n) { return null; }
  const ratio = divideExactRational(exact.imaginary, exact.real);
  const threshold = numberToExactRational(1e-8);
  const oneEighty = numberToExactRational(180);
  const pi = numberToExactRational(Math.PI);
  if (!ratio || !threshold || !oneEighty || !pi) { return null; }
  if (
    (ratio.numerator < 0n ? -ratio.numerator : ratio.numerator) * threshold.denominator >
      threshold.numerator * ratio.denominator
  ) {
    return null;
  }
  const degreeScale = divideExactRational(oneEighty, pi);
  const degrees = degreeScale && multiplyExactRational(ratio, degreeScale);
  return degrees ? exactRationalToNumber(degrees) : null;
}

export function complexPhaseDegrees(value: ComplexValue) {
  const exactNearAxis = exactNearAxisPhaseDegrees(value);
  if (exactNearAxis !== null) { return exactNearAxis; }
  const [real, imaginary] = phaseComponents(value);
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

function floatFromExactUnits(value: bigint, unitExponent = -1074) {
  if (value === 0n) { return 0; }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const bitLength = magnitude.toString(2).length;
  // Keep at most 53 significant bits and never round below the smallest
  // binary64 unit. Product sums use 2^-2148 units; ordinary sums use 2^-1074.
  const shift = Math.max(0, bitLength - 53, -1074 - unitExponent);
  const discardedUnits = 2n ** BigInt(shift);
  let significand = magnitude / discardedUnits;
  if (shift > 0) {
    const remainder = magnitude % discardedUnits;
    const halfway = discardedUnits / 2n;
    if (remainder > halfway || (remainder === halfway && significand % 2n === 1n)) {
      significand += 1n;
    }
  }
  const rounded = Number(significand) * 2 ** (shift + unitExponent);
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
