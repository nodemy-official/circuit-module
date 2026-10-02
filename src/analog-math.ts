import {
  addExactComplex,
  addExactRational,
  divideExactRational,
  divideExactComplex,
  exactRationalToNumber,
  exactRationalSquareRootToNumber,
  exactRationalMagnitudeExponent,
  floorExactRationalSquareRootWithRelativeError,
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

const ONE: ExactRational = { numerator: 1n, denominator: 1n };
const magnitudeNormalizations = new WeakMap<ComplexValue, { squared: ExactRational; real: number; imaginary: number }>();

/** A positive uniform amplitude correction; rectangular coefficients remain approximate. */
export function complexMagnitudeNormalization(value: ComplexValue): ExactRational {
  const stored = magnitudeNormalizations.get(value);
  if (stored && Object.is(stored.real, value.real) && Object.is(stored.imaginary, value.imaginary)) { return stored.squared; }
  magnitudeNormalizations.delete(value);
  return ONE;
}

export function withComplexMagnitudeNormalization(value: ComplexValue, squared: ExactRational): ComplexValue {
  if (squared.numerator <= 0n || squared.denominator <= 0n) { return complex(Number.NaN, Number.NaN); }
  if (squared.numerator === squared.denominator && !magnitudeNormalizations.has(value)) { return value; }
  const exact = exactComplexValue(value);
  const result = exact ? complexFromExact(exact) : complex(value.real, value.imaginary);
  if (squared.numerator !== squared.denominator) {
    magnitudeNormalizations.set(result, { squared: addExactRational(squared, { numerator: 0n, denominator: 1n }), real: result.real, imaginary: result.imaginary });
  }
  return result;
}

function sumMagnitudeNormalization(left: ComplexValue, right: ComplexValue) {
  const first = complexMagnitudeNormalization(left);
  const second = complexMagnitudeNormalization(right);
  if (first.numerator * second.denominator === second.numerator * first.denominator) { return first; }
  const isZero = (value: ComplexValue) => {
    const exact = exactComplexValue(value);
    return exact && exact.real.numerator === 0n && exact.imaginary.numerator === 0n;
  };
  return isZero(left) ? second : isZero(right) ? first : ONE;
}

const normalizationScales = new WeakMap<ExactRational, { scale: ExactRational; errorExponent: number }>();

function componentsAtNormalization(value: ComplexValue, target: ExactRational, sumErrorExponent?: number) {
  const exact = exactComplexValue(value);
  const squared = complexMagnitudeNormalization(value);
  if (!exact || squared.numerator * target.denominator === target.numerator * squared.denominator) { return exact; }
  const ratio = divideExactRational(squared, target);
  if (!ratio) { return null; }
  const maximumExponent = Math.max(exactRationalMagnitudeExponent(exact.real) ?? Number.NEGATIVE_INFINITY, exactRationalMagnitudeExponent(exact.imaginary) ?? Number.NEGATIVE_INFINITY);
  const componentExponent = Number.isFinite(maximumExponent) ? maximumExponent : 0;
  // Each expanded operand contributes less than half the sum's error budget.
  const errorExponent = sumErrorExponent === undefined ? undefined : sumErrorExponent - componentExponent - 2;
  const scaleKey = target === ONE ? squared : ratio;
  let stored = normalizationScales.get(scaleKey);
  if (!stored || (errorExponent !== undefined && stored.errorExponent > errorExponent)) {
    const scale = floorExactRationalSquareRootWithRelativeError(ratio, 512, errorExponent);
    if (!scale) { return null; }
    stored = { scale, errorExponent: errorExponent ?? Number.POSITIVE_INFINITY };
    normalizationScales.set(scaleKey, stored);
  }
  return { real: multiplyExactRational(exact.real, stored.scale), imaginary: multiplyExactRational(exact.imaginary, stored.scale) };
}

/** Expands an amplitude correction while preserving its magnitude and departure from one. */
export function complexRectangularValue(value: ComplexValue): ComplexValue {
  const exact = componentsAtNormalization(value, ONE);
  return exact ? complexFromExact(exact) : complex(value.real, value.imaginary);
}

function componentSumMagnitudeBound(
  left: ExactRational,
  right: ExactRational,
  leftNormalization: ExactRational,
  rightNormalization: ExactRational,
  subtract: boolean,
) {
  const leftSquared = multiplyExactRational(multiplyExactRational(left, left), leftNormalization);
  const rightSquared = multiplyExactRational(multiplyExactRational(right, right), rightNormalization);
  const leftExponent = exactRationalMagnitudeExponent(leftSquared);
  const rightExponent = exactRationalMagnitudeExponent(rightSquared);
  if (leftExponent === null && rightExponent === null) { return { zero: true, exponent: null }; }
  const maximumExponent = Math.floor(Math.max(leftExponent ?? Number.NEGATIVE_INFINITY, rightExponent ?? Number.NEGATIVE_INFINITY) / 2);
  const oppositeSigns = (left.numerator < 0n) !== (right.numerator < 0n);
  if (leftExponent === null || rightExponent === null || oppositeSigns === subtract) {
    return { zero: false, exponent: maximumExponent };
  }
  const difference = subtractExactRational(leftSquared, rightSquared);
  const differenceExponent = exactRationalMagnitudeExponent(difference);
  if (differenceExponent === null) { return { zero: true, exponent: null }; }
  // For opposing terms L,R, |L+R| = |L²-R²|/(|L|+|R|), and the
  // denominator is below 2^(maximumExponent+2). No projection is used.
  return { zero: false, exponent: differenceExponent - maximumExponent - 2 };
}

function mixedNormalizationSumBounds(left: ComplexValue, right: ComplexValue, subtract: boolean) {
  const first = complexMagnitudeNormalization(left);
  const second = complexMagnitudeNormalization(right);
  if (first.numerator * second.denominator === second.numerator * first.denominator) { return; }
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  if (!exactLeft || !exactRight) { return; }
  const real = componentSumMagnitudeBound(exactLeft.real, exactRight.real, first, second, subtract);
  const imaginary = componentSumMagnitudeBound(exactLeft.imaginary, exactRight.imaginary, first, second, subtract);
  const exponent = Math.min(real.exponent ?? Number.POSITIVE_INFINITY, imaginary.exponent ?? Number.POSITIVE_INFINITY);
  return { real, imaginary, errorExponent: Number.isFinite(exponent) ? exponent - 512 : undefined };
}

// floor(sqrt(1/2) * 2^512): n^2 <= 2^1023 < (n+1)^2.
// Equal diagonal coefficients preserve the exact phase; their absolute
// approximation error is below 2^-512, without binary64 amplitude inflation.
const DIAGONAL_DIRECTION: ExactRational = {
  numerator: 0xb504f333f9de6484597d89b3754abe9f1d6f60ba893ba84ced17ac85833399154afc83043ab8a2c3a8b1fe6fdc83db390f74a85e439c7b4a780487363dfa2768n,
  denominator: 2n ** 512n,
};

/** Trigonometric coefficients are binary64 approximations; amplitude products stay exact. */
export function complexFromPolar(magnitude: number, degrees = 0): ComplexValue {
  const wrappedDegrees = degrees % 360;
  const quadrant = Math.round(wrappedDegrees / 90);
  const offsetDegrees = wrappedDegrees - quadrant * 90;
  const nearAxis = Math.abs(offsetDegrees) < 1e-7;
  const diagonal = Math.abs(offsetDegrees) === 45;
  const offsetRadians = nearAxis ? 0 : (offsetDegrees * Math.PI) / 180;
  const acrossAxis = diagonal
    ? offsetDegrees < 0 ? { ...DIAGONAL_DIRECTION, numerator: -DIAGONAL_DIRECTION.numerator } : DIAGONAL_DIRECTION
    : nearAxis
    ? exactProductSumRatio([{ factors: [offsetDegrees, Math.PI] }], 180)
    : numberToExactRational(Math.sin(offsetRadians));
  const alongAxis = diagonal ? DIAGONAL_DIRECTION : numberToExactRational(nearAxis ? 1 : Math.cos(offsetRadians));
  if (!acrossAxis || !alongAxis) { return complex(Number.NaN, Number.NaN); }
  // Near an axis, sin(epsilon)=epsilon and cos(epsilon)=1 have relative
  // coefficient errors below epsilon^2/2 < 1.6e-18. Retain the rational
  // radian offset itself, including offsets below the binary64 range.
  const direction = complexFromExact({ real: alongAxis, imaginary: acrossAxis });
  const rotation = [complex(1), complex(0, 1), complex(-1), complex(0, -1)][((quadrant % 4) + 4) % 4]!;
  const squaredLength = addExactRational(multiplyExactRational(alongAxis, alongAxis), multiplyExactRational(acrossAxis, acrossAxis));
  return withComplexMagnitudeNormalization(complexMultiply(complexMultiply(direction, rotation), complex(magnitude)),
    divideExactRational(ONE, squaredLength)!);
}

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
  const normalization = sumMagnitudeNormalization(left, right);
  const bounds = mixedNormalizationSumBounds(left, right, false);
  const exactLeft = componentsAtNormalization(left, normalization, bounds?.errorExponent);
  const exactRight = componentsAtNormalization(right, normalization, bounds?.errorExponent);
  const sum = exactLeft && exactRight ? addExactComplex(exactLeft, exactRight) : null;
  const result = sum
    ? complexFromExact({ real: bounds?.real.zero ? { numerator: 0n, denominator: 1n } : sum.real,
      imaginary: bounds?.imaginary.zero ? { numerator: 0n, denominator: 1n } : sum.imaginary })
    : complex(left.real + right.real, left.imaginary + right.imaginary);
  return withComplexMagnitudeNormalization(result, normalization);
};

export const complexSubtract = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const normalization = sumMagnitudeNormalization(left, right);
  const bounds = mixedNormalizationSumBounds(left, right, true);
  const exactLeft = componentsAtNormalization(left, normalization, bounds?.errorExponent);
  const exactRight = componentsAtNormalization(right, normalization, bounds?.errorExponent);
  const difference = exactLeft && exactRight ? subtractExactComplex(exactLeft, exactRight) : null;
  const result = difference
    ? complexFromExact({ real: bounds?.real.zero ? { numerator: 0n, denominator: 1n } : difference.real,
      imaginary: bounds?.imaginary.zero ? { numerator: 0n, denominator: 1n } : difference.imaginary })
    : complex(left.real - right.real, left.imaginary - right.imaginary);
  return withComplexMagnitudeNormalization(result, normalization);
};

export const complexMultiply = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  const result = exactLeft && exactRight
    ? complexFromExact(multiplyExactComplex(exactLeft, exactRight))
    : complex(
      left.real * right.real - left.imaginary * right.imaginary,
      left.real * right.imaginary + left.imaginary * right.real,
    );
  return withComplexMagnitudeNormalization(result, multiplyExactRational(complexMagnitudeNormalization(left), complexMagnitudeNormalization(right)));
};

/** Divides finite complex inputs exactly before rounding the two output components. */
export const complexDivide = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  const exactLeft = exactComplexValue(left);
  const exactRight = exactComplexValue(right);
  if (!exactLeft || !exactRight) {
    return complex(Number.NaN, Number.NaN);
  }
  const quotient = divideExactComplex(exactLeft, exactRight);
  return quotient ? withComplexMagnitudeNormalization(complexFromExact(quotient), divideExactRational(complexMagnitudeNormalization(left), complexMagnitudeNormalization(right))!)
    : complex(Number.NaN, Number.NaN);
};

export const complexConjugate = (value: ComplexValue): ComplexValue => {
  const exact = exactComplexValue(value);
  const result = exact ? complexFromExact({
    real: exact.real,
    imaginary: subtractExactRational({ numerator: 0n, denominator: 1n }, exact.imaginary),
  }) : complex(value.real, -value.imaginary);
  return withComplexMagnitudeNormalization(result, complexMagnitudeNormalization(value));
};

export function complexMagnitude(value: ComplexValue) {
  const exact = exactComplexValue(value);
  if (!exact) { return Math.hypot(value.real, value.imaginary); }
  const normalization = complexMagnitudeNormalization(value);
  if (normalization.numerator === normalization.denominator) {
    if (exact.imaginary.numerator === 0n) { return Math.abs(exactRationalToNumber(exact.real)); }
    if (exact.real.numerator === 0n) { return Math.abs(exactRationalToNumber(exact.imaginary)); }
  }
  const squaredMagnitude = addExactRational(
    multiplyExactRational(exact.real, exact.real),
    multiplyExactRational(exact.imaginary, exact.imaginary),
  );
  return exactRationalSquareRootToNumber(multiplyExactRational(squaredMagnitude, normalization));
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
