// biome-ignore-all lint/suspicious/noBitwiseOperators: Bit operations decode IEEE-754 values and generate seeded binary64 cases.
/**
 * Small, independent binary64 oracle for numerical contract tests.
 *
 * This module intentionally does not import production arithmetic. It models
 * every finite binary64 input as an exact BigInt rational and checks a result
 * by comparing it with the midpoints around that result.
 */

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const SIGN_MASK = 1n << 63n;
const FRACTION_MASK = (1n << 52n) - 1n;
const EXPONENT_MASK = 0x7ffn;
const UINT64_MASK = (1n << 64n) - 1n;
const ZERO: Rational = { numerator: 0n, denominator: 1n };
const TWO: Rational = { numerator: 2n, denominator: 1n };
const bitsBuffer = new ArrayBuffer(8);
const bitsView = new DataView(bitsBuffer);

function greatestCommonDivisor(left: bigint, right: bigint) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) { throw new Error("Rational denominator is zero"); }
  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  if (signedNumerator === 0n) { return ZERO; }
  const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator);
  return {
    numerator: signedNumerator / divisor,
    denominator: positiveDenominator / divisor,
  };
}

export function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function divideRational(left: Rational, right: Rational): Rational {
  if (right.numerator === 0n) { throw new Error("Cannot divide by zero"); }
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

export function negateRational(value: Rational): Rational {
  return rational(-value.numerator, value.denominator);
}

export function compareRational(left: Rational, right: Rational): -1 | 0 | 1 {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function midpointRational(left: Rational, right: Rational): Rational {
  return divideRational(addRational(left, right), TWO);
}

export function rationalFromNumber(value: number): Rational | null {
  if (!Number.isFinite(value)) { return null; }
  const bits = bitsOf(value);
  const negative = (bits & SIGN_MASK) !== 0n;
  const exponentField = Number((bits >> 52n) & EXPONENT_MASK);
  const fraction = bits & FRACTION_MASK;
  if (exponentField === 0 && fraction === 0n) { return ZERO; }

  const significand = exponentField === 0 ? fraction : (1n << 52n) | fraction;
  const exponent = exponentField === 0 ? -1074 : exponentField - 1023 - 52;
  const signedSignificand = negative ? -significand : significand;
  return exponent >= 0
    ? rational(signedSignificand << BigInt(exponent))
    : rational(signedSignificand, 1n << BigInt(-exponent));
}

export function bitsOf(value: number): bigint {
  bitsView.setFloat64(0, value, false);
  return bitsView.getBigUint64(0, false);
}

export function floatFromBits(bits: bigint): number {
  bitsView.setBigUint64(0, bits & UINT64_MASK, false);
  return bitsView.getFloat64(0, false);
}

export function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) { return value; }
  if (value === 0) { return Number.MIN_VALUE; }
  const bits = bitsOf(value);
  return floatFromBits(value > 0 ? bits + 1n : bits - 1n);
}

export function nextDown(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) { return value; }
  if (value === 0) { return -Number.MIN_VALUE; }
  const bits = bitsOf(value);
  return floatFromBits(value > 0 ? bits - 1n : bits + 1n);
}

function powerOfTwo(exponent: number): Rational {
  return exponent >= 0
    ? rational(1n << BigInt(exponent))
    : rational(1n, 1n << BigInt(-exponent));
}

function virtualAdjacent(value: number, direction: "down" | "up"): Rational {
  const adjacent = direction === "down" ? nextDown(value) : nextUp(value);
  if (Number.isFinite(adjacent)) { return rationalFromNumber(adjacent) as Rational; }
  const endpoint = powerOfTwo(1024);
  return value < 0 ? negateRational(endpoint) : endpoint;
}

function isEvenSignificand(value: number) {
  return (bitsOf(value) & 1n) === 0n;
}

function failRounding(label: string, actual: number, reason: string): never {
  throw new Error(`${label}: ${reason}; actual=${String(actual)}`);
}

/** Checks correct round-to-nearest, ties-to-even without independently rounding. */
export function assertCorrectRounding(actual: number, exact: Rational, label: string) {
  const sign = exact.numerator < 0n ? -1 : exact.numerator > 0n ? 1 : 0;
  if (Number.isNaN(actual)) { failRounding(label, actual, "unexpected NaN"); }

  const maximum = rationalFromNumber(Number.MAX_VALUE) as Rational;
  const overflowMidpoint = midpointRational(maximum, powerOfTwo(1024));
  if (actual === Number.POSITIVE_INFINITY) {
    if (sign <= 0 || compareRational(exact, overflowMidpoint) < 0) {
      failRounding(label, actual, "exact value rounds to a finite result");
    }
    return;
  }
  if (actual === Number.NEGATIVE_INFINITY) {
    if (sign >= 0 || compareRational(exact, negateRational(overflowMidpoint)) > 0) {
      failRounding(label, actual, "exact value rounds to a finite result");
    }
    return;
  }

  if (!Number.isFinite(actual)) { failRounding(label, actual, "non-finite result"); }
  if (actual === 0) {
    if (sign === 0) {
      if (!Object.is(actual, 0)) { failRounding(label, actual, "exact zero must be positive zero"); }
      return;
    }
    const halfMinimum = powerOfTwo(-1075);
    const magnitude = sign < 0 ? negateRational(exact) : exact;
    if (Object.is(actual, -0) !== (sign < 0) || compareRational(magnitude, halfMinimum) > 0) {
      failRounding(label, actual, "nonzero exact value is outside the signed-zero rounding interval");
    }
    return;
  }

  const candidate = rationalFromNumber(actual) as Rational;
  const lower = midpointRational(virtualAdjacent(actual, "down"), candidate);
  const upper = midpointRational(candidate, virtualAdjacent(actual, "up"));
  const even = isEvenSignificand(actual);
  const lowerComparison = compareRational(exact, lower);
  const upperComparison = compareRational(exact, upper);
  if (lowerComparison < 0 || (lowerComparison === 0 && !even)) {
    failRounding(label, actual, "exact value lies below the candidate rounding interval");
  }
  if (upperComparison > 0 || (upperComparison === 0 && !even)) {
    failRounding(label, actual, "exact value lies above the candidate rounding interval");
  }
}

/** Checks correctly rounded sqrt(exact), using squared rational midpoints. */
export function assertCorrectSqrtRounding(actual: number, exactSquared: Rational, label: string) {
  if (exactSquared.numerator < 0n) { throw new Error(`${label}: negative square supplied to oracle`); }
  if (Number.isNaN(actual) || actual < 0) { failRounding(label, actual, "invalid square-root result"); }

  const maximum = rationalFromNumber(Number.MAX_VALUE) as Rational;
  const overflowMidpoint = midpointRational(maximum, powerOfTwo(1024));
  const overflowSquare = multiplyRational(overflowMidpoint, overflowMidpoint);
  if (actual === Number.POSITIVE_INFINITY) {
    if (compareRational(exactSquared, overflowSquare) < 0) {
      failRounding(label, actual, "exact square root rounds to a finite result");
    }
    return;
  }
  if (!Number.isFinite(actual)) { failRounding(label, actual, "non-finite result"); }
  if (actual === 0) {
    const halfMinimum = powerOfTwo(-1075);
    const halfMinimumSquare = multiplyRational(halfMinimum, halfMinimum);
    if (compareRational(exactSquared, halfMinimumSquare) > 0) {
      failRounding(label, actual, "exact square root is outside the zero rounding interval");
    }
    return;
  }

  const candidate = rationalFromNumber(actual) as Rational;
  const lower = midpointRational(virtualAdjacent(actual, "down"), candidate);
  const upper = midpointRational(candidate, virtualAdjacent(actual, "up"));
  const lowerComparison = compareRational(exactSquared, multiplyRational(lower, lower));
  const upperComparison = compareRational(exactSquared, multiplyRational(upper, upper));
  const even = isEvenSignificand(actual);
  if (lowerComparison < 0 || (lowerComparison === 0 && !even)) {
    failRounding(label, actual, "exact square root lies below the candidate rounding interval");
  }
  if (upperComparison > 0 || (upperComparison === 0 && !even)) {
    failRounding(label, actual, "exact square root lies above the candidate rounding interval");
  }
}

export function createSeededRandom(seed: bigint): () => bigint {
  let state = seed & UINT64_MASK;
  if (state === 0n) { state = 0x9e3779b97f4a7c15n; }
  return () => {
    state ^= state >> 12n;
    state ^= (state << 25n) & UINT64_MASK;
    state ^= state >> 27n;
    return (state * 0x2545f4914f6cdd1dn) & UINT64_MASK;
  };
}

export function randomFiniteNumber(nextBits: () => bigint): number {
  let bits = nextBits() & UINT64_MASK;
  if (((bits >> 52n) & EXPONENT_MASK) === EXPONENT_MASK) {
    bits ^= 1n << 52n;
  }
  return floatFromBits(bits);
}

/** One deterministic, signed finite sample for every encoded exponent field. */
export function finiteNumbersAcrossExponentFields(nextBits: () => bigint): number[] {
  const values: number[] = [];
  for (let exponent = 0; exponent < 0x7_ff; exponent += 1) {
    const sign = exponent % 2 === 0 ? 0n : SIGN_MASK;
    let fraction = nextBits() & FRACTION_MASK;
    if (exponent === 0 && fraction === 0n) { fraction = 1n; }
    const bits = sign | (BigInt(exponent) << 52n) | fraction;
    values.push(floatFromBits(bits));
  }
  return values;
}
