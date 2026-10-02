import type { ComplexValue } from "./analog-math.js";
import { combineExactExpressionHandles, exactExpressionCaptureIsActive, exactExpressionHandle, retainExactExpressionHandle, recordExactAlias, recordExactExpression, recordExactSum, type ExactExpressionHandle } from "./exact-expression.js";

/** An exact rational with a positive denominator. */
export interface ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Exact rectangular complex number used by the linear solvers. */
export interface ExactComplexValue {
  readonly real: ExactRational;
  readonly imaginary: ExactRational;
}

const ZERO: ExactRational = Object.freeze({ numerator: 0n, denominator: 1n });
const ONE: ExactRational = Object.freeze({ numerator: 1n, denominator: 1n });
const NEGATIVE_ONE: ExactRational = Object.freeze({ numerator: -1n, denominator: 1n });
const reducedRationals = new WeakSet<ExactRational>([ZERO, ONE, NEGATIVE_ONE]);
const deferredRationals = new WeakSet<ExactRational>();
const TWO_TO_52 = 2n ** 52n;
const TWO_TO_53 = 2n ** 53n;
const TWO_TO_1074 = 2n ** 1074n;
const MIN_NORMAL_BINARY64 = 2 ** -1022;
const MAX_NATIVE_GCD_OPERAND = 2n ** 512n;
const MAX_PRODUCT_INTERVAL_SMALL_OPERAND = 2n ** 512n;
const binary64View = new DataView(new ArrayBuffer(8));
const exactRationalNumberCache = new WeakMap<ExactRational, number>();
const MAX_SMALL_DEFERRED_OPERAND = 2n ** 2048n;
const bitLengthThresholds = [2n ** 32n];
const smallDivisorGcdCache = new Map<bigint, Map<bigint, bigint>>();

function absolute(value: bigint) {
  return value < 0n ? -value : value;
}

function gcd(first: bigint, second: bigint) {
  let left = absolute(first);
  let right = absolute(second);
  if (left < right) { [left, right] = [right, left]; }
  if (left === right) { return left; }
  if (right < MAX_NATIVE_GCD_OPERAND) { return nativeGcd(left, right); }
  let shift = Math.max(0, bitLength(left) - 48);
  let shiftAmount = BigInt(shift);
  while (right !== 0n) {
    if (left < right) { [left, right] = [right, left]; }
    if (right < MAX_NATIVE_GCD_OPERAND) { return nativeGcd(left, right); }

    // Keep extracting from the cached high-word position as Euclid shrinks
    // the operands. One small decrease restores enough leading bits without
    // rebuilding a huge binary string on every batch.
    // biome-ignore lint/suspicious/noBitwiseOperators: exact BigInt shift extracts high word
    let approximateLeft = Number(left >> shiftAmount);
    while (approximateLeft < 2 ** 32 && shift >= 16) {
      shift -= 16;
      shiftAmount -= 16n;
      // biome-ignore lint/suspicious/noBitwiseOperators: exact BigInt shift extracts high word
      approximateLeft = Number(left >> shiftAmount);
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: exact BigInt shift extracts high word
    const approximateRight = Number(right >> shiftAmount);
    if (approximateRight === 0) {
      [left, right] = [right, positiveQuotientAndRemainder(left, right)[1]];
      continue;
    }

    const reduced = lehmerReduction(left, right, approximateLeft, approximateRight);
    [left, right] = reduced ?? [right, positiveQuotientAndRemainder(left, right)[1]];
  }
  return left;
}

function nativeGcd(left: bigint, right: bigint) {
  if (right === 0n) { return left; }
  if (right === 1n) { return 1n; }
  const cacheable = left >= MAX_SMALL_DEFERRED_OPERAND;
  const cached = cacheable ? smallDivisorGcdCache.get(left) : undefined;
  const known = cached?.get(right);
  if (known !== undefined) { return known; }
  let dividend = left;
  let divisor = right;
  while (divisor !== 0n) {
    if (divisor === 1n) { dividend = 1n; break; }
    [dividend, divisor] = [divisor, dividend % divisor];
  }
  if (cacheable) {
    const factors = cached ?? new Map<bigint, bigint>();
    // BigInt keys and answers are immutable. Bound both dimensions so that
    // repeated exact coefficients reuse work without retaining a history.
    if (factors.size < 16) { factors.set(right, dividend); }
    if (!cached) {
      if (smallDivisorGcdCache.size >= 32) {
        smallDivisorGcdCache.delete(smallDivisorGcdCache.keys().next().value!);
      }
      smallDivisorGcdCache.set(left, factors);
    }
  }
  return dividend;
}

interface LehmerMatrix {
  firstLeft: number;
  firstRight: number;
  secondLeft: number;
  secondRight: number;
}

function estimateLehmerMatrix(
  initialApproximateLeft: number,
  initialApproximateRight: number,
): LehmerMatrix | null {
  let approximateLeft = initialApproximateLeft;
  let approximateRight = initialApproximateRight;
  let firstLeft = 1;
  let firstRight = 0;
  let secondLeft = 0;
  let secondRight = 1;
  const maximumSafeCoefficient = Number.MAX_SAFE_INTEGER;
  let steps = 0;

  while (approximateRight !== 0) {
    const firstDenominator = approximateRight + secondLeft;
    const secondDenominator = approximateRight + secondRight;
    const firstNumerator = approximateLeft + firstLeft;
    const secondNumerator = approximateLeft + firstRight;
    if (![firstDenominator, secondDenominator, firstNumerator, secondNumerator].every(Number.isSafeInteger) ||
        firstDenominator <= 0 || secondDenominator <= 0 || firstNumerator < 0 || secondNumerator < 0) {
      break;
    }
    const firstQuotient = Math.floor(firstNumerator / firstDenominator);
    const secondQuotient = Math.floor(secondNumerator / secondDenominator);
    if (firstQuotient !== secondQuotient || !Number.isSafeInteger(firstQuotient) || firstQuotient <= 0) { break; }

    const quotientProduct = firstQuotient * approximateRight;
    if (!Number.isSafeInteger(quotientProduct)) { break; }
    const nextApproximateRight = approximateLeft - quotientProduct;
    if (nextApproximateRight < 0 || nextApproximateRight >= approximateRight) { break; }
    const leftProduct = firstQuotient * secondLeft;
    const rightProduct = firstQuotient * secondRight;
    if (!Number.isSafeInteger(leftProduct) || !Number.isSafeInteger(rightProduct)) { break; }
    const nextSecondLeft = firstLeft - leftProduct;
    const nextSecondRight = firstRight - rightProduct;
    if ([secondLeft, secondRight, nextSecondLeft, nextSecondRight].some(
      (coefficient) => !Number.isSafeInteger(coefficient) || Math.abs(coefficient) > maximumSafeCoefficient,
    )) {
      break;
    }

    approximateLeft = approximateRight;
    approximateRight = nextApproximateRight;
    firstLeft = secondLeft;
    firstRight = secondRight;
    secondLeft = nextSecondLeft;
    secondRight = nextSecondRight;
    steps += 1;
  }

  return steps === 0 ? null : { firstLeft, firstRight, secondLeft, secondRight };
}

function lehmerReduction(
  left: bigint,
  right: bigint,
  approximateLeft: number,
  approximateRight: number,
): [bigint, bigint] | null {
  const matrix = estimateLehmerMatrix(approximateLeft, approximateRight);
  if (!matrix) { return null; }
  const { firstLeft, firstRight, secondLeft, secondRight } = matrix;
  const firstLeftBigInt = BigInt(firstLeft);
  const firstRightBigInt = BigInt(firstRight);
  const secondLeftBigInt = BigInt(secondLeft);
  const secondRightBigInt = BigInt(secondRight);
  const determinant = firstLeftBigInt * secondRightBigInt - firstRightBigInt * secondLeftBigInt;
  if (determinant !== 1n && determinant !== -1n) { return null; }
  const reducedLeft = firstLeftBigInt * left + firstRightBigInt * right;
  const reducedRight = secondLeftBigInt * left + secondRightBigInt * right;
  return reducedLeft > 0n && reducedRight >= 0n && reducedLeft >= reducedRight &&
      reducedRight < right && (reducedRight === 0n || reducedLeft < left)
    ? [reducedLeft, reducedRight]
    : null;
}

function rational(numerator: bigint, denominator = 1n): ExactRational {
  if (denominator === 0n) { throw new RangeError("Exact rational denominator must not be zero."); }
  if (numerator === 0n) { return ZERO; }
  const sign = denominator < 0n ? -1n : 1n;
  const positiveDenominator = absolute(denominator);
  const divisor = gcd(numerator, positiveDenominator);
  return reducedRational(sign * (numerator / divisor), positiveDenominator / divisor);
}

function reducedRational(numerator: bigint, denominator: bigint) {
  const result = Object.freeze({ numerator, denominator });
  reducedRationals.add(result);
  return result;
}

function deferredRational(numerator: bigint, denominator: bigint): ExactRational {
  if (denominator === 0n) { throw new RangeError("Exact rational denominator must not be zero."); }
  if (numerator === 0n) { return ZERO; }
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const positiveDenominator = absolute(denominator);
  if (normalizedNumerator === positiveDenominator) { return ONE; }
  if (normalizedNumerator === -positiveDenominator) { return NEGATIVE_ONE; }
  const result = Object.freeze({ numerator: normalizedNumerator, denominator: positiveDenominator });
  deferredRationals.add(result);
  return result;
}

function withDeferredReduction(value: ExactRational) {
  return deferredRationals.has(value)
    ? value
    : deferredRational(value.numerator, value.denominator);
}

function isSmallCanonicalRational(value: ExactRational) {
  return reducedRationals.has(value) &&
    absolute(value.numerator) < MAX_SMALL_DEFERRED_OPERAND &&
    value.denominator < MAX_SMALL_DEFERRED_OPERAND;
}

function multiplyDeferredRationals(
  left: ExactRational,
  right: ExactRational,
  leftDeferred: boolean,
  rightDeferred: boolean,
) {
  const nonDeferred = leftDeferred ? right : left;
  if (leftDeferred !== rightDeferred && isSmallCanonicalRational(nonDeferred)) {
    const firstCancellation = gcd(left.numerator, right.denominator);
    const secondCancellation = gcd(right.numerator, left.denominator);
    return deferredRational(
      integerQuotient(left.numerator, firstCancellation) * integerQuotient(right.numerator, secondCancellation),
      integerQuotient(left.denominator, secondCancellation) * integerQuotient(right.denominator, firstCancellation),
    );
  }
  return deferredRational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divideDeferredRationals(
  left: ExactRational,
  right: ExactRational,
  leftDeferred: boolean,
  rightDeferred: boolean,
) {
  const nonDeferred = leftDeferred ? right : left;
  if (leftDeferred !== rightDeferred && isSmallCanonicalRational(nonDeferred)) {
    const numeratorCancellation = gcd(left.numerator, right.numerator);
    const denominatorCancellation = gcd(right.denominator, left.denominator);
    return deferredRational(
      integerQuotient(left.numerator, numeratorCancellation) * integerQuotient(right.denominator, denominatorCancellation),
      integerQuotient(left.denominator, denominatorCancellation) * integerQuotient(right.numerator, numeratorCancellation),
    );
  }
  return deferredRational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function canonicalized(value: ExactRational) {
  return reducedRationals.has(value) ? value : rational(value.numerator, value.denominator);
}

function normalized(value: ExactRational): ExactRational | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.numerator !== "bigint" ||
    typeof value.denominator !== "bigint" ||
    value.denominator === 0n
  ) {
    return null;
  }
  if (value.numerator === 0n) { return ZERO; }
  return value.denominator < 0n
    ? Object.freeze({ numerator: -value.numerator, denominator: -value.denominator })
    : value;
}

/** Snapshots a rational as an immutable value whose reduction is deferred. */
export function deferExactRationalReduction(value: ExactRational): ExactRational {
  const normalizedValue = normalized(value);
  if (!normalizedValue) { throw new RangeError("Exact rational denominator must not be zero."); }
  return recordExactAlias(value, withDeferredReduction(normalizedValue));
}

/** Converts a finite binary64 value to its exact binary rational. */
export function numberToExactRational(value: number): ExactRational | null {
  if (!Number.isFinite(value)) { return null; }
  if (value === 0) { return ZERO; }

  binary64View.setFloat64(0, value, false);
  const highWord = binary64View.getUint32(0, false);
  const lowWord = binary64View.getUint32(4, false);
  const negative = highWord >= 2 ** 31;
  const unsignedHighWord = highWord % (2 ** 31);
  const exponent = Math.floor(unsignedHighWord / (2 ** 20));
  const fractionHigh = unsignedHighWord % (2 ** 20);
  const fraction = BigInt(fractionHigh) * (2n ** 32n) + BigInt(lowWord);
  const significand = exponent === 0 ? fraction : TWO_TO_52 + fraction;
  const binaryExponent = exponent === 0 ? -1074 : exponent - 1075;
  const signedSignificand = negative ? -significand : significand;
  return binaryExponent >= 0
    ? rational(signedSignificand * (2n ** BigInt(binaryExponent)))
    : rational(signedSignificand, 2n ** BigInt(-binaryExponent));
}

/** Adds two exact rational values. */
export function addExactRational(left: ExactRational, right: ExactRational): ExactRational {
  return recordExactExpression("add", left, right, addRationalValue(left, right))!;
}

function addRationalValue(leftValue: ExactRational, rightValue: ExactRational): ExactRational {
  const left = normalized(leftValue);
  const right = normalized(rightValue);
  if (!left || !right) { throw new RangeError("Exact rational denominator must not be zero."); }
  const hasDeferredOperand = deferredRationals.has(left) || deferredRationals.has(right);
  if (left.numerator === 0n) {
    return hasDeferredOperand ? withDeferredReduction(right) : canonicalized(right);
  }
  if (right.numerator === 0n) {
    return hasDeferredOperand ? withDeferredReduction(left) : canonicalized(left);
  }
  if (reducedRationals.has(left) && reducedRationals.has(right)) {
    const commonDenominator = gcd(left.denominator, right.denominator);
    const numerator = left.numerator * integerQuotient(right.denominator, commonDenominator) +
      right.numerator * integerQuotient(left.denominator, commonDenominator);
    if (numerator === 0n) { return ZERO; }
    const sharedFactor = gcd(numerator, commonDenominator);
    return reducedRational(
      numerator / sharedFactor,
      integerQuotient(left.denominator, commonDenominator) * (right.denominator / sharedFactor),
    );
  }
  if (left.denominator === right.denominator) {
    const numerator = left.numerator + right.numerator;
    return hasDeferredOperand
      ? deferredRational(numerator, left.denominator)
      : rational(numerator, left.denominator);
  }
  const common = gcd(left.denominator, right.denominator);
  const leftScale = integerQuotient(right.denominator, common);
  const rightScale = integerQuotient(left.denominator, common);
  const numerator = left.numerator * leftScale + right.numerator * rightScale;
  const denominator = left.denominator * leftScale;
  return hasDeferredOperand
    ? deferredRational(numerator, denominator)
    : rational(numerator, denominator);
}

/** Sums rationals exactly, reducing the final result only once. */
export function sumExactRationals(values: readonly ExactRational[]): ExactRational {
  return recordExactSum(values, sumRationalValues(values));
}

function sumRationalValues(values: readonly ExactRational[]): ExactRational {
  let numerator = 0n;
  let denominator = 1n;
  let hasNonzeroValue = false;
  let firstNonzeroValue: ExactRational | null = null;
  let hasDeferredValue = false;
  for (const value of values) {
    const normalizedValue = normalized(value);
    if (!normalizedValue) { throw new RangeError("Exact rational denominator must not be zero."); }
    hasDeferredValue ||= deferredRationals.has(normalizedValue);
    if (normalizedValue.numerator === 0n) { continue; }
    if (!hasNonzeroValue) {
      numerator = normalizedValue.numerator;
      denominator = normalizedValue.denominator;
      firstNonzeroValue = normalizedValue;
      hasNonzeroValue = true;
      continue;
    }
    const commonDenominator = gcd(denominator, normalizedValue.denominator);
    numerator = numerator * integerQuotient(normalizedValue.denominator, commonDenominator) +
      normalizedValue.numerator * integerQuotient(denominator, commonDenominator);
    denominator = integerQuotient(denominator, commonDenominator) * normalizedValue.denominator;
  }
  if (!hasNonzeroValue || numerator === 0n) { return ZERO; }
  if (firstNonzeroValue && numerator === firstNonzeroValue.numerator &&
      denominator === firstNonzeroValue.denominator) {
    return hasDeferredValue
      ? withDeferredReduction(firstNonzeroValue)
      : canonicalized(firstNonzeroValue);
  }
  return hasDeferredValue
    ? deferredRational(numerator, denominator)
    : rational(numerator, denominator);
}

/** Subtracts two exact rational values. */
export function subtractExactRational(left: ExactRational, right: ExactRational): ExactRational {
  return recordExactExpression("subtract", left, right, subtractRationalValue(left, right))!;
}

function subtractRationalValue(left: ExactRational, right: ExactRational): ExactRational {
  const normalizedRight = normalized(right);
  if (!normalizedRight) { return addExactRational(left, right); }
  if (normalizedRight.numerator === 0n) { return addExactRational(left, ZERO); }
  const negated = deferredRationals.has(normalizedRight)
    ? deferredRational(-normalizedRight.numerator, normalizedRight.denominator)
    : reducedRationals.has(normalizedRight)
      ? reducedRational(-normalizedRight.numerator, normalizedRight.denominator)
      : { numerator: -normalizedRight.numerator, denominator: normalizedRight.denominator };
  return addExactRational(left, negated);
}

/** Multiplies two exact rational values with cross-cancellation. */
export function multiplyExactRational(left: ExactRational, right: ExactRational): ExactRational {
  return recordExactExpression("multiply", left, right, multiplyRationalValue(left, right))!;
}

function multiplyRationalValue(leftValue: ExactRational, rightValue: ExactRational): ExactRational {
  const left = normalized(leftValue);
  const right = normalized(rightValue);
  if (!left || !right) { throw new RangeError("Exact rational denominator must not be zero."); }
  if (left.numerator === 0n || right.numerator === 0n) { return ZERO; }
  const leftDeferred = deferredRationals.has(left);
  const rightDeferred = deferredRationals.has(right);
  const hasDeferredOperand = leftDeferred || rightDeferred;
  if (left.numerator === 1n && left.denominator === 1n) {
    return hasDeferredOperand ? withDeferredReduction(right) : canonicalized(right);
  }
  if (right.numerator === 1n && right.denominator === 1n) {
    return hasDeferredOperand ? withDeferredReduction(left) : canonicalized(left);
  }
  if (hasDeferredOperand) {
    return multiplyDeferredRationals(left, right, leftDeferred, rightDeferred);
  }
  if (
    left.denominator === right.denominator &&
    reducedRationals.has(left) &&
    reducedRationals.has(right)
  ) {
    return reducedRational(left.numerator * right.numerator, left.denominator * right.denominator);
  }
  if (reducedRationals.has(left) && reducedRationals.has(right)) {
    const sharedDenominator = gcd(left.denominator, right.denominator);
    const leftResidualDenominator = left.denominator / sharedDenominator;
    const rightResidualDenominator = right.denominator / sharedDenominator;
    // Each reduced numerator is coprime to the shared factor, so only the
    // opposite residual denominator can contribute a cross-cancellation.
    const firstCancellation = gcd(left.numerator, rightResidualDenominator);
    const secondCancellation = gcd(right.numerator, leftResidualDenominator);
    const numerator = integerQuotient(left.numerator, firstCancellation) * integerQuotient(right.numerator, secondCancellation);
    const denominator = sharedDenominator * sharedDenominator *
      (leftResidualDenominator / secondCancellation) *
      (rightResidualDenominator / firstCancellation);
    return reducedRational(numerator, denominator);
  }
  const firstCancellation = gcd(left.numerator, right.denominator);
  const secondCancellation = gcd(right.numerator, left.denominator);
  const numerator = integerQuotient(left.numerator, firstCancellation) * integerQuotient(right.numerator, secondCancellation);
  const denominator = integerQuotient(left.denominator, secondCancellation) * integerQuotient(right.denominator, firstCancellation);
  return rational(numerator, denominator);
}

/** Divides exact rational values, returning null when the divisor is zero. */
export function divideExactRational(left: ExactRational, right: ExactRational): ExactRational | null {
  return recordExactExpression("divide", left, right, divideRationalValue(left, right));
}

function divideRationalValue(
  leftValue: ExactRational,
  rightValue: ExactRational,
): ExactRational | null {
  const left = normalized(leftValue);
  const right = normalized(rightValue);
  if (!left || !right) { return null; }
  if (right.numerator === 0n) { return null; }
  if (left.numerator === 0n) { return ZERO; }
  const leftDeferred = deferredRationals.has(left);
  const rightDeferred = deferredRationals.has(right);
  const hasDeferredOperand = leftDeferred || rightDeferred;
  if (right.numerator === 1n && right.denominator === 1n) {
    return hasDeferredOperand ? withDeferredReduction(left) : canonicalized(left);
  }
  if (hasDeferredOperand) {
    return divideDeferredRationals(left, right, leftDeferred, rightDeferred);
  }
  const numeratorCancellation = gcd(left.numerator, right.numerator);
  const denominatorCancellation = gcd(right.denominator, left.denominator);
  let numerator = integerQuotient(left.numerator, numeratorCancellation) * integerQuotient(right.denominator, denominatorCancellation);
  let denominator = integerQuotient(left.denominator, denominatorCancellation) * integerQuotient(right.numerator, numeratorCancellation);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  if (reducedRationals.has(left) && reducedRationals.has(right)) {
    return reducedRational(numerator, denominator);
  }
  return rational(numerator, denominator);
}

function roundPositiveRatio(numerator: bigint, denominator: bigint) {
  const [quotient, remainder] = positiveQuotientAndRemainder(numerator, denominator);
  const doubledRemainder = remainder * 2n;
  return doubledRemainder > denominator ||
    (doubledRemainder === denominator && quotient % 2n === 1n)
    ? quotient + 1n
    : quotient;
}

/** Divides positive integers, certifying a small leading-word quotient exactly. */
function positiveQuotientAndRemainder(numerator: bigint, denominator: bigint): [bigint, bigint] {
  if (numerator < denominator) { return [0n, numerator]; }
  if (denominator >= MAX_SMALL_DEFERRED_OPERAND) {
    let shift = bitLength(denominator) - 128;
    // biome-ignore lint/suspicious/noBitwiseOperators: exact BigInt shift extracts the leading integer words
    const leadingNumerator = numerator >> BigInt(shift);
    // Retain guard bits beyond the quotient's width, including for exact
    // denominator divisions with a larger-than-binary64 quotient.
    shift = Math.max(0, shift - Math.max(0, bitLength(leadingNumerator) - 128));
    const shiftAmount = BigInt(shift);
    // biome-ignore lint/suspicious/noBitwiseOperators: exact BigInt shifts estimate an integer quotient, never a rational result
    let quotient = (numerator >> shiftAmount) / (denominator >> shiftAmount);
    let remainder = numerator - quotient * denominator;
    if (remainder < 0n) { quotient -= 1n; remainder += denominator; }
    else if (remainder >= denominator) { quotient += 1n; remainder -= denominator; }
    // This certificate alone authorizes the result. Truncated leading words
    // cannot change the answer, including at an integer or rounding midpoint.
    if (remainder >= 0n && remainder < denominator) { return [quotient, remainder]; }
  }
  const quotient = numerator / denominator;
  return [quotient, numerator - quotient * denominator];
}

function integerQuotient(numerator: bigint, denominator: bigint) {
  if (denominator === 1n) { return numerator; }
  if (denominator < MAX_SMALL_DEFERRED_OPERAND) { return numerator / denominator; }
  const [quotient] = positiveQuotientAndRemainder(absolute(numerator), denominator);
  return numerator < 0n ? -quotient : quotient;
}

function bitLength(value: bigint) {
  let magnitude = absolute(value);
  if (magnitude === 0n) { return 1; }
  let upperBits = 32;
  let thresholdIndex = 0;
  while (magnitude >= bitLengthThresholds[thresholdIndex]!) {
    upperBits *= 2;
    thresholdIndex += 1;
    if (thresholdIndex === bitLengthThresholds.length) {
      bitLengthThresholds.push(2n ** BigInt(upperBits));
    }
  }
  let length = 0;
  for (let shift = upperBits / 2; shift >= 32; shift /= 2) {
    // biome-ignore lint/suspicious/noBitwiseOperators: exact shifts locate the highest nonzero integer word
    const leading = magnitude >> BigInt(shift);
    if (leading !== 0n) { magnitude = leading; length += shift; }
  }
  // The remaining word fits uint32 exactly; no rational is projected here.
  return length + 32 - Math.clz32(Number(magnitude));
}

function integerSquareRoot(value: bigint) {
  if (value < 2n) { return value; }
  let estimate = 2n ** BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    const next = (estimate + value / estimate) / 2n;
    if (next >= estimate) { return estimate; }
    estimate = next;
  }
}

function floorLog2Ratio(numerator: bigint, denominator: bigint) {
  let exponent = bitLength(numerator) - bitLength(denominator);
  const belowPower = exponent >= 0
    ? numerator < denominator * (2n ** BigInt(exponent))
    : numerator * (2n ** BigInt(-exponent)) < denominator;
  if (belowPower) { exponent -= 1; }
  return exponent;
}

/** Exact floor(log2(abs(value))), with null for zero or an invalid rational. */
export function exactRationalMagnitudeExponent(value: ExactRational): number | null {
  const input = normalized(value);
  return !input || input.numerator === 0n
    ? null
    : floorLog2Ratio(absolute(input.numerator), input.denominator);
}

/** Rounds a significand while preserving its exponent beyond binary64's range. */
export function roundExactRationalSignificand(value: ExactRational, significantBits: number): ExactRational {
  if (!Number.isSafeInteger(significantBits) || significantBits < 2) {
    throw new RangeError("Exact rational precision must be an integer of at least two bits.");
  }
  const input = normalized(value);
  if (!input) { throw new RangeError("Exact rational denominator must not be zero."); }
  if (input.numerator === 0n) { return ZERO; }
  const magnitude = absolute(input.numerator);
  const exponent = floorLog2Ratio(magnitude, input.denominator);
  const shift = significantBits - 1 - exponent;
  const numerator = shift >= 0 ? magnitude * 2n ** BigInt(shift) : magnitude;
  const denominator = shift >= 0 ? input.denominator : input.denominator * 2n ** BigInt(-shift);
  const significand = roundPositiveRatio(numerator, denominator) * (input.numerator < 0n ? -1n : 1n);
  return shift >= 0
    ? rational(significand, 2n ** BigInt(shift))
    : rational(significand * 2n ** BigInt(-shift));
}

/** Rounds one exact rational to binary64 using round-to-nearest, ties-to-even. */
export function exactRationalToNumber(value: ExactRational): number {
  if (reducedRationals.has(value) || deferredRationals.has(value)) {
    const cached = exactRationalNumberCache.get(value);
    if (cached !== undefined) { return cached; }
    const result = exactRationalToNumberUncached(value);
    exactRationalNumberCache.set(value, result);
    return result;
  }
  return exactRationalToNumberUncached(value);
}

function exactRationalToNumberUncached(value: ExactRational): number {
  const normalizedValue = normalized(value);
  if (!normalizedValue) { return Number.NaN; }
  const { numerator, denominator } = normalizedValue;
  if (numerator === 0n) { return 0; }
  const negative = numerator < 0n;
  const magnitude = absolute(numerator);
  let exponent = floorLog2Ratio(magnitude, denominator);

  if (exponent < -1022) {
    if (exponent < -1075) { return negative ? -0 : 0; }
    const subnormalUnits = roundPositiveRatio(magnitude * TWO_TO_1074, denominator);
    const rounded = Number(subnormalUnits) * Number.MIN_VALUE;
    return negative ? -rounded : rounded;
  }

  const shift = 52 - exponent;
  const scaledNumerator = shift >= 0 ? magnitude * (2n ** BigInt(shift)) : magnitude;
  const scaledDenominator = shift >= 0 ? denominator : denominator * (2n ** BigInt(-shift));
  let significand = roundPositiveRatio(scaledNumerator, scaledDenominator);
  if (significand === TWO_TO_53) {
    significand = TWO_TO_52;
    exponent += 1;
  }
  if (exponent > 1023) { return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY; }
  const rounded = Number(significand) * 2 ** (exponent - 52);
  return negative ? -rounded : rounded;
}

interface PositiveScaledBounds {
  lower: bigint;
  upper: bigint;
}

function positiveRationalBoundsAtScale(value: ExactRational, binaryScale: number): PositiveScaledBounds | null {
  const normalizedValue = normalized(value);
  if (!normalizedValue || normalizedValue.numerator === 0n) { return null; }
  const numerator = absolute(normalizedValue.numerator);
  const denominator = normalizedValue.denominator;
  const scaledNumerator = binaryScale < 0
    ? numerator * (2n ** BigInt(-binaryScale))
    : numerator;
  const scaledDenominator = binaryScale > 0
    ? denominator * (2n ** BigInt(binaryScale))
    : denominator;
  const [lower, remainder] = positiveQuotientAndRemainder(scaledNumerator, scaledDenominator);
  const upper = remainder === 0n ? lower : lower + 1n;
  return { lower, upper };
}

function scaledIntegerToRational(value: bigint, binaryScale: number): ExactRational {
  return binaryScale >= 0
    ? { numerator: value * (2n ** BigInt(binaryScale)), denominator: 1n }
    : { numerator: value, denominator: 2n ** BigInt(-binaryScale) };
}

function productBoundsToNumbers(
  left: PositiveScaledBounds,
  right: PositiveScaledBounds,
  binaryScale: number,
): [number, number] {
  return [
    exactRationalToNumber(scaledIntegerToRational(left.lower * right.lower, binaryScale)),
    exactRationalToNumber(scaledIntegerToRational(left.upper * right.upper, binaryScale)),
  ];
}

/** Rounds an exact product to binary64 without constructing its full rational product when certifiable. */
export function exactRationalProductToNumber(left: ExactRational, right: ExactRational): number {
  const leftApproximation = exactRationalToNumber(left);
  const rightApproximation = exactRationalToNumber(right);
  const leftMagnitude = Math.abs(leftApproximation);
  const rightMagnitude = Math.abs(rightApproximation);
  const fallback = () => exactRationalToNumber(multiplyExactRational(left, right));
  if (
    !Number.isFinite(leftApproximation) ||
    !Number.isFinite(rightApproximation) ||
    leftMagnitude === 0 ||
    rightMagnitude === 0 ||
    leftMagnitude < MIN_NORMAL_BINARY64 ||
    rightMagnitude < MIN_NORMAL_BINARY64
  ) {
    return fallback();
  }

  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  if (!normalizedLeft || !normalizedRight) { return fallback(); }
  if (
    (absolute(normalizedLeft.numerator) < MAX_PRODUCT_INTERVAL_SMALL_OPERAND &&
      normalizedLeft.denominator < MAX_PRODUCT_INTERVAL_SMALL_OPERAND) ||
    (absolute(normalizedRight.numerator) < MAX_PRODUCT_INTERVAL_SMALL_OPERAND &&
      normalizedRight.denominator < MAX_PRODUCT_INTERVAL_SMALL_OPERAND)
  ) {
    return fallback();
  }

  const leftScale = Math.floor(Math.log2(leftMagnitude)) - 80;
  const rightScale = Math.floor(Math.log2(rightMagnitude)) - 80;
  const leftBounds = positiveRationalBoundsAtScale(normalizedLeft, leftScale);
  const rightBounds = positiveRationalBoundsAtScale(normalizedRight, rightScale);
  if (!leftBounds || !rightBounds) { return fallback(); }

  const [lower, upper] = productBoundsToNumbers(leftBounds, rightBounds, leftScale + rightScale);
  if (lower !== upper) { return fallback(); }
  const negative = (normalizedLeft.numerator < 0n) !== (normalizedRight.numerator < 0n);
  return negative ? -lower : lower;
}

function roundScaledSquareRoot(numerator: bigint, denominator: bigint, binaryScale: number) {
  let scaledNumerator = numerator;
  let scaledDenominator = denominator;
  if (binaryScale >= 0) {
    scaledNumerator *= 2n ** BigInt(2 * binaryScale);
  } else {
    scaledDenominator *= 2n ** BigInt(-2 * binaryScale);
  }
  const floor = integerSquareRoot(scaledNumerator / scaledDenominator);
  const twiceMidpointNumerator = 4n * scaledNumerator;
  const twiceMidpointDenominator = scaledDenominator * (2n * floor + 1n) ** 2n;
  return twiceMidpointNumerator > twiceMidpointDenominator ||
    (twiceMidpointNumerator === twiceMidpointDenominator && floor % 2n === 1n)
    ? floor + 1n
    : floor;
}

/** Floors sqrt(value) to a binary rational at the requested fractional precision. */
export function floorExactRationalSquareRoot(value: ExactRational, fractionalBits: number): ExactRational | null {
  const normalizedValue = normalized(value);
  if (!normalizedValue || normalizedValue.numerator < 0n || !Number.isSafeInteger(fractionalBits) || fractionalBits < 0) { return null; }
  const scale = 2n ** BigInt(fractionalBits);
  return rational(integerSquareRoot((normalizedValue.numerator * scale * scale) / normalizedValue.denominator), scale);
}

/**
 * Returns a rational square root exactly when possible; otherwise floors it
 * with relative error below 2^-relativeBits, preserving its departure from
 * one to the same accuracy. An optional absolute error bound
 * 2^absoluteErrorExponent protects a subsequent cancelling sum.
 */
export function floorExactRationalSquareRootWithRelativeError(
  value: ExactRational,
  relativeBits: number,
  absoluteErrorExponent?: number,
): ExactRational | null {
  const input = normalized(value);
  if (!input || input.numerator < 0n || !Number.isSafeInteger(relativeBits) || relativeBits < 2 ||
      (absoluteErrorExponent !== undefined && !Number.isSafeInteger(absoluteErrorExponent))) { return null; }
  if (input.numerator === 0n) { return ZERO; }
  // A non-binary rational root must stay exact too: a floor can otherwise
  // move a later exact binary64 midpoint to the wrong side of its tie.
  const exactRoot = exactRationalSquareRoot(input);
  if (exactRoot) { return exactRoot; }
  const rootExponent = Math.floor(floorLog2Ratio(input.numerator, input.denominator) / 2);
  let fractionalBits = Math.max(0, relativeBits - rootExponent, -(absoluteErrorExponent ?? 0));
  const difference = absolute(input.numerator - input.denominator);
  if (difference !== 0n) {
    // |sqrt(value)-1| = |value-1|/(sqrt(value)+1). The denominator is
    // below 2^(max(rootExponent,0)+2); the numerator is at least 2^gapExponent.
    const gapExponent = floorLog2Ratio(difference, input.denominator);
    fractionalBits = Math.max(fractionalBits, relativeBits + Math.max(rootExponent, 0) + 2 - gapExponent);
  }
  return floorExactRationalSquareRoot(input, fractionalBits);
}

/** Returns the exact nonnegative rational root, or null for an irrational root. */
export function exactRationalSquareRoot(value: ExactRational): ExactRational | null {
  const input = normalized(value);
  if (!input || input.numerator < 0n) { return null; }
  const reduced = canonicalized(input);
  const numerator = integerSquareRoot(reduced.numerator);
  if (numerator * numerator !== reduced.numerator) { return null; }
  const denominator = integerSquareRoot(reduced.denominator);
  return denominator * denominator === reduced.denominator
    ? reducedRational(numerator, denominator) : null;
}

/** Rounds the square root of an exact nonnegative rational to binary64. */
export function exactRationalSquareRootToNumber(value: ExactRational): number {
  const normalizedValue = normalized(value);
  if (!normalizedValue || normalizedValue.numerator < 0n) { return Number.NaN; }
  if (normalizedValue.numerator === 0n) { return 0; }

  const { numerator, denominator } = normalizedValue;
  const exponent = Math.floor(floorLog2Ratio(numerator, denominator) / 2);
  if (exponent > 1023) { return Number.POSITIVE_INFINITY; }
  if (exponent < -1022) {
    const subnormalUnits = roundScaledSquareRoot(numerator, denominator, 1074);
    return Number(subnormalUnits) * Number.MIN_VALUE;
  }

  const significand = roundScaledSquareRoot(numerator, denominator, 52 - exponent);
  return Number(significand) * 2 ** (exponent - 52);
}

export function addExactComplex(left: ExactComplexValue, right: ExactComplexValue): ExactComplexValue {
  return {
    real: addExactRational(left.real, right.real),
    imaginary: addExactRational(left.imaginary, right.imaginary),
  };
}

export function subtractExactComplex(left: ExactComplexValue, right: ExactComplexValue): ExactComplexValue {
  return {
    real: subtractExactRational(left.real, right.real),
    imaginary: subtractExactRational(left.imaginary, right.imaginary),
  };
}

export function multiplyExactComplex(left: ExactComplexValue, right: ExactComplexValue): ExactComplexValue {
  const real = subtractExactRational(
    multiplyExactRational(left.real, right.real),
    multiplyExactRational(left.imaginary, right.imaginary),
  );
  const imaginary = addExactRational(
    multiplyExactRational(left.real, right.imaginary),
    multiplyExactRational(left.imaginary, right.real),
  );
  return { real, imaginary };
}

export function divideExactComplex(
  left: ExactComplexValue,
  right: ExactComplexValue,
): ExactComplexValue | null {
  const denominator = addExactRational(
    multiplyExactRational(right.real, right.real),
    multiplyExactRational(right.imaginary, right.imaginary),
  );
  if (denominator.numerator === 0n) { return null; }
  const realNumerator = addExactRational(
    multiplyExactRational(left.real, right.real),
    multiplyExactRational(left.imaginary, right.imaginary),
  );
  const imaginaryNumerator = subtractExactRational(
    multiplyExactRational(left.imaginary, right.real),
    multiplyExactRational(left.real, right.imaginary),
  );
  const real = divideExactRational(realNumerator, denominator);
  const imaginary = divideExactRational(imaginaryNumerator, denominator);
  return real && imaginary ? { real, imaginary } : null;
}

export function exactComplexToNumber(value: ExactComplexValue): ComplexValue {
  return {
    real: exactRationalToNumber(value.real),
    imaginary: exactRationalToNumber(value.imaginary),
  };
}

type ExactRealArray = Float64Array | readonly ExactRational[];

function validExactRealArray(length: number, values: ExactRealArray) {
  return values.length === length &&
    (values instanceof Float64Array
      ? values.every(Number.isFinite)
      : values.every((value) => normalized(value) !== null));
}

function validExactRealInput(size: number, matrix: ExactRealArray, rhs: ExactRealArray) {
  return Number.isSafeInteger(size) && size >= 0 &&
    validExactRealArray(size * size, matrix) && validExactRealArray(size, rhs);
}

type IntegerRow = Map<number, bigint>;
type RationalRow = Map<number, ExactRational>;

function exactRealValueAt(values: ExactRealArray, index: number, missingNumber: number) {
  if (values instanceof Float64Array) {
    return numberToExactRational(values[index] ?? missingNumber);
  }
  const value = values[index];
  return value ? normalized(value) : null;
}

function exactCoefficientsForRow(size: number, matrix: ExactRealArray, rowIndex: number) {
  const coefficients = new Map<number, ExactRational>();
  for (let column = 0; column < size; column += 1) {
    const exactValue = exactRealValueAt(matrix, rowIndex * size + column, 0);
    if (!exactValue) { return null; }
    if (exactValue.numerator !== 0n) { coefficients.set(column, exactValue); }
  }
  return coefficients;
}

function exactRightHandSideAt(rhs: ExactRealArray, rowIndex: number) {
  return exactRealValueAt(rhs, rowIndex, Number.NaN);
}

function rationalRowsFromInput(size: number, matrix: ExactRealArray, rhs: ExactRealArray): RationalRow[] | null {
  const rows: RationalRow[] = [];
  for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
    const coefficients = exactCoefficientsForRow(size, matrix, rowIndex);
    const exactRhs = exactRightHandSideAt(rhs, rowIndex);
    if (!coefficients || !exactRhs) { return null; }
    const row = coefficients;
    if (exactRhs.numerator !== 0n) { row.set(size, exactRhs); }
    rows.push(row);
  }
  return rows;
}

function rationalMatrixNonzeroCount(size: number, matrix: ExactRealArray) {
  let count = 0;
  for (let index = 0; index < size * size; index += 1) {
    if (matrix instanceof Float64Array) {
      if ((matrix[index] ?? 0) !== 0) { count += 1; }
    } else if ((matrix[index]?.numerator ?? 0n) !== 0n) {
      count += 1;
    }
  }
  return count;
}

function findSparsePivotRow(rows: RationalRow[], column: number, size: number) {
  let pivotRow = -1;
  let pivotFill = Number.POSITIVE_INFINITY;
  for (let rowIndex = column; rowIndex < size; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row?.has(column)) { continue; }
    let fill = 0;
    for (const targetColumn of row.keys()) {
      if (targetColumn > column && targetColumn < size) { fill += 1; }
    }
    if (fill < pivotFill) {
      pivotRow = rowIndex;
      pivotFill = fill;
    }
  }
  return pivotRow;
}

function eliminateSparseRows(rows: RationalRow[], column: number, pivotEquation: RationalRow, pivot: ExactRational) {
  for (let rowIndex = column + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const leading = row?.get(column);
    if (!row || !leading) { continue; }
    const factor = divideExactRational(leading, pivot);
    if (!factor) { return false; }
    row.delete(column);
    for (const [targetColumn, pivotValue] of pivotEquation) {
      if (targetColumn <= column) { continue; }
      const current = row.get(targetColumn) ?? ZERO;
      const value = subtractExactRational(current, multiplyExactRational(factor, pivotValue));
      if (value.numerator === 0n) { row.delete(targetColumn); }
      else { row.set(targetColumn, value); }
    }
  }
  return true;
}

function backSubstituteSparseRationalRows(rows: RationalRow[], size: number): ExactRational[] | null {
  const solution: ExactRational[] = Array.from({ length: size }, () => ZERO);
  for (let rowIndex = size - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    const diagonal = row?.get(rowIndex);
    if (!row || !diagonal) { return null; }
    let residual = row.get(size) ?? ZERO;
    for (const [column, coefficient] of row) {
      if (column <= rowIndex || column >= size) { continue; }
      residual = subtractExactRational(
        residual,
        multiplyExactRational(coefficient, solution[column] ?? ZERO),
      );
    }
    const value = divideExactRational(residual, diagonal);
    if (!value) { return null; }
    solution[rowIndex] = value;
  }
  return solution;
}

function solveSparseRationalRows(rows: RationalRow[], size: number): ExactRational[] | null {
  for (let column = 0; column < size; column += 1) {
    const pivotRow = findSparsePivotRow(rows, column, size);
    if (pivotRow < 0) { return null; }
    if (pivotRow !== column) { [rows[column], rows[pivotRow]] = [rows[pivotRow]!, rows[column]!]; }
    const pivotEquation = rows[column];
    const pivot = pivotEquation?.get(column);
    if (!pivotEquation || !pivot || !eliminateSparseRows(rows, column, pivotEquation, pivot)) { return null; }
  }
  return backSubstituteSparseRationalRows(rows, size);
}

interface ScaledIntegerRows {
  rows: IntegerRow[];
  rhsScale: bigint;
  rhsExpressions?: Map<IntegerRow, ExactExpressionHandle>;
}

interface IntegerizedRow {
  coefficients: IntegerRow;
  scaledRhs: ExactRational;
}

function integerizeRow(coefficients: Map<number, ExactRational>, rhs: ExactRational): IntegerizedRow {
  let rowDenominator = 1n;
  for (const value of coefficients.values()) {
    rowDenominator = (rowDenominator / gcd(rowDenominator, value.denominator)) * value.denominator;
  }
  const integerCoefficients: IntegerRow = new Map();
  let content = 0n;
  for (const [column, value] of coefficients) {
    const integerValue = value.numerator * (rowDenominator / value.denominator);
    if (integerValue !== 0n) {
      integerCoefficients.set(column, integerValue);
      content = gcd(content, integerValue);
    }
  }
  const rowContent = content || 1n;
  if (rowContent > 1n) {
    for (const [column, value] of integerCoefficients) {
      integerCoefficients.set(column, value / rowContent);
    }
  }
  return {
    coefficients: integerCoefficients,
    scaledRhs: exactExpressionCaptureIsActive()
      ? multiplyExactRational(rhs, rational(rowDenominator, rowContent))
      : rational(rhs.numerator * rowDenominator, rhs.denominator * rowContent),
  };
}

function integerRowsFromInput(size: number, matrix: ExactRealArray, rhs: ExactRealArray): ScaledIntegerRows | null {
  const integerizedRows: IntegerizedRow[] = [];
  let rhsScale = 1n;
  for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
    const coefficients = exactCoefficientsForRow(size, matrix, rowIndex);
    const exactRhs = exactRightHandSideAt(rhs, rowIndex);
    if (!coefficients || !exactRhs) { return null; }
    const integerized = integerizeRow(coefficients, exactRhs);
    integerizedRows.push(integerized);
    rhsScale = (rhsScale / gcd(rhsScale, integerized.scaledRhs.denominator)) * integerized.scaledRhs.denominator;
  }
  const rhsExpressions = exactExpressionCaptureIsActive() ? new Map<IntegerRow, ExactExpressionHandle>() : undefined;
  const rows = integerizedRows.map(({ coefficients, scaledRhs }) => {
    const integerRhs = scaledRhs.numerator * (rhsScale / scaledRhs.denominator);
    if (integerRhs !== 0n) { coefficients.set(size, integerRhs); }
    if (rhsExpressions) {
      rhsExpressions.set(coefficients, exactExpressionHandle(scaledRhs));
    }
    return coefficients;
  });
  return { rows, rhsScale, rhsExpressions };
}

function findPivotRow(rows: IntegerRow[], column: number, size: number) {
  let pivotRow = -1;
  let pivotBits = Number.POSITIVE_INFINITY;
  let pivotMagnitude = 0n;
  for (let rowIndex = column; rowIndex < size; rowIndex += 1) {
    const candidate = rows[rowIndex]?.get(column) ?? 0n;
    if (candidate === 0n) { continue; }
    const candidateBits = bitLength(candidate);
    const candidateMagnitude = absolute(candidate);
    if (candidateBits < pivotBits || (candidateBits === pivotBits && candidateMagnitude < pivotMagnitude)) {
      pivotRow = rowIndex;
      pivotBits = candidateBits;
      pivotMagnitude = candidateMagnitude;
    }
  }
  return pivotRow;
}

function setIntegerCoefficient(row: IntegerRow, column: number, value: bigint) {
  if (value === 0n) { row.delete(column); }
  else { row.set(column, value); }
}

function eliminateIntegerRow(row: IntegerRow, pivotEquation: IntegerRow, column: number, pivot: bigint, previousPivot: bigint, rhsExpressions?: Map<IntegerRow, ExactExpressionHandle>) {
  const leading = row.get(column) ?? 0n;
  if (leading === 0n && pivot === previousPivot) { return true; }
  if (rhsExpressions) {
    const current = rhsExpressions.get(row) ?? exactExpressionHandle(ZERO);
    const pivotRhs = rhsExpressions.get(pivotEquation) ?? exactExpressionHandle(ZERO);
    const left = combineExactExpressionHandles("multiply", exactExpressionHandle(rational(pivot)), current);
    const right = combineExactExpressionHandles("multiply", exactExpressionHandle(rational(leading)), pivotRhs);
    const numerator = combineExactExpressionHandles("subtract", left, right);
    const next = combineExactExpressionHandles("divide", numerator, exactExpressionHandle(rational(previousPivot)));
    rhsExpressions.set(row, next);
  }
  const targetColumns = new Set<number>();
  for (const targetColumn of row.keys()) {
    if (targetColumn > column) { targetColumns.add(targetColumn); }
  }
  for (const targetColumn of pivotEquation.keys()) {
    if (targetColumn > column) { targetColumns.add(targetColumn); }
  }
  for (const targetColumn of targetColumns) {
    const current = row.get(targetColumn) ?? 0n;
    const pivotValue = pivotEquation.get(targetColumn) ?? 0n;
    const numerator = pivot * current - leading * pivotValue;
    if (numerator % previousPivot !== 0n) { return false; }
    setIntegerCoefficient(row, targetColumn, numerator / previousPivot);
  }
  row.delete(column);
  return true;
}

function eliminateRowsBelow(rows: IntegerRow[], column: number, pivotEquation: IntegerRow, pivot: bigint, previousPivot: bigint, size: number, rhsExpressions?: Map<IntegerRow, ExactExpressionHandle>) {
  for (let rowIndex = column + 1; rowIndex < size; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || !eliminateIntegerRow(row, pivotEquation, column, pivot, previousPivot, rhsExpressions)) { return false; }
  }
  return true;
}

function backSubstituteIntegerRows(rows: IntegerRow[], size: number) {
  const solution: ExactRational[] = Array.from({ length: size }, () => ZERO);
  for (let rowIndex = size - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    const diagonal = row?.get(rowIndex);
    if (!row || diagonal === undefined || diagonal === 0n) { return null; }
    let residual = rational(row.get(size) ?? 0n);
    for (const [column, coefficient] of row) {
      if (column <= rowIndex) { continue; }
      residual = subtractExactRational(
        residual,
        multiplyExactRational(rational(coefficient), solution[column] ?? ZERO),
      );
    }
    const value = divideExactRational(residual, rational(diagonal));
    if (!value) { return null; }
    solution[rowIndex] = value;
  }
  return solution;
}

function integerSolutionExpressions(rows: IntegerRow[], size: number, rhsExpressions: ReadonlyMap<IntegerRow, ExactExpressionHandle>) {
  const values: ExactExpressionHandle[] = Array.from({ length: size }, () => exactExpressionHandle(ZERO));
  for (let rowIndex = size - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex]!;
    let value = rhsExpressions.get(row) ?? exactExpressionHandle(ZERO);
    for (const [column, coefficient] of row) {
      if (column <= rowIndex || column >= size) { continue; }
      const product = combineExactExpressionHandles("multiply", exactExpressionHandle(rational(coefficient)), values[column]!);
      value = combineExactExpressionHandles("subtract", value, product);
    }
    values[rowIndex] = combineExactExpressionHandles("divide", value, exactExpressionHandle(rational(row.get(rowIndex)!)));
  }
  return values;
}

function solveExactRealLinearSystemUnchecked(
  size: number,
  matrix: ExactRealArray,
  rhs: ExactRealArray,
): ExactRational[] | null {
  if (!validExactRealInput(size, matrix, rhs)) { return null; }
  if (size === 0) { return []; }
  if (rationalMatrixNonzeroCount(size, matrix) * 4 <= size * size) {
    const rationalRows = rationalRowsFromInput(size, matrix, rhs);
    return rationalRows ? solveSparseRationalRows(rationalRows, size) : null;
  }
  const integerized = integerRowsFromInput(size, matrix, rhs);
  if (!integerized) { return null; }
  const { rows, rhsScale, rhsExpressions } = integerized;

  let previousPivot = 1n;
  for (let column = 0; column < size; column += 1) {
    const pivotRow = findPivotRow(rows, column, size);
    if (pivotRow < 0) { return null; }
    if (pivotRow !== column) {
      [rows[column], rows[pivotRow]] = [rows[pivotRow]!, rows[column]!];
    }
    const pivot = rows[column]?.get(column);
    const pivotEquation = rows[column];
    if (pivot === undefined || pivot === 0n || !pivotEquation) { return null; }
    if (column < size - 1 && !eliminateRowsBelow(rows, column, pivotEquation, pivot, previousPivot, size, rhsExpressions)) {
      return null;
    }
    previousPivot = pivot;
  }
  const scaledSolution = backSubstituteIntegerRows(rows, size);
  if (!scaledSolution) { return null; }
  const solution = rhsScale === 1n ? scaledSolution
    : scaledSolution.map((value) => rational(value.numerator, value.denominator * rhsScale));
  if (!rhsExpressions) { return solution; }
  const solutionExpressions = integerSolutionExpressions(rows, size, rhsExpressions);
  return solution.map((value, index) => retainExactExpressionHandle(value, solutionExpressions[index]!));
}

function exactEquationHolds(terms: readonly ExactRational[], rhs: ExactRational) {
  const sum = sumExactRationals(terms);
  if (sum.denominator === rhs.denominator) { return sum.numerator === rhs.numerator; }
  // Cancelling the positive common denominator preserves the exact equation
  // while avoiding products of two full transient-history-sized integers.
  const common = gcd(sum.denominator, rhs.denominator);
  return sum.numerator * integerQuotient(rhs.denominator, common) ===
    rhs.numerator * integerQuotient(sum.denominator, common);
}

/**
 * Checks the original equations without a tolerance or binary64 rounding.
 * This is separate from elimination so a solver optimization cannot silently
 * return an answer to a different system. Pass exact sidecar values here when
 * the matrix or solution was assembled through exact-numeric-state.
 */
export function isExactRealLinearSolution(
  size: number,
  matrix: ExactRealArray,
  rhs: ExactRealArray,
  solution: readonly ExactRational[],
): boolean {
  if (!validExactRealInput(size, matrix, rhs) || !validExactRealArray(size, solution)) { return false; }
  for (let row = 0; row < size; row += 1) {
    const terms: ExactRational[] = [];
    for (let column = 0; column < size; column += 1) {
      const coefficient = exactRealValueAt(matrix, row * size + column, 0);
      const value = solution[column];
      if (!coefficient || !value) { return false; }
      if (coefficient.numerator === 0n || value.numerator === 0n) { continue; }
      terms.push(multiplyExactRational(coefficient, value));
    }
    const expected = exactRightHandSideAt(rhs, row);
    if (!expected || !exactEquationHolds(terms, expected)) { return false; }
  }
  return true;
}

/** Solves and verifies an exact real system before exposing its rational answer. */
export function solveExactRealLinearSystem(
  size: number,
  matrix: ExactRealArray,
  rhs: ExactRealArray,
): ExactRational[] | null {
  const solution = solveExactRealLinearSystemUnchecked(size, matrix, rhs);
  return solution && isExactRealLinearSolution(size, matrix, rhs, solution) ? solution : null;
}

/** Solves a real system and rounds each exact result once to binary64. */
export function solveRealLinearSystem(
  size: number,
  matrix: ExactRealArray,
  rhs: ExactRealArray,
): Float64Array | null {
  const exact = solveExactRealLinearSystem(size, matrix, rhs);
  if (!exact) { return null; }
  const result = Float64Array.from(exact, exactRationalToNumber);
  return result.every(Number.isFinite) ? result : null;
}

function realifyNumberComplexSystem(
  size: number,
  matrixReal: Float64Array,
  matrixImaginary: Float64Array,
  rhsReal: Float64Array,
  rhsImaginary: Float64Array,
) {
  const realSize = size * 2;
  const matrix = new Float64Array(realSize * realSize);
  const rhs = new Float64Array(realSize);
  for (let row = 0; row < size; row += 1) {
    rhs[row] = rhsReal[row] ?? 0;
    rhs[row + size] = rhsImaginary[row] ?? 0;
    for (let column = 0; column < size; column += 1) {
      const index = row * size + column;
      const real = matrixReal[index] ?? 0;
      const imaginary = matrixImaginary[index] ?? 0;
      matrix[row * realSize + column] = real;
      matrix[row * realSize + column + size] = -imaginary;
      matrix[(row + size) * realSize + column] = imaginary;
      matrix[(row + size) * realSize + column + size] = real;
    }
  }
  return { matrix, rhs };
}

function negateExactRational(value: ExactRational): ExactRational {
  return { numerator: -value.numerator, denominator: value.denominator };
}

function realifyExactComplexSystem(
  size: number,
  matrixReal: ExactRealArray,
  matrixImaginary: ExactRealArray,
  rhsReal: ExactRealArray,
  rhsImaginary: ExactRealArray,
) {
  const realSize = size * 2;
  const matrix = Array.from({ length: realSize * realSize }, () => ZERO);
  const rhs = Array.from({ length: realSize }, () => ZERO);
  for (let row = 0; row < size; row += 1) {
    const realRhs = exactRealValueAt(rhsReal, row, Number.NaN);
    const imaginaryRhs = exactRealValueAt(rhsImaginary, row, Number.NaN);
    if (!realRhs || !imaginaryRhs) { return null; }
    rhs[row] = realRhs;
    rhs[row + size] = imaginaryRhs;
    for (let column = 0; column < size; column += 1) {
      const index = row * size + column;
      const real = exactRealValueAt(matrixReal, index, 0);
      const imaginary = exactRealValueAt(matrixImaginary, index, 0);
      if (!real || !imaginary) { return null; }
      matrix[row * realSize + column] = real;
      matrix[row * realSize + column + size] = negateExactRational(imaginary);
      matrix[(row + size) * realSize + column] = imaginary;
      matrix[(row + size) * realSize + column + size] = real;
    }
  }
  return { matrix, rhs };
}

function exactComplexEquationHolds(
  size: number,
  row: number,
  matrixReal: ExactRealArray,
  matrixImaginary: ExactRealArray,
  rhsReal: ExactRealArray,
  rhsImaginary: ExactRealArray,
  solution: readonly ExactComplexValue[],
) {
  const realTerms: ExactRational[] = [];
  const imaginaryTerms: ExactRational[] = [];
  for (let column = 0; column < size; column += 1) {
    const real = exactRealValueAt(matrixReal, row * size + column, 0);
    const imaginary = exactRealValueAt(matrixImaginary, row * size + column, 0);
    const value = solution[column];
    if (!real || !imaginary || !value) { return false; }
    if (real.numerator !== 0n) {
      realTerms.push(multiplyExactRational(real, value.real));
      imaginaryTerms.push(multiplyExactRational(real, value.imaginary));
    }
    if (imaginary.numerator !== 0n) {
      realTerms.push(negateExactRational(multiplyExactRational(imaginary, value.imaginary)));
      imaginaryTerms.push(multiplyExactRational(imaginary, value.real));
    }
  }
  const expectedReal = exactRightHandSideAt(rhsReal, row);
  const expectedImaginary = exactRightHandSideAt(rhsImaginary, row);
  return expectedReal !== null && expectedImaginary !== null &&
    exactEquationHolds(realTerms, expectedReal) && exactEquationHolds(imaginaryTerms, expectedImaginary);
}

/** Verifies the complex equations directly, independently of their realification. */
export function isExactComplexLinearSolution(
  size: number,
  matrixReal: ExactRealArray,
  matrixImaginary: ExactRealArray,
  rhsReal: ExactRealArray,
  rhsImaginary: ExactRealArray,
  solution: readonly ExactComplexValue[],
): boolean {
  if (!validExactRealInput(size, matrixReal, rhsReal) ||
      !validExactRealInput(size, matrixImaginary, rhsImaginary) ||
      solution.length !== size ||
      !solution.every((value) => value && normalized(value.real) !== null && normalized(value.imaginary) !== null)) {
    return false;
  }
  for (let row = 0; row < size; row += 1) {
    if (!exactComplexEquationHolds(size, row, matrixReal, matrixImaginary, rhsReal, rhsImaginary, solution)) {
      return false;
    }
  }
  return true;
}

/** Solves and verifies a complex system before exposing exact rectangular components. */
export function solveExactComplexLinearSystem(
  size: number,
  matrixReal: ExactRealArray,
  matrixImaginary: ExactRealArray,
  rhsReal: ExactRealArray,
  rhsImaginary: ExactRealArray,
): ExactComplexValue[] | null {
  if (!validExactRealInput(size, matrixReal, rhsReal) || !validExactRealInput(size, matrixImaginary, rhsImaginary)) {
    return null;
  }
  if (size === 0) { return []; }

  const realSize = size * 2;
  const inputArrays = [matrixReal, matrixImaginary, rhsReal, rhsImaginary];
  const usesExactRationals = inputArrays.some((values) => !(values instanceof Float64Array));
  const realSystem = usesExactRationals
    ? realifyExactComplexSystem(size, matrixReal, matrixImaginary, rhsReal, rhsImaginary)
    : realifyNumberComplexSystem(
      size,
      matrixReal as Float64Array,
      matrixImaginary as Float64Array,
      rhsReal as Float64Array,
      rhsImaginary as Float64Array,
    );
  if (!realSystem) { return null; }
  const exact = solveExactRealLinearSystemUnchecked(realSize, realSystem.matrix, realSystem.rhs);
  if (!exact) { return null; }
  const solution = Array.from({ length: size }, (_, index) => ({
    real: exact[index] ?? ZERO,
    imaginary: exact[index + size] ?? ZERO,
  }));
  return isExactComplexLinearSolution(size, matrixReal, matrixImaginary, rhsReal, rhsImaginary, solution)
    ? solution
    : null;
}

/** Solves a complex system and rounds each exact result once to binary64. */
export function solveComplexLinearSystem(
  size: number,
  matrixReal: ExactRealArray,
  matrixImaginary: ExactRealArray,
  rhsReal: ExactRealArray,
  rhsImaginary: ExactRealArray,
): ComplexValue[] | null {
  const exact = solveExactComplexLinearSystem(size, matrixReal, matrixImaginary, rhsReal, rhsImaginary);
  if (!exact) { return null; }
  const result = exact.map(exactComplexToNumber);
  return result.every((value) => Number.isFinite(value.real) && Number.isFinite(value.imaginary))
    ? result
    : null;
}
