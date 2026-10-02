import {
  addExactComplex,
  addExactRational,
  deferExactRationalReduction,
  divideExactRational,
  divideExactComplex,
  exactRationalToNumber,
  exactRationalSquareRoot,
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
  type ExactComplexValue,
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
const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const magnitudeNormalizations = new WeakMap<ComplexValue, { squared: ExactRational; real: number; imaginary: number }>();
interface NormalizedTerm {
  coefficient: ExactComplexValue;
  squared: ExactRational;
}
const normalizedSums = new WeakMap<ComplexValue, { terms: readonly NormalizedTerm[]; real: number; imaginary: number }>();
interface NormalizedFraction {
  numerator: readonly NormalizedTerm[];
  denominator: readonly NormalizedTerm[];
}
const normalizedFractions = new WeakMap<ComplexValue, { fraction: NormalizedFraction; real: number; imaginary: number }>();

function storedNormalizedFraction(value: ComplexValue) {
  const stored = normalizedFractions.get(value);
  if (stored && Object.is(stored.real, value.real) && Object.is(stored.imaginary, value.imaginary)) { return stored.fraction; }
  normalizedFractions.delete(value);
}

function normalizedFraction(value: ComplexValue): NormalizedFraction | null {
  const stored = storedNormalizedFraction(value);
  if (stored) { return stored; }
  const numerator = normalizedTerms(value);
  return numerator ? { numerator, denominator: [{ coefficient: { real: ONE, imaginary: ZERO }, squared: ONE }] } : null;
}

function storedNormalizedTerms(value: ComplexValue) {
  const stored = normalizedSums.get(value);
  if (stored && Object.is(stored.real, value.real) && Object.is(stored.imaginary, value.imaginary)) { return stored.terms; }
  normalizedSums.delete(value);
}

function retainNormalizedTerms(value: ComplexValue, terms: readonly NormalizedTerm[]) {
  normalizedSums.set(value, { terms, real: value.real, imaginary: value.imaginary });
  return value;
}

function normalizedTerms(value: ComplexValue): readonly NormalizedTerm[] | null {
  const stored = storedNormalizedTerms(value);
  if (stored) { return stored; }
  const coefficient = exactComplexValue(value);
  return coefficient ? [{ coefficient, squared: complexMagnitudeNormalization(value) }] : null;
}

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
  const terms = storedNormalizedTerms(value);
  if (terms) {
    const ratio = divideExactRational(squared, complexMagnitudeNormalization(value))!;
    retainNormalizedTerms(result, terms.map((term) => ({ ...term, squared: multiplyExactRational(term.squared, ratio) })));
  }
  const fraction = storedNormalizedFraction(value);
  if (fraction) {
    const ratio = divideExactRational(squared, complexMagnitudeNormalization(value))!;
    normalizedFractions.set(result, { fraction: { ...fraction,
      numerator: fraction.numerator.map((term) => ({ ...term, squared: multiplyExactRational(term.squared, ratio) })),
    }, real: result.real, imaginary: result.imaginary });
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
  const fraction = storedNormalizedFraction(value);
  if (fraction) { return complexFromNormalizedFraction(fraction); }
  const normalization = complexMagnitudeNormalization(value);
  const terms = storedNormalizedTerms(value) ?? (normalization.numerator !== normalization.denominator
    ? normalizedTerms(value) : null);
  if (terms) { return complexFromNormalizedTerms(terms); }
  const exact = componentsAtNormalization(value, ONE);
  return exact ? complexFromExact(exact) : complex(value.real, value.imaginary);
}

function scaleExactComplex(value: ExactComplexValue, scale: ExactRational): ExactComplexValue {
  return { real: multiplyExactRational(value.real, scale), imaginary: multiplyExactRational(value.imaginary, scale) };
}

/** Combine like radicals before any square-root boundary can erase an identity. */
function compactNormalizedTerms(terms: readonly NormalizedTerm[]) {
  const groups: NormalizedTerm[] = [];
  for (const term of terms) {
    if (term.coefficient.real.numerator === 0n && term.coefficient.imaginary.numerator === 0n) { continue; }
    const rationalRoot = exactRationalSquareRoot(term.squared);
    const next = rationalRoot ? { coefficient: scaleExactComplex(term.coefficient, rationalRoot), squared: ONE } : term;
    let combined = false;
    for (const group of groups) {
      const ratio = divideExactRational(next.squared, group.squared)!;
      const scale = ratio.numerator === ratio.denominator ? ONE : exactRationalSquareRoot(ratio);
      if (!scale) { continue; }
      group.coefficient = addExactComplex(group.coefficient, scaleExactComplex(next.coefficient, scale));
      combined = true;
      break;
    }
    if (!combined) { groups.push({ ...next }); }
  }
  return groups.filter(({ coefficient }) => coefficient.real.numerator !== 0n || coefficient.imaginary.numerator !== 0n);
}

function binaryRationalPower(exponent: number): ExactRational {
  return exponent < 0 ? { numerator: 1n, denominator: 2n ** BigInt(-exponent) }
    : { numerator: 2n ** BigInt(exponent), denominator: 1n };
}

function absoluteRational(value: ExactRational): ExactRational {
  return value.numerator < 0n ? { numerator: -value.numerator, denominator: value.denominator } : value;
}

function componentExpansionAccurate(value: ExactRational, error: ExactRational) {
  if (error.numerator === 0n) { return true; }
  if (absoluteRational(value).numerator * error.denominator <= error.numerator * value.denominator * 2n ** 514n) {
    return false;
  }
  // A relative bound alone cannot decide which side of a binary64 midpoint
  // the exact algebraic value occupies. Refine until the entire enclosure
  // rounds identically, including values arbitrarily close to a midpoint.
  // These enclosure endpoints are temporary rounding witnesses. Their exact
  // ratio is sufficient; reducing both large numerators adds no precision.
  const retainedValue = deferExactRationalReduction(value);
  const retainedError = deferExactRationalReduction(error);
  return Object.is(exactRationalToNumber(subtractExactRational(retainedValue, retainedError)),
    exactRationalToNumber(addExactRational(retainedValue, retainedError)));
}

function normalizedTermsErrorExponent(terms: readonly NormalizedTerm[]) {
  const magnitudeExponents = terms.flatMap(({ coefficient, squared }) => [coefficient.real, coefficient.imaginary]
    .map((value) => exactRationalMagnitudeExponent(multiplyExactRational(multiplyExactRational(value, value), squared)))
    .filter((exponent): exponent is number => exponent !== null));
  return Math.floor(Math.max(...magnitudeExponents) / 2) - 516 - Math.ceil(Math.log2(terms.length));
}

function normalizedTermsBounds(terms: readonly NormalizedTerm[], errorExponent: number) {
  let real = ZERO;
  let imaginary = ZERO;
  let realError = ZERO;
  let imaginaryError = ZERO;
  for (const { coefficient, squared } of terms) {
    const coefficientExponent = Math.max(exactRationalMagnitudeExponent(coefficient.real) ?? Number.NEGATIVE_INFINITY,
      exactRationalMagnitudeExponent(coefficient.imaginary) ?? Number.NEGATIVE_INFINITY);
    const rootErrorExponent = errorExponent - coefficientExponent - 2;
    const root = floorExactRationalSquareRootWithRelativeError(squared, 512, rootErrorExponent)!;
    const exact = multiplyExactRational(root, root);
    const error = exact.numerator * squared.denominator === squared.numerator * exact.denominator
      ? ZERO : binaryRationalPower(rootErrorExponent);
    real = addExactRational(real, multiplyExactRational(coefficient.real, root));
    imaginary = addExactRational(imaginary, multiplyExactRational(coefficient.imaginary, root));
    realError = addExactRational(realError, multiplyExactRational(absoluteRational(coefficient.real), error));
    imaginaryError = addExactRational(imaginaryError, multiplyExactRational(absoluteRational(coefficient.imaginary), error));
  }
  return { real, imaginary, realError, imaginaryError };
}

function expandNormalizedTerms(terms: readonly NormalizedTerm[]): ComplexValue {
  let errorExponent = normalizedTermsErrorExponent(terms);
  for (;;) {
    const { real, imaginary, realError, imaginaryError } = normalizedTermsBounds(terms, errorExponent);
    if (componentExpansionAccurate(real, realError) && componentExpansionAccurate(imaginary, imaginaryError)) {
      return complexFromExact({ real, imaginary });
    }
    // Distinct rational square-root classes are linearly independent. Exact
    // zero coefficients were combined first, so every remaining component
    // with a nonzero error enclosure can be resolved by further refinement.
    const resultExponent = Math.min(exactRationalMagnitudeExponent(real) ?? errorExponent,
      exactRationalMagnitudeExponent(imaginary) ?? errorExponent);
    errorExponent = Math.min(errorExponent - 64, resultExponent - 516);
  }
}

function complexFromNormalizedTerms(input: readonly NormalizedTerm[], target = ONE): ComplexValue {
  const terms = compactNormalizedTerms(input);
  if (terms.length === 0) { return complex(); }
  const first = terms[0]!;
  if (terms.length === 1) {
    const value = withComplexMagnitudeNormalization(complexFromExact(first.coefficient), first.squared);
    const sameNormalization = first.squared.numerator * target.denominator === target.numerator * first.squared.denominator;
    const exact = sameNormalization ? exactComplexValue(value)! : exactComplexValue(expandNormalizedTerms([
      { ...first, squared: divideExactRational(first.squared, target)! },
    ]))!;
    const result = withComplexMagnitudeNormalization(complexFromExact(exact), target);
    return sameNormalization ? result : retainNormalizedTerms(result, terms);
  }
  const coordinates = terms.map((term) => ({ ...term, squared: divideExactRational(term.squared, target)! }));
  const expanded = expandNormalizedTerms(coordinates);
  const result = withComplexMagnitudeNormalization(expanded, target);
  return retainNormalizedTerms(result, terms);
}

function multiplyNormalizedTerms(left: readonly NormalizedTerm[], right: readonly NormalizedTerm[]) {
  return compactNormalizedTerms(left.flatMap((a) => right.map((b) => ({
    coefficient: multiplyExactComplex(a.coefficient, b.coefficient), squared: multiplyExactRational(a.squared, b.squared),
  }))));
}

function conjugateNormalizedTerms(terms: readonly NormalizedTerm[]) {
  return terms.map((term) => ({ ...term,
    coefficient: { real: term.coefficient.real, imaginary: subtractExactRational(ZERO, term.coefficient.imaginary) },
  }));
}

/** Detect zero and rational components before interval refinement, including exact midpoint ties. */
function proportionalNormalizedComponent(numerator: readonly NormalizedTerm[], denominator: readonly NormalizedTerm[], component: keyof ExactComplexValue) {
  const nonzero = numerator.filter((term) => term.coefficient[component].numerator !== 0n);
  if (nonzero.length === 0) { return ZERO; }
  if (nonzero.length !== denominator.length) { return null; }
  const first = denominator[0]!;
  let coefficient = ZERO;
  for (const term of numerator) {
    const scale = exactRationalSquareRoot(divideExactRational(term.squared, first.squared)!);
    if (scale) { coefficient = addExactRational(coefficient, multiplyExactRational(term.coefficient[component], scale)); }
  }
  const ratio = divideExactRational(coefficient, first.coefficient.real)!;
  return nonzero.every((term) => denominator.some((divisor) => {
    const scale = exactRationalSquareRoot(divideExactRational(term.squared, divisor.squared)!);
    return scale && compareExactRationals(multiplyExactRational(term.coefficient[component], scale),
      multiplyExactRational(ratio, divisor.coefficient.real)) === 0;
  })) ? ratio : null;
}

function proportionalNormalizedFraction(numerator: readonly NormalizedTerm[], denominator: readonly NormalizedTerm[]) {
  if (numerator.length !== denominator.length) { return null; }
  const first = denominator[0]!;
  for (const term of numerator) {
    const scale = exactRationalSquareRoot(divideExactRational(term.squared, first.squared)!);
    if (!scale) { continue; }
    const ratio = divideExactComplex(scaleExactComplex(term.coefficient, scale), first.coefficient)!;
    return numerator.every((a) => denominator.some((b) => {
      const factor = exactRationalSquareRoot(divideExactRational(a.squared, b.squared)!);
      if (!factor) { return false; }
      const difference = subtractExactComplex(scaleExactComplex(a.coefficient, factor), multiplyExactComplex(ratio, b.coefficient));
      return difference.real.numerator === 0n && difference.imaginary.numerator === 0n;
    })) ? ratio : null;
  }
  return null;
}

function compareExactRationals(left: ExactRational, right: ExactRational) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function quotientComponentBounds(value: ExactRational, error: ExactRational, lowerDenominator: ExactRational, upperDenominator: ExactRational) {
  const endpoints = [subtractExactRational(value, error), addExactRational(value, error)]
    .flatMap((endpoint) => [lowerDenominator, upperDenominator].map((divisor) => divideExactRational(endpoint, divisor)!));
  endpoints.sort(compareExactRationals);
  const lower = endpoints[0]!;
  const upper = endpoints[3]!;
  return { value: divideExactRational(addExactRational(lower, upper), { numerator: 2n, denominator: 1n })!,
    error: divideExactRational(subtractExactRational(upper, lower), { numerator: 2n, denominator: 1n })! };
}

function expandNormalizedFraction(fraction: NormalizedFraction, target: ExactRational) {
  const coordinates = fraction.numerator.map((term) => ({ ...term, squared: divideExactRational(term.squared, target)! }));
  const rationalReal = proportionalNormalizedComponent(coordinates, fraction.denominator, "real");
  const rationalImaginary = proportionalNormalizedComponent(coordinates, fraction.denominator, "imaginary");
  let errorExponent = Math.min(normalizedTermsErrorExponent(coordinates), normalizedTermsErrorExponent(fraction.denominator));
  for (;;) {
    const numerator = normalizedTermsBounds(coordinates, errorExponent);
    const denominator = normalizedTermsBounds(fraction.denominator, errorExponent);
    const lower = subtractExactRational(denominator.real, denominator.realError);
    const upper = addExactRational(denominator.real, denominator.realError);
    if (lower.numerator > 0n) {
      const real = rationalReal ? { value: rationalReal, error: ZERO }
        : quotientComponentBounds(numerator.real, numerator.realError, lower, upper);
      const imaginary = rationalImaginary ? { value: rationalImaginary, error: ZERO }
        : quotientComponentBounds(numerator.imaginary, numerator.imaginaryError, lower, upper);
      if (componentExpansionAccurate(real.value, real.error) && componentExpansionAccurate(imaginary.value, imaginary.error)) {
        return complexFromExact({ real: real.value, imaginary: imaginary.value });
      }
    }
    // Nonproportional square-root sums cannot equal a rational midpoint.
    // After exact cancellation, a positive denominator and unique binary64
    // rounding are therefore certified by arbitrarily fine root enclosures.
    errorExponent = Math.min(errorExponent - 64,
      (exactRationalMagnitudeExponent(denominator.real) ?? errorExponent) - 516,
      (exactRationalMagnitudeExponent(numerator.real) ?? errorExponent) - 516,
      (exactRationalMagnitudeExponent(numerator.imaginary) ?? errorExponent) - 516);
  }
}

function complexFromNormalizedFraction(input: NormalizedFraction, target = ONE): ComplexValue {
  const numerator = compactNormalizedTerms(input.numerator);
  const denominator = compactNormalizedTerms(input.denominator);
  if (denominator.length === 0) { return complex(Number.NaN, Number.NaN); }
  if (numerator.length === 0) { return complexFromNormalizedTerms([], target); }
  if (denominator.length === 1) {
    const divisor = denominator[0]!;
    return complexFromNormalizedTerms(numerator.map((term) => ({
      coefficient: divideExactComplex(term.coefficient, divisor.coefficient)!,
      squared: divideExactRational(term.squared, divisor.squared)!,
    })), target);
  }
  const proportional = proportionalNormalizedFraction(numerator, denominator);
  if (proportional) { return complexFromNormalizedTerms([{ coefficient: proportional, squared: ONE }], target); }
  // Keep the original compact fraction. Conjugation is only needed to certify
  // its rectangular projection, without repeatedly squaring the stored term count.
  const conjugate = conjugateNormalizedTerms(denominator);
  const realFraction = { numerator: multiplyNormalizedTerms(numerator, conjugate),
    denominator: multiplyNormalizedTerms(denominator, conjugate) };
  const real = proportionalNormalizedComponent(realFraction.numerator, realFraction.denominator, "real");
  const imaginary = proportionalNormalizedComponent(realFraction.numerator, realFraction.denominator, "imaginary");
  if (real && imaginary) {
    return complexFromNormalizedTerms([{ coefficient: { real, imaginary }, squared: ONE }], target);
  }
  const fraction = { numerator, denominator };
  const result = withComplexMagnitudeNormalization(expandNormalizedFraction(realFraction, target), target);
  normalizedFractions.set(result, { fraction, real: result.real, imaginary: result.imaginary });
  return result;
}

function combineNormalizedFractions(left: ComplexValue, right: ComplexValue, subtract: boolean) {
  if (!storedNormalizedFraction(left) && !storedNormalizedFraction(right)) { return null; }
  const first = normalizedFraction(left);
  const second = normalizedFraction(right);
  if (!first || !second) { return null; }
  const otherNumerator = multiplyNormalizedTerms(second.numerator, first.denominator);
  return complexFromNormalizedFraction({
    numerator: [...multiplyNormalizedTerms(first.numerator, second.denominator), ...otherNumerator.map((term) => subtract
      ? { ...term, coefficient: scaleExactComplex(term.coefficient, { numerator: -1n, denominator: 1n }) } : term)],
    denominator: multiplyNormalizedTerms(first.denominator, second.denominator),
  }, sumMagnitudeNormalization(left, right));
}

function combineNormalizedTerms(left: ComplexValue, right: ComplexValue, subtract: boolean): ComplexValue | null {
  if (!storedNormalizedTerms(left) && !storedNormalizedTerms(right)) {
    const first = complexMagnitudeNormalization(left);
    const second = complexMagnitudeNormalization(right);
    if (first.numerator * second.denominator === second.numerator * first.denominator) { return null; }
  }
  const first = normalizedTerms(left);
  const second = normalizedTerms(right);
  return first && second ? complexFromNormalizedTerms([...first, ...second.map((term) => subtract
    ? { ...term, coefficient: scaleExactComplex(term.coefficient, { numerator: -1n, denominator: 1n }) } : term)],
    sumMagnitudeNormalization(left, right)) : null;
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

function addExpandedComplexValues(left: ComplexValue, right: ComplexValue, subtract: boolean): ComplexValue {
  const normalization = sumMagnitudeNormalization(left, right);
  const bounds = mixedNormalizationSumBounds(left, right, subtract);
  const exactLeft = componentsAtNormalization(left, normalization, bounds?.errorExponent);
  const exactRight = componentsAtNormalization(right, normalization, bounds?.errorExponent);
  const sum = exactLeft && exactRight ? (subtract ? subtractExactComplex : addExactComplex)(exactLeft, exactRight) : null;
  const result = sum
    ? complexFromExact({ real: bounds?.real.zero ? { numerator: 0n, denominator: 1n } : sum.real,
      imaginary: bounds?.imaginary.zero ? { numerator: 0n, denominator: 1n } : sum.imaginary })
    : complex(left.real + (subtract ? -right.real : right.real), left.imaginary + (subtract ? -right.imaginary : right.imaginary));
  return withComplexMagnitudeNormalization(result, normalization);
}

export const complexAdd = (left: ComplexValue, right: ComplexValue): ComplexValue =>
  combineNormalizedFractions(left, right, false) ?? combineNormalizedTerms(left, right, false) ?? addExpandedComplexValues(left, right, false);

export const complexSubtract = (left: ComplexValue, right: ComplexValue): ComplexValue =>
  combineNormalizedFractions(left, right, true) ?? combineNormalizedTerms(left, right, true) ?? addExpandedComplexValues(left, right, true);

export const complexMultiply = (left: ComplexValue, right: ComplexValue): ComplexValue => {
  if (storedNormalizedFraction(left) || storedNormalizedFraction(right)) {
    const first = normalizedFraction(left);
    const second = normalizedFraction(right);
    if (first && second) {
      return complexFromNormalizedFraction({ numerator: multiplyNormalizedTerms(first.numerator, second.numerator),
        denominator: multiplyNormalizedTerms(first.denominator, second.denominator),
      }, multiplyExactRational(complexMagnitudeNormalization(left), complexMagnitudeNormalization(right)));
    }
  }
  if (storedNormalizedTerms(left) || storedNormalizedTerms(right)) {
    const first = normalizedTerms(left);
    const second = normalizedTerms(right);
    if (first && second) {
      return complexFromNormalizedTerms(first.flatMap((a) => second.map((b) => ({
        coefficient: multiplyExactComplex(a.coefficient, b.coefficient), squared: multiplyExactRational(a.squared, b.squared),
      }))), multiplyExactRational(complexMagnitudeNormalization(left), complexMagnitudeNormalization(right)));
    }
  }
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
  if (storedNormalizedFraction(left) || storedNormalizedFraction(right) || storedNormalizedTerms(right)) {
    const first = normalizedFraction(left);
    const second = normalizedFraction(right);
    if (first && second) {
      return complexFromNormalizedFraction({
        numerator: multiplyNormalizedTerms(first.numerator, second.denominator),
        denominator: multiplyNormalizedTerms(first.denominator, second.numerator),
      }, divideExactRational(complexMagnitudeNormalization(left), complexMagnitudeNormalization(right))!);
    }
  }
  const terms = storedNormalizedTerms(left);
  if (terms && !storedNormalizedTerms(right)) {
    const divisor = exactComplexValue(right);
    const normalization = complexMagnitudeNormalization(right);
    if (divisor) {
      const divided = terms.map((term) => ({ coefficient: divideExactComplex(term.coefficient, divisor),
        squared: divideExactRational(term.squared, normalization)! }));
      if (divided.every((term): term is NormalizedTerm => term.coefficient !== null)) {
        return complexFromNormalizedTerms(divided, divideExactRational(complexMagnitudeNormalization(left), normalization)!);
      }
    }
  }
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
  const fraction = storedNormalizedFraction(value);
  if (fraction) {
    return complexFromNormalizedFraction({ numerator: conjugateNormalizedTerms(fraction.numerator),
      denominator: conjugateNormalizedTerms(fraction.denominator) },
      complexMagnitudeNormalization(value));
  }
  const terms = storedNormalizedTerms(value);
  if (terms) { return complexFromNormalizedTerms(terms.map((term) => ({ ...term,
    coefficient: { real: term.coefficient.real, imaginary: subtractExactRational(ZERO, term.coefficient.imaginary) },
  })), complexMagnitudeNormalization(value)); }
  const exact = exactComplexValue(value);
  const result = exact ? complexFromExact({
    real: exact.real,
    imaginary: subtractExactRational({ numerator: 0n, denominator: 1n }, exact.imaginary),
  }) : complex(value.real, -value.imaginary);
  return withComplexMagnitudeNormalization(result, complexMagnitudeNormalization(value));
};

function normalizedFractionMagnitude(fraction: NormalizedFraction): number {
  if (fraction.numerator.length === 0) { return 0; }
  const numerator = multiplyNormalizedTerms(fraction.numerator, conjugateNormalizedTerms(fraction.numerator));
  const denominator = multiplyNormalizedTerms(fraction.denominator, conjugateNormalizedTerms(fraction.denominator));
  const rationalSquared = proportionalNormalizedComponent(numerator, denominator, "real");
  if (rationalSquared) { return exactRationalSquareRootToNumber(rationalSquared); }
  let errorExponent = Math.min(normalizedTermsErrorExponent(numerator), normalizedTermsErrorExponent(denominator));
  for (;;) {
    const top = normalizedTermsBounds(numerator, errorExponent);
    const bottom = normalizedTermsBounds(denominator, errorExponent);
    const lowerDenominator = subtractExactRational(bottom.real, bottom.realError);
    if (lowerDenominator.numerator > 0n) {
      const squared = quotientComponentBounds(top.real, top.realError, lowerDenominator,
        addExactRational(bottom.real, bottom.realError));
      const lower = subtractExactRational(squared.value, squared.error);
      const upper = addExactRational(squared.value, squared.error);
      const lowerMagnitude = exactRationalSquareRootToNumber(lower.numerator > 0n ? lower : ZERO);
      const upperMagnitude = exactRationalSquareRootToNumber(upper);
      if (Object.is(lowerMagnitude, upperMagnitude)) { return lowerMagnitude; }
    }
    // A rational midpoint squared was detected above. Every other positive
    // algebraic magnitude has a unique rounded result after refinement.
    errorExponent -= 64;
  }
}

export function complexMagnitude(value: ComplexValue) {
  if (storedNormalizedTerms(value) || storedNormalizedFraction(value)) {
    return normalizedFractionMagnitude(normalizedFraction(value)!);
  }
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
